"""누락 원문 백필의 supervised 입력·계정·토큰 경계."""
import json
import os
import time
from datetime import date

import collect_runtime
from garmin_pipeline import backfill, coverage, dates, store

InvalidCollectInput = collect_runtime.InvalidCollectInput
CredentialEvidenceError = collect_runtime.CredentialEvidenceError


def validate_input(data):
    try:
        if data is None:
            data = {}
        if not isinstance(data, dict) or not set(data) <= {'start_date', 'end_date', 'endpoints', 'dry_run'}:
            raise ValueError('invalid input')
        for key in ('start_date', 'end_date'):
            if key in data and date.fromisoformat(data[key]).isoformat() != data[key]:
                raise ValueError('invalid date')
        endpoints = data.get('endpoints')
        if endpoints is not None and (not isinstance(endpoints, list) or not endpoints or
                any(not isinstance(e, str) or e not in coverage.DAY_ENDPOINTS + coverage.ACTIVITY_ENDPOINTS for e in endpoints) or
                len(endpoints) != len(set(endpoints))):
            raise ValueError('invalid endpoints')
        if type(data.get('dry_run', False)) is not bool:
            raise ValueError('invalid dry run')
        return data
    except (ValueError, TypeError, OverflowError) as exc:
        raise InvalidCollectInput('invalid backfill input') from exc


def run(env=None, *, port_factory=collect_runtime.SupervisedGarmin, sleep=time.sleep):
    actual = os.environ if env is None else env
    account, cfg = collect_runtime.envelope(actual, work_kinds=('garmin.backfill',))
    with store.supervised_account(account), store.write_session(cfg) as conn:
        with store.transaction(conn):
            row = conn.execute('select timezone from garmin.account_connections where user_id=%s and connection_id=%s',
                               (account.user_id, account.connection_id)).fetchone()
            if not row or row[0] != cfg.timezone:
                raise InvalidCollectInput('account timezone mismatch')
            raw = conn.execute('select brain.extension_work_input(%s,%s)',
                               (account.work_id, account.attempt_token)).fetchone()[0]
            data = validate_input(raw)
            history = conn.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='history_start'",
                                   (account.user_id, account.connection_id)).fetchone()
        today = dates.today(cfg)
        start = date.fromisoformat(data.get('start_date', history[0] if history else (today - backfill.HISTORY_WINDOW).isoformat()))
        end = date.fromisoformat(data.get('end_date', today.isoformat()))
        if start > end or end > today:
            raise InvalidCollectInput('invalid backfill period')
        result = backfill.run(conn, cfg, port_factory(cfg, conn, sleep=sleep), start, end,
            endpoints=data.get('endpoints'), dry_run=data.get('dry_run', False), sleep=sleep)
        summary = json.dumps(result, ensure_ascii=False)
        # dry-run도 공개 결과 영수증만 남긴다. 원문·수집 run·토큰은 바꾸지 않는다.
        with store.transaction(conn):
            for key in (f'backfill_result:{account.work_id}', 'backfill_latest'):
                conn.execute('insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,%s,%s) on conflict (user_id,connection_id,key) do update set value=excluded.value',
                    (account.user_id, account.connection_id, key, summary))
        return summary
