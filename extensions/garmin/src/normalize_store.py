"""Immutable health publication and resumable normalization ledger."""
from datetime import datetime, timedelta, timezone
import hashlib
import time
from uuid import UUID, uuid5

from batch_import import canonical, encoded
from collect_store import _write, dataset_for, raw_fingerprint, current_raw_fingerprint
from health import convert, source_endpoint
from raw_codec import project
from reader import SQLiteText
import normalize_tables as tables_rules

NORMALIZATION_VERSION = 8
CHUNK_SIZE = 500
NAMESPACE = UUID('257a8cd9-36ea-5b4d-9ff7-fddc219d1d55')
PRIMARY_KEYS = {
    'daily_metric': ('day_key',), 'activity': ('activity_id',),
    'body_battery_sample': ('day_key', 'ts_ms'), 'stress_bb_sample': ('day_key', 'ts_ms'),
    'hr_sample': ('day_key', 'ts_ms'), 'activity_hr_sample': ('activity_id', 'ts_ms'),
    'exercise_set': ('activity_id', 'set_index'), 'day_summary': ('date',),
    'workout': ('activity_id',), 'exercise_log': ('activity_id', 'exercise'),
}
DAY_TABLES = frozenset(('day_summary', 'workout', 'exercise_log'))


def digest(*parts):
    return hashlib.sha256(canonical(list(parts)).encode('utf-8')).hexdigest()


def raw_revision(body):
    return hashlib.sha256(body.encode('utf-8')).hexdigest()


def day_revision(inputs, labels_sha):
    return digest(sorted((i['scope'], i['key'], i['endpoint'], i['revision'], i['fetched_at_ms']) for i in inputs), labels_sha)


def revision_for(body, fetched_ms, previous):
    """Reuse a reserved matching revision; suffix a repeated hash at a different time."""
    sha = raw_revision(body)
    matching = [(revision, fetched) for revision, fetched in previous if revision == sha or revision == f'{sha}:{fetched}']
    for revision, fetched in matching:
        if fetched == fetched_ms:
            return revision
    return f'{sha}:{fetched_ms}' if matching else sha


def item_batch(dataset, scope, key, endpoint, revision, version=NORMALIZATION_VERSION):
    return 'normalize-' + digest(dataset, scope, key, endpoint, revision, version)


def day_batch(dataset, day, revision, version=NORMALIZATION_VERSION):
    return 'day-values-' + digest(dataset, day, revision, version)


def observations(tables, catalog, *, dataset, account, zone, revision, fetched_ms, batch, endpoint=None, version=NORMALIZATION_VERSION, day=None):
    """Map legacy rows and catalog columns to immutable observation dictionaries."""
    result = []
    for table, rows in tables.items():
        if table not in PRIMARY_KEYS:
            continue
        for row in rows:
            original_key = canonical([encoded(SQLiteText(row[k].encode('utf-8'), 'utf-8') if isinstance(row[k], str) else row[k]) for k in PRIMARY_KEYS[table]])
            activity = str(row['activity_id']) if row.get('activity_id') is not None else None
            observed = datetime.fromtimestamp(row['ts_ms'] / 1000, timezone.utc) if row.get('ts_ms') is not None else None
            local_day = None if observed is not None else row.get('day_key') or row.get('date') or day
            if local_day is None and observed is None:
                raise ValueError('NORMALIZE_MISSING_DATE')
            for metric in catalog:
                for mapping in metric['mappings']:
                    column = mapping['column']
                    if mapping['table'] != table or column not in row:
                        continue
                    if endpoint is not None and source_endpoint(table, column) != endpoint:
                        continue
                    value = convert(metric, table, column, row[column])
                    storage_key = ['garmin', dataset, account, table, original_key, metric['metric'], activity, original_key, local_day, observed.isoformat() if observed else None, zone, version, revision]
                    result.append(dict(id=uuid5(NAMESPACE, canonical(storage_key)), dataset=dataset, batch=batch,
                        table=table, key=original_key, account=account, metric=metric['metric'], value=value,
                        kind=metric['type'], unit=metric['unit'], day=local_day, observed=observed, zone=zone,
                        revision=revision, fetched=datetime.fromtimestamp(fetched_ms / 1000, timezone.utc),
                        version=version, activity=activity))
    return result


def _authority(cur, dataset, account, work_id, token):
    identity = canonical(encoded(account))
    cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,1))', (identity,))
    cur.execute('select rule_id from garmin.authority_v2 where account_identity=%s', (identity,))
    if cur.fetchone():
        return
    cur.execute('select datasets from garmin.authority_provenance where account_identity=%s or (account_identity is null and account=%s)', (identity, account))
    old = cur.fetchone()
    datasets = [dataset] + [d for d in (old[0] if old else []) if d != dataset]
    rule_id = uuid5(NAMESPACE, canonical(['authority', identity, 2]))
    cur.execute("insert into brain.health_authority_rules(id,source,account,revision,datasets,source_work_item_id,source_attempt_token) values (%s,'garmin',%s,2,%s,%s,%s)", (rule_id, account, datasets, work_id, token))
    cur.execute('insert into garmin.authority_v2(account_identity,rule_id,datasets) values (%s,%s,%s)', (identity, rule_id, datasets))


def _insert(cur, row, work_id, token):
    value = row['value']
    display, raw, encoding = project(value) if row['kind'] == 'text' else (None, None, None)
    json_value = canonical(value) if row['kind'] == 'json' and value is not None else None
    cur.execute('''insert into brain.health_observations
        (id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_text,value_text_raw,value_text_encoding,value_json,activity_id,sub_identity)
        values (%s,'garmin',%s,%s,%s,%s,%s,true,%s,%s,%s,%s,%s,%s,false,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s)''',
        (row['id'],row['dataset'],row['batch'],row['table'],row['key'],row['account'],row['metric'],value if row['kind']=='number' else None,row['unit'],row['day'],row['observed'],row['zone'],row['revision'],row['fetched'],row['version'],work_id,token,row['kind'],display,raw,encoding,json_value,row['activity'],row['key']))


def chunks(rows, size=CHUNK_SIZE):
    if size < 1:
        raise ValueError('invalid chunk size')
    return [rows[i:i + size] for i in range(0, len(rows), size)] or [[]]


def reserve_item(cur, dataset, scope, key, endpoint, body, fetched_ms, version=NORMALIZATION_VERSION):
    cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (digest(dataset,scope,key,endpoint,version),))
    cur.execute('select revision,fetched_at_ms from garmin.normalize_items where dataset=%s and scope=%s and key=%s and endpoint=%s', (dataset,scope,key,endpoint))
    revision = revision_for(body, fetched_ms, cur.fetchall())
    cur.execute("""insert into garmin.normalize_items(dataset,scope,key,endpoint,revision,normalization_version,fetched_at_ms,ok,error_code,normalized_at_ms)
        values (%s,%s,%s,%s,%s,%s,%s,false,'pending',%s) on conflict do nothing""", (dataset,scope,key,endpoint,revision,version,fetched_ms,int(time.time()*1000)))
    return revision


def publish_item(conn, account, work_id, token, scope, key, endpoint, body, fetched_ms, zone, tables, catalog, error_code=None, version=NORMALIZATION_VERSION, boundary=None):
    dataset = dataset_for(account)
    with _write(conn, account, work_id, token) as (cur, _):
        revision = reserve_item(cur, dataset, scope, key, endpoint, body, fetched_ms, version)
    batch = item_batch(dataset,scope,key,endpoint,revision,version)
    rows = [] if error_code else observations(tables,catalog,dataset=dataset,account=account,zone=zone,revision=revision,fetched_ms=fetched_ms,batch=batch,endpoint=endpoint,version=version)
    parts = chunks(rows)
    for index, part in enumerate(parts):
        if boundary:
            boundary('항목 발행 batch')
        with _write(conn, account, work_id, token) as (cur, _):
            if not error_code:
                _authority(cur,dataset,account,work_id,token)
            for row in part:
                _insert(cur,row,work_id,token)
            if index == len(parts)-1:
                cur.execute('''update garmin.normalize_items set ok=%s,error_code=%s,normalized_at_ms=%s,null_materialized=%s
                    where dataset=%s and scope=%s and key=%s and endpoint=%s and revision=%s and normalization_version=%s''',
                    (not bool(error_code),error_code,int(time.time()*1000),body != 'null' or bool(rows),dataset,scope,key,endpoint,revision,version))
    return revision


def unpublished(conn, account, version=NORMALIZATION_VERSION):
    """Return collected raw items with missing or failed publication for this version."""
    dataset = dataset_for(account)
    cur = conn.cursor()
    cur.execute('''select scope,original_key,endpoint,body,fetched_at_ms from garmin.raw_payloads
        where dataset=%s and raw_identity is null and body_raw is null order by scope,original_key,endpoint''', (dataset,))
    items = [dict(zip(('scope','key','endpoint','body','fetched_at_ms'),row)) for row in cur.fetchall()]
    cur.execute('select scope,key,endpoint,revision,fetched_at_ms,ok,null_materialized from garmin.normalize_items where dataset=%s and normalization_version=%s', (dataset,version))
    states = cur.fetchall()
    successful = {(scope,key,endpoint,revision,fetched) for scope,key,endpoint,revision,fetched,ok,_ in states if ok}
    targets = {(scope,key) for scope,key,endpoint,revision,_,ok,_ in states if ok and endpoint in tables_rules.NORMALIZERS and tables_rules.NORMALIZERS[endpoint].columns and not (revision == raw_revision('null') or revision.startswith(raw_revision('null') + ':'))}
    empty_null = {(scope,key,endpoint,revision,fetched) for scope,key,endpoint,revision,fetched,ok,materialized in states if ok and not materialized}
    pending = []
    for item in items:
        fetched = item['fetched_at_ms']
        sha = raw_revision(item['body'])
        prefix = (item['scope'],item['key'],item['endpoint'])
        revisions = (sha,sha + ':' + str(fetched))
        rule = tables_rules.NORMALIZERS.get(item['endpoint'])
        retry_null = item['body']=='null' and rule is not None and bool(rule.columns) and (item['scope'],item['key']) in targets and any((*prefix,revision,fetched) in empty_null for revision in revisions)
        if retry_null or not any((*prefix,revision,fetched) in successful for revision in revisions):
            pending.append(item)
    return pending


def mark_days_dirty(cur, dataset, days):
    for day in sorted(set(day for day in days if day)):
        cur.execute('''insert into garmin.normalize_day_dirty(dataset,day,generation) values (%s,%s,1)
            on conflict (dataset,day) do update set generation=garmin.normalize_day_dirty.generation+1''', (dataset,day))


def reserve_day(conn, account, work_id, token, day, revision, source_max_ms, raw, version=NORMALIZATION_VERSION, *, fingerprint=None):
    """Reserve against the current account-wide raw snapshot, never a stale one."""
    fingerprint = raw_fingerprint(raw) if fingerprint is None else fingerprint
    with _write(conn,account,work_id,token) as (cur,dataset):
        # Import and collect both write this table; the lock fences them until
        # validation and reservation commit, including writers outside collect.
        cur.execute('lock table garmin.raw_payloads in share mode')
        if current_raw_fingerprint(conn,account) != fingerprint:
            return None
        cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', (digest(dataset,day,'day-reservation'),))
        base_revision = revision
        legacy_collision = False
        cur.execute('select source_max_ms,watermark_us from garmin.normalize_day_revisions where dataset=%s and day=%s and revision=%s', (dataset,day,revision))
        existing = cur.fetchone()
        if existing:
            # 0008 could publish multiple revisions at the same fetched time.
            # Preserve those immutable rows and give this input one stable alias.
            cur.execute('''select exists(select 1 from garmin.normalize_day_revisions
                where dataset=%s and day=%s and watermark_us=%s and revision<>%s)''',
                (dataset,day,existing[1],revision))
            if cur.fetchone()[0]:
                legacy_collision = True
                revision = digest(revision,'legacy-collision-repair')
                cur.execute('select source_max_ms,watermark_us from garmin.normalize_day_revisions where dataset=%s and day=%s and revision=%s', (dataset,day,revision))
                existing = cur.fetchone()
        cur.execute('''select revision,base_revision,watermark_us from garmin.normalize_day_revisions
            where dataset=%s and day=%s and source_max_ms=%s order by watermark_us desc,revision desc limit 1''', (dataset,day,source_max_ms))
        latest = cur.fetchone()
        if latest and latest[1] == base_revision and (not legacy_collision or latest[0] != base_revision):
            revision = latest[0]
            cur.execute('select source_max_ms,watermark_us from garmin.normalize_day_revisions where dataset=%s and day=%s and revision=%s', (dataset,day,revision))
            existing = cur.fetchone()
        elif latest and existing:
            revision = digest(base_revision,'day-occurrence',latest[0])
            cur.execute('select source_max_ms,watermark_us from garmin.normalize_day_revisions where dataset=%s and day=%s and revision=%s', (dataset,day,revision))
            existing = cur.fetchone()
        if existing:
            source_max_ms, watermark = existing
        else:
            cur.execute('select max(watermark_us) from garmin.normalize_day_revisions where dataset=%s and day=%s and source_max_ms=%s', (dataset,day,source_max_ms))
            previous = cur.fetchone()[0]
            watermark = max(source_max_ms*1000, (previous+1) if previous is not None else source_max_ms*1000)
            if watermark >= (source_max_ms+1)*1000:
                raise ValueError('NORMALIZE_DAY_WATERMARK_EXHAUSTED')
            cur.execute('insert into garmin.normalize_day_revisions(dataset,day,revision,base_revision,source_max_ms,watermark_us) values (%s,%s,%s,%s,%s,%s)', (dataset,day,revision,base_revision,source_max_ms,watermark))
        cur.execute('select generation from garmin.normalize_day_dirty where dataset=%s and day=%s', (dataset,day))
        dirty = cur.fetchone()
        generation = dirty[0] if dirty else None
        cur.execute("""insert into garmin.normalize_days(dataset,day,revision,normalization_version,fetched_at_ms,ok,error_code,normalized_at_ms)
            values (%s,%s,%s,%s,%s,false,'pending',%s) on conflict do nothing""", (dataset,day,revision,version,source_max_ms,int(time.time()*1000)))
        cur.execute('select ok from garmin.normalize_days where dataset=%s and day=%s and revision=%s and normalization_version=%s', (dataset,day,revision,version))
        ok = cur.fetchone()[0]
        if ok:
            # Preserve an untouched success unless it must supersede a later
            # failed reservation for this day in the legacy retry ledger.
            cur.execute('''update garmin.normalize_days success set normalized_at_ms=greatest(%s,
                (select max(failure.normalized_at_ms)+1 from garmin.normalize_days failure
                 where failure.dataset=success.dataset and failure.day=success.day
                   and failure.normalization_version=success.normalization_version and not failure.ok))
                where success.dataset=%s and success.day=%s and success.revision=%s and success.normalization_version=%s
                  and exists (select 1 from garmin.normalize_days failure where failure.dataset=success.dataset
                    and failure.day=success.day and failure.normalization_version=success.normalization_version
                    and not failure.ok and failure.normalized_at_ms>=success.normalized_at_ms)''',
                (int(time.time()*1000),dataset,day,revision,version))
        if ok and generation is not None:
            cur.execute('update garmin.normalize_day_dirty set completed_generation=%s where dataset=%s and day=%s and generation=%s', (generation,dataset,day,generation))
        return revision, watermark, generation, ok


def publish_day(conn, account, work_id, token, day, revision, fetched_ms, zone, tables, catalog, error_code=None, version=NORMALIZATION_VERSION, boundary=None, *, watermark_us=None, generation=None):
    dataset = dataset_for(account)
    batch = day_batch(dataset, day, revision, version)
    rows = [] if error_code else observations(tables,catalog,dataset=dataset,account=account,zone=zone,revision=revision,fetched_ms=fetched_ms,batch=batch,version=version,day=day)
    if watermark_us is not None:
        fetched = datetime(1970,1,1,tzinfo=timezone.utc) + timedelta(microseconds=watermark_us)
        for row in rows:
            row['fetched'] = fetched
    parts = chunks(rows)
    for index, part in enumerate(parts):
        if boundary:
            boundary('날짜 발행 batch')
        with _write(conn,account,work_id,token) as (cur, _):
            if not error_code:
                _authority(cur,dataset,account,work_id,token)
            for row in part:
                _insert(cur,row,work_id,token)
            if index == len(parts)-1:
                cur.execute("""insert into garmin.normalize_days(dataset,day,revision,normalization_version,fetched_at_ms,ok,error_code,normalized_at_ms)
                    values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict (dataset,day,revision,normalization_version)
                    do update set ok=excluded.ok,error_code=excluded.error_code,normalized_at_ms=excluded.normalized_at_ms
                    where not garmin.normalize_days.ok""",
                    (dataset,day,revision,version,fetched_ms,not bool(error_code),error_code,int(time.time()*1000)))
                if not error_code and generation is not None:
                    cur.execute('update garmin.normalize_day_dirty set completed_generation=%s where dataset=%s and day=%s and generation=%s', (generation,dataset,day,generation))


def unfinished_days(conn, account, version=NORMALIZATION_VERSION, *, history_start=None):
    cur = conn.cursor()
    cur.execute('''select day,revision,fetched_at_ms,error_code from (
        select distinct on (day) day,revision,fetched_at_ms,error_code,ok
        from garmin.normalize_days where dataset=%s and normalization_version=%s
        order by day,normalized_at_ms desc,ok desc,revision desc
        ) latest where not ok
        union select day,'pending',0,'pending' from garmin.normalize_day_dirty
        where dataset=%s and generation>completed_generation order by day''', (dataset_for(account),version,dataset_for(account)))
    return [row for row in cur.fetchall() if not history_start or row[0].isoformat() >= history_start]


def anticipated_revision(conn, account, scope, key, endpoint, body, fetched_ms, version=NORMALIZATION_VERSION):
    cur = conn.cursor()
    cur.execute('select revision,fetched_at_ms from garmin.normalize_items where dataset=%s and scope=%s and key=%s and endpoint=%s', (dataset_for(account),scope,key,endpoint))
    return revision_for(body,fetched_ms,cur.fetchall())


def publish_atomic(cur, dataset, account, work_id, token, scope, key, endpoint, body, fetched_ms, revision, rows, error_code=None, version=NORMALIZATION_VERSION):
    """Publish precomputed observations in the caller's raw upsert transaction."""
    actual = reserve_item(cur,dataset,scope,key,endpoint,body,fetched_ms,version)
    if actual != revision:
        raise ValueError('COLLECT_RAW_CHANGED')
    if len(rows) > CHUNK_SIZE:
        return False
    if not error_code:
        _authority(cur,dataset,account,work_id,token)
    for row in rows:
        _insert(cur,row,work_id,token)
    cur.execute('''update garmin.normalize_items set ok=%s,error_code=%s,normalized_at_ms=%s,null_materialized=%s
        where dataset=%s and scope=%s and key=%s and endpoint=%s and revision=%s and normalization_version=%s''',
        (not bool(error_code),error_code,int(time.time()*1000),body != 'null' or bool(rows),dataset,scope,key,endpoint,revision,version))
    return True
