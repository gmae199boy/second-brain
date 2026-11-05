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
from reader import read_snapshot, SQLiteText, InvalidSQLiteText
from raw_codec import dataset_ref, project, restore
from metadata_codec import safe_dumps
from role_probe import probe_role
from preflight import ORDER

# core 건강 발행 제거로 기존 checkpoint의 계약 fingerprint와 호환되지 않는다.
VERSION = 3


class RowMismatch(Exception):
    pass


def encoded(value):
    if isinstance(value, (SQLiteText, InvalidSQLiteText)):
        return {'type': 'text', 'encoding': value.encoding, 'base64': base64.b64encode(value.raw).decode('ascii')}
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
    return safe_dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'))


def contains_nul(value):
    if isinstance(value, str):
        try: value.encode('utf-8')
        except UnicodeEncodeError: return True
        return '\x00' in value
    if isinstance(value, list): return any(contains_nul(item) for item in value)
    if isinstance(value, dict): return any(contains_nul(key) or contains_nul(item) for key, item in value.items())
    return False


def contract_fingerprint(manifest):
    contract = ['raw-v2', 'text-codec-v1', 'canonical-sqlite-v2', 'json-projection-v2', manifest]
    return hashlib.sha256(canonical(contract).encode('utf-8')).hexdigest()


def reconcile_raw(cur, dataset, batch, account, row):
    values = [account, row['scope'], row['key'], row['endpoint'], row['library_version'], row['raw']]
    projections = [project(v) for v in values]
    identity = canonical([encoded(row[k]) for k in ('scope', 'key', 'endpoint')])
    displays = [v[0] for v in projections]
    cur.execute('''select account,scope,original_key,endpoint,library_version,body,
        fetched_at_ms,checked_at_ms, account_raw,account_encoding,scope_raw,scope_encoding,
        original_key_raw,original_key_encoding,endpoint_raw,endpoint_encoding,
        library_version_raw,library_version_encoding,body_raw,body_encoding,raw_identity
        from garmin.raw_payloads where dataset=%s and (raw_identity=%s or
        (raw_identity is null and scope=%s and original_key=%s and endpoint=%s))''',
        (dataset, identity, displays[1], displays[2], displays[3]))
    old = cur.fetchall()
    def original(v):
        if isinstance(v, (SQLiteText, InvalidSQLiteText)):
            return v.encoding, v.raw
        return ('utf-8', v.encode('utf-8')) if isinstance(v, str) else None
    matching = []
    try:
        for stored in old:
            exact = [restore(stored[i], stored[8+i*2], stored[9+i*2]) for i in range(6)]
            exact_key = [original(exact[i]) for i in (1, 2, 3)] == [original(values[i]) for i in (1, 2, 3)]
            legacy_key = stored[20] is None and all(isinstance(values[i], str) and exact[i] == values[i] for i in (1, 2, 3))
            if exact_key or legacy_key:
                matching.append((stored, exact))
        if matching:
            if len(matching) != 1: return False
            stored, exact = matching[0]
            if [original(v) for v in exact] == [original(v) for v in values] and stored[6:8] == (row['fetched_at'], row['checked_at']):
                return True
            # 옛 tracer의 TEXT는 항상 논리 Unicode만 저장했으므로 동일 원문에 한해 원형 쌍을 보강한다.
            if stored[20] is None and stored[6:8] == (row['fetched_at'], row['checked_at']) and all((value is None and old is None) or (isinstance(value, str) and old == value) for old, value in zip(exact, values)):
                pairs = [part for _, raw, encoding in projections for part in (raw, encoding)]
                cur.execute('''update garmin.raw_payloads set raw_identity=%s, account_raw=%s,account_encoding=%s,
                    scope_raw=%s,scope_encoding=%s,original_key_raw=%s,original_key_encoding=%s,
                    endpoint_raw=%s,endpoint_encoding=%s,library_version_raw=%s,library_version_encoding=%s,
                    body_raw=%s,body_encoding=%s where dataset=%s and raw_identity is null and scope=%s and original_key=%s and endpoint=%s''',
                    [identity,*pairs,dataset,displays[1],displays[2],displays[3]])
                return cur.rowcount == 1
            return False
    except ValueError:
        return False
    args = [dataset,batch,*displays[:4],row['fetched_at'],row['checked_at'],*displays[4:],identity]
    for _, raw, encoding in projections:
        args.extend((raw, encoding))
    cur.execute('''insert into garmin.raw_payloads
        (dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body,raw_identity,
         account_raw,account_encoding,scope_raw,scope_encoding,original_key_raw,original_key_encoding,
         endpoint_raw,endpoint_encoding,library_version_raw,library_version_encoding,body_raw,body_encoding)
        values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''', args)
    return True


def insert_legacy(cur, ident, conversation, dataset, label, table, key, batch, row):
    fields = ('local_date', 'event', 'detail') if table == 'notification' else ('original_id', 'local_date', 'kind', 'event', 'reason')
    values = {'original_id': str(row['id'])} if table == 'delivery' else {}
    values.update(row)
    columns = ['id', 'conversation_id', 'source', 'dataset', 'original_table', 'original_key', 'import_batch']
    args = [ident, conversation, 'garmin', dataset, table, key, batch]
    if label is not None:
        columns.extend(('dataset_label', 'dataset_label_raw', 'dataset_label_encoding'))
        args.extend(project(label))
    for field in fields:
        display, raw, encoding = project(values[field])
        columns.extend((field, field + '_raw', field + '_encoding'))
        args.extend((display, raw, encoding))
    if table == 'delivery':
        columns.append('ok'); args.append(bool(row['ok']))
    columns.extend(('at', 'source_work_item_id', 'source_attempt_token'))
    args.extend((datetime.fromtimestamp(row['at'] / 1000, timezone.utc), os.environ['BRAIN_WORK_ID'], os.environ['BRAIN_ATTEMPT_TOKEN']))
    target = 'channel_legacy_notifications' if table == 'notification' else 'channel_legacy_deliveries'
    cur.execute('insert into brain.' + target + ' (' + ','.join(columns) + ') values (' + ','.join(['%s'] * len(args)) + ')', args)


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


def ingest(conn, capture, entry, conversation):
    dataset = entry['dataset']
    label = entry['dataset_label']
    label_display, label_raw, label_encoding = project(label)
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
    account_display, account_raw, account_encoding = project(acct['account'])
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
            cur.execute('insert into garmin.datasets(dataset,account,account_confirmed,account_raw,account_encoding,dataset_label,dataset_label_raw,dataset_label_encoding) values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict (dataset) do nothing', (dataset,account_display,acct['confirmed'],account_raw,account_encoding,label_display,label_raw,label_encoding))
            cur.execute('select account,account_confirmed,account_raw,account_encoding,dataset_label,dataset_label_raw,dataset_label_encoding from garmin.datasets where dataset=%s',(dataset,))
            previous_account = cur.fetchone()
            account_mismatch = (previous_account[1] != acct['confirmed'] or restore(previous_account[0], previous_account[2], previous_account[3]) != acct['account'] or restore(previous_account[4], previous_account[5], previous_account[6]) != label)
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
                if skipping and (name, key) == resume: skipping = False
                hashed=hashlib.sha256(payload.encode()).hexdigest()
                try:
                    with conn.transaction():
                        cur=conn.cursor(); check(cur)
                        cur.execute("select target_id,content_hash from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind='preserved'",(dataset,name,key))
                        old=cur.fetchone(); mismatch=bool(old and old[1] != hashed)
                        if old and not mismatch:
                            parent = None
                            if name == 'fetch_error' and row.get('run_id') is not None:
                                parentkey = canonical([encoded(row['run_id'])])
                                cur.execute("select target_id from garmin.import_mapping where dataset=%s and original_table='run' and original_key=%s and target_kind='preserved'", (dataset,parentkey))
                                found = cur.fetchone()
                                if not found: raise ValueError('IMPORT_INVALID')
                                parent = found[0]
                            cur.execute('select dataset,original_table,original_key,values_json,run_id from garmin.preserved_rows where id=%s', (old[0],))
                            stored = cur.fetchone()
                            if stored is None:
                                cur.execute('insert into garmin.preserved_rows values (%s,%s,%s,%s,%s::jsonb,%s)', (old[0],dataset,name,key,payload,parent))
                            elif stored != (dataset,name,key,json.loads(payload),parent):
                                mismatch = True
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
                        if not mismatch and name in ('notification', 'delivery'):
                            if conversation is None: raise ValueError('IMPORT_INVALID')
                            cur.execute('select conversation_id from garmin.legacy_conversations where dataset=%s and original_table=%s and original_key=%s',(dataset,name,key))
                            previous_conversation = cur.fetchone()
                            if previous_conversation and previous_conversation[0] != conversation:
                                mismatch = True
                            else:
                                if not previous_conversation: cur.execute('insert into garmin.legacy_conversations values (%s,%s,%s,%s)',(dataset,name,key,conversation))
                                cur.execute("select target_id,content_hash,batch from garmin.import_mapping where dataset=%s and original_table=%s and original_key=%s and target_kind='legacy'",(dataset,name,key))
                                legacy = cur.fetchone()
                                if legacy and legacy[1] != hashed: mismatch = True
                                else:
                                    legacy_id, legacy_batch = (legacy[0],legacy[2]) if legacy else (uuid7(),batch)
                                    if not legacy: cur.execute("insert into garmin.import_mapping values (%s,%s,%s,'legacy',%s,%s,%s)",(dataset,name,key,legacy_id,hashed,batch))
                                    try:
                                        with conn.transaction(): insert_legacy(cur, legacy_id, conversation, dataset, label, name, key, legacy_batch, row)
                                    except (psycopg.errors.RaiseException, psycopg.errors.UniqueViolation):
                                        mismatch = True
                        if not mismatch and name == 'raw_response':
                            mismatch = not reconcile_raw(cur, dataset, batch, acct['account'], row)
                        if not mismatch:
                            cur.execute('update garmin.import_checkpoints set original_table=%s,original_key=%s where batch=%s and dataset=%s',(name,key,batch,dataset))
                        if mismatch: raise RowMismatch()
                except RowMismatch:
                    mismatch = True
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
    return {'snapshot': snapshot, 'sha256': source_hash}


def run():
    try:
        settings=json.loads(os.environ['BRAIN_SETTINGS_SNAPSHOT'])
        if settings.get('version') != 1 or settings.get('extension') != 'garmin': raise ValueError('IMPORT_INVALID')
        capture=load_capture(settings['values']['garmin.capture_manifest'])
        for entry in capture['private']['datasets']:
            original = entry['dataset']; entry['dataset'] = dataset_ref(original)
            entry['dataset_label'] = original if original != entry['dataset'] else None
        conversation = settings['values'].get('garmin.legacy_conversation_id')
        if conversation: conversation = UUID(conversation)
        entries = capture['private']['datasets']
        ordered = sorted(entries, key=lambda e: ORDER.index(ROLES[e['source']]))
        with psycopg.connect(os.environ['BRAIN_DATABASE_URL'], options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                if not all(probe_role(conn).values()): raise ValueError('IMPORT_INVALID')
            capture['private']['fingerprint'] = contract_fingerprint(capture['private']['fingerprint'])
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
            verified = {entry['dataset']: ingest(conn,capture,entry,conversation) for entry in ordered}
            from artifact_publish import publish
            publish(conn,capture,ordered,verified)
            from reports import write_reports
            from metadata_codec import decode_metadata
            with conn.transaction():
                cur=conn.cursor(); check(cur)
                artifact_rows=cur.execute('select dataset,artifact_key,category,exclusion_reason,request_id,analysis_id,metadata,metadata_raw,unlinked_reason,original_table from garmin.artifact_inventory order by dataset,original_table,artifact_key').fetchall()
                inventory_rows=cur.execute('select dataset,category,state,metadata,metadata_raw from garmin.input_inventory order by dataset,category').fetchall()
                relation_rows=cur.execute('select dataset,artifact_key,analysis_key,role,request_id,analysis_id,reason from garmin.artifact_relations order by dataset,artifact_key,analysis_key,role').fetchall()
            from artifacts import decode_identity
            private={'artifacts':[{'dataset':r[0],'key':decode_identity(r[1]),'category':r[2],'reason':r[3],'request_id':str(r[4]) if r[4] else None,'analysis_id':str(r[5]) if r[5] else None,'metadata':decode_metadata(r[6],r[7]),'unlinked_reason':r[8],'original_table':r[9]} for r in artifact_rows],
                     'inventory':[{'dataset':r[0],'category':r[1],'state':r[2],'metadata':decode_metadata(r[3],r[4])} for r in inventory_rows],
                     'relations':[{'dataset':r[0],'artifact_key':decode_identity(r[1]),'analysis_key':decode_identity(r[2]),'role':r[3],'request_id':str(r[4]) if r[4] else None,'analysis_id':str(r[5]) if r[5] else None,'reason':r[6]} for r in relation_rows],
                     'unassigned_files':[{'source':f['source'],'reason':'unknown_provenance'} for f in capture['private']['files']] if capture['private']['version']==1 else []}
            public={'counts':{'artifacts':len(artifact_rows),'excluded':sum(1 for r in artifact_rows if r[3]),'unlinked':len({(r[0],r[1]) for r in relation_rows if r[6] and r[4] is not None} | {(r[0],r[1]) for r in artifact_rows if r[8]}),'unassigned':len(private['unassigned_files'])}}
            write_reports(os.environ['BRAIN_EXTENSION_HOME'],os.environ['BRAIN_WORK_ID'],private,public)
        print(json.dumps({'abi':1,'type':'result','summary':'이전 완료'}),flush=True)
    except Exception as exc:
        code = 'IMPORT_CONFLICT' if str(exc) == 'IMPORT_CONFLICT' else 'IMPORT_INVALID'
        state = getattr(exc, 'sqlstate', None)
        retryable = (state is None and isinstance(exc, psycopg.OperationalError)) or state in ('40001','40P01','55P03','57014','25P04','57P01','57P02','57P03') or bool(state and state.startswith('08'))
        print(json.dumps({'abi':1,'type':'error','code':code,'retryable':retryable}),flush=True)
        sys.exit(1)
