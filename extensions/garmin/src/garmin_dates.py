import re
from datetime import UTC, datetime, timedelta

_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
_ONE_MS = timedelta(milliseconds=1)
_UTC_TEXT = re.compile(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?", re.ASCII)

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


