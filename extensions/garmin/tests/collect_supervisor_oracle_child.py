"""Unmodified SQLite collector supplies the installed-supervisor expected result."""
import json
import sqlite3
from unittest.mock import patch
from garmin_pipeline import collect, dates, garmin, store
from collect_oracle_support import DAY, NOW, TABLES, FakeNetwork, cfg, fixture

garmin.LIBRARY_VERSION = 'synthetic'
conn = sqlite3.connect(':memory:', autocommit=True)
store._migrate(conn, store._load_migrations())
conn.execute("insert into meta(key,value) values ('history_start',?)", (DAY.isoformat(),))
conn.execute("insert into meta(key,value) values ('normalize_version',?)", (str(store.NORMALIZE_VERSION),))
network = FakeNetwork(fixture()['items'])
with patch.object(dates, 'now_ms', return_value=NOW), patch.object(dates, 'system_timezone', return_value='Asia/Seoul'):
    collect.run(conn, cfg(), network, network.sleep, today=DAY, started_at=NOW, manual=True)
out = {'requests': network.requests, 'tables': {},
       'raw': conn.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from raw_response order by scope,key,endpoint').fetchall(),
       'runs': conn.execute('select local_date,started_at,finished_at,status,detail from run order by id').fetchall()}
for name in TABLES:
    info = conn.execute(f'pragma table_info("{name}")').fetchall()
    cols = [row[1] for row in info]
    keys = [row[1] for row in sorted(info, key=lambda row: row[5]) if row[5]]
    rows = [dict(zip(cols, row, strict=True)) for row in conn.execute(f'select * from "{name}"')]
    rows.sort(key=lambda row: json.dumps([row[key] for key in keys], ensure_ascii=False))
    out['tables'][name] = {'columns': cols, 'keys': keys, 'rows': rows}
print(json.dumps(out, ensure_ascii=False, sort_keys=True, allow_nan=False))
