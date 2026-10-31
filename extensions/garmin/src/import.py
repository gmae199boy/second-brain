"""합성 snapshot의 얇은 이전 경로. 원본 SQLite에는 쓰지 않는다."""
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import sys
from datetime import datetime, timezone
from uuid import uuid7
from urllib.parse import quote
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
import psycopg


def digest(value):
    return hashlib.sha256(value).hexdigest()


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}), flush=True)


def main():
    snapshot = json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
    if snapshot.get('version') != 1 or snapshot.get('extension') != 'garmin':
        raise ValueError('snapshot')
    values = snapshot['values']
    dataset = values['garmin.dataset']
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
    with sqlite3.connect('file:' + quote(str(source), safe='/') + '?mode=ro', uri=True) as src:
        src.row_factory = sqlite3.Row
        raw = src.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from raw_response order by scope,key,endpoint limit 1').fetchone()
        daily = src.execute('select day_key,steps from daily_metric order by day_key limit 1').fetchone()
        if raw is None or daily is None:
            raise ValueError('입력')
        version_row = src.execute("select value from meta where key='normalize_version'").fetchone()
        if version_row is None or not version_row[0].isdigit() or int(version_row[0]) < 1:
            raise ValueError('정규화 버전')
        version = int(version_row[0])
        zone_row = src.execute("select value from meta where key='timezone'").fetchone()
        time_zone = zone_row[0] if zone_row else None
        if time_zone is not None:
            try: ZoneInfo(time_zone)
            except (ZoneInfoNotFoundError, ValueError): raise ValueError('시간대')
        profile_ids = set()
        def profiles(node):
            if isinstance(node, dict):
                for key, value in node.items():
                    if key == 'userProfileId' and isinstance(value, (str, int)) and not isinstance(value, bool) and str(value):
                        profile_ids.add(str(value))
                    else:
                        profiles(value)
            elif isinstance(node, list):
                for value in node: profiles(value)
        for row in src.execute('select raw from raw_response'):
            try: profiles(json.loads(row[0]))
            except (ValueError, TypeError): pass
        account = next(iter(profile_ids)) if len(profile_ids) == 1 else None
        confirmed = account is not None
        raw = dict(raw); daily = dict(daily)
    text = legacy.read_bytes()
    text.decode('utf-8')
    content_hash = digest(text)
    raw_hash = digest(raw['raw'].encode('utf-8'))
    batch = digest((dataset + raw_hash + content_hash).encode())
    raw_key = json.dumps([raw['scope'], raw['key'], raw['endpoint']], ensure_ascii=False, separators=(',', ':'))
    records = [
        ('raw_response', raw_key, 'raw', digest(json.dumps(raw, ensure_ascii=False, sort_keys=True).encode())),
        ('daily_metric', daily['day_key'], 'health', digest(json.dumps([daily, version, raw_hash, time_zone], ensure_ascii=False, sort_keys=True).encode())),
        ('legacy_markdown', artifact_key, 'analysis', content_hash),
    ]
    staging_key = digest(json.dumps([dataset, artifact_key, content_hash], ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
    staged = staging / (staging_key + '.md')
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as probe:
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
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
        with conn.cursor() as cur:
            cur.execute('select dataset from garmin.raw_payloads where account is not distinct from %s and scope=%s and original_key=%s and endpoint=%s', (account,raw['scope'],raw['key'],raw['endpoint']))
            existing_raw = cur.fetchone()
            if existing_raw and existing_raw[0] != dataset: raise ValueError('conflict')
            cur.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,%s) on conflict do nothing', (dataset,account,confirmed))
            cur.execute('select account,account_confirmed from garmin.datasets where dataset=%s', (dataset,))
            if cur.fetchone() != (account,confirmed): raise ValueError('conflict')
            cur.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,%s) on conflict do nothing', (batch,dataset,now))
            ids = {}
            for table, key, kind, hashed in records:
                cur.execute('select target_id,content_hash from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind=%s', (dataset,table,key,kind))
                previous = cur.fetchone()
                if previous:
                    if previous[1] != hashed: raise ValueError('conflict')
                    ids[kind] = previous[0]
                else:
                    ids[kind] = uuid7()
                    cur.execute('insert into garmin.import_mapping(dataset,original_table,original_key,target_kind,target_id,content_hash,batch) values (%s,%s,%s,%s,%s,%s,%s)', (dataset,table,key,kind,ids[kind],hashed,batch))
                    if kind == 'raw':
                        cur.execute('insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (dataset,batch,account,raw['scope'],raw['key'],raw['endpoint'],raw['fetched_at'],raw['checked_at'],raw['library_version'],raw['raw']))
                    elif kind == 'health':
                        cur.execute('insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,revision,fetched_at,normalization_version,time_zone,time_zone_missing,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s / 1000.0),%s,%s,%s,%s,%s)', (ids[kind],'garmin',dataset,batch,table,key,account,confirmed,'steps',daily['steps'],'count',daily['day_key'],raw_hash,raw['fetched_at'],version,time_zone,time_zone is None,work,token))
                    else:
                        file_id = uuid7()
                        cur.execute('insert into garmin.import_mapping(dataset,original_table,original_key,target_kind,target_id,content_hash,batch) values (%s,%s,%s,%s,%s,%s,%s)', (dataset,table,key,'file',file_id,hashed,batch))
                        cur.execute('insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)', (file_id,'garmin',json.dumps([dataset,key],ensure_ascii=False,separators=(',', ':')),dataset,batch,staged.name,content_hash,len(text),'text/markdown',now,work,token))
                        cur.execute('insert into brain.analyses(id,source,dataset,import_batch,original_table,original_key,revision,model_missing,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) values (%s,%s,%s,%s,%s,%s,1,true,true,%s,%s,%s)', (ids[kind],'garmin',dataset,batch,table,key,file_id,work,token))
    emit('result', summary='이전 완료')


try:
    main()
except psycopg.errors.UniqueViolation:
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
