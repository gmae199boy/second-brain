"""Garmin endpoint 수집 ABI worker."""
from contextlib import nullcontext, ExitStack
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import signal
import sys
import uuid
from zoneinfo import ZoneInfo

import psycopg
from collect_client import open_client, blocked_today
from collect_settings import decode
import collect_coverage as coverage
import collect_store as store
import normalize_store as normalized_store
import normalize_runtime as normalization
from garmin_session import GarminError, session_lock, silence_library_logging

_stopping = False

def _stop(_signum, _frame):
    global _stopping
    _stopping = True

def boundary(message=None):
    if _stopping:
        raise ValueError('COLLECT_STOPPED')
    if message:
        emit('progress', message=message)

def emit(kind, **values):
    print(json.dumps({'abi':1,'type':kind,**values}, ensure_ascii=False), flush=True)

def inputs(env):
    uuid_pattern = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (env.get('BRAIN_ABI_VERSION') != '1' or env.get('BRAIN_WORK_KIND') not in ('garmin.collect','garmin.collect_retry','garmin.collect_recent')
        or env.get('BRAIN_TARGET_KIND') not in ('account','extension') or not env.get('BRAIN_TARGET_ID')
        or '\x00' in env['BRAIN_TARGET_ID']
        or not re.fullmatch(r'[1-9][0-9]{0,8}',env.get('BRAIN_RUN_GENERATION',''))
        or not all(re.fullmatch(uuid_pattern,env.get(k,'')) for k in ('BRAIN_WORK_ID','BRAIN_ATTEMPT_TOKEN'))
        or not re.match(r'^postgres(?:ql)?://',env.get('BRAIN_DATABASE_URL',''))):
        raise ValueError('COLLECT_INVALID')
    if 'BRAIN_ACCOUNT' in env and (env['BRAIN_TARGET_KIND'] != 'account' or env['BRAIN_ACCOUNT'] != env['BRAIN_TARGET_ID']):
        raise ValueError('COLLECT_INVALID')
    start, end = env.get('BRAIN_RANGE_FROM'), env.get('BRAIN_RANGE_TO')
    if (start is None) != (end is None) or (start is not None and (not re.fullmatch(r'\d{4}-\d{2}-\d{2}',start) or start != end or date.fromisoformat(start).isoformat() != start)):
        raise ValueError('COLLECT_INVALID')
    settings = decode(env.get('BRAIN_SETTINGS_SNAPSHOT'),require_timezone=True)
    return {'target_kind':env['BRAIN_TARGET_KIND'],'target_id':env['BRAIN_TARGET_ID'],
            'day':date.fromisoformat(start) if start else None,'settings':settings,
            'recent':env['BRAIN_WORK_KIND']=='garmin.collect_recent'}

def result(status, cutoff_ms, local_date, normalized=0, normalize_failed=0):
    emit('result', summary=json.dumps({'status':status,'cutoff_ms':cutoff_ms,'local_date':local_date.isoformat(),'normalized':normalized,'normalize_failed':normalize_failed},separators=(',',':')))

def _clock_ms():
    return int(datetime.now(timezone.utc).timestamp()*1000)

def _token_mtime(tokenstore):
    try:
        return (Path(tokenstore).expanduser() / 'garmin_tokens.json').stat().st_mtime_ns // 1000000
    except OSError:
        return None

def _payload(response):
    return getattr(response,'payload',response)

def run(client=None, env=None, connect=psycopg.connect):
    env = os.environ if env is None else env
    args = inputs(env)
    settings = args['settings']; zone = settings['garmin.timezone']; tokenstore = settings['garmin.tokenstore']
    today = args['day'] or datetime.now(ZoneInfo(zone)).date()
    work = env['BRAIN_WORK_ID']; token = env['BRAIN_ATTEMPT_TOKEN']
    boundary()
    token_path = Path(tokenstore).expanduser()
    if not token_path.is_dir():
        raise GarminError('LOGIN_REQUIRED')
    with session_lock(token_path, settings['garmin.lock_wait_seconds']):
        return _run_locked(client, env, connect, args, settings, zone, tokenstore, today, _clock_ms(), work, token)


def _run_locked(client, env, connect, args, settings, zone, tokenstore, today, cutoff, work, token):
    boundary()
    with connect(env['BRAIN_DATABASE_URL'],autocommit=True,options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
        valid = conn.execute('select garmin.attempt_valid(%s::uuid,%s::uuid)',(work,token)).fetchone()
        if valid[0] is not True:
            raise ValueError('COLLECT_INVALID_ATTEMPT')
        account = args['target_id'] if args['target_kind'] == 'account' else store.target_account(conn,args['target_kind'],args['target_id'])
        blocked = blocked_today(tokenstore,today)
        run_id = uuid.uuid7(); started = _clock_ms()
        if blocked:
            if account:
                store.put_run(conn,account,work,token,run_id,today,started,'skipped_blocked',finished_at=_clock_ms())
            raise GarminError('SESSION_BLOCKED')
        # 미등록 extension 대상은 로그인 profile로 식별해야 coverage를 읽을 수 있다.
        manager = None
        if account is None:
            manager = open_client(tokenstore,zone,settings,lock_held=True) if client is None else nullcontext(client)
        with (manager or nullcontext(None)) as initial:
            if account is None:
                identity = getattr(initial,'profile_id',None)
                if identity is None or str(identity) == '':
                    raise ValueError('COLLECT_ACCOUNT_UNKNOWN')
                account = str(identity)
                store.set_target(conn,account,work,token,args['target_kind'],args['target_id'])
            snapshot = store.coverage_snapshot(conn,account)
            catalogue = normalization.catalog(conn)
            normalized, normalize_failed = normalization.retry_items(conn,account,work,token,zone,boundary,snapshot,catalogue)
            mode = coverage.entry(snapshot,today,force=args['recent'],token_saved_at=_token_mtime(tokenstore))
            if mode == 'noop':
                pending_days = [str(row[0]) for row in normalized_store.unfinished_days(conn,account,history_start=snapshot['history_start'])]
                failed = normalization.publish_days(conn,account,work,token,zone,pending_days,catalogue,boundary,snapshot=snapshot) if pending_days else 0
                result('noop',cutoff,today,normalized=normalized,normalize_failed=normalize_failed + failed)
                return
            if args['recent']:
                mode = 'rejected'
            history = date.fromisoformat(snapshot['history_start']) if snapshot['history_start'] else today-timedelta(days=30)
            planned = coverage.plan(snapshot,history,today,zone,int(settings['garmin.max_dates_per_run']),int(settings['garmin.max_rejected_attempts']),mode,args['recent'])
            counts = {'transient':0,'rejected':0}
            affected = set()
            status, detail = 'success', ''
            try:
                if planned:
                    first = coverage.first_call_endpoints(snapshot)
                    active_manager = nullcontext(initial) if initial is not None else (open_client(tokenstore,zone,settings,first,lock_held=True) if client is None else nullcontext(client))
                    with active_manager as active:
                        if args['target_kind'] == 'extension':
                            identity = getattr(active,'profile_id',None)
                            if identity is None or str(identity) == '':
                                raise ValueError('COLLECT_ACCOUNT_UNKNOWN')
                            if str(identity) != account:
                                raise ValueError('COLLECT_ACCOUNT_MISMATCH')
                        if (initial is not None or client is not None) and hasattr(active, 'configure_first'):
                            active.configure_first(first)
                        snapshot['history_start'] = store.set_history_start(conn,account,work,token,history.isoformat())
                        history = date.fromisoformat(snapshot['history_start'])
                        store.put_run(conn,account,work,token,run_id,today,started,'running')
                        for index,(day,endpoints) in enumerate(planned):
                            if index:
                                boundary('날짜 대기 시작')
                                active.next_date()
                                boundary('날짜 대기 완료')
                            def fetch(scope,key,endpoint):
                                boundary(f'{key} {endpoint} 시작')
                                try:
                                    response = active.fetch_day(endpoint,day) if scope == 'day' else active.fetch_activity(endpoint,key)
                                    if response is None:
                                        return
                                    payload = _payload(response)
                                except GarminError as error:
                                    if error.code == 'GARMIN_NO_DATA':
                                        payload = None
                                    elif error.code in ('GARMIN_TRANSIENT','GARMIN_REJECTED'):
                                        kind = 'transient' if error.code == 'GARMIN_TRANSIENT' else 'rejected'
                                        counts[kind] += 1
                                        store.add_fetch_error(conn,account,work,token,run_id,scope,key,endpoint,kind,today,_clock_ms(),error.code)
                                        return
                                    else:
                                        raise
                                finally:
                                    boundary(f'{key} {endpoint} 완료')
                                nonlocal normalized, normalize_failed
                                before = snapshot['raw']
                                old_activity_day = normalization.activity_date(before,key,zone) if scope == 'activity' else None
                                previous = next((i for i in before if i['scope']==scope and i['key']==key and i['endpoint']==endpoint),None)
                                now = _clock_ms()
                                library = getattr(active,'library_version','synthetic-port')
                                predicted = store.raw_transition(previous,payload,library,now)
                                projected = [i for i in before if (i['scope'],i['key'],i['endpoint']) != (scope,key,endpoint)]
                                projected.append({'scope':scope,'key':key,'endpoint':endpoint,**predicted})
                                dirty_days = [key] if scope == 'day' else [day.isoformat(),old_activity_day,normalization.activity_date(projected,key,zone)]
                                dirty_days = [d for d in dirty_days if d and d >= history.isoformat()]
                                prepared = normalization.prepare(conn,account,before,scope,key,endpoint,predicted['body'],zone)
                                published = [True]
                                revision = None
                                observations = []
                                if prepared is not None:
                                    rows,error = prepared
                                    dataset = store.dataset_for(account)
                                    revision = normalized_store.anticipated_revision(conn,account,scope,key,endpoint,predicted['body'],predicted['fetched_at_ms'])
                                    batch = normalized_store.item_batch(dataset,scope,key,endpoint,revision)
                                    if not error:
                                        observations = normalized_store.observations(rows,catalogue,dataset=dataset,account=account,zone=zone,revision=revision,fetched_ms=predicted['fetched_at_ms'],batch=batch,endpoint=endpoint)
                                def publish(cur,dataset,value):
                                    normalized_store.mark_days_dirty(cur,dataset,dirty_days)
                                    if prepared is not None:
                                        published[0] = normalized_store.publish_atomic(cur,dataset,account,work,token,scope,key,endpoint,value['body'],value['fetched_at_ms'],revision,observations,error)
                                stored = store.upsert_raw(conn,account,work,token,scope,key,endpoint,payload,library,now,expected=predicted,publish=publish,expected_raw=before)
                                if prepared is not None:
                                    rows,error = prepared
                                    if not published[0]:
                                        boundary('큰 항목 발행')
                                        normalized_store.publish_item(conn,account,work,token,scope,key,endpoint,stored['body'],stored['fetched_at_ms'],zone,rows,catalogue,error,boundary=boundary)
                                    normalized += not bool(error)
                                    normalize_failed += bool(error)
                                before[:] = [i for i in before if (i['scope'],i['key'],i['endpoint']) != (scope,key,endpoint)]
                                before.append({'scope':scope,'key':key,'endpoint':endpoint,**stored})
                                if scope == 'day':
                                    affected.add(key)
                                else:
                                    affected.add(old_activity_day)
                                    affected.add(normalization.activity_date(before,key,zone))
                            for endpoint in endpoints:
                                fetch('day',day.isoformat(),endpoint)
                            for item in coverage.pending_activities(snapshot,day,zone,int(settings['garmin.max_rejected_attempts']),mode,today):
                                fetch('activity',item.key,item.endpoint)
                else:
                    snapshot['history_start'] = store.set_history_start(conn,account,work,token,history.isoformat())
                    history = date.fromisoformat(snapshot['history_start'])
                    store.put_run(conn,account,work,token,run_id,today,started,'running')
                affected.update(str(row[0]) for row in normalized_store.unfinished_days(conn,account,history_start=history.isoformat()))
                normalize_failed += normalization.publish_days(conn,account,work,token,zone,affected,catalogue,boundary,snapshot=snapshot)
                if any(counts.values()):
                    status = 'partial'
                    detail = ' '.join(f'{key}={value}' for key,value in counts.items() if value)
            except GarminError as error:
                status = {'RATE_LIMITED':'rate_limited','BLOCKED_403':'blocked_403','LOGIN_REQUIRED':'auth_failed'}.get(error.code,'error')
                detail = error.code.lower()
                store.put_run(conn,account,work,token,run_id,today,started,status,detail,_clock_ms())
                raise
            except ValueError as error:
                if str(error) in ('COLLECT_ACCOUNT_UNKNOWN', 'COLLECT_ACCOUNT_MISMATCH'):
                    raise
                store.put_run(conn,account,work,token,run_id,today,started,'error','error',_clock_ms())
                raise
            store.put_run(conn,account,work,token,run_id,today,started,status,detail,_clock_ms())
            if status == 'partial':
                raise ValueError('COLLECT_PARTIAL')
            result(status,cutoff,today,normalized,normalize_failed)

def main():
    silence_library_logging()
    signal.signal(signal.SIGTERM,_stop); signal.signal(signal.SIGINT,_stop)
    try:
        run()
    except Exception as error:
        allowed = ('COLLECT_CLIENT_UNAVAILABLE','COLLECT_INVALID_ATTEMPT','COLLECT_STOPPED','COLLECT_PARTIAL','COLLECT_ACCOUNT_UNKNOWN','COLLECT_ACCOUNT_MISMATCH')
        code = error.code if isinstance(error,GarminError) else str(error) if isinstance(error,ValueError) and str(error) in allowed else 'COLLECT_INVALID'
        emit('error',code=code,retryable=error.retryable if isinstance(error,GarminError) else False)
        return 1
    return 0

if __name__ == '__main__':
    sys.exit(main())
