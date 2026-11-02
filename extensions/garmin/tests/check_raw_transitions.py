"""옛 raw 저장 문자열과 시각 전이를 네트워크 없이 검증한다."""
from pathlib import Path
import sys
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from collect_store import raw_transition

T1, T2 = 1760000000000, 1760086400000
payload = {'zeta': 1, 'alpha': [1, 2], '메모': '수면', 'nested': {'b': None, 'a': 1.5}}
first = raw_transition(None, payload, '0.3.17', T1)
assert first == {'body': '{"zeta": 1, "alpha": [1, 2], "메모": "수면", "nested": {"b": null, "a": 1.5}}', 'fetched_at_ms': T1, 'checked_at_ms': T1, 'library_version': '0.3.17'}
for value in (payload.copy(), None):
    assert raw_transition(first, value, '0.3.18', T2) == first | {'checked_at_ms': T2}
for value in ({'changed': 2}, dict(reversed(list(payload.items()))), [], {}, 0, ''):
    changed = raw_transition(first, value, '0.3.18', T2)
    assert changed['fetched_at_ms'] == changed['checked_at_ms'] == T2 and changed['library_version'] == '0.3.18'
null = raw_transition(None, None, '0.3.17', T1)
assert null['body'] == 'null' and raw_transition(null, None, '0.3.18', T2) == null | {'checked_at_ms': T2}
assert raw_transition(null, payload, '0.3.18', T2)['body'] == first['body']
escaped = raw_transition(None, {'note': '\ud83d', '메모': '수면'}, 'v', T1)
assert escaped['body'] == '{"note": "\\ud83d", "\\uba54\\ubaa8": "\\uc218\\uba74"}'
assert raw_transition(escaped, {'note': '\ud83d', '메모': '수면'}, 'v2', T2) == escaped | {'checked_at_ms': T2}
print('check_raw_transitions: all checks passed')
