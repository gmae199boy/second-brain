"""Test-only network seam, copied only into a disposable installed extension.

The real manifest, entry, DB, locks and collector remain in use. The fake owns
no credentials or external network and writes a synthetic request ledger.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from garmin_pipeline import garmin

root = Path(os.environ['BRAIN_EXTENSION_HOME'])
ledger = root / 'synthetic-requests.jsonl'


def record(kind, endpoint=None, key=None):
    item = {'work': os.environ['BRAIN_WORK_ID'], 'target': os.environ['BRAIN_TARGET_ID'],
            'kind': kind, 'endpoint': endpoint, 'key': key}
    with ledger.open('a', encoding='utf-8') as stream:
        stream.write(json.dumps(item) + '\n'); stream.flush(); os.fsync(stream.fileno())


class FakeClient:
    profile_id = 12345
    def login(self, tokenstore):
        record('login')
        marker = root / 'synthetic-refresh'
        if marker.exists():
            Path(tokenstore, 'garmin_tokens.json').write_bytes(b'synthetic-refreshed-token')
            marker.unlink()


def fake(endpoint, key):
    record('data', endpoint, str(key))
    if endpoint == 'hrv_data' and (root / 'synthetic-hold').exists():
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(300)'])
        (root / 'synthetic-pids.json').write_text(json.dumps({'leader': os.getpid(), 'child': child.pid}))
        while (root / 'synthetic-hold').exists(): time.sleep(0.05)
    if endpoint == 'activities_by_date': return []
    return None


garmin._configured_client = lambda cfg: FakeClient()
garmin._DAY_CALLS = {endpoint: (lambda client, day, endpoint=endpoint: fake(endpoint, day)) for endpoint in garmin.DAY_ENDPOINTS}
garmin._ACTIVITY_CALLS = {endpoint: (lambda client, activity, endpoint=endpoint: fake(endpoint, activity)) for endpoint in garmin.ACTIVITY_ENDPOINTS}
garmin.random.uniform = lambda low, high: 0
# Keep today deterministic and make already received data final on restart.
from datetime import date
from garmin_pipeline import dates
dates.today = lambda cfg: date(2026, 1, 1)
dates.now_ms = lambda: 1767312000000
dates.system_timezone = lambda: 'UTC'
