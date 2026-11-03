"""Pure preparation and database orchestration shared by collect and rebuild."""
import hashlib
import json
from datetime import datetime
from zoneinfo import ZoneInfo

import collect_rawparse as rawparse
import collect_store
import digest
import labels
import normalize_store as store
import normalize_tables as tables


def catalog(conn):
    return [r[0] for r in conn.execute('select definition from brain.health_catalog_v1').fetchall()]


def day_keys(raw):
    result = {}
    for item in sorted(raw, key=lambda i:i['key']):
        if item['scope'] == 'day' and item['endpoint'] == 'activities_by_date':
            try:
                for ref in rawparse.activity_refs(item['body']):
                    result.setdefault(ref.activity_id,ref.day_key)
            except rawparse.RawParseError:
                pass
    return result


def existing_row(conn, account, scope, key):
    # Legacy normalize/__init__.py:400-408,441-459: NULL raw only updates
    # existing rows; a NULL response alone never creates a target row.
    cur = conn.cursor()
    cur.execute('''select endpoint,revision from garmin.normalize_items where dataset=%s and scope=%s and key=%s and normalization_version=%s and ok''',
                (collect_store.dataset_for(account),scope,key,store.NORMALIZATION_VERSION))
    null_hash = store.raw_revision('null')
    return any(endpoint in tables.NORMALIZERS and tables.NORMALIZERS[endpoint].columns and not (revision == null_hash or revision.startswith(null_hash + ':')) for endpoint,revision in cur.fetchall())


def prepare(conn, account, raw, scope, key, endpoint, body, zone=None):
    result = tables.normalize_item(scope,key,endpoint,body,day_keys(raw))
    if result is None:
        return None
    rows, status = result
    rule = tables.NORMALIZERS[endpoint]
    if body == 'null' and rule.columns and existing_row(conn,account,scope,key):
        if scope == 'day':
            row = {'day_key':key}
        else:
            row = {'activity_id':int(key), 'day_key':day_keys(raw).get(int(key))}
        row.update(dict.fromkeys(rule.columns))
        rows[tables._TARGETS[scope].table] = [row]
    if scope == 'activity':
        day = day_keys(raw).get(int(key)) if key.isascii() and key.isdecimal() else None
        if day is None and zone:
            day = activity_date(raw,key,zone)
        for row in rows.get('activity', []):
            row['day_key'] = row.get('day_key') or day
        for row in rows.get('exercise_set', []):
            row['day_key'] = day
    return rows, status['error_code']


def activity_date(raw, key, zone):
    entry = next((i for i in raw if i['scope']=='activity' and i['key']==key and i['endpoint']=='activity'),None)
    if not entry or entry['body']=='null':
        return None
    try:
        parsed = tables.activity.activity(entry['body'],key)
        ms = parsed['start_ms']
        return datetime.fromtimestamp(ms/1000,ZoneInfo(zone)).date().isoformat() if ms is not None else None
    except Exception:
        return None


def publish_days(conn,account,work,token,zone,days,catalogue,boundary,snapshot=None,_retries=0):
    if snapshot is None:
        snapshot = collect_store.coverage_snapshot(conn,account)
    raw = snapshot['raw']
    fingerprint = collect_store.raw_fingerprint(raw)
    activity_days = {i['key']:activity_date(raw,i['key'],zone) for i in raw if i['scope']=='activity' and i['endpoint']=='activity'}
    label_bytes = labels.load_bytes()
    label_hash = hashlib.sha256(label_bytes).hexdigest()
    cur = conn.cursor()
    cur.execute('select scope,key,endpoint,revision,fetched_at_ms from garmin.normalize_items where dataset=%s', (collect_store.dataset_for(account),))
    states = cur.fetchall()
    failed = 0
    start = snapshot['history_start']
    for day in sorted(set(d for d in days if d and (not start or d >= start))):
        boundary('날짜 정규화 ' + day)
        selected = [i for i in raw if (i['scope']=='day' and i['key']==day) or (i['scope']=='activity' and activity_days.get(i['key'])==day)]
        if not selected:
            continue
        inputs = []
        for i in selected:
            sha = store.raw_revision(i['body'])
            revision = next((rev for scope,key,endpoint,rev,fetched in states if (scope,key,endpoint,fetched)==(i['scope'],i['key'],i['endpoint'],i['fetched_at_ms']) and rev in (sha,sha+':'+str(fetched))),sha)
            inputs.append(dict(scope=i['scope'],key=i['key'],endpoint=i['endpoint'],revision=revision,fetched_at_ms=i['fetched_at_ms']))
        revision = store.day_revision(inputs,label_hash)
        fetched = max(i['fetched_at_ms'] for i in selected)
        reservation = store.reserve_day(conn,account,work,token,day,revision,fetched,raw,fingerprint=fingerprint)
        if reservation is None:
            # The calculated snapshot lost a race with a raw writer. Recompute
            # against a fresh snapshot; never reserve the stale derivation.
            if _retries >= 3:
                raise ValueError('COLLECT_RAW_CHANGED')
            return failed + publish_days(conn,account,work,token,zone,[d for d in days if d and d >= day],catalogue,boundary,_retries=_retries+1)
        revision, watermark, generation, done = reservation
        if done:
            continue
        try:
            daily = {i['endpoint']:json.loads(i['body']) for i in selected if i['scope']=='day'}
            activities = {key:{i['endpoint']:json.loads(i['body']) for i in selected if i['scope']=='activity' and i['key']==key} for key in activity_days if activity_days[key]==day}
            values = digest.day_values(day,daily,activities,labels.load(label_bytes),zone)
            rows = {'day_summary':[values['day_summary']], 'workout':values['workouts'], 'exercise_log':values['exercise_logs']}
            error = None
        except Exception:
            rows, error = {}, 'internal'
            failed += 1
        store.publish_day(conn,account,work,token,day,revision,fetched,zone,rows,catalogue,error,boundary=boundary,watermark_us=watermark,generation=generation)
    return failed


def retry_items(conn,account,work,token,zone,boundary,snapshot,catalogue):
    raw = snapshot['raw']
    pending = store.unpublished(conn,account)
    normalized = failed = 0
    for item in pending:
        boundary('항목 정규화 ' + item['key'] + ' ' + item['endpoint'])
        prepared = prepare(conn,account,raw,item['scope'],item['key'],item['endpoint'],item['body'],zone)
        if prepared is None:
            continue
        rows, error = prepared
        store.publish_item(conn,account,work,token,item['scope'],item['key'],item['endpoint'],item['body'],item['fetched_at_ms'],zone,rows,catalogue,error,boundary=boundary)
        normalized += not bool(error)
        failed += bool(error)
    return normalized, failed


def rebuild(conn,account,work,token,zone,boundary):
    catalogue = catalog(conn)
    snapshot = collect_store.coverage_snapshot(conn,account)
    raw = snapshot['raw']
    normalized, failed = retry_items(conn,account,work,token,zone,boundary,snapshot,catalogue)
    # Only collected dates are candidates; the snapshot remains account-wide input.
    cur = conn.cursor()
    cur.execute("select distinct scope,original_key from garmin.raw_payloads where dataset=%s and raw_identity is null and original_key_raw is null", (collect_store.dataset_for(account),))
    collected = cur.fetchall()
    days = {key for scope,key in collected if scope == 'day'}
    days.update(activity_date(raw,key,zone) for scope,key in collected if scope == 'activity')
    start = snapshot['history_start']
    days = {day for day in days if day and (not start or day >= start)}
    failed += publish_days(conn,account,work,token,zone,days,catalogue,boundary,snapshot=snapshot)
    return normalized, failed
