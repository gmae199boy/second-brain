"""Synthetic inputs for pass-two runtime and transaction boundary tests."""
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

sys.path.insert(0,str(Path(__file__).resolve().parent/'src'))
import psycopg
import collect
import collect_store
import normalize
import normalize_runtime
import normalize_store as store
from batch_import import canonical, encoded
from health import convert, source_endpoint
from reader import SQLiteText
from collect_fixture import checked_fixture


def key(values):
    return canonical([encoded(SQLiteText(v.encode('utf-8'),'utf-8') if isinstance(v,str) else v) for v in values])


def expected_projection(inputs, expected, catalog):
    raw = {(i['scope'],i['key'],i['endpoint']):i['raw'] for i in inputs['items']}
    statuses = {(i['scope'],i['key'],i['endpoint']):i['ok'] for i in expected['normalize_result']}
    activity_days={str(r['activity_id']):r['day_key'] for r in expected['activity']}
    out=[]
    for table, pks in store.PRIMARY_KEYS.items():
        for row in expected.get(table,[]):
            activity = str(row['activity_id']) if row.get('activity_id') is not None else None
            scope = 'activity' if activity is not None else 'day'
            day = row.get('day_key') or row.get('date') or activity_days.get(activity)
            source_key = activity if activity is not None else day
            original_key = key([row[c] for c in pks])
            for metric in catalog:
                for mapping in metric['mappings']:
                    col=mapping['column']
                    if mapping['table']!=table or col not in row: continue
                    endpoint=source_endpoint(table,col)
                    if table not in store.DAY_TABLES:
                        ident=(scope,source_key,endpoint)
                        if statuses.get(ident)!=1 or raw.get(ident)=='null': continue
                    value=convert(metric,table,col,row[col])
                    observed=datetime.fromtimestamp(row['ts_ms']/1000,timezone.utc).isoformat(timespec='milliseconds').replace('+00:00','Z') if row.get('ts_ms') is not None else None
                    out.append(dict(original_table=table,original_key=original_key,metric=metric['metric'],
                        value=value,kind=metric['type'],unit=metric['unit'],day=None if observed else day,observed=observed,activity=activity))
    return out


def main():
    home,marker=checked_fixture()
    work,token=os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN']
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'],autocommit=True) as conn:
        if marker['pass2_action']=='frozen':
            inputs=json.loads((home/'pass2-input.json').read_text())
            expected=json.loads((home/'pass2-expected.json').read_text())
            for i in inputs['items']:
                collect_store.upsert_raw(conn,'12345',work,token,i['scope'],i['key'],i['endpoint'],json.loads(i['raw']),'fixture',i['fetched_at'])
            collect_store.set_history_start(conn,'12345',work,token,inputs['history_start'])
            (home/'pass2-projection.json').write_text(json.dumps(expected_projection(inputs,expected,normalize_runtime.catalog(conn)),ensure_ascii=False))
    normalize.run()


if __name__=='__main__':
    try: main()
    except Exception:
        collect.emit('error',code='COLLECT_INVALID',retryable=False)
        sys.exit(1)
