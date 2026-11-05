"""보존된 Garmin 원문(`raw_response.raw`)에서 값을 뽑는 순수 함수(AD-4).

입력은 `store.upsert_raw`가 저장한 JSON 텍스트다. DB·네트워크·시계에 닿지 않고 시간대 변환도
하지 않는다. 그래서 파서를 고친 뒤 보존된 원문만으로 과거 값을 다시 만들 수 있다.

형식이 틀리면 조용히 건너뛰지 않고 `RawParseError`를 낸다. 건너뛰면 활동이 소리 없이 사라지기
때문이다. 오류 메시지에는 원문 내용(건강 데이터)을 넣지 않고 항목 위치만 넣는다.

최상위에서 stdlib(`json`·`datetime`·`typing`)만 import한다. import-linter 계약
`rawparse-is-pure`와 `tests/test_skeleton.py`가 검사한다.
"""

import json
from datetime import date
from typing import NamedTuple

_DAY_KEY_LENGTH = len("YYYY-MM-DD")
_DATE_TIME_SEPARATORS = (" ", "T")
_NOT_JSON = object()


class RawParseError(ValueError):
    """원문 형식이 예상과 다르다. 메시지에는 원문 내용 없이 항목 위치만 담는다."""


class ActivityRef(NamedTuple):
    """활동 목록의 항목 하나: activityId, 그 활동의 일 키(`YYYY-MM-DD`), 세트 상세가 필요한지.

    `needs_sets`는 세트 상세(`activity_exercise_sets`)를 받을 활동인지의 유일한 판정이다(AD-4).
    """

    activity_id: int
    day_key: str
    needs_sets: bool = False


def activity_refs(raw: str) -> list[ActivityRef]:
    """`activities_by_date` 원문에서 (activityId, 일 키) 목록을 뽑는다.

    일 키는 각 항목 `startTimeLocal`(`"YYYY-MM-DD HH:MM:SS"`)의 날짜 부분이다. Garmin이 이미
    활동 현지 시각으로 준 값이라 시간대 변환은 하지 않는다. `'null'`(NoData)과 `'[]'`는 빈
    목록이다. 같은 activityId는 처음 나온 것만 남기고 원문 순서를 지킨다.

    최상위가 리스트가 아니거나, 항목이 dict가 아니거나, `activityId`가 없거나 int가 아니거나
    (bool 포함), `startTimeLocal`이 없거나 날짜로 시작하지 않으면 `RawParseError`다.

    `needs_sets`는 `totalSets`가 0보다 큰 int(bool 제외)이거나 `summarizedExerciseSets`가 비어 있지
    않은 리스트일 때 참이다. 두 키는 없거나 `null`이면 거짓 조건이고, 그 밖의 타입(문자열·bool·
    실수·객체 등)이면 `RawParseError`다.
    """
    try:
        items = json.loads(raw)
    except ValueError:
        items = _NOT_JSON
    if items is _NOT_JSON:
        # `except` 밖에서 던져 원문 조각을 담은 JSONDecodeError가 `__context__`에 남지 않게 한다.
        raise RawParseError("활동 목록 원문이 JSON이 아니다")
    if items is None:
        return []
    if not isinstance(items, list):
        raise RawParseError(
            f"활동 목록 최상위가 리스트가 아니다({type(items).__name__})"
        )
    refs: list[ActivityRef] = []
    seen: set[int] = set()
    for index, item in enumerate(items):
        ref = _activity_ref(index, item)
        if ref.activity_id not in seen:
            seen.add(ref.activity_id)
            refs.append(ref)
    return refs


def _activity_ref(index: int, item: object) -> ActivityRef:
    if not isinstance(item, dict):
        raise RawParseError(f"활동 목록 항목 [{index}]이 객체가 아니다")
    activity_id = item.get("activityId")
    if not isinstance(activity_id, int) or isinstance(activity_id, bool):
        raise RawParseError(
            f"활동 목록 항목 [{index}]의 activityId가 없거나 정수가 아니다"
        )
    day_key = _day_key(item.get("startTimeLocal"))
    if day_key is None:
        raise RawParseError(
            f"활동 목록 항목 [{index}]의 startTimeLocal이 없거나 날짜로 시작하지 않는다"
        )
    return ActivityRef(activity_id, day_key, _needs_sets(index, item))


def _needs_sets(index: int, item: dict[str, object]) -> bool:
    """`totalSets > 0`이거나 `summarizedExerciseSets`가 비어 있지 않으면 참. 형식이 틀리면 오류다."""
    total = item.get("totalSets")
    if total is not None and (not isinstance(total, int) or isinstance(total, bool)):
        raise RawParseError(f"활동 목록 항목 [{index}]의 totalSets가 정수가 아니다")
    summarized = item.get("summarizedExerciseSets")
    if summarized is not None and not isinstance(summarized, list):
        raise RawParseError(
            f"활동 목록 항목 [{index}]의 summarizedExerciseSets가 리스트가 아니다"
        )
    return (total is not None and total > 0) or bool(summarized)


def _day_key(value: object) -> str | None:
    """`"YYYY-MM-DD HH:MM:SS"`의 날짜 부분. 형식이 틀리면 `None`이다.

    `date.fromisoformat`은 `20261016`·`2026-W42-5` 같은 다른 ISO 8601 꼴도 받으므로 되돌린
    문자열이 원래 날짜 부분과 같은지까지 본다. 날짜 뒤는 비었거나 공백·`T`로 이어져야 한다.
    """
    if not isinstance(value, str):
        return None
    part, rest = value[:_DAY_KEY_LENGTH], value[_DAY_KEY_LENGTH:]
    if rest and not rest.startswith(_DATE_TIME_SEPARATORS):
        return None
    try:
        parsed = date.fromisoformat(part)
    except ValueError:
        return None
    if parsed.isoformat() != part:
        return None
    return part


def completion_stats(raw: str) -> dict[str, int]:
    """Return lifestyle tracking counts by calendar date, without interpreting habits."""
    try:
        top = json.loads(raw)
    except ValueError:
        top = _NOT_JSON
    if top is _NOT_JSON:
        raise RawParseError("생활 습관 원문이 JSON이 아니다")
    if top is None:
        return {}
    if not isinstance(top, dict):
        raise RawParseError("생활 습관 최상위가 객체가 아니다")
    rows = top.get("completionStats")
    if rows is None:
        rows = []
    if not isinstance(rows, list):
        raise RawParseError("completionStats가 리스트가 아니다")
    result = {}
    for index, row in enumerate(rows):
        if not isinstance(row, dict):
            raise RawParseError(f"completionStats 항목 [{index}]이 객체가 아니다")
        day = _day_key(row.get("calendarDate"))
        count = row.get("completedTracking")
        if (
            day is None
            or not isinstance(count, int)
            or isinstance(count, bool)
            or count < 0
        ):
            raise RawParseError(
                f"completionStats 항목 [{index}]의 날짜·개수가 유효하지 않다"
            )
        result[day] = count
    return result
