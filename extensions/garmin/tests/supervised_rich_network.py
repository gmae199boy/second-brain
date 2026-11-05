"""Fake network for installed-entry integration only; no real account or network."""
import json
import os
import sys
import time
from datetime import date
from pathlib import Path
from garmin_pipeline import dates, garmin

root = Path(os.environ['BRAIN_EXTENSION_HOME'])
sys.path.insert(0, str(root / 'tests'))
from collect_oracle_support import DAY, NOW, fixture

values = {(i['scope'], i['key'], i['endpoint']): json.loads(i['raw']) for i in fixture()['items']}
target = os.environ['BRAIN_TARGET_ID']
work = os.environ['BRAIN_WORK_ID']


def record(kind, endpoint=None, key=None):
    with (root / 'rich-requests.jsonl').open('a', encoding='utf-8') as stream:
        stream.write(json.dumps({'work': work, 'target': target, 'kind': kind, 'endpoint': endpoint, 'key': key}) + '\n')
        stream.flush(); os.fsync(stream.fileno())


class SyntheticAuthError(Exception):
    __module__ = 'garminconnect.synthetic'


class Client:
    profile_id = 'synthetic-profile-' + target
    def login(self, tokenstore):
        record('login')
        mode = root / ('auth-' + target)
        if mode.exists():
            raise SyntheticAuthError(mode.read_text())


def fetch(scope, endpoint, key):
    key = str(key); record('data', endpoint, key)
    marker = root / ('hold-' + target)
    if endpoint == 'hrv_data' and marker.exists():
        (root / ('waiting-' + work)).write_text('waiting')
        while marker.exists(): time.sleep(0.05)
        if (root / ('fail-' + work)).exists(): raise SyntheticAuthError('HTTP 503')
    return values.get((scope, key, endpoint))


garmin._configured_client = lambda cfg: Client()
garmin._DAY_CALLS = {name: (lambda client, day, name=name: fetch('day', name, day)) for name in garmin.DAY_ENDPOINTS}
garmin._ACTIVITY_CALLS = {name: (lambda client, key, name=name: fetch('activity', name, key)) for name in garmin.ACTIVITY_ENDPOINTS}
garmin.random.uniform = lambda low, high: 0
dates.today = lambda cfg: DAY
dates.now_ms = lambda: NOW
dates.system_timezone = lambda: 'Asia/Seoul'
garmin.LIBRARY_VERSION = 'synthetic'
