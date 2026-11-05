"""단일 "오늘"과 일 키: 시간대 변환은 이 모듈만 한다(AD-7).

일 키는 config `timezone`(기본 Asia/Seoul) 기준 로컬 달력 날짜 `YYYY-MM-DD`이고, 시각은 UTC
epoch ms로 다룬다. 시스템 로컬 시각은 쓰지 않는다. 현재 시각은 `_utc_now()` 하나에서만 읽으며,
테스트는 이 함수만 monkeypatch한다.

`day_start_ms(day, cfg)`는 현지 날짜의 자정을 UTC epoch ms로 바꾼다(DST 반영).

`local_minute()`는 UTC epoch ms를 config `timezone` 기준 표시용 시각 문자열(`YYYY-MM-DD HH:MM`)로 바꾼다.

`utc_text_ms()`는 시간대 표기가 없는 Garmin GMT 시각 문자열(예: `summaryDTO.startTimeGMT`)을 UTC로 읽어
epoch ms로 바꾼다.

`system_timezone()`은 시스템 시간대의 *이름*만 읽는다(config `timezone`과 같은지 확인하는 데만 쓴다).
시스템 시간대로 시각을 바꾸지는 않는다.

stdlib과 `garmin_pipeline.config`만 import한다.
"""

import os
import re
from datetime import UTC, date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from garmin_pipeline.config import Config

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_ONE_MS = timedelta(milliseconds=1)
_LOCALTIME = Path("/etc/localtime")
"""시스템 시간대 링크. 테스트는 이 경로만 바꾼다."""
_ZONEINFO_MARKER = "zoneinfo/"
_UTC_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?", re.ASCII)
"""`YYYY-MM-DD[ T]HH:MM:SS[.f]`. 시간대 표기(`Z`·`+09:00`)와 날짜만 있는 꼴은 받지 않는다."""


def _utc_now() -> datetime:
    """시계 seam. 테스트는 이것만 바꾼다."""
    return datetime.now(UTC)


def now_ms() -> int:
    """현재 시각(UTC epoch ms)."""
    return (_utc_now() - _EPOCH) // _ONE_MS


def today(cfg: Config) -> date:
    """config `timezone` 기준 오늘 날짜."""
    return _utc_now().astimezone(ZoneInfo(cfg.timezone)).date()


def day_key(epoch_ms: int, cfg: Config) -> str:
    """UTC epoch ms가 속한 config `timezone` 기준 날짜(`YYYY-MM-DD`)."""
    moment = _EPOCH + timedelta(milliseconds=epoch_ms)
    return moment.astimezone(ZoneInfo(cfg.timezone)).date().isoformat()


def local_minute(epoch_ms: int, cfg: Config) -> str:
    """UTC epoch ms의 config `timezone` 기준 로컬 시각 `YYYY-MM-DD HH:MM`(초 이하는 버린다)."""
    moment = _EPOCH + timedelta(milliseconds=epoch_ms)
    local = moment.astimezone(ZoneInfo(cfg.timezone))
    return f"{local.date().isoformat()} {local.hour:02d}:{local.minute:02d}"


def utc_text_ms(text: str) -> int:
    """시간대 표기가 없는 `YYYY-MM-DD[ T]HH:MM:SS[.f]`를 UTC 시각으로 보고 epoch ms로 바꾼다.

    소수 초는 마이크로초까지 읽고 ms 미만은 버린다. 날짜만 있거나, 시간대 표기가 있거나, 형식이
    틀리거나, 날짜·시각 값이 범위 밖이면 `ValueError`다. 메시지에는 입력 값을 넣지 않는다.
    """
    if not isinstance(text, str) or _UTC_TEXT.fullmatch(text) is None:
        raise ValueError("시간대 표기 없는 YYYY-MM-DD HH:MM:SS 형식이 아니다")
    try:
        naive = datetime.fromisoformat(text)
    except ValueError:
        naive = None
    if naive is None:
        # `except` 밖에서 던져 입력 값을 담은 원래 예외가 `__context__`에 남지 않게 한다.
        raise ValueError("날짜·시각 값이 범위 밖이다")
    return (naive.replace(tzinfo=UTC) - _EPOCH) // _ONE_MS


def system_timezone() -> str | None:
    """시스템 시간대 이름. 알 수 없으면 `None`이다.

    비어 있지 않은 `TZ` 환경변수(앞 `:` 하나 제거)가 먼저다. 없으면 `/etc/localtime`의 실제
    경로에서 마지막 `zoneinfo/` 뒤 부분(예: `Asia/Seoul`)이다.
    """
    name = os.environ.get("TZ", "").removeprefix(":")
    if name:
        return name
    try:
        target = str(_LOCALTIME.resolve(strict=True))
    except (OSError, RuntimeError):
        return None
    _, marker, zone = target.rpartition(_ZONEINFO_MARKER)
    return zone if marker and zone else None


def day_start_ms(day: date, cfg: Config) -> int:
    """config 시간대의 현지 자정(UTC epoch ms)."""
    midnight = datetime(day.year, day.month, day.day, tzinfo=ZoneInfo(cfg.timezone))
    return (midnight.astimezone(UTC) - _EPOCH) // _ONE_MS
