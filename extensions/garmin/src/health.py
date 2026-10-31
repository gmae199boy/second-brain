"""공유 건강 계약의 부작용 없는 판정과 원본 열 변환."""
from datetime import datetime
from decimal import Decimal
import json
import math
import re
from reader import SQLiteText, InvalidSQLiteText


def _instant(value):
    match = re.fullmatch(r'(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d+))?(Z|[+-]\d\d:\d\d)', value)
    if not match:
        raise ValueError('HEALTH_INVALID_OBSERVATION')
    dt = datetime.fromisoformat(match[1] + match[3].replace('Z', '+00:00'))
    return (int(dt.timestamp()), Decimal('0.' + (match[2] or '0')))


def resolve(rows, supported_versions, authority=None):
    ordered = sorted(rows, key=lambda row: row['id'])
    def result(reason, selected=(), current=None):
        ids = [row['id'] for row in selected]
        return {'current': current['id'] if current else None, 'reason': reason, 'selected': ids,
                'unselected': [row['id'] for row in ordered if row['id'] not in ids],
                'authorityVersion': authority['version'] if authority else None}
    if not ordered:
        return result(None)
    if any(row['account'] is None or not row['accountConfirmed'] for row in ordered):
        return result('account_unconfirmed')
    if any(row['date'] is not None and row['timezone'] is None for row in ordered):
        return result('timezone_unconfirmed')
    datasets = {row['dataset'] for row in ordered}
    if authority:
        dataset = next((d for d in authority['datasets'] if d in datasets), None)
    elif len(datasets) == 1:
        dataset = next(iter(datasets))
    else:
        return result('dataset_ambiguous')
    if dataset is None:
        return result('dataset_unselected')
    in_dataset = [row for row in ordered if row['dataset'] == dataset]
    latest = max(_instant(row['fetchedAt']) for row in in_dataset)
    observed = [row for row in in_dataset if _instant(row['fetchedAt']) == latest]
    if len({row['revision'] for row in observed}) > 1:
        return result('revision_ambiguous', observed)
    supported = [row for row in observed if row['version'] in supported_versions]
    if not supported:
        return result('version_unsupported', observed)
    version = max(row['version'] for row in supported)
    candidates = [row for row in supported if row['version'] == version]
    def equal(a, b):
        if isinstance(a, bool) or isinstance(b, bool):
            return type(a) is type(b) and a == b
        if isinstance(a, (int, float)) and isinstance(b, (int, float)):
            return a == b
        if isinstance(a, list) and isinstance(b, list):
            return len(a) == len(b) and all(equal(x, y) for x, y in zip(a, b))
        if isinstance(a, dict) and isinstance(b, dict):
            return a.keys() == b.keys() and all(equal(a[k], b[k]) for k in a)
        return type(a) is type(b) and a == b
    if any(not equal(candidates[0]['value'], row['value']) for row in candidates[1:]):
        return result('value_ambiguous', candidates)
    return result(None, candidates, candidates[0])


def validate(row, metric):
    value = row['value']
    valid_value = value is None or (row['type'] == 'number' and isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)) or (row['type'] == 'text' and isinstance(value, str)) or (row['type'] == 'json' and isinstance(value, (dict, list)))
    if (row['metric'] != metric['metric'] or row['type'] != metric['type'] or row['unit'] != metric['unit'] or
            (row['date'] is None) == (row['instant'] is None) or isinstance(row['version'], bool) or
            not isinstance(row['version'], int) or row['version'] < 1 or not valid_value):
        raise ValueError('HEALTH_INVALID_OBSERVATION')


# [ASSUMPTION] 원본 SQL에서 단위 근거가 없는 지표는 집계하지 않는다.
def aggregate(metric, operation, rows):
    if operation not in metric['aggregations']:
        raise ValueError('HEALTH_AGGREGATION_NOT_ALLOWED')
    values = [r['value'] for r in rows if r and r['metric'] == metric['metric'] and r['type'] == metric['type'] == 'number' and r['unit'] == metric['unit'] and isinstance(r['value'], (int, float)) and not isinstance(r['value'], bool) and math.isfinite(r['value'])]
    return (sum(values) if operation == 'sum' else sum(values) / len(values)) if values else None


def convert(metric, table, column, value):
    mapping = next((m for m in metric['mappings'] if m['table'] == table and m['column'] == column), None)
    if mapping is None:
        raise ValueError('HEALTH_INVALID_MAPPING')
    if value is None:
        return None
    if metric['type'] == 'number':
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError('HEALTH_INVALID_OBSERVATION')
        return value * mapping['factor']
    if metric['type'] == 'text' and isinstance(value, (str, InvalidSQLiteText)):
        return value
    if metric['type'] == 'json':
        if isinstance(value, InvalidSQLiteText):
            return value
        if isinstance(value, str):
            try:
                parsed = json.loads(value)
            except ValueError:
                return value
            if not isinstance(parsed, (dict, list)):
                return value
            value = parsed
        if isinstance(value, (dict, list)):
            return value
    raise ValueError('HEALTH_INVALID_OBSERVATION')


def source_endpoint(table_name, column):
    """원본 정규화 코드가 소유권을 명시한 열의 endpoint를 반환한다."""
    endpoints = {
        'body_battery_sample': 'body_battery', 'stress_bb_sample': 'stress_data',
        'hr_sample': 'heart_rates', 'activity_hr_sample': 'activity_details',
        'exercise_set': 'activity_exercise_sets',
    }
    if table_name == 'daily_metric':
        if column in ('steps','distance_m','active_kcal','moderate_intensity_s','vigorous_intensity_s','min_hr','max_hr'): return 'user_summary'
        elif column == 'resting_hr': return 'rhr_day'
        elif column.startswith('hrv_'): return 'hrv_data'
        elif column.startswith('readiness_'): return 'training_readiness'
        elif column.startswith('sleep_') or column in ('deep_sleep_s','light_sleep_s','rem_sleep_s','awake_sleep_s'): return 'sleep_data'
        elif column.startswith('stress_'): return 'stress_data'
        elif column.startswith('bb_'): return 'body_battery'
        else: return None
    elif table_name == 'activity': return 'activity_hr_in_timezones' if column.startswith('hr_zone') else 'activity'
    else: return endpoints.get(table_name)


def import_candidates(snapshot, catalog, table_name, row):
    """원문과 정규화 근거가 유일한 catalog 열만 발행 대상으로 만든다."""
    import hashlib
    from datetime import datetime, timezone
    from zoneinfo import ZoneInfo
    meta = {r['key']: r['value'] for r in snapshot['tables'].get('meta', {}).get('rows', [])}
    version = meta.get('normalize_version')
    zone = meta.get('timezone')
    try:
        if zone is not None: ZoneInfo(zone)
    except Exception:
        zone = None
    day = row.get('day_key') or row.get('date')
    activity = row.get('activity_id')
    if activity is not None and day is None:
        parent = next((r for r in snapshot['tables'].get('activity', {}).get('rows', []) if r.get('activity_id') == activity), None)
        if parent: day = parent.get('day_key')
    source_key = (activity if isinstance(activity, (str, InvalidSQLiteText)) else str(activity)) if activity is not None else day
    scope = 'activity' if activity is not None else 'day'
    raw = [r for r in snapshot['tables'].get('raw_response', {}).get('rows', []) if r['scope'] == scope and r['key'] == source_key]
    normal = snapshot['tables'].get('normalize_result', {}).get('rows', [])
    valid_raw = [r for r in raw if any(n['scope'] == r['scope'] and n['key'] == r['key'] and n['endpoint'] == r['endpoint'] and n['ok'] == 1 and n['raw_fetched_at'] == r['fetched_at'] for n in normal)]
    timestamp = row.get('ts_ms')
    observed = datetime.fromtimestamp(timestamp / 1000, timezone.utc) if timestamp is not None else None
    for definition in catalog:
        for mapping in definition.get('mappings', []):
            column = mapping['column']
            if mapping['table'] != table_name or column not in row:
                continue
            endpoint = source_endpoint(table_name, column)
            matched = [r for r in valid_raw if r['endpoint'] == endpoint]
            reason = None
            if not isinstance(version, str) or not version.isdigit() or int(version) < 1: reason = '정규화 버전 없음'
            elif len(matched) != 1: reason = '원문·정규화 연결이 유일하지 않음'
            elif observed is None and day is None: reason = '날짜·시각 근거 없음'
            if reason:
                yield definition, column, None, reason
                continue
            source = matched[0]
            yield definition, column, {'value': convert(definition, table_name, column, row[column]), 'source_value': row[column],
                'revision': hashlib.sha256(source['raw'].raw if isinstance(source['raw'], (SQLiteText, InvalidSQLiteText)) else source['raw'].encode('utf-8')).hexdigest(),
                'fetched_at': datetime.fromtimestamp(source['fetched_at'] / 1000, timezone.utc),
                'version': int(version), 'zone': zone, 'day': day if observed is None else None,
                'observed': observed, 'activity': (activity if isinstance(activity, (str, InvalidSQLiteText)) else str(activity)) if activity is not None else None}, None
