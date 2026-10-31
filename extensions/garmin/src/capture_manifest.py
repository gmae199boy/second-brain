"""정규화된 capture manifest를 엄격히 읽는다."""
import hashlib
from datetime import datetime
import json
import os
from pathlib import Path, PurePosixPath
import stat
from metadata_codec import safe_dumps

# version1의 모양을 유지하며 version2는 출처와 관계를 명시한다.
ROLES = {'development': 'D1', 'production': 'D2', 'development-before-change': 'D3',
         'production-pre-epic5': 'D4', 'production-before-history-start': 'D5'}


def _invalid():
    raise ValueError('PREFLIGHT_INVALID')


def _safe_file(root, value):
    if not isinstance(value, str) or not value or '\\' in value or '\0' in value:
        _invalid()
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ('', '.', '..') for part in value.split('/')):
        _invalid()
    current = root
    for part in path.parts:
        current = current / part
        info = current.lstat()
        if stat.S_ISLNK(info.st_mode):
            _invalid()
    if not current.is_file():
        _invalid()
    return current


def load_capture(manifest_path):
    try:
        path = Path(manifest_path)
        if not path.is_absolute() or path.is_symlink() or not path.is_file():
            _invalid()
        current = Path('/')
        for part in path.parts[1:]:
            current /= part
            if current.is_symlink():
                _invalid()
        raw = path.read_bytes()
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != ({'version', 'capture_id', 'datasets', 'files'} if value.get('version') == 1 else {'version', 'capture_id', 'datasets', 'files', 'inventory'}) or type(value['version']) is not int or value['version'] not in (1, 2) or not isinstance(value['capture_id'], str) or not value['capture_id'].strip() or not isinstance(value['datasets'], list) or not isinstance(value['files'], list):
            _invalid()
        datasets, names, snapshots = {}, set(), set()
        for entry in value['datasets']:
            if not isinstance(entry, dict) or set(entry) != {'dataset', 'source', 'snapshot'} or not isinstance(entry['dataset'], str) or not entry['dataset'].strip() or entry['dataset'] in names or entry['source'] not in ROLES:
                _invalid()
            role = ROLES[entry['source']]
            if role in datasets or entry['snapshot'] in snapshots:
                _invalid()
            target = _safe_file(path.parent, entry['snapshot'])
            datasets[role] = target
            names.add(entry['dataset'])
            snapshots.add(entry['snapshot'])
        if set(datasets) != set(ROLES.values()):
            _invalid()
        files = []
        artifact_keys = set()
        for entry in value['files']:
            required = {'source', 'snapshot', 'bytes'} if value['version'] == 1 else {'source', 'snapshot', 'bytes', 'dataset', 'artifact_key', 'category'}
            allowed = required | ({'relations', 'report_date', 'scope', 'model', 'created_at'} if value['version'] == 2 else set())
            if not isinstance(entry, dict) or not required <= set(entry) or not set(entry) <= allowed or not isinstance(entry['source'], str) or not entry['source'].strip() or type(entry['bytes']) is not int or entry['bytes'] < 0 or entry['snapshot'] in snapshots:
                _invalid()
            target = _safe_file(path.parent, entry['snapshot'])
            if target.stat().st_size != entry['bytes']:
                _invalid()
            snapshots.add(entry['snapshot'])
            if value['version'] == 2:
                key = entry['artifact_key']
                if entry['dataset'] not in names or not isinstance(key, str) or not key.strip() or '\0' in key or (entry['dataset'], key) in artifact_keys or entry['category'] not in ('report','facts','image','input','log','config','unknown'):
                    _invalid()
                artifact_keys.add((entry['dataset'], key))
                if any(entry.get(k) is not None and not isinstance(entry[k], str) for k in ('report_date','scope','model','created_at')):
                    _invalid()
                if entry.get('created_at') is not None:
                    try:
                        timestamp = datetime.fromisoformat(entry['created_at'].replace('Z','+00:00'))
                        if timestamp.tzinfo is None or timestamp.utcoffset() is None: _invalid()
                    except ValueError: _invalid()
                relations = entry.get('relations', [])
                if not isinstance(relations, list) or any(not isinstance(r, dict) or set(r) != {'analysis_key','role'} or not isinstance(r['analysis_key'], str) or not r['analysis_key'] or r['role'] not in ('image','input','source_file') for r in relations):
                    _invalid()
                if len({(r['analysis_key'],r['role']) for r in relations}) != len(relations): _invalid()
            files.append(entry)
        inventory = value.get('inventory', [])
        if not isinstance(inventory, list): _invalid()
        inventory_keys = set()
        for item in inventory:
            if not isinstance(item, dict) or set(item) != {'dataset','category','state','metadata','source_files'} or item['dataset'] not in names or item['category'] not in ('body','profile','inbox') or item['state'] not in ('unknown','absent','empty','present') or not isinstance(item['metadata'], dict) or not isinstance(item['source_files'], list): _invalid()
            identity = (item['dataset'],item['category'])
            if identity in inventory_keys or any(not isinstance(k,str) or (item['dataset'],k) not in artifact_keys for k in item['source_files']): _invalid()
            inventory_keys.add(identity)
        if value['version'] == 2:
            for entry in files:
                for relation in entry.get('relations', []):
                    if (entry['dataset'],relation['analysis_key']) not in artifact_keys: _invalid()
        fingerprint = hashlib.sha256(safe_dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        return {'datasets': datasets, 'private': {'capture_id': value['capture_id'], 'fingerprint': fingerprint, 'datasets': value['datasets'], 'files': files, 'inventory': inventory, 'version': value['version'], 'root': str(path.parent)}}
    except (OSError, TypeError, KeyError, UnicodeError, json.JSONDecodeError):
        _invalid()
