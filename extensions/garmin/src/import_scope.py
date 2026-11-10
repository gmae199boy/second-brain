"""Fixed full-five capture / confirmed-four import contract; no inferred selection."""
import hashlib
import sqlite3
from contextlib import closing
from pathlib import Path

from metadata_codec import safe_dumps
from verify_source import read_source, recheck_source

SELECTED_ROLES = frozenset(('D1', 'D2', 'D4', 'D5'))
REASON = 'unconfirmed-account'


def validate_selection(value):
    from capture_manifest import ROLES
    selection = value.get('selection')
    if not isinstance(selection, dict) or set(selection) != {'version', 'include', 'exclude'} or type(selection['version']) is not int or selection['version'] != 1:
        raise ValueError('PREFLIGHT_INVALID')
    include, exclude = selection['include'], selection['exclude']
    expected = {e['dataset'] for e in value['datasets'] if ROLES[e['source']] in SELECTED_ROLES}
    excluded = next(e['dataset'] for e in value['datasets'] if ROLES[e['source']] == 'D3')
    if not isinstance(include, list) or any(not isinstance(x, str) for x in include) or len(include) != 4 or set(include) != expected:
        raise ValueError('PREFLIGHT_INVALID')
    if exclude != [{'dataset': excluded, 'reason': REASON}]:
        raise ValueError('PREFLIGHT_INVALID')


def _digest(value):
    return hashlib.sha256(safe_dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()


def capture_receipt(value, root):
    """Bind every captured byte and the fixed disposition to all selected checkpoints."""
    normalized = dict(value)
    for field, key in (('datasets', 'dataset'), ('files', 'snapshot')):
        normalized[field] = sorted(value[field], key=lambda x: x[key])
    normalized['inventory'] = sorted(value['inventory'], key=lambda x: (x['dataset'], x['category']))
    normalized['selection'] = {**value['selection'], 'include': sorted(value['selection']['include'])}
    hashes, counts, tokens = {}, {}, {}
    for entry in value['datasets'] + value['files']:
        path = Path(root) / entry['snapshot']
        database = entry in value['datasets']
        data, hashed, token = read_source(path, reject_wal=database)
        hashes[entry['snapshot']] = hashed
        tokens[entry['snapshot']] = token
        if database:
            with closing(sqlite3.connect(':memory:')) as conn:
                standalone = data[:18] + b'\x01\x01' + data[20:] if data[:16] == b'SQLite format 3\x00' and data[18:20] == b'\x02\x02' else data
                conn.deserialize(standalone)
                conn.execute('pragma query_only=on')
                if conn.execute('pragma quick_check').fetchall() != [('ok',)]:
                    raise ValueError('PREFLIGHT_INVALID')
                names = [r[0] for r in conn.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%'")]
                counts[entry['dataset']] = {name: conn.execute('select count(*) from "' + name.replace('"', '""') + '"').fetchone()[0] for name in names}
        # Files are rechecked without treating an unrelated '<file>-wal' as a DB sidecar.
        if database: recheck_source(path, (hashed, token))
        elif read_source(path)[1:] != (hashed, token): raise ValueError('PREFLIGHT_INVALID')
    capture_digest = _digest(['garmin-full5-v3', normalized, sorted(hashes.items())])
    selection_digest = _digest(['garmin-fixed4-v1', capture_digest, normalized['selection'], ['D2', 'D1', 'D4', 'D5']])
    return {'fingerprint': selection_digest, 'capture_digest': capture_digest,
            'selection_receipt': {'contract': 'fixed4-selected/sole-D3-excluded',
                'selection': normalized['selection'], 'captured': 5, 'selected': 4, 'excluded': 1,
                'sha256': hashes, 'table_counts': counts, 'capture_digest': capture_digest,
                'selection_digest': selection_digest}, 'source_tokens': tokens}


def selected_capture(capture):
    """Keep the full capture intact; every importer/verifier consumer uses this view."""
    if capture['private']['version'] != 3: return capture
    private = capture['private']
    include = set(private['selection_receipt']['selection']['include'])
    return {'datasets': {role: path for role, path in capture['datasets'].items() if role in SELECTED_ROLES},
            'private': {**private,
                'captured_datasets': private['datasets'],
                'datasets': [dict(e) for e in private['datasets'] if e['dataset'] in include],
                'files': [e for e in private['files'] if e['dataset'] in include],
                'inventory': [e for e in private['inventory'] if e['dataset'] in include]}}


def recheck_capture(manifest, full):
    """Recheck excluded bytes too, including manifest replacement during a run."""
    if full['private']['version'] != 3: return
    from capture_manifest import load_capture
    actual = load_capture(manifest, secure=True)['private']
    before = full['private']
    if any(actual.get(key) != before.get(key) for key in ('fingerprint', 'manifest_token', 'source_tokens')):
        raise ValueError('IMPORT_INVALID')


def batch_id(capture, dataset):
    """v3 role anchors overlap even if input dataset labels are renamed on resume."""
    from raw_codec import dataset_ref
    private = capture['private']
    if private.get('version') == 3:
        roles = [e['source'] for e in private.get('captured_datasets', private['datasets']) if dataset in (e['dataset'], dataset_ref(e['dataset']))]
        if len(roles) != 1: raise ValueError('IMPORT_INVALID')
        return _digest(['garmin-fixed4-batch-v1', private['capture_id'], roles[0]])
    return _digest([private['capture_id'], dataset])
