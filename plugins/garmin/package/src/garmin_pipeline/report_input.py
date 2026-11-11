"""Build a private, scrubbed daily-analysis input directory from one read snapshot."""

import contextlib
import importlib.resources
import json
import os
import shutil
import psycopg
from psycopg.rows import dict_row
import tempfile
from dataclasses import dataclass
from datetime import date, datetime, timedelta
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


def _snapshot(cfg, day, started_at, notes):
    days, activities, workouts, missing = {}, {}, [], []
    workout_starts = []
    cutoff = started_at
    yesterday = day - timedelta(days=1)
    window_from = int(
        datetime.combine(
            yesterday, cfg.collect_time, ZoneInfo(cfg.timezone)
        ).timestamp()
        * 1000
    )
    collect = {
        "status": "not_run",
        "detail": "",
        "finished_at": None,
        "missing": missing,
    }
    first_ever = day
    try:
        conn = store.read_connection(cfg)
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
            cutoff = run[0]
            collect.update(
                status=run[1],
                detail=run[2] or "",
                finished_at=dates.local_minute(run[3], cfg) if run[3] else None,
            )
        previous = _run(conn, yesterday)
        if previous:
            window_from = previous[0]
        earliest = conn.execute(
            "SELECT MIN(key COLLATE \"C\") FROM garmin.raw_current WHERE user_id=%s AND connection_id=%s AND scope='day'",
            (conn.user_id, conn.connection_id)
        ).fetchone()[0]
        if earliest:
            first_ever = date.fromisoformat(earliest)
        first = (day - timedelta(days=HISTORY_DAYS)).isoformat()
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
        for activity_id, start_ms in conn.execute(
            "SELECT activity_id, start_ms FROM garmin.activity WHERE user_id=%s AND connection_id=%s AND day_key BETWEEN %s AND %s "
            "AND garmin.activity_ends_before_cutoff(start_ms,duration_s,%s) ORDER BY start_ms",
            (conn.user_id, conn.connection_id, first, day.isoformat(), cutoff),
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
            activities[activity_id] = endpoints
            if window_from <= start_ms < cutoff:
                workouts.append(activity_id)
    except (psycopg.Error, ValueError):
        notes.append("수집 DB 스냅샷을 읽지 못했다")
        raise
    finally:
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
    cfg: config.Config, report_date: date, *, started_at: int | None = None
) -> ReportInput:
    """Replace today's input with a fresh snapshot, then remove older date folders."""
    notes = [
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
        notes,
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
            "to": _timestamp(cutoff, cfg),
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
    root = cfg.data_dir / "report-input"
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
        try:
            (temporary / "profile.md").write_text(
                cfg.profile_path.read_text(encoding="utf-8"), encoding="utf-8"
            )
        except (OSError, UnicodeError):
            notes.append("profile.md 파일이 없거나 읽을 수 없다")
        previous_report = cfg.reports_dir / f"{yesterday}.md"
        if previous_report.is_file():
            shutil.copyfile(previous_report, temporary / "previous_report.md")
            manifest["previous_report"] = "previous_report.md"
        _previous_evaluations(cfg, temporary, yesterday, notes)
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

def _previous_evaluations(cfg, folder, yesterday, notes):
    try:
        conn = store.read_connection(cfg)
        try:
            for scope in ("day", "7d"):
                rows = _evaluations(
                    conn,
                    f"SELECT {_EVALUATION_FIELDS} FROM garmin.evaluation WHERE user_id=%s AND connection_id=%s AND report_date=%s AND scope=%s",
                    (conn.user_id, conn.connection_id, yesterday.isoformat(), scope),
                )
                if rows:
                    write_json(
                        folder / "previous_evaluations" / f"{scope}.json", rows[0]
                    )
                else:
                    notes.append(f"어제 {scope} 평가가 없다")
        finally:
            conn.close()
    except (store.StoreError, psycopg.Error):
        notes.append("이전 평가를 읽을 수 없다")


def build_period(
    cfg: config.Config, folder: Path, report_date: date, scope: str, *, focus=None
) -> Path:
    """Export a period from one PostgreSQL read snapshot immediately before its session."""
    if scope not in ("7d", "30d", "all", "custom"):
        raise ValueError("invalid period scope")
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    window = manifest["period_windows"][scope]
    start, end = window["from"], window["to"]
    conn = store.read_connection(cfg)
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
        if scope in ("7d", "custom"):
            evaluations = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM garmin.evaluation WHERE user_id=%s AND connection_id=%s AND scope='day' AND report_date BETWEEN %s AND %s ORDER BY report_date COLLATE \"C\"",
                (*account, start, end),
            )
        elif scope == "30d":
            evaluations = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM garmin.evaluation WHERE user_id=%s AND connection_id=%s AND scope='7d' AND report_date<=%s ORDER BY report_date COLLATE \"C\" DESC LIMIT 5",
                (*account, end),
            )
        else:
            evaluations = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM garmin.evaluation e WHERE e.user_id=%s AND e.connection_id=%s AND e.scope='30d' AND e.report_date IN (SELECT MAX(m.report_date COLLATE \"C\") FROM garmin.evaluation m WHERE m.user_id=e.user_id AND m.connection_id=e.connection_id AND m.scope='30d' AND m.report_date<=%s GROUP BY substr(m.report_date,1,7)) ORDER BY e.report_date COLLATE \"C\"",
                (*account, end),
            )
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
            previous = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM garmin.evaluation WHERE user_id=%s AND connection_id=%s AND scope=%s AND report_date<%s ORDER BY report_date COLLATE \"C\" DESC LIMIT 1",
                (*account, scope, end),
            )
    finally:
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
