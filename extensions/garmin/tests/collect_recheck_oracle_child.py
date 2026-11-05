"""Pinned SQLite collector supplies independent recheck and timezone results."""
import json
import sqlite3
from garmin_pipeline import coverage, store
from collect_oracle_support import DAY, recheck_scenario, timezone_scenario


def make_db():
    conn = sqlite3.connect(':memory:', autocommit=True)
    store._migrate(conn, store._load_migrations())
    conn.execute("insert into meta(key,value) values ('history_start',?)", (DAY.isoformat(),))
    conn.execute("insert into meta(key,value) values ('normalize_version',?)", (str(store.NORMALIZE_VERSION),))
    return conn


def snapshot(conn, today, local_cfg):
    return {'raw': conn.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from raw_response order by scope,key,endpoint').fetchall(),
            'runs': conn.execute('select local_date,started_at,finished_at,status,detail from run order by id').fetchall(),
            'coverage': [list(item) for item in coverage.items(conn, local_cfg, DAY, today)]}

result = {'recheck': recheck_scenario(make_db(), snapshot),
          'zones': {zone: timezone_scenario(make_db(), snapshot, zone) for zone in ('UTC', 'Asia/Seoul')}}
print(json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False))
