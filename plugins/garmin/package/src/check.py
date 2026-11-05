"""설치된 확장 자격으로 PostgreSQL 연결을 확인한다."""
import json
import os
import psycopg

try:
    with psycopg.connect(os.environ['BRAIN_DATABASE_URL']) as conn:
        with conn.cursor() as cursor:
            cursor.execute('select current_user')
            if cursor.fetchone()[0] != 'brain_ext_garmin':
                raise ValueError('unexpected role')
    print(json.dumps({'abi': 1, 'type': 'result', 'summary': 'connected'}))
except Exception:
    print(json.dumps({'abi': 1, 'type': 'error', 'code': 'IMPORT_INVALID', 'retryable': False}))
    raise SystemExit(1)
