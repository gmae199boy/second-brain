"""v8 순수 계산과 수집 port의 경계 검증."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'extensions/garmin/src'))
from collect_client import UnavailableClient
from collect_normalize import NormalizeParseError, user_summary
from collect_store import covered, prepare, publish

catalog = json.loads((root / 'packages/core/schemas/health/v1/catalog.json').read_text())['metrics']
response = dict(totalSteps=12.5, totalDistanceMeters=None, activeKilocalories=-1,
                moderateIntensityMinutes=1.5, vigorousIntensityMinutes=0,
                minHeartRate=None, maxHeartRate=100, label='한글')
raw = json.dumps(response, ensure_ascii=False)
assert user_summary(raw, '2026-01-01') == dict(steps=12, distance_m=None, active_kcal=None,
    moderate_intensity_s=90, vigorous_intensity_s=0, min_hr=None, max_hr=100)
for change in ({'totalSteps': True}, {'totalSteps': float('nan')}):
    try:
        user_summary(json.dumps(response | change), '2026-01-01')
    except NormalizeParseError:
        pass
    else:
        raise AssertionError('invalid number accepted')
try:
    user_summary('{}', '2026-01-01')
except NormalizeParseError:
    pass
else:
    raise AssertionError('missing field accepted')
try:
    UnavailableClient().user_summary('2026-01-01')
except ValueError as exc:
    assert str(exc) == 'COLLECT_CLIENT_UNAVAILABLE'
else:
    raise AssertionError('default client must fail closed')
p = prepare(response, '2026-01-01', catalog, datetime(2026, 1, 1, tzinfo=timezone.utc))
assert p['body'] == raw and p['value'] == 12 and len(p['revision']) == 64

class Connection:
    def __init__(self, valid=True, exists=False):
        self.valid, self.exists, self.calls, self.row = valid, exists, [], None
    @contextmanager
    def transaction(self):
        self.calls.append('begin')
        try:
            yield
        except Exception:
            self.calls.append('rollback')
            raise
        else:
            self.calls.append('commit')
    def cursor(self): return self
    def execute(self, sql, args=()):
        self.calls.append(sql)
        if 'attempt_valid' in sql: self.row = (self.valid,)
        elif 'select exists' in sql: self.row = (self.exists,)
        elif 'select account,account_confirmed' in sql: self.row = ('acct', True, None)
        return self
    def fetchone(self): return self.row

conn = Connection()
assert not covered(conn, 'acct', '2026-01-01')
assert publish(conn, 'acct', '2026-01-01', 'UTC', 'work', 'token', p)
assert conn.calls[-1] == 'commit'
assert sum('insert into ' in x for x in conn.calls) == 5
conn = Connection(valid=False)
try:
    publish(conn, 'acct', '2026-01-01', 'UTC', 'work', 'token', p)
except ValueError as exc:
    assert str(exc) == 'COLLECT_INVALID_ATTEMPT'
else:
    raise AssertionError('stale attempt accepted')
assert conn.calls[-1] == 'rollback' and not any('insert into ' in x for x in conn.calls)
conn = Connection(exists=True)
assert not publish(conn, 'acct', '2026-01-01', 'UTC', 'work', 'token', p)
assert not any('insert into ' in x for x in conn.calls)
print('수집 순수 계산과 port 검사 통과')

# ABI 검증과 worker 경계를 실제 연결 없이 검사한다.
import collect
from contextlib import redirect_stdout
from io import StringIO

env = {'BRAIN_ABI_VERSION': '1', 'BRAIN_WORK_KIND': 'garmin.collect',
       'BRAIN_TARGET_KIND': 'account', 'BRAIN_TARGET_ID': 'acct',
       'BRAIN_RUN_GENERATION': '1', 'BRAIN_WORK_ID': '00000000-0000-0000-0000-000000000001',
       'BRAIN_ATTEMPT_TOKEN': '00000000-0000-0000-0000-000000000002',
       'BRAIN_DATABASE_URL': 'postgresql://fixture', 'BRAIN_RANGE_FROM': '2026-01-01',
       'BRAIN_RANGE_TO': '2026-01-01', 'BRAIN_SETTINGS_SNAPSHOT': json.dumps(
           {'version': 1, 'extension': 'garmin', 'values': {'garmin.timezone': 'UTC'}})}
assert collect.inputs(env) == ('acct', '2026-01-01', 'UTC')
for change in ({'BRAIN_ACCOUNT': 'other'}, {'BRAIN_TARGET_KIND': 'user'},
               {'BRAIN_RANGE_TO': '2026-01-02'}, {'BRAIN_RUN_GENERATION': '0'},
               {'BRAIN_ATTEMPT_TOKEN': 'bad'}, {'BRAIN_SETTINGS_SNAPSHOT': '{}'}):
    try:
        collect.inputs(env | change)
    except (ValueError, KeyError):
        pass
    else:
        raise AssertionError('invalid ABI input accepted')

class WorkerConn(Connection):
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def execute(self, sql, args=()):
        if 'health_catalog_v1' in sql:
            self.calls.append(sql)
            self.row = (next(m for m in catalog if m['metric'] == 'daily_metric.steps'),)
            return self
        return super().execute(sql, args)

class Client:
    def __init__(self): self.calls = 0
    def user_summary(self, day):
        self.calls += 1
        return response

conn, client, output = WorkerConn(), Client(), StringIO()
with redirect_stdout(output):
    collect.run(client, env, lambda *a, **k: conn)
assert client.calls == 1
assert [json.loads(line)['type'] for line in output.getvalue().splitlines()] == ['progress', 'progress', 'result']
conn, client, output = WorkerConn(exists=True), Client(), StringIO()
with redirect_stdout(output):
    collect.run(client, env, lambda *a, **k: conn)
assert client.calls == 0
assert [json.loads(line)['type'] for line in output.getvalue().splitlines()] == ['progress', 'result']
collect._stopping = True
try:
    collect.run(Client(), env, lambda *a, **k: WorkerConn())
except ValueError as exc:
    assert str(exc) == 'COLLECT_STOPPED'
else:
    raise AssertionError('stop ignored')
finally:
    collect._stopping = False
print('수집 ABI와 worker 경계 검사 통과')
