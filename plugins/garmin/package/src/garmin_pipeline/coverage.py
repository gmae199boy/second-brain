"""저장된 데이터만으로 "무엇을 받았고 무엇이 빠졌는지"를 판정한다(FR8·16·20, AD-4·5·15).

`raw_response`·`fetch_error`·`run`만 읽는다. 쓰기·트랜잭션·시계 읽기를 하지 않으므로 같은 시점의
일관된 결과가 필요하면 호출자가 `store.transaction(conn)`으로 묶는다. `collect`가 수집 계획에 쓴다.

- `items(conn, cfg, start, end)`: [start, end] 일 키마다 day-scope `DAY_ENDPOINTS` 항목과, 저장된
  활동 목록에서 그 범위에 속하는 활동마다 activity-scope 항목의 `CoverageItem`이다. 활동 항목은
  `ACTIVITY_ENDPOINTS` 앞 3종이고, 소속 목록 항목의 `rawparse.ActivityRef.needs_sets`가 참인 활동만
  네 번째 `activity_exercise_sets`(세트 상세)도 낸다.
- `incomplete(item)`: 아직 받을 항목인지. `collect`의 계획과 재시도 계획이 함께 쓰는 유일한 미완료 판정이다.
- `day_status(conn, day)`: 그날의 마지막 실행(`skipped_blocked` 제외, lock_timeout 행은 그 밖의
  행이 없을 때만)의 `DayStatus`다.

활동 목록은 `rawparse.activity_refs`로만 읽는다. 목록 원문이 `RawParseError`면 전파하지 않고 그
목록 항목을 확정하지 않은 채(`final=False`) 두고 그 목록의 활동은 내지 않는다. 로그에는 key와
오류 메시지만 남긴다(원문 내용 없음).

최상위에서 stdlib과 `garmin_pipeline`의 `config`·`dates`·`errors`·`rawparse`만 import한다.
`garmin`은 import할 수 없어(계약 `garmin-only-imported-by-auth-collect`) endpoint 튜플을 여기 둔다.
"""

import logging
from datetime import date, timedelta
from enum import StrEnum
from typing import NamedTuple

from garmin_pipeline import config, dates, errors, rawparse, store

DAY_ENDPOINTS = (
    "sleep_data",
    "hrv_data",
    "rhr_day",
    "heart_rates",
    "stress_data",
    "body_battery",
    "user_summary",
    "training_readiness",
    "daily_weigh_ins",
    "lifestyle_logging_data",
    "activities_by_date",
)
"""날짜 하나로 받는 endpoint. `garmin.DAY_ENDPOINTS`와 같다(순서 포함, 테스트가 고정한다)."""

EXERCISE_SETS = "activity_exercise_sets"
"""세트 상세 endpoint. `rawparse.ActivityRef.needs_sets`가 참인 활동에만 항목을 낸다."""

ACTIVITY_ENDPOINTS = (
    "activity",
    "activity_details",
    "activity_hr_in_timezones",
    EXERCISE_SETS,
)
"""activityId 하나로 받는 endpoint. `garmin.ACTIVITY_ENDPOINTS`와 같다(순서 포함)."""

_BASE_ACTIVITY_ENDPOINTS = ACTIVITY_ENDPOINTS[:-1]
"""모든 활동이 내는 3종. 세트 상세는 그 뒤에 붙는다."""

NOT_RUN = "not_run"
"""그날 실행 기록이 없을 때의 `DayStatus.status`."""

_DAY = "day"
_ACTIVITY = "activity"
_ACTIVITY_LIST = "activities_by_date"
_NULL = "null"

logger = logging.getLogger(__name__)


class CoverageState(StrEnum):
    """항목 하나의 수집 상태."""

    DATA = "data"
    EMPTY = "empty"
    FAILED = "failed"
    MISSING = "missing"


_COMPLETE = frozenset({CoverageState.DATA, CoverageState.EMPTY})


class FetchErrorKind(StrEnum):
    """`fetch_error.kind`."""

    TRANSIENT = "transient"
    REJECTED = "rejected"


class CoverageItem(NamedTuple):
    """`(scope, key, endpoint)` 항목 하나의 판정.

    - `day_key`: day-scope면 `key`, activity-scope면 그 활동의 일 키.
    - `checked_at`: 원문 행의 `checked_at`(UTC epoch ms). 원문이 없으면 `None`.
    - `final`: 원문을 `day_key` 다음 날(config `timezone`) 이후에 확인했다.
    - `plannable`: `rejected`를 받은 서로 다른 날 수가 `max_rejected_attempts` 미만이다.
    - `fresh`: `activity_exercise_sets`이고 원문이 있으면 `checked_at`이 소속 목록(그 activityId를
      처음 낸 `activities_by_date` 원문)의 `fetched_at` 이후다. 생활 습관은 최신 `completionStats`와
      다르고 그 뒤 재확인하지 않았으면 `False`다. 그 밖의 항목은 늘 `True`다. `state`는
      바꾸지 않는다(`fresh=False`여도 `data`·`empty` 그대로다).
    """

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
    """그날 마지막 실행의 상태. 기록이 없으면 `(NOT_RUN, "", None)`이다."""

    status: errors.RunStatus | str
    detail: str
    finished_at: int | None


class _Raw(NamedTuple):
    checked_at: int
    empty: bool


class _Activity(NamedTuple):
    """활동 하나와 그 소속 목록(그 activityId를 처음 낸 `activities_by_date` 원문)의 `fetched_at`."""

    ref: rawparse.ActivityRef
    list_fetched_at: int


def items(
    conn: store.Connection, cfg: config.Config, start: date, end: date
) -> list[CoverageItem]:
    """[start, end]의 모든 항목을 일 키 오름차순으로 돌려준다. `start > end`면 `ValueError`다.

    한 일 키 안에서는 day 11종(`DAY_ENDPOINTS` 순) 다음에 활동(목록 순)별 3종(`ACTIVITY_ENDPOINTS`
    순)이고, 세트가 필요한 활동은 그 뒤에 `activity_exercise_sets`가 붙는다. 활동은 저장된 모든
    `activities_by_date` 원문(범위 밖 key 포함)에서 찾고, 같은 activityId가 여러 목록에 나오면 목록
    key 오름차순으로 처음 것(소속 목록)을 쓴다. `needs_sets`와 `fresh`의 기준 `fetched_at`도 그 목록의
    것이다.
    """
    if start > end:
        raise ValueError(f"start({start})가 end({end})보다 늦다")
    first, last = start.isoformat(), end.isoformat()
    raws = _raw_rows(conn, first, last)
    failures = _failures(conn)
    refs, broken = _activity_refs(conn)
    stale_lifestyle = _stale_lifestyle(conn)

    activities: dict[str, list[_Activity]] = {}
    for activity in refs:
        if first <= activity.ref.day_key <= last:
            activities.setdefault(activity.ref.day_key, []).append(activity)

    def item(
        scope: str,
        key: str,
        endpoint: str,
        day_key: str,
        list_fetched_at: int | None = None,
    ) -> CoverageItem:
        where = (scope, key, endpoint)
        raw = raws.get(where)
        failure = failures.get(where)
        if raw is not None:
            state = CoverageState.EMPTY if raw.empty else CoverageState.DATA
            checked_at: int | None = raw.checked_at
        elif failure is not None:
            state, checked_at = CoverageState.FAILED, None
        else:
            state, checked_at = CoverageState.MISSING, None
        final = checked_at is not None and dates.day_key(checked_at, cfg) > day_key
        if scope == _DAY and endpoint == _ACTIVITY_LIST and key in broken:
            final = False
        rejected_days = failure if failure is not None else 0
        plannable = rejected_days < cfg.max_rejected_attempts
        fresh = (
            endpoint != EXERCISE_SETS
            or checked_at is None
            or list_fetched_at is None
            or checked_at >= list_fetched_at
        )
        if (
            scope == _DAY
            and endpoint == "lifestyle_logging_data"
            and key in stale_lifestyle
        ):
            fresh = False
        return CoverageItem(
            scope, key, endpoint, day_key, state, final, checked_at, plannable, fresh
        )

    result: list[CoverageItem] = []
    day = start
    while day <= end:
        key = day.isoformat()
        result.extend(item(_DAY, key, endpoint, key) for endpoint in DAY_ENDPOINTS)
        for activity in activities.get(key, ()):
            activity_id = str(activity.ref.activity_id)
            result.extend(
                item(_ACTIVITY, activity_id, endpoint, key)
                for endpoint in _BASE_ACTIVITY_ENDPOINTS
            )
            if activity.ref.needs_sets:
                result.append(
                    item(
                        _ACTIVITY,
                        activity_id,
                        EXERCISE_SETS,
                        key,
                        activity.list_fetched_at,
                    )
                )
        day += timedelta(days=1)
    return result


def incomplete(item: CoverageItem) -> bool:
    """아직 받을 항목이면 참. `collect`의 계획과 재시도 계획이 함께 쓰는 유일한 미완료 판정이다.

    `plannable`이 아니면 거짓, `data`·`empty`가 아니면 참이다. `data`·`empty`면 day-scope는 `final`이
    아니거나 `fresh`가 아닐 때, activity-scope는 `fresh`가 아닐 때(소속 목록이 세트 상세 확인 뒤 바뀜) 참이다.
    """
    if not item.plannable:
        return False
    if item.state not in _COMPLETE:
        return True
    return (not item.final or not item.fresh) if item.scope == _DAY else not item.fresh


def day_status(conn: store.Connection, day: date) -> DayStatus:
    """`day`의 `skipped_blocked`가 아닌 실행 중 `started_at`이 가장 늦은(같으면 rowid가 큰) 행.

    lock_timeout 행(`error`이고 `detail`의 첫 토큰이 `lock_timeout`)은 그날 `skipped_blocked`도
    lock_timeout도 아닌 행이 하나도 없을 때만 고르고, 그때는 lock_timeout 행 중 가장 늦은 행이다.
    락을 못 잡아 수집하지 않은 실행이 그날 실제 수집 결과(락을 쥔 `collect`의 결과 포함)를 가리지
    않게 한다.
    """
    token = errors.RunDetail.LOCK_TIMEOUT.value
    row = conn.execute(
        "SELECT status, detail, finished_at FROM garmin.run"
        " WHERE user_id = %s AND connection_id = %s AND local_date = %s AND status != %s"
        # LIKE는 `_`를 와일드카드로 읽으므로 앞부분을 그대로 비교한다.
        " ORDER BY status = %s AND (detail = %s OR substr(detail, 1, %s) = %s),"
        " started_at DESC, id DESC LIMIT 1",
        (
            conn.user_id, conn.connection_id, day.isoformat(),
            errors.RunStatus.SKIPPED_BLOCKED.value,
            errors.RunStatus.ERROR.value,
            token,
            len(token) + 1,
            f"{token} ",
        ),
    ).fetchone()
    if row is None:
        return DayStatus(NOT_RUN, "", None)
    status, detail, finished_at = row
    return DayStatus(errors.RunStatus(status), detail, finished_at)


def _raw_rows(
    conn: store.Connection, first: str, last: str
) -> dict[tuple[str, str, str], _Raw]:
    """범위 안 day-scope 원문과 모든 activity-scope 원문의 `(checked_at, 'null'인지)`."""
    rows = conn.execute(
        "SELECT scope, key, endpoint, checked_at, raw = %s FROM garmin.raw_current"
        " WHERE user_id = %s AND connection_id = %s AND ((scope = %s AND key BETWEEN %s AND %s) OR scope = %s)",
        (_NULL, conn.user_id, conn.connection_id, _DAY, first, last, _ACTIVITY),
    )
    return {
        (scope, key, endpoint): _Raw(checked_at, bool(empty))
        for scope, key, endpoint, checked_at, empty in rows
    }


def _failures(conn: store.Connection) -> dict[tuple[str, str, str], int]:
    """실패 기록이 있는 항목마다 `rejected`를 받은 서로 다른 `local_date` 수."""
    rows = conn.execute(
        "SELECT scope, key, endpoint,"
        " COUNT(DISTINCT CASE WHEN kind = %s THEN local_date END)"
        " FROM garmin.fetch_error WHERE user_id=%s AND connection_id=%s GROUP BY scope, key, endpoint",
        (FetchErrorKind.REJECTED.value, conn.user_id, conn.connection_id),
    )
    return {(scope, key, endpoint): count for scope, key, endpoint, count in rows}


def _activity_refs(
    conn: store.Connection,
) -> tuple[list[_Activity], set[str]]:
    """저장된 모든 활동 목록의 활동(목록 key 오름차순, 처음 것만)과 형식이 틀린 목록 key.

    활동마다 소속 목록 원문의 `fetched_at`을 함께 돌려준다.
    """
    rows = conn.execute(
        "SELECT key, raw, fetched_at FROM garmin.raw_current"
        " WHERE user_id=%s AND connection_id=%s AND scope = %s AND endpoint = %s ORDER BY key COLLATE \"C\"",
        (conn.user_id, conn.connection_id, _DAY, _ACTIVITY_LIST),
    )
    refs: list[_Activity] = []
    seen: set[int] = set()
    broken: set[str] = set()
    for key, raw, fetched_at in rows:
        try:
            parsed = rawparse.activity_refs(raw)
        except rawparse.RawParseError as error:
            logger.warning("활동 목록 원문 형식 오류(key=%s): %s", key, error)
            broken.add(key)
            continue
        for ref in parsed:
            if ref.activity_id not in seen:
                seen.add(ref.activity_id)
                refs.append(_Activity(ref, fetched_at))
    return refs, broken


def _stale_lifestyle(conn: store.Connection) -> set[str]:
    """Compare stored self counts with the latest non-null report, across all keys."""
    rows = conn.execute(
        "SELECT key, raw, fetched_at, checked_at FROM garmin.raw_current"
        " WHERE user_id=%s AND connection_id=%s AND scope = 'day' AND endpoint = 'lifestyle_logging_data' ORDER BY key COLLATE \"C\" DESC",
        (conn.user_id, conn.connection_id)
    ).fetchall()
    reference = next((row for row in rows if row[1] != _NULL), None)
    if reference is None:
        return set()
    key, raw, fetched_at, _ = reference
    try:
        stats = rawparse.completion_stats(raw)
        reference_day = date.fromisoformat(key)
    except (rawparse.RawParseError, ValueError) as error:
        logger.warning("생활 습관 원문 형식 오류(key=%s): %s", key, error)
        return set()
    stored = {row[0]: row for row in rows}
    stale = set()
    for day, count in stats.items():
        try:
            if (
                not reference_day - timedelta(days=6)
                <= date.fromisoformat(day)
                < reference_day
            ):
                continue
            previous = stored.get(day)
            if previous is None or previous[3] >= fetched_at:
                continue
            if rawparse.completion_stats(previous[1]).get(day, 0) != count:
                stale.add(day)
        except (rawparse.RawParseError, ValueError) as error:
            logger.warning("생활 습관 원문 형식 오류(key=%s): %s", day, error)
            continue
    return stale
