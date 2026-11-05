"""단일 설정 원천: `config.toml`을 찾아 검증하고 기본값을 채운다(AD-11).

- 탐색 순서는 `load(path)` 인자(`--config` 값) > `GARMIN_PIPELINE_CONFIG`(빈 문자열은 없는
  것으로 본다) > 현재 폴더의 `config.toml`이다. 고른 파일이 없으면 다음 순위로 넘어가지 않고
  `ConfigError`를 낸다.
- 상대 config 경로는 현재 폴더 기준이고, config 안의 상대경로는 config 파일이 있는 폴더
  기준이다. 경로는 `expanduser` 후 결합만 하고 `resolve`하지 않는다.
- `load`가 파일시스템에 하는 일은 config 파일 읽기와 tokenstore 심링크 검사(`lstat`)뿐이다.
  그 밖에 `timezone` 검증(`ZoneInfo`)이 시스템 tzdata를 읽는다. 디렉터리를 만들거나 존재를
  확인하거나 무언가를 쓰지 않는다.
- `GARMINTOKENS` 환경변수는 읽지 않는다. tokenstore는 config 값(또는 기본값)뿐이다.

stdlib만 import하고 다른 패키지 모듈은 import하지 않는다.
"""

import math
import os
import re
import stat
import sys
import tomllib
from dataclasses import dataclass
from datetime import time
from pathlib import Path
from typing import Literal
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

CONFIG_ENV = "GARMIN_PIPELINE_CONFIG"
CONFIG_FILENAME = "config.toml"
DB_FILENAME = "garmin.db"
ENVIRONMENTS = ("runtime", "dev")

# `environment`는 필수이고 나머지는 생략하면 아래 값을 쓴다. 이 목록 밖의 키는 거부한다.
_DEFAULTS: dict[str, object] = {
    "tokenstore": "~/.garmin-pipeline/tokens",
    "data_dir": "data",
    "reports_dir": "reports",
    "inbox_dir": "inbox",
    "timezone": "Asia/Seoul",
    "collect_time": "11:00",
    "retry_time": "11:15",
    "report_time": "11:30",
    "report_wait_minutes": 30,
    "report_codex_timeout_minutes": 20,
    "report_model": None,
    "report_reasoning_effort": "high",
    "profile_path": "profile.md",
    "date_pause_seconds": 5,
    "call_pause_min_seconds": 1,
    "call_pause_max_seconds": 2,
    "max_dates_per_run": 10,
    "max_rejected_attempts": 3,
    "max_consecutive_403": 3,
    "lock_wait_seconds": 60,
    "cffi_api_session": False,
}
_KNOWN_KEYS = frozenset({"environment", *_DEFAULTS})
_HHMM = re.compile(r"([0-9]{2}):([0-9]{2})")


class ConfigError(Exception):
    """설정 파일을 고르거나 읽거나 검증하지 못했다.

    `.key`는 문제가 된 최상위 키 이름이고, 파일 자체의 문제(없음, TOML 오류)면 `None`이다.
    키 문제면 메시지에도 키 이름이 들어간다.
    """

    def __init__(self, message: str, key: str | None = None) -> None:
        super().__init__(message)
        self.key = key


@dataclass(frozen=True, kw_only=True)
class Config:
    """검증을 마친 설정. 경로는 모두 절대경로이고 `resolve`하지 않은 그대로다."""

    path: Path
    environment: Literal["runtime", "dev"]
    tokenstore: Path
    data_dir: Path
    reports_dir: Path
    inbox_dir: Path
    timezone: str
    collect_time: time
    retry_time: time
    report_time: time
    report_wait_minutes: int
    report_codex_timeout_minutes: int
    report_model: str | None
    report_reasoning_effort: str
    profile_path: Path
    date_pause_seconds: float
    call_pause_min_seconds: float
    call_pause_max_seconds: float
    max_dates_per_run: int
    max_rejected_attempts: int
    max_consecutive_403: int
    lock_wait_seconds: float
    cffi_api_session: bool

    @property
    def db_path(self) -> Path:
        """SQLite DB 파일: `<data_dir>/garmin.db`."""
        return self.data_dir / DB_FILENAME


def under_pytest() -> bool:
    """pytest 안에서 실행 중이면 참이다.

    `load`는 참일 때 운영 설정(`environment = "runtime"`)과 tokenstore를 적지 않은 설정을
    거부한다. `store`와 `install-schedule`도 이 함수로 운영 자원을 지킨다.
    """
    return "PYTEST_CURRENT_TEST" in os.environ or "pytest" in sys.modules


def load(path: str | Path | None = None) -> Config:
    """config 파일을 찾아 읽고 검증한 `Config`를 돌려준다. 잘못되면 `ConfigError`다."""
    config_path, source = _locate(path)
    raw = _read(config_path, source)

    unknown = [key for key in raw if key not in _KNOWN_KEYS]
    if unknown:
        raise _invalid(config_path, unknown[0], "알 수 없는 키다")
    if "environment" not in raw:
        raise _invalid(config_path, "environment", "필수 키가 없다")

    fields = _Fields(config_path, {**_DEFAULTS, **raw})
    cfg = Config(
        path=config_path,
        environment=fields.environment("environment"),
        tokenstore=fields.path("tokenstore"),
        data_dir=fields.path("data_dir"),
        reports_dir=fields.path("reports_dir"),
        inbox_dir=fields.path("inbox_dir"),
        timezone=fields.timezone("timezone"),
        collect_time=fields.clock("collect_time"),
        retry_time=fields.clock("retry_time"),
        report_time=fields.clock("report_time"),
        report_wait_minutes=fields.integer("report_wait_minutes", minimum=0),
        report_codex_timeout_minutes=fields.integer(
            "report_codex_timeout_minutes", minimum=1
        ),
        report_model=fields.optional_string("report_model"),
        report_reasoning_effort=fields.reasoning_effort("report_reasoning_effort"),
        profile_path=fields.path("profile_path"),
        date_pause_seconds=fields.seconds("date_pause_seconds"),
        call_pause_min_seconds=fields.seconds("call_pause_min_seconds"),
        call_pause_max_seconds=fields.seconds("call_pause_max_seconds"),
        # 오늘과 확정되지 않은 어제가 매 실행 두 자리를 차지하므로 3 미만이면 백필이 진행되지 않는다.
        max_dates_per_run=fields.integer("max_dates_per_run", minimum=3),
        max_rejected_attempts=fields.integer("max_rejected_attempts", minimum=1),
        max_consecutive_403=fields.integer("max_consecutive_403", minimum=1),
        lock_wait_seconds=fields.seconds("lock_wait_seconds"),
        cffi_api_session=fields.boolean("cffi_api_session"),
    )

    if cfg.call_pause_min_seconds > cfg.call_pause_max_seconds:
        raise _invalid(
            config_path,
            "call_pause_min_seconds",
            "call_pause_max_seconds보다 클 수 없다"
            f"({cfg.call_pause_min_seconds} > {cfg.call_pause_max_seconds})",
        )
    if under_pytest():
        if cfg.environment == "runtime":
            raise _invalid(
                config_path,
                "environment",
                'pytest 안에서는 "runtime" 설정을 쓰지 않는다. tmp_path에 dev 설정을 만든다',
            )
        if "tokenstore" not in raw:
            raise _invalid(
                config_path,
                "tokenstore",
                "pytest 안에서는 운영 tokenstore를 쓰지 않도록 반드시 적는다",
            )
    _reject_symlinks(config_path, cfg.tokenstore)
    return cfg


def _locate(path: str | Path | None) -> tuple[Path, str]:
    """(절대 config 경로, 그 경로를 고른 출처)."""
    if path is not None:
        chosen, source = Path(path), "--config"
    elif os.environ.get(CONFIG_ENV):
        chosen, source = Path(os.environ[CONFIG_ENV]), CONFIG_ENV
    else:
        chosen, source = Path(CONFIG_FILENAME), "현재 폴더"
    chosen = chosen.expanduser()
    return (chosen if chosen.is_absolute() else Path.cwd() / chosen), source


def _read(config_path: Path, source: str) -> dict[str, object]:
    try:
        text = config_path.read_text(encoding="utf-8")
    except FileNotFoundError as error:
        raise ConfigError(f"설정 파일이 없다: {config_path} ({source})") from error
    except OSError as error:
        raise ConfigError(
            f"설정 파일을 읽지 못했다: {config_path} ({source}, {error.strerror})"
        ) from error
    except UnicodeDecodeError as error:
        raise ConfigError(f"설정 파일이 UTF-8이 아니다: {config_path}") from error
    try:
        return tomllib.loads(text)
    except tomllib.TOMLDecodeError as error:
        raise ConfigError(
            f"설정 파일의 TOML이 잘못됐다: {config_path}: {error}"
        ) from error


def _invalid(config_path: Path, key: str, problem: str) -> ConfigError:
    return ConfigError(f"{config_path}: `{key}` {problem}", key=key)


def _type_name(value: object) -> str:
    return type(value).__name__


class _Fields:
    """기본값을 합친 원시 값에서 키 하나씩 타입·값을 검사해 꺼낸다."""

    def __init__(self, config_path: Path, values: dict[str, object]) -> None:
        self._config_path = config_path
        self._values = values

    def _error(self, key: str, problem: str) -> ConfigError:
        return _invalid(self._config_path, key, problem)

    def string(self, key: str) -> str:
        value = self._values[key]
        if not isinstance(value, str):
            raise self._error(key, f"문자열이어야 한다(받은 타입: {_type_name(value)})")
        return value

    def reasoning_effort(self, key: str) -> str:
        value = self.string(key)
        if value not in ("none", "minimal", "low", "medium", "high", "xhigh"):
            raise self._error(key, "유효한 추론 수준이어야 한다")
        return value

    def optional_string(self, key: str) -> str | None:
        return None if self._values[key] is None else self.string(key)

    def environment(self, key: str) -> Literal["runtime", "dev"]:
        value = self.string(key)
        if value == "runtime":
            return "runtime"
        if value == "dev":
            return "dev"
        raise self._error(key, f'"runtime"이나 "dev"여야 한다(받은 값: {value!r})')

    def path(self, key: str) -> Path:
        value = self.string(key)
        if not value.strip():
            raise self._error(key, "빈 경로다")
        return self._config_path.parent / Path(value).expanduser()

    def timezone(self, key: str) -> str:
        value = self.string(key)
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError, OSError):
            raise self._error(key, f"알 수 없는 시간대다(받은 값: {value!r})") from None
        return value

    def clock(self, key: str) -> time:
        value = self.string(key)
        match = _HHMM.fullmatch(value)
        if match is not None:
            hour, minute = int(match[1]), int(match[2])
            if hour < 24 and minute < 60:
                return time(hour, minute)
        raise self._error(key, f'"HH:MM" 형식이어야 한다(받은 값: {value!r})')

    def integer(self, key: str, *, minimum: int) -> int:
        value = self._values[key]
        if isinstance(value, bool) or not isinstance(value, int):
            raise self._error(key, f"정수여야 한다(받은 타입: {_type_name(value)})")
        if value < minimum:
            raise self._error(key, f"{minimum} 이상이어야 한다(받은 값: {value})")
        return value

    def seconds(self, key: str) -> float:
        value = self._values[key]
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise self._error(
                key, f"초 단위 숫자여야 한다(받은 타입: {_type_name(value)})"
            )
        if not math.isfinite(value) or value < 0:
            raise self._error(key, f"0 이상의 유한한 값이어야 한다(받은 값: {value})")
        return float(value)

    def boolean(self, key: str) -> bool:
        value = self._values[key]
        if not isinstance(value, bool):
            raise self._error(
                key, f"true나 false여야 한다(받은 타입: {_type_name(value)})"
            )
        return value


def _reject_symlinks(config_path: Path, tokenstore: Path) -> None:
    """tokenstore 자신과 모든 부모 중 심링크가 있으면 거부한다.

    부모는 정규화하기 전 경로로 따진다. `a/link/../tokens`는 `a/link`도 검사하므로 `..`로
    심링크를 건너뛰지 못한다. 없는 경로는 심링크가 아니므로 넘어간다.
    """
    for candidate in (tokenstore, *tokenstore.parents):
        try:
            mode = candidate.lstat().st_mode
        except (FileNotFoundError, NotADirectoryError):
            continue
        except OSError as error:
            raise _invalid(
                config_path,
                "tokenstore",
                f"심링크인지 확인하지 못했다: {candidate} ({error.strerror})",
            ) from error
        if stat.S_ISLNK(mode):
            raise _invalid(
                config_path, "tokenstore", f"경로에 심링크가 있다: {candidate}"
            )
