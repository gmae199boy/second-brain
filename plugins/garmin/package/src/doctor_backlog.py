"""doctor 전용 읽기 점검. Garmin 네트워크·토큰에는 접근하지 않는다."""
import json
import os
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from uuid import UUID
from zoneinfo import ZoneInfo

import psycopg
from garmin_pipeline import backlog, store


def inspect(database_url):
    totals = dict.fromkeys(('remaining_endpoints', 'remaining_activities', 'remaining_dates', 'unplannable',
                           'deferred_dates', 'deferred_endpoints', 'deferred_first_call'), 0)
    with psycopg.connect(database_url, autocommit=True, options='-c statement_timeout=10000 -c transaction_timeout=15000') as raw:
        raw.execute('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        accounts = raw.execute('select user_id,connection_id,timezone from garmin.account_connections').fetchall()
        for user, connection, zone in accounts:
            conn = store.Connection(raw, store.AccountContext(user, connection, UUID(int=0), UUID(int=0)), readonly=True)
            cfg = SimpleNamespace(timezone=zone, max_rejected_attempts=3)
            today = datetime.now(ZoneInfo(zone)).date()
            history = raw.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='history_start'", (user, connection)).fetchone()
            start = date.fromisoformat(history[0]) if history else today - timedelta(days=30)
            for key, value in backlog.snapshot(conn, cfg, start, today).items():
                totals[key] += value
            saved = raw.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='collect_backlog'", (user, connection)).fetchone()
            if saved:
                previous = json.loads(saved[0])
                for key in ('deferred_dates', 'deferred_endpoints', 'deferred_first_call'):
                    value = previous.get(key, 0)
                    if type(value) is not int or value < 0:
                        raise ValueError('invalid saved counts')
                    totals[key] += value
        raw.execute('ROLLBACK')
    return totals


if __name__ == '__main__':
    try:
        print(json.dumps(inspect(os.environ['BRAIN_DATABASE_URL'])))
    except Exception:
        raise SystemExit(1)
