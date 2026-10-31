"""아직 구현되지 않은 검증 일감은 고정 오류로 거부한다."""
import json
import sys

print(json.dumps({'abi': 1, 'type': 'error', 'code': 'IMPORT_VERIFY_UNAVAILABLE', 'retryable': False}), flush=True)
sys.exit(1)
