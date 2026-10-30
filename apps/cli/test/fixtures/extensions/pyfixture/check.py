"""시험 전용 연결 확인. 데이터베이스에 쓰지 않는다."""
import json
import os
import re

# [ASSUMPTION] 조사 당시 다운로드 없이 사용 가능한 patch를 고정했다.
valid = (os.environ.get('BRAIN_ABI_VERSION') == '1'
         and re.match(r'^postgres(?:ql)?://', os.environ.get('BRAIN_DATABASE_URL', ''))
         and os.environ.get('BRAIN_WORK_KIND') == 'pyfixture.connection_check'
         and os.environ.get('BRAIN_TARGET_KIND') == 'extension'
         and os.environ.get('BRAIN_TARGET_ID') == 'pyfixture')
if not valid:
    print(json.dumps({'abi': 1, 'type': 'error', 'code': 'ABI_ENV_INVALID', 'retryable': False, 'message': '환경 변수가 올바르지 않습니다'}))
    raise SystemExit(1)
print(json.dumps({'abi': 1, 'type': 'result', 'summary': 'connected'}))
