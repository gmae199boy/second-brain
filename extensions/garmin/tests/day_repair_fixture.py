"""Run one synthetic stale-snapshot reservation inside a real attempt."""
import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent / 'src'))
import psycopg
import collect
import collect_store
import normalize_runtime
import normalize_store
from collect_fixture import checked_fixture


def main():
    home, marker = checked_fixture()
    account, day = '12345', '2026-01-01'
    work, token = os.environ['BRAIN_WORK_ID'], os.environ['BRAIN_ATTEMPT_TOKEN']
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], autocommit=True) as conn:
        old = collect_store.coverage_snapshot(conn, account)
        prior = next(i for i in old['raw'] if i['scope'] == 'day' and i['key'] == day and i['endpoint'] == 'user_summary')
        payload = json.loads(prior['body'])
        payload['totalSteps'] = marker['stale_new_steps']
        def dirty(cur,dataset,value):
            normalize_store.mark_days_dirty(cur,dataset,[day])
        collect_store.upsert_raw(conn,account,work,token,'day',day,'user_summary',payload,'fixture',marker['stale_fetch_ms'],publish=dirty)
        fresh = collect_store.coverage_snapshot(conn, account)
        normalize_runtime.publish_days(conn,account,work,token,'Asia/Seoul',[day],normalize_runtime.catalog(conn),lambda message: None,snapshot=fresh)
        # Reservation must reject the old snapshot even when source maxima tie.
        stale = normalize_store.reserve_day(conn,account,work,token,day,'stale-test-revision',marker['source_max_ms'],old['raw'])
        # Advance the source maximum, then try the formerly current snapshot.
        collect_store.upsert_raw(conn,account,work,token,'day',day,'sleep_data',{'ok':True,'synthetic':1},'fixture',marker['source_max_ms']+1,publish=dirty)
        newest = collect_store.coverage_snapshot(conn, account)
        normalize_runtime.publish_days(conn,account,work,token,'Asia/Seoul',[day],normalize_runtime.catalog(conn),lambda message: None,snapshot=newest)
        older = normalize_store.reserve_day(conn,account,work,token,day,'older-test-revision',marker['source_max_ms'],fresh['raw'])
        (home / 'day-stale-result.json').write_text(json.dumps({'rejected':stale is None,'older_rejected':older is None}))
    collect.emit('result',summary='{}')


if __name__ == '__main__':
    try:
        main()
    except Exception:
        collect.emit('error',code='COLLECT_INVALID',retryable=False)
        sys.exit(1)
