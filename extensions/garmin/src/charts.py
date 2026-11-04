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

from datetime import datetime, time
from zoneinfo import ZoneInfo
import hashlib
import json
import normalize_tables

BACKEND = "Agg"
FONT_FAMILY = ["Apple SD Gothic Neo", "DejaVu Sans"]
FIGURE_SIZE_IN = (12, 6)
DPI = 150
# Bump whenever drawing semantics or renderer code changes.
RENDERER_VERSION = 1


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


_METRIC_COLUMNS = {
    "sleep_s": "sleep_total_s",
    "sleep_score": "sleep_score",
    "hrv_ms": "hrv_avg",
    "resting_hr": "resting_hr",
    "sleep_min_hr": "sleep_hr_min",
    "stress_avg": "stress_avg",
}


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



def _read_raw_chart_data(snapshot, report_date, timezone):
    """Build raw-derived chart data without database I/O."""
    zone = ZoneInfo(timezone)
    items = [{'scope': i['scope'], 'key': i['key'], 'endpoint': i['endpoint'],
              'raw': i.get('raw', i.get('body')), 'fetched_at': i.get('fetched_at', i.get('fetched_at_ms'))}
             for i in snapshot['raw']]
    tables = normalize_tables.normalize_all(items, timezone, snapshot.get('history_start'))
    day = report_date.isoformat()
    yesterday = (report_date - timedelta(days=1)).isoformat()
    start = int(datetime.combine(report_date - timedelta(days=1), time.min, zone).timestamp() * 1000)
    end = int(datetime.combine(report_date, time.min, zone).timestamp() * 1000)
    def samples(table, column):
        chosen = {}
        for row in sorted(tables[table], key=lambda r: (r['ts_ms'], r['day_key'])):
            ts = row['ts_ms']
            if start <= ts < end and (ts not in chosen or row['day_key'] == datetime.fromtimestamp(ts / 1000, zone).date().isoformat()):
                chosen[ts] = row[column]
        return [[ts, value] for ts, value in chosen.items() if value is not None]
    workouts = sorted(tables['workout'], key=lambda r: (r['start_ms'] is not None, r['start_ms'] or 0, r['activity_id']))
    result = {'report_date': day, 'yesterday': {
        'from_ms': start, 'to_ms': end, 'hr': samples('hr_sample', 'bpm'),
        'body_battery': samples('stress_bb_sample', 'level'),
        'sleep': [{'start_ms': r['sleep_start_ms'], 'end_ms': r['sleep_end_ms']} for r in tables['daily_metric']
                  if yesterday <= r['day_key'] <= day and r.get('sleep_start_ms') is not None and r.get('sleep_end_ms') is not None and r['sleep_start_ms'] < end and r['sleep_end_ms'] > start],
        'activities': [{'start_ms': w['start_ms'], 'end_ms': w['start_ms'] + round(w['duration_s'] * 1000)} for w in workouts
                       if w['start_ms'] is not None and w['duration_s'] is not None and w['start_ms'] < end and w['start_ms'] + w['duration_s'] * 1000 > start]}}
    activities = {a['activity_id']: a for a in tables['activity']}
    groups = {}
    for w in sorted(workouts, key=lambda r:(r['start_ms'] is None, r['start_ms'] or 0, r['activity_id'])):
        if yesterday <= w['date'] <= day and w['activity_id'] in activities:
            groups.setdefault((w['date'], w['session_no']), []).append(activities[w['activity_id']])
    sessions = []
    for (d, _), group in groups.items():
        origin = group[0]['start_ms']
        if origin is None: continue
        chosen = {}
        for a in group:
            for sample in sorted((s for s in tables['activity_hr_sample'] if s['activity_id'] == a['activity_id']), key=lambda s:s['ts_ms']):
                chosen.setdefault(sample['ts_ms'], (sample['bpm'], sample['body_battery']))
        sessions.append({'day_key': d, 'start_ms': origin,
                         'start_local': datetime.fromtimestamp(origin / 1000, zone).strftime('%Y-%m-%d %H:%M'),
                         'activity_ids': [a['activity_id'] for a in group],
                         'activities': [{'start_ms': a['start_ms'], 'end_ms': None if a['start_ms'] is None or a['duration_s'] is None else a['start_ms'] + round(a['duration_s'] * 1000),
                                         'zone_low_bpm': [a.get(f'hr_zone{i}_low_bpm') for i in range(1, 6)], 'label': ACTIVITY_TYPE_LABELS.get(a['type_key'], a['type_key'])} for a in group],
                         'hr': [[t, v[0]] for t,v in sorted(chosen.items()) if v[0] is not None],
                         'body_battery': [[t, v[1]] for t,v in sorted(chosen.items()) if v[1] is not None]})
    result['sessions'] = {'items': sorted(sessions, key=lambda i:i['start_ms'])[-2:]}
    by_id = {w['activity_id']: w for w in workouts}
    logs = [e for e in tables['exercise_log'] if e['activity_id'] in by_id]
    recent_logs = sorted(enumerate(logs), key=lambda pair: (by_id[pair[1]['activity_id']]['start_ms'] is not None, by_id[pair[1]['activity_id']]['start_ms'] or 0, pair[0]))
    recent = list(dict.fromkeys(e['exercise'] for _,e in recent_logs if yesterday <= by_id[e['activity_id']]['date'] <= day))
    strength = []
    for exercise in recent:
        days = {}
        for e in logs:
            d = by_id[e['activity_id']]['date']
            if e['exercise'] == exercise and d <= day: days.setdefault(d, []).append(e)
        def sql_sum(values):
            values = [v for v in values if v is not None]
            return sum(values) if values else None
        strength.append({'label': exercise, 'days': [{'day_key': d, 'sets': sql_sum([e['sets'] for e in rows]),
            'best_weight_kg': max((e['max_kg'] for e in rows if e['max_kg'] is not None), default=None),
            'volume_kg': sql_sum([e['volume_kg'] for e in rows])} for d,rows in sorted(days.items())]})
    result['strength_progress'] = {'items': strength}
    summaries = {r['date']: r for r in tables['day_summary']}
    bands = {r['day_key']: r for r in tables['daily_metric']}
    def daily(first, last):
        days = []
        for offset in range((last-first).days+1):
            key = (first + timedelta(days=offset)).isoformat()
            row = summaries.get(key)
            ws = [w for w in workouts if w['date'] == key]
            types = {}
            for w in ws: types[w['type']] = types.get(w['type'], 0) + (w['duration_s'] or 0)
            sessions = list(dict.fromkeys(w['session_no'] for w in ws))
            volume_rows = [e['volume_kg'] for e in logs if by_id[e['activity_id']]['date'] == key]
            volumes = [v for v in volume_rows if v is not None]
            band = bands.get(key, {})
            days.append({'day_key':key, **{k: row.get(col) if row else None for k,col in _METRIC_COLUMNS.items()},
                         'hrv_baseline_low_ms':band.get('hrv_baseline_low'), 'hrv_baseline_high_ms':band.get('hrv_baseline_high'),
                         'workouts': None if row is None else {'sessions':sessions, 'by_type':[{'type_key':k,'label':ACTIVITY_TYPE_LABELS.get(k,k),'duration_s':v} for k,v in sorted(types.items(), key=lambda p:(p[0] is None,p[0] or ''))]},
                         'workout_duration_s':None if row is None else sum(types.values()), 'sessions':None if row is None else len(sessions),
                         'strength_volume_kg':None if row is None else (sum(volumes) if volumes else (None if volume_rows else 0))})
        return {'from':first.isoformat(), 'to':last.isoformat(), 'days':days}
    result['daily'] = daily(report_date-timedelta(days=29), report_date)
    dates = [d for d in [*summaries, *(w['date'] for w in workouts)] if d <= day]
    if dates: result['all'] = _bucket(daily(date.fromisoformat(min(dates)),report_date))
    return result


def read_chart_data(snapshot, measurements, report_date, timezone):
    """Read raw-derived data and the independent body ledger separately."""
    try:
        result = _read_raw_chart_data(snapshot, report_date, timezone)
    except Exception as error:
        logger.warning('charts raw failure: error=%s', type(error).__name__)
        result = {'report_date': report_date.isoformat()}
    try:
        day = report_date.isoformat()
        result['body_measurements'] = {'items':[{'measured_on':m['measured_on'], 'values':m['values']} for m in sorted(measurements,key=lambda m:m['measured_on']) if m['measured_on'] <= day], 'labels':BODY_LABELS}
    except Exception as error:
        logger.warning('charts body failure: error=%s', type(error).__name__)
    return result


def graph_jobs(chart_data):
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
    return jobs

def prepare(home):
    """Set the private matplotlib cache before importing matplotlib."""
    cache = Path(home) / '.matplotlib'
    cache.mkdir(mode=0o700, parents=True, exist_ok=True)
    cache.chmod(0o700)
    os.environ['MPLCONFIGDIR'] = str(cache)
    import matplotlib
    matplotlib.use(BACKEND)
    from matplotlib import font_manager
    face = font_manager.findfont(font_manager.FontProperties(family=FONT_FAMILY))
    return matplotlib.__version__, face


def revision(name, data, version, face):
    # Include only the data used by this graph, so independent changes stay local.
    number = int(name[:2])
    if number == 1: part = data.get('yesterday', {})
    elif number <= 3:
        items = data.get('sessions', {}).get('items', [])
        part = items[number - 2] if len(items) >= number - 1 else None
    elif number <= 49:
        items = data.get('strength_progress', {}).get('items', [])
        part = {'item':items[number-4], 'report_date':data['report_date']} if len(items) >= number-3 else None
    elif number <= 53:
        source = data.get('daily', {})
        keys = {50:('sleep_s','sleep_score'), 51:('hrv_ms','hrv_baseline_low_ms','hrv_baseline_high_ms'),
                52:('resting_hr','sleep_min_hr','stress_avg'), 53:('workouts',)}[number]
        part = {k:v for k,v in source.items() if k != 'days'} | {'days':[{k:d.get(k) for k in ('day_key', *keys)} for d in source.get('days', [])]}
    elif number <= 58:
        source = data.get('all', {})
        metrics = {54:_SLEEP, 55:_HRV, 56:_HEART, 57:_WORKOUTS, 58:_VOLUME}[number]
        part = {k:v for k,v in source.items() if k != 'metrics'} | {'metrics':{k:source.get('metrics', {}).get(k, []) for k,*_ in metrics}}
    else:
        source = data.get('body_measurements', {})
        part = {'labels': {k:source.get('labels', {}).get(k) for k in _BODY}, 'reason':source.get('reason'),
                'items':[{'measured_on':i['measured_on'], 'values':{k:i['values'].get(k) for k in _BODY}} for i in source.get('items', [])]}
    value = {'name':name, 'data':part, 'figure_size':FIGURE_SIZE_IN, 'dpi':DPI,
             'backend':BACKEND, 'font_family':FONT_FAMILY, 'unicode_minus':False,
             'matplotlib':version, 'face':face, 'renderer_version':RENDERER_VERSION}
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()).hexdigest()


def render_one(home, name, size, draw, warning_records=None):
    """Render one graph privately; return (path, title), None for absent data."""
    prepare(home)
    import matplotlib
    from matplotlib.figure import Figure
    import tempfile
    directory = Path(home) / 'graph-work'
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    path = None
    figure = None
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        try:
            with matplotlib.rc_context({'font.family':FONT_FAMILY, 'axes.unicode_minus':False}):
                figure = Figure(figsize=size, dpi=DPI)
                if not draw(figure): return None
                figure.tight_layout()
                fd, filename = tempfile.mkstemp(prefix='graph-', suffix='.png', dir=directory)
                path = Path(filename)
                os.fchmod(fd, 0o600)
                os.close(fd)
                figure.savefig(path, format='png', dpi=DPI)
                if path.stat().st_size > 10_000_000: raise ValueError('PNG size limit')
                return path, figure.axes[0].get_title()
        except Exception:
            if path is not None: path.unlink(missing_ok=True)
            raise
        finally:
            if figure is not None: figure.clear()
            if warning_records is not None: warning_records.extend(caught)
            if caught:
                logger.warning('charts warning: graph=%s count=%d category=%s',name,len(caught),caught[0].category.__name__)
