"""Drive real publisher boundaries with synthetic inputs and two DB connections."""
import json
import os
from pathlib import Path
import sys
from datetime import date
import uuid
import time

sys.path.insert(0,str(Path(__file__).resolve().parent/'src'))
import psycopg
import collect
import collect_store
import normalize_runtime
import normalize_store as store
from collect_fixture import checked_fixture


def main():
    home,marker=checked_fixture()
    work,token=os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN']
    account,zone='12345','Asia/Seoul'
    action=marker['pass2_action']
    day='2026-10-17' if action=='race' else '2026-10-19' if action=='stress' else '2026-10-18'
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'],autocommit=True) as first, psycopg.connect(os.environ['BRAIN_DATABASE_URL'],autocommit=True) as second:
        def dirty(cur,dataset,value): store.mark_days_dirty(cur,dataset,[day])
        if action in ('chunk_start','race','stress'):
            collect_store.upsert_raw(first,account,work,token,'day',day,'user_summary',{'totalSteps':111},'fixture',1900000000000,publish=dirty)
        snapshot=collect_store.coverage_snapshot(first,account)
        source=next(i for i in snapshot['raw'] if i['scope']=='day' and i['key']==day and i['endpoint']=='user_summary')
        revision=store.day_revision([dict(scope='day',key=day,endpoint='user_summary',revision=store.raw_revision(source['body']),fetched_at_ms=source['fetched_at_ms'])],'synthetic-boundary-labels')
        fingerprint=collect_store.raw_fingerprint(snapshot['raw'])
        started=time.monotonic()
        reserved=store.reserve_day(first,account,work,token,day,revision,source['fetched_at_ms'],snapshot['raw'],fingerprint=fingerprint)
        elapsed=time.monotonic()-started
        if reserved is None: raise ValueError('stale fixture')
        revision,watermark,generation,_=reserved
        if action=='stress':
            dataset=collect_store.dataset_for(account)
            changes=[('body','{"totalSteps":112}'),('fetched_at_ms',1900000000001),('checked_at_ms',1900000000001),('library_version','changed')]
            rejected=[]
            for column,value in changes:
                previous=source[column]
                second.execute('update garmin.raw_payloads set '+column+'=%s where dataset=%s and scope=%s and original_key=%s and endpoint=%s',(value,dataset,'day',day,'user_summary'))
                rejected.append(store.reserve_day(first,account,work,token,day,revision,source['fetched_at_ms'],snapshot['raw'],fingerprint=fingerprint) is None)
                second.execute('update garmin.raw_payloads set '+column+'=%s where dataset=%s and scope=%s and original_key=%s and endpoint=%s',(previous,dataset,'day',day,'user_summary'))
            (home/'pass2-stress.json').write_text(json.dumps({'seconds':elapsed,'raw_count':len(snapshot['raw']),'rejected':rejected}))
        elif action=='race':
            collect_store.upsert_raw(second,account,work,token,'day',day,'user_summary',{'totalSteps':222},'fixture',1900000000001,publish=dirty)
            store.publish_day(first,account,work,token,day,revision,source['fetched_at_ms'],zone,{'day_summary':[{'date':day,'steps':111}]},normalize_runtime.catalog(first),watermark_us=watermark,generation=generation)
            pending=[str(r[0]) for r in store.unfinished_days(first,account,history_start=snapshot['history_start'])]
            (home/'pass2-race.json').write_text(json.dumps({'pending':pending}))
            collect_store.put_run(first,account,work,token,uuid.uuid7(),date.fromisoformat(day),1,'success',finished_at=1)
        else:
            rows={'workout':[{'activity_id':800000+i,'date':day,'duration_s':60} for i in range(501)]}
            calls=0
            def boundary(message):
                nonlocal calls
                calls+=1
                if action=='chunk_start' and calls==2: raise ValueError('COLLECT_STOPPED')
            store.publish_day(first,account,work,token,day,revision,source['fetched_at_ms'],zone,rows,normalize_runtime.catalog(first),boundary=boundary,watermark_us=watermark,generation=generation)
    collect.emit('result',summary='{}')


if __name__=='__main__':
    try: main()
    except Exception as error:
        code=str(error) if isinstance(error,ValueError) and str(error)=='COLLECT_STOPPED' else 'COLLECT_INVALID'
        collect.emit('error',code=code,retryable=False)
        sys.exit(1)
