"""JSONB에 안전한 metadata는 그대로, 표현 불가능한 원문은 별도 버전 바이트로 보존한다."""
import json

PREFIX = b'brain-metadata-v1\n'


def safe_dumps(value, **options):
    """정상 문자는 그대로 두고 UTF-8에 없는 단독 surrogate만 JSON escape한다."""
    return json.dumps(value, **options).encode('utf-8', errors='backslashreplace').decode('utf-8')


def _unsafe(value):
    if isinstance(value, str):
        return '\0' in value or any(0xd800 <= ord(ch) <= 0xdfff for ch in value)
    if isinstance(value, list): return any(_unsafe(v) for v in value)
    if isinstance(value, dict): return any(_unsafe(k) or _unsafe(v) for k, v in value.items())
    return False


def encode_metadata(value):
    if value is None: return None, None
    if not _unsafe(value): return value, None
    raw = json.dumps(value, ensure_ascii=True, sort_keys=True, separators=(',', ':')).encode('ascii')
    return {}, PREFIX + raw


def decode_metadata(value, raw):
    if raw is None: return value
    raw = bytes(raw)
    if value != {} or not raw.startswith(PREFIX): raise ValueError('IMPORT_INVALID')
    return json.loads(raw[len(PREFIX):].decode('ascii'))
