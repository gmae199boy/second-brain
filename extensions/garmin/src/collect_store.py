"""계정 전체 원문 coverage와 수집 dataset의 원자적 publisher."""
from datetime import datetime, timezone
import hashlib
import json
import uuid

# 다음 API는 외부 호출과 분리된 짧은 트랜잭션으로만 쓴다.
from contextlib import contextmanager
import base64


def _digest(*parts):
    return hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(',', ':')).encode('utf-8')).hexdigest()


def dataset_for(account):
    return 'collect-' + _digest(account)


@contextmanager
def _write(conn, account, work_id, attempt_token):
    dataset = dataset_for(account)
    with conn.transaction():
        cur = conn.cursor()
        cur.execute("set local transaction_timeout = '1900ms'")
        cur.execute("set local statement_timeout = '1900ms'")
        cur.execute("set local lock_timeout = '1500ms'")
        cur.execute('select garmin.attempt_valid(%s::uuid,%s::uuid)', (work_id, attempt_token))
        if cur.fetchone()[0] is not True:
            raise ValueError('COLLECT_INVALID_ATTEMPT')
        cur.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,true) on conflict (dataset) do nothing', (dataset, account))
        cur.execute('select account,account_confirmed,account_raw from garmin.datasets where dataset=%s', (dataset,))
        if cur.fetchone() != (account, True, None):
            raise ValueError('COLLECT_DATASET_CONFLICT')
        yield cur, dataset


def raw_transition(previous, payload, library_version, now_ms):
    """원문과 시각의 옛 upsert 전이. previous는 body/fetched_at_ms 등을 담는다."""
    body = json.dumps(payload, ensure_ascii=False)
    try:
        body.encode('utf-8')
    except UnicodeEncodeError:
        body = json.dumps(payload, ensure_ascii=True)
    if previous is not None and (payload is None or previous['body'] == body):
        return {'body': previous['body'], 'fetched_at_ms': previous['fetched_at_ms'],
                'checked_at_ms': now_ms, 'library_version': previous['library_version']}
    return {'body': body, 'fetched_at_ms': now_ms, 'checked_at_ms': now_ms, 'library_version': library_version}


def _legacy_value(value):
    if not isinstance(value, dict):
        return None
    if value.get('type') == 'null':
        return None
    if 'value' in value:
        return value['value']
    if value.get('type') == 'text' and 'base64' in value:
        try:
            return base64.b64decode(value['base64'], validate=True).decode(value.get('encoding', 'utf-8'))
        except (ValueError, UnicodeError, LookupError):
            return None
    return None


def coverage_snapshot(conn, account):
    """동일 계정 dataset의 최신 raw와 모든 실행·실패, 운영 meta를 읽는다."""
    dataset = dataset_for(account)
    cur = conn.cursor()
    cur.execute('''select distinct on (r.scope,r.original_key,r.endpoint)
        r.scope,r.original_key,r.endpoint,r.body,r.fetched_at_ms,r.checked_at_ms,r.library_version
        from garmin.raw_payloads r join garmin.datasets d on d.dataset=r.dataset
        where d.account=%s and d.account_confirmed and d.account_raw is null
          and r.account=%s and r.account_raw is null and r.scope_raw is null
          and r.original_key_raw is null and r.endpoint_raw is null and r.body_raw is null
          and r.library_version_raw is null
        order by r.scope,r.original_key,r.endpoint,r.checked_at_ms desc,(r.dataset=%s) desc,r.dataset''',
        (account, account, dataset))
    raw = [dict(zip(('scope','key','endpoint','body','fetched_at_ms','checked_at_ms','library_version'), row)) for row in cur.fetchall()]
    cur.execute('''select r.local_date,r.started_at,r.finished_at,r.status,r.detail,
        garmin.attempt_valid(r.work_id,r.attempt_token)
        from garmin.collect_runs r join garmin.datasets d on d.dataset=r.dataset
        where d.account=%s and d.account_confirmed and d.account_raw is null''', (account,))
    runs = []
    for local_date, started, finished, status, detail, valid in cur.fetchall():
        if status == 'running' and not valid:
            status, detail = 'error', 'abandoned'
        runs.append(dict(local_date=str(local_date), started_at=started, finished_at=finished, status=status, detail=detail))
    cur.execute('''select e.scope,e.original_key,e.endpoint,e.kind,e.local_date,e.occurred_at,e.error_code
        from garmin.collect_fetch_errors e join garmin.datasets d on d.dataset=e.dataset
        where d.account=%s and d.account_confirmed and d.account_raw is null''', (account,))
    errors = [dict(zip(('scope','key','endpoint','kind','local_date','occurred_at','error_code'), row)) for row in cur.fetchall()]
    for row in errors:
        row['local_date'] = str(row['local_date'])
    cur.execute('''select p.original_table,p.values_json,exists(select 1 from garmin.import_checkpoints c
        where c.dataset=p.dataset and c.source_role='D2')
        from garmin.preserved_rows p join garmin.datasets d on d.dataset=p.dataset
        where d.account=%s and d.account_confirmed and d.account_raw is null
          and p.original_table in ('run','fetch_error','meta')''', (account,))
    history_start = None
    for table, encoded, is_d2 in cur.fetchall():
        row = {key: _legacy_value(value) for key, value in encoded.items()}
        if table == 'run':
            if row.get('status') == 'running':
                row['status'], row['detail'] = 'error', 'abandoned'
            runs.append(row)
        elif table == 'fetch_error':
            errors.append(row)
        elif is_d2 and row.get('key') == 'history_start':
            history_start = row.get('value')
    cur.execute('select value from garmin.collect_meta where dataset=%s and key=%s', (dataset, 'history_start'))
    row = cur.fetchone()
    return {'raw': raw, 'runs': runs, 'errors': errors, 'history_start': row[0] if row else history_start}


def upsert_raw(conn, account, work_id, attempt_token, scope, key, endpoint, payload, library_version, now_ms, *, expected=None, publish=None):
    if scope not in ('day', 'activity'):
        raise ValueError('COLLECT_INVALID')
    with _write(conn, account, work_id, attempt_token) as (cur, dataset):
        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (_digest(account, scope, key, endpoint),))
        cur.execute('''select r.body,r.fetched_at_ms,r.checked_at_ms,r.library_version
            from garmin.raw_payloads r join garmin.datasets d on d.dataset=r.dataset
            where d.account=%s and d.account_confirmed and d.account_raw is null and r.account=%s
              and r.account_raw is null and r.scope=%s and r.scope_raw is null
              and r.original_key=%s and r.original_key_raw is null and r.endpoint=%s
              and r.endpoint_raw is null and r.body_raw is null and r.library_version_raw is null
            order by r.checked_at_ms desc,(r.dataset=%s) desc,r.dataset limit 1''',
            (account,account,scope,key,endpoint,dataset))
        row = cur.fetchone()
        previous = dict(zip(('body','fetched_at_ms','checked_at_ms','library_version'), row)) if row else None
        value = raw_transition(previous, payload, library_version, now_ms)
        batch = 'collect-' + _digest(account, scope, key, endpoint)
        cur.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,%s) on conflict (id) do nothing',
                    (batch, dataset, datetime.fromtimestamp(now_ms / 1000, timezone.utc)))
        cur.execute('''insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,body,fetched_at_ms,checked_at_ms,library_version)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            on conflict (dataset,scope,original_key,endpoint) where raw_identity is null do update
            set body=excluded.body,fetched_at_ms=excluded.fetched_at_ms,checked_at_ms=excluded.checked_at_ms,library_version=excluded.library_version''',
            (dataset,batch,account,scope,key,endpoint,value['body'],value['fetched_at_ms'],value['checked_at_ms'],value['library_version']))
        if expected is not None and value != expected:
            raise ValueError('COLLECT_RAW_CHANGED')
        if publish is not None:
            publish(cur, dataset, value)
        return value


def put_run(conn, account, work_id, attempt_token, run_id, local_date, started_at, status, detail='', finished_at=None):
    with _write(conn, account, work_id, attempt_token) as (cur, dataset):
        cur.execute('''insert into garmin.collect_runs(dataset,run_id,work_id,attempt_token,local_date,started_at,finished_at,status,detail)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict (dataset,run_id) do update
            set finished_at=excluded.finished_at,status=excluded.status,detail=excluded.detail
            where garmin.collect_runs.work_id=excluded.work_id and garmin.collect_runs.attempt_token=excluded.attempt_token''',
            (dataset,run_id,work_id,attempt_token,local_date,started_at,finished_at,status,detail))


def add_fetch_error(conn, account, work_id, attempt_token, run_id, scope, key, endpoint, kind, local_date, occurred_at, error_code):
    with _write(conn, account, work_id, attempt_token) as (cur, dataset):
        cur.execute('''insert into garmin.collect_fetch_errors(id,dataset,run_id,scope,original_key,endpoint,kind,local_date,occurred_at,error_code)
            values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
            (uuid.uuid7(),dataset,run_id,scope,key,endpoint,kind,local_date,occurred_at,error_code))


def set_history_start(conn, account, work_id, attempt_token, value):
    with _write(conn, account, work_id, attempt_token) as (cur, dataset):
        cur.execute("insert into garmin.collect_meta(dataset,key,value) values (%s,'history_start',%s) on conflict do nothing", (dataset,value))
        cur.execute("select value from garmin.collect_meta where dataset=%s and key='history_start'", (dataset,))
        return cur.fetchone()[0]


def target_account(conn, target_kind, target_id):
    row = conn.execute('select account from garmin.collect_targets where target_kind=%s and target_id=%s', (target_kind,target_id)).fetchone()
    return row[0] if row else None


def set_target(conn, account, work_id, attempt_token, target_kind, target_id):
    with _write(conn, account, work_id, attempt_token) as (cur, dataset):
        cur.execute('''insert into garmin.collect_targets(target_kind,target_id,account,dataset) values (%s,%s,%s,%s)
            on conflict (target_kind,target_id) do nothing''', (target_kind,target_id,account,dataset))
        cur.execute('select account from garmin.collect_targets where target_kind=%s and target_id=%s', (target_kind,target_id))
        if cur.fetchone()[0] != account:
            raise ValueError('COLLECT_ACCOUNT_MISMATCH')


