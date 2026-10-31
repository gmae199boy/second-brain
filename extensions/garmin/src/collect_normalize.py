"""보존된 Garmin normalize/daily.py의 v8 user_summary와 순수 helper."""
import json
import math

type Value = int | str | None
_SECONDS_PER_MINUTE = 60
_NOT_JSON = object()

class NormalizeParseError(ValueError):
    pass


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



def _scaled(value: float | None, factor: int) -> float | None:
    return None if value is None else value * factor


def _int(value: float | None) -> int | None:
    return None if value is None else round(value)

