"""보존된 원문을 분석용 테이블로 정규화한다: 작업 집합, 항목별 트랜잭션, 실패 격리, 재구성
(FR9·10·11·13·22, NFR3·5·6, AD-8·13).

- `run(conn, *, rebuild=False) -> Summary`: 열린 쓰기 연결을 받아 작업 집합을 처리한다. 락·마이그레이션은
  호출자(`cli`의 `store.write_session`, `collect.run`)가 맡고 여기서는 하지 않는다. `raw_response`에는 쓰지 않는다.
- 재구성과 버전: `rebuild`이거나 `meta.normalize_version`(`NORMALIZE_VERSION_KEY`)이 `str(NORMALIZE_VERSION)`과
  다르면(행이 없음 포함) 전체 재구성이다. `store.transaction` 하나 안에서 파생 테이블(`_DERIVED_TABLES`:
  `_TARGETS`의 대상 테이블, `NORMALIZERS`의 샘플·세트 테이블)과 `normalize_result`를 모두
  `DELETE`하고, 아래 증분과 같은 루프로 등록된 원문 전부를 다시 정규화한 뒤(결과 행이 비었으므로 전부 작업
  집합이다) `meta.normalize_version`을 upsert한다. 항목·실패 기록은 각각 `store.savepoint`라 항목
  실패 격리는 증분과 같다. `sqlite3.Error`면 바깥 트랜잭션 전체가 롤백돼 파생 테이블·`normalize_result`·
  `meta`가 모두 이전 그대로다. WAL이라 읽는 쪽은 커밋 전까지 이전 행을 본다. 1차 테이블(`auth_event`·
  `raw_response`·`run`·`fetch_error`·`notification`)과 `meta`의 다른 키는 건드리지 않는다. 재구성하면 INFO 로그
  한 줄(사유 `flag`/`version`, 저장 값, 코드 값)을 남긴다. 증분은 `meta`를 건드리지 않는다.
- `NORMALIZE_VERSION`·`NORMALIZE_VERSION_KEY`는 `store`가 정의하고(올리는 규칙도 `store.NORMALIZE_VERSION`
  docstring에 있다) 여기서는 같은 이름으로 다시 내보낸다. 버전을 올리면 다음 쓰기 명령(`normalize`·`collect`)이
  한 번 전체 재구성한다.
- 대상 테이블: scope마다 코드 상수(`_TARGETS`)다. scope `day` → `daily_metric`(키 열 `day_key`), scope
  `activity` → `activity`(키 열 `activity_id`, integer). 샘플 테이블의 키 열도 scope를 따른다.
- 작업 집합: (scope, endpoint)가 등록된 쌍(`NORMALIZERS`, 지금은 scope `day`의 10종과 scope `activity`의
  `activity`·`activity_hr_in_timezones`·`activity_details`·`activity_exercise_sets` 4종, 모두 14종)인
  원문 중 `normalize_result` 행이 없거나 그 `raw_fetched_at`이 원문 `fetched_at`과 다른 것이다. 키·`fetched_at`만 먼저 고르고
  `ORDER BY scope, key, endpoint`로 처리한다. 원문(`raw`)은 그 항목의 트랜잭션 안에서 읽는다. 등록되지 않은
  원문(`activities_by_date` 등)에는 결과 행을 쓰지 않으므로 endpoint를 더하면 그 원문이 자동으로 작업 집합이 된다.
- 항목 하나 = `store.transaction` 하나(재구성에서는 `store.savepoint` 하나). 성공하면 그 endpoint가
  소유한 대상 테이블 열만 새 값으로 바꾸고(행이 없으면 만든다) `normalize_result`를 `ok=1`로 기록한다.
  원문이 `'null'`(NoData)이면 행을 만들지 않고 있는 행의 그 열만 NULL로 한다. activity 항목의 key는 정규형 십진수 activityId(0 이상,
  SQLite INTEGER 범위)여야 하고, 아니면 아무것도 쓰지 않고 `parse_error`다.
- 활동 일 키: 이번 실행에 activity 항목이 있으면 저장된 모든 `activities_by_date` 원문(scope `day`, key
  오름차순)을 한 번 `rawparse.activity_refs`로 읽어 `{activityId: 일 키}`를 만든다(같은 id는 처음 것, 형식이
  틀린 목록은 WARNING(key만)을 남기고 건너뛴다. `coverage._activity_refs`와 같은 규칙). 성공 항목이
  `activity` 행을 만들거나 고칠 때마다 `day_key`를 그 값(어느 목록에도 없으면 NULL)으로 쓴다. null 원문·실패
  경로는 `day_key`를 건드리지 않는다.
- 키별 행 테이블(`Normalizer.sample_table`, `SampleTable(table, columns, parse)`, 지금은 `body_battery` →
  `body_battery_sample`, `stress_data` → `stress_bb_sample`, `heart_rates` → `hr_sample`, `activity_details` → `activity_hr_sample`,
  `activity_exercise_sets` → `exercise_set`): 같은 항목 트랜잭션에서 그 키의 행을 모두 지우고, 성공이면 새
  행을 넣는다(null 원문·실패면 지우기만 한다). 그래서 한 활동의 세트도 트랜잭션 하나로 통째 교체되고, 샘플과
  세트도 현재 원문만으로 다시 만든 결과와 같다. 열은 키 열 + `columns`(시계열 샘플은 `ts_ms`와 값 열 하나,
  활동 샘플은 `ts_ms`·`bpm`·운동 중 Body Battery `body_battery` 셋, 세트는
  `activity.EXERCISE_SET_COLUMNS`)다. 소유 열이 없는 endpoint(`heart_rates`·`activity_details`·
  `activity_exercise_sets`)는 대상 테이블 행을 만들지도 바꾸지도 않는다.
- 실패 격리: 파싱 오류(`NormalizeParseError` → `parse_error`)나 그 밖의 예외(`internal`)는 그 항목을
  롤백한 뒤 새 트랜잭션에서 그 endpoint 열을 NULL로 비우고(샘플·세트 테이블이 있으면 그 키의 행도 지우고)
  `ok=0`과 `error_code`를 기록하고 다음 항목으로 넘어간다. 그래서 대상 테이블의 열 값과 샘플은 언제나
  현재 원문만으로 다시 만든 결과와 같다. 예외는 `activity.day_key`다: 작업 집합 밖의 `activities_by_date`
  원문에 기대고 activity-scope 항목이 행을 쓸 때만 갱신되므로, 목록만 바뀌면 그 행을 다시 쓸 때까지 이전
  값으로 남는다. 재구성(`--rebuild`나 버전 변경)하면 바로잡힌다. 행이 있는지는 뜻이 없다(실패·null
  원문 뒤에도, 빈 준비도처럼 값이 모두 NULL이어도 행이 남거나 생긴다). 읽는 쪽은 열의 NULL 여부로 판단한다. `sqlite3.Error`는 항목
  문제가 아니라 환경 문제라 그대로 전파한다.

로그(WARNING)에는 scope·key·endpoint·error_code만 남긴다. 원문 내용과 예외 메시지는 남기지 않는다.
시각은 `dates.now_ms()`다.

import해도 되는 것은 stdlib과 `garmin_pipeline`의 `config`·`dates`·`digest`·`errors`·`rawparse`·`store`, 자기 하위다
(지금은 `dates`·`rawparse`·`store`·`normalize.daily`·`normalize.activity`만 쓴다). `garmin`(어댑터)·`cli`·`auth`·
`coverage`·`collect`·`ports`·`schedule`·`capture`는 import하지 않는다(계약 `normalize-imports-no-upper-modules`).
collect → normalize는 허용한다.
"""

import contextlib
import importlib.resources
import json
import logging
import sqlite3
from collections.abc import Callable, Mapping
from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import NamedTuple
from zoneinfo import ZoneInfo

from garmin_pipeline import dates, digest, rawparse, store
from garmin_pipeline.normalize import activity, daily
from garmin_pipeline.normalize.daily import NormalizeParseError

__all__ = [
    "NORMALIZERS",
    "NORMALIZE_VERSION",
    "NORMALIZE_VERSION_KEY",
    "NormalizeErrorCode",
    "NormalizeParseError",
    "Normalizer",
    "SampleTable",
    "Summary",
    "run",
]

_DAY = "day"
_ACTIVITY = "activity"
_ACTIVITY_LIST = "activities_by_date"
_NULL = "null"
_SQLITE_INTEGER_LIMIT = 2**63
"""SQLite INTEGER(부호 있는 64비트)에 담기는 activityId의 상한(미만)."""
_RESULT_TABLE = "normalize_result"

NORMALIZE_VERSION = store.NORMALIZE_VERSION
"""정규화 규칙의 버전. 정의와 올리는 규칙은 `store.NORMALIZE_VERSION`에 있고 여기서는 다시 내보낸다."""
NORMALIZE_VERSION_KEY = store.NORMALIZE_VERSION_KEY
"""`meta`에서 정규화 버전을 담는 key(`store.NORMALIZE_VERSION_KEY`를 다시 내보낸다)."""

logger = logging.getLogger(__name__)


class NormalizeErrorCode(StrEnum):
    """`normalize_result.error_code`: 정규화에 실패한 항목의 사유."""

    PARSE_ERROR = "parse_error"
    INTERNAL = "internal"


class Summary(NamedTuple):
    """`run` 결과. `processed`는 처리한 작업 항목 수(실패 포함), `failed`는 그중 실패한 수다."""

    processed: int
    failed: int


class SampleTable(NamedTuple):
    """키별 행 테이블(`(<scope 키 열>, *columns)` 열)과 그 행 파서. 테이블·열 이름은 코드 상수다.

    `columns`는 키 열을 뺀 열 이름이고 파서가 돌려주는 행(`daily.Sample`)이 이 순서다.
    """

    table: str
    columns: tuple[str, ...]
    parse: daily.SampleParser


class Normalizer(NamedTuple):
    """endpoint 하나의 정규화 규칙: 소유한 대상 테이블 열, 원문 파서, 선택한 샘플 테이블, scope."""

    columns: tuple[str, ...]
    parse: daily.Parser
    sample_table: SampleTable | None = None
    scope: str = _DAY


class _Target(NamedTuple):
    """scope 하나의 대상 테이블과 키 열. 샘플 테이블도 같은 키 열을 쓴다."""

    table: str
    key_column: str


_TARGETS: dict[str, _Target] = {
    _DAY: _Target("daily_metric", "day_key"),
    _ACTIVITY: _Target("activity", "activity_id"),
}
"""scope → 대상 테이블. 이름은 코드 상수라 f-string SQL에 주입 위험이 없다."""


NORMALIZERS: dict[str, Normalizer] = {
    "daily_weigh_ins": Normalizer((), daily.measurement_only),
    "lifestyle_logging_data": Normalizer((), daily.measurement_only),
    "user_summary": Normalizer(daily.USER_SUMMARY_COLUMNS, daily.user_summary),
    "rhr_day": Normalizer(daily.RHR_DAY_COLUMNS, daily.rhr_day),
    "hrv_data": Normalizer(daily.HRV_DATA_COLUMNS, daily.hrv_data),
    "training_readiness": Normalizer(
        daily.TRAINING_READINESS_COLUMNS, daily.training_readiness
    ),
    "sleep_data": Normalizer(daily.SLEEP_DATA_COLUMNS, daily.sleep_data),
    "stress_data": Normalizer(
        daily.STRESS_DATA_COLUMNS,
        daily.stress_data,
        SampleTable(
            "stress_bb_sample", ("ts_ms", "level"), daily.stress_body_battery_samples
        ),
    ),
    "body_battery": Normalizer(
        daily.BODY_BATTERY_COLUMNS,
        daily.body_battery,
        SampleTable(
            "body_battery_sample", ("ts_ms", "level"), daily.body_battery_samples
        ),
    ),
    "heart_rates": Normalizer(
        daily.HEART_RATES_COLUMNS,
        daily.heart_rates,
        SampleTable("hr_sample", ("ts_ms", "bpm"), daily.heart_rate_samples),
    ),
    "activity": Normalizer(
        activity.ACTIVITY_COLUMNS, activity.activity, scope=_ACTIVITY
    ),
    "activity_hr_in_timezones": Normalizer(
        activity.ACTIVITY_HR_IN_TIMEZONES_COLUMNS,
        activity.activity_hr_in_timezones,
        scope=_ACTIVITY,
    ),
    "activity_details": Normalizer(
        activity.ACTIVITY_DETAILS_COLUMNS,
        activity.activity_details,
        SampleTable(
            "activity_hr_sample",
            ("ts_ms", "bpm", "body_battery"),
            activity.activity_hr_samples,
        ),
        scope=_ACTIVITY,
    ),
    "activity_exercise_sets": Normalizer(
        activity.ACTIVITY_EXERCISE_SETS_COLUMNS,
        activity.activity_exercise_sets,
        SampleTable(
            "exercise_set", activity.EXERCISE_SET_COLUMNS, activity.exercise_set_rows
        ),
        scope=_ACTIVITY,
    ),
}
"""endpoint 이름 → 정규화 규칙(scope 포함). 여기 없는 (scope, endpoint)의 원문은 작업 집합에 들지 않는다."""


type _Key = str | int
"""대상 테이블의 키 값: scope `day`는 일 키 문자열, scope `activity`는 activityId 정수."""


class _Item(NamedTuple):
    scope: str
    key: str
    endpoint: str
    fetched_at: int


_DERIVED_TABLES: tuple[str, ...] = tuple(
    sorted(
        {
            *(target.table for target in _TARGETS.values()),
            *(
                rule.sample_table.table
                for rule in NORMALIZERS.values()
                if rule.sample_table
            ),
            _RESULT_TABLE,
            "day_summary",
            "workout",
            "exercise_log",
        }
    )
)
"""재구성이 비우는 테이블: 대상·샘플·세트 테이블과 `normalize_result`. 모두 코드 상수에서 유도한다."""

type _Unit = Callable[[sqlite3.Connection], contextlib.AbstractContextManager[object]]
"""한 단위(항목·실패 기록)를 묶는 context manager. 증분은 `store.transaction`, 재구성은 `store.savepoint`."""


def run(
    conn: sqlite3.Connection, *, rebuild: bool = False, timezone: str = "Asia/Seoul"
) -> Summary:
    """작업 집합의 항목을 하나씩 정규화한다. 항목 실패는 기록하고 넘어간다.

    `rebuild`이거나 `meta.normalize_version`이 `str(NORMALIZE_VERSION)`과 다르면(없음 포함) 트랜잭션 하나에서
    파생 테이블과 `normalize_result`를 비우고 전부 다시 정규화한 뒤 버전을 기록한다.
    `conn`은 쓰기 세션의 autocommit 연결이고 열린 트랜잭션이 없어야 한다.
    """
    stored = _stored_version(conn)
    if rebuild:
        reason = "flag"
    elif stored != str(NORMALIZE_VERSION):
        reason = "version"
    else:
        return _process(conn, store.transaction, timezone=timezone)
    logger.info(
        "normalize 재구성: reason=%s stored=%s code=%s",
        reason,
        stored,
        NORMALIZE_VERSION,
    )
    with store.transaction(conn):
        for table in _DERIVED_TABLES:
            conn.execute(f"DELETE FROM {table}")
        summary = _process(conn, store.savepoint, timezone=timezone, rebuild=True)
        conn.execute(
            "INSERT INTO meta (key, value) VALUES (?, ?)"
            " ON CONFLICT (key) DO UPDATE SET value = excluded.value",
            (NORMALIZE_VERSION_KEY, str(NORMALIZE_VERSION)),
        )
    return summary


def _stored_version(conn: sqlite3.Connection) -> str | None:
    """`meta.normalize_version` 값(없으면 `None`)."""
    row = conn.execute(
        "SELECT value FROM meta WHERE key = ?", (NORMALIZE_VERSION_KEY,)
    ).fetchone()
    return None if row is None else row[0]


def _process(
    conn: sqlite3.Connection, unit: _Unit, *, timezone: str, rebuild: bool = False
) -> Summary:
    """작업 집합을 처리한다. 항목·실패 기록은 각각 `unit(conn)` 하나다."""
    processed = failed = 0
    items = _work_set(conn)
    previous_dates = {
        row[0]
        for item in items
        if item.scope == _ACTIVITY
        for row in conn.execute(
            "SELECT date FROM workout WHERE activity_id=?", (item.key,)
        )
    }
    day_keys: Mapping[int, str] = (
        _activity_day_keys(conn)
        if any(item.scope == _ACTIVITY for item in items)
        else {}
    )
    for item in items:
        normalizer = NORMALIZERS[item.endpoint]
        try:
            with unit(conn):
                _normalize_item(conn, item, normalizer, day_keys)
        except sqlite3.Error:
            raise
        except NormalizeParseError:
            code = NormalizeErrorCode.PARSE_ERROR
        except Exception:  # noqa: BLE001 - 항목 하나의 예상 밖 실패를 격리한다(AD-13)
            code = NormalizeErrorCode.INTERNAL
        else:
            processed += 1
            continue
        with unit(conn):
            key = _target_key(item)
            if key is not None:
                target = _TARGETS[item.scope]
                _write_columns(conn, target, key, normalizer.columns, None)
                _replace_samples(conn, target, key, normalizer.sample_table, [])
            _record(conn, item, ok=False, error_code=code)
        logger.warning(
            "정규화 실패: scope=%s key=%s endpoint=%s error_code=%s",
            item.scope,
            item.key,
            item.endpoint,
            code,
        )
        processed += 1
        failed += 1
    _refresh_days(conn, items, unit, timezone, rebuild, previous_dates)
    logger.info("normalize 끝: processed=%d failed=%d", processed, failed)
    return Summary(processed, failed)


def _work_set(conn: sqlite3.Connection) -> list[_Item]:
    """정규화할 원문의 (scope, key, endpoint, fetched_at). 원문 내용은 읽지 않는다."""
    pairs = sorted((rule.scope, endpoint) for endpoint, rule in NORMALIZERS.items())
    registered = " OR ".join("(r.scope = ? AND r.endpoint = ?)" for _ in pairs)
    rows = conn.execute(
        "SELECT r.scope, r.key, r.endpoint, r.fetched_at"
        " FROM raw_response AS r"
        " LEFT JOIN normalize_result AS n"
        " ON n.scope = r.scope AND n.key = r.key AND n.endpoint = r.endpoint"
        f" WHERE ({registered})"
        " AND (n.scope IS NULL OR n.raw_fetched_at != r.fetched_at)"
        " ORDER BY r.scope, r.key, r.endpoint",
        [value for pair in pairs for value in pair],
    ).fetchall()
    return [_Item(*row) for row in rows]


def _activity_day_keys(conn: sqlite3.Connection) -> dict[int, str]:
    """저장된 모든 활동 목록의 `{activityId: 일 키}`(목록 key 오름차순, 같은 id는 처음 것).

    형식이 틀린 목록은 WARNING(key만)을 남기고 건너뛴다. `coverage._activity_refs`와 같은 규칙이다.
    """
    rows = conn.execute(
        "SELECT key, raw FROM raw_response WHERE scope = ? AND endpoint = ? ORDER BY key",
        (_DAY, _ACTIVITY_LIST),
    ).fetchall()
    day_keys: dict[int, str] = {}
    for key, raw in rows:
        try:
            refs = rawparse.activity_refs(raw)
        except rawparse.RawParseError:
            refs = None
        if refs is None:
            logger.warning("활동 목록 원문 형식 오류: key=%s", key)
            continue
        for ref in refs:
            day_keys.setdefault(ref.activity_id, ref.day_key)
    return day_keys


def _target_key(item: _Item) -> _Key | None:
    """대상 테이블의 키 값. activity key가 정규형 십진수 activityId가 아니면 `None`이다."""
    if item.scope != _ACTIVITY:
        return item.key
    key = item.key
    if not (key.isascii() and key.isdecimal()) or str(int(key)) != key:
        return None
    activity_id = int(key)
    return activity_id if activity_id < _SQLITE_INTEGER_LIMIT else None


def _normalize_item(
    conn: sqlite3.Connection,
    item: _Item,
    normalizer: Normalizer,
    day_keys: Mapping[int, str],
) -> None:
    """트랜잭션 안: 원문을 읽어 파싱하고 그 endpoint 열·샘플과 결과 행을 쓴다."""
    key = _target_key(item)
    if key is None:
        raise NormalizeParseError(f"{item.endpoint}: key가 십진수 activityId가 아니다")
    target = _TARGETS[item.scope]
    (raw,) = conn.execute(
        "SELECT raw FROM raw_response WHERE scope = ? AND key = ? AND endpoint = ?",
        (item.scope, item.key, item.endpoint),
    ).fetchone()
    sample_table = normalizer.sample_table
    if raw == _NULL:
        _write_columns(conn, target, key, normalizer.columns, None)
        _replace_samples(conn, target, key, sample_table, [])
    else:
        values = normalizer.parse(raw, item.key)
        if set(values) != set(normalizer.columns):
            raise RuntimeError(f"{item.endpoint} 파서가 소유 열과 다른 열을 돌려줬다")
        samples = [] if sample_table is None else sample_table.parse(raw, item.key)
        if normalizer.columns:
            _create_row(conn, key, day_keys)
        _write_columns(conn, target, key, normalizer.columns, values)
        _replace_samples(conn, target, key, sample_table, samples)
    _record(conn, item, ok=True, error_code=None)


def _create_row(
    conn: sqlite3.Connection, key: _Key, day_keys: Mapping[int, str]
) -> None:
    """대상 테이블 행이 없으면 만든다. `activity`는 있어도 `day_key`를 목록 값(없으면 NULL)으로 고친다.

    `_target_key`가 scope `activity`에만 int(activityId)를 돌려주므로 키 타입으로 테이블을 고른다.
    """
    if isinstance(key, int):
        conn.execute(
            "INSERT INTO activity (activity_id, day_key) VALUES (?, ?)"
            " ON CONFLICT (activity_id) DO UPDATE SET day_key = excluded.day_key",
            (key, day_keys.get(key)),
        )
    else:
        conn.execute(
            "INSERT INTO daily_metric (day_key) VALUES (?) ON CONFLICT DO NOTHING",
            (key,),
        )


def _write_columns(
    conn: sqlite3.Connection,
    target: _Target,
    key: _Key,
    columns: tuple[str, ...],
    values: dict[str, daily.Value] | None,
) -> None:
    """대상 테이블에서 키 행의 `columns`만 `values`(None이면 모두 NULL)로 바꾼다. 행은 만들지 않는다.

    `columns`가 비어 있으면 아무것도 하지 않는다.
    테이블·열 이름은 `_TARGETS`·`NORMALIZERS`의 코드 상수에서만 오므로 f-string SQL에 주입 위험이 없다.
    """
    if not columns:
        return
    assignments = ", ".join(f"{column} = ?" for column in columns)
    params = [None if values is None else values[column] for column in columns]
    conn.execute(
        f"UPDATE {target.table} SET {assignments} WHERE {target.key_column} = ?",
        (*params, key),
    )


def _replace_samples(
    conn: sqlite3.Connection,
    target: _Target,
    key: _Key,
    sample_table: SampleTable | None,
    samples: list[daily.Sample],
) -> None:
    """`sample_table`가 있으면 그 테이블의 키 행을 모두 지우고 `samples`(행마다 `sample_table.columns` 순서)로 바꾼다.

    행 길이가 `sample_table.columns`와 다르면 파서 결함이라 `RuntimeError`(항목 실패 `internal`)다.
    테이블·열 이름은 `_TARGETS`·`NORMALIZERS`의 코드 상수에서만 오므로 f-string SQL에 주입 위험이 없다.
    """
    if sample_table is None:
        return
    if any(len(sample) != len(sample_table.columns) for sample in samples):
        raise RuntimeError(f"{sample_table.table} 파서가 열 수와 다른 행을 돌려줬다")
    columns = (target.key_column, *sample_table.columns)
    conn.execute(
        f"DELETE FROM {sample_table.table} WHERE {target.key_column} = ?", (key,)
    )
    conn.executemany(
        f"INSERT INTO {sample_table.table} ({', '.join(columns)})"
        f" VALUES ({', '.join('?' for _ in columns)})",
        [(key, *sample) for sample in samples],
    )


def _record(
    conn: sqlite3.Connection,
    item: _Item,
    *,
    ok: bool,
    error_code: NormalizeErrorCode | None,
) -> None:
    conn.execute(
        "INSERT INTO normalize_result"
        " (scope, key, endpoint, ok, error_code, raw_fetched_at, normalized_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)"
        " ON CONFLICT (scope, key, endpoint) DO UPDATE SET"
        " ok = excluded.ok, error_code = excluded.error_code,"
        " raw_fetched_at = excluded.raw_fetched_at, normalized_at = excluded.normalized_at",
        (
            item.scope,
            item.key,
            item.endpoint,
            int(ok),
            None if error_code is None else error_code.value,
            item.fetched_at,
            dates.now_ms(),
        ),
    )


def _refresh_days(conn, items, unit, timezone, rebuild, previous_dates):
    """Replace each affected date atomically, isolating non-SQL calculation failures."""
    pending_row = conn.execute(
        "SELECT value FROM meta WHERE key='day_values_pending'"
    ).fetchone()
    pending = set(json.loads(pending_row[0])) if pending_row else set()
    zone = ZoneInfo(timezone)
    activity_days = {}
    for activity_id, start_ms in conn.execute(
        "SELECT activity_id, start_ms FROM activity WHERE start_ms IS NOT NULL"
    ):
        activity_days[str(activity_id)] = (
            datetime.fromtimestamp(start_ms / 1000, zone).date().isoformat()
        )
    affected = {i.key if i.scope == "day" else activity_days.get(i.key) for i in items}
    affected.update(previous_dates)
    if rebuild:
        affected = set()
        first, last = conn.execute(
            "SELECT MIN(key), MAX(key) FROM raw_response WHERE scope='day'"
        ).fetchone()
        history = conn.execute(
            "SELECT value FROM meta WHERE key='history_start'"
        ).fetchone()
        if first and last:
            cursor = date.fromisoformat(history[0] if history else first)
            while cursor.isoformat() <= last:
                affected.add(cursor.isoformat())
                cursor += timedelta(days=1)
    affected.update(pending)
    labels = json.loads(
        (
            importlib.resources.files("garmin_pipeline")
            / "labels"
            / "exercise_types_ko.json"
        ).read_text(encoding="utf-8")
    )
    for key in sorted(k for k in affected if k is not None):
        try:
            with unit(conn):
                day_raw = {
                    endpoint: json.loads(raw)
                    for endpoint, raw in conn.execute(
                        "SELECT endpoint,raw FROM raw_response WHERE scope='day' AND key=?",
                        (key,),
                    )
                }
                activities = {}
                for activity_id, activity_day in activity_days.items():
                    if activity_day == key:
                        activities[activity_id] = {
                            endpoint: json.loads(raw)
                            for endpoint, raw in conn.execute(
                                "SELECT endpoint,raw FROM raw_response WHERE scope='activity' AND key=?",
                                (activity_id,),
                            )
                        }
                conn.execute(
                    "DELETE FROM exercise_log WHERE activity_id IN (SELECT activity_id FROM workout WHERE date=?)",
                    (key,),
                )
                conn.execute("DELETE FROM workout WHERE date=?", (key,))
                conn.execute("DELETE FROM day_summary WHERE date=?", (key,))
                if not day_raw and not activities:
                    pending.discard(key)
                    _write_pending_days(conn, pending)
                    continue
                values = digest.day_values(key, day_raw, activities, labels, timezone)
                # An incoming activity may still belong to another stored date.
                # Remove both tables by ID in this same date transaction so an
                # insertion failure restores its previous workout and exercises.
                incoming = [(row["activity_id"],) for row in values["workouts"]]
                conn.executemany(
                    "DELETE FROM exercise_log WHERE activity_id=?", incoming
                )
                conn.executemany("DELETE FROM workout WHERE activity_id=?", incoming)
                for table, rows in (
                    ("day_summary", [values["day_summary"]]),
                    ("workout", values["workouts"]),
                    ("exercise_log", values["exercise_logs"]),
                ):
                    for row in rows:
                        columns = ",".join(row)
                        conn.execute(
                            f"INSERT INTO {table} ({columns}) VALUES ({','.join('?' for _ in row)})",
                            tuple(row.values()),
                        )
                pending.discard(key)
                _write_pending_days(conn, pending)
        except sqlite3.Error:
            raise
        except Exception:  # noqa: BLE001 - isolate a date without exposing health data
            with unit(conn):
                pending.add(key)
                _write_pending_days(conn, pending)
            logger.warning("day values failed: date=%s", key)


def _write_pending_days(conn, pending):
    """Keep failed date refreshes eligible even when their source items are current."""
    if pending:
        conn.execute(
            "INSERT INTO meta(key,value) VALUES ('day_values_pending',?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (json.dumps(sorted(pending)),),
        )
    else:
        conn.execute("DELETE FROM meta WHERE key='day_values_pending'")
