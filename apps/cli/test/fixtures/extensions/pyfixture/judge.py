"""배포된 core fixture를 Python으로 판정해 이름과 판정을 JSON으로 출력한다."""
import importlib.util
import json
import math
import sys
from pathlib import Path
import jsonschema

root = Path(sys.argv[1])
abi = root / 'fixtures/process-abi/v1'
schemas = root / 'schemas/process-abi/v1'
def load(path):
    return json.loads(path.read_text(encoding='utf-8'))
def validator(name):
    return jsonschema.Draft202012Validator(load(schemas / name))
event_schema = validator('event.schema.json')
env_schema = validator('env.schema.json')
snapshot_schema = validator('settings-snapshot.schema.json')
spec = importlib.util.spec_from_file_location('manifests', root / 'fixtures/extensions/v1/check-manifests.py')
manifests = importlib.util.module_from_spec(spec)
spec.loader.exec_module(manifests)

def event(line):
    try:
        obj = json.loads(line, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, TypeError):
        return None, 'ABI_LINE_INVALID'
    if not isinstance(obj, dict):
        return None, 'ABI_LINE_INVALID'
    version = obj.get('abi')
    if 'abi' in obj and (type(version) not in (int, float) or version != 1):
        return None, 'ABI_VERSION_UNKNOWN'
    return (obj, None) if event_schema.is_valid(obj) else (None, 'ABI_LINE_INVALID')

def snapshot(raw):
    if not isinstance(raw, str) or len(raw.encode('utf-8')) > 16384:
        return False
    try:
        value = json.loads(raw, parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except ValueError:
        return False
    if not snapshot_schema.is_valid(value) or value['extension'] != 'testext':
        return False
    types = {'testext.limit': 'number', 'testext.token': 'string'}
    for key, item in value['values'].items():
        if key not in types:
            return False
        if types[key] == 'number' and (type(item) not in (int, float) or not math.isfinite(item)):
            return False
        if types[key] == 'string' and not isinstance(item, str):
            return False
    return True

def run(case):
    text = ''.join(part if isinstance(part, str) else part['repeat'] * part['count'] for part in case['stdout'])
    final = None
    usage = None
    failure = None
    fragments = text.split('\n')
    for line in fragments[:-1]:
        if len(line.encode('utf-8')) > 65536:
            failure = 'ABI_LINE_TOO_LONG'; break
        obj, failure = event(line)
        if failure:
            break
        if obj['type'] in ('result', 'error'):
            if final:
                failure = 'ABI_DUPLICATE_FINAL'; break
            final = obj
            if obj['type'] == 'result':
                usage = obj.get('usage')
    if not failure and fragments[-1]:
        failure = 'ABI_LINE_TOO_LONG' if len(fragments[-1].encode('utf-8')) > 65536 else 'ABI_LINE_TRUNCATED'
    if failure:
        return {'outcome': 'failed', 'code': failure, 'retryable': failure in ('ABI_LINE_TRUNCATED', 'ABI_EXIT_FAILED', 'ABI_OUTPUT_UNREADABLE', 'PROCESS_START_FAILED'), 'usage': usage}
    if final and final['type'] == 'error':
        return {'outcome': 'failed', 'code': final['code'], 'retryable': final['retryable'], 'usage': usage}
    clean = case['exit']['code'] == 0 and case['exit']['signal'] is None
    if final and clean:
        return {'outcome': 'succeeded', 'usage': usage}
    code = 'ABI_EXIT_AFTER_RESULT' if final else 'ABI_NO_RESULT' if clean else 'ABI_EXIT_FAILED'
    return {'outcome': 'failed', 'code': code, 'retryable': code == 'ABI_EXIT_FAILED', 'usage': usage}

result = {}
result['manifests'] = [{'name': c['name'], 'verdict': manifests.valid(c['manifest'])} for c in manifests.fixtures]
result['env'] = [{'name': c['name'], 'verdict': env_schema.is_valid(c['env'])} for c in load(abi / 'env.json')]
result['events'] = [{'name': c['name'], 'verdict': event(c['line'])[1] or True} for c in load(abi / 'events.json')]
result['runs'] = [{'name': c['name'], 'verdict': run(c)} for c in load(abi / 'runs.json')]
result['settings-snapshots'] = [{'name': c['name'], 'verdict': snapshot(c['snapshot'])} for c in load(abi / 'settings-snapshots.json')]
print(json.dumps(result, ensure_ascii=False))
