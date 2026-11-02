"""계정 전체 원문 coverage와 수집 dataset의 원자적 publisher."""
from datetime import datetime, timezone
import hashlib
import json
import uuid

from health import convert
from collect_normalize import user_summary


def _digest(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def covered(conn, account, day):
    """정확한 Unicode 계정의 기존 원문을 모든 dataset에서 찾는다."""
    return conn.execute('''select exists(select 1 from garmin.raw_payloads r
        join garmin.datasets d on d.dataset=r.dataset
        where d.account=%s and d.account_confirmed and d.account_raw is null
        and r.account=%s and r.account_raw is null and r.scope='day' and r.scope_raw is null
        and r.original_key=%s and r.original_key_raw is null and r.endpoint='user_summary'
        and r.endpoint_raw is null and r.body_raw is null)''', (account, account, day)).fetchone()[0]


def prepare(response, day, catalog, fetched_at=None, library_version='synthetic-port'):
    """외부 호출 후 트랜잭션 밖에서 원문과 v8 관측을 준비한다."""
    body = json.dumps(response, ensure_ascii=False)
    metric = next(m for m in catalog if m['metric'] == 'daily_metric.steps')
    value = None if response is None else convert(metric, 'daily_metric', 'steps', user_summary(body, day)['steps'])
    fetched_at = fetched_at or datetime.now(timezone.utc)
    fetched_ms = int(fetched_at.timestamp() * 1000)
    return {'body': body, 'revision': hashlib.sha256(body.encode('utf-8')).hexdigest(),
            'fetched_ms': fetched_ms, 'value': value, 'unit': metric['unit'], 'library_version': library_version}


def publish(conn, account, day, zone, work_id, attempt_token, prepared):
    """현재 attempt 검사와 모든 저장을 제한된 단일 트랜잭션에서 수행한다."""
    dataset = 'collect-' + _digest(account)
    batch = 'collect-' + _digest(account, day, 'user_summary')
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("set local transaction_timeout = '1900ms'")
        cur.execute("set local statement_timeout = '1900ms'")
        cur.execute("set local lock_timeout = '1900ms'")
        cur.execute('select garmin.attempt_valid(%s::uuid,%s::uuid)', (work_id, attempt_token))
        if cur.fetchone()[0] is not True:
            raise ValueError('COLLECT_INVALID_ATTEMPT')
        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (_digest(account, day, 'user_summary'),))
        if covered(conn, account, day):
            return False
        cur.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,true) on conflict (dataset) do nothing', (dataset, account))
        cur.execute('select account,account_confirmed,account_raw from garmin.datasets where dataset=%s', (dataset,))
        if cur.fetchone() != (account, True, None):
            raise ValueError('COLLECT_DATASET_CONFLICT')
        fetched = datetime.fromtimestamp(prepared['fetched_ms'] / 1000, timezone.utc)
        cur.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,%s) on conflict (id) do nothing', (batch, dataset, fetched))
        cur.execute('''insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body)
            values (%s,%s,%s,'day',%s,'user_summary',%s,%s,%s,%s)''',
            (dataset,batch,account,day,prepared['fetched_ms'],prepared['fetched_ms'],prepared['library_version'],prepared['body']))
        if prepared['value'] is None:
            return True
        cur.execute('''insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,sub_identity)
            values (%s,'garmin',%s,%s,'daily_metric',%s,%s,true,'daily_metric.steps',%s,%s,%s,%s,false,%s,%s,8,%s,%s,'number',%s)''',
            (uuid.uuid7(),dataset,batch,day,account,prepared['value'],prepared['unit'],day,zone,prepared['revision'],fetched,work_id,attempt_token,day))
        cur.execute('insert into garmin.collect_state values (%s,%s,%s,\'user_summary\',%s,%s)', (dataset,account,day,prepared['revision'],prepared['fetched_ms']))
    return True
