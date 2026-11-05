"""Run only the pinned SQLite store in a separate test process."""
import json
import sqlite3
import sys
from pathlib import Path

oracle = Path(__file__).resolve().parent / 'oracle' / 'src'
sys.path.insert(0, str(oracle))
from garmin_pipeline import store

conn = sqlite3.connect(':memory:')
conn.executescript((oracle / 'garmin_pipeline/store/migrations/0002_raw_response.sql').read_text())
sequence = [(None, 1, 'v1'), (None, 2, 'v2'), ({'totalSteps': 10}, 3, 'v3'),
            ({'totalSteps': 10}, 4, 'v4'), (None, 5, 'v5'), ({'totalSteps': 20}, 6, 'v6')]
rows = []
for payload, now, version in sequence:
    store.upsert_raw(conn, scope='day', key='2026-01-05', endpoint='user_summary', payload=payload, library_version=version, now_ms=now)
    rows.append(conn.execute('select raw,fetched_at,checked_at,library_version from raw_response').fetchone())
print(json.dumps(rows))
