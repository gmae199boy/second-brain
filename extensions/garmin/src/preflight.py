"""원본 보존 정보와 충돌을 계산한다. 이 모듈은 DB에 쓰지 않는다."""
import json
import base64
from itertools import combinations
from reader import read_snapshot
from contract import COLUMNS, TABLES, BY_VERSION

ORDER = ('D2', 'D1', 'D4', 'D5', 'D3')
LOCAL_ID = {'run', 'auth_event', 'fetch_error', 'delivery'}


def account(snapshot):
    ids = set()
    def visit(value):
        if isinstance(value, dict):
            for key, child in value.items():
                if key == 'userProfileId' and isinstance(child, (str, int)) and not isinstance(child, bool) and str(child):
                    ids.add(str(child))
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)
    for row in snapshot['tables'].get('raw_response', {}).get('rows', []):
        try:
            visit(json.loads(row.get('raw')))
        except (TypeError, ValueError):
            pass
    return {'confirmed': len(ids) == 1, 'account': next(iter(ids)) if len(ids) == 1 else None, 'distinct': len(ids)}


def _index(table):
    from reader import SQLiteText, InvalidSQLiteText
    keys = table['keys']
    if not keys:
        return None
    result = {}
    for row in table['rows']:
        key = tuple(('text', row[k].encoding, row[k].raw) if isinstance(row[k], (SQLiteText, InvalidSQLiteText)) else (type(row[k]).__name__, row[k]) for k in keys)
        if key in result:
            return None
        result[key] = row
    return result


def _different(left, right, columns):
    from reader import SQLiteText, InvalidSQLiteText
    def original(value):
        return ('text', value.encoding, value.raw) if isinstance(value, (SQLiteText, InvalidSQLiteText)) else (type(value), value)
    return any(original(left[column]) != original(right[column]) for column in columns)


def _private_value(value):
    from reader import InvalidSQLiteText
    if isinstance(value, InvalidSQLiteText):
        return {'text_base64': base64.b64encode(value.raw).decode('ascii'), 'encoding': value.encoding}
    if isinstance(value, bytes):
        return {'blob_base64': base64.b64encode(value).decode('ascii')}
    if isinstance(value, dict):
        return {key: _private_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_private_value(item) for item in value]
    return value


def _ranges(name, table):
    # [ASSUMPTION] 알려진 날짜·시각 열만 범위로 요약하고 나머지 열은 원문으로 보존한다.
    candidates = {'raw_response': 'key', 'normalize_result': 'key', 'daily_metric': 'day_key',
                  'body_battery_sample': 'ts_ms', 'hr_sample': 'ts_ms', 'activity_hr_sample': 'ts_ms',
                  'stress_bb_sample': 'ts_ms', 'activity': 'day_key', 'auth_event': 'local_date',
                  'notification': 'local_date', 'delivery': 'local_date', 'activity_recovery': 'end_ms'}
    column = candidates.get(name)
    if not column or column not in table['columns']:
        return None
    values = [row[column] for row in table['rows'] if row[column] is not None and (name not in ('raw_response', 'normalize_result') or row.get('scope') == 'day')]
    if not values:
        return {'column': column, 'min': None, 'max': None}
    try:
        return {'column': column, 'min': min(values), 'max': max(values)}
    except TypeError:
        return {'column': column, 'min': None, 'max': None, 'unsupported': True}


def analyze(datasets):
    if set(datasets) != set(ORDER):
        raise ValueError('PREFLIGHT_INVALID')
    snapshots = {role: read_snapshot(datasets[role]) for role in ORDER}
    result = {'datasets': {}, 'tables': {}, 'authority_order': list(ORDER), 'unselected_keys': 0, 'excluded_keys': 0, 'authority_version': 1, 'authority_scope': '표별 원래 키; 정수 이력은 dataset별'}
    for role, snapshot in snapshots.items():
        result['datasets'][role] = {'schema': snapshot['schema'], 'account': account(snapshot), 'tables': {name: {'count': len(table['rows']), 'columns': table['columns'], 'column_metadata': table['column_metadata'], 'keys': table['keys'], 'rows': _private_value(table['rows']), 'range': _ranges(name, table)} for name, table in snapshot['tables'].items()}}
    all_names = sorted(set().union(*(s['tables'] for s in snapshots.values())))
    for name in all_names:
        tables = {role: snapshots[role]['tables'].get(name) for role in ORDER}
        indexed = {role: _index(table) if table else None for role, table in tables.items()}
        present = [role for role in ORDER if tables[role] is not None]
        usable = all(indexed[role] is not None for role in present)
        keysets = {tuple(tables[role]['keys']) for role in present}
        entry = {'pairs': {}, 'union': None, 'conflicts': None, 'raw_conflicts': None, 'only': {}, 'excluded': None}
        if not usable or len(keysets) != 1:
            entry['excluded'] = '원래 키가 없거나 호환되지 않음'
            entry['unresolved_rows'] = sum(len(tables[role]['rows']) for role in present)
            result['excluded_keys'] += entry['unresolved_rows']
            result['tables'][name] = entry
            continue
        for left, right in combinations(ORDER, 2):
            a, b = indexed[left], indexed[right]
            if a is None or b is None:
                entry['pairs'][left + ':' + right] = None
                continue
            common = sorted((set(tables[left]['columns']) & set(tables[right]['columns'])) - set(tables[left]['keys']))
            overlap = a.keys() & b.keys()
            metadata = [column for column in common if column != 'raw']
            entry['pairs'][left + ':' + right] = {'metadata_conflicts': sum(_different(a[k], b[k], metadata) for k in overlap) if name == 'raw_response' else None, 'overlap': len(overlap), 'conflicts': sum(_different(a[k], b[k], common) for k in overlap), 'left_only': len(a.keys() - b.keys()), 'right_only': len(b.keys() - a.keys()), 'raw_conflicts': sum(a[k].get('raw') != b[k].get('raw') for k in overlap) if name == 'raw_response' and 'raw' in common else None}
        union = set().union(*(indexed[role].keys() for role in present))
        common = sorted(set.intersection(*(set(tables[role]['columns']) for role in present)) - set(tables[present[0]]['keys']))
        conflicts = raw_conflicts = metadata_conflicts = 0
        for key in union:
            rows = [indexed[role][key] for role in present if key in indexed[role]]
            conflicts += any(_different(rows[0], row, common) for row in rows[1:])
            if name == 'raw_response' and 'raw' in common:
                raw_conflicts += any(rows[0]['raw'] != row['raw'] for row in rows[1:])
                metadata_conflicts += any(_different(rows[0], row, [c for c in common if c != 'raw']) for row in rows[1:])
        def encode_key(key):
            return [{'type': 'text', 'encoding': part[1], 'base64': base64.b64encode(part[2]).decode('ascii')} if part[0] == 'text' else {'blob_base64': base64.b64encode(part[1]).decode('ascii')} if isinstance(part[1], bytes) else part[1] for part in key]
        selections = []
        for key in sorted(union, key=repr):
            candidates = [role for role in ORDER if indexed[role] is not None and key in indexed[role]]
            if name in LOCAL_ID:
                selections.extend({'key': encode_key(key), 'selected': role, 'alternatives': []} for role in candidates)
            else:
                selections.append({'key': encode_key(key), 'selected': candidates[0], 'alternatives': candidates[1:]})
        entry['authority_v1'] = selections
        result['unselected_keys'] += sum(selection['selected'] is None for selection in selections)
        entry.update(union=len(union), conflicts=conflicts, raw_conflicts=raw_conflicts if name == 'raw_response' else None, metadata_conflicts=metadata_conflicts if name == 'raw_response' else None,
                     only={role: None if indexed[role] is None else len(indexed[role].keys() - set().union(*(indexed[other].keys() for other in present if other != role))) for role in ORDER},
                     dataset_local=name in LOCAL_ID)
        result['tables'][name] = entry
    unsupported = []
    for role, snapshot in snapshots.items():
        expected = BY_VERSION[snapshot['schema']]
        for missing in sorted(set(expected) - set(snapshot['tables'])):
            unsupported.append({'dataset': role, 'table': missing, 'reason': '필수 표가 없음'})
        for name, table in snapshot['tables'].items():
            if name not in COLUMNS:
                unsupported.append({'dataset': role, 'table': name, 'reason': '지원 표가 아님'})
            else:
                extra = sorted(set(table['columns']) - set(COLUMNS[name]))
                if extra:
                    unsupported.append({'dataset': role, 'table': name, 'columns': extra, 'reason': '지원 열이 아님'})
                missing = sorted(set(expected.get(name, [])) - set(table['columns']))
                if missing:
                    unsupported.append({'dataset': role, 'table': name, 'columns': missing, 'reason': '필수 열이 없음'})
            result['datasets'][role]['tables'][name]['null_counts'] = {column: sum(row[column] is None for row in table['rows']) for column in table['columns']}
    result['unsupported'] = unsupported
    return result


def readiness(metadata, role, current, batches):
    """core가 전달한 ledger와 확장 자격으로 읽은 사실만 판정한다."""
    migrations = metadata.get('migrations')
    checks = {
        'core_ready': isinstance(metadata.get('core'), int) and metadata.get('core') == metadata.get('expected_core'),
        'extension_ready': isinstance(migrations, list) and bool(migrations) and metadata.get('extension') == max(migrations) and metadata.get('applied_migrations') == migrations,
        'abi_ready': metadata.get('version') == 1 and metadata.get('abi') == 1 and bool(metadata.get('manifest_version')),
        'role_ready': role == 'brain_ext_garmin',
        'attempt_current': current is True,
    }
    return {'checks': checks, 'previous_batches': batches, 'resume': '미제공', 'ready': all(checks.values())}


def public_report(report, ready):
    tables = report['tables']
    counts = {'datasets': len(report['datasets']), 'tables': len(tables),
              'rows': sum(info['count'] for ds in report['datasets'].values() for info in ds['tables'].values()),
              'conflict_keys': sum(item['conflicts'] or 0 for item in tables.values()),
              'raw_conflict_keys': tables.get('raw_response', {}).get('raw_conflicts') or 0,
              'raw_metadata_conflict_keys': tables.get('raw_response', {}).get('metadata_conflicts') or 0,
              'unselected_keys': report['unselected_keys'], 'excluded_keys': report['excluded_keys'],
              'unconfirmed_accounts': sum(not ds['account']['confirmed'] for ds in report['datasets'].values()),
              'previous_batches': len(ready['previous_batches']),
              'expected_file_requests': report.get('estimates', {}).get('file_request_candidates', 0),
              'expected_preservation_candidates': report.get('estimates', {}).get('preservation_candidates', 0),
              'expected_dataset_candidates': report.get('estimates', {}).get('dataset_candidates', 0),
              'expected_mapping_candidates': report.get('estimates', {}).get('mapping_candidates', 0),
              'exclusion_reasons': len(report.get('exclusions', [])) + len(report['unsupported'])}
    for name in TABLES:
        item = tables.get(name, {})
        counts[name + '_rows'] = sum(ds['tables'].get(name, {}).get('count', 0) for ds in report['datasets'].values())
        counts[name + '_overlap'] = sum(pair['overlap'] for pair in item.get('pairs', {}).values() if pair)
        counts[name + '_only'] = sum(n or 0 for n in item.get('only', {}).values())
        counts[name + '_conflicts'] = item.get('conflicts') or 0
    checks = {**ready['checks'], 'source_unchanged': report.get('source_unchanged', True), 'total_insert_known': report.get('estimates', {}).get('total_insert_known', False)}
    return {'counts': counts, 'checks': checks}


def classify_files(files):
    """전달 가능한 문서와 제외 대상을 원래 분류 문자열로 구분한다."""
    groups = {'report': 0, 'facts': 0, 'image': 0, 'input': 0, 'config': 0, 'log': 0, 'unknown': 0}
    classified = []
    for entry in files:
        source = entry['source'].lower()
        if source.endswith(('.toml', '.env', '.ini', '.yaml', '.yml')) or 'config' in source:
            group = 'config'
        elif source.endswith('.log'):
            group = 'log'
        elif source.endswith('.png'):
            group = 'image'
        elif 'facts' in source and source.endswith(('.json', '.md')):
            group = 'facts'
        elif 'report-input' in source and source.endswith('.json'):
            group = 'input'
        elif 'report' in source and source.endswith(('.md', '.json')):
            group = 'report'
        else:
            group = 'unknown'
        groups[group] += 1
        classified.append({'source': entry['source'], 'snapshot': entry['snapshot'], 'category': group,
                           'reason': '비밀·기계 설정' if group == 'config' else '운영 로그' if group == 'log' else '분류 확인 필요' if group == 'unknown' else None})
    return {'groups': groups, 'files': classified, 'expected_requests': sum(groups[k] for k in ('report', 'facts', 'image', 'input'))}


def unit_risks(report, catalog):
    mappings = {}
    for definition in catalog:
        for mapping in definition.get('mappings', []):
            mappings.setdefault((mapping.get('table'), mapping.get('column')), []).append({'metric': definition.get('metric'), 'unit': definition.get('unit'), 'factor': mapping.get('factor')})
    risks = []
    for role, dataset in report['datasets'].items():
        for name, table in dataset['tables'].items():
            for column in table['columns']:
                if (name, column) in mappings:
                    risks.append({'dataset': role, 'table': name, 'column': column, 'nulls': table['null_counts'][column], 'catalog': mappings[(name, column)], 'reason': '변환과 NULL 의미 검증 필요'})
    return risks


def estimate_candidates(report, files, existing_mappings):
    """입력으로 확인되는 후보를 세며 실제 반입 INSERT 총계를 예측하지 않는다."""
    preservation = sum(table['count'] for dataset in report['datasets'].values() for table in dataset['tables'].values())
    mapping = sum(table['count'] for dataset in report['datasets'].values() for name, table in dataset['tables'].items()
                  if name in COLUMNS and report['tables'][name]['excluded'] is None)
    return {'preservation_candidates': preservation, 'dataset_candidates': len(report['datasets']),
            'mapping_candidates': mapping, 'file_request_candidates': files['expected_requests'],
            'existing_mapping_count': existing_mappings,
            'total_insert_known': False,
            'scope': '보존 행·dataset·키가 지원되는 표의 mapping·분류된 파일 요청 후보만 계산한다. 기존 mapping과 후속 건강·분석 변환을 대조하기 전 실제 INSERT 총계는 미제공이다.'}
