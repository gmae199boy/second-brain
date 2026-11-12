"""수동 백필의 공개 계획·결과를 계정과 일감 범위로 조회한다."""
import json
import os
import sys
from uuid import UUID

import psycopg


def execute(database_url, envelope):
    if not isinstance(envelope, dict) or set(envelope) != {'abi','user_id','settings','input'} or type(envelope['abi']) is not int or envelope['abi'] != 1:
        raise ValueError('invalid envelope')
    user = UUID(envelope['user_id'])
    data = envelope['input']
    if str(user) != envelope['user_id'] or not isinstance(data, dict) or not set(data) <= {'connection_id','work_id'}:
        raise ValueError('invalid input')
    connection = UUID(data['connection_id'])
    if str(connection) != data['connection_id']:
        raise ValueError('invalid connection')
    key = 'backfill_latest'
    if 'work_id' in data:
        work = UUID(data['work_id'])
        if str(work) != data['work_id']:
            raise ValueError('invalid work')
        key = f'backfill_result:{work}'
    with psycopg.connect(database_url, autocommit=True, options='-c statement_timeout=10000 -c transaction_timeout=11000') as conn:
        conn.execute('BEGIN READ ONLY')
        row = conn.execute('select value from garmin.meta where user_id=%s and connection_id=%s and key=%s', (user,connection,key)).fetchone()
        result = json.loads(row[0]) if row else None
        conn.execute('ROLLBACK')
        return {'result': result}


if __name__ == '__main__':
    try:
        print(json.dumps(execute(os.environ['BRAIN_DATABASE_URL'], json.load(sys.stdin)), ensure_ascii=False))
    except Exception:
        raise SystemExit(1)
