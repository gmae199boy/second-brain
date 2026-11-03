"""Publish synthetic catalog rows using the real extension role and attempt."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
import psycopg
import collect
import collect_store
import normalize_runtime
import normalize_store as store
from batch_import import canonical, encoded
from reader import SQLiteText
from collect_fixture import checked_fixture


def key(*values):
    return canonical([encoded(SQLiteText(v.encode('utf-8'),'utf-8') if isinstance(v,str) else v) for v in values])


def main():
    home, _ = checked_fixture()
    account, day, activity, exercise = '12345','2026-03-03','synthetic-activity-9','딥 스쿼트'
    work, token = os.environ['BRAIN_WORK_ID'], os.environ['BRAIN_ATTEMPT_TOKEN']
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'],autocommit=True) as conn:
        catalog = normalize_runtime.catalog(conn)
        args = (conn,account,work,token)
        store.publish_item(*args,'activity',activity,'activity','{"synthetic":1}',2200000000000,'Asia/Seoul',
            {'activity':[{'activity_id':activity,'day_key':day,'type_key':'러닝\0원본'}]},catalog)
        store.publish_item(*args,'activity',activity,'activity_exercise_sets','{"synthetic":2}',2200000000000,'Asia/Seoul',
            {'exercise_set':[{'activity_id':activity,'day_key':day,'set_index':3,'exercise_name':'스쿼트\0원본','weight_g':40500}]},catalog)
        store.publish_item(*args,'day',day,'heart_rates','{"synthetic":3}',2200000000000,'Asia/Seoul',
            {'hr_sample':[{'day_key':day,'ts_ms':1700001234000,'bpm':65}]},catalog)
        revision='synthetic-day-contract'
        reservation=store.reserve_day(*args,day,revision,2200000000000,collect_store.raw_snapshot(conn,account))
        if reservation is None: raise ValueError('stale fixture')
        revision,watermark,generation,_=reservation
        store.publish_day(*args,day,revision,2200000000000,'Asia/Seoul',
            {'day_summary':[{'date':day,'drinks_json':'[{"count":2,"name":"물"}]'}],
             'exercise_log':[{'activity_id':activity,'exercise':exercise,'sets':3}]},catalog,
            watermark_us=watermark,generation=generation)
        (home / 'publisher-contract-keys.json').write_text(json.dumps({
            'activity':key(activity),'exercise_set':key(activity,3),'exercise_log':key(activity,exercise),
            'hr_sample':key(day,1700001234000),'day_summary':key(day)},ensure_ascii=False))
    collect.emit('result',summary='{}')


if __name__ == '__main__':
    try: main()
    except Exception:
        collect.emit('error',code='COLLECT_INVALID',retryable=False)
        sys.exit(1)
