"""Build a private, scrubbed daily-analysis input directory from one read snapshot."""

import contextlib
import importlib.resources
import json
import math
import os
import shutil
import psycopg
from psycopg.rows import dict_row
import tempfile
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from garmin_pipeline import body, config, dates, store

SCRUB_PARTS = (
    "userprofile",
    "owner",
    "displayname",
    "fullname",
    "profileimage",
    "email",
    "userid",
    "profileid",
)
HISTORY_DAYS = 30
"""Export the report day and the preceding 30 calendar days."""
WEEKDAYS = "월화수목금토일"


@dataclass(frozen=True)
class ReportInput:
    """Installed input folder and the dictionaries supplied to digest.build."""

    path: Path
    manifest: dict
    days: dict
    activities: dict
    labels: dict
    body: list


def scrub(value):
    """Recursively remove account identifier keys, including nested list members."""
    if isinstance(value, dict):
        return {
            k: scrub(v)
            for k, v in value.items()
            if not any(part in k.lower() for part in SCRUB_PARTS)
        }
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def write_json(path: Path, value: object) -> None:
    """Atomically install a UTF-8 JSON file in its destination directory."""
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def _truncate(endpoint: str, raw: object, cutoff: int):
    if not isinstance(raw, dict):
        return raw
    keys = (
        ("stressValuesArray", "bodyBatteryValuesArray")
        if endpoint == "stress_data"
        else (("heartRateValues",) if endpoint == "heart_rates" else ())
    )
    for key in keys:
        if isinstance(raw.get(key), list):
            raw[key] = [
                r
                for r in raw[key]
                if isinstance(r, list)
                and r
                and isinstance(r[0], (int, float))
                and r[0] < cutoff
            ]
    return raw


def _timestamp(epoch_ms: int, cfg: config.Config) -> str:
    """Preserve cutoff milliseconds and offset instead of truncating to a minute."""
    return datetime.fromtimestamp(epoch_ms / 1000, ZoneInfo(cfg.timezone)).isoformat(
        timespec="milliseconds"
    )


def _run(conn, day):
    return conn.execute(
        "SELECT started_at, status, detail, finished_at FROM garmin.run "
        "WHERE user_id=%s AND connection_id=%s AND local_date=%s AND status!='skipped_blocked' ORDER BY started_at DESC LIMIT 1",
        (conn.user_id, conn.connection_id, day.isoformat()),
    ).fetchone()


def activity_completion(endpoints, start_ms, duration_s):
    """원본 소수 초 정밀도를 digest와 동일하게 보존한다."""
    activity = endpoints.get('activity')
    summary = activity.get('summaryDTO') if isinstance(activity, dict) else None
    if isinstance(summary, dict):
        duration, raw_start = summary.get('duration'), summary.get('startTimeGMT')
        if isinstance(duration, (int, float)) and not isinstance(duration, bool) and math.isfinite(duration):
            try:
                start = (datetime.fromtimestamp(raw_start / 1000, UTC) if isinstance(raw_start, (int, float))
                         else datetime.fromisoformat(str(raw_start)))
                if start.tzinfo is None: start = start.replace(tzinfo=UTC)
                return (start + timedelta(seconds=duration)).timestamp() * 1000
            except (ValueError, OverflowError):
                pass
    # 원본이 불완전한 보존 자료는 기존 정수 초 cutoff 계약으로만 내보낸다.
    # 기존 SQLite의 int64 overflow → binary64 승격까지 보존한다.
    minimum, maximum = -(2 ** 63), 2 ** 63 - 1
    product = duration_s * 1000
    if minimum <= product <= maximum:
        total = start_ms + product
        if minimum <= total <= maximum: return total
        return float(start_ms) + float(product)
    return float(start_ms) + float(duration_s) * 1000


def workout_window(day, timezone):
    """직전 현지 날짜의 완료 시각 반열림 창. DST에도 인접 날짜 경계가 정확히 맞는다."""
    return tuple(int(datetime.combine(value, time.min, ZoneInfo(timezone)).timestamp() * 1000)
                 for value in (day - timedelta(days=1), day))


def _snapshot(cfg, day, started_at, notes, *, connection=None, full_history=False):
    days, activities, workouts, missing = {}, {}, [], []
    workout_starts = []
    cutoff = started_at
    yesterday = day - timedelta(days=1)
    window_from, window_to = workout_window(day, cfg.timezone)
    collect = {
        "status": "not_run",
        "detail": "",
        "finished_at": None,
        "missing": missing,
    }
    first_ever = day
    try:
        conn = connection if connection is not None else store.read_connection(cfg)
    except (store.StoreError, psycopg.Error):
        notes.append("수집 DB를 읽을 수 없다")
        return (
            days,
            activities,
            workouts,
            cutoff,
            window_from,
            collect,
            first_ever,
            workout_starts,
        )
    try:
        run = _run(conn, day)
        if run:
            collect.update(
                status=run[1],
                detail=run[2] or "",
                finished_at=dates.local_minute(run[3], cfg) if run[3] else None,
            )
        earliest = conn.execute(
            "SELECT MIN(key COLLATE \"C\") FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='day'",
            (conn.user_id, conn.connection_id)
        ).fetchone()[0]
        if earliest:
            first_ever = date.fromisoformat(earliest)
        first = first_ever.isoformat() if full_history else (day - timedelta(days=HISTORY_DAYS)).isoformat()
        for key, endpoint, encoded in conn.execute(
            "SELECT key, endpoint, raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='day' AND key BETWEEN %s AND %s ORDER BY key COLLATE \"C\", endpoint COLLATE \"C\"",
            (conn.user_id, conn.connection_id, first, day.isoformat()),
        ):
            if key == day.isoformat() and endpoint in ("user_summary", "body_battery"):
                continue
            try:
                raw = scrub(json.loads(encoded))
            except (ValueError, TypeError):
                notes.append(f"{key} {endpoint}: 원본 JSON이 잘못됐다")
                continue
            if key == day.isoformat():
                raw = _truncate(endpoint, raw, cutoff)
            if (
                raw is None
                and endpoint not in ("activities_by_date", "training_readiness")
                and key in (day.isoformat(), yesterday.isoformat())
            ):
                missing.append(f"{key} {endpoint}")
            if Path(endpoint).name != endpoint or endpoint in (".", ".."):
                notes.append("원본 endpoint 이름이 잘못됐다")
                continue
            days.setdefault(key, {})[endpoint] = raw
        # Recovery ends at every observed workout start, including a workout
        # still in progress at cutoff. Its results remain excluded below.
        workout_starts = [
            row[0]
            for row in conn.execute(
                "SELECT start_ms FROM garmin.activity WHERE user_id=%s AND connection_id=%s AND day_key BETWEEN %s AND %s AND start_ms < %s ORDER BY start_ms",
                (conn.user_id, conn.connection_id, first, day.isoformat(), cutoff),
            )
        ]
        for activity_id, start_ms, duration_s in conn.execute(
            "SELECT activity_id, start_ms, duration_s FROM garmin.activity WHERE user_id=%s AND connection_id=%s AND day_key BETWEEN %s AND %s "
            "AND start_ms IS NOT NULL AND duration_s IS NOT NULL ORDER BY start_ms",
            (conn.user_id, conn.connection_id, first, day.isoformat()),
        ):
            activity_id = str(activity_id)
            if not activity_id.isdecimal():
                notes.append("운동 ID 모양이 잘못됐다")
                continue
            endpoints = {}
            for endpoint, encoded in conn.execute(
                "SELECT endpoint, raw FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='activity' AND key=%s",
                (conn.user_id, conn.connection_id, activity_id),
            ):
                if Path(endpoint).name != endpoint or endpoint in (".", ".."):
                    continue
                try:
                    endpoints[endpoint] = scrub(json.loads(encoded))
                except (ValueError, TypeError):
                    notes.append(f"운동 {activity_id} {endpoint}: 원본 JSON이 잘못됐다")
            completed_at = activity_completion(endpoints, start_ms, duration_s)
            if completed_at >= cutoff:
                continue
            activities[activity_id] = endpoints
            # 완료한 현지 날짜로 한 번만 귀속한다. 자정을 넘기는 운동도 다음 날 창에서 빠지지 않는다.
            if window_from <= completed_at < window_to:
                workouts.append(activity_id)
    except (psycopg.Error, ValueError):
        notes.append("수집 DB 스냅샷을 읽지 못했다")
        raise
    finally:
        if connection is None:
            conn.close()
    return (
        days,
        activities,
        workouts,
        cutoff,
        window_from,
        collect,
        first_ever,
        workout_starts,
    )


def build(
    cfg: config.Config, report_date: date, *, started_at: int | None = None,
    connection=None, snapshot_id=None, target_root=None
) -> ReportInput:
    """Replace today's input with a fresh snapshot, then remove older date folders."""
    notes = [
        "운동은 직전 현지 날짜에 완료된 건만 확정 집계한다. 대상 날짜 자료는 data_cutoff까지의 진행 중 부분 자료다.",
        "리포트 날짜의 stress_data·heart_rates는 data_cutoff 전 샘플만 담는다.",
        "리포트 날짜의 user_summary·body_battery는 하루가 끝나지 않아 넣지 않았다.",
    ]
    (
        days,
        activities,
        workouts,
        cutoff,
        window_from,
        collect,
        first_ever,
        workout_starts,
    ) = _snapshot(
        cfg,
        report_date,
        dates.now_ms() if started_at is None else started_at,
        notes, connection=connection, full_history=snapshot_id is not None,
    )
    yesterday = report_date - timedelta(days=1)
    sidecars = []
    schema = body.load_schema()
    for path in sorted((cfg.data_dir / "body").glob("*.json")):
        try:
            measured_on = date.fromisoformat(path.stem)
            if measured_on > report_date:
                continue
            value = body.read_sidecar(schema, path, measured_on)
            if value is not None:
                sidecars.append(scrub(value))
        except (ValueError, OSError, body.BodyError):
            notes.append(f"body/{path.name}: 무효 사이드카를 제외했다")
    labels = json.loads(
        (
            importlib.resources.files("garmin_pipeline")
            / "labels"
            / "exercise_types_ko.json"
        ).read_text(encoding="utf-8")
    )
    windows = {
        key: {"from": start.isoformat(), "to": report_date.isoformat()}
        for key, start in (
            ("7d", report_date - timedelta(days=6)),
            ("30d", report_date - timedelta(days=29)),
            ("all", first_ever),
        )
    }
    months = []
    cursor = first_ever.replace(day=1)
    while cursor <= report_date:
        months.append(cursor.strftime("%Y-%m"))
        cursor = (cursor.replace(day=28) + timedelta(days=4)).replace(day=1)
    manifest = {
        "report_date": report_date.isoformat(),
        "weekday": WEEKDAYS[report_date.weekday()],
        "timezone": cfg.timezone,
        "yesterday": yesterday.isoformat(),
        "sleep_night": {
            "from": yesterday.isoformat(),
            "to": report_date.isoformat(),
            "file": f"days/{report_date}/sleep_data.json",
        },
        "workout_window": {
            "from": _timestamp(window_from, cfg),
            "to": _timestamp(workout_window(report_date, cfg.timezone)[1], cfg),
            "basis": "completed_at",
        },
        "workouts": workouts,
        "_workout_starts_ms": workout_starts,
        "baseline_days": [
            (report_date - timedelta(days=i)).isoformat() for i in range(7, 0, -1)
        ],
        "history_days": sorted(days),
        "period_windows": windows,
        "months": months,
        "collect": collect,
        "data_cutoff": _timestamp(cutoff, cfg),
        "previous_report": None,
        "body": [f"body/{r['measured_on']}.json" for r in sidecars],
        "notes": notes,
    }
    if snapshot_id is not None:
        manifest["snapshot_id"] = snapshot_id
    root = target_root if target_root is not None else cfg.data_dir / "report-input"
    root.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = root / report_date.isoformat()
    temporary = Path(tempfile.mkdtemp(prefix=f".{report_date}-", dir=root))
    backup = None
    try:
        for folder in ("days", "activities", "body", "scratch", "labels"):
            (temporary / folder).mkdir(mode=0o700)
        for key, endpoints in days.items():
            for endpoint, raw in endpoints.items():
                write_json(temporary / "days" / key / f"{endpoint}.json", raw)
        for key, endpoints in activities.items():
            for endpoint, raw in endpoints.items():
                write_json(temporary / "activities" / key / f"{endpoint}.json", raw)
        for row in sidecars:
            write_json(temporary / "body" / f"{row['measured_on']}.json", row)
        write_json(temporary / "labels" / "exercise_types_ko.json", labels)
        from . import analysis_profile
        manifest['analysis_profile'] = analysis_profile.write(cfg, temporary)
        _previous_evaluations(cfg, temporary, yesterday, notes, connection=connection)
        write_json(temporary / "manifest.json", manifest)
        if target.exists():
            backup = temporary.with_name(temporary.name + ".old")
            target.rename(backup)
        try:
            temporary.rename(target)
        except BaseException:
            if backup is not None:
                backup.rename(target)
            raise
        if backup is not None:
            shutil.rmtree(backup)
        for old in root.iterdir():
            if old != target and old.is_dir():
                try:
                    date.fromisoformat(old.name)
                except ValueError:
                    continue
                shutil.rmtree(old)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return ReportInput(target, manifest, days, activities, labels, sidecars)


def _evaluations(conn, sql, params=()):
    fields = ("report_date", "scope", "summary", "judgments", "evidence", "next_checks")
    rows = []
    for record in conn.execute(sql, params):
        row = dict(zip(fields, record, strict=True))
        for field in ("judgments", "evidence", "next_checks"):
            row[field] = json.loads(row[field])
        rows.append(row)
    return rows


_EVALUATION_FIELDS = "report_date,scope,summary,judgments,evidence,next_checks"



# SQLite migration 0016 column order; do not include PG account/revision columns.
_DAY_COLUMNS = (
    "date", "sleep_total_s", "sleep_deep_s", "sleep_light_s", "sleep_rem_s", "sleep_awake_s", "sleep_score",
    "sleep_hr_min", "sleep_hr_min_time", "hrv_avg", "spo2_avg", "spo2_min", "resp_avg", "wake_bb", "bb_high",
    "bb_low", "bb_charged", "bb_drained", "stress_avg", "stress_high_s", "steps", "active_kcal", "moderate_min",
    "vigorous_min", "resting_hr", "weight_kg", "drinks_json",
)
_DAY_FIELDS = ",".join(_DAY_COLUMNS)
_AVERAGE_FIELDS = tuple(c for c in _DAY_COLUMNS if c not in ("date", "sleep_hr_min_time", "drinks_json"))
_WORKOUT_FIELDS = "activity_id,date,type,start_ms,duration_s,hr_avg,hr_max,zone1_s,zone2_s,zone3_s,zone4_s,zone5_s,bb_change,session_no"
_EXERCISE_FIELDS = ",".join("e." + c for c in ("activity_id", "exercise", "sets", "reps", "max_kg", "volume_kg", "set_peak_hr_avg", "rest_drop_avg"))

def _previous_evaluations(cfg, folder, yesterday, notes, *, connection=None):
    conn = connection if connection is not None else store.read_connection(cfg)
    try:
        previous = _previous_checks(conn, 'day', (yesterday + timedelta(days=1)).isoformat(), exact_date=yesterday.isoformat())
        write_json(folder / 'previous_evaluations' / 'day.json', previous)
    finally:
        if connection is None:
            conn.close()


def _previous_checks(conn, scope, end, *, exact_date=None):
    # 과거 본문은 전달하지 않고 같은 기간의 next_checks와 선택 revision만 고정한다.
    condition = 'report_date=%s' if exact_date else 'report_date<%s'
    row = conn.execute(
        f"SELECT report_date,scope,next_checks,revision,model,created_at FROM garmin.evaluation "
        f"WHERE user_id=%s AND connection_id=%s AND scope=%s AND {condition} ORDER BY report_date DESC LIMIT 1",
        (conn.user_id,conn.connection_id,scope,exact_date or end)).fetchone()
    if row is None: return None
    report_date, scope, checks, revision, model, created_at = row
    return {'report_date':report_date,'scope':scope,'next_checks':json.loads(checks),
            'revision':revision,'model':model,'created_at':created_at,
            'elapsed_days':(date.fromisoformat(end)-date.fromisoformat(report_date)).days}


def build_period(
    cfg: config.Config, folder: Path, report_date: date, scope: str, *, focus=None, connection=None
) -> Path:
    """Export a period from one PostgreSQL read snapshot immediately before its session."""
    if scope not in ("7d", "30d", "all", "custom"):
        raise ValueError("invalid period scope")
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    window = manifest["period_windows"][scope]
    start, end = window["from"], window["to"]
    target = folder / "period" / scope
    if connection is None and (folder / "snapshot.json").is_file() and target.is_dir():
        return target
    conn = connection if connection is not None else store.read_connection(cfg)
    try:
        account = (conn.user_id, conn.connection_id)
        actual = conn.execute(
            "SELECT COUNT(*) FROM garmin.day_summary WHERE user_id=%s AND connection_id=%s AND date BETWEEN %s AND %s",
            (*account, start, end),
        ).fetchone()[0]
        scope_info = {
            "scope": scope,
            "report_date": report_date.isoformat(),
            "from": start,
            "to": end,
            "actual_days": actual,
            "months": [m for m in manifest["months"] if start[:7] <= m <= end[:7]],
            "partial_date": manifest.get("partial_date", {
                "date": report_date.isoformat(),
                "description": "data_cutoff까지의 부분 값",
                "data_cutoff": manifest["data_cutoff"],
            }),
        }
        # Explicit original SQLite column lists exclude the new account keys.
        with conn.cursor(row_factory=dict_row) as cur:
            def rows(sql, params):
                cur.execute(sql, params)
                return cur.fetchall()

            if scope != "all":
                values = {
                    "day_summary": rows(
                        f"SELECT {_DAY_FIELDS} FROM garmin.day_summary WHERE user_id=%s AND connection_id=%s AND date BETWEEN %s AND %s ORDER BY date COLLATE \"C\"",
                        (*account, start, end),
                    ),
                    "workout": rows(
                        f"SELECT {_WORKOUT_FIELDS} FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND date BETWEEN %s AND %s ORDER BY start_ms NULLS FIRST, date COLLATE \"C\", activity_id",
                        (*account, start, end),
                    ),
                    "exercise_log": rows(
                        f"SELECT {_EXERCISE_FIELDS} FROM garmin.exercise_log e JOIN garmin.workout w ON w.user_id=e.user_id AND w.connection_id=e.connection_id AND w.activity_id=e.activity_id WHERE e.user_id=%s AND e.connection_id=%s AND w.date BETWEEN %s AND %s ORDER BY w.start_ms NULLS FIRST,e.exercise COLLATE \"C\",w.date COLLATE \"C\",w.activity_id",
                        (*account, start, end),
                    ),
                }
            else:
                averages = ",".join(f"AVG({c}) AS {c}" for c in _AVERAGE_FIELDS)
                values = {
                    "months": rows(
                        f"SELECT substr(date,1,7) AS month,COUNT(*) AS days,{averages} FROM garmin.day_summary WHERE user_id=%s AND connection_id=%s AND date BETWEEN %s AND %s GROUP BY month ORDER BY month",
                        (*account, start, end),
                    ),
                    "workouts": rows(
                        "SELECT substr(date,1,7) AS month,COUNT(*) AS workouts,SUM(duration_s) AS duration_s FROM garmin.workout WHERE user_id=%s AND connection_id=%s AND date BETWEEN %s AND %s GROUP BY month ORDER BY month",
                        (*account, start, end),
                    ),
                    "exercises": rows(
                        "SELECT substr(w.date,1,7) AS month,e.exercise,MAX(e.max_kg) AS max_kg,SUM(e.volume_kg) AS volume_kg FROM garmin.exercise_log e JOIN garmin.workout w ON w.user_id=e.user_id AND w.connection_id=e.connection_id AND w.activity_id=e.activity_id WHERE e.user_id=%s AND e.connection_id=%s AND w.date BETWEEN %s AND %s GROUP BY month,e.exercise ORDER BY month,e.exercise COLLATE \"C\"",
                        (*account, start, end),
                    ),
                }
        if scope == "custom":
            scope_info['timezone'] = cfg.timezone
            scope_info['focus'] = focus or {}
            if focus and 'metric' in focus:
                import query
                data = {'connection_id': str(conn.connection_id), 'timezone': cfg.timezone,
                        'start_date': start, 'end_date': end, **focus}
                command = 'period-summary' if 'aggregation' in focus else 'daily-values'
                values = {'focus': focus, 'values': query.execute(conn, conn.user_id, command, data)}
            elif focus:
                workouts = values['workout']
                if 'activity_type' in focus:
                    workouts = [w for w in workouts if w['type'] == focus['activity_type']]
                if 'exercise' in focus:
                    ids = {e['activity_id'] for e in values['exercise_log'] if e['exercise'] == focus['exercise']}
                    workouts = [w for w in workouts if w['activity_id'] in ids]
                ids = {w['activity_id'] for w in workouts}
                days = {w['date'] for w in workouts}
                values = {'workout': workouts,
                          'day_summary': [d for d in values['day_summary'] if d['date'] in days],
                          'exercise_log': [e for e in values['exercise_log'] if e['activity_id'] in ids and ('exercise' not in focus or e['exercise'] == focus['exercise'])]}
        evaluations = _evaluations(conn,
            f"SELECT {_EVALUATION_FIELDS} FROM garmin.evaluation WHERE user_id=%s AND connection_id=%s AND scope='day' AND report_date BETWEEN %s AND %s ORDER BY report_date",
            (*account,start,end)) if scope=='custom' else []
        if scope == "custom":
            # 같은 초점·길이 중 이번 창과 겹치지 않는 가장 최근 기간의 최신 revision이다.
            with conn.cursor(row_factory=dict_row) as cur:
                cur.execute("""select start_date,end_date,revision,focus,summary,report_md,judgments,evidence,next_checks
                    from garmin.period_evaluations where user_id=%s and connection_id=%s and focus=%s::jsonb
                    and end_date<%s and (end_date::date-start_date::date)=(%s::date-%s::date)
                    order by end_date desc,start_date desc,revision desc limit 1""",
                    (*account, json.dumps(focus or {}), start, end, start))
                previous = cur.fetchall()
        else:
            selected = _previous_checks(conn, scope, report_date.isoformat())
            previous = [selected] if selected else []
    finally:
        if connection is None:
            conn.close()
    parent = folder / "period"
    parent.mkdir(mode=0o700, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=f".{scope}-", dir=parent))
    (temporary / "scratch").mkdir(mode=0o700)
    target, backup = parent / scope, parent / f".{scope}.old"
    try:
        for name, value in (
            ("scope", scope_info),
            ("day_values", values),
            ("evaluations", evaluations),
            ("previous", previous[0] if previous else None),
        ):
            write_json(temporary / f"{name}.json", value)
        for name in ('profile.json', 'profile.md'):
            if (folder / name).is_file():
                shutil.copyfile(folder / name, temporary / name)
        if target.exists():
            target.rename(backup)
        try:
            temporary.rename(target)
        except BaseException:
            if backup.exists():
                backup.rename(target)
            raise
        if backup.exists():
            shutil.rmtree(backup)
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)
    return target


def prepare_snapshot(cfg, report_date: date, work_id: str, *, started_at=None) -> ReportInput:
    """네 기간 원본·이전 확인사항을 한 읽기 트랜잭션에서 고정한 뒤 모델 실행 전에 닫는다."""
    import hashlib
    from garmin_pipeline import digest, training_measurements
    snapshot_id = training_measurements.snapshot_id_for(work_id,report_date)
    parent = cfg.data_dir / 'report-snapshots'
    parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = parent / snapshot_id
    if target.exists():
        training_measurements.resolve_snapshot_root(cfg, snapshot_id)
        return _load_snapshot(target)
    temporary = Path(tempfile.mkdtemp(prefix='.snapshot-', dir=parent))
    conn = None
    try:
        conn = store.read_connection(cfg)
        exported = build(cfg, report_date, started_at=started_at, connection=conn,
                         snapshot_id=snapshot_id, target_root=temporary)
        folder = exported.path
        profile_path = folder / 'profile.json'
        profile = json.loads(profile_path.read_text(encoding='utf-8')) if profile_path.is_file() else None
        scope_measurements = {
            scope:training_measurements.build_training_measurements(
                exported.manifest,exported.days,exported.activities,exported.labels,exported.body,scope,profile=profile)
            for scope in training_measurements.SCOPES}
        # 모든 파일의 창은 C1과 같아야 한다. 완료일 귀속 운동은 C1 한 곳에서만 제공한다.
        for scope in ('7d','30d','all'):
            current=scope_measurements[scope]['current']
            exported.manifest['period_windows'][scope]={'from':current['from'],'to':current['to']}
        write_json(folder/'manifest.json',exported.manifest)
        # 기존 회복 요약도 모델 시작 전에 같은 읽기 트랜잭션에서 내보낸다.
        for scope in ('7d', '30d', 'all'):
            build_period(cfg, folder, report_date, scope, connection=conn)
        day_folder = folder / 'day'
        day_folder.mkdir(mode=0o700)
        for name in ('days', 'activities', 'labels', 'body', 'previous_evaluations'):
            if (folder / name).exists(): shutil.copytree(folder / name, day_folder / name)
        # day는 같은 snapshot의 최근 측정만 읽고 다른 기간 입력은 받지 않는다.
        history_from=min((report_date-timedelta(days=HISTORY_DAYS)).isoformat(),scope_measurements['day']['comparison']['from'])
        for path in (day_folder/'days').iterdir():
            if path.name < history_from: shutil.rmtree(path)
        for path in (day_folder/'activities').iterdir():
            raw=exported.activities.get(path.name,{}).get('activity') or {}
            start=(raw.get('summaryDTO') or {}).get('startTimeGMT')
            parsed=digest._Digest(exported.manifest,{}, {}, {}, []).to_utc(start)
            if parsed and parsed.astimezone(ZoneInfo(cfg.timezone)).date().isoformat() < history_from:
                shutil.rmtree(path)
        for name in ('profile.md', 'profile.json'):
            # 생산은 프로필 워커 소유이며 여기서는 이미 생성된 사본만 같은 snapshot에 포함한다.
            if (folder / name).is_file(): shutil.copyfile(folder / name, day_folder / name)
        (day_folder / 'scratch').mkdir(mode=0o700)
        write_json(day_folder / 'manifest.json', exported.manifest)
        write_json(day_folder / 'digest.json', digest.build(exported.manifest,exported.days,exported.activities,exported.labels,exported.body))
        for scope in training_measurements.SCOPES:
            scope_folder = day_folder if scope == 'day' else folder / 'period' / scope
            measurements = scope_measurements[scope]
            write_json(scope_folder / 'training_measurements.json', measurements)
            # source_ref는 기간 입력 안에서 실제로 읽을 수 있는 고정 원본만 가리킨다.
            sessions=measurements['current']['sessions']
            if measurements['comparison'] is not None: sessions=sessions+measurements['comparison']['sessions']
            if scope!='day':
                for session_id in {session['session_id'] for session in sessions}:
                    source=folder/'activities'/session_id
                    if source.is_dir(): shutil.copytree(source,scope_folder/'activities'/session_id)
            if scope != 'day':
                scope_info=json.loads((scope_folder / 'scope.json').read_text(encoding='utf-8'))
                scope_info.update(snapshot_id=snapshot_id,timezone=cfg.timezone,
                    data_cutoff=exported.manifest['data_cutoff'],
                    measurements_version=training_measurements.SCHEMA_VERSION,
                    profile_snapshot_id=exported.manifest.get('profile_snapshot_id'),
                    **{'from':measurements['current']['from'],'to':measurements['current']['to'],
                       'actual_days':measurements['current']['actual_days']})
                write_json(scope_folder / 'scope.json',scope_info)
                legacy_values=json.loads((scope_folder/'day_values.json').read_text(encoding='utf-8'))
                # 시작일로 귀속된 구 운동/종목 집계를 C1과 함께 전달하지 않는다.
                recovery_key='months' if scope=='all' else 'day_summary'
                write_json(scope_folder/'day_values.json',{
                    recovery_key:legacy_values[recovery_key],
                    'training_measurements_ref':'training_measurements.json'})
        # 재게시에서 쓰는 원본과 입력 해시는 동일 폴더에 보존한다. 결과·scratch는 해시에 포함하지 않는다.
        hashes={str(path.relative_to(folder)):hashlib.sha256(path.read_bytes()).hexdigest()
                for path in sorted(folder.rglob('*')) if path.is_file()}
        write_json(folder / 'snapshot.json',{'snapshot_id':snapshot_id,'complete':True,
            'report_date':report_date.isoformat(),'data_cutoff':exported.manifest['data_cutoff'],
            'profile_snapshot_id':exported.manifest.get('profile_snapshot_id'),'files':hashes})
        folder.rename(target)
    finally:
        if conn is not None: conn.close()
        shutil.rmtree(temporary,ignore_errors=True)
    return _load_snapshot(target)


def _load_snapshot(folder: Path) -> ReportInput:
    """재개 시 DB나 프로필 원본을 다시 읽지 않는다."""
    def read(path): return json.loads(path.read_text(encoding='utf-8'))
    def endpoints(path):
        return {child.name:{p.stem:read(p) for p in child.glob('*.json')}
                for child in path.iterdir() if child.is_dir()}
    return ReportInput(folder,read(folder/'manifest.json'),endpoints(folder/'days'),
        endpoints(folder/'activities'),read(folder/'labels/exercise_types_ko.json'),
        [read(p) for p in sorted((folder/'body').glob('*.json'))])
