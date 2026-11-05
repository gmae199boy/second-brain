"""보존된 일일 원문 8종에서 `daily_metric` 열 값과 샘플을 뽑는 순수 함수(FR9·11, NFR3, AD-4·13).

파서는 `(raw, day_key) -> dict[열 이름, 값]`이고, 샘플 파서(`body_battery_samples`·`stress_body_battery_samples`·`heart_rate_samples`)는
`(raw, day_key) -> list[(ts_ms, 값)]`이다. `heart_rates`는 열을 소유하지 않아 빈 dict를 돌려준다. `raw`는 `store.upsert_raw`가 저장한 JSON 텍스트이고,
`'null'`(NoData)은 호출자(`normalize.run`)가 처리하므로 여기 오지 않는다. DB·네트워크·시계에 닿지
않는다.

값 규칙:
- 읽는 키는 반드시 있어야 하고 값은 null이어도 된다. 키가 없거나 컨테이너 타입(dict·list)이 다르면
  `NormalizeParseError`다. 키 이름이 바뀌면 조용히 NULL이 되지 않고 실패로 드러나게 한다. null을
  허용하는 컨테이너는 `hrvSummary.baseline`, `dailySleepDTO.sleepScores`와 그 `overall`,
  `stressValuesArray`·`stressValueDescriptorsDTOList`, `bodyBatteryValuesArray`·
  `bodyBatteryValueDescriptorDTOList`·`bodyBatteryValueDescriptorsDTOList`, `heartRateValues`·`heartRateValueDescriptors`다. 키를 읽지 않는 예외는 다음과 같다: `dailySleepDTO.sleepTimeSeconds`가
  null·음수면 수면의 다른 키를 읽지 않고, 준비도의 `inputContext`와 `dailySleepDTO.sleepScores`는 없어도
  된다(`sleepScores`는 어느 밤이든 없어도 된다. 첫 밤에 관찰됨). stress Body Battery의 배열·descriptor 키가
  둘 다 없으면 샘플이 없고, 하나만 없으면 오류다(시계를 안 찬 날의 실제 응답).
- 실제 Garmin "빈 모양" 응답은 값 없음으로 받는다: `rhr_day`의 `allMetrics.metricsMap`이 빈 dict면
  `resting_hr`가 `None`이다. 다른 키가 있는데 `WELLNESS_RESTING_HEART_RATE`가 없으면 여전히 오류다.
- 샘플 배열(`[ts, 값]` 같은 리스트의 리스트)은 고정 인덱스가 아니라 descriptor 목록으로 위치를 찾는다.
  timestamp는 0 이상의 int여야 한다. 결측 샘플(값 `None`)도 남긴다. 심박(bpm)은 반올림 결과가 0이어도
  `None`이다. `body_battery`·`heart_rates`·stress Body Battery의 샘플 배열에만 다음 두 규칙이 있다.
  - 같은 timestamp가 다시 나오면 원문 행이 같을 때(완전 중복, 55와 55.0은 같다)만 첫 샘플을 남기고,
    다르면(null 대 숫자 포함) 오류다.
  - descriptor 목록이 null이고 모든 행이 "0 이상 int timestamp + 나머지 모두 null"(`[ts, null]`)이면 빈
    모양으로 보고 샘플 없이 받는다. 값이 하나라도 있는 행이 있으면 오류다.
- 숫자는 int·float만 받는다(bool·문자열·무한대·NaN은 오류). 음수는 Garmin 센티넬로 보고 `None`이다.
  나머지는 `round()`한 int다(Python `round`는 짝수 쪽 반올림이라 52.5 → 52, 53.5 → 54). 문자열 필드는
  str 또는 null이다.
- 오류 메시지에는 원문 값 없이 위치(endpoint와 키 경로)만 담는다.

activity-scope 파서(`normalize.activity`)도 이 모듈의 값 규칙과 helper를 그대로 쓴다.

stdlib만 import한다.
"""

import json
import math
from collections.abc import Callable

type Value = int | str | None
type Parser = Callable[[str, str], dict[str, Value]]

USER_SUMMARY_COLUMNS = (
    "steps",
    "distance_m",
    "active_kcal",
    "moderate_intensity_s",
    "vigorous_intensity_s",
    "min_hr",
    "max_hr",
)
RHR_DAY_COLUMNS = ("resting_hr",)
HRV_DATA_COLUMNS = (
    "hrv_last_night_avg",
    "hrv_weekly_avg",
    "hrv_baseline_low",
    "hrv_baseline_high",
    "hrv_status",
)
TRAINING_READINESS_COLUMNS = ("readiness_score", "readiness_level")
SLEEP_DATA_COLUMNS = (
    "sleep_s",
    "deep_sleep_s",
    "light_sleep_s",
    "rem_sleep_s",
    "awake_sleep_s",
    "sleep_score",
    "sleep_start_ms",
    "sleep_end_ms",
)
STRESS_DATA_COLUMNS = ("stress_avg", "stress_max")
BODY_BATTERY_COLUMNS = ("bb_charged", "bb_drained", "bb_high", "bb_low")
HEART_RATES_COLUMNS: tuple[str, ...] = ()

type Sample = tuple[Value, ...]
"""샘플 테이블 한 행의 값(키 열 제외, `normalize.SampleTable.columns` 순서). 시계열 샘플은 `(ts_ms, 값)`이다."""
type SampleParser = Callable[[str, str], list[Sample]]

_SECONDS_PER_MINUTE = 60
_AFTER_WAKEUP_RESET = "AFTER_WAKEUP_RESET"
_NOT_JSON = object()


class NormalizeParseError(ValueError):
    """원문 형식이 예상과 다르다. 메시지에는 원문 값 없이 endpoint와 키 경로만 담는다."""


def user_summary(raw: str, day_key: str) -> dict[str, Value]:
    """`user_summary` 원문의 걸음·거리·활동 칼로리·강도 시간(분→초)·최소/최대 심박."""
    endpoint = "user_summary"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    moderate = _number(endpoint, top, "moderateIntensityMinutes", "")
    vigorous = _number(endpoint, top, "vigorousIntensityMinutes", "")
    return {
        "steps": _int(_number(endpoint, top, "totalSteps", "")),
        "distance_m": _int(_number(endpoint, top, "totalDistanceMeters", "")),
        "active_kcal": _int(_number(endpoint, top, "activeKilocalories", "")),
        "moderate_intensity_s": _int(_scaled(moderate, _SECONDS_PER_MINUTE)),
        "vigorous_intensity_s": _int(_scaled(vigorous, _SECONDS_PER_MINUTE)),
        "min_hr": _int(_number(endpoint, top, "minHeartRate", "")),
        "max_hr": _int(_number(endpoint, top, "maxHeartRate", "")),
    }


def rhr_day(raw: str, day_key: str) -> dict[str, Value]:
    """`allMetrics.metricsMap.WELLNESS_RESTING_HEART_RATE[]`에서 `calendarDate`가 일 키인 항목의 `value`.

    그런 항목이 없으면 `None`이다. 항목마다 `calendarDate` 키가 문자열 또는 null로 있어야 하고, 고른 항목에는 `value`
    키가 있어야 한다. `metricsMap`이 빈 dict(시계를 안 찬 날의 빈 모양)면 `None`이고, 다른 키가 있는데
    `WELLNESS_RESTING_HEART_RATE`가 없으면 오류다.
    """
    endpoint = "rhr_day"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    all_metrics = _expect_dict(
        _get(endpoint, top, "allMetrics", ""), endpoint, "allMetrics"
    )
    path = "allMetrics.metricsMap"
    metrics_map = _expect_dict(
        _get(endpoint, all_metrics, "metricsMap", "allMetrics."), endpoint, path
    )
    if not metrics_map:
        return {"resting_hr": None}
    list_key = "WELLNESS_RESTING_HEART_RATE"
    entries = _expect_list(
        _get(endpoint, metrics_map, list_key, f"{path}."),
        endpoint,
        f"{path}.{list_key}",
    )
    resting: float | None = None
    for index, entry in enumerate(entries):
        where = f"{path}.{list_key}[{index}]"
        item = _expect_dict(entry, endpoint, where)
        if _string(endpoint, item, "calendarDate", f"{where}.") == day_key:
            resting = _number(endpoint, item, "value", f"{where}.")
            break
    return {"resting_hr": _int(resting)}


def hrv_data(raw: str, day_key: str) -> dict[str, Value]:
    """`hrvSummary`의 지난밤·주간 평균, 기준 범위(baseline이 null이면 `None`), 상태."""
    endpoint = "hrv_data"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    summary = _expect_dict(
        _get(endpoint, top, "hrvSummary", ""), endpoint, "hrvSummary"
    )
    prefix = "hrvSummary."
    baseline = _get(endpoint, summary, "baseline", prefix)
    low: float | None = None
    high: float | None = None
    if baseline is not None:
        baseline = _expect_dict(baseline, endpoint, "hrvSummary.baseline")
        low = _number(endpoint, baseline, "balancedLow", "hrvSummary.baseline.")
        high = _number(endpoint, baseline, "balancedUpper", "hrvSummary.baseline.")
    return {
        "hrv_last_night_avg": _int(_number(endpoint, summary, "lastNightAvg", prefix)),
        "hrv_weekly_avg": _int(_number(endpoint, summary, "weeklyAvg", prefix)),
        "hrv_baseline_low": _int(low),
        "hrv_baseline_high": _int(high),
        "hrv_status": _string(endpoint, summary, "status", prefix),
    }


def training_readiness(raw: str, day_key: str) -> dict[str, Value]:
    """아침(기상 직후) 준비도 항목의 `score`·`level`. 빈 리스트면 `None`이다.

    `inputContext == "AFTER_WAKEUP_RESET"`인 항목이 있으면 그중 `timestamp`(문자열)가 가장 이른 항목,
    없으면 전체에서 가장 이른 항목이다. garminconnect `get_morning_training_readiness`와 같은
    `AFTER_WAKEUP_RESET` 기준을 쓰지만, 라이브러리처럼 리스트 순서의 첫 항목(없으면 `data[0]`)을 고르지
    않고 `timestamp`가 가장 이른 항목을 고른다(없으면 전체에서 가장 이른 항목).
    항목마다 `timestamp` 키가 문자열로 있어야 한다. `inputContext`는 펌웨어에 따라 없을 수 있어 선택이고,
    있으면 문자열 또는 null이어야 한다. 같은 시각이 여럿이면 원문에서 먼저 나온 항목이다.
    """
    endpoint = "training_readiness"
    entries = _expect_list(_load(endpoint, raw), endpoint, "$")
    earliest: tuple[str, int, dict[str, object]] | None = None
    earliest_morning: tuple[str, int, dict[str, object]] | None = None
    for index, entry in enumerate(entries):
        where = f"[{index}]"
        item = _expect_dict(entry, endpoint, where)
        timestamp = _get(endpoint, item, "timestamp", f"{where}.")
        if not isinstance(timestamp, str):
            raise NormalizeParseError(
                f"{endpoint}: {where}.timestamp가 문자열이 아니다"
            )
        context = (
            _string(endpoint, item, "inputContext", f"{where}.")
            if "inputContext" in item
            else None
        )
        if earliest is None or timestamp < earliest[0]:
            earliest = (timestamp, index, item)
        if context == _AFTER_WAKEUP_RESET and (
            earliest_morning is None or timestamp < earliest_morning[0]
        ):
            earliest_morning = (timestamp, index, item)
    chosen = earliest_morning or earliest
    if chosen is None:
        return {"readiness_score": None, "readiness_level": None}
    _, index, item = chosen
    where = f"[{index}]."
    return {
        "readiness_score": _int(_number(endpoint, item, "score", where)),
        "readiness_level": _string(endpoint, item, "level", where),
    }


def sleep_data(raw: str, day_key: str) -> dict[str, Value]:
    """`dailySleepDTO`의 수면 시간·단계(초), 수면 점수, 시작·끝 시각(UTC epoch ms).

    `sleepTimeSeconds`가 null·음수면 잠이 기록되지 않은 날로 보고 다른 키를 읽지 않고 모두 `None`이다.
    `sleepScores` 키가 없거나(어느 밤이든. 첫 밤에 관찰됨) `sleepScores`·`overall`이 null이면 `sleep_score`만 `None`이다.
    """
    endpoint = "sleep_data"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    dto = _expect_dict(
        _get(endpoint, top, "dailySleepDTO", ""), endpoint, "dailySleepDTO"
    )
    prefix = "dailySleepDTO."
    total = _number(endpoint, dto, "sleepTimeSeconds", prefix)
    if total is None:
        return dict.fromkeys(SLEEP_DATA_COLUMNS)
    score: float | None = None
    scores = dto.get("sleepScores")
    if scores is not None:
        scores = _expect_dict(scores, endpoint, "dailySleepDTO.sleepScores")
        overall = _get(endpoint, scores, "overall", "dailySleepDTO.sleepScores.")
        if overall is not None:
            path = "dailySleepDTO.sleepScores.overall"
            overall = _expect_dict(overall, endpoint, path)
            score = _number(endpoint, overall, "value", f"{path}.")
    return {
        "sleep_s": _int(total),
        "deep_sleep_s": _int(_number(endpoint, dto, "deepSleepSeconds", prefix)),
        "light_sleep_s": _int(_number(endpoint, dto, "lightSleepSeconds", prefix)),
        "rem_sleep_s": _int(_number(endpoint, dto, "remSleepSeconds", prefix)),
        "awake_sleep_s": _int(_number(endpoint, dto, "awakeSleepSeconds", prefix)),
        "sleep_score": _int(score),
        "sleep_start_ms": _int(
            _number(endpoint, dto, "sleepStartTimestampGMT", prefix)
        ),
        "sleep_end_ms": _int(_number(endpoint, dto, "sleepEndTimestampGMT", prefix)),
    }


def stress_data(raw: str, day_key: str) -> dict[str, Value]:
    """`stressValuesArray`의 유효 스트레스 수준(null·음수 센티넬 제외)의 평균(`round`)과 최대.

    수준의 위치는 `stressValueDescriptorsDTOList`에서 `key == "stressLevel"`인 항목의 `index`다. 샘플이
    하나라도 있으면 그 descriptor가 있어야 하고, 샘플마다 그 위치까지 값이 있는 리스트여야 한다. 유효
    샘플이 없으면(배열이 null·빈 리스트 포함) 둘 다 `None`이다.
    """
    endpoint = "stress_data"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    samples = _optional_list(endpoint, top, "stressValuesArray", "")
    descriptors = _optional_list(endpoint, top, "stressValueDescriptorsDTOList", "")
    levels: list[float] = []
    if samples:
        positions = _descriptor_positions(
            endpoint,
            descriptors,
            "stressValueDescriptorsDTOList",
            key_field="key",
            index_field="index",
        )
        position = _position(
            endpoint, positions, "stressLevel", "stressValueDescriptorsDTOList"
        )
        for index, sample in enumerate(samples):
            where = f"stressValuesArray[{index}]"
            row = _sample_row(endpoint, sample, where, position)
            level = _number_value(endpoint, row[position], f"{where}[{position}]")
            if level is not None:
                levels.append(level)
    if not levels:
        return {"stress_avg": None, "stress_max": None}
    return {
        "stress_avg": round(sum(levels) / len(levels)),
        "stress_max": round(max(levels)),
    }


def stress_body_battery_samples(raw: str, day_key: str) -> list[Sample]:
    """`stress_data.bodyBatteryValuesArray`의 `(ts_ms, level)` 목록(원문 순서).

    위치는 `bodyBatteryValueDescriptorsDTOList`의 `bodyBatteryValueDescriptorKey`와
    `bodyBatteryValueDescriptorIndex`로 찾는다. 두 키가 모두 없거나 배열이 null·빈 목록이면 샘플이 없다.
    키가 하나만 없으면 오류다. descriptor가 null이면 모든 행이 빈 모양일 때만 샘플이 없다.
    빈 모양·완전 중복·timestamp·level 규칙은 `_timestamped_samples`와 같다.
    """
    endpoint = "stress_data"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    values_key = "bodyBatteryValuesArray"
    descriptors_key = "bodyBatteryValueDescriptorsDTOList"
    if values_key not in top and descriptors_key not in top:
        return []
    values = _optional_list(endpoint, top, values_key, "")
    descriptors = _optional_list(endpoint, top, descriptors_key, "")
    return [
        (timestamp, _int(level))
        for timestamp, level in _timestamped_samples(
            endpoint,
            values,
            descriptors,
            values_key,
            descriptors_key,
            key_field="bodyBatteryValueDescriptorKey",
            index_field="bodyBatteryValueDescriptorIndex",
            value_key="bodyBatteryLevel",
        )
    ]


def body_battery(raw: str, day_key: str) -> dict[str, Value]:
    """`date`가 일 키인 첫 항목의 `charged`·`drained`와 유효 샘플 level의 최대·최소.

    그런 항목이 없으면 모두 `None`이다. 샘플 규칙은 `body_battery_samples`와 같다.
    """
    entry = _body_battery(raw, day_key)
    if entry is None:
        return dict.fromkeys(BODY_BATTERY_COLUMNS)
    charged, drained, samples = entry
    levels = [level for _, level in samples if level is not None]
    return {
        "bb_charged": _int(charged),
        "bb_drained": _int(drained),
        "bb_high": max(levels) if levels else None,
        "bb_low": min(levels) if levels else None,
    }


def body_battery_samples(raw: str, day_key: str) -> list[Sample]:
    """`date`가 일 키인 첫 항목의 `bodyBatteryValuesArray` 샘플 `(ts_ms, level)` 목록(원문 순서).

    위치는 `bodyBatteryValueDescriptorDTOList`의 `bodyBatteryValueDescriptorKey`(`timestamp`·
    `bodyBatteryLevel`)와 `bodyBatteryValueDescriptorIndex`로 찾는다. timestamp는 0 이상의 int여야 하고
    (bool·float·null은 오류) 같은 timestamp가 다시 나오면 원문 행이 같을 때(완전 중복)만 첫 샘플을
    남기고, 다르면 오류다. level은 null·음수면 `None`이다. 그런 항목이 없거나 배열이 null·빈 리스트면
    빈 목록이다. descriptor 목록이 null이고 모든 행이 `[ts, null]`꼴(빈 모양)이어도 빈 목록이다.
    """
    entry = _body_battery(raw, day_key)
    return [] if entry is None else entry[2]


def _body_battery(
    raw: str, day_key: str
) -> tuple[float | None, float | None, list[Sample]] | None:
    endpoint = "body_battery"
    entries = _expect_list(_load(endpoint, raw), endpoint, "$")
    chosen: tuple[int, dict[str, object]] | None = None
    for index, candidate in enumerate(entries):
        entry = _expect_dict(candidate, endpoint, f"[{index}]")
        if _string(endpoint, entry, "date", f"[{index}].") == day_key:
            chosen = (index, entry)
            break
    if chosen is None:
        return None
    index, item = chosen
    prefix = f"[{index}]."
    charged = _number(endpoint, item, "charged", prefix)
    drained = _number(endpoint, item, "drained", prefix)
    values = _optional_list(endpoint, item, "bodyBatteryValuesArray", prefix)
    list_key = "bodyBatteryValueDescriptorDTOList"
    descriptors = _optional_list(endpoint, item, list_key, prefix)
    samples = [
        (timestamp, _int(level))
        for timestamp, level in _timestamped_samples(
            endpoint,
            values,
            descriptors,
            f"{prefix}bodyBatteryValuesArray",
            f"{prefix}{list_key}",
            key_field="bodyBatteryValueDescriptorKey",
            index_field="bodyBatteryValueDescriptorIndex",
            value_key="bodyBatteryLevel",
        )
    ]
    return charged, drained, samples


def heart_rates(raw: str, day_key: str) -> dict[str, Value]:
    """`heart_rates`는 `daily_metric` 열을 소유하지 않는다(`HEART_RATES_COLUMNS`가 빈 튜플).

    형식 검증은 `heart_rate_samples`가 한다.
    """
    return {}


def heart_rate_samples(raw: str, day_key: str) -> list[Sample]:
    """`heartRateValues` 샘플 `(ts_ms, bpm)` 목록(원문 순서). 일 키 범위 밖 시각도 거르지 않는다.

    최상위 dict에 `heartRateValues`·`heartRateValueDescriptors`(리스트 또는 null) 키가 있어야 한다. 위치는
    descriptor의 `key`(`timestamp`·`heartrate`)와 `index`로 찾는다. timestamp는 0 이상의 int여야 하고
    (bool·float·null은 오류) 같은 timestamp가 다시 나오면 원문 행이 같을 때(완전 중복)만 첫 샘플을
    남기고, 다르면 오류다. bpm은 null·음수거나 반올림 결과가 0이면 `None`이고(0 bpm은 살아 있는 사람의
    값이 아니다), 나머지는 `round()`한 int다. 배열이 null·빈 리스트면 빈 목록이다. descriptor 목록이
    null이고 모든 행이 `[ts, null]`꼴(빈 모양)이어도 빈 목록이다.
    """
    endpoint = "heart_rates"
    top = _expect_dict(_load(endpoint, raw), endpoint, "$")
    values = _optional_list(endpoint, top, "heartRateValues", "")
    descriptors = _optional_list(endpoint, top, "heartRateValueDescriptors", "")
    samples: list[Sample] = []
    for timestamp, value in _timestamped_samples(
        endpoint,
        values,
        descriptors,
        "heartRateValues",
        "heartRateValueDescriptors",
        key_field="key",
        index_field="index",
        value_key="heartrate",
    ):
        bpm = _int(value)
        samples.append((timestamp, None if bpm == 0 else bpm))
    return samples


def _timestamped_samples(
    endpoint: str,
    values: list[object] | None,
    descriptors: list[object] | None,
    values_path: str,
    descriptors_path: str,
    *,
    key_field: str,
    index_field: str,
    value_key: str,
) -> list[tuple[int, float | None]]:
    """`[ts, value]` 같은 샘플 리스트를 `(timestamp, 값)` 목록으로 읽는다(원문 순서).

    샘플이 하나라도 있으면 descriptor 목록에서 `timestamp`·`value_key` 위치를 찾는다. 단 descriptor 목록이
    null이고 배열이 빈 모양(`_empty_shape`, 모든 행이 `[ts, null]`꼴)이면 빈 목록이다. timestamp는 0 이상의
    int여야 한다. 같은 timestamp가 다시 나오면 원문 행 전체가 `==`로 같을 때(완전 중복)만 첫 샘플을
    남기고 건너뛰고, 다르면 오류다. 값은 `_number_value` 규칙(null·음수는 `None`)을 따른다.
    """
    if not values:
        return []
    if descriptors is None and _empty_shape(values):
        return []
    positions = _descriptor_positions(
        endpoint,
        descriptors,
        descriptors_path,
        key_field=key_field,
        index_field=index_field,
    )
    ts_at = _position(endpoint, positions, "timestamp", descriptors_path)
    value_at = _position(endpoint, positions, value_key, descriptors_path)
    samples: list[tuple[int, float | None]] = []
    seen: dict[int, object] = {}
    for sample_index, sample in enumerate(values):
        path = f"{values_path}[{sample_index}]"
        row = _sample_row(endpoint, sample, path, max(ts_at, value_at))
        timestamp = row[ts_at]
        if not _is_timestamp(timestamp):
            raise NormalizeParseError(
                f"{endpoint}: {path}[{ts_at}]가 0 이상의 정수가 아니다"
                f"({_kind(timestamp)})"
            )
        value = _number_value(endpoint, row[value_at], f"{path}[{value_at}]")
        if timestamp in seen:
            # 원문 행 전체가 같은 완전 중복만 첫 샘플로 합친다(`[ts, 55]`와 `[ts, 55.0]`은 같다).
            # null 대 음수처럼 저장 값은 같아도 원문이 다르거나 다른 열이 다르면 오류다.
            if seen[timestamp] == row:
                continue
            raise NormalizeParseError(f"{endpoint}: {path}[{ts_at}] 시각이 중복이다")
        seen[timestamp] = row
        samples.append((timestamp, value))
    return samples


def _is_timestamp(value: object) -> bool:
    """0 이상의 int(bool 제외)인가."""
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _empty_shape(values: list[object]) -> bool:
    """descriptor가 null일 때 Garmin이 보내는 "값 없음" 배열인가.

    모든 행이 리스트이고, 첫 원소가 0 이상 int(bool 제외)이며, 나머지 원소가 모두 null이어야 한다
    (실제 모양 `[ts, null]`). 값이 하나라도 있는 행이 있으면 아니다.
    """
    return all(
        isinstance(row, list)
        and len(row) >= 1
        and _is_timestamp(row[0])
        and all(item is None for item in row[1:])
        for row in values
    )


def _optional_list(
    endpoint: str, container: dict[str, object], key: str, prefix: str
) -> list[object] | None:
    """키가 있어야 하고 값은 리스트 또는 null이다."""
    value = _get(endpoint, container, key, prefix)
    return None if value is None else _expect_list(value, endpoint, f"{prefix}{key}")


def _descriptor_positions(
    endpoint: str,
    descriptors: list[object] | None,
    path: str,
    *,
    key_field: str,
    index_field: str,
) -> dict[str, int]:
    """descriptor 목록의 `{key: index}`. 목록이 null이면 오류다(샘플이 있고 빈 모양이 아닐 때만 부른다)."""
    if descriptors is None:
        raise NormalizeParseError(f"{endpoint}: {path}가 리스트가 아니다(null)")
    positions: dict[str, int] = {}
    for index, descriptor in enumerate(descriptors):
        where = f"{path}[{index}]"
        item = _expect_dict(descriptor, endpoint, where)
        key = _string(endpoint, item, key_field, f"{where}.")
        position = _get(endpoint, item, index_field, f"{where}.")
        if isinstance(position, bool) or not isinstance(position, int) or position < 0:
            raise NormalizeParseError(
                f"{endpoint}: {where}.{index_field}가 0 이상의 정수가 아니다"
                f"({_kind(position)})"
            )
        if key is not None:
            positions.setdefault(key, position)
    return positions


def _position(endpoint: str, positions: dict[str, int], key: str, path: str) -> int:
    if key not in positions:
        raise NormalizeParseError(f"{endpoint}: {path}에 {key} 항목이 없다")
    return positions[key]


def _sample_row(endpoint: str, sample: object, path: str, last: int) -> list[object]:
    """샘플 하나가 `last` 위치까지 값이 있는 리스트인지 확인한다."""
    row = _expect_list(sample, endpoint, path)
    if len(row) <= last:
        raise NormalizeParseError(f"{endpoint}: {path}의 길이가 모자란다")
    return row


def _load(endpoint: str, raw: str) -> object:
    try:
        value = json.loads(raw)
    except ValueError:
        value = _NOT_JSON
    if value is _NOT_JSON:
        # `except` 밖에서 던져 원문 조각을 담은 JSONDecodeError가 `__context__`에 남지 않게 한다.
        raise NormalizeParseError(f"{endpoint}: 원문이 JSON이 아니다")
    return value


def _expect_dict(value: object, endpoint: str, path: str) -> dict[str, object]:
    if not isinstance(value, dict):
        raise NormalizeParseError(f"{endpoint}: {path}가 객체가 아니다({_kind(value)})")
    return value


def _expect_list(value: object, endpoint: str, path: str) -> list[object]:
    if not isinstance(value, list):
        raise NormalizeParseError(
            f"{endpoint}: {path}가 리스트가 아니다({_kind(value)})"
        )
    return value


def _kind(value: object) -> str:
    # 타입 이름만 쓴다. 값은 건강 데이터라 메시지에 넣지 않는다.
    return "null" if value is None else type(value).__name__


def _get(endpoint: str, container: dict[str, object], key: str, prefix: str) -> object:
    if key not in container:
        raise NormalizeParseError(f"{endpoint}: {prefix}{key} 키가 없다")
    return container[key]


def _number(
    endpoint: str, container: dict[str, object], key: str, prefix: str
) -> float | None:
    """키의 숫자 값. null·음수(센티넬)는 `None`이다. 숫자가 아니면 오류다."""
    return _number_value(
        endpoint, _get(endpoint, container, key, prefix), f"{prefix}{key}"
    )


def _number_value(endpoint: str, value: object, path: str) -> float | None:
    """`_number`의 값 규칙. `path`는 오류 메시지에 넣을 위치다."""
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise NormalizeParseError(f"{endpoint}: {path}가 숫자가 아니다({_kind(value)})")
    if isinstance(value, float) and not math.isfinite(value):
        raise NormalizeParseError(f"{endpoint}: {path}가 유한한 숫자가 아니다")
    if value < 0:
        return None
    return value


def _string(
    endpoint: str, container: dict[str, object], key: str, prefix: str
) -> str | None:
    value = _get(endpoint, container, key, prefix)
    if value is not None and not isinstance(value, str):
        raise NormalizeParseError(
            f"{endpoint}: {prefix}{key}가 문자열이 아니다({_kind(value)})"
        )
    return value


def _scaled(value: float | None, factor: int) -> float | None:
    return None if value is None else value * factor


def _int(value: float | None) -> int | None:
    return None if value is None else round(value)


def measurement_only(raw: str, day_key: str) -> dict[str, Value]:
    """Measurements owned by day_summary; no daily_metric columns."""
    _expect_dict(_load("measurement_only", raw), "measurement_only", "$")
    return {}
