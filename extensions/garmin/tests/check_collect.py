"""v8 순수 계산과 수집 port의 경계 검증."""
from contextlib import contextmanager
from datetime import datetime, timezone
import json
from pathlib import Path
import sys

sys.dont_write_bytecode = True
root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'extensions/garmin/src'))
from collect_normalize import NormalizeParseError, user_summary
import collect_store
from collect_store import raw_transition
from unittest.mock import Mock, patch

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
p = raw_transition(None,response,'v',1767225600000)
assert p['body'] == raw

# 짝 없는 surrogate가 원문과 걸음 수의 같은 트랜잭션 발행을 막지 않는다.
surrogate_response = response | {'note': '\ud83d'}
cursor = Mock()
cursor.fetchone.return_value = None
@contextmanager
def write_fixture(*args):
    yield cursor, 'fixture-dataset'
publish = Mock()
with patch.object(collect_store, '_write', write_fixture):
    stored = collect_store.upsert_raw(None, 'acct', 'work', 'token', 'day', '2026-01-01',
        'user_summary', surrogate_response, 'v', 1767225600000, publish=publish)
raw_insert = next(call for call in cursor.execute.call_args_list
                  if 'insert into garmin.raw_payloads' in call.args[0])
assert raw_insert.args[1][6] == stored['body']
assert json.loads(stored['body']) == surrogate_response
assert publish.call_args.args[-1] == stored

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
args = collect.inputs(env)
assert args['target_id'] == 'acct' and args['day'].isoformat() == '2026-01-01'
assert args['settings']['garmin.timezone'] == 'UTC'
manual = {k: v for k, v in env.items() if k not in ('BRAIN_RANGE_FROM', 'BRAIN_RANGE_TO')}
manual['BRAIN_TARGET_KIND'] = 'extension'
manual['BRAIN_TARGET_ID'] = 'default'
assert collect.inputs(manual)['day'] is None
assert collect.inputs(manual | {'BRAIN_WORK_KIND': 'garmin.collect_recent'})['recent']
for change in ({'BRAIN_ACCOUNT':'other'}, {'BRAIN_TARGET_KIND':'user'}, {'BRAIN_RANGE_TO':'2026-01-02'},
               {'BRAIN_RUN_GENERATION':'0'}, {'BRAIN_ATTEMPT_TOKEN':'bad'}, {'BRAIN_SETTINGS_SNAPSHOT':'{}'}):
    try:
        collect.inputs(env | change)
    except (ValueError, KeyError):
        pass
    else:
        raise AssertionError('invalid ABI input accepted')
for values in ({'garmin.timezone':'UTC','garmin.unknown':1},
               {'garmin.timezone':'UTC','garmin.call_pause_min_seconds':3,'garmin.call_pause_max_seconds':2},
               {'garmin.timezone':'UTC','garmin.max_dates_per_run':2}):
    invalid_env = env | {'BRAIN_SETTINGS_SNAPSHOT':json.dumps({'version':1,'extension':'garmin','values':values})}
    try:
        collect.run(env=invalid_env, connect=lambda *a, **k: (_ for _ in ()).throw(AssertionError('DB 연결됨')))
    except ValueError:
        pass
    else:
        raise AssertionError('잘못된 설정 허용')
output = StringIO()
with redirect_stdout(output):
    collect.result('success', 123, __import__('datetime').date(2026,1,1))
event = json.loads(output.getvalue())
assert event['type'] == 'result' and json.loads(event['summary']) == {'status':'success','cutoff_ms':123,'local_date':'2026-01-01','normalized':0,'normalize_failed':0}
print('수집 ABI 입력과 결과 검사 통과')
