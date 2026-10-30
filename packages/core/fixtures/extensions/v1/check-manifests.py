"""선택 Python fixture 검사: uv run --with jsonschema python .../check-manifests.py."""
import json
import math
import re
from pathlib import Path
import jsonschema

root = Path(__file__).resolve().parents[3]
schema = json.loads((root / 'schemas/extensions/v1/manifest.schema.json').read_text())
fixtures = json.loads(Path(__file__).with_name('manifests.json').read_text())
validator = jsonschema.Draft202012Validator(schema)

def valid(value):
    if not validator.is_valid(value):
        return False
    name = value['name']
    settings = value.get('settings', [])
    keys = [s['key'] for s in settings]
    if len(keys) != len(set(keys)) or any(not k.startswith(name + '.') for k in keys):
        return False
    for setting in settings:
        default = setting.get('default')
        if default is None:
            continue
        if setting.get('secret') and not re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', default):
            return False
        if setting['type'] == 'boolean' and default not in ('true', 'false'):
            return False
        if setting['type'] == 'number':
            if not re.fullmatch(r'-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?', default) or not math.isfinite(float(default)):
                return False
    work = value.get('work', [])
    kinds = [w['kind'] for w in work]
    if len(kinds) != len(set(kinds)) or any(not k.startswith(name + '.') for k in kinds):
        return False
    auth = value.get('auth')
    if auth and (not auth['kind'].startswith(name + '.') or auth['kind'] in kinds):
        return False
    return all(schedule['kind'] in kinds for schedule in value.get('default_schedules', []))

for fixture in fixtures:
    assert valid(fixture['manifest']) == (fixture['expect'] == 'valid'), fixture['name']
print(f'{len(fixtures)} manifest fixtures passed')
