"""Pure v8 normalization of preserved raw items."""
import json
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo
from typing import NamedTuple
import normalize_daily as daily
import normalize_activity as activity
import collect_rawparse as rawparse
import digest
import labels

_DAY = "day"
_ACTIVITY = "activity"

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



def normalize_item(scope, key, endpoint, raw, day_keys=None):
    """Return endpoint-owned rows and an isolated result for one raw item."""
    rule = NORMALIZERS.get(endpoint)
    if rule is None or rule.scope != scope:
        return None
    result = {"scope": scope, "key": key, "endpoint": endpoint, "ok": 1, "error_code": None}
    tables = {}
    try:
        if scope == "activity":
            if not (key.isascii() and key.isdecimal()) or str(int(key)) != key or int(key) >= 2**63:
                raise daily.NormalizeParseError("invalid activity key")
            target_key = int(key)
        else:
            target_key = key
        values = {c: None for c in rule.columns} if raw == "null" else rule.parse(raw, key)
        if set(values) != set(rule.columns):
            raise RuntimeError("invalid parser columns")
        samples = [] if raw == "null" or rule.sample_table is None else rule.sample_table.parse(raw, key)
        if rule.columns and raw != "null":
            row = {"day_key": target_key} if scope == "day" else {"activity_id": target_key, "day_key": (day_keys or {}).get(target_key)}
            row.update(values)
            tables[_TARGETS[scope].table] = [row]
        if rule.sample_table:
            if any(len(s) != len(rule.sample_table.columns) for s in samples):
                raise RuntimeError("invalid sample columns")
            tables[rule.sample_table.table] = [dict(zip((_TARGETS[scope].key_column, *rule.sample_table.columns), (target_key, *s))) for s in samples]
    except daily.NormalizeParseError:
        result.update(ok=0, error_code="parse_error")
        tables = {}
    except Exception:
        result.update(ok=0, error_code="internal")
        tables = {}
    return tables, result

def normalize_all(items, timezone="Asia/Seoul", history_start=None):
    """Rebuild legacy-shaped tables from raw items, with per-item failure isolation."""
    items = sorted(items, key=lambda i: (i["scope"], i["key"], i["endpoint"]))
    day_keys = {}
    for item in items:
        if item["scope"] == "day" and item["endpoint"] == "activities_by_date":
            try:
                for ref in rawparse.activity_refs(item["raw"]):
                    day_keys.setdefault(ref.activity_id, ref.day_key)
            except rawparse.RawParseError:
                pass
    names = ("daily_metric", "activity", "body_battery_sample", "stress_bb_sample", "hr_sample", "activity_hr_sample", "exercise_set", "day_summary", "workout", "exercise_log", "normalize_result")
    tables = {name: [] for name in names}
    merged = {"daily_metric": {}, "activity": {}}
    for item in items:
        parsed = normalize_item(item["scope"], item["key"], item["endpoint"], item["raw"], day_keys)
        if parsed is None:
            continue
        rows, result = parsed
        result["raw_fetched_at"] = item["fetched_at"]
        tables["normalize_result"].append(result)
        for table, values in rows.items():
            if table in merged:
                for row in values:
                    pk = row["day_key"] if table == "daily_metric" else row["activity_id"]
                    merged[table].setdefault(pk, {column: None for rule in NORMALIZERS.values() if rule.scope == ("day" if table == "daily_metric" else "activity") for column in rule.columns}).update(row)
            else:
                tables[table].extend(values)
    for table, rows in merged.items():
        tables[table] = list(rows.values())
    activity_days = {str(row["activity_id"]): datetime.fromtimestamp(row["start_ms"] / 1000, ZoneInfo(timezone)).date().isoformat() for row in tables["activity"] if row.get("start_ms") is not None}
    dates = sorted({i["key"] for i in items if i["scope"] == "day"})
    if dates:
        start = date.fromisoformat(history_start or dates[0])
        end = date.fromisoformat(dates[-1])
        dates = [(start + timedelta(days=i)).isoformat() for i in range((end - start).days + 1)]
    for day in dates:
        try:
            day_raw = {i["endpoint"]: json.loads(i["raw"]) for i in items if i["scope"] == "day" and i["key"] == day}
            activities = {aid: {i["endpoint"]: json.loads(i["raw"]) for i in items if i["scope"] == "activity" and i["key"] == aid} for aid, date in activity_days.items() if date == day}
            if not day_raw and not activities:
                continue
            values = digest.day_values(day, day_raw, activities, labels.load(), timezone)
            tables["day_summary"].append(values["day_summary"])
            tables["workout"].extend(values["workouts"])
            tables["exercise_log"].extend(values["exercise_logs"])
        except Exception:
            pass
    return tables
