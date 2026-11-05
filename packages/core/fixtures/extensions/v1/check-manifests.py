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
        if any(k not in keys for k in item.get('required_settings', [])):
            return False
        report = item.get('public_report')
        if report and set(report['counts']) & set(report['checks']):
            return False
    auth = value.get('auth')
    if auth and (not auth['kind'].startswith(name + '.') or auth['kind'] in kinds):
        return False
    return all(schedule['kind'] in kinds for schedule in value.get('default_schedules', []))

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
