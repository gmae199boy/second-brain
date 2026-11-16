"""JSONB에 안전한 metadata는 그대로, 표현 불가능한 원문은 별도 버전 바이트로 보존한다."""
import json

def safe_dumps(value, **options):
    """정상 문자는 그대로 두고 UTF-8에 없는 단독 surrogate만 JSON escape한다."""
    return json.dumps(value, **options).encode('utf-8', errors='backslashreplace').decode('utf-8')
