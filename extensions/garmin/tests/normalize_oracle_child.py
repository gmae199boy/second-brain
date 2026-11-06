"""Isolated subprocess driver for the unchanged pinned SQLite implementation.

Invoked only by the disposable-PG unittest; PYTHONPATH must point at tests/oracle.
"""
import json
import sqlite3
import sys
from pathlib import Path
from garmin_pipeline import dates, normalize, store

FIXED_NOW = 1792100000000
TABLES = ('daily_metric','activity','body_battery_sample','hr_sample',
          'stress_bb_sample','activity_hr_sample','exercise_set','normalize_result',
          'day_summary','workout','exercise_log')


def pending_scenario(scenario):
    """Run unchanged SQLite rebuild with pre-existing durable pending."""
    from unittest.mock import patch
    dates.now_ms=lambda: FIXED_NOW
    conn=sqlite3.connect(':memory:',autocommit=True)
    store._migrate(conn,store._load_migrations())
    day='2026-01-01'
    history='2026-01-03' if scenario=='history_after_last' else '2026-01-02'
    conn.execute("insert into meta values ('history_start',?)",(history,))
    conn.execute("insert into meta values ('day_values_pending',?)",(json.dumps([day]),))
    if scenario != 'no_day_raw':
        store.upsert_raw(conn,scope='day',key=day,endpoint='user_summary',payload={'totalSteps':12},library_version='synthetic',now_ms=1)
    if scenario == 'outside_history':
        store.upsert_raw(conn,scope='day',key='2026-01-02',endpoint='user_summary',payload={'totalSteps':34},library_version='synthetic',now_ms=1)
    original=normalize.digest.day_values
    def fail_day(key,*args,**kwargs):
        if key==day: raise ValueError('synthetic pending failure')
        return original(key,*args,**kwargs)
    def snapshot():
        return {'days':[list(row) for row in conn.execute('select date,steps from day_summary order by date')],
                'pending':conn.execute("select value from meta where key='day_values_pending'").fetchone()}
    if scenario != 'no_day_raw':
        with patch.object(normalize.digest,'day_values',side_effect=fail_day):
            normalize.run(conn,rebuild=True,timezone='UTC')
        failed=snapshot()
    else:
        failed=None
    normalize.run(conn,rebuild=True,timezone='UTC')
    print(json.dumps({'failed':failed,'recovered':snapshot()}))
    conn.close()


def main():
    fixture=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
    dates.now_ms=lambda: FIXED_NOW
    conn=sqlite3.connect(':memory:',autocommit=True)
    store._migrate(conn,store._load_migrations())
    conn.execute('insert into meta(key,value) values (?,?)',('history_start',fixture['history_start']))
    conn.execute('insert into meta(key,value) values (?,?)',('normalize_version',str(store.NORMALIZE_VERSION)))
    for item in fixture['items']:
        store.upsert_raw(conn,scope=item['scope'],key=item['key'],endpoint=item['endpoint'],
            payload=json.loads(item['raw']),library_version='synthetic',now_ms=item['fetched_at'])
    def snapshot():
        out={}
        for table in TABLES:
            info=conn.execute(f'pragma table_info("{table}")').fetchall()
            columns=[row[1] for row in info]
            keys=[row[1] for row in sorted(info,key=lambda row:row[5]) if row[5]]
            fields=','.join('"'+name+'"' for name in columns)
            rows=[dict(zip(columns,row,strict=True)) for row in conn.execute(f'select {fields} from "{table}"')]
            rows.sort(key=lambda row:json.dumps([row[key] for key in keys],ensure_ascii=False))
            out[table]={'columns':columns,'keys':keys,'rows':rows}
        out['exercise_order']=[list(row) for row in conn.execute('select activity_id,exercise from exercise_log order by rowid')]
        out['pending']=conn.execute("select value from meta where key='day_values_pending'").fetchone()
        return out
    def run(rebuild=False):
        result=normalize.run(conn,rebuild=rebuild,timezone=fixture['timezone'])
        return {'processed':result.processed,'failed':result.failed,'snapshot':snapshot()}
    result={'initial':run(),'rerun':run(),'rebuild':run(rebuild=True)}
    valid_summary=json.loads(next(item['raw'] for item in fixture['items'] if item['endpoint']=='user_summary' and item['key']=='2026-10-15'))
    store.upsert_raw(conn,scope='day',key='2026-10-17',endpoint='user_summary',
                     payload={**valid_summary,'calendarDate':'2026-10-17','totalSteps':321},library_version='synthetic',now_ms=FIXED_NOW)
    result['post_update']=run()
    print(json.dumps(result,ensure_ascii=False,sort_keys=True,allow_nan=False))
    conn.close()


if __name__=='__main__':
    if len(sys.argv)>2 and sys.argv[1]=='pending': pending_scenario(sys.argv[2])
    else: main()
