"""Normalize immutable raw responses into account-scoped Garmin projections.

Rebuild computes in session-local staging and publishes all projections atomically.
Incremental item commits durably record the dates requiring projection refresh.
"""

import contextlib
import importlib.resources
import json
import logging
import re
import psycopg
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

type _Unit = Callable[[store.Connection], contextlib.AbstractContextManager[object]]
"""한 항목 또는 실패 기록의 원자적 단위."""


def run(
    conn: store.Connection, *, rebuild: bool = False, timezone: str = "Asia/Seoul"
) -> Summary:
    """작업 집합의 항목을 하나씩 정규화한다. 항목 실패는 기록하고 넘어간다.

    `rebuild`이거나 `meta.normalize_version`이 `str(NORMALIZE_VERSION)`과 다르면(없음 포함) 임시 staging에서 다시 정규화하고 성공한 결과와 버전을 단일 트랜잭션으로 교체한다.
    `conn`은 쓰기 세션의 autocommit 연결이고 열린 트랜잭션이 없어야 한다.
    """
    with store.transaction(conn):
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
    return _rebuild(conn, timezone)


# Only normalize-owned tables are mapped; all raw reads remain on the real schema.
_STAGE_TABLES = (*_DERIVED_TABLES, "exercise_log_order", "meta")
_STAGE_PATTERN = re.compile(r"\bgarmin\.(" + "|".join(sorted(_STAGE_TABLES, key=len, reverse=True)) + r")\b")


class _StageConnection(store.Connection):
    def __init__(self, conn):
        super().__init__(store._driver(conn), conn.account, readonly=False)

    @staticmethod
    def _stage_sql(sql):
        return _STAGE_PATTERN.sub(lambda match: "pg_temp.normalize_stage_" + match.group(1), sql)

    def execute(self, query, params=None, **kwargs):
        return super().execute(self._stage_sql(query), params, **kwargs)

    def executemany(self, query, params):
        return super().executemany(self._stage_sql(query), params)


def _rebuild(conn, timezone):
    account = (conn.user_id, conn.connection_id)
    with store.transaction(conn):
        existing = conn.execute("SELECT value FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='day_values_pending'", account).fetchone()
        durable_pending = set(json.loads(existing[0])) if existing else set()
        for table in ('exercise_log_order', *_DERIVED_TABLES, 'meta'):
            conn.execute(f"DROP TABLE IF EXISTS pg_temp.normalize_stage_{table}")
        for table in _STAGE_TABLES:
            conn.execute(f"CREATE TEMP TABLE normalize_stage_{table} (LIKE garmin.{table} INCLUDING DEFAULTS INCLUDING CONSTRAINTS INCLUDING INDEXES) ON COMMIT PRESERVE ROWS")
        conn.execute("ALTER TABLE pg_temp.normalize_stage_exercise_log_order ADD FOREIGN KEY (user_id,connection_id,activity_id,exercise) REFERENCES pg_temp.normalize_stage_exercise_log (user_id,connection_id,activity_id,exercise) ON DELETE CASCADE")
        conn.execute("INSERT INTO pg_temp.normalize_stage_meta SELECT * FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key <> 'day_values_pending'", account)
    staged = _StageConnection(conn)
    summary = _process(staged, store.transaction, timezone=timezone, rebuild=True, durable_pending=durable_pending)
    with store.transaction(staged):
        pending = staged.execute("SELECT value FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='day_values_pending'", account).fetchone()
        if pending: raise store.StoreError('rebuild projection incomplete')
    _before_rebuild_publish(conn, staged)
    # A single fenced transaction publishes only completed staged rows. On timeout
    # or process death PostgreSQL rolls every deletion and insertion back together.
    with store.transaction(conn):
        for table in ('exercise_log_order', *_DERIVED_TABLES):
            conn.execute(f"DELETE FROM garmin.{table} WHERE user_id=%s AND connection_id=%s", account)
        for table in (*_DERIVED_TABLES, 'exercise_log_order'):
            conn.execute(f"INSERT INTO garmin.{table} SELECT * FROM pg_temp.normalize_stage_{table} WHERE user_id=%s AND connection_id=%s", account)
        conn.execute("DELETE FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='day_values_pending'", account)
        conn.execute("INSERT INTO garmin.meta (user_id,connection_id,key,value) VALUES (%s,%s,%s,%s) ON CONFLICT (user_id,connection_id,key) DO UPDATE SET value=excluded.value", (*account,NORMALIZE_VERSION_KEY,str(NORMALIZE_VERSION)))
    return summary


def _before_rebuild_publish(conn, staged):
    """Narrow crash-observation seam; no database access in production."""


def _after_item_commit(item):
    """Narrow crash-observation seam; pending has already committed."""


def _stored_version(conn: store.Connection) -> str | None:
    """`meta.normalize_version` 값(없으면 `None`)."""
    row = conn.execute(
        "SELECT value FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key = %s", (conn.user_id, conn.connection_id, NORMALIZE_VERSION_KEY,)
    ).fetchone()
    return None if row is None else row[0]


def _process(
    conn: store.Connection, unit: _Unit, *, timezone: str, rebuild: bool = False, durable_pending: set[str] | None = None
) -> Summary:
    """작업 집합을 처리한다. 항목·실패 기록은 각각 `unit(conn)` 하나다."""
    processed = failed = 0
    with store.transaction(conn):
        items = _work_set(conn)
        previous_dates = {
            row[0]
            for item in items if item.scope == _ACTIVITY and _target_key(item) is not None
            for row in conn.execute(
                "SELECT date FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND activity_id=%s",
                (conn.user_id, conn.connection_id, int(item.key)),
            )
        }
        day_keys: Mapping[int, str] = (
            _activity_day_keys(conn) if any(item.scope == _ACTIVITY for item in items) else {}
        )
    for item in items:
        normalizer = NORMALIZERS[item.endpoint]
        try:
            with unit(conn):
                before = _item_days(conn, item, day_keys, timezone)
                _normalize_item(conn, item, normalizer, day_keys)
                _mark_pending(conn, before | _item_days(conn, item, day_keys, timezone))
        except (psycopg.Error, store.StoreError):
            raise
        except NormalizeParseError:
            code = NormalizeErrorCode.PARSE_ERROR
        except Exception:  # noqa: BLE001 - 항목 하나의 예상 밖 실패를 격리한다(AD-13)
            code = NormalizeErrorCode.INTERNAL
        else:
            _after_item_commit(item)
            processed += 1
            continue
        with unit(conn):
            before = _item_days(conn, item, day_keys, timezone)
            key = _target_key(item)
            if key is not None:
                target = _TARGETS[item.scope]
                _write_columns(conn, target, key, normalizer.columns, None)
                _replace_samples(conn, target, key, normalizer.sample_table, [])
            _record(conn, item, ok=False, error_code=code)
            _mark_pending(conn, before | _item_days(conn, item, day_keys, timezone))
        _after_item_commit(item)
        logger.warning(
            "정규화 실패: scope=%s key=%s endpoint=%s error_code=%s",
            item.scope,
            item.key,
            item.endpoint,
            code,
        )
        processed += 1
        failed += 1
    _refresh_days(conn, items, unit, timezone, rebuild, previous_dates, durable_pending)
    logger.info("normalize 끝: processed=%d failed=%d", processed, failed)
    return Summary(processed, failed)


def _work_set(conn: store.Connection) -> list[_Item]:
    """정규화할 원문의 (scope, key, endpoint, fetched_at). 원문 내용은 읽지 않는다."""
    pairs = sorted((rule.scope, endpoint) for endpoint, rule in NORMALIZERS.items())
    registered = " OR ".join("(r.scope = %s AND r.endpoint = %s)" for _ in pairs)
    rows = conn.execute(
        "SELECT r.scope, r.key, r.endpoint, r.fetched_at"
        " FROM garmin.raw_current AS r"
        " LEFT JOIN garmin.normalize_result AS n"
        " ON n.user_id=r.user_id AND n.connection_id=r.connection_id AND n.scope = r.scope AND n.key = r.key AND n.endpoint = r.endpoint"
        f" WHERE r.user_id=%s AND r.connection_id=%s AND ({registered})"
        " AND (n.scope IS NULL OR n.raw_fetched_at != r.fetched_at)"
        " ORDER BY r.scope COLLATE \"C\", r.key COLLATE \"C\", r.endpoint COLLATE \"C\"",
        [conn.user_id, conn.connection_id, *(value for pair in pairs for value in pair)],
    ).fetchall()
    return [_Item(*row) for row in rows]


def _activity_day_keys(conn: store.Connection) -> dict[int, str]:
    """저장된 모든 활동 목록의 `{activityId: 일 키}`(목록 key 오름차순, 같은 id는 처음 것).

    형식이 틀린 목록은 WARNING(key만)을 남기고 건너뛴다. `coverage._activity_refs`와 같은 규칙이다.
    """
    rows = conn.execute(
        "SELECT key, raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope = %s AND endpoint = %s ORDER BY key COLLATE \"C\"",
        (conn.user_id, conn.connection_id, _DAY, _ACTIVITY_LIST),
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
    conn: store.Connection,
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
        "SELECT raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope = %s AND key = %s AND endpoint = %s",
        (conn.user_id, conn.connection_id, item.scope, item.key, item.endpoint),
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
    conn: store.Connection, key: _Key, day_keys: Mapping[int, str]
) -> None:
    """대상 테이블 행이 없으면 만든다. `activity`는 있어도 `day_key`를 목록 값(없으면 NULL)으로 고친다.

    `_target_key`가 scope `activity`에만 int(activityId)를 돌려주므로 키 타입으로 테이블을 고른다.
    """
    if isinstance(key, int):
        conn.execute(
            "INSERT INTO garmin.activity (user_id, connection_id, activity_id, day_key) VALUES (%s, %s, %s, %s)"
            " ON CONFLICT (user_id, connection_id, activity_id) DO UPDATE SET day_key = excluded.day_key",
            (conn.user_id, conn.connection_id, key, day_keys.get(key)),
        )
    else:
        conn.execute(
            "INSERT INTO garmin.daily_metric (user_id, connection_id, day_key) VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (conn.user_id, conn.connection_id, key),
        )


def _write_columns(
    conn: store.Connection,
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
    assignments = ", ".join(f"{column} = %s" for column in columns)
    params = [None if values is None else values[column] for column in columns]
    conn.execute(
        f"UPDATE garmin.{target.table} SET {assignments} WHERE user_id=%s AND connection_id=%s AND {target.key_column} = %s",
        (*params, conn.user_id, conn.connection_id, key),
    )


def _replace_samples(
    conn: store.Connection,
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
    columns = ("user_id", "connection_id", target.key_column, *sample_table.columns)
    conn.execute(
        f"DELETE FROM garmin.{sample_table.table} WHERE user_id=%s AND connection_id=%s AND {target.key_column} = %s", (conn.user_id, conn.connection_id, key,)
    )
    conn.executemany(
        f"INSERT INTO garmin.{sample_table.table} ({', '.join(columns)})"
        f" VALUES ({', '.join('%s' for _ in columns)})",
        [(conn.user_id, conn.connection_id, key, *sample) for sample in samples],
    )


def _record(
    conn: store.Connection,
    item: _Item,
    *,
    ok: bool,
    error_code: NormalizeErrorCode | None,
) -> None:
    conn.execute(
        "INSERT INTO garmin.normalize_result"
        " (user_id, connection_id, scope, key, endpoint, ok, error_code, raw_fetched_at, normalized_at)"
        " VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)"
        " ON CONFLICT (user_id, connection_id, scope, key, endpoint) DO UPDATE SET"
        " ok = excluded.ok, error_code = excluded.error_code,"
        " raw_fetched_at = excluded.raw_fetched_at, normalized_at = excluded.normalized_at",
        (
            conn.user_id, conn.connection_id,
            item.scope,
            item.key,
            item.endpoint,
            int(ok),
            None if error_code is None else error_code.value,
            item.fetched_at,
            dates.now_ms(),
        ),
    )


def _item_days(conn, item, day_keys, timezone):
    if item.scope == _DAY: return {item.key}
    key = _target_key(item)
    if key is None: return set()
    account = (conn.user_id, conn.connection_id)
    days = {day_keys.get(key)}
    row = conn.execute("SELECT day_key,start_ms FROM garmin.activity WHERE user_id=%s AND connection_id=%s AND activity_id=%s", (*account,key)).fetchone()
    if row:
        days.add(row[0])
        if row[1] is not None: days.add(datetime.fromtimestamp(row[1] / 1000, ZoneInfo(timezone)).date().isoformat())
    for row in conn.execute("SELECT date FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND activity_id=%s", (*account,key)):
        days.add(row[0])
    return {day for day in days if day is not None}


def _mark_pending(conn, days):
    if not days: return
    row = conn.execute("SELECT value FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='day_values_pending'", (conn.user_id, conn.connection_id)).fetchone()
    pending = set(json.loads(row[0])) if row else set()
    _write_pending_days(conn, pending | days)


def _refresh_days(conn, items, unit, timezone, rebuild, previous_dates, durable_pending=None):
    """Replace each affected date atomically, isolating non-SQL calculation failures."""
    account = (conn.user_id, conn.connection_id)
    with store.transaction(conn):
        pending_row = conn.execute(
            "SELECT value FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='day_values_pending'", account
        ).fetchone()
        pending = set(json.loads(pending_row[0])) if pending_row else set()
        zone = ZoneInfo(timezone)
        activity_days = {}
        for activity_id, start_ms in conn.execute(
            "SELECT activity_id, start_ms FROM garmin.activity WHERE user_id=%s AND connection_id=%s AND start_ms IS NOT NULL", account
        ):
            activity_days[str(activity_id)] = datetime.fromtimestamp(start_ms / 1000, zone).date().isoformat()
        affected = {i.key if i.scope == "day" else activity_days.get(i.key) for i in items}
        affected.update(previous_dates)
        if rebuild:
            affected = set()
            first, last = conn.execute(
                "SELECT MIN(key), MAX(key) FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='day'", account
            ).fetchone()
            history = conn.execute(
                "SELECT value FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='history_start'", account
            ).fetchone()
            if first and last:
                cursor = date.fromisoformat(history[0] if history else first)
                while cursor.isoformat() <= last:
                    affected.add(cursor.isoformat())
                    cursor += timedelta(days=1)
            # Staging items create fresh pending dates; SQLite rebuild only
            # carries pending that existed before rebuild into the range.
            pending.intersection_update(affected)
            pending.update(durable_pending or ())
            affected.update(durable_pending or ())
            _write_pending_days(conn, pending)
        else:
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
                        "SELECT endpoint,raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='day' AND key=%s",
                        (*account, key),
                    )
                }
                activities = {}
                for activity_id, activity_day in activity_days.items():
                    if activity_day == key:
                        activities[activity_id] = {
                            endpoint: json.loads(raw)
                            for endpoint, raw in conn.execute(
                                "SELECT endpoint,raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='activity' AND key=%s",
                                (*account, activity_id),
                            )
                        }
                conn.execute(
                    "DELETE FROM garmin.exercise_log WHERE user_id=%s AND connection_id=%s AND activity_id IN (SELECT activity_id FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND date=%s)",
                    (*account, *account, key),
                )
                conn.execute("DELETE FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND date=%s", (*account, key))
                conn.execute("DELETE FROM garmin.day_summary WHERE user_id=%s AND connection_id=%s AND date=%s", (*account, key))
                if not day_raw and not activities:
                    pending.discard(key)
                    _write_pending_days(conn, pending)
                    continue
                values = digest.day_values(key, day_raw, activities, labels, timezone)
                # An incoming activity may still belong to another stored date.
                # Remove both tables by ID in this same date transaction so an
                # insertion failure restores its previous workout and exercises.
                incoming = [(*account, row["activity_id"]) for row in values["workouts"]]
                conn.executemany(
                    "DELETE FROM garmin.exercise_log WHERE user_id=%s AND connection_id=%s AND activity_id=%s", incoming
                )
                conn.executemany("DELETE FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND activity_id=%s", incoming)
                for table, rows in (
                    ("day_summary", [values["day_summary"]]),
                    ("workout", values["workouts"]),
                    ("exercise_log", values["exercise_logs"]),
                ):
                    for row in rows:
                        columns = ",".join(row)
                        conn.execute(
                            f"INSERT INTO garmin.{table} (user_id,connection_id,{columns}) VALUES ({','.join('%s' for _ in range(len(row) + 2))})",
                            (*account, *row.values()),
                        )
                        if table == "exercise_log":
                            conn.execute(
                                "INSERT INTO garmin.exercise_log_order (user_id,connection_id,activity_id,exercise,source_order) "
                                "SELECT %s,%s,%s,%s,COALESCE(MAX(source_order),0)+1 FROM garmin.exercise_log_order WHERE user_id=%s AND connection_id=%s",
                                (*account, row["activity_id"], row["exercise"], *account),
                            )
                pending.discard(key)
                _write_pending_days(conn, pending)
        except (psycopg.Error, store.StoreError):
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
            "INSERT INTO garmin.meta(user_id,connection_id,key,value) VALUES (%s,%s,'day_values_pending',%s) "
            "ON CONFLICT(user_id,connection_id,key) DO UPDATE SET value=excluded.value",
            (conn.user_id, conn.connection_id, json.dumps(sorted(pending))),
        )
    else:
        conn.execute("DELETE FROM garmin.meta WHERE user_id=%s AND connection_id=%s AND key='day_values_pending'", (conn.user_id, conn.connection_id))
