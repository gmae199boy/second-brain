"""Select the fixed history and workout window consumed by the pure digest."""
from datetime import datetime, time, timedelta, timezone
import json
import math
from zoneinfo import ZoneInfo


def _moment(value):
    if type(value) in (int,float) and math.isfinite(value):
        return datetime.fromtimestamp(value/1000,timezone.utc)
    if not isinstance(value,str): return None
    dt = datetime.fromisoformat(value)
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def prepare(raw, report_day, cutoff_ms, zone, previous_cutoff_ms=None):
    tz = ZoneInfo(zone)
    first = report_day - timedelta(days=30)
    cutoff = datetime.fromtimestamp(cutoff_ms/1000,timezone.utc)
    window = (datetime.fromtimestamp(previous_cutoff_ms/1000,timezone.utc)
              if previous_cutoff_ms is not None
              else datetime.combine(report_day-timedelta(days=1),time(11),tz).astimezone(timezone.utc))
    days, all_activities, notes = {}, {}, []
    invalid_activity = {}
    for item in raw:
        scope,key,endpoint = item['scope'],item['key'],item['endpoint']
        if scope == 'day':
            try: day = datetime.fromisoformat(key).date()
            except (TypeError,ValueError): continue
            if not first <= day <= report_day or (day == report_day and endpoint in ('user_summary','body_battery')): continue
        elif scope != 'activity' or not isinstance(key,str) or not key.isascii() or not key.isdecimal():
            continue
        try: payload=json.loads(item['body'])
        except (ValueError,TypeError):
            if scope == 'day': notes.append(f'{key} {endpoint}: 원본 JSON이 잘못됐다')
            else: invalid_activity.setdefault(key,[]).append(endpoint)
            continue
        if scope == 'day':
            if day == report_day and isinstance(payload,dict):
                keys = ('stressValuesArray','bodyBatteryValuesArray') if endpoint == 'stress_data' else (('heartRateValues',) if endpoint == 'heart_rates' else ())
                for column in keys:
                    if isinstance(payload.get(column),list):
                        payload[column] = [row for row in payload[column] if isinstance(row,list) and row and type(row[0]) in (int,float) and row[0] < cutoff_ms]
            days.setdefault(key,{})[endpoint] = payload
        elif scope == 'activity':
            all_activities.setdefault(key,{})[endpoint] = payload
    starts, completed = [], []
    for key,endpoints in all_activities.items():
        try:
            summary = endpoints['activity']['summaryDTO']
            if not isinstance(summary, dict): continue
            start = _moment(summary.get('startTimeGMT'))
            duration = summary.get('duration')
            if start is None or not first <= start.astimezone(tz).date() <= report_day or start >= cutoff: continue
            starts.append(int(start.timestamp()*1000))
            if type(duration) not in (int,float) or not math.isfinite(duration) or duration < 0: continue
            if start + timedelta(seconds=duration) >= cutoff: continue
            completed.append((start,key,endpoints))
        except (KeyError,TypeError,ValueError,OverflowError,OSError):
            continue
    completed.sort(key=lambda item:(item[0],item[1]))
    activities={key:endpoints for _,key,endpoints in completed}
    for _,key,_ in completed:
        notes.extend(f'운동 {key} {endpoint}: 원본 JSON이 잘못됐다' for endpoint in invalid_activity.get(key,[]))
    workouts=[key for start,key,_ in completed if start >= window]
    return days,activities,workouts,sorted(starts),notes
