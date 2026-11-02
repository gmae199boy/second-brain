"""보존된 activity-scope 원문에서 `activity` 열 값과 활동 심박 샘플·근력 세트 행을 뽑는 순수 함수(FR11·13, AD-4·13).

파서는 `daily`와 같은 `(raw, key) -> dict[열 이름, 값]`이고, 샘플 파서 `activity_hr_samples`는
`(raw, key) -> list[(ts_ms, bpm, body_battery)]`, 세트 파서 `exercise_set_rows`는 `(raw, key) -> list[행]`(행은
`EXERCISE_SET_COLUMNS` 순서)이다. `key`는 activityId 문자열(`raw_response.key`)이고 파서는 읽지 않는다.
`activity_details`와 `activity_exercise_sets`(세트 상세)는 `activity` 열을 소유하지 않아 빈 dict를 돌려준다.
`raw`는 `store.upsert_raw`가 저장한 JSON 텍스트이고, `'null'`(NoData)은 호출자(`normalize.run`)가
처리하므로 여기 오지 않는다. DB·네트워크·시계에 닿지 않는다.

값 규칙과 helper(`_number_value`, `round`, 음수 → `None`, bool·문자열·NaN 오류, 오류 메시지에는 위치만)는
`normalize.daily`의 것을 그대로 쓴다. 예외: `summaryDTO`의 `distance`·`averageHR`·`maxHR`는 키가 없어도
`None`이다(Garmin은 거리 없는 근력 운동처럼 값이 없는 필드를 응답에서 뺀다). `startTimeGMT`·`duration`·
`activityTypeDTO.typeKey`는 반드시 있어야 한다. 시각 문자열 변환은 `dates.utc_text_ms`가 한다(AD-7).

응답 구조는 garminconnect 0.3.17에 응답 모델이 없어 가정했다. `activity_hr_in_timezones`는
`{zoneNumber, secsInZone, zoneLowBoundary, …}` 리스트, `activity_details`의 심박·시각 채널 키는 `directHeartRate`·
`directTimestamp`다. 다르면 `parse_error`(존) 또는 빈 시계열(심박 채널 이름)로 드러나고, 실제 fixture 시험이
"요약에 심박이 있으면 시계열이 비지 않음"을 본다. 운동 중 Body Battery 채널 키는 `directBodyBattery`다(5.9,
실제 fixture 13개 모두에 있고 값은 정수 값 float, 가끔 null). 채널이 없으면 샘플 행은 그대로이고
`body_battery`만 모두 `None`이다.

세트 상세(`activity_exercise_sets` → `exercise_set`) 규칙은 5.3에서 얻은 실제 세트 fixture로 정했다(값 없이 구조만).
- 최상위 dict에 `exerciseSets` 키가 있어야 하고 값은 리스트 또는 null(null이면 행 없음)이다. 원소는 dict다.
- 순서: `set_index`는 `exerciseSets` 안 위치(0부터, REST 포함)다. `messageIndex`는 fixture 여럿에서 전부
  null이고 `startTime`은 몇 개에서 순서가 뒤집혀 쓰지 않는다.
- 휴식: `setType`은 `"ACTIVE"` 또는 `"REST"`여야 한다(그 밖·null·키 없음은 오류). REST 세트는 `exercises`가 빈
  리스트이고 반복·무게가 null이며 시간만 있다. `is_rest`는 REST면 1이다.
- 종목: `exercises`(리스트 또는 null)의 후보(dict, `category`·`name`은 문자열 또는 null, `probability`는 숫자
  규칙, 세 키 모두 있어야 함) 중 `probability`가 가장 큰 것(같으면 앞의 것, null·음수 확률은 어느 숫자보다
  낮음)의 `category`·`name`이다. 후보가 없으면 둘 다 `None`이다. 이렇게 고른 (`category`, `name`)으로 묶은
  세트·반복·볼륨이 활동 목록의 `summarizedExerciseSets`(Garmin 앱 요약)와 같다.
- 단위: `weight`는 g다(정수 값 float, Σ반복×무게가 목록의 `volume`과 같다). `duration`은 초다. 반복·무게·
  시간은 숫자 규칙(null·음수 → `None`, bool·문자열·NaN 오류) 뒤 `round()`다. 무게 `-1.0`(무게 없는 세트의
  센티넬)은 음수라 `None`이다. 무게는 `round()` 결과가 0이어도 `None`이다(실제 fixture에서 0은 바벨 종목에도
  나오는 "입력 안 함"이라 0 kg로 보지 않는다. 0.4 g처럼 0으로 반올림되는 값도 같다). 반복·시간의 0은 0이다.
- `startTime`·`messageIndex`·`wktStepIndex`·속도·파워·ROM 키와 후보 확률은 저장하지 않는다(읽지도 않는다).

stdlib과 `garmin_pipeline.dates`·`garmin_pipeline.normalize.daily`만 import한다(`garminconnect`·
`parse_activity_detail_metrics`는 쓰지 않는다).
"""

import math

import garmin_dates as dates
from normalize_daily import (
    NormalizeParseError,
    Sample,
    Value,
    _descriptor_positions,
    _expect_dict,
    _expect_list,
    _get,
    _int,
    _kind,
    _load,
    _number,
    _number_value,
    _optional_list,
    _position,
    _sample_row,
    _string,
)

ACTIVITY_COLUMNS = (
    "type_key",
    "start_ms",
    "duration_s",
    "distance_m",
    "avg_hr",
    "max_hr",
)
HR_ZONES = range(1, 6)
"""Garmin 심박 존 번호(1~5로 고정)."""
ACTIVITY_HR_IN_TIMEZONES_COLUMNS = (
    *(f"hr_zone{zone}_s" for zone in HR_ZONES),
    *(f"hr_zone{zone}_low_bpm" for zone in HR_ZONES),
)
ACTIVITY_DETAILS_COLUMNS: tuple[str, ...] = ()
ACTIVITY_EXERCISE_SETS_COLUMNS: tuple[str, ...] = ()
EXERCISE_SET_COLUMNS = (
    "set_index",
    "category",
    "exercise_name",
    "reps",
    "weight_g",
    "duration_s",
    "is_rest",
)
"""`exercise_set`의 값 열(키 `activity_id` 제외). `exercise_set_rows`의 행이 이 순서다."""
_SET_TYPES = {"ACTIVE": 0, "REST": 1}
"""`setType` → `is_rest`. 여기 없는 값(null 포함)은 오류다."""

_HEART_RATE = "directHeartRate"
_TIMESTAMP = "directTimestamp"
_BODY_BATTERY = "directBodyBattery"


def activity(raw: str, key: str) -> dict[str, Value]:
    """`activityTypeDTO.typeKey`와 `summaryDTO`의 시작 시각(UTC epoch ms)·시간(초)·거리(m)·평균/최대 심박.

    `distance`·`averageHR`·`maxHR`는 키가 없으면 `None`이다. `startTimeGMT`는 문자열 또는 null이고 시간대
    표기 없는 `YYYY-MM-DD[ T]HH:MM:SS[.f]`를 UTC로 읽는다.
    """
    endpoint = "activity"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    activity_type = _expect_dict(
        _get(endpoint, top, "activityTypeDTO", ""), endpoint, "activityTypeDTO"
    )
    type_key = _string(endpoint, activity_type, "typeKey", "activityTypeDTO.")
    summary = _expect_dict(
        _get(endpoint, top, "summaryDTO", ""), endpoint, "summaryDTO"
    )
    prefix = "summaryDTO."
    start = _string(endpoint, summary, "startTimeGMT", prefix)
    return {
        "type_key": type_key,
        "start_ms": None
        if start is None
        else _utc_ms(endpoint, start, f"{prefix}startTimeGMT"),
        "duration_s": _int(_number(endpoint, summary, "duration", prefix)),
        "distance_m": _int(_optional_number(endpoint, summary, "distance", prefix)),
        "avg_hr": _int(_optional_number(endpoint, summary, "averageHR", prefix)),
        "max_hr": _int(_optional_number(endpoint, summary, "maxHR", prefix)),
    }


def activity_hr_in_timezones(raw: str, key: str) -> dict[str, Value]:
    """존 번호(`zoneNumber`, 1~5)별 `secsInZone`(초)·`zoneLowBoundary`(bpm). 리스트에 없는 존은 `None`이다.

    최상위는 리스트이고 원소는 dict다. 존 번호는 1~5의 int(bool 제외)여야 하고 범위 밖이거나 중복이면
    오류다(조용히 버리지 않는다). `secsInZone`·`zoneLowBoundary`는 키가 반드시 있어야 하고 숫자 규칙(null·음수는 `None`)을 따른다.
    """
    endpoint = "activity_hr_in_timezones"
    entries = _expect_list(_load(endpoint, raw), endpoint, "$")
    seconds: dict[int, float | None] = {}
    bounds: dict[int, float | None] = {}
    for index, entry in enumerate(entries):
        where = f"[{index}]"
        item = _expect_dict(entry, endpoint, where)
        zone = _get(endpoint, item, "zoneNumber", f"{where}.")
        if isinstance(zone, bool) or not isinstance(zone, int) or zone not in HR_ZONES:
            raise NormalizeParseError(
                f"{endpoint}: {where}.zoneNumber가 1~5의 정수가 아니다({_kind(zone)})"
            )
        if zone in seconds:
            raise NormalizeParseError(f"{endpoint}: {where}.zoneNumber가 중복이다")
        seconds[zone] = _number(endpoint, item, "secsInZone", f"{where}.")
        bounds[zone] = _number(endpoint, item, "zoneLowBoundary", f"{where}.")
    return {
        **{f"hr_zone{zone}_s": _int(seconds.get(zone)) for zone in HR_ZONES},
        **{f"hr_zone{zone}_low_bpm": _int(bounds.get(zone)) for zone in HR_ZONES},
    }


def activity_details(raw: str, key: str) -> dict[str, Value]:
    """`activity_details`는 `activity` 열을 소유하지 않는다(`ACTIVITY_DETAILS_COLUMNS`가 빈 튜플).

    형식 검증은 `activity_hr_samples`가 한다.
    """
    return {}


def activity_exercise_sets(raw: str, key: str) -> dict[str, Value]:
    """`activity_exercise_sets`는 `activity` 열을 소유하지 않는다(`ACTIVITY_EXERCISE_SETS_COLUMNS`가 빈 튜플).

    형식 검증과 세트 행은 `exercise_set_rows`가 맡는다.
    """
    return {}


def exercise_set_rows(raw: str, key: str) -> list[Sample]:
    """`exerciseSets`의 세트마다 `EXERCISE_SET_COLUMNS` 순서의 행 하나(원문 순서, REST 포함).

    규칙은 모듈 docstring의 세트 상세 문단이다. `exerciseSets`가 null이거나 빈 리스트면 빈 목록이다.
    """
    endpoint = "activity_exercise_sets"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    sets = _optional_list(endpoint, top, "exerciseSets", "") or []
    rows: list[Sample] = []
    for set_index, entry in enumerate(sets):
        where = f"exerciseSets[{set_index}]"
        item = _expect_dict(entry, endpoint, where)
        prefix = f"{where}."
        set_type = _get(endpoint, item, "setType", prefix)
        if not isinstance(set_type, str) or set_type not in _SET_TYPES:
            raise NormalizeParseError(
                f"{endpoint}: {prefix}setType이 ACTIVE·REST가 아니다({_kind(set_type)})"
            )
        category, name = _top_exercise(
            endpoint, _optional_list(endpoint, item, "exercises", prefix), where
        )
        rows.append(
            (
                set_index,
                category,
                name,
                _int(_number(endpoint, item, "repetitionCount", prefix)),
                _int(_number(endpoint, item, "weight", prefix)) or None,
                _int(_number(endpoint, item, "duration", prefix)),
                _SET_TYPES[set_type],
            )
        )
    return rows


def _top_exercise(
    endpoint: str, candidates: list[object] | None, where: str
) -> tuple[str | None, str | None]:
    """확률이 가장 큰 후보의 (`category`, `name`). 같으면 앞의 것, null·음수 확률은 어느 숫자보다 낮다.

    후보가 없으면 `(None, None)`이다. 고르지 않은 후보도 세 키와 값 형식을 검사한다.
    """
    best: tuple[str | None, str | None] = (None, None)
    best_probability: float | None = None
    for index, candidate in enumerate(candidates or []):
        path = f"{where}.exercises[{index}]"
        item = _expect_dict(candidate, endpoint, path)
        prefix = f"{path}."
        category = _string(endpoint, item, "category", prefix)
        name = _string(endpoint, item, "name", prefix)
        probability = _number(endpoint, item, "probability", prefix)
        if index == 0 or (
            probability is not None
            and (best_probability is None or probability > best_probability)
        ):
            best, best_probability = (category, name), probability
    return best


def activity_hr_samples(raw: str, key: str) -> list[Sample]:
    """`activityDetailMetrics` 샘플 `(ts_ms, bpm, body_battery)` 목록(원문 순서).

    최상위 dict에 `metricDescriptors`·`activityDetailMetrics`(리스트 또는 null) 키가 있어야 한다. 샘플이
    하나라도 있으면 descriptor의 `key`와 `metricsIndex`로 위치를 찾는다. `directHeartRate` 항목이 없으면
    심박 시계열이 없는 활동으로 보고 빈 목록이다. 있으면 `directTimestamp` 항목도 있어야 하고, 샘플은
    `{"metrics": [...]}` dict이고 `metrics`는 두 위치(`directBodyBattery` 항목이 있으면 그 위치까지)를 담는
    리스트여야 한다. 하나라도 짧으면 항목 전체가 오류라 심박 샘플도 남지 않는다.

    timestamp는 0 이상의 int 또는 유한 float이고 `round()`한다(bool·null·문자열은 오류). 반올림 뒤 같은
    timestamp가 두 번 나오면 오류다. bpm은 `heart_rates`와 같이 null·음수거나 반올림 결과가 0이면 `None`이고,
    결측 샘플도 남긴다.

    `body_battery`는 `directBodyBattery` 항목이 있으면 그 위치의 값이고(위치는 descriptor로 동적으로 찾는다),
    숫자 규칙(null·음수 → `None`, bool·문자열·NaN 오류) 뒤 `round()`한다. 0은 0으로 남긴다. 항목이 없으면
    모든 샘플이 `None`이다. 행이 생기는 조건은 `directHeartRate` 항목 하나뿐이다.
    """
    endpoint = "activity_details"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    descriptors_path = "metricDescriptors"
    descriptors = _optional_list(endpoint, top, descriptors_path, "")
    values = _optional_list(endpoint, top, "activityDetailMetrics", "")
    if not values:
        return []
    positions = _descriptor_positions(
        endpoint,
        descriptors,
        descriptors_path,
        key_field="key",
        index_field="metricsIndex",
    )
    if _HEART_RATE not in positions:
        return []
    hr_at = positions[_HEART_RATE]
    ts_at = _position(endpoint, positions, _TIMESTAMP, descriptors_path)
    bb_at = positions.get(_BODY_BATTERY)
    last = max(ts_at, hr_at) if bb_at is None else max(ts_at, hr_at, bb_at)
    samples: list[Sample] = []
    seen: set[int] = set()
    for sample_index, sample in enumerate(values):
        path = f"activityDetailMetrics[{sample_index}]"
        item = _expect_dict(sample, endpoint, path)
        metrics_path = f"{path}.metrics"
        row = _sample_row(
            endpoint,
            _get(endpoint, item, "metrics", f"{path}."),
            metrics_path,
            last,
        )
        timestamp = _timestamp(endpoint, row[ts_at], f"{metrics_path}[{ts_at}]")
        if timestamp in seen:
            raise NormalizeParseError(
                f"{endpoint}: {metrics_path}[{ts_at}] 시각이 중복이다"
            )
        seen.add(timestamp)
        bpm = _int(_number_value(endpoint, row[hr_at], f"{metrics_path}[{hr_at}]"))
        body_battery = (
            None
            if bb_at is None
            else _int(_number_value(endpoint, row[bb_at], f"{metrics_path}[{bb_at}]"))
        )
        samples.append((timestamp, None if bpm == 0 else bpm, body_battery))
    return samples


def _optional_number(
    endpoint: str, container: dict[str, object], key: str, prefix: str
) -> float | None:
    """키가 없으면 `None`이고, 있으면 `_number_value` 규칙을 따른다."""
    if key not in container:
        return None
    return _number_value(endpoint, container[key], f"{prefix}{key}")


def _utc_ms(endpoint: str, text: str, path: str) -> int:
    try:
        moment = dates.utc_text_ms(text)
    except ValueError:
        moment = None
    if moment is None:
        # `except` 밖에서 던져 원래 예외가 `__context__`에 남지 않게 한다.
        raise NormalizeParseError(
            f"{endpoint}: {path}가 시간대 표기 없는 YYYY-MM-DD HH:MM:SS 시각이 아니다"
        )
    return moment


def _timestamp(endpoint: str, value: object, path: str) -> int:
    """0 이상의 int 또는 유한 float를 `round()`한 epoch ms. 그 밖(bool·null·문자열·음수)은 오류다."""
    if (
        isinstance(value, bool)
        or not isinstance(value, int | float)
        or (isinstance(value, float) and not math.isfinite(value))
        or value < 0
    ):
        raise NormalizeParseError(
            f"{endpoint}: {path}가 0 이상의 유한한 숫자가 아니다({_kind(value)})"
        )
    return round(value)
