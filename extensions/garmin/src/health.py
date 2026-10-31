"""공유 건강 계약의 부작용 없는 판정과 원본 열 변환."""
from datetime import datetime
from decimal import Decimal
import json
import math
import re


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
    if metric['type'] == 'text' and isinstance(value, str):
        return value
    if metric['type'] == 'json':
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError as exc:
                raise ValueError('HEALTH_INVALID_OBSERVATION') from exc
        if isinstance(value, (dict, list)):
            return value
    raise ValueError('HEALTH_INVALID_OBSERVATION')
