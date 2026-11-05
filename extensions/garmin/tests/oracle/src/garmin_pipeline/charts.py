"""파생 DB·체성분 장부를 읽어 앨범 '오늘·운동'·'추세'를 그린다(AD-18).

matplotlib은 render 안에서만 로드한다. 시각은 변환하지 않고 시작부터의 상대
시간을 쓰며, 수치는 저장된 값을 그대로 그린다. 출력 폴더는 호출자가 준비한다.
각 그래프의 실패·경고는 값이나 라벨 없이 기록하고 나머지 그래프는 계속한다.
"""

import calendar
import contextlib
import logging
import math
import os
import re
import warnings
from datetime import date, timedelta
from fractions import Fraction
from pathlib import Path
from typing import NamedTuple

from garmin_pipeline import body, config, dates, store

BACKEND = "Agg"
FONT_FAMILY = ["Apple SD Gothic Neo", "DejaVu Sans"]
FIGURE_SIZE_IN = (12, 6)
DPI = 150


class Graph(NamedTuple):
    """실제로 그린 PNG 이름과 그림 제목."""

    name: str
    title: str


logger = logging.getLogger(__name__)


def _line(ax, samples, origin, unit, **kwargs):
    if samples:
        ax.plot(
            [(sample[0] - origin) / unit for sample in samples],
            [sample[1] for sample in samples],
            **kwargs,
        )


def _battery(ax, samples, origin, unit):
    right = ax.twinx()
    right.set_ylabel("바디 배터리")
    right.set_ylim(0, 100)
    _line(right, samples, origin, unit, color="tab:green", label="Body Battery")
    return right


def _legend(ax, right=None):
    handles, labels = ax.get_legend_handles_labels()
    if right is not None:
        other_handles, other_labels = right.get_legend_handles_labels()
        handles += other_handles
        labels += other_labels
    unique = dict(zip(labels, handles))
    ax.legend(unique.values(), unique.keys())


def _yesterday(figure, chart_data):
    part = chart_data.get("yesterday", {})
    if part.get("reason") == "failed" or not (
        part.get("hr") or part.get("body_battery")
    ):
        return False
    ax = figure.subplots()
    origin, end = part["from_ms"], part["to_ms"]
    unit = 3_600_000
    ax.set(
        title="어제 하루",
        xlabel="시간 (시)",
        ylabel="심박 (bpm)",
        xlim=(0, (end - origin) / unit),
    )
    _line(ax, part["hr"], origin, unit, color="tab:red", label="심박")
    right = _battery(ax, part["body_battery"], origin, unit)
    for key, color in [("sleep", "tab:blue"), ("activities", "tab:orange")]:
        for item in part[key]:
            start, stop = max(origin, item["start_ms"]), min(end, item["end_ms"])
            if start < stop:
                ax.axvspan(
                    (start - origin) / unit,
                    (stop - origin) / unit,
                    color=color,
                    alpha=0.15,
                    label="수면" if key == "sleep" else "운동",
                )
    _legend(ax, right)
    return True


def _session(figure, item, number):
    if not item.get("hr"):
        return False
    origin, unit = item["start_ms"], 60_000
    ax = figure.subplots()
    title = f"운동 세션 {number}"
    if item.get("start_local"):
        title += f" · {item['start_local']}"
    ax.set(title=title, xlabel="시간 (분)", ylabel="심박 (bpm)")
    _line(ax, item["hr"], origin, unit, color="tab:red", label="심박")
    # Fix limits before shading so bands cannot change the data scale.
    bottom, top = ax.get_ylim()
    ax.set_ylim(bottom, top)
    colors = ["tab:blue", "tab:green", "gold", "tab:orange", "tab:red"]
    for activity in item["activities"]:
        start = (activity["start_ms"] - origin) / unit
        ax.axvline(start, color="grey", linewidth=0.8)
        if activity.get("label") is not None:
            ax.text(
                start,
                0.98,
                activity["label"],
                transform=ax.get_xaxis_transform(),
                va="top",
                fontsize=9,
            )
        if activity["end_ms"] is None:
            continue
        stop = (activity["end_ms"] - origin) / unit
        ax.axvline(stop, color="grey", linewidth=0.8)
        lows = activity["zone_low_bpm"]
        for i, low in enumerate(lows):
            high = lows[i + 1] if i < 4 else top
            if low is not None and high is not None:
                ax.fill_between(
                    [start, stop],
                    low,
                    high,
                    color=colors[i],
                    alpha=0.12,
                    label=f"존 {i + 1}",
                )
    right = _battery(ax, item["body_battery"], origin, unit)
    _legend(ax, right)
    return True


def _strength(figure, item, report_date):
    days = item["days"]
    if not days:
        return False
    end = date.fromisoformat(report_date)
    start = end - timedelta(days=30)
    ax = figure.subplots()
    xs = [date.fromisoformat(day["day_key"]) for day in days]
    ax.set(title=f"근력 진행 · {item['label']}", xlabel="날짜")
    ax.axvspan(start, end, color="tab:blue", alpha=0.1, label="최근 30일")
    right = None
    if all(d["best_weight_kg"] is None and d["volume_kg"] is None for d in days):
        ax.set_ylabel("세트 수")
        ax.bar(
            xs, [d["sets"] for d in days], color="tab:blue", alpha=0.5, label="세트 수"
        )
    else:
        ax.set_ylabel("최고 무게 (kg)")
        ax.plot(
            xs,
            [
                float("nan") if d["best_weight_kg"] is None else d["best_weight_kg"]
                for d in days
            ],
            marker="o",
            color="tab:blue",
            label="최고 무게",
        )
        right = ax.twinx()
        right.set_ylabel("볼륨 (kg)")
        right.bar(
            xs,
            [float("nan") if d["volume_kg"] is None else d["volume_kg"] for d in days],
            color="tab:orange",
            alpha=0.3,
            label="볼륨",
        )
    ax.tick_params(axis="x", labelrotation=30)
    _legend(ax, right)
    return True


# Metric tuples: file key, independent metric label, unit divisor, right axis.
_SLEEP = [("sleep_s", "수면 시간", 3600, False), ("sleep_score", "수면 점수", 1, True)]
_HRV = [("hrv_ms", "HRV", 1, False)]
_HEART = [
    ("resting_hr", "안정 심박", 1, False),
    ("sleep_min_hr", "수면 중 최저 심박", 1, False),
    ("stress_avg", "스트레스 평균", 1, True),
]
_WORKOUTS = [
    ("workout_duration_s", "운동 시간", 60, False),
    ("sessions", "세션 수", 1, True),
]
_VOLUME = [("strength_volume_kg", "근력 볼륨", 1, False)]
_BODY = ("weight_kg", "skeletal_muscle_mass_kg", "body_fat_mass_kg", "body_fat_percent")


def _value(value, divisor=1):
    return float("nan") if value is None else value / divisor


def _date_axes(figure, title, ylabel, right_label=None, bounded=False):
    ax = figure.subplots()
    ax.set(title=title, xlabel="날짜", ylabel=ylabel)
    ax.tick_params(axis="x", labelrotation=30)
    right = ax.twinx() if right_label else None
    if right is not None:
        right.set_ylabel(right_label)
        if bounded:
            right.set_ylim(0, 100)
    return ax, right


def _daily_trend(figure, chart_data, metrics, title, ylabel, right_label=None):
    part = chart_data.get("daily", {})
    days = part.get("days", [])
    if (
        part.get("reason") == "failed"
        or sum(any(day[key] is not None for key, *_ in metrics) for day in days) < 2
    ):
        return False
    ax, right = _date_axes(figure, title, ylabel, right_label, bounded=True)
    xs = [date.fromisoformat(day["day_key"]) for day in days]
    for i, (key, label, divisor, secondary) in enumerate(metrics):
        target = right if secondary else ax
        ys = [_value(day[key], divisor) for day in days]
        if key == "sleep_s":
            target.bar(xs, ys, color="tab:blue", alpha=0.4, label=label)
        else:
            target.plot(xs, ys, marker="o", markersize=3, color=f"C{i}", label=label)
    if metrics == _HRV:
        ax.fill_between(
            xs,
            [_value(day["hrv_baseline_low_ms"]) for day in days],
            [_value(day["hrv_baseline_high_ms"]) for day in days],
            alpha=0.2,
            label="기준 범위",
        )
    ax.set_xlim(
        ax.convert_xunits(date.fromisoformat(part["from"])) - 0.5,
        ax.convert_xunits(date.fromisoformat(part["to"])) + 0.5,
    )
    _legend(ax, right)
    return True


def _daily_workouts(figure, chart_data):
    from matplotlib.ticker import MaxNLocator

    part = chart_data.get("daily", {})
    days = part.get("days", [])
    if (
        part.get("reason") == "failed"
        or sum(day["workouts"] is not None for day in days) < 2
        or not any(day["workouts"] and day["workouts"]["sessions"] for day in days)
    ):
        return False
    ax, right = _date_axes(figure, "운동 30일", "운동 시간 (분)", "세션 수 (회)")
    xs = [date.fromisoformat(day["day_key"]) for day in days]
    types = {}
    for day in days:
        if day["workouts"] is not None:
            for item in day["workouts"]["by_type"]:
                types.setdefault(item["type_key"], item["label"])
    bottom = [0.0] * len(days)
    for kind, label in types.items():
        heights = [
            sum(
                item["duration_s"] / 60
                for item in day["workouts"]["by_type"]
                if item["type_key"] == kind
            )
            if day["workouts"] is not None
            else 0
            for day in days
        ]
        known = [i for i, day in enumerate(days) if day["workouts"] is not None]
        ax.bar(
            [xs[i] for i in known],
            [heights[i] for i in known],
            bottom=[bottom[i] for i in known],
            label=label if label is not None else "종류 미상",
        )
        bottom = [a + b for a, b in zip(bottom, heights)]
    right.plot(
        xs,
        [
            len(day["workouts"]["sessions"])
            if day["workouts"] is not None
            else float("nan")
            for day in days
        ],
        linestyle="none",
        marker="o",
        color="black",
        label="세션 수",
    )
    for x, day in zip(xs, days):
        if day["workouts"] is None:
            ax.axvspan(
                ax.convert_xunits(x) - 0.5,
                ax.convert_xunits(x) + 0.5,
                color="grey",
                alpha=0.2,
                label="기록 못 받음",
            )
    right.yaxis.set_major_locator(MaxNLocator(integer=True))
    right.set_ylim(bottom=0)
    ax.set_xlim(
        ax.convert_xunits(date.fromisoformat(part["from"])) - 0.5,
        ax.convert_xunits(date.fromisoformat(part["to"])) + 0.5,
    )
    _legend(ax, right)
    return True


def _all_trend(
    figure, chart_data, metrics, title, ylabel, right_label=None, bounded=False
):
    part = chart_data.get("all", {})
    values = part.get("metrics", {})
    present = {
        (bucket["from"], bucket["to"])
        for key, *_ in metrics
        for bucket in values.get(key, [])
        if bucket["mean"] is not None
    }
    if part.get("reason") == "failed" or len(present) < 2:
        return False
    ax, right = _date_axes(figure, title, ylabel, right_label, bounded)
    for i, (key, label, divisor, secondary) in enumerate(metrics):
        buckets = values.get(key, [])
        xs = [
            date.fromisoformat(b["from"])
            + (date.fromisoformat(b["to"]) - date.fromisoformat(b["from"])) / 2
            for b in buckets
        ]
        target = right if secondary else ax
        target.plot(
            xs,
            [_value(b["mean"], divisor) for b in buckets],
            marker="o",
            markersize=3,
            color=f"C{i}",
            label=label,
        )
        if part["unit"] == "month":
            target.fill_between(
                xs,
                [_value(b["min"], divisor) for b in buckets],
                [_value(b["max"], divisor) for b in buckets],
                color=f"C{i}",
                alpha=0.15,
            )
    ax.set_xlim(date.fromisoformat(part["from"]), date.fromisoformat(part["to"]))
    _legend(ax, right)
    return True


def _body_trend(figure, chart_data):
    part = chart_data.get("body_measurements", {})
    items = part.get("items", [])
    if (
        part.get("reason") == "failed"
        or sum(
            any(item["values"].get(key) is not None for key in _BODY) for item in items
        )
        < 2
    ):
        return False
    ax, right = _date_axes(figure, "인바디 추이", "질량 (kg)", "비율 (%)")
    for i, key in enumerate(_BODY):
        measurements = [item for item in items if item["values"].get(key) is not None]
        if not measurements:
            continue
        target = right if key == "body_fat_percent" else ax
        target.plot(
            [date.fromisoformat(item["measured_on"]) for item in measurements],
            [item["values"][key] for item in measurements],
            marker="o",
            color=f"C{i}",
            label=part["labels"][key],
        )
    _legend(ax, right)
    return True


ACTIVITY_TYPE_LABELS = {
    "running": "달리기",
    "treadmill_running": "트레드밀 달리기",
    "trail_running": "트레일 러닝",
    "walking": "걷기",
    "hiking": "하이킹",
    "cycling": "사이클링",
    "indoor_cycling": "실내 사이클링",
    "strength_training": "근력 운동",
    "lap_swimming": "수영",
    "open_water_swimming": "오픈워터 수영",
    "yoga": "요가",
    "hiit": "HIIT",
}

BODY_LABELS = {
    "weight_kg": "체중 (kg)",
    "skeletal_muscle_mass_kg": "골격근량 (kg)",
    "body_fat_mass_kg": "체지방량 (kg)",
    "body_fat_percent": "체지방률 (%)",
    "bmi": "BMI",
    "total_body_water_l": "체수분 (L)",
    "protein_kg": "단백질 (kg)",
    "minerals_kg": "무기질 (kg)",
    "basal_metabolic_rate_kcal": "기초대사량 (kcal)",
    "visceral_fat_level": "내장지방 레벨",
    "inbody_score": "인바디 점수",
}


def _samples(conn, cfg, table, column, start, end):
    chosen = {}
    for day, ts, value in conn.execute(
        f"SELECT day_key, ts_ms, {column} FROM {table}"
        " WHERE ts_ms >= ? AND ts_ms < ? ORDER BY ts_ms, day_key",
        (start, end),
    ):
        if ts not in chosen or day == dates.day_key(ts, cfg):
            chosen[ts] = (day, value)
    return [[ts, value] for ts, (_, value) in chosen.items() if value is not None]


def _read_yesterday(conn, cfg, report_date):
    yesterday = report_date - timedelta(days=1)
    start, end = (
        dates.day_start_ms(yesterday, cfg),
        dates.day_start_ms(report_date, cfg),
    )
    return {
        "from_ms": start,
        "to_ms": end,
        "hr": _samples(conn, cfg, "hr_sample", "bpm", start, end),
        "body_battery": _samples(conn, cfg, "stress_bb_sample", "level", start, end),
        "sleep": [
            {"start_ms": a, "end_ms": b}
            for a, b in conn.execute(
                "SELECT sleep_start_ms, sleep_end_ms FROM daily_metric WHERE day_key BETWEEN ? AND ?"
                " AND sleep_start_ms < ? AND sleep_end_ms > ?",
                (yesterday.isoformat(), report_date.isoformat(), end, start),
            )
        ],
        "activities": [
            {"start_ms": a, "end_ms": a + round(b * 1000)}
            for a, b in conn.execute(
                "SELECT start_ms, duration_s FROM workout WHERE start_ms < ?"
                " AND start_ms + duration_s * 1000 > ? ORDER BY start_ms",
                (end, start),
            )
        ],
    }


def _read_sessions(conn, cfg, report_date):
    columns = ["activity_id", "type_key", "start_ms", "duration_s"] + [
        f"hr_zone{i}_low_bpm" for i in range(1, 6)
    ]
    groups = {}
    for row in conn.execute(
        "SELECT w.date, w.session_no, "
        + ", ".join("a." + c for c in columns)
        + " FROM workout w JOIN activity a USING(activity_id) WHERE w.date BETWEEN ? AND ?"
        " ORDER BY w.start_ms IS NULL, w.start_ms, w.activity_id",
        ((report_date - timedelta(days=1)).isoformat(), report_date.isoformat()),
    ):
        groups.setdefault(tuple(row[:2]), []).append(
            dict(zip(columns, row[2:], strict=True))
        )
    items = []
    for (day, _), group in groups.items():
        start = group[0]["start_ms"]
        if start is None:
            continue
        chosen = {}
        activities = []
        for item in group:
            for ts, bpm, bb in conn.execute(
                "SELECT ts_ms, bpm, body_battery FROM activity_hr_sample WHERE activity_id = ? ORDER BY ts_ms",
                (item["activity_id"],),
            ):
                chosen.setdefault(ts, (bpm, bb))
            activities.append(
                {
                    "start_ms": item["start_ms"],
                    "end_ms": None
                    if item["start_ms"] is None or item["duration_s"] is None
                    else item["start_ms"] + round(item["duration_s"] * 1000),
                    "zone_low_bpm": [item[f"hr_zone{i}_low_bpm"] for i in range(1, 6)],
                    "label": ACTIVITY_TYPE_LABELS.get(
                        item["type_key"], item["type_key"]
                    ),
                }
            )
        items.append(
            {
                "day_key": day,
                "start_ms": start,
                "start_local": dates.local_minute(start, cfg),
                "activity_ids": [item["activity_id"] for item in group],
                "activities": activities,
                "hr": [
                    [ts, pair[0]]
                    for ts, pair in sorted(chosen.items())
                    if pair[0] is not None
                ],
                "body_battery": [
                    [ts, pair[1]]
                    for ts, pair in sorted(chosen.items())
                    if pair[1] is not None
                ],
            }
        )
    return {"items": sorted(items, key=lambda item: item["start_ms"])[-2:]}


def _read_strength(conn, report_date):
    exercises = dict.fromkeys(
        row[0]
        for row in conn.execute(
            "SELECT e.exercise FROM exercise_log e JOIN workout w USING(activity_id)"
            " WHERE w.date BETWEEN ? AND ? ORDER BY w.start_ms, e.rowid",
            ((report_date - timedelta(days=1)).isoformat(), report_date.isoformat()),
        )
    )
    return {
        "items": [
            {
                "label": exercise,
                "days": [
                    dict(
                        zip(
                            ("day_key", "sets", "best_weight_kg", "volume_kg"),
                            row,
                            strict=True,
                        )
                    )
                    for row in conn.execute(
                        "SELECT w.date, SUM(e.sets), MAX(e.max_kg), SUM(e.volume_kg)"
                        " FROM exercise_log e JOIN workout w USING(activity_id)"
                        " WHERE e.exercise = ? AND w.date <= ? GROUP BY w.date ORDER BY w.date",
                        (exercise, report_date.isoformat()),
                    )
                ],
            }
            for exercise in exercises
        ]
    }


_METRIC_COLUMNS = {
    "sleep_s": "sleep_total_s",
    "sleep_score": "sleep_score",
    "hrv_ms": "hrv_avg",
    "resting_hr": "resting_hr",
    "sleep_min_hr": "sleep_hr_min",
    "stress_avg": "stress_avg",
}


def _read_daily(conn, first, last):
    values = {
        row[0]: dict(zip(_METRIC_COLUMNS, row[1:], strict=True))
        for row in conn.execute(
            "SELECT date, "
            + ", ".join(_METRIC_COLUMNS.values())
            + " FROM day_summary WHERE date BETWEEN ? AND ?",
            (first.isoformat(), last.isoformat()),
        )
    }
    bands = {
        row[0]: row[1:]
        for row in conn.execute(
            "SELECT day_key, hrv_baseline_low, hrv_baseline_high FROM daily_metric WHERE day_key BETWEEN ? AND ?",
            (first.isoformat(), last.isoformat()),
        )
    }
    workouts = {}
    for day, kind, duration, session_no in conn.execute(
        "SELECT date, type, duration_s, session_no FROM workout WHERE date BETWEEN ? AND ? ORDER BY start_ms, activity_id",
        (first.isoformat(), last.isoformat()),
    ):
        workouts.setdefault(day, []).append((kind, duration, session_no))
    volumes = dict(
        conn.execute(
            "SELECT w.date, SUM(e.volume_kg) FROM exercise_log e JOIN workout w USING(activity_id) WHERE w.date BETWEEN ? AND ? GROUP BY w.date",
            (first.isoformat(), last.isoformat()),
        )
    )
    days = []
    day = first
    while day <= last:
        key = day.isoformat()
        row = values.get(key, dict.fromkeys(_METRIC_COLUMNS))
        types = {}
        for kind, duration, _ in workouts.get(key, []):
            types[kind] = types.get(kind, 0) + (duration or 0)
        sessions = list(dict.fromkeys(item[2] for item in workouts.get(key, [])))
        days.append(
            {
                "day_key": key,
                **row,
                "hrv_baseline_low_ms": bands.get(key, (None, None))[0],
                "hrv_baseline_high_ms": bands.get(key, (None, None))[1],
                "workouts": None
                if key not in values
                else {
                    "sessions": sessions,
                    "by_type": [
                        {
                            "type_key": kind,
                            "label": ACTIVITY_TYPE_LABELS.get(kind, kind),
                            "duration_s": duration,
                        }
                        for kind, duration in sorted(
                            types.items(),
                            key=lambda pair: (pair[0] is None, pair[0] or ""),
                        )
                    ],
                },
                "workout_duration_s": None
                if key not in values
                else sum(types.values()),
                "sessions": None if key not in values else len(sessions),
                "strength_volume_kg": None
                if key not in values
                else volumes.get(key, 0),
            }
        )
        day += timedelta(days=1)
    return {"from": first.isoformat(), "to": last.isoformat(), "days": days}


def _add_months(day, months):
    year, month = divmod(day.year * 12 + day.month - 1 + months, 12)
    month += 1
    return date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _bucket(daily):
    first, last = date.fromisoformat(daily["from"]), date.fromisoformat(daily["to"])
    unit = "week" if last <= _add_months(first, 6) else "month"
    metrics = {
        key: []
        for key in (
            *_METRIC_COLUMNS,
            "workout_duration_s",
            "sessions",
            "strength_volume_kg",
        )
    }
    start, offset = first, 0
    while start <= last:
        next_start = (
            start + timedelta(days=7 - start.weekday())
            if unit == "week"
            else _add_months(start.replace(day=1), 1)
        )
        end = min(last, next_start - timedelta(days=1))
        count = (end - start).days + 1
        for key, buckets in metrics.items():
            values = [
                day[key]
                for day in daily["days"][offset : offset + count]
                if day[key] is not None
            ]
            mean = None
            if values:
                average = sum(
                    (Fraction(str(value)) for value in values), Fraction()
                ) / len(values)
                scale = 1 if key.endswith("_s") else 10
                magnitude = math.floor(abs(average) * scale + Fraction(1, 2))
                mean = Fraction(magnitude if average >= 0 else -magnitude, scale)
                mean = int(mean) if key.endswith("_s") else float(mean)
            item = {
                "from": start.isoformat(),
                "to": end.isoformat(),
                "days": len(values),
                "mean": mean,
            }
            if unit == "month":
                item.update(
                    min=min(values) if values else None,
                    max=max(values) if values else None,
                )
            buckets.append(item)
        start, offset = next_start, offset + count
    return {"from": daily["from"], "to": daily["to"], "unit": unit, "metrics": metrics}


def _read_body(cfg, report_date):
    directory = body.body_dir(cfg)
    if not directory.exists():
        return {"items": [], "labels": BODY_LABELS}
    schema = body.load_schema()
    items = []
    for path in sorted(directory.iterdir()):
        if path.name.startswith(".") or not re.fullmatch(
            r"[0-9]{4}-[0-9]{2}-[0-9]{2}\.json", path.name
        ):
            continue
        try:
            day = date.fromisoformat(path.stem)
            if day > report_date:
                continue
            doc = body.read_sidecar(schema, path, day)
            if doc is not None:
                items.append({"measured_on": day.isoformat(), "values": doc["values"]})
        except (ValueError, OSError, body.BodyError) as error:
            logger.warning("charts 장부 제외: error=%s", type(error).__name__)
    return {"items": items, "labels": BODY_LABELS}


def _read_chart_data(cfg, report_date):
    result = {"report_date": report_date.isoformat()}
    try:
        with (
            contextlib.closing(store.read_connection(cfg)) as conn,
            store.transaction(conn),
        ):
            result["yesterday"] = _read_yesterday(conn, cfg, report_date)
            result["sessions"] = _read_sessions(conn, cfg, report_date)
            result["strength_progress"] = _read_strength(conn, report_date)
            result["daily"] = _read_daily(
                conn, report_date - timedelta(days=29), report_date
            )
            first = conn.execute(
                "SELECT MIN(date) FROM (SELECT date FROM day_summary UNION ALL SELECT date FROM workout) WHERE date <= ?",
                (report_date.isoformat(),),
            ).fetchone()[0]
            if first is not None:
                result["all"] = _bucket(
                    _read_daily(conn, date.fromisoformat(first), report_date)
                )
    except Exception as error:  # noqa: BLE001 - DB failure must not block the ledger
        logger.warning("charts DB 실패: error=%s", type(error).__name__)
        result = {"report_date": report_date.isoformat()}
    try:
        result["body_measurements"] = _read_body(cfg, report_date)
    except Exception as error:  # noqa: BLE001 - ledger failure must not block DB graphs
        logger.warning("charts 장부 실패: error=%s", type(error).__name__)
    return result


def render(cfg: config.Config, report_date: date, out_dir: Path) -> list[Graph]:
    """빈 out_dir에 PNG(0600)를 쓰고 성공한 Graph만 번호 순으로 돌려준다."""
    chart_data = _read_chart_data(cfg, report_date)

    jobs = [
        ("01-yesterday.png", FIGURE_SIZE_IN, lambda fig: _yesterday(fig, chart_data))
    ]
    sessions = chart_data.get("sessions", {})
    if sessions.get("reason") != "failed":
        items = sessions.get("items", [])
        valid = [item for item in items if item.get("start_ms") is not None]
        if len(valid) != len(items):
            logger.info("charts 세션 제외: count=%d", len(items) - len(valid))
        items = sorted(valid, key=lambda item: item["start_ms"])[-2:]
        for number, item in enumerate(items, 1):
            jobs.append(
                (
                    f"{number + 1:02d}-session-{number}.png",
                    FIGURE_SIZE_IN,
                    lambda fig, item=item, number=number: _session(fig, item, number),
                )
            )
    strength = chart_data.get("strength_progress", {})
    if strength.get("reason") != "failed":
        items = strength.get("items", [])
        if len(items) > 46:
            logger.info("charts 근력 초과: count=%d", len(items) - 46)
        for number, item in enumerate(items[:46], 1):
            jobs.append(
                (
                    f"{number + 3:02d}-strength-{number}.png",
                    FIGURE_SIZE_IN,
                    lambda fig, item=item: _strength(
                        fig, item, chart_data["report_date"]
                    ),
                )
            )
    for name, metrics, title, ylabel, right_label in [
        ("50-sleep-30d.png", _SLEEP, "수면 30일", "수면 시간 (시간)", "수면 점수"),
        ("51-hrv-30d.png", _HRV, "HRV 30일", "HRV (ms)", None),
        (
            "52-heart-30d.png",
            _HEART,
            "심박·스트레스 30일",
            "심박 (bpm)",
            "스트레스 평균",
        ),
    ]:
        jobs.append(
            (
                name,
                FIGURE_SIZE_IN,
                lambda fig, metrics=metrics, title=title, ylabel=ylabel, right_label=right_label: (
                    _daily_trend(fig, chart_data, metrics, title, ylabel, right_label)
                ),
            )
        )
    jobs.append(
        (
            "53-workouts-30d.png",
            FIGURE_SIZE_IN,
            lambda fig: _daily_workouts(fig, chart_data),
        )
    )
    for name, metrics, title, ylabel, right_label, bounded in [
        (
            "54-sleep-all.png",
            _SLEEP,
            "수면 전체",
            "수면 시간 (시간)",
            "수면 점수",
            True,
        ),
        ("55-hrv-all.png", _HRV, "HRV 전체", "HRV (ms)", None, False),
        (
            "56-heart-all.png",
            _HEART,
            "심박·스트레스 전체",
            "심박 (bpm)",
            "스트레스 평균",
            True,
        ),
        (
            "57-workouts-all.png",
            _WORKOUTS,
            "운동 전체",
            "하루 평균 운동 시간 (분)",
            "하루 평균 세션 수 (회)",
            False,
        ),
        (
            "58-strength-all.png",
            _VOLUME,
            "근력 볼륨 전체",
            "하루 평균 볼륨 (kg)",
            None,
            False,
        ),
    ]:
        jobs.append(
            (
                name,
                FIGURE_SIZE_IN,
                lambda fig, metrics=metrics, title=title, ylabel=ylabel, right_label=right_label, bounded=bounded: (
                    _all_trend(
                        fig, chart_data, metrics, title, ylabel, right_label, bounded
                    )
                ),
            )
        )
    jobs.append(
        ("59-body.png", FIGURE_SIZE_IN, lambda fig: _body_trend(fig, chart_data))
    )
    drawn = []
    for name, size, draw in jobs:
        path = out_dir / name
        figure = None
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            try:
                cache = cfg.data_dir / ".matplotlib"
                cache.mkdir(mode=0o700, parents=True, exist_ok=True)
                cache.chmod(0o700)
                os.environ["MPLCONFIGDIR"] = str(cache)
                import matplotlib
                from matplotlib.figure import Figure

                matplotlib.use(BACKEND)
                with matplotlib.rc_context(
                    {"font.family": FONT_FAMILY, "axes.unicode_minus": False}
                ):
                    figure = Figure(figsize=size, dpi=DPI)
                    if not draw(figure):
                        logger.info("charts 그래프 없음: graph=%s", name)
                        continue
                    figure.tight_layout()
                    # Create privately before the renderer opens the file.
                    with path.open("xb"):
                        path.chmod(0o600)
                    figure.savefig(path, format="png", dpi=DPI)
                    if path.stat().st_size > 10_000_000:
                        raise ValueError("PNG size limit")
                    drawn.append(Graph(name, figure.axes[0].get_title()))
            except Exception as error:  # noqa: BLE001 - 그래프별 실패를 격리한다
                logger.warning(
                    "charts 그래프 실패: graph=%s error=%s", name, type(error).__name__
                )
                with contextlib.suppress(OSError):
                    path.unlink(missing_ok=True)
            finally:
                if figure is not None:
                    figure.clear()
                if caught:
                    logger.warning(
                        "charts 경고: graph=%s count=%d category=%s",
                        name,
                        len(caught),
                        caught[0].category.__name__,
                    )
    logger.info("charts 끝: drawn=%d", len(drawn))
    return drawn
