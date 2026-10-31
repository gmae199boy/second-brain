"""공유 기대표를 독립 Python 구현과 대조한다."""
import json
import os
import sys
sys.dont_write_bytecode = True
from pathlib import Path

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, os.environ.get('BRAIN_HEALTH_MODULE_DIR', str(root / 'extensions/garmin/src')))
from health import aggregate, convert, resolve, validate

fixture = json.loads((root / 'packages/core/fixtures/health/v1/current.json').read_text())
catalog = json.loads((root / 'packages/core/schemas/health/v1/catalog.json').read_text())
metrics = {metric['metric']: metric for metric in catalog['metrics']}
for case in fixture['cases']:
    expected = dict(case['expected'], authorityVersion=case['authority']['version'] if case['authority'] else None)
    assert resolve(case['rows'], case['versions'], case['authority']) == expected, case['name']
for case in fixture['aggregations']:
    try:
        groups = {}
        for row in case['rows']:
            key = tuple(row[k] for k in ('source', 'account', 'metric', 'activity', 'subIdentity', 'date', 'instant', 'timezone'))
            groups.setdefault(key, []).append(row)
        current = []
        for rows in groups.values():
            selected = resolve(rows, [1])['current']
            current.append(next((row for row in rows if row['id'] == selected), None))
        value = aggregate(metrics[case['metric']], case['operation'], current)
        assert 'error' not in case and value == case['expected'], case['name']
    except ValueError as exc:
        assert str(exc) == case.get('error'), case['name']
steps = metrics['daily_metric.steps']
row = fixture['cases'][0]['rows'][0]
for value in (None, 0, -1):
    validate(dict(row, value=value), steps)
for change in ({'value': '1'}, {'unit': 'g'}, {'instant': '2026-01-01T00:00:00Z'}, {'version': 1.5}, {'value': True}):
    try:
        validate(dict(row, **change), steps)
    except ValueError as exc:
        assert str(exc) == 'HEALTH_INVALID_OBSERVATION'
    else:
        raise AssertionError(change)
assert convert(metrics['day_summary.moderate_min'], 'day_summary', 'moderate_min', 2) == 120
assert convert(metrics['day_summary.weight_kg'], 'day_summary', 'weight_kg', 2) == 2000
assert convert(metrics['day_summary.drinks_json'], 'day_summary', 'drinks_json', '[{"count":0}]') == [{'count': 0}]
assert convert(metrics['daily_metric.hrv_status'], 'daily_metric', 'hrv_status', 'balanced') == 'balanced'
assert convert(steps, 'daily_metric', 'steps', None) is None
assert convert(steps, 'daily_metric', 'steps', 0) == 0
assert convert(steps, 'daily_metric', 'steps', -1) == -1
print(f"건강 선택 {len(fixture['cases'])}건, 집계 {len(fixture['aggregations'])}건과 변환 통과")
