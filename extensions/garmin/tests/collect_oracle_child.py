"""Run the unchanged pinned SQLite collector in an isolated process."""
import json
import sqlite3
from unittest.mock import patch
from garmin_pipeline import collect, coverage, dates, digest, normalize, store
from collect_oracle_support import DAY, NOW, TABLES, FakeNetwork, cfg, fixture

conn = sqlite3.connect(':memory:', autocommit=True)
store._migrate(conn, store._load_migrations())
conn.execute("insert into meta(key,value) values ('history_start',?)", (DAY.isoformat(),))
conn.execute("insert into meta(key,value) values ('normalize_version',?)", (str(store.NORMALIZE_VERSION),))
inputs = fixture(); interrupted = FakeNetwork(inputs['items'], fail_after=5)
resumed = FakeNetwork(inputs['items'])
with patch.object(dates, 'now_ms', return_value=NOW), patch.object(dates, 'system_timezone', return_value='Asia/Seoul'):
    try:
        collect.run(conn, cfg(), interrupted, interrupted.sleep, today=DAY, started_at=NOW, manual=True)
    except RuntimeError as error:
        if str(error) != 'synthetic interruption': raise
    before = conn.execute('select scope,key,endpoint,raw from raw_response order by scope,key,endpoint').fetchall()
    with patch.object(digest, 'day_values', side_effect=ValueError('synthetic projection failure')):
        collect.run(conn, cfg(), resumed, resumed.sleep, today=DAY, started_at=NOW + 1, manual=True)
    pending_before = conn.execute("select value from meta where key='day_values_pending'").fetchone()
    normalize.run(conn, timezone=cfg().timezone)
    coverage_rows = [list(row) for row in coverage.items(conn, cfg(), DAY, DAY)]
    output = {'before': before, 'requests_before': interrupted.requests, 'requests_after': resumed.requests,
              'coverage': coverage_rows, 'tables': {}, 'pending_before': pending_before,
              'exercise_order': conn.execute('select activity_id,exercise from exercise_log order by rowid').fetchall(),
              'raw': conn.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from raw_response order by scope,key,endpoint').fetchall(),
              'runs': conn.execute('select local_date,started_at,finished_at,status,detail from run order by id').fetchall()}
    for name in TABLES:
        info = conn.execute(f'pragma table_info("{name}")').fetchall()
        cols = [row[1] for row in info]
        keys = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
        values = [dict(zip(cols, row, strict=True)) for row in conn.execute(f'select * from "{name}"')]
        values.sort(key=lambda row: json.dumps([row[key] for key in keys], ensure_ascii=False))
        output['tables'][name] = {'columns': cols, 'keys': keys, 'rows': values}
    raw = conn.execute('select scope,key,endpoint,raw from raw_response').fetchall()
    day_raw = {endpoint: json.loads(body) for scope, key, endpoint, body in raw if scope == 'day' and key == DAY.isoformat()}
    activities = {}
    for scope, key, endpoint, body in raw:
        if scope == 'activity': activities.setdefault(key, {})[endpoint] = json.loads(body)
    output['digest'] = digest.day_values(DAY.isoformat(), day_raw, activities, {}, 'Asia/Seoul')
    output['pending'] = conn.execute("select value from meta where key='day_values_pending'").fetchone()
print(json.dumps(output, ensure_ascii=False, sort_keys=True, allow_nan=False))
