"""Build a private, scrubbed daily-analysis input directory from one read snapshot."""

import contextlib
import importlib.resources
import json
import os
import shutil
import sqlite3
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
        "SELECT started_at, status, detail, finished_at FROM run "
        "WHERE local_date=? AND status!='skipped_blocked' ORDER BY started_at DESC LIMIT 1",
        (day.isoformat(),),
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
    except store.StoreError:
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
        conn.execute("BEGIN")
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
            "SELECT MIN(key) FROM raw_response WHERE scope='day'"
        ).fetchone()[0]
        if earliest:
            first_ever = date.fromisoformat(earliest)
        first = (day - timedelta(days=HISTORY_DAYS)).isoformat()
        for key, endpoint, encoded in conn.execute(
            "SELECT key, endpoint, raw FROM raw_response WHERE scope='day' AND key BETWEEN ? AND ? ORDER BY key, endpoint",
            (first, day.isoformat()),
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
                "SELECT start_ms FROM activity WHERE day_key BETWEEN ? AND ? AND start_ms < ? ORDER BY start_ms",
                (first, day.isoformat(), cutoff),
            )
        ]
        for activity_id, start_ms in conn.execute(
            "SELECT activity_id, start_ms FROM activity WHERE day_key BETWEEN ? AND ? "
            "AND start_ms + duration_s * 1000 < ? ORDER BY start_ms",
            (first, day.isoformat(), cutoff),
        ):
            activity_id = str(activity_id)
            if not activity_id.isdecimal():
                notes.append("운동 ID 모양이 잘못됐다")
                continue
            endpoints = {}
            for endpoint, encoded in conn.execute(
                "SELECT endpoint, raw FROM raw_response WHERE scope='activity' AND key=?",
                (activity_id,),
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
    except (sqlite3.Error, ValueError):
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


def _previous_evaluations(cfg, folder, yesterday, notes):
    try:
        conn = store.read_connection(cfg)
        try:
            conn.execute("BEGIN")
            for scope in ("day", "7d"):
                rows = _evaluations(
                    conn,
                    f"SELECT {_EVALUATION_FIELDS} FROM evaluation WHERE report_date=? AND scope=?",
                    (yesterday.isoformat(), scope),
                )
                if rows:
                    write_json(
                        folder / "previous_evaluations" / f"{scope}.json", rows[0]
                    )
                else:
                    notes.append(f"어제 {scope} 평가가 없다")
        finally:
            conn.close()
    except (store.StoreError, sqlite3.Error):
        notes.append("이전 평가를 읽을 수 없다")


def build_period(
    cfg: config.Config, folder: Path, report_date: date, scope: str
) -> Path:
    """Export a period from one SQLite read snapshot immediately before its session."""
    if scope not in ("7d", "30d", "all"):
        raise ValueError("invalid period scope")
    manifest = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    window = manifest["period_windows"][scope]
    start, end = window["from"], window["to"]
    conn = store.read_connection(cfg)
    try:
        conn.row_factory = sqlite3.Row
        conn.execute("BEGIN")
        actual = conn.execute(
            "SELECT COUNT(*) FROM day_summary WHERE date BETWEEN ? AND ?", (start, end)
        ).fetchone()[0]
        scope_info = {
            "scope": scope,
            "report_date": report_date.isoformat(),
            "from": start,
            "to": end,
            "actual_days": actual,
            "months": [m for m in manifest["months"] if start[:7] <= m <= end[:7]],
            "partial_date": {
                "date": report_date.isoformat(),
                "description": "data_cutoff까지의 부분 값",
                "data_cutoff": manifest["data_cutoff"],
            },
        }
        if scope != "all":
            values = {
                "day_summary": [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM day_summary WHERE date BETWEEN ? AND ? ORDER BY date",
                        (start, end),
                    )
                ],
                "workout": [
                    dict(r)
                    for r in conn.execute(
                        "SELECT * FROM workout WHERE date BETWEEN ? AND ? ORDER BY start_ms",
                        (start, end),
                    )
                ],
                "exercise_log": [
                    dict(r)
                    for r in conn.execute(
                        "SELECT e.* FROM exercise_log e JOIN workout w USING(activity_id) WHERE w.date BETWEEN ? AND ? ORDER BY w.start_ms,e.exercise",
                        (start, end),
                    )
                ],
            }
        else:
            columns = [
                r[1]
                for r in conn.execute("PRAGMA table_info(day_summary)")
                if r[1] not in ("date", "sleep_hr_min_time", "drinks_json")
            ]
            averages = ",".join(f"AVG({c}) AS {c}" for c in columns)
            values = {
                "months": [
                    dict(r)
                    for r in conn.execute(
                        f"SELECT substr(date,1,7) AS month,COUNT(*) AS days,{averages} FROM day_summary WHERE date BETWEEN ? AND ? GROUP BY month ORDER BY month",
                        (start, end),
                    )
                ],
                "workouts": [
                    dict(r)
                    for r in conn.execute(
                        "SELECT substr(date,1,7) AS month,COUNT(*) AS workouts,SUM(duration_s) AS duration_s FROM workout WHERE date BETWEEN ? AND ? GROUP BY month ORDER BY month",
                        (start, end),
                    )
                ],
                "exercises": [
                    dict(r)
                    for r in conn.execute(
                        "SELECT substr(w.date,1,7) AS month,e.exercise,MAX(e.max_kg) AS max_kg,SUM(e.volume_kg) AS volume_kg FROM exercise_log e JOIN workout w USING(activity_id) WHERE w.date BETWEEN ? AND ? GROUP BY month,e.exercise ORDER BY month,e.exercise",
                        (start, end),
                    )
                ],
            }
        if scope == "7d":
            evaluations = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM evaluation WHERE scope='day' AND report_date BETWEEN ? AND ? ORDER BY report_date",
                (start, end),
            )
        elif scope == "30d":
            evaluations = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM evaluation WHERE scope='7d' AND report_date<=? ORDER BY report_date DESC LIMIT 5",
                (end,),
            )
        else:
            evaluations = _evaluations(
                conn,
                f"SELECT {_EVALUATION_FIELDS} FROM evaluation WHERE scope='30d' AND report_date IN (SELECT MAX(report_date) FROM evaluation WHERE scope='30d' AND report_date<=? GROUP BY substr(report_date,1,7)) ORDER BY report_date",
                (end,),
            )
        previous = _evaluations(
            conn,
            f"SELECT {_EVALUATION_FIELDS} FROM evaluation WHERE scope=? AND report_date<? ORDER BY report_date DESC LIMIT 1",
            (scope, end),
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
