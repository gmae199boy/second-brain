"""읽기 전용 capture를 작은 원자 단위로 보존한다."""
import base64
from datetime import datetime, timezone
import hashlib
import json
import os
import sys
from uuid import uuid7, UUID

import psycopg
from capture_manifest import load_capture, ROLES
from preflight import account
from reader import read_snapshot
from health import import_candidates
from role_probe import probe_role
from preflight import ORDER

VERSION = 1


def encoded(value):
    if isinstance(value, bytes):
        return {'type': 'blob', 'base64': base64.b64encode(value).decode('ascii')}
    if value is None:
        return {'type': 'null'}
    if isinstance(value, int):
        return {'type': 'integer', 'value': value}
    if isinstance(value, float):
        return {'type': 'real', 'value': value.hex()}
    if isinstance(value, str):
        if '\x00' in value:
            return {'type': 'text', 'base64': base64.b64encode(value.encode('utf-8')).decode('ascii')}
        return {'type': 'text', 'value': value}
    raise ValueError('IMPORT_INVALID')


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def check(cur):
    cur.execute('select garmin.attempt_valid(%s::uuid,%s::uuid)', (os.environ['BRAIN_WORK_ID'], os.environ['BRAIN_ATTEMPT_TOKEN']))
    if cur.fetchone()[0] is not True:
        raise ValueError('IMPORT_INVALID')


def conflict(conn, dataset, batch, table, key, reason):
    with conn.transaction():
        with conn.cursor() as cur:
            check(cur)
            cur.execute('insert into garmin.import_conflicts values (%s,%s,%s,%s,%s,%s,%s)', (uuid7(), dataset, batch, table, key, reason, datetime.now(timezone.utc)))
    raise ValueError('IMPORT_CONFLICT')


def ingest(conn, capture, entry, catalog, conversation):
    dataset = entry['dataset']
    path = capture['datasets'][ROLES[entry['source']]]
    if path.with_name(path.name + '-wal').exists():
        batch = hashlib.sha256(canonical([capture['private']['capture_id'], dataset]).encode()).hexdigest()
        with conn.transaction():
            cur=conn.cursor(); check(cur)
            cur.execute('select 1 from garmin.import_checkpoints where batch=%s and dataset=%s',(batch,dataset))
            prior=cur.fetchone()
        if prior: conflict(conn,dataset,batch,None,None,'wal_present')
        raise ValueError('IMPORT_INVALID')
    with path.open('rb') as f:
        source_hash = hashlib.file_digest(f, 'sha256').hexdigest()
    snapshot = read_snapshot(path)
    with path.open('rb') as f:
        if hashlib.file_digest(f, 'sha256').hexdigest() != source_hash or path.with_name(path.name + '-wal').exists():
            raise ValueError('IMPORT_INVALID')
    batch = hashlib.sha256(canonical([capture['private']['capture_id'], dataset]).encode()).hexdigest()
    acct = account(snapshot)
    with conn.transaction():
        cur = conn.cursor(); check(cur)
        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (dataset,))
        cur.execute('select source_hash,schema_version,importer_version,manifest_fingerprint,source_role,conversation_id from garmin.import_checkpoints where batch=%s and dataset=%s', (batch,dataset))
        old = cur.fetchone()
    if old and old != (source_hash, snapshot['schema'], VERSION, capture['private']['fingerprint'], entry['source'], conversation):
        conflict(conn, dataset, batch, None, None, 'checkpoint_mismatch')
    # 별도 충돌 확정을 포함해 dataset 전체를 직렬화한다.
    conn.execute('select pg_advisory_lock(hashtextextended(%s,0))', (dataset,)); conn.commit()
    try:
        with conn.transaction():
            cur = conn.cursor(); check(cur)
            cur.execute('select source_hash,schema_version,importer_version,manifest_fingerprint,source_role,conversation_id,original_table,original_key from garmin.import_checkpoints where batch=%s and dataset=%s', (batch,dataset))
            checkpoint = cur.fetchone()
            old = checkpoint[:6] if checkpoint else None
        if old and old != (source_hash, snapshot['schema'], VERSION, capture['private']['fingerprint'], entry['source'], conversation):
            conflict(conn, dataset, batch, None, None, 'checkpoint_mismatch')
        with conn.transaction():
            cur=conn.cursor(); check(cur)
            cur.execute('insert into garmin.datasets values (%s,%s,%s) on conflict (dataset) do nothing', (dataset,acct['account'],acct['confirmed']))
            cur.execute('select account,account_confirmed from garmin.datasets where dataset=%s',(dataset,))
            account_mismatch = cur.fetchone() != (acct['account'],acct['confirmed'])
            if not account_mismatch: cur.execute('insert into garmin.import_batches values (%s,%s,%s) on conflict (id) do nothing',(batch,dataset,datetime.now(timezone.utc)))
            if not account_mismatch: cur.execute('insert into garmin.import_checkpoints(batch,dataset,source_hash,schema_version,importer_version,manifest_fingerprint,source_role,conversation_id) values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict (batch,dataset) do nothing',(batch,dataset,source_hash,snapshot['schema'],VERSION,capture['private']['fingerprint'],entry['source'],conversation))
        if account_mismatch: conflict(conn,dataset,batch,None,None,'account_mismatch')
        resume = (checkpoint[6], checkpoint[7]) if checkpoint and checkpoint[6] is not None else None
        skipping = resume is not None
        for name in sorted(snapshot['tables'], key=lambda n: (n != 'run', n)):
            table=snapshot['tables'][name]
            if not table['keys']:
                raise ValueError('IMPORT_INVALID')
            metadata=canonical(table['column_metadata']); keys=canonical(table['keys'])
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                cur.execute('select schema_version,columns_json,keys_json from garmin.source_schemas where dataset=%s and original_table=%s',(dataset,name))
                old=cur.fetchone()
                mismatch=old is not None and old != (snapshot['schema'],json.loads(metadata),json.loads(keys))
                if not old:
                    cur.execute('insert into garmin.source_schemas values (%s,%s,%s,%s::jsonb,%s::jsonb)',(dataset,name,snapshot['schema'],metadata,keys))
            if mismatch: conflict(conn,dataset,batch,name,None,'schema_mismatch')
            rows=sorted(table['rows'],key=lambda r: canonical([encoded(r[k]) for k in table['keys']]))
            seen=set()
            for row in rows:
                key=canonical([encoded(row[k]) for k in table['keys']]); payload=canonical({k:encoded(v) for k,v in row.items()})
                if key in seen: raise ValueError('IMPORT_INVALID')
                seen.add(key)
                if skipping:
                    with conn.transaction():
                        check(conn.cursor())
                    if (name, key) == resume: skipping = False
                    continue
                hashed=hashlib.sha256(payload.encode()).hexdigest()
                with conn.transaction():
                    cur=conn.cursor(); check(cur)
                    cur.execute("select target_id,content_hash from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind='preserved'",(dataset,name,key))
                    old=cur.fetchone(); mismatch=bool(old and old[1] != hashed)
                    if old and name in ('notification','delivery'):
                        cur.execute('select conversation_id from garmin.legacy_conversations where dataset=%s and original_table=%s and original_key=%s',(dataset,name,key))
                        prior_conversation=cur.fetchone()
                        mismatch = mismatch or not prior_conversation or prior_conversation[0] != conversation
                    if not old:
                        ident=uuid7(); parent=None
                        if name == 'fetch_error' and row.get('run_id') is not None:
                            parentkey=canonical([encoded(row['run_id'])])
                            cur.execute("select target_id from garmin.import_mapping where dataset=%s and original_table='run' and original_key=%s and target_kind='preserved'",(dataset,parentkey))
                            found=cur.fetchone()
                            if not found: raise ValueError('IMPORT_INVALID')
                            parent=found[0]
                        cur.execute('insert into garmin.preserved_rows values (%s,%s,%s,%s,%s::jsonb,%s)',(ident,dataset,name,key,payload,parent))
                        cur.execute("insert into garmin.import_mapping values (%s,%s,%s,'preserved',%s,%s,%s)",(dataset,name,key,ident,hashed,batch))
                        if name in ('notification', 'delivery'):
                            if conversation is None: raise ValueError('IMPORT_INVALID')
                            legacy_id=uuid7()
                            cur.execute('insert into garmin.legacy_conversations values (%s,%s,%s,%s)',(dataset,name,key,conversation))
                            cur.execute("insert into garmin.import_mapping values (%s,%s,%s,'legacy',%s,%s,%s)",(dataset,name,key,legacy_id,hashed,batch))
                            if name == 'notification':
                                cur.execute("insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token) values (%s,%s,'garmin',%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s / 1000.0),%s,%s)",(legacy_id,conversation,dataset,name,key,batch,row['local_date'],row['event'],row['detail'],row['at'],os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN']))
                            else:
                                cur.execute("insert into brain.channel_legacy_deliveries(id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,reason,at,source_work_item_id,source_attempt_token) values (%s,%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,to_timestamp(%s / 1000.0),%s,%s)",(legacy_id,conversation,dataset,name,key,batch,str(row['id']),row['local_date'],row['kind'],row['event'],bool(row['ok']),row['reason'],row['at'],os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN']))
                        for definition, column, candidate, reason in import_candidates(snapshot,catalog,name,row):
                            metric=definition['metric']
                            cur.execute('insert into garmin.import_provenance values (%s,%s,%s,%s,%s)',(dataset,name,key,metric,reason or '발행'))
                            if candidate:
                                value=candidate['value']; kind=definition['type']; health_id=uuid7()
                                cur.execute('insert into garmin.import_mapping values (%s,%s,%s,%s,%s,%s,%s)',(dataset,name,key,'health:' + metric,health_id,hashed,batch))
                                cur.execute("insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_text,value_json,activity_id,sub_identity) values (%s,'garmin',%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)",(health_id,dataset,batch,name,key,acct['account'],acct['confirmed'],metric,value if kind == 'number' else None,definition['unit'],candidate['day'],candidate['observed'],candidate['zone'],candidate['zone'] is None,candidate['revision'],candidate['fetched_at'],candidate['version'],os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN'],kind,value if kind == 'text' else None,canonical(value) if kind == 'json' and value is not None else None,candidate['activity'],key))
                        if name == 'raw_response':
                            cur.execute('insert into garmin.raw_payloads values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)',(dataset,batch,acct['account'],row['scope'],row['key'],row['endpoint'],row['fetched_at'],row['checked_at'],row['library_version'],row['raw']))
                    if not mismatch:
                        cur.execute('update garmin.import_checkpoints set original_table=%s,original_key=%s where batch=%s and dataset=%s',(name,key,batch,dataset))
                if mismatch: conflict(conn,dataset,batch,name,key,'row_mismatch')
        if skipping: raise ValueError('IMPORT_INVALID')
    finally:
        # 서버가 세션을 종료했거나 원래 예외가 있으면 정리 오류로 가리지 않는다.
        pending = sys.exc_info()[0] is not None
        if not conn.closed:
            try:
                conn.execute('select pg_advisory_unlock(hashtextextended(%s,0))',(dataset,)); conn.commit()
            except psycopg.Error:
                if not pending: raise


def run():
    try:
        settings=json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
        if settings.get('version') != 1 or settings.get('extension') != 'garmin': raise ValueError('IMPORT_INVALID')
        capture=load_capture(settings['values']['garmin.capture_manifest'])
        conversation = settings['values'].get('garmin.legacy_conversation_id')
        if conversation: conversation = UUID(conversation)
        entries = capture['private']['datasets']
        ordered = sorted(entries, key=lambda e: ORDER.index(ROLES[e['source']]))
        with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                if not all(probe_role(conn).values()): raise ValueError('IMPORT_INVALID')
                catalog=[row[0] for row in cur.execute('select definition from brain.health_catalog_v1')]
            # 권위 행보다 먼저 모든 기존 checkpoint의 입력을 확인한다.
            for entry in ordered:
                dataset=entry['dataset']; path=capture['datasets'][ROLES[entry['source']]]
                batch=hashlib.sha256(canonical([capture['private']['capture_id'],dataset]).encode()).hexdigest()
                with conn.transaction():
                    cur=conn.cursor(); check(cur)
                    cur.execute('select source_hash,schema_version,importer_version,manifest_fingerprint,source_role,conversation_id from garmin.import_checkpoints where batch=%s and dataset=%s',(batch,dataset))
                    old=cur.fetchone()
                # SQLite는 주 파일 외 WAL에서도 확정 행을 읽으므로 안전한 단일 파일만 받는다.
                if path.with_name(path.name + '-wal').exists():
                    if old: conflict(conn,dataset,batch,None,None,'wal_present')
                    raise ValueError('IMPORT_INVALID')
                with path.open('rb') as source: hashed=hashlib.file_digest(source,'sha256').hexdigest()
                if path.with_name(path.name + '-wal').exists():
                    if old: conflict(conn,dataset,batch,None,None,'wal_present')
                    raise ValueError('IMPORT_INVALID')
                if old and (old[0] != hashed or old[2:] != (VERSION,capture['private']['fingerprint'],entry['source'],conversation)):
                    conflict(conn,dataset,batch,None,None,'checkpoint_mismatch')
                schema=read_snapshot(path)['schema']
                if old and old[1] != schema: conflict(conn,dataset,batch,None,None,'checkpoint_mismatch')
            accounts = {}
            for entry in ordered:
                info = account(read_snapshot(capture['datasets'][ROLES[entry['source']]]))
                with conn.transaction():
                    cur=conn.cursor(); check(cur)
                    cur.execute('select account,account_confirmed from garmin.datasets where dataset=%s',(entry['dataset'],))
                    existing=cur.fetchone()
                if existing and existing != (info['account'],info['confirmed']):
                    batch=hashlib.sha256(canonical([capture['private']['capture_id'],entry['dataset']]).encode()).hexdigest()
                    conflict(conn,entry['dataset'],batch,None,None,'account_mismatch')
                if info['confirmed']: accounts.setdefault(info['account'], []).append(entry['dataset'])
            for acct, datasets in accounts.items():
                with conn.transaction():
                    cur=conn.cursor(); check(cur)
                    cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,1))',(acct,))
                    cur.execute('select datasets from garmin.authority_provenance where account=%s',(acct,))
                    previous=cur.fetchone()
                    authority_mismatch = bool(previous and previous[0] != datasets)
                    if not previous:
                        ident=uuid7()
                        cur.execute("insert into brain.health_authority_rules(id,source,account,revision,datasets,source_work_item_id,source_attempt_token) values (%s,'garmin',%s,1,%s,%s,%s)",(ident,acct,datasets,os.environ['BRAIN_WORK_ID'],os.environ['BRAIN_ATTEMPT_TOKEN']))
                        cur.execute('insert into garmin.authority_provenance values (%s,%s,%s,1)',(acct,datasets,ident))
                if authority_mismatch:
                    first=next(e for e in ordered if e['dataset'] in datasets)
                    batch=hashlib.sha256(canonical([capture['private']['capture_id'],first['dataset']]).encode()).hexdigest()
                    conflict(conn,first['dataset'],batch,None,None,'authority_mismatch')
            for entry in ordered: ingest(conn,capture,entry,catalog,conversation)
        print(json.dumps({'abi':1,'type':'result','summary':'이전 완료'}),flush=True)
    except Exception as exc:
        code = 'IMPORT_CONFLICT' if str(exc) == 'IMPORT_CONFLICT' else 'IMPORT_INVALID'
        state = getattr(exc, 'sqlstate', None)
        retryable = (state is None and isinstance(exc, psycopg.OperationalError)) or state in ('40001','40P01','55P03','57014','25P04','57P01','57P02','57P03') or bool(state and state.startswith('08'))
        print(json.dumps({'abi':1,'type':'error','code':code,'retryable':retryable}),flush=True)
        sys.exit(1)
