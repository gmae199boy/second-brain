"""Manual, network-free resumption of collected raw normalization."""
import json
import os
import re
import signal
import sys
import psycopg
import collect
import collect_store
import normalize_runtime
from collect_settings import decode


def run(env=None, connect=psycopg.connect):
    env = os.environ if env is None else env
    pattern = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (env.get('BRAIN_ABI_VERSION')!='1' or env.get('BRAIN_WORK_KIND')!='garmin.normalize'
        or env.get('BRAIN_TARGET_KIND') not in ('account','extension') or not env.get('BRAIN_TARGET_ID')
        or not re.fullmatch(r'[1-9][0-9]{0,8}',env.get('BRAIN_RUN_GENERATION',''))
        or not all(re.fullmatch(pattern,env.get(k,'')) for k in ('BRAIN_WORK_ID','BRAIN_ATTEMPT_TOKEN'))
        or not re.match(r'^postgres(?:ql)?://',env.get('BRAIN_DATABASE_URL',''))):
        raise ValueError('COLLECT_INVALID')
    zone = decode(env.get('BRAIN_SETTINGS_SNAPSHOT'),require_timezone=True)['garmin.timezone']
    with connect(env['BRAIN_DATABASE_URL'],autocommit=True,options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
        account = (env['BRAIN_TARGET_ID'] if env['BRAIN_TARGET_KIND'] == 'account'
                   else collect_store.target_account(conn,env['BRAIN_TARGET_KIND'],env['BRAIN_TARGET_ID']))
        if account is None:
            collect.emit('result',summary=json.dumps({'normalized':0,'normalize_failed':0}))
            return
        normalized,failed = normalize_runtime.rebuild(conn,account,env['BRAIN_WORK_ID'],env['BRAIN_ATTEMPT_TOKEN'],zone,collect.boundary)
        collect.emit('result',summary=json.dumps({'normalized':normalized,'normalize_failed':failed}))


def main():
    signal.signal(signal.SIGTERM,collect._stop); signal.signal(signal.SIGINT,collect._stop)
    try:
        run()
    except Exception as error:
        allowed = ('COLLECT_INVALID_ATTEMPT','COLLECT_STOPPED')
        code = str(error) if isinstance(error,ValueError) and str(error) in allowed else 'COLLECT_INVALID'
        collect.emit('error',code=code,retryable=False)
        return 1
    return 0

if __name__=='__main__':
    sys.exit(main())
