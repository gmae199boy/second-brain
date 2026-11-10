"""Copy preserved SQLite rows to account-scoped native tables in fenced units."""
from import_scope import batch_id
import hashlib
import contextlib
from garmin_pipeline.store import account_write_lock_key
import json
import math
import os
from uuid import UUID, uuid7
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError
from psycopg.rows import tuple_row
from psycopg.pq import TransactionStatus

from batch_import import canonical, check, conflict, encoded
from contract import BY_VERSION, COLUMNS
from preflight import account
from reader import InvalidSQLiteText

VERSION = 1
ORDER = ('auth_event', 'raw_response', 'run', 'fetch_error', 'meta', 'notification',
         'normalize_result', 'daily_metric', 'body_battery_sample', 'hr_sample',
         'activity', 'activity_hr_sample', 'exercise_set', 'stress_bb_sample',
         'delivery', 'day_summary', 'workout', 'exercise_log', 'evaluation')
LOCAL_ID = frozenset(('auth_event', 'run', 'fetch_error', 'delivery'))


def envelope(settings):
    try:
        user = UUID(os.environ['BRAIN_USER_ID'])
        if UUID(settings['user_id']) != user:
            raise ValueError()
        timezone = settings['values']['garmin.timezone']
        if not isinstance(timezone, str) or not timezone or timezone != timezone.strip():
            raise ValueError()
        ZoneInfo(timezone)
        return user, timezone
    except (KeyError, TypeError, ValueError, ZoneInfoNotFoundError):
        raise ValueError('IMPORT_INVALID') from None


def clean(value):
    if isinstance(value, InvalidSQLiteText) or isinstance(value, bytes):
        raise ValueError('IMPORT_INVALID')
    if isinstance(value, str):
        if '\0' in value:
            raise ValueError('IMPORT_INVALID')
        value.encode('utf-8', 'strict')
        return str(value)
    if isinstance(value, float) and not math.isfinite(value):
        raise ValueError('IMPORT_INVALID')
    if value is None or type(value) in (int, float):
        return value
    raise ValueError('IMPORT_INVALID')


def _source_key(table, row):
    return canonical([encoded(row[k]) for k in table['keys']])


def _native_key(table, row):
    return canonical([clean(row[k]) for k in table['keys']])


def _connect_account(conn, user, profile, timezone):
    profile = clean(profile)
    if not isinstance(profile, str) or not profile:
        raise ValueError('IMPORT_INVALID')
    with conn.transaction():
        cur = conn.cursor(); check(cur)
        cur.execute('select connection_id,timezone from garmin.account_connections where user_id=%s and external_identity=%s', (user, profile))
        found = cur.fetchone()
        if found is None:
            connection = uuid7()
            cur.execute('insert into garmin.account_connections(user_id,connection_id,external_identity,tokenstore_ref,timezone) values (%s,%s,%s,NULL,%s) on conflict (user_id,external_identity) do nothing', (user, connection, profile, timezone))
            cur.execute('select connection_id,timezone from garmin.account_connections where user_id=%s and external_identity=%s', (user, profile))
            found = cur.fetchone()
        if found is None or found[1] != timezone:
            raise ValueError('IMPORT_CONFLICT')
        check(cur)
        return found[0]


def _copy_row(cur, user, connection, name, table, row, provenance):
    columns = table['columns']
    if name not in ORDER or not table['keys'] or set(columns) - set(COLUMNS[name]):
        raise ValueError('IMPORT_INVALID')
    values = [clean(row[col]) for col in columns]
    target = 'evaluation_revisions' if name == 'evaluation' else name
    names = ['user_id', 'connection_id', *columns]
    args = [user, connection, *values]
    if name == 'evaluation':
        names.append('revision'); args.append(1)
    if name in LOCAL_ID:
        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', ('garmin:sequence:' + name,))
    marks = ','.join(['%s'] * len(args))
    cur.execute('insert into garmin.' + target + ' (' + ','.join(names) + ') values (' + marks + ') on conflict do nothing', args)
    predicates = ['user_id=%s', 'connection_id=%s'] + [key + '=%s' for key in table['keys']]
    key_args = [user, connection, *(clean(row[key]) for key in table['keys'])]
    if name == 'evaluation': predicates.append('revision=1')
    cur.execute('select ' + ','.join(columns) + ' from garmin.' + target + ' where ' + ' and '.join(predicates), key_args)
    actual = cur.fetchone()
    if actual is None or tuple(values) != tuple(actual):
        raise ValueError('IMPORT_CONFLICT')
    if name in LOCAL_ID:
        # Identity sequences are shared across accounts and must clear imported IDs.
        cur.execute("select setval(pg_get_serial_sequence(%s,'id'), greatest((select last_value from garmin." + name + "_id_seq), %s, 1), true)", ('garmin.' + name, clean(row['id'])))
    if name == 'exercise_log':
        dataset, batch, rowid = provenance
        cur.execute('select source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s and activity_id=%s and exercise=%s', (user,connection,clean(row['activity_id']),clean(row['exercise'])))
        old = cur.fetchone()
        if old is None:
            cur.execute('insert into garmin.exercise_log_order(user_id,connection_id,activity_id,exercise,source_order,source_dataset,source_batch,source_rowid) select %s,%s,%s,%s,coalesce(max(source_order),0)+1,%s,%s,%s from garmin.exercise_log_order where user_id=%s and connection_id=%s', (user,connection,clean(row['activity_id']),clean(row['exercise']),dataset,batch,rowid,user,connection))


def validate_sources(entries, verified, settings=None, *, fixed4=False):
    """Validate every selected account/schema/value before the first durable write."""
    if settings is not None: envelope(settings)
    profiles = set()
    for entry in entries:
        snapshot = verified[entry['dataset']]['snapshot']
        info = account(snapshot)
        if not info['confirmed']: raise ValueError('IMPORT_INVALID')
        profile = clean(info['account'])
        if not isinstance(profile, str) or not profile: raise ValueError('IMPORT_INVALID')
        profiles.add(profile)
        expected = os.environ.get('BRAIN_ACCOUNT')
        if expected is not None and expected != profile: raise ValueError('IMPORT_INVALID')
        expected_tables = BY_VERSION.get(snapshot['schema'])
        if expected_tables is None or set(expected_tables) - set(snapshot['tables']):
            raise ValueError('IMPORT_INVALID')
        for name, table in snapshot['tables'].items():
            if not table['keys']: raise ValueError('IMPORT_INVALID')
            if name in expected_tables and set(expected_tables[name]) - set(table['columns']):
                raise ValueError('IMPORT_INVALID')
            if name == 'activity_recovery': continue
            if name not in ORDER or set(table['columns']) - set(COLUMNS[name]):
                raise ValueError('IMPORT_INVALID')
            for row in table['rows']:
                for column in table['columns']: clean(row[column])
    if fixed4 and len(profiles) != 1: raise ValueError('IMPORT_INVALID')
    return profiles


@contextlib.contextmanager
def account_locks(conn, capture, entries, verified, settings):
    """Serialize the complete native import and file-link stage with writers."""
    user, timezone = envelope(settings)
    if capture['private'].get('version') == 3:
        profiles = validate_sources(entries, verified, settings, fixed4=True)
        # Check every existing connection before creating any account connection.
        with conn.transaction():
            cur = conn.cursor(); check(cur)
            for profile in sorted(profiles):
                cur.execute('select timezone from garmin.account_connections where user_id=%s and external_identity=%s', (user, profile))
                existing = cur.fetchone()
                if existing is not None and existing[0] != timezone: raise ValueError('IMPORT_CONFLICT')
    connections = set()
    for entry in entries:
        info = account(verified[entry['dataset']]['snapshot'])
        if not info['confirmed']: raise ValueError('IMPORT_INVALID')
        expected = os.environ.get('BRAIN_ACCOUNT')
        if expected is not None and expected != info['account']:
            batch = batch_id(capture, entry['dataset'])
            conflict(conn,entry['dataset'],batch,None,None,'native_account_mismatch')
        try:
            connections.add(_connect_account(conn,user,info['account'],timezone))
        except ValueError as exc:
            if str(exc) == 'IMPORT_CONFLICT':
                batch = batch_id(capture, entry['dataset'])
                conflict(conn,entry['dataset'],batch,None,None,'native_account_mismatch')
            raise
    held = []
    try:
        for connection in sorted(connections, key=str):
            key = account_write_lock_key(user, connection)
            conn.execute('select pg_catalog.pg_advisory_lock(pg_catalog.hashtextextended(%s,0))',(key,))
            held.append(key)
            conn.commit()
        yield
    finally:
        if not conn.closed and conn.info.transaction_status == TransactionStatus.INERROR:
            conn.rollback()
        for key in reversed(held):
            if conn.closed: break
            conn.execute('select pg_catalog.pg_advisory_unlock(pg_catalog.hashtextextended(%s,0))',(key,))
            conn.commit()


def _copy_locked(conn, capture, entries, verified, settings, seam=None):
    """Preservation precedes this call. Replay verifies each row before checkpointing."""
    user, timezone = envelope(settings)
    seam = seam or (lambda stage, dataset, table, key: None)
    profiles = {}
    for entry in entries:
        dataset = entry['dataset']; snapshot = verified[dataset]['snapshot']; info = account(snapshot)
        if not info['confirmed']:
            raise ValueError('IMPORT_INVALID')
        if snapshot['schema'] not in BY_VERSION:
            raise ValueError('IMPORT_INVALID')
        expected_tables = BY_VERSION[snapshot['schema']]
        if set(expected_tables) - set(snapshot['tables']): raise ValueError('IMPORT_INVALID')
        for name, table in snapshot['tables'].items():
            if name in expected_tables and set(expected_tables[name]) - set(table['columns']): raise ValueError('IMPORT_INVALID')
            if name == 'activity_recovery':
                continue  # Legacy-only table remains in preserved_rows.
            if name not in ORDER or set(table['columns']) - set(COLUMNS[name]):
                raise ValueError('IMPORT_INVALID')
        profiles[dataset] = info['account']
        expected_account = os.environ.get('BRAIN_ACCOUNT')
        if expected_account is not None and expected_account != info['account']:
            batch = batch_id(capture, dataset)
            conflict(conn,dataset,batch,None,None,'native_account_mismatch')
    connections = {}
    for entry in entries:
        dataset = entry['dataset']; profile = profiles[dataset]
        if profile in connections: continue
        try:
            connections[profile] = _connect_account(conn, user, profile, timezone)
        except ValueError as exc:
            if str(exc) == 'IMPORT_CONFLICT':
                batch = batch_id(capture, dataset)
                conflict(conn, dataset, batch, None, None, 'native_account_mismatch')
            raise
    fingerprint = hashlib.sha256(canonical([VERSION, capture['private']['fingerprint'], str(user), timezone,
        [(e['dataset'], verified[e['dataset']]['sha256'], profiles[e['dataset']]) for e in entries]]).encode()).hexdigest()
    batches = {e['dataset']: batch_id(capture, e['dataset']) for e in entries}
    for entry in entries:
        dataset = entry['dataset']; data = verified[dataset]; connection = connections[profiles[dataset]]; batch = batches[dataset]
        expected = (data['sha256'], data['snapshot']['schema'], VERSION, fingerprint)
        with conn.transaction():
            cur=conn.cursor(); check(cur)
            cur.execute('select source_hash,schema_version,importer_version,manifest_fingerprint from garmin.native_import_checkpoints where batch=%s and dataset=%s and user_id=%s and connection_id=%s', (batch,dataset,user,connection))
            previous=cur.fetchone()
            if previous is None:
                cur.execute('insert into garmin.native_import_checkpoints(batch,dataset,user_id,connection_id,source_hash,schema_version,importer_version,manifest_fingerprint) values (%s,%s,%s,%s,%s,%s,%s,%s)', (batch,dataset,user,connection,*expected))
            elif previous == expected:
                cur.execute('update garmin.native_import_checkpoints set completed=false where batch=%s and dataset=%s and user_id=%s and connection_id=%s', (batch,dataset,user,connection))
            check(cur)
        if previous is not None and previous != expected:
            conflict(conn,dataset,batch,None,None,'native_checkpoint_mismatch')
    selected = {}
    exercise_order = {}
    for name in ORDER:
        for entry in entries:
            dataset=entry['dataset']; snapshot=verified[dataset]['snapshot']; table=snapshot['tables'].get(name)
            if not table: continue
            connection=connections[profiles[dataset]]; batch=batches[dataset]
            rows=list(zip(table['rows'], table['rowids'] or [None]*len(table['rows']), strict=True))
            rows.sort(key=lambda pair: pair[1] if name == 'exercise_log' else _source_key(table,pair[0]))
            for row, rowid in rows:
                key=_source_key(table,row); native_key=_native_key(table,row); selection=(connection,name,native_key)
                payload=canonical({k:encoded(v) for k,v in row.items()}); hashed=hashlib.sha256(payload.encode()).hexdigest()
                if selection in selected:
                    if name in LOCAL_ID and selected[selection] != hashed:
                        conflict(conn,dataset,batch,name,key,'native_local_id_collision')
                    continue
                selected[selection]=hashed
                if name == 'exercise_log':
                    if rowid is None: raise ValueError('IMPORT_INVALID')
                source_order=(dataset,batch,rowid) if name == 'exercise_log' else None
                if name == 'exercise_log':
                    exercise_order.setdefault(connection, []).append((clean(row['activity_id']), clean(row['exercise']), dataset, batch, rowid))
                seam('before',dataset,name,key)
                try:
                    with conn.transaction():
                        cur=conn.cursor(); check(cur)
                        cur.execute('select native_key,content_hash from garmin.native_import_mapping where dataset=%s and original_table=%s and original_key=%s and user_id=%s and connection_id=%s', (dataset,name,key,user,connection))
                        old=cur.fetchone()
                        if old and old != (native_key,hashed): raise ValueError('IMPORT_CONFLICT')
                        _copy_row(cur,user,connection,name,table,row,source_order)
                        if not old:
                            cur.execute('insert into garmin.native_import_mapping(dataset,original_table,original_key,user_id,connection_id,batch,native_key,content_hash) values (%s,%s,%s,%s,%s,%s,%s,%s)', (dataset,name,key,user,connection,batch,native_key,hashed))
                        cur.execute('update garmin.native_import_checkpoints set original_table=%s,original_key=%s where batch=%s and dataset=%s and user_id=%s and connection_id=%s', (name,key,batch,dataset,user,connection))
                        check(cur)
                except ValueError as exc:
                    if str(exc)=='IMPORT_CONFLICT': conflict(conn,dataset,batch,name,key,'native_row_mismatch')
                    raise
                seam('after',dataset,name,key)
    # Publish the selected prefix and the retained native suffix together with
    # completion. Existing readers see either the old order or the new order.
    seam('before_order_publish', None, None, None)
    with conn.transaction():
        cur=conn.cursor(); check(cur)
        if exercise_order:
            cur.execute('set constraints all deferred')
        for connection, chosen in exercise_order.items():
            cur.execute('select activity_id,exercise from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order', (user,connection))
            existing=cur.fetchall()
            chosen_keys={(activity,exercise) for activity,exercise,_,_,_ in chosen}
            remainder=[(activity,exercise,None,None,None) for activity,exercise in existing if (activity,exercise) not in chosen_keys]
            for index,(activity,exercise,dataset,batch,rowid) in enumerate(chosen + remainder,1):
                if dataset is None:
                    cur.execute('update garmin.exercise_log_order set source_order=%s where user_id=%s and connection_id=%s and activity_id=%s and exercise=%s', (index,user,connection,activity,exercise))
                else:
                    cur.execute('update garmin.exercise_log_order set source_order=%s,source_dataset=%s,source_batch=%s,source_rowid=%s where user_id=%s and connection_id=%s and activity_id=%s and exercise=%s', (index,dataset,batch,rowid,user,connection,activity,exercise))
        seam('during_order_publish', None, None, None)
        for entry in entries:
            dataset=entry['dataset']; connection=connections[profiles[dataset]]
            cur.execute('update garmin.native_import_checkpoints set completed=true where batch=%s and dataset=%s and user_id=%s and connection_id=%s', (batches[dataset],dataset,user,connection))
        check(cur)


def copy(conn, capture, entries, verified, settings, seam=None):
    with account_locks(conn, capture, entries, verified, settings):
        _copy_locked(conn, capture, entries, verified, settings, seam)


def verify(conn, capture, entries, verified, settings, *, progress=lambda: None):
    """Read-only native checkpoint, selected row, mapping and order verification."""
    user, timezone = envelope(settings)
    profiles = {}
    for entry in entries:
        progress()
        info = account(verified[entry['dataset']]['snapshot'])
        if not info['confirmed']: return False
        profiles[entry['dataset']] = info['account']
        expected_account = os.environ.get('BRAIN_ACCOUNT')
        if expected_account is not None and expected_account != info['account']: return False
    from batch_import import contract_fingerprint
    fingerprint = hashlib.sha256(canonical([VERSION, contract_fingerprint(capture['private']['fingerprint']), str(user), timezone,
        [(e['dataset'], verified[e['dataset']]['sha256'], profiles[e['dataset']]) for e in entries]]).encode()).hexdigest()
    cur = conn.cursor(row_factory=tuple_row); connections = {}
    for profile in set(profiles.values()):
        cur.execute('select connection_id,timezone from garmin.account_connections where user_id=%s and external_identity=%s', (user,profile))
        row=cur.fetchone()
        if row is None or row[1] != timezone: return False
        connections[profile]=row[0]
    selected = {}
    last_order = {}
    selected_order = {}
    wanted_mappings = set()
    for entry in entries:
        dataset=entry['dataset']; data=verified[dataset]; connection=connections[profiles[dataset]]
        batch=batch_id(capture, dataset)
        cur.execute('select source_hash,schema_version,importer_version,manifest_fingerprint,completed from garmin.native_import_checkpoints where batch=%s and dataset=%s and user_id=%s and connection_id=%s', (batch,dataset,user,connection))
        if cur.fetchone() != (data['sha256'],data['snapshot']['schema'],VERSION,fingerprint,True): return False
    for name in ORDER:
        for entry in entries:
            dataset=entry['dataset']; table=verified[dataset]['snapshot']['tables'].get(name)
            if not table: continue
            connection=connections[profiles[dataset]]
            rows=list(zip(table['rows'],table['rowids'] or [None]*len(table['rows']),strict=True))
            rows.sort(key=lambda pair: pair[1] if name=='exercise_log' else _source_key(table,pair[0]))
            for row,rowid in rows:
                progress()
                key=_source_key(table,row); native_key=_native_key(table,row); identity=(connection,name,native_key)
                payload=canonical({k:encoded(v) for k,v in row.items()}); hashed=hashlib.sha256(payload.encode()).hexdigest()
                if identity in selected:
                    if name in LOCAL_ID and selected[identity]!=hashed: return False
                    continue
                selected[identity]=hashed
                wanted_mappings.add((dataset, name, key, connection))
                cur.execute('select native_key,content_hash from garmin.native_import_mapping where dataset=%s and original_table=%s and original_key=%s and user_id=%s and connection_id=%s', (dataset,name,key,user,connection))
                if cur.fetchone() != (native_key,hashed): return False
                target='evaluation_revisions' if name=='evaluation' else name
                predicates=['user_id=%s','connection_id=%s']+[k+'=%s' for k in table['keys']]
                args=[user,connection,*(clean(row[k]) for k in table['keys'])]
                if name=='evaluation': predicates.append('revision=1')
                cur.execute('select '+','.join(table['columns'])+' from garmin.'+target+' where '+' and '.join(predicates),args)
                if cur.fetchone() != tuple(clean(row[k]) for k in table['columns']): return False
                if name=='exercise_log':
                    cur.execute('select source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s and activity_id=%s and exercise=%s',(user,connection,clean(row['activity_id']),clean(row['exercise'])))
                    order = cur.fetchone()
                    if order is None or order[1:] != (dataset,batch_id(capture, dataset),rowid) or order[0] <= last_order.get(connection, -9223372036854775809): return False
                    last_order[connection] = order[0]
                    selected_order.setdefault(connection, []).append((clean(row['activity_id']),clean(row['exercise'])))
    if capture['private'].get('version') == 3:
        for entry in entries:
            dataset = entry['dataset']
            cur.execute('select original_table,original_key,connection_id from garmin.native_import_mapping where user_id=%s and dataset=%s and batch=%s', (user,dataset,batch_id(capture,dataset)))
            if any((dataset, name, key, connection) not in wanted_mappings for name,key,connection in cur.fetchall()): return False
    for connection, expected in selected_order.items():
        cur.execute('select activity_id,exercise from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order limit %s', (user,connection,len(expected)))
        if cur.fetchall() != expected: return False
    return True
