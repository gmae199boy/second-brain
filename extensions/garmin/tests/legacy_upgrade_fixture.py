"""Create 0008-style normal and colliding day observations in an active attempt."""
import hashlib
import json
import os
from pathlib import Path
import sys

sys.path.insert(0,str(Path(__file__).resolve().parent / 'src'))
import psycopg
import collect
import collect_store
import normalize_runtime
import normalize_store as store
from collect_fixture import checked_fixture


def main():
    home,_ = checked_fixture()
    account, work, token = '12345',os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN']
    ms=2000000000000
    labels=Path(__file__).resolve().parent/'src/labels/exercise_types_ko.json'
    label_hash=hashlib.sha256(labels.read_bytes()).hexdigest()
    bases={}
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'],autocommit=True) as conn:
        catalog=normalize_runtime.catalog(conn)
        collect_store.set_history_start(conn,account,work,token,'2026-01-01')
        collect_store.upsert_raw(conn,account,work,token,'day','2025-12-30','rhr_day',None,'legacy-fixture',ms)
        with collect_store._write(conn,account,work,token) as (cur,dataset):
            cur.execute("""insert into garmin.normalize_items(dataset,scope,key,endpoint,revision,normalization_version,fetched_at_ms,ok,error_code,normalized_at_ms)
                values (%s,'day','2025-12-30','rhr_day',%s,8,%s,true,null,%s)""",(dataset,store.raw_revision('null'),ms,ms))
        for day,value in [('2026-01-01',1111),('2026-01-02',2222)]:
            raw=collect_store.upsert_raw(conn,account,work,token,'day',day,'user_summary',{'totalSteps':value},'legacy-fixture',ms)
            base=store.day_revision([dict(scope='day',key=day,endpoint='user_summary',revision=store.raw_revision(raw['body']),fetched_at_ms=ms)],label_hash)
            bases[day]=base
            store.publish_day(conn,account,work,token,day,base,ms,'Asia/Seoul',{'day_summary':[{'date':day,'steps':value}]},catalog)
            if day=='2026-01-01':
                other=store.digest('synthetic-legacy-other')
                store.publish_day(conn,account,work,token,day,other,ms,'Asia/Seoul',{'day_summary':[{'date':day,'steps':9999}]},catalog)
                bases['other']=other
    (home/'legacy-day-bases.json').write_text(json.dumps(bases))
    collect.emit('result',summary='{}')


if __name__=='__main__':
    try: main()
    except Exception:
        collect.emit('error',code='COLLECT_INVALID',retryable=False)
        sys.exit(1)
