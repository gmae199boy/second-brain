"""Compare the pure v8 port to the frozen legacy SQLite oracle."""
import json
from pathlib import Path
import sys
sys.dont_write_bytecode = True

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from normalize_tables import normalize_all

fixture = Path(__file__).parent / 'fixtures' / 'normalize_v8'
inputs = json.loads((fixture / 'input.json').read_text(encoding='utf-8'))
expected = json.loads((fixture / 'expected.json').read_text(encoding='utf-8'))
actual = normalize_all(inputs['items'], inputs['timezone'], inputs['history_start'])
assert next(row for row in actual['day_summary'] if row['date']=='2026-10-15')['weight_kg'] == 72.3
for table in actual:
    actual[table].sort(key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
    if actual[table] != expected[table]:
        raise AssertionError(f'{table}:\nactual={actual[table]}\nexpected={expected[table]}')
print('normalize v8 equivalence: ok')

# A malformed raw payload must not prevent an unrelated date from being derived.
good = next(item for item in inputs['items'] if item['scope'] == 'day' and item['endpoint'] == 'user_summary')
broken = {**good, 'key': '2099-01-01', 'raw': '{'}
isolated = normalize_all([good, broken], inputs['timezone'], good['key'])
assert any(row['date'] == good['key'] for row in isolated['day_summary'])
assert not any(row['date'] == broken['key'] for row in isolated['day_summary'])
