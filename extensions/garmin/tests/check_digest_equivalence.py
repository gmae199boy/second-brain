"""Compare the complete pure result to an isolated archived implementation."""
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import digest

fixture = Path(__file__).parent / 'fixtures' / 'digest_v8'
inputs = json.loads((fixture / 'input.json').read_text(encoding='utf-8'))
expected = json.loads((fixture / 'expected.json').read_text(encoding='utf-8'))
actual = digest.build(inputs['manifest'], inputs['days'], inputs['activities'], inputs['labels'], inputs['body'])
assert actual == expected
assert actual['weight']['days'][0]['weight_kg'] == 80.8
assert actual['weight']['days'][1]['weight_kg'] is None
assert actual['drinks_last_8_days'][0]['logged'][0]['amount'] == 2
assert actual['body']['latest']['measured_on'] == '2026-10-14'
assert all(key in actual for key in ('sleep', 'day', 'workouts', 'recovery', 'body', 'weight'))
print('digest v8 equivalence: ok')

edge = json.loads((fixture / 'edge_input.json').read_text(encoding='utf-8'))
edge_expected = json.loads((fixture / 'edge_expected.json').read_text(encoding='utf-8'))
edge_actual = digest.build(edge['manifest'], edge['days'], edge['activities'], edge['labels'], edge['body'])
assert edge_actual == edge_expected
assert edge_actual['day']['today_morning']['stress_avg_samples'] == 30
first_set = edge_actual['workouts'][0]['detail'][0]['sets'][0]
assert first_set['set_peak_hr'] == 155 and first_set['set_peak_after_end_s'] == 42

cases=json.loads((fixture/'cases_input.json').read_text(encoding='utf-8'))
expected_cases=json.loads((fixture/'cases_expected.json').read_text(encoding='utf-8'))
assert cases.keys() == expected_cases.keys()
for name, case in cases.items():
    actual=digest.build(case['manifest'],case['days'],case['activities'],case['labels'],case['body'])
    assert actual == expected_cases[name], name
print(f'archive digest named cases: {len(cases)} ok')
