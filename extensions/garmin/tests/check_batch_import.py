"""반입 보존값의 canonical 표현을 검사한다."""
from pathlib import Path
import sys
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from batch_import import encoded, canonical
assert encoded(None) == {'type': 'null'}
assert encoded(0) == {'type': 'integer', 'value': 0}
assert encoded(-3) == {'type': 'integer', 'value': -3}
assert encoded(1.5) == {'type': 'real', 'value': '0x1.8000000000000p+0'}
assert encoded('한글\x00') == {'type': 'text', 'base64': '7ZWc6riAAA=='}
assert encoded(b'\x00\xff') == {'type': 'blob', 'base64': 'AP8='}
assert canonical([encoded(None), encoded(7)]) == '[{"type":"null"},{"type":"integer","value":7}]'
print('보존 원형 계약 성공')
