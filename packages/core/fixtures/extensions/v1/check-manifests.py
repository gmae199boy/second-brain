"""선택 Python fixture 검사: uv run --with jsonschema python .../check-manifests.py."""
import json
import math
import re
import subprocess
from pathlib import Path
import jsonschema

root = Path(__file__).resolve().parents[3]
schema = json.loads((root / 'schemas/extensions/v1/manifest.schema.json').read_text())
fixtures = json.loads(Path(__file__).with_name('manifests.json').read_text())
validator = jsonschema.Draft202012Validator(schema)

def _valid(value, schema_adapter=None):
    if not validator.is_valid(value):
        return False
    name = value['name']
    fields = ('files', 'core_compat', 'plugin_version')
    if any(field in value for field in fields):
        if not all(field in value for field in fields):
            return False
        files = value['files']
        version = re.compile(r'^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$')
        compat = value['core_compat']
        if files != sorted(set(files)) or 'manifest.json' not in files or 'digest' in files or not version.fullmatch(value['version']) or not version.fullmatch(value['plugin_version']):
            return False
        if tuple(map(int, compat['min'].split('.'))) >= tuple(map(int, compat['max_exclusive'].split('.'))):
            return False
    commands = value.get('commands', [])
    if commands and ('_' in name or name in ('install', 'run', 'login', 'list', 'status', 'enable', 'disable')):
        return False
    names = [command['name'] for command in commands]
    if len(names) != len(set(names)):
        return False
    def asynchronous(value):
        if not isinstance(value, dict):
            return False
        if value.get('$async') is True:
            return True
        for key in ('$defs', 'definitions', 'properties', 'patternProperties', 'dependentSchemas'):
            children = value.get(key)
            if isinstance(children, dict) and any(asynchronous(child) for child in children.values()):
                return True
        for key in ('allOf', 'anyOf', 'oneOf', 'prefixItems'):
            children = value.get(key)
            if isinstance(children, list) and any(asynchronous(child) for child in children):
                return True
        return any(asynchronous(value.get(key)) for key in ('items', 'additionalItems', 'additionalProperties', 'unevaluatedProperties', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else', 'contentSchema'))
    for command in commands:
        if asynchronous(command['input_schema']) or asynchronous(command['output_schema']):
            return False
        # The installed runtime owns AJV and its exact reference interpretation.
        # Reuse it here, together with Core's codec, without fetching schemas.
        adapter = Path(schema_adapter) if schema_adapter else root.parent.parent / 'apps/cli/dist/runtime/json-schema.js'
        script = "import {pathToFileURL} from 'node:url';let s='';for await(const c of process.stdin)s+=c;const {maskOutputValue}=await import(pathToFileURL(process.argv[1]));const {validateSchema}=await import(pathToFileURL(process.argv[2]));const x=JSON.parse(s);process.stdout.write(validateSchema(x.input)&&validateSchema(x.output)&&JSON.stringify(x.input)===JSON.stringify(maskOutputValue(x.input))?'1':'0')"
        try:
            jsonschema.Draft202012Validator.check_schema(command['input_schema'])
            jsonschema.Draft202012Validator.check_schema(command['output_schema'])
            result = subprocess.run(['node', '--input-type=module', '-e', script, str(root / 'dist/output/mask.js'), str(adapter)], input=json.dumps({'input': command['input_schema'], 'output': command['output_schema']}), text=True, capture_output=True, check=True)
            if result.stdout != '1':
                return False
        except (OSError, subprocess.SubprocessError, jsonschema.SchemaError):
            return False
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
    aliases = [w['manual'] for w in work if 'manual' in w]
    if len(aliases) != len(set(aliases)):
        return False
    for item in work:
        if 'input_schema' in item:
            schema = item['input_schema']
            if asynchronous(schema):
                return False
            try:
                jsonschema.Draft202012Validator.check_schema(schema)
                adapter = Path(schema_adapter) if schema_adapter else root.parent.parent / 'apps/cli/dist/runtime/json-schema.js'
                script = "import {pathToFileURL} from 'node:url';let s='';for await(const c of process.stdin)s+=c;const {validateSchema}=await import(pathToFileURL(process.argv[1]));process.stdout.write(validateSchema(JSON.parse(s))?'1':'0')"
                result = subprocess.run(['node', '--input-type=module', '-e', script, str(adapter)], input=json.dumps(schema), text=True, capture_output=True, check=True)
                if result.stdout != '1':
                    return False
            except (OSError, subprocess.SubprocessError, jsonschema.SchemaError):
                return False
        if any(k not in keys for k in item.get('required_settings', [])):
            return False
        report = item.get('public_report')
        if report and set(report['counts']) & set(report['checks']):
            return False
    auth = value.get('auth')
    if auth and (not auth['kind'].startswith(name + '.') or auth['kind'] in kinds):
        return False
    schedules = value.get('default_schedules', [])
    for schedule in schedules:
        target = schedule.get('target_setting')
        if target is not None and not any(s['key'] == target and s['type'] == 'string' and s.get('scope', 'user') == 'user' and not s.get('secret', False) and 'machine' not in s for s in settings):
            return False
    schedule_keys = [s.get('key', f"{s['kind']}:{s['target_kind']}:{s['target_id']}") for s in schedules]
    if len(schedule_keys) != len(set(schedule_keys)) or not all(schedule['kind'] in kinds for schedule in schedules):
        return False
    for entry in schedules:
        if 'after_schedule' not in entry:
            continue
        parent = next((item for item, key in zip(schedules, schedule_keys) if key == entry['after_schedule']), None)
        if (parent is None or parent is entry or 'after_schedule' in parent or parent['target_kind'] != entry['target_kind']
                or parent.get('target_setting') != entry.get('target_setting')
                or ('target_setting' not in parent and parent['target_id'] != entry['target_id'])
                or parent.get('time_zone') is None or parent.get('time_zone') != entry.get('time_zone')
                or 'local_time' in parent or 'local_time' in entry):
            return False
    return True

def valid(value, schema_adapter=None):
    try:
        return _valid(value, schema_adapter)
    except Exception:
        return False

def deep_fixture():
    recipe = json.loads(Path(__file__).with_name('deep-schema.json').read_text())
    schema = {}
    for _ in range(recipe['depth']):
        schema = {'type': 'object', 'properties': {'x': schema}}
    command = {'name': 'echo', 'runtime': 'node', 'entry': 'echo.mjs', 'description': '조회', 'input_schema': schema, 'output_schema': {'type': 'object'}, 'timeout_ms': 100, 'risk': 'read'}
    return recipe, {**fixtures[0]['manifest'], 'commands': [command]}

if __name__ == '__main__':
    for fixture in fixtures:
        assert valid(fixture['manifest']) == (fixture['expect'] == 'valid'), fixture['name']
    recipe, deep = deep_fixture()
    assert valid(deep) == (recipe['expect'] == 'valid'), recipe['name']
    print(f'{len(fixtures) + 1} manifest fixtures passed')
