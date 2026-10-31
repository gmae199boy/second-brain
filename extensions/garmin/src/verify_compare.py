"""읽기 전용 반입 검증의 고정 비교 규칙."""
import base64
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
import os
from pathlib import Path
import stat

from analysis_codec import project_analysis
from analyses import original_bytes
from artifacts import MAX_BYTES, classify, read_relative, scan_log, encode_identity
from batch_import import VERSION, canonical, contains_nul, contract_fingerprint, encoded
from capture_manifest import ROLES
from health import import_candidates, resolve
from metadata_codec import decode_metadata
from preflight import ORDER, account, analyze
from raw_codec import dataset_ref, project
from reader import read_snapshot

CHECKS = ('source_unchanged', 'checkpoints', 'schemas', 'preserved', 'mappings', 'raw', 'health', 'authority', 'legacy', 'analyses', 'files', 'relations', 'inventory', 'provenance', 'conflicts', 'no_outbound')
COUNTS = ('datasets', 'source_tables', 'source_rows', 'preserved_rows', 'health_rows', 'raw_rows', 'legacy_rows', 'analysis_rows', 'file_requests', 'artifacts', 'excluded', 'unlinked', 'unselected', 'unselected_ambiguous', 'unselected_account_unconfirmed', 'unselected_timezone_unconfirmed', 'unselected_dataset_ambiguous', 'unselected_dataset_unselected', 'unselected_revision_ambiguous', 'unselected_version_unsupported', 'unselected_value_ambiguous', 'excluded_config', 'excluded_secret', 'excluded_scan_failed', 'excluded_too_large', 'excluded_unknown', 'conflict_entries', 'outbound_requests', 'outbound_results', 'source_conflict_keys', 'raw_conflict_keys', 'raw_metadata_conflict_keys', 'excluded_keys', 'unassigned_files', 'mismatches')


def public_projection(details):
    """동적 값은 공개 결과로 복사하지 않는다."""
    if any(type(details['counts'].get(key, 0)) is not int or not 0 <= details['counts'].get(key, 0) <= 9007199254740991 for key in COUNTS): raise ValueError('IMPORT_INVALID')
    return {'counts': {key: details['counts'].get(key, 0) for key in COUNTS},
            'checks': {key: not bool(details['differences'].get(key)) for key in CHECKS}}


def json_equal(left, right):
    """JSON 숫자의 표현 차이는 허용하고 boolean과 숫자는 분리한다."""
    if isinstance(left, bool) or isinstance(right, bool):
        return type(left) is bool and type(right) is bool and left == right
    if isinstance(left, (int, float, Decimal)) and isinstance(right, (int, float, Decimal)):
        return left == right
    if isinstance(left, str) and isinstance(right, str): return left == right
    if type(left) is not type(right): return False
    if isinstance(left, dict):
        return left.keys() == right.keys() and all(json_equal(left[k], right[k]) for k in left)
    if isinstance(left, list):
        return len(left) == len(right) and all(json_equal(a, b) for a, b in zip(left, right))
    return left == right


def target_payload_hash(value, expected):
    """JSONB가 보존한 동등 숫자 표기를 원본의 숫자 표기로 정렬해 해시한다."""
    def align(actual, source):
        if isinstance(actual, (int, float)) and not isinstance(actual, bool) and isinstance(source, (int, float)) and not isinstance(source, bool) and actual == source:
            return source
        if isinstance(actual, dict) and isinstance(source, dict):
            return {k: align(v, source[k]) if k in source else v for k,v in actual.items()}
        if isinstance(actual, list) and isinstance(source, list):
            return [align(v, source[i]) if i < len(source) else v for i,v in enumerate(actual)]
        return actual
    return hashlib.sha256(canonical(align(value, expected)).encode()).hexdigest()


def read_core_snapshot(home, path, work, token):
    home, path = Path(home), Path(path)
    if not home.is_absolute() or path.parent != home / 'verification-snapshots' or not path.name.endswith('.json'):
        raise ValueError('IMPORT_INVALID')
    fd = os.open('/', os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in path.parent.parts[1:]:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=fd)
            os.close(fd); fd = child
        source = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        try:
            before = os.fstat(source)
            if not stat.S_ISREG(before.st_mode) or stat.S_IMODE(before.st_mode) != 0o600: raise ValueError('IMPORT_INVALID')
            with os.fdopen(source, 'rb', closefd=False) as stream: value = json.load(stream)
            after = os.fstat(source); current = os.stat(path.name, dir_fd=fd, follow_symlinks=False)
            if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns) or (before.st_dev, before.st_ino) != (current.st_dev, current.st_ino): raise ValueError('IMPORT_INVALID')
        finally: os.close(source)
    finally: os.close(fd)
    if not isinstance(value, dict) or value.get('version') != 1 or value.get('source') != 'garmin' or value.get('work_id') != work or value.get('attempt_token') != token or not isinstance(value.get('tables'), dict) or not isinstance(value.get('files'), list): raise ValueError('IMPORT_INVALID')
    # JSONB인 것이 계약으로 정해진 칸만 한 번 해석한다.
    for table, field in (('health','value_json'), ('channel_requests','bundle')):
        for row in value['tables'][table]:
            wrapped = row[field]
            if wrapped is not None:
                if not isinstance(wrapped, dict) or set(wrapped) != {'encoding','data'} or wrapped['encoding'] != 'jsonb-text-v1' or not isinstance(wrapped['data'], str): raise ValueError('IMPORT_INVALID')
                row[field] = json.loads(wrapped['data'], parse_float=Decimal, parse_int=Decimal)
    return value


def digest_file(path):
    with path.open('rb') as stream: return hashlib.file_digest(stream, 'sha256').hexdigest()


def raw_bytes(value):
    if value is None: return None
    if isinstance(value, dict) and value.get('encoding') == 'base64': return base64.b64decode(value['data'], validate=True)
    return bytes(value)


def matches_project(row, name, value, analysis=False):
    expected = (project_analysis if analysis else project)(value)
    return (row.get(name), raw_bytes(row.get(name + '_raw')), row.get(name + '_encoding')) == expected


def time_equal(value, expected):
    if value is None or expected is None: return value is None and expected is None
    if isinstance(value, str): value = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if isinstance(expected, str): expected = datetime.fromisoformat(expected.replace('Z', '+00:00'))
    return value == expected


def key(row, columns): return canonical([encoded(row[column]) for column in columns])


def source_json(candidate):
    """발행 원본 JSON의 수치를 이진 float로 반올림하지 않는다."""
    source = candidate.get('source_value')
    if isinstance(source, str):
        try:
            value = json.loads(source, parse_float=Decimal, parse_int=Decimal)
            if isinstance(value, (dict, list)): return value
        except ValueError: pass
    return candidate['value']


def resolution_json(value):
    # 순수 건강 판정에서 JSON 숫자 형식을 하나의 정확한 수치 타입으로 맞춘다.
    if isinstance(value, bool) or value is None: return value
    if isinstance(value, (int, float, Decimal)): return Decimal(str(value))
    if isinstance(value, list): return [resolution_json(v) for v in value]
    if isinstance(value, dict): return {k: resolution_json(v) for k,v in value.items()}
    return value


def logical_identity(value):
    display, raw, encoding = project(value)
    if display is None: return None
    return (encoding or 'utf-8', raw if raw is not None else display.encode('utf-8'))


def compare_resolution(groups, accounts, stored, tables, fail):
    """source 후보와 승인 규칙으로 기대 선택을 계산하고 core 결정을 대조한다."""
    versions = [row['version'] for row in tables['health_supported_versions']]
    if any(type(v) is not int or v < 1 for v in versions) or len(set(versions)) != len(versions):
        fail('authority', ['supported_versions']); return
    actual = tables['health_resolution']; decisions = []
    for identity, rows in groups.items():
        account_value = rows[0]['account']
        account_key = canonical(encoded(account_value)) if account_value is not None else None
        approved = accounts.get(account_key)
        provenance = [r for r in stored['authority_provenance'] if r.get('account_identity') == account_key] if approved else []
        authority = {'version': 1, 'datasets': approved[1]} if approved and len(provenance) == 1 else None
        expected_authority = str(provenance[0]['rule_id']) if authority else None
        expected = resolve(rows, versions, authority)
        dataset_set = {r['dataset'] for r in rows}
        if authority:
            selected_dataset = next((d for d in authority['datasets'] if d in dataset_set), None)
        else:
            selected_dataset = next(iter(dataset_set)) if len(dataset_set) == 1 else None
        ids = {r['id'] for r in rows}
        matches = [r for r in actual if ids.intersection(str(i) for i in (r.get('all_ids') or []))]
        if len(matches) != 1:
            fail('authority', [repr(identity), 'resolution_missing_or_duplicate']); continue
        row = matches[0]
        observed = {'current': str(row['current_id']) if row['current_id'] is not None else None,
                    'selected': sorted(str(i) for i in (row['selected_ids'] or [])),
                    'unselected': sorted(str(i) for i in (row['unselected_ids'] or [])),
                    'reason': row['reason'], 'dataset': row['dataset'],
                    'authority_id': str(row['authority_id']) if row['authority_id'] is not None else None,
                    'authority_version': row['authority_version'], 'all_ids': sorted(str(i) for i in (row['all_ids'] or []))}
        wanted = {'current': expected['current'], 'selected': sorted(expected['selected']),
                  'unselected': sorted(expected['unselected']), 'reason': expected['reason'],
                  'dataset': selected_dataset, 'authority_id': expected_authority,
                  'authority_version': expected['authorityVersion'], 'all_ids': sorted(ids)}
        decisions.append({'identity': repr(identity), 'expected': wanted, 'observed': observed})
        if observed != wanted: fail('authority', [repr(identity), 'resolution', wanted, observed])
    return decisions


def compare(capture, stored, core, catalog, conversation):
    differences = {name: [] for name in CHECKS}
    counts = {name: 0 for name in COUNTS}
    def fail(group, detail): differences[group].append(detail)
    def lookup(rows, **criteria):
        return [row for row in rows if all(str(row.get(k)) == str(v) for k, v in criteria.items())]
    tables = core['tables']; files = {str(row['request_id']): row for row in core['files']}
    mappings = stored['import_mapping']; preserved = stored['preserved_rows']; provenance = stored['import_provenance']
    expected_map = set(); expected_preserved = set(); expected_provenance = set(); expected_raw = set(); expected_health = set(); expected_legacy = set()
    fingerprint = contract_fingerprint(capture['private']['fingerprint'], catalog)
    entries = sorted(capture['private']['datasets'], key=lambda e: ORDER.index(ROLES[e['source']]))
    datasets = {}; batches = {}; snapshots = {}; accounts = {}; table_details = {}; health_details = {}; resolution_groups = {}
    counts['datasets'] = len(entries)
    for entry in entries:
        original = entry['dataset']; dataset = dataset_ref(original); datasets[original] = dataset
        path = capture['datasets'][ROLES[entry['source']]]
        batch = hashlib.sha256(canonical([capture['private']['capture_id'], dataset]).encode()).hexdigest(); batches[dataset] = batch
        before = digest_file(path); snapshot = read_snapshot(path); after = digest_file(path); snapshots[dataset] = snapshot
        if before != after or path.with_name(path.name + '-wal').exists(): fail('source_unchanged', [dataset, 'changed'])
        info = account(snapshot)
        if info['confirmed']: accounts.setdefault(canonical(encoded(info['account'])), (info['account'], []))[1].append(dataset)
        checkpoint = lookup(stored['import_checkpoints'], dataset=dataset, batch=batch)
        if len(lookup(stored['import_batches'], dataset=dataset, id=batch)) != 1: fail('checkpoints', [dataset, 'batch'])
        if checkpoint and checkpoint[0]['source_hash'] != before: fail('source_unchanged', [dataset, 'checkpoint_hash'])
        if len(checkpoint) != 1 or any(checkpoint[0].get(k) != v for k, v in {'source_hash': before, 'schema_version': snapshot['schema'], 'importer_version': VERSION, 'manifest_fingerprint': fingerprint, 'source_role': entry['source']}.items()) or (str(checkpoint[0].get('conversation_id')) if checkpoint and checkpoint[0].get('conversation_id') else None) != conversation: fail('checkpoints', [dataset, 'checkpoint'])
        record = lookup(stored['datasets'], dataset=dataset)
        label = original if original != dataset else None
        if len(record) != 1 or record[0]['account_confirmed'] != info['confirmed'] or not matches_project(record[0], 'account', info['account']) or not matches_project(record[0], 'dataset_label', label): fail('preserved', [dataset, 'dataset'])
        counts['source_tables'] += len(snapshot['tables'])
        last = None
        for name in sorted(snapshot['tables'], key=lambda n: (n != 'run', n)):
            table = snapshot['tables'][name]
            if not table['keys']: fail('schemas', [dataset, name, 'no_key']); continue
            schema = lookup(stored['source_schemas'], dataset=dataset, original_table=name)
            if len(schema) != 1 or schema[0]['schema_version'] != snapshot['schema'] or not json_equal(schema[0]['columns_json'], table['column_metadata']) or not json_equal(schema[0]['keys_json'], table['keys']): fail('schemas', [dataset, name])
            counts['source_rows'] += len(table['rows'])
            source_keys = {key(r, table['keys']) for r in table['rows']}
            target_rows = [r for r in preserved if r['dataset'] == dataset and r['original_table'] == name and r['original_key'] in source_keys]
            target_keys = {r['original_key'] for r in target_rows}
            table_details.setdefault(dataset, {})[name] = {'source_count':len(table['rows']), 'target_count':len(target_rows), 'missing_keys':sorted(source_keys - target_keys), 'extra_keys':[], 'source_nulls':{column:sum(row[column] is None for row in table['rows']) for column in table['columns']}, 'target_nulls':{column:sum(row['values_json'].get(column) == {'type':'null'} for row in target_rows) for column in table['columns']}, 'value_difference_keys':[key(r,table['keys']) for r in table['rows'] if any(x['original_key'] == key(r,table['keys']) and not json_equal(x['values_json'], {k:encoded(v) for k,v in r.items()}) for x in target_rows)], 'value_unit_check':'전수 비교'}
            for row in sorted(table['rows'], key=lambda r: key(r, table['keys'])):
                rowkey = key(row, table['keys']); last = (name, rowkey)
                payload = {k: encoded(v) for k, v in row.items()}; hashed = hashlib.sha256(canonical(payload).encode()).hexdigest()
                identity = (dataset, name, rowkey); expected_preserved.add(identity)
                def mapped(kind):
                    expected_map.add((*identity, kind))
                    found = lookup(mappings, dataset=dataset, original_table=name, original_key=rowkey, target_kind=kind)
                    if len(found) != 1 or found[0]['content_hash'] != hashed: fail('mappings', [*identity, kind]); return None
                    return found[0]
                mapping = mapped('preserved')
                target = lookup(preserved, dataset=dataset, original_table=name, original_key=rowkey)
                parent = None
                if name == 'fetch_error' and row.get('run_id') is not None:
                    parentmap = lookup(mappings, dataset=dataset, original_table='run', original_key=canonical([encoded(row['run_id'])]), target_kind='preserved')
                    if len(parentmap) == 1: parent = str(parentmap[0]['target_id'])
                    else: fail('preserved', [*identity, 'parent'])
                if len(target) != 1 or not mapping or str(target[0]['id']) != str(mapping['target_id']) or not json_equal(target[0]['values_json'], payload) or target_payload_hash(target[0]['values_json'], payload) != hashed or (str(target[0]['run_id']) if target[0]['run_id'] else None) != parent: fail('preserved', list(identity))
                for definition, column, candidate, reason in import_candidates(snapshot, catalog, name, row):
                    metric = definition['metric']; expected_provenance.add((*identity, metric))
                    found = lookup(provenance, dataset=dataset, original_table=name, original_key=rowkey, metric=metric)
                    if len(found) != 1 or found[0]['reason'] != (reason or '발행'): fail('provenance', [*identity, metric])
                    if candidate:
                        stat = health_details.setdefault(dataset, {}).setdefault(metric, {'source_count':0,'target_count':0,'source_nulls':0,'target_nulls':0,'value_differences':0,'unit_differences':0})
                        stat['source_count'] += 1; stat['source_nulls'] += int(candidate['value'] is None)
                        mapping = mapped('health:' + metric)
                        if not mapping: continue
                        ident = str(mapping['target_id']); expected_health.add(ident)
                        day = str(candidate['day']) if candidate['day'] is not None else None
                        observed_key = candidate['observed'].isoformat() if candidate['observed'] is not None else None
                        logical_key = (logical_identity(info['account']), metric, logical_identity(candidate['activity']), logical_identity(rowkey), day, observed_key, candidate['zone'])
                        logical_value = resolution_json(source_json(candidate)) if definition['type'] == 'json' else candidate['value']
                        if isinstance(logical_value, str): logical_value = str(logical_value)
                        resolution_groups.setdefault(logical_key, []).append({'id':ident, 'dataset':dataset, 'account':info['account'], 'accountConfirmed':info['confirmed'], 'date':day, 'timezone':candidate['zone'], 'fetchedAt':candidate['fetched_at'].isoformat(), 'revision':candidate['revision'], 'version':candidate['version'], 'value':[definition['type'],logical_value]})
                        found = lookup(tables['health'], id=ident)
                        if len(found) != 1: fail('health', [*identity, metric, 'missing']); continue
                        h = found[0]; value = candidate['value']; typ = definition['type']
                        stat['target_count'] += 1; stat['target_nulls'] += int(h.get('value' if typ == 'number' else 'value_text' if typ == 'text' else 'value_json') is None); stat['unit_differences'] += int(h.get('unit') != definition['unit'])
                        expected = {'source':'garmin', 'dataset':dataset, 'original_table':name, 'original_key':rowkey, 'metric':metric, 'unit':definition['unit'], 'value_type':typ, 'account_confirmed':info['confirmed'], 'normalization_version':candidate['version'], 'revision':candidate['revision'], 'time_zone':candidate['zone'], 'time_zone_missing':candidate['zone'] is None, 'sub_identity':rowkey, 'import_batch':mapping['batch'], 'catalog_version':1, 'value':value if typ == 'number' else None}
                        bad = any(not json_equal(h.get(k), v) for k, v in expected.items()) or not matches_project(h, 'account', info['account']) or not matches_project(h, 'activity_id', candidate['activity']) or not matches_project(h, 'dataset_label', label) or not matches_project(h, 'sub_identity', rowkey) or (typ == 'text' and not matches_project(h, 'value_text', value)) or (typ != 'text' and (h.get('value_text') is not None or h.get('value_text_raw') is not None)) or (typ != 'json' and (h.get('value_json') is not None or h.get('value_json_raw') is not None)) or not time_equal(h.get('observed_at'), candidate['observed']) or not time_equal(h.get('fetched_at'), candidate['fetched_at']) or (str(h.get('local_date'))[:10] if h.get('local_date') else None) != (str(candidate['day']) if candidate['day'] else None)
                        if typ == 'json' and value is not None:
                            original_json = candidate['source_value']; raw = original_json.raw if hasattr(original_json, 'raw') else original_json.encode('utf-8')
                            bad |= raw_bytes(h.get('value_json_raw')) != raw or h.get('value_json_encoding') != getattr(original_json, 'encoding', 'utf-8')
                            precise_value = source_json(candidate)
                            expected_json = {} if isinstance(precise_value, str) or precise_value.__class__.__name__ == 'InvalidSQLiteText' else ([] if isinstance(precise_value, list) else {}) if contains_nul(precise_value) else precise_value
                            bad |= not json_equal(h.get('value_json'), expected_json)
                        elif typ == 'json': bad |= h.get('value_json') is not None or h.get('value_json_raw') is not None
                        if bad:
                            stat['value_differences'] += 1
                            fail('health', [*identity, metric, 'value'])
                if name == 'raw_response':
                    rid = canonical([encoded(row[k]) for k in ('scope','key','endpoint')]); expected_raw.add((dataset, rid))
                    found = lookup(stored['raw_payloads'], dataset=dataset, raw_identity=rid)
                    if len(found) != 1 or any(not matches_project(found[0], field, value) for field, value in [('account',info['account']),('scope',row['scope']),('original_key',row['key']),('endpoint',row['endpoint']),('library_version',row['library_version']),('body',row['raw'])]) or found[0]['fetched_at_ms'] != row['fetched_at'] or found[0]['checked_at_ms'] != row['checked_at']: fail('raw', list(identity))
                    view = [v for v in tables['raw'] if matches_project(v, 'dataset', original) and all(matches_project(v, field, value) for field,value in [('account',info['account']),('scope',row['scope']),('original_key',row['key']),('endpoint',row['endpoint']),('body',row['raw'])])]
                    if len(view) != 1 or not time_equal(view[0]['fetched_at'], datetime.fromtimestamp(row['fetched_at']/1000, timezone.utc)) or not time_equal(view[0]['checked_at'], datetime.fromtimestamp(row['checked_at']/1000, timezone.utc)): fail('raw', [*identity,'view'])
                if name in ('notification','delivery'):
                    mapping = mapped('legacy')
                    conversation_row = lookup(stored['legacy_conversations'], dataset=dataset, original_table=name, original_key=rowkey)
                    if len(conversation_row) != 1 or str(conversation_row[0]['conversation_id']) != conversation: fail('legacy', [*identity,'conversation'])
                    if mapping:
                        ident = str(mapping['target_id']); expected_legacy.add(ident)
                        found = lookup(tables['legacy_notifications' if name == 'notification' else 'legacy_deliveries'], id=ident)
                        fields = ('local_date','event','detail') if name == 'notification' else ('local_date','kind','event','reason')
                        bad = len(found) != 1
                        if not bad:
                            v = found[0]; bad = any(not matches_project(v, f, row[f]) for f in fields) or v['dataset'] != dataset or v['original_table'] != name or v['original_key'] != rowkey or v['import_batch'] != mapping['batch'] or v['source'] != 'garmin' or not matches_project(v, 'dataset_label', label) or v['external_message_id'] is not None or v['body'] is not None or v['metadata_missing'] is not True or v['resend_eligible'] is not False or str(v['conversation_id']) != conversation or not time_equal(v['at'], datetime.fromtimestamp(row['at']/1000, timezone.utc)) or (name == 'delivery' and (v['ok'] != bool(row['ok']) or not matches_project(v, 'original_id', str(row['id']))))
                        if bad: fail('legacy', list(identity))
        if checkpoint and ((checkpoint[0]['original_table'], checkpoint[0]['original_key']) != (last if last else (None,None))): fail('checkpoints', [dataset, 'position'])
    counts['preserved_rows'] = len(expected_preserved); counts['health_rows'] = len(expected_health); counts['raw_rows'] = len(expected_raw); counts['legacy_rows'] = len(expected_legacy)
    current_preserved = {(m['dataset'],m['original_table'],m['original_key']) for m in mappings if m['target_kind'] == 'preserved' and m['dataset'] in batches and m['batch'] == batches[m['dataset']]}
    for dataset, name, rowkey in current_preserved - expected_preserved:
        if name in table_details.get(dataset, {}): table_details[dataset][name]['extra_keys'].append(rowkey)
    all_preserved = {(m['dataset'],m['original_table'],m['original_key']) for m in mappings if m['target_kind'] == 'preserved'}
    for r in preserved:
        identity = (r['dataset'],r['original_table'],r['original_key'])
        if r['dataset'] in batches and (identity in current_preserved or identity not in all_preserved) and identity not in expected_preserved: fail('preserved', [r['dataset'],r['original_table'],r['original_key'],'extra'])
    for r in stored['source_schemas']:
        if r['dataset'] in batches and r['original_table'] not in snapshots[r['dataset']]['tables'] and any(x[0] == r['dataset'] and x[1] == r['original_table'] for x in current_preserved): fail('schemas', [r['dataset'],r['original_table'],'extra'])
    for r in provenance:
        if (r['dataset'],r['original_table'],r['original_key']) in (current_preserved | expected_preserved) and (r['dataset'],r['original_table'],r['original_key'],r['metric']) not in expected_provenance: fail('provenance', [r['dataset'],r['original_table'],r['original_key'],r['metric'],'extra'])
    for r in stored['raw_payloads']:
        if r['dataset'] in batches and r['batch'] == batches[r['dataset']] and (r['dataset'],r['raw_identity']) not in expected_raw: fail('raw', [r['dataset'],'extra'])
    all_health = {str(m['target_id']) for m in mappings if m['target_kind'].startswith('health:')}
    for r in tables['health']:
        if r['dataset'] in batches and (r['import_batch'] == batches[r['dataset']] or (r['dataset'],r['original_table'],r['original_key']) in expected_preserved or str(r['id']) not in all_health) and str(r['id']) not in expected_health: fail('health', [r['dataset'],'extra'])
    all_legacy = {str(m['target_id']) for m in mappings if m['target_kind'] == 'legacy'}
    for group in ('legacy_notifications','legacy_deliveries'):
        for r in tables[group]:
            if r['dataset'] in batches and (r['import_batch'] == batches[r['dataset']] or (r['dataset'],r['original_table'],r['original_key']) in expected_preserved or str(r['id']) not in all_legacy) and str(r['id']) not in expected_legacy: fail('legacy', [r['dataset'],'extra'])
    for identity, (acct, ordered) in accounts.items():
        found = lookup(stored['authority_provenance'], account_identity=identity)
        if len(found) != 1 or found[0]['datasets'] != ordered: fail('authority', [identity, 'provenance']); continue
        rules = lookup(tables['authority'], id=found[0]['rule_id'])
        if len(rules) != 1 or rules[0]['datasets'] != ordered or rules[0]['revision'] != 1 or any(rules[0].get(k) is not None for k in ('metric','activity_id','date_from','date_to')) or not matches_project(rules[0], 'account', acct): fail('authority', [identity, 'rule'])
    resolution_details = compare_resolution(resolution_groups, accounts, stored, tables, fail) or []
    source_conflicts = analyze(capture['datasets'])
    counts['source_conflict_keys'] = sum(v['conflicts'] or 0 for v in source_conflicts['tables'].values())
    counts['raw_conflict_keys'] = sum(v.get('raw_conflicts') or 0 for v in source_conflicts['tables'].values())
    counts['raw_metadata_conflict_keys'] = sum(v.get('metadata_conflicts') or 0 for v in source_conflicts['tables'].values())
    counts['excluded_keys'] = source_conflicts['excluded_keys']
    artifact_scope = compare_artifacts(capture, stored, tables, files, entries, datasets, batches, snapshots, mappings, expected_map, counts, fail)
    current_identities = expected_preserved | artifact_scope['identities']
    current_target_ids = expected_health | expected_legacy | artifact_scope['related_target_ids'] | {str(m['target_id']) for m in mappings if (m['dataset'],m['original_table'],m['original_key']) in expected_preserved and m['target_kind'] == 'preserved'}
    for m in mappings:
        identity = (m['dataset'],m['original_table'],m['original_key'],m['target_kind'])
        related = (m['dataset'],m['original_table'],m['original_key']) in current_identities or str(m['target_id']) in current_target_ids
        if m['original_table'] == 'artifact_relation':
            try:
                parts = json.loads(m['original_key'])
                related |= isinstance(parts,list) and len(parts) == 3 and any((m['dataset'],'artifact',part) in current_identities for part in parts[:2])
            except (TypeError, ValueError): pass
        if m['dataset'] in batches and (m['batch'] == batches[m['dataset']] or related) and identity not in expected_map: fail('mappings', [*identity,'extra'])
    for entry in entries:
        dataset = datasets[entry['dataset']]; path = capture['datasets'][ROLES[entry['source']]]
        checkpoint = lookup(stored['import_checkpoints'], dataset=dataset, batch=batches[dataset])
        if path.with_name(path.name + '-wal').exists() or not checkpoint or digest_file(path) != checkpoint[0]['source_hash']: fail('source_unchanged', [dataset, 'final_hash'])
    relevant = [r for r in stored['import_conflicts'] if r['dataset'] in batches and r['batch'] == batches[r['dataset']]]
    counts['conflict_entries'] = len(relevant)
    for conflict in relevant: fail('conflicts', [conflict['dataset'], conflict['original_table'], conflict['original_key'], conflict['reason']])
    import_work = {str(w['id']) for w in tables['work'] if w['kind'] == 'garmin.import'}
    outbound = [q for q in tables['channel_requests'] if str(q.get('source_work_item_id')) in import_work]
    ids = {str(q['id']) for q in outbound}; results = [r for r in tables['channel_results'] if str(r['request_id']) in ids]
    counts['outbound_requests'] = len(outbound); counts['outbound_results'] = len(results)
    if outbound or results: fail('no_outbound', ['import_channel_activity'])
    resolution = [item['expected'] for item in resolution_details]
    counts['unselected'] = sum(len(row['unselected']) for row in resolution)
    counts['unselected_ambiguous'] = sum(len(row['unselected']) for row in resolution if row['reason'] is not None)
    for reason in ('account_unconfirmed','timezone_unconfirmed','dataset_ambiguous','dataset_unselected','revision_ambiguous','version_unsupported','value_ambiguous'):
        counts['unselected_' + reason] = sum(len(row['unselected']) for row in resolution if row['reason'] == reason)
    counts['mismatches'] = sum(map(len, differences.values()))
    return {'counts': counts, 'differences': differences, 'tables': table_details, 'health':health_details, 'resolution':resolution_details, 'source_conflicts':source_conflicts['tables'], 'history': {'rerun': '미입증', 'resume': '미입증', 'outbound': '현재 저장된 반입 작업의 발신 요청·결과만 관찰', 'unassigned_file_checkpoint': 'v1 미할당 파일은 과거 파일 해시가 없어 미입증'}}


def compare_artifacts(capture, stored, tables, files, entries, datasets, batches, snapshots, mappings, expected_map, counts, fail):
    def one(rows, **criteria):
        matches = [r for r in rows if all(str(r.get(k)) == str(v) for k,v in criteria.items())]
        return matches[0] if len(matches) == 1 else None
    requests = tables['requests']; analyses = tables['analyses']; relations = tables['analysis_artifacts']
    expected_requests = set(); expected_analyses = set(); expected_relations = set(); expected_inventory = set(); expected_inputs = set(); expected_links = set()
    published = {}; unlinked_keys = set(); current_identities = set()
    def mapped(dataset, table, k, kind, fingerprint):
        expected_map.add((dataset,table,k,kind))
        row = one(mappings, dataset=dataset, original_table=table, original_key=k, target_kind=kind)
        if row is None or row['content_hash'] != fingerprint: fail('mappings', [dataset,table,k,kind]); return None
        return row
    def emit(dataset, table, k, category, data, metadata, evaluation=None):
        hashed = hashlib.sha256(data).hexdigest()
        fingerprint = hashlib.sha256(canonical({'hash':hashed,'category':category,'metadata':metadata,'evaluation':evaluation and {x:encoded(v) for x,v in evaluation.items()}}).encode()).hexdigest()
        mapping = mapped(dataset, table, k, 'artifact_file', fingerprint)
        if mapping is None: return None, None
        request_id = str(mapping['target_id']); expected_requests.add(request_id)
        request = one(requests, id=request_id)
        media = 'image/png' if category == 'image' else 'application/json' if metadata.get('source','').lower().endswith('.json') else 'text/plain' if category == 'log' else 'text/markdown'
        expected = {'dataset':dataset, 'original_table':table, 'original_key':k}
        if request is None or request['request_key'] != canonical([dataset,table,k]) or request['source'] != 'garmin' or request['dataset'] != dataset or request['import_batch'] != mapping['batch'] or request['sha256'] != hashed or int(request['size_bytes']) != len(data) or request['media_type'] != media: fail('files', [dataset,table,k,'request'])
        observed = files.get(request_id)
        if observed is None or observed.get('status') != 'available' or observed.get('metadata_matches') is not True or observed.get('sha256') != hashed or observed.get('size_bytes') != len(data): fail('files', [dataset,table,k,'content'])
        analysis_id = None
        if category in ('report','facts') or evaluation is not None:
            mapping = mapped(dataset, table, k, 'artifact_analysis', fingerprint)
            primary = mapped(dataset, table, k, 'artifact_primary', fingerprint)
            if mapping:
                analysis_id = str(mapping['target_id']); expected_analyses.add(analysis_id)
                row = one(analyses,id=analysis_id); values = evaluation or {x:metadata.get(x) for x in ('report_date','scope','model','created_at')}
                created = datetime.fromtimestamp(values['created_at']/1000,timezone.utc) if evaluation is not None and values.get('created_at') is not None else datetime.fromisoformat(values['created_at'].replace('Z','+00:00')) if values.get('created_at') else None
                bad = row is None
                if row:
                    bad = any(str(row.get(x)) != str(y) for x,y in expected.items()) or row['source'] != 'garmin' or row['import_batch'] != mapping['batch'] or str(row['file_request_id']) != request_id or row['revision'] != 1 or row['model_missing'] != (values.get('model') is None) or row['created_at_missing'] != (created is None) or not time_equal(row['created_at'], created) or any(not matches_project(row, field, values.get(field), True) for field in ('report_date','scope','summary','judgments','evidence','next_checks','report_md','model'))
                if bad: fail('analyses', [dataset,table,k])
                if primary:
                    rid = str(primary['target_id']); expected_relations.add(rid); rel = one(relations,id=rid)
                    if rel is None or rel['source'] != 'garmin' or rel['dataset'] != dataset or rel['import_batch'] != primary['batch'] or str(rel['analysis_id']) != analysis_id or str(rel['file_request_id']) != request_id or rel['role'] != 'primary': fail('relations', [dataset,table,k,'primary'])
        return request_id, analysis_id
    if capture['private']['version'] == 1:
        for artifact in capture['private']['files']:
            read_relative(capture['private']['root'], artifact['snapshot'], artifact['bytes'])
            counts['unassigned_files'] += 1
    if capture['private']['version'] == 2:
        for artifact in capture['private']['files']:
            dataset = datasets[artifact['dataset']]; k = encode_identity(artifact['artifact_key']); identity = (dataset,'artifact',k); expected_inventory.add(identity); current_identities.add(identity)
            data, hashed = read_relative(capture['private']['root'],artifact['snapshot'],artifact['bytes']); category = classify(artifact); reason = None
            if data is None: reason = 'too_large'
            elif category == 'config': reason = 'config'
            elif category == 'unknown': reason = 'unknown'
            elif category == 'log':
                try: scanned = scan_log(data); reason = 'secret' if scanned['hasSecrets'] else None
                except ValueError: reason = 'scan_failed'
            metadata = dict(artifact)
            if category == 'log' and data is not None and reason != 'scan_failed': metadata['scanner_version'] = scanned['version']
            unlinked = 'no_analysis_reference' if reason is None and category in ('image','input') and not artifact.get('relations',[]) else None
            request_id, analysis_id = emit(dataset,'artifact',k,category,data,metadata) if reason is None else (None,None)
            published[(artifact['dataset'],artifact['artifact_key'])] = (request_id, analysis_id)
            row = one(stored['artifact_inventory'],dataset=dataset,original_table='artifact',artifact_key=k)
            if row is not None and row['content_hash'] != hashed: fail('source_unchanged', [dataset,'artifact',k,'checkpoint_hash'])
            if row is None or not json_equal([row['category'],row['content_hash'],row['size_bytes'],row['exclusion_reason'],row['unlinked_reason'],decode_metadata(row['metadata'],row['metadata_raw'])], [category,hashed,artifact['bytes'],reason,unlinked,metadata]) or (str(row['request_id']) if row['request_id'] else None) != request_id or (str(row['analysis_id']) if row['analysis_id'] else None) != analysis_id: fail('inventory', list(identity))
            counts['artifacts'] += 1; counts['excluded'] += int(reason is not None)
            if unlinked is not None: unlinked_keys.add((dataset,k))
            if reason in ('config','secret','scan_failed','too_large','unknown'): counts['excluded_' + reason] += 1
        for artifact in capture['private']['files']:
            dataset = datasets[artifact['dataset']]; k = encode_identity(artifact['artifact_key']); request_id,_ = published[(artifact['dataset'],artifact['artifact_key'])]
            for relation in artifact.get('relations',[]):
                akey = encode_identity(relation['analysis_key']); _, analysis_id = published[(artifact['dataset'],relation['analysis_key'])]; role = relation['role']
                expected_links.add((dataset,k,akey,role))
                reason = 'source_excluded' if request_id is None else 'analysis_unavailable' if analysis_id is None else None
                row = one(stored['artifact_relations'],dataset=dataset,artifact_key=k,analysis_key=akey,role=role)
                if row is None or (str(row['request_id']) if row['request_id'] else None) != request_id or (str(row['analysis_id']) if row['analysis_id'] else None) != analysis_id or row['reason'] != reason: fail('relations', [dataset,k,akey,role])
                if reason:
                    if request_id is not None: unlinked_keys.add((dataset,k))
                    continue
                relkey = canonical([k,akey,role]); fingerprint = hashlib.sha256(relkey.encode()).hexdigest(); mapping = mapped(dataset,'artifact_relation',relkey,'relation',fingerprint)
                if mapping:
                    ident = str(mapping['target_id']); expected_relations.add(ident); actual = one(relations,id=ident)
                    if actual is None or actual['source'] != 'garmin' or actual['dataset'] != dataset or actual['import_batch'] != mapping['batch'] or str(actual['analysis_id']) != analysis_id or str(actual['file_request_id']) != request_id or actual['role'] != role: fail('relations', [dataset,k,akey,role,'core'])
    for entry in entries:
        original = entry['dataset']; dataset = datasets[original]; table = snapshots[dataset]['tables'].get('evaluation')
        if table:
            for row in table['rows']:
                k = key(row,table['keys']); data = original_bytes(row['report_md']); current_identities.add((dataset,'evaluation',k))
                if len(data) > MAX_BYTES:
                    invkey = 'evaluation:' + k; expected_inventory.add((dataset,'evaluation',invkey)); record = one(stored['artifact_inventory'],dataset=dataset,original_table='evaluation',artifact_key=invkey)
                    if record is None or not json_equal([record['category'],record['content_hash'],record['size_bytes'],record['request_id'],record['analysis_id'],record['exclusion_reason'],record['metadata']], ['report',hashlib.sha256(data).hexdigest(),len(data),None,None,'too_large',{'original_table':'evaluation','original_key':k}]): fail('inventory',[dataset,'evaluation',k])
                    counts['artifacts'] += 1; counts['excluded'] += 1; counts['excluded_too_large'] += 1
                else: emit(dataset,'evaluation',k,'report',data,{'source':'evaluation.md'},row)
        for category in ('body','profile','inbox'):
            expected_inputs.add((dataset,category)); item = next((x for x in capture['private']['inventory'] if x['dataset']==original and x['category']==category),None)
            state = item['state'] if item else 'unknown'
            metadata = {'fields':item['metadata'],'source_files':[{'artifact_key':k,'request_id':published[(original,k)][0]} for k in item['source_files']]} if item else None
            actual = one(stored['input_inventory'],dataset=dataset,category=category)
            if actual is None or actual['state'] != state or not json_equal(decode_metadata(actual['metadata'],actual['metadata_raw']), metadata): fail('inventory',[dataset,category])
    # 논리 identity와 연결된 ID는 기존 batch를 그대로 유지할 수 있다.
    related_requests = set(expected_requests)
    related_analyses = set(expected_analyses)
    for mapping in mappings:
        identity = (mapping['dataset'],mapping['original_table'],mapping['original_key'])
        if identity in current_identities:
            if mapping['target_kind'] == 'artifact_file': related_requests.add(str(mapping['target_id']))
            if mapping['target_kind'] == 'artifact_analysis': related_analyses.add(str(mapping['target_id']))
    def request_identity(row):
        try:
            value = json.loads(row['request_key'])
            if isinstance(value,list) and len(value) >= 3 and all(isinstance(v,str) for v in value[:3]): return tuple(value[:3])
        except (TypeError, ValueError): pass
        return None
    for row in requests:
        if request_identity(row) in current_identities: related_requests.add(str(row['id']))
    for row in analyses:
        if (row['dataset'],row['original_table'],row['original_key']) in current_identities: related_analyses.add(str(row['id']))
    related_relations = set(expected_relations)
    while True:
        previous = (len(related_requests), len(related_analyses), len(related_relations))
        for row in analyses:
            if row['dataset'] in batches and str(row['id']) in related_analyses:
                related_requests.add(str(row['file_request_id']))
        for row in relations:
            if row['dataset'] in batches and (str(row['id']) in related_relations or str(row['analysis_id']) in related_analyses or str(row['file_request_id']) in related_requests):
                related_relations.add(str(row['id'])); related_analyses.add(str(row['analysis_id'])); related_requests.add(str(row['file_request_id']))
        if previous == (len(related_requests), len(related_analyses), len(related_relations)): break
    for row in requests:
        if row['dataset'] in batches and (row['import_batch'] == batches[row['dataset']] or str(row['id']) in related_requests) and str(row['id']) not in expected_requests: fail('files',[row['dataset'],str(row['id']),'extra'])
    for row in analyses:
        if row['dataset'] in batches and (row['import_batch'] == batches[row['dataset']] or str(row['id']) in related_analyses or str(row['file_request_id']) in related_requests) and str(row['id']) not in expected_analyses: fail('analyses',[row['dataset'],str(row['id']),'extra'])
    for row in relations:
        if row['dataset'] in batches and (row['import_batch'] == batches[row['dataset']] or str(row['analysis_id']) in related_analyses or str(row['file_request_id']) in related_requests) and str(row['id']) not in expected_relations: fail('relations',[row['dataset'],str(row['id']),'extra'])
    for row in stored['artifact_inventory']:
        identity = (row['dataset'],row['original_table'],row['artifact_key'])
        related = identity in current_identities
        if row['original_table'] == 'evaluation' and row['artifact_key'].startswith('evaluation:'):
            related |= (row['dataset'],'evaluation',row['artifact_key'][len('evaluation:'):]) in current_identities
        related |= row['request_id'] is not None and str(row['request_id']) in related_requests
        related |= row['analysis_id'] is not None and str(row['analysis_id']) in related_analyses
        if row['dataset'] in batches and (row['batch'] == batches[row['dataset']] or related) and identity not in expected_inventory:
            fail('inventory',[row['dataset'],row['original_table'],row['artifact_key'],'extra'])
    for row in stored['input_inventory']:
        if row['dataset'] in batches and (row['dataset'],row['category']) not in expected_inputs: fail('inventory',[row['dataset'],row['category'],'extra'])
    for row in stored['artifact_relations']:
        if row['dataset'] in batches and ((row['dataset'],'artifact',row['artifact_key']) in current_identities or (row['dataset'],'artifact',row['analysis_key']) in current_identities) and (row['dataset'],row['artifact_key'],row['analysis_key'],row['role']) not in expected_links: fail('relations',[row['dataset'],row['artifact_key'],'extra'])
    counts['analysis_rows'] = len(expected_analyses); counts['file_requests'] = len(expected_requests); counts['unlinked'] = len(unlinked_keys)
    return {'identities': current_identities, 'related_target_ids': related_requests | related_analyses | related_relations}
