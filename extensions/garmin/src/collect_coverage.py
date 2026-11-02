"""계정 coverage snapshot으로 옛 수집 진입과 계획을 순수하게 계산한다."""
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from enum import StrEnum
from typing import NamedTuple
from zoneinfo import ZoneInfo

from garmin_session import DAY_ENDPOINTS, ACTIVITY_ENDPOINTS
from collect_rawparse import activity_refs, completion_stats, RawParseError

EXERCISE_SETS = 'activity_exercise_sets'
FIRST_CALL_ENDPOINTS = (EXERCISE_SETS, 'daily_weigh_ins', 'lifestyle_logging_data')

class CoverageState(StrEnum):
    DATA = 'data'
    EMPTY = 'empty'
    FAILED = 'failed'
    MISSING = 'missing'

class CoverageItem(NamedTuple):
    scope: str
    key: str
    endpoint: str
    day_key: str
    state: CoverageState
    final: bool
    checked_at: int | None
    plannable: bool
    fresh: bool

class DayStatus(NamedTuple):
    status: str
    detail: str
    finished_at: int | None


def _local_day(milliseconds, zone):
    return datetime.fromtimestamp(milliseconds / 1000, timezone.utc).astimezone(ZoneInfo(zone)).date().isoformat()


def stale_lifestyle(rows):
    rows = sorted((r for r in rows if r['scope'] == 'day' and r['endpoint'] == 'lifestyle_logging_data'), key=lambda r: r['key'], reverse=True)
    reference = next((r for r in rows if r['body'] != 'null'), None)
    if reference is None:
        return set()
    try:
        stats = completion_stats(reference['body'])
        ref_day = date.fromisoformat(reference['key'])
    except (RawParseError, ValueError):
        return set()
    stored = {r['key']: r for r in rows}
    stale = set()
    for day, count in stats.items():
        try:
            previous = stored.get(day)
            if not ref_day - timedelta(days=6) <= date.fromisoformat(day) < ref_day or previous is None or previous['checked_at_ms'] >= reference['fetched_at_ms']:
                continue
            if completion_stats(previous['body']).get(day, 0) != count:
                stale.add(day)
        except (RawParseError, ValueError):
            continue
    return stale


def items(snapshot, start, end, zone='UTC', max_rejected_attempts=3):
    if start > end:
        raise ValueError('invalid date range')
    rows = snapshot['raw']
    raw = {(r['scope'],r['key'],r['endpoint']): r for r in rows}
    failures = defaultdict(set)
    for r in snapshot['errors']:
        identity = (r['scope'],r['key'],r['endpoint'])
        failures[identity]  # transient도 실패 상태다.
        if r['kind'] == 'rejected':
            failures[identity].add(str(r['local_date']))
    refs, broken, seen = defaultdict(list), set(), set()
    for row in sorted((r for r in rows if r['scope'] == 'day' and r['endpoint'] == 'activities_by_date'), key=lambda r: r['key']):
        try:
            parsed = activity_refs(row['body'])
        except RawParseError:
            broken.add(row['key'])
            continue
        for ref in parsed:
            if ref.activity_id not in seen:
                seen.add(ref.activity_id)
                refs[ref.day_key].append((ref,row['fetched_at_ms']))
    stale = stale_lifestyle(rows)
    def item(scope, key, endpoint, day, list_fetched=None):
        identity = scope,key,endpoint
        found = raw.get(identity)
        checked = found['checked_at_ms'] if found else None
        state = (CoverageState.EMPTY if found['body'] == 'null' else CoverageState.DATA) if found else (CoverageState.FAILED if identity in failures else CoverageState.MISSING)
        final = checked is not None and _local_day(checked,zone) > day
        if endpoint == 'activities_by_date' and key in broken:
            final = False
        fresh = not (endpoint == EXERCISE_SETS and checked is not None and list_fetched is not None and checked < list_fetched)
        if scope == 'day' and endpoint == 'lifestyle_logging_data' and key in stale:
            fresh = False
        return CoverageItem(scope,key,endpoint,day,state,final,checked,len(failures[identity]) < max_rejected_attempts,fresh)
    result = []
    day = start
    while day <= end:
        key = day.isoformat()
        result.extend(item('day',key,endpoint,key) for endpoint in DAY_ENDPOINTS)
        for ref, fetched in refs[key]:
            result.extend(item('activity',str(ref.activity_id),endpoint,key) for endpoint in ACTIVITY_ENDPOINTS[:-1])
            if ref.needs_sets:
                result.append(item('activity',str(ref.activity_id),EXERCISE_SETS,key,fetched))
        day += timedelta(days=1)
    return result


def incomplete(item):
    if not item.plannable:
        return False
    if item.state not in (CoverageState.DATA, CoverageState.EMPTY):
        return True
    return (not item.final or not item.fresh) if item.scope == 'day' else not item.fresh


def day_status(snapshot, day):
    rows = [r for r in snapshot['runs'] if str(r['local_date']) == day.isoformat() and r['status'] != 'skipped_blocked']
    if not rows:
        return DayStatus('not_run','',None)
    def locked(r):
        detail = r.get('detail') or ''
        return r['status'] == 'error' and (detail == 'lock_timeout' or detail.startswith('lock_timeout '))
    # 동일 started_at은 snapshot 순서에서 뒤에 놓인 행을 고른다.
    _, row = max(enumerate(rows), key=lambda pair: (not locked(pair[1]),pair[1]['started_at'],pair[0]))
    return DayStatus(row['status'],row.get('detail') or '',row.get('finished_at'))


def entry(snapshot, today, *, blocked=False, force=False, token_saved_at=None):
    if blocked:
        return 'blocked'
    if force:
        return 'full'
    state = day_status(snapshot,today)
    if state.status in ('not_run','error','rate_limited','blocked_403'):
        return 'full'
    if state.status == 'auth_failed' and token_saved_at is not None and state.finished_at is not None and token_saved_at > state.finished_at:
        return 'full'
    if state.status == 'partial' and any(token.startswith('transient=') for token in state.detail.split()):
        return 'retry'
    return 'noop'


def excluded(item, snapshot, today, zone, mode):
    if mode not in ('retry', 'rejected'):
        return False
    if mode == 'retry' and item.checked_at is not None and _local_day(item.checked_at,zone) == today.isoformat():
        return True
    return any((e['scope'],e['key'],e['endpoint'],str(e['local_date']),e['kind']) == (item.scope,item.key,item.endpoint,today.isoformat(),'rejected') for e in snapshot['errors'])


def plan(snapshot, history_start, today, zone='UTC', max_dates_per_run=10, max_rejected_attempts=3, mode='full', recent_lists=False):
    if history_start > today:
        return []
    pending = {}
    for item in items(snapshot,history_start,today,zone,max_rejected_attempts):
        recent = recent_lists and item.scope == 'day' and item.endpoint == 'activities_by_date' and item.day_key >= (today - timedelta(days=6)).isoformat()
        if excluded(item,snapshot,today,zone,mode) or not (recent or incomplete(item)):
            continue
        endpoints = pending.setdefault(item.day_key,[])
        if item.scope == 'day':
            endpoints.append(item.endpoint)
    return [(date.fromisoformat(key),pending[key]) for key in sorted(pending,reverse=True)[:max_dates_per_run]]


def pending_activities(snapshot, day, zone='UTC', max_rejected_attempts=3, mode='full', today=None):
    today = day if today is None else today
    return [item for item in items(snapshot,day,day,zone,max_rejected_attempts) if item.scope == 'activity' and not excluded(item,snapshot,today,zone,mode) and incomplete(item)]


def first_call_endpoints(snapshot):
    return tuple(endpoint for endpoint in FIRST_CALL_ENDPOINTS if not any(r['endpoint'] == endpoint and r['body'] != 'null' for r in snapshot['raw']))
