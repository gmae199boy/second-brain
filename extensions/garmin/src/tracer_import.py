"""합성 snapshot의 얇은 이전 경로. 원본 SQLite에는 쓰지 않는다."""
import hashlib
import json
import os
from pathlib import Path
import sys
from datetime import datetime, timezone
from uuid import uuid7
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import psycopg
from health import convert
from reader import read_snapshot, InvalidSQLiteText
from raw_codec import dataset_ref, project, restore
from batch_import import check, conflict, encoded, reconcile_raw
from preflight import account as snapshot_account
from role_probe import probe_role


def digest(value):
    return hashlib.sha256(value).hexdigest()


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}), flush=True)


class TracerConflict(Exception):
    def __init__(self, dataset, batch, table, key):
        self.dataset, self.batch, self.table, self.key = dataset, batch, table, key


def main():
    snapshot = json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
    if snapshot.get('version') != 1 or snapshot.get('extension') != 'garmin':
        raise ValueError('snapshot')
    values = snapshot['values']
    dataset_label = values['garmin.dataset']
    dataset = dataset_ref(dataset_label)
    dataset_label = dataset_label if dataset != dataset_label else None
    label_display, label_raw, label_encoding = project(dataset_label)
    if not dataset:
        raise ValueError('설정')
    source = Path(values['garmin.snapshot_path'])
    legacy = Path(values['garmin.legacy_path'])
    staging = Path(values['garmin.staging_path'])
    artifact_root = Path(values['garmin.artifact_root'])
    if not all(p.is_absolute() for p in (source, legacy, staging, artifact_root)):
        raise ValueError('경로')
    artifact_key = legacy.resolve(strict=True).relative_to(artifact_root.resolve(strict=True)).as_posix()
    if artifact_key in ('', '.'):
        raise ValueError('경로')
    source_snapshot = read_snapshot(source)
    tables = source_snapshot['tables']
    daily_rows = tables['daily_metric']['rows']
    daily = min(daily_rows, key=lambda row: row['day_key']) if daily_rows else None
    if daily is not None: daily = {'day_key': daily['day_key'], 'steps': daily['steps']}
    raw = next((row for row in tables['raw_response']['rows'] if daily and row['scope'] == 'day' and row['key'] == daily['day_key'] and row['endpoint'] == 'user_summary'), None)
    if raw is None or daily is None: raise ValueError('입력')
    meta = {row['key']: row['value'] for row in tables['meta']['rows']}
    version_value = meta.get('normalize_version')
    if not isinstance(version_value, str) or not version_value.isdigit() or int(version_value) < 1: raise ValueError('정규화 버전')
    version = int(version_value)
    time_zone = meta.get('timezone')
    if time_zone is not None:
        try: ZoneInfo(time_zone)
        except (ZoneInfoNotFoundError, ValueError): raise ValueError('시간대')
    account_info = snapshot_account(source_snapshot)
    account, confirmed = account_info['account'], account_info['confirmed']
    account_display, account_raw, account_encoding = project(account)
    text = legacy.read_bytes()
    text.decode('utf-8')
    content_hash = digest(text)
    # 기존 tracer의 정상 TEXT revision은 논리 원문의 UTF-8 해시다.
    raw_hash = digest(raw['raw'].raw if isinstance(raw['raw'], InvalidSQLiteText) else raw['raw'].encode('utf-8'))
    batch = digest((dataset + raw_hash + content_hash).encode())
    raw_key = json.dumps([raw['scope'], raw['key'], raw['endpoint']], ensure_ascii=False, separators=(',', ':'))
    records = [
        ('raw_response', raw_key, 'raw', digest(json.dumps(raw, ensure_ascii=False, sort_keys=True, default=encoded).encode())),
        ('daily_metric', daily['day_key'], 'health', digest(json.dumps([daily, version, raw_hash, time_zone], ensure_ascii=False, sort_keys=True).encode())),
        ('legacy_markdown', artifact_key, 'analysis', content_hash),
    ]
    staging_key = digest(json.dumps([dataset, artifact_key, content_hash], ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    staged = staging / (staging_key + '.md')
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as probe:
        check(probe.cursor())
        if not all(probe_role(probe).values()): raise ValueError('입력')
        previous = probe.execute("select target_id from garmin.import_mapping where dataset=%s and original_table='legacy_markdown' and original_key=%s and target_kind='file'", (dataset,artifact_key)).fetchone()
        status = probe.execute('select status from brain.file_request_results_public_v1 where request_id=%s', (previous[0],)).fetchone() if previous else None
    if not status or status[0] != 'completed':
        staging.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        except FileExistsError:
            fd = os.open(staged, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(fd, 'rb') as existing:
                if existing.read() != text:
                    raise ValueError('staging conflict')
        else:
            with os.fdopen(fd, 'wb') as output:
                output.write(text)
    now = datetime.now(timezone.utc)
    work = os.environ['BRAIN_WORK_ID']; token = os.environ['BRAIN_ATTEMPT_TOKEN']
    try:
        with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
            with conn.cursor() as cur:
                cur.execute('select garmin.attempt_valid(%s::uuid,%s::uuid)', (work,token))
                if cur.fetchone()[0] is not True: raise ValueError('입력')
                if not all(probe_role(conn).values()): raise ValueError('입력')
                cur.execute('insert into garmin.datasets(dataset,account,account_confirmed,account_raw,account_encoding,dataset_label,dataset_label_raw,dataset_label_encoding) values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict do nothing', (dataset,account_display,confirmed,account_raw,account_encoding,label_display,label_raw,label_encoding))
                cur.execute('select account,account_confirmed,account_raw,account_encoding,dataset_label,dataset_label_raw,dataset_label_encoding from garmin.datasets where dataset=%s', (dataset,))
                existing = cur.fetchone()
                if existing[1] != confirmed or restore(existing[0],existing[2],existing[3]) != account or restore(existing[4],existing[5],existing[6]) != dataset_label: raise TracerConflict(dataset,batch,None,None)
                cur.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,%s) on conflict do nothing', (batch,dataset,now))
                ids = {}
                for table, key, kind, hashed in records:
                    cur.execute('select target_id,content_hash,batch from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind=%s', (dataset,table,key,kind))
                    previous = cur.fetchone()
                    if previous:
                        if previous[1] != hashed: raise TracerConflict(dataset,batch,table,key)
                        ids[kind] = previous[0]
                        if kind == 'raw' and not reconcile_raw(cur,dataset,previous[2],account,raw): raise TracerConflict(dataset,batch,table,key)
                        if kind == 'health':
                            metric = cur.execute("select definition from brain.health_catalog_v1 where metric='daily_metric.steps'").fetchone()[0]
                            steps = convert(metric, 'daily_metric', 'steps', daily['steps'])
                            cur.execute('insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,revision,fetched_at,normalization_version,time_zone,time_zone_missing,source_work_item_id,source_attempt_token,account_raw,account_encoding,dataset_label,dataset_label_raw,dataset_label_encoding) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s / 1000.0),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (ids[kind],'garmin',dataset,previous[2],table,key,account_display,confirmed,'steps',steps,metric['unit'],daily['day_key'],raw_hash,raw['fetched_at'],version,time_zone,time_zone is None,work,token,account_raw,account_encoding,label_display,label_raw,label_encoding))
                        if kind == 'analysis':
                            cur.execute("select target_id,content_hash,batch from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind='file'", (dataset,table,key))
                            mapped_file = cur.fetchone()
                            if not mapped_file or mapped_file[1] != hashed: raise ValueError('conflict')
                            imported_at = cur.execute('select imported_at from garmin.import_batches where id=%s and dataset=%s', (mapped_file[2],dataset)).fetchone()
                            if not imported_at: raise ValueError('conflict')
                            file_id = mapped_file[0]
                            cur.execute('insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (file_id,'garmin',json.dumps([dataset,key],ensure_ascii=False,separators=(',', ':')),dataset,mapped_file[2],staged.name,content_hash,len(text),'text/markdown',imported_at[0],work,token))
                            cur.execute('insert into brain.analyses(id,source,dataset,import_batch,original_table,original_key,revision,model_missing,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,1,true,true,%s,%s,%s)', (ids[kind],'garmin',dataset,previous[2],table,key,file_id,work,token))
                    else:
                        ids[kind] = uuid7()
                        cur.execute('insert into garmin.import_mapping(dataset,original_table,original_key,target_kind,target_id,content_hash,batch) values (%s,%s,%s,%s,%s,%s,%s)', (dataset,table,key,kind,ids[kind],hashed,batch))
                        if kind == 'raw':
                            if not reconcile_raw(cur,dataset,batch,account,raw): raise TracerConflict(dataset,batch,table,key)
                        elif kind == 'health':
                            cur.execute("select definition from brain.health_catalog_v1 where metric='daily_metric.steps'")
                            metric_row = cur.fetchone()
                            if metric_row is None: raise ValueError('건강 catalog')
                            metric = metric_row[0]
                            steps = convert(metric, 'daily_metric', 'steps', daily['steps'])
                            cur.execute('insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,revision,fetched_at,normalization_version,time_zone,time_zone_missing,source_work_item_id,source_attempt_token,account_raw,account_encoding,dataset_label,dataset_label_raw,dataset_label_encoding) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s / 1000.0),%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (ids[kind],'garmin',dataset,batch,table,key,account_display,confirmed,'steps',steps,metric['unit'],daily['day_key'],raw_hash,raw['fetched_at'],version,time_zone,time_zone is None,work,token,account_raw,account_encoding,label_display,label_raw,label_encoding))
                        else:
                            file_id = uuid7()
                            cur.execute('insert into garmin.import_mapping(dataset,original_table,original_key,target_kind,target_id,content_hash,batch) values (%s,%s,%s,%s,%s,%s,%s)', (dataset,table,key,'file',file_id,hashed,batch))
                            cur.execute('insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (file_id,'garmin',json.dumps([dataset,key],ensure_ascii=False,separators=(',', ':')),dataset,batch,staged.name,content_hash,len(text),'text/markdown',now,work,token))
                            cur.execute('insert into brain.analyses(id,source,dataset,import_batch,original_table,original_key,revision,model_missing,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,1,true,true,%s,%s,%s)', (ids[kind],'garmin',dataset,batch,table,key,file_id,work,token))
    except (psycopg.errors.RaiseException, psycopg.errors.UniqueViolation) as exc:
        raise TracerConflict(dataset,batch,table if 'table' in locals() else None,key if 'key' in locals() else None) from exc
    emit('result', summary='이전 완료')


try:
    main()
except TracerConflict as exc:
    try:
        with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as connection:
            conflict(connection, exc.dataset, exc.batch, exc.table, exc.key, 'row_mismatch')
    except ValueError as persisted:
        if str(persisted) == 'IMPORT_CONFLICT':
            emit('error', code='IMPORT_CONFLICT', retryable=False)
            sys.exit(1)
    except psycopg.Error:
        pass
    emit('error', code='IMPORT_INVALID', retryable=False)
    sys.exit(1)
except (psycopg.errors.UniqueViolation, psycopg.errors.RaiseException):
    emit('error', code='IMPORT_CONFLICT', retryable=False)
    sys.exit(1)
except psycopg.Error as exc:
    state = exc.sqlstate
    retryable = (state is None and isinstance(exc, psycopg.OperationalError)) or (
        state is not None and (state.startswith('08') or state in ('40001', '40P01', '55P03', '57014', '25P04', '57P01', '57P02', '57P03'))
    )
    emit('error', code='IMPORT_INVALID', retryable=retryable)
    sys.exit(1)
except ValueError as exc:
    emit('error', code='IMPORT_CONFLICT' if str(exc) in ('conflict', 'staging conflict') else 'IMPORT_INVALID', retryable=False)
    sys.exit(1)
except Exception:
    emit('error', code='IMPORT_INVALID', retryable=False)
    sys.exit(1)
