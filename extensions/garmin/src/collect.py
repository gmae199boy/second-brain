"""단일 날짜 user_summary 수집 ABI worker."""
from datetime import date
import json
import os
from pathlib import Path
import re
import signal
import sys
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import psycopg
from collect_client import UnavailableClient
from collect_store import covered, prepare, publish

_stopping = False


def _stop(_signum, _frame):
    global _stopping
    _stopping = True


def boundary():
    if _stopping:
        raise ValueError('COLLECT_STOPPED')


def emit(kind, **values):
    print(json.dumps({'abi': 1, 'type': kind, **values}, ensure_ascii=False), flush=True)


def inputs(env):
    uuid_pattern = r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
    if (env.get('BRAIN_ABI_VERSION') != '1' or env.get('BRAIN_WORK_KIND') != 'garmin.collect'
        or env.get('BRAIN_TARGET_KIND') != 'account' or not env.get('BRAIN_TARGET_ID')
        or not re.fullmatch(r'[1-9][0-9]{0,8}', env.get('BRAIN_RUN_GENERATION', ''))
        or not all(re.fullmatch(uuid_pattern, env.get(k, '')) for k in ('BRAIN_WORK_ID', 'BRAIN_ATTEMPT_TOKEN'))
        or not re.match(r'^postgres(?:ql)?://', env.get('BRAIN_DATABASE_URL', ''))):
        raise ValueError('COLLECT_INVALID')
    account = env['BRAIN_TARGET_ID']
    if '\x00' in account or ('BRAIN_ACCOUNT' in env and env['BRAIN_ACCOUNT'] != account):
        raise ValueError('COLLECT_INVALID')
    start, end = env.get('BRAIN_RANGE_FROM', ''), env.get('BRAIN_RANGE_TO', '')
    if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', start) or start != end:
        raise ValueError('COLLECT_INVALID')
    date.fromisoformat(start)
    raw = env.get('BRAIN_SETTINGS_SNAPSHOT', '')
    if len(raw.encode('utf-8')) > 16384:
        raise ValueError('COLLECT_INVALID')
    snapshot = json.loads(raw)
    manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
    declarations = {entry['key']: entry['type'] for entry in manifest['settings']}
    if (not isinstance(snapshot, dict) or set(snapshot) != {'version', 'extension', 'values'}
        or type(snapshot['version']) is not int or snapshot['version'] != 1 or snapshot['extension'] != 'garmin'
        or not isinstance(snapshot['values'], dict)):
        raise ValueError('COLLECT_INVALID')
    for key, value in snapshot['values'].items():
        if key not in declarations or declarations[key] != 'string' or not isinstance(value, str):
            raise ValueError('COLLECT_INVALID')
    zone = snapshot['values'].get('garmin.timezone')
    if not isinstance(zone, str) or not zone:
        raise ValueError('COLLECT_INVALID')
    try:
        ZoneInfo(zone)
    except (ZoneInfoNotFoundError, ValueError):
        raise ValueError('COLLECT_INVALID') from None
    return account, start, zone


def run(client=None, env=None, connect=psycopg.connect):
    env = os.environ if env is None else env
    account, day, zone = inputs(env)
    client = client if client is not None else UnavailableClient()
    boundary()
    with connect(env['BRAIN_DATABASE_URL'], autocommit=True,
                 options='-c transaction_timeout=2000 -c statement_timeout=1900 -c lock_timeout=1500') as conn:
        current = conn.execute('select garmin.attempt_valid(%s::uuid,%s::uuid)',
                               (env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'])).fetchone()
        if current[0] is not True:
            raise ValueError('COLLECT_INVALID_ATTEMPT')
        boundary()
        emit('progress', message='coverage 확인')
        if covered(conn, account, day):
            boundary()
            emit('result', summary='수집 범위 완료')
            return
        row = conn.execute("select definition from brain.health_catalog_v1 where metric='daily_metric.steps'").fetchone()
        if row is None:
            raise ValueError('COLLECT_INVALID')
        boundary()
        response = client.user_summary(day)
        boundary()
        prepared = prepare(response, day, [row[0]])
        boundary()
        publish(conn, account, day, zone, env['BRAIN_WORK_ID'], env['BRAIN_ATTEMPT_TOKEN'], prepared)
        boundary()
        emit('progress', message='수집 저장 완료')
        emit('result', summary='수집 완료')


def main():
    signal.signal(signal.SIGTERM, _stop)
    signal.signal(signal.SIGINT, _stop)
    try:
        run()
    except Exception as exc:
        code = str(exc) if isinstance(exc, ValueError) and str(exc) in ('COLLECT_CLIENT_UNAVAILABLE', 'COLLECT_INVALID_ATTEMPT', 'COLLECT_STOPPED') else 'COLLECT_INVALID'
        emit('error', code=code, retryable=False)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
