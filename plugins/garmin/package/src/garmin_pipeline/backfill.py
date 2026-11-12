"""보존된 자료는 재조회하지 않는 재개 가능한 누락 항목 백필."""
import json
import time
from collections import Counter
from datetime import date, timedelta

from garmin_pipeline import collect, coverage, dates, errors, garmin, normalize, store

HISTORY_WINDOW = timedelta(days=collect.HISTORY_DAYS)
RANGE_ENDPOINTS = ('activities_by_date', 'daily_weigh_ins', 'body_battery')
RANGE_DAYS = 7
EMPTY_PREFIX = 'backfill_empty:'


def empty_key(item):
    return f'{EMPTY_PREFIX}{item.scope}:{item.key}:{item.endpoint}'


def pending(conn, cfg, start, end, endpoints=None):
    """기존 data는 freshness와 무관하게 유지하고, 확인한 빈 응답도 재개 시 유지한다."""
    with store.transaction(conn):
        items = coverage.items(conn, cfg, start, end)
        checked = dict(conn.execute('select key,value from garmin.meta where user_id=%s and connection_id=%s and key like %s',
            (conn.user_id, conn.connection_id, EMPTY_PREFIX + '%')).fetchall())
    return [item for item in items if (endpoints is None or item.endpoint in endpoints)
            and item.state != coverage.CoverageState.DATA
            and not (item.state == coverage.CoverageState.EMPTY and checked.get(empty_key(item)) == str(item.checked_at))]


def counts(items):
    return {'remaining_endpoints': len(items),
            'remaining_activities': len({i.key for i in items if i.scope == 'activity'}),
            'remaining_dates': len({i.day_key for i in items}),
            'unplannable': sum(not i.plannable for i in items)}


def batches(items):
    """같은 endpoint의 연속 누락 날짜만 묶는다. 자료가 있는 날짜를 가로지르지 않는다."""
    groups = []
    for endpoint in RANGE_ENDPOINTS:
        days = sorted((i for i in items if i.scope == 'day' and i.endpoint == endpoint and i.plannable), key=lambda i: i.day_key)
        for item in days:
            if (groups and groups[-1][0].endpoint == endpoint and len(groups[-1]) < RANGE_DAYS and
                    date.fromisoformat(item.day_key) == date.fromisoformat(groups[-1][-1].day_key) + timedelta(days=1)):
                groups[-1].append(item)
            else:
                groups.append([item])
    groups.extend([item] for item in items if item.plannable and
                  (item.scope != 'day' or item.endpoint not in RANGE_ENDPOINTS))
    # 날짜별 endpoint를 먼저 채워 새 활동 목록을 마지막 상세 계획에 반영한다.
    return sorted(groups, key=lambda group: (group[0].scope != 'day', group[0].day_key, group[0].endpoint))


def plan(items):
    by_day = Counter((i.day_key, i.endpoint) for i in items)
    return {'items': [{'date': day, 'endpoint': endpoint, 'count': count}
                      for (day, endpoint), count in sorted(by_day.items())],
            'expected_calls_min': len(batches(items)),
            'additional_activity_details_unknown': any(i.endpoint == 'activities_by_date' for i in items),
            'activity_list_pages_unknown': any(i.endpoint == 'activities_by_date' for i in items),
            **counts(items)}


class _Cached:
    def __init__(self, response=None, error=None):
        self.response, self.error = response, error

    def fetch_day(self, endpoint, day):
        if self.error is not None:
            raise self.error
        return self.response


def _save_empty_checkpoint(conn, item):
    with store.transaction(conn):
        row = conn.execute('select raw,checked_at from garmin.raw_current where user_id=%s and connection_id=%s and scope=%s and key=%s and endpoint=%s',
            (conn.user_id, conn.connection_id, item.scope, item.key, item.endpoint)).fetchone()
        if row and row[0] == 'null':
            conn.execute('insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,%s,%s) on conflict (user_id,connection_id,key) do update set value=excluded.value',
                (conn.user_id, conn.connection_id, empty_key(item), str(row[1])))
            return True
    return False


def run(conn, cfg, port, start, end, *, endpoints=None, dry_run=False, sleep=time.sleep):
    initial = pending(conn, cfg, start, end, endpoints)
    preview = plan(initial)
    if dry_run:
        return {'status': 'dry_run', 'plan': preview, 'received': 0, 'not_provided': 0, **counts(initial)}
    today, started = dates.today(cfg), dates.now_ms()
    received = unavailable = deferred = 0
    failures = dict.fromkeys(coverage.FetchErrorKind, 0)
    collect._abandon_running(conn, collect.ports.TableNotifier(conn))
    with store.transaction(conn):
        store.identity_lock(conn, 'run')
        run_id = conn.execute('insert into garmin.run(user_id,connection_id,local_date,started_at,status,detail) values (%s,%s,%s,%s,%s,%s) returning id',
            (conn.user_id, conn.connection_id, today.isoformat(), started, 'running', 'manual backfill')).fetchone()[0]
    stop = None
    attempted = set()
    first = collect._first_call_endpoints(conn)
    attempts = dict.fromkeys(first, 0)
    last_day = None
    try:
        if initial:
            # 세션·차단·자격 검증은 정기 수집과 동일하다. 첫 호출 상한도 유지한다.
            with port.open_session(first_call_endpoints=first) as session:
                # day 목록 호출 뒤 상세를 새로 계산하여 새로 발견된 활동도 빠짐없이 채운다.
                for activity_phase in (False, True):
                    work = pending(conn, cfg, start, end, endpoints)
                    work = [i for i in work if (i.scope == 'activity') == activity_phase]
                    for group in batches(work):
                        endpoint = group[0].endpoint
                        if endpoint in attempts:
                            if attempts[endpoint] >= collect.FIRST_CALL_LIMIT:
                                deferred += len(group)
                                continue
                            attempts[endpoint] += 1
                        if last_day is not None and last_day != group[0].day_key:
                            sleep(cfg.date_pause_seconds)
                        last_day = group[0].day_key
                        proxy = None
                        split = None
                        if group[0].scope == 'day' and endpoint in RANGE_ENDPOINTS:
                            try:
                                response = session.fetch_range(endpoint, date.fromisoformat(group[0].day_key), date.fromisoformat(group[-1].day_key))
                                # 일별 호환 원문과 별도로 기간 응답 전체도 보존한다.
                                store.upsert_raw(conn, scope='day', key=group[0].day_key,
                                    endpoint=f'backfill_range.{endpoint}.{group[-1].day_key}',
                                    payload=response.payload, library_version=response.library_version, now_ms=dates.now_ms())
                                split = garmin.split_range(endpoint, response.payload, [i.day_key for i in group], cfg.timezone)
                            except (errors.NoData, errors.Transient, errors.Rejected) as error:
                                proxy = _Cached(error=error)
                        for item in group:
                            identity = (item.scope, item.key, item.endpoint)
                            if identity in attempted:
                                continue
                            attempted.add(identity)
                            cached = proxy
                            if split is not None:
                                payload = split[item.day_key]
                                cached = _Cached(garmin.RawResponse(endpoint, payload, response.library_version)) if payload is not None else _Cached(error=errors.NoData('range empty'))
                            failure = collect._fetch(conn, cached or session, run_id, today, item.scope, item.key, endpoint)
                            if failure is not None:
                                failures[failure] += 1
                            elif _save_empty_checkpoint(conn, item):
                                unavailable += 1
                            else:
                                received += 1
    except collect._OPEN_STOPS as error:
        stop = collect._stop('backfill', error)
    remaining = pending(conn, cfg, start, end, endpoints)
    status, reason = stop if stop else (errors.RunStatus.PARTIAL if remaining or any(failures.values()) else errors.RunStatus.SUCCESS, None)
    result = {'status': str(status), 'plan': preview, 'received': received, 'not_provided': unavailable,
              'deferred_first_call': deferred, 'errors': sum(failures.values()), **counts(remaining)}
    detail = collect._detail(cfg, failures, reason, manual=True) + ' backfill ' + ' '.join(f'{k}={v}' for k, v in counts(remaining).items())
    def finish(final_status, final_detail):
        with store.transaction(conn):
            conn.execute('update garmin.run set status=%s,finished_at=%s,detail=%s where user_id=%s and connection_id=%s and id=%s',
                (str(final_status), dates.now_ms(), final_detail, conn.user_id, conn.connection_id, run_id))
    # 정규화까지 확인한 뒤 성공을 확정한다. 예외에도 DB의 실행 상태를 성공으로 남기지 않는다.
    try:
        normalize.run(conn, timezone=cfg.timezone, retry_failed=True)
        with store.transaction(conn):
            failed = conn.execute('select exists(select 1 from garmin.normalize_result where user_id=%s and connection_id=%s and ok=0)',
                                  (conn.user_id, conn.connection_id)).fetchone()[0]
            projection_pending = conn.execute("select exists(select 1 from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending')",
                                             (conn.user_id, conn.connection_id)).fetchone()[0]
    except Exception:
        finish(errors.RunStatus.ERROR, detail + ' normalize_failed')
        raise
    result['projection_complete'] = not (failed or projection_pending)
    if not result['projection_complete'] and result['status'] == 'success':
        result['status'] = 'partial'
    finish(result['status'], detail + ('' if result['projection_complete'] else ' normalize_failed'))
    return result
