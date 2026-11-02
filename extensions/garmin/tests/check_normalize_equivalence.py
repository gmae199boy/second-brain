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
for table in actual:
    actual[table].sort(key=lambda row: json.dumps(row, sort_keys=True, ensure_ascii=False))
    if actual[table] != expected[table]:
        raise AssertionError(f'{table}:\nactual={actual[table]}\nexpected={expected[table]}')
print('normalize v8 equivalence: ok')
