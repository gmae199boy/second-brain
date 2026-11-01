"""명시된 canonical profile의 rate/manual 보호만 해제하는 로컬 일감."""
import json
import os
import re
import sys
import psycopg


def emit(kind, **fields):
    print(json.dumps({'abi':1,'type':kind,**fields}),flush=True)


def main():
    try:
        env = os.environ
        uuid = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
        if (env.get('BRAIN_ABI_VERSION') != '1' or env.get('BRAIN_WORK_KIND') != 'garmin.release_block'
            or env.get('BRAIN_TARGET_KIND') != 'extension' or not env.get('BRAIN_TARGET_ID')
            or not all(re.fullmatch(uuid,env.get(key,'')) for key in ('BRAIN_WORK_ID','BRAIN_ATTEMPT_TOKEN'))):
            raise ValueError('invalid')
        with psycopg.connect(env['BRAIN_DATABASE_URL'], autocommit=True) as conn:
            with conn.transaction():
                conn.execute("set local transaction_timeout = '1900ms'")
                conn.execute("set local statement_timeout = '1900ms'")
                conn.execute("set local lock_timeout = '1500ms'")
                result = conn.execute('select garmin.release_protection(%s::uuid,%s::uuid,%s)',
                    (env['BRAIN_WORK_ID'],env['BRAIN_ATTEMPT_TOKEN'],env['BRAIN_TARGET_ID'])).fetchone()
                if not result or result[0] is not True: raise ValueError('invalid')
        emit('result',summary='수동 보호 해제 완료')
        return 0
    except Exception:
        emit('error',code='RELEASE_INVALID',retryable=False)
        return 1


if __name__ == '__main__':
    sys.exit(main())
