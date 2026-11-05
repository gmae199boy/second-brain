"""합성 값과 원본 정규화 소유권의 독립 기대값을 확인한다."""
import ast
import json
from pathlib import Path
import sys
import tarfile

root = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(root / 'extensions/garmin/src'))
from batch_import import encoded, canonical
from health import source_endpoint, import_candidates

assert encoded(None) == {'type': 'null'}
assert encoded(0) == {'type': 'integer', 'value': 0}
assert encoded(-3) == {'type': 'integer', 'value': -3}
assert encoded(1.5) == {'type': 'real', 'value': '0x1.8000000000000p+0'}
assert encoded('한글\x00') == {'type': 'text', 'base64': '7ZWc6riAAA=='}
assert encoded(b'\x00\xff') == {'type': 'blob', 'base64': 'AP8='}
assert canonical([encoded(None), encoded(7)]) == '[{"type":"null"},{"type":"integer","value":7}]'

archive = root / '_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz'
with tarfile.open(archive) as bundle:
    daily = bundle.extractfile('garmin-source/src/garmin_pipeline/normalize/daily.py').read().decode()
    activity = bundle.extractfile('garmin-source/src/garmin_pipeline/normalize/activity.py').read().decode()
    registry = bundle.extractfile('garmin-source/src/garmin_pipeline/normalize/__init__.py').read().decode()

def literal_constants(text):
    found = {}
    for node in ast.parse(text).body:
        if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
            try: found[node.targets[0].id] = ast.literal_eval(node.value)
            except (ValueError, TypeError): pass
    return found

owners = {'USER_SUMMARY_COLUMNS':'user_summary','RHR_DAY_COLUMNS':'rhr_day','HRV_DATA_COLUMNS':'hrv_data',
          'TRAINING_READINESS_COLUMNS':'training_readiness','SLEEP_DATA_COLUMNS':'sleep_data',
          'STRESS_DATA_COLUMNS':'stress_data','BODY_BATTERY_COLUMNS':'body_battery'}
constants = literal_constants(daily)
expected = {('daily_metric', column): endpoint for name, endpoint in owners.items() for column in constants[name]}
expected.update({('activity', column): 'activity' for column in literal_constants(activity)['ACTIVITY_COLUMNS']})
expected.update({('activity', f'hr_zone{n}_{suffix}'): 'activity_hr_in_timezones' for n in range(1, 6) for suffix in ('s','low_bpm')})
expected.update({('exercise_set', column): 'activity_exercise_sets' for column in literal_constants(activity)['EXERCISE_SET_COLUMNS']})
for table, endpoint, columns in [('body_battery_sample','body_battery',['level']),('stress_bb_sample','stress_data',['level']),('hr_sample','heart_rates',['bpm']),('activity_hr_sample','activity_details',['bpm','body_battery'])]:
    assert f'"{table}"' in registry and f'"{endpoint}"' in registry
    expected.update({(table,column):endpoint for column in columns})
catalog = json.loads((root/'packages/core/schemas/health/v1/catalog.json').read_text())['metrics']
for metric in catalog:
    for mapping in metric['mappings']:
        pair = (mapping['table'],mapping['column'])
        assert source_endpoint(*pair) == expected.get(pair), pair

snapshot={'tables':{'meta':{'rows':[{'key':'normalize_version','value':'2'}, {'key':'timezone','value':'Asia/Seoul'}]},
 'raw_response':{'rows':[{'scope':'day','key':'2026-01-01','endpoint':'user_summary','raw':'원문','fetched_at':1234}]},
 'normalize_result':{'rows':[{'scope':'day','key':'2026-01-01','endpoint':'user_summary','ok':1,'raw_fetched_at':1234}]}}}
metric=next(m for m in catalog if m['metric']=='daily_metric.steps')
result=list(import_candidates(snapshot,[metric],'daily_metric',{'day_key':'2026-01-01','steps':None}))[0]
assert result[2]['value'] is None and result[2]['version'] == 2 and result[2]['day'] == '2026-01-01'
snapshot['tables']['meta']['rows'].pop(0)
assert list(import_candidates(snapshot,[metric],'daily_metric',{'day_key':'2026-01-01','steps':1}))[0][3] == '정규화 버전 없음'
print('독립 값·catalog 원천 소유권 검증 성공')
