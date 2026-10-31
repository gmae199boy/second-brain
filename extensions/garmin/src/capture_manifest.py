"""정규화된 capture manifest를 엄격히 읽는다."""
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import stat

# [ASSUMPTION] 기존 비공개 형식은 해석하지 않고 정규화 version1만 허용한다.
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
        if not isinstance(value, dict) or set(value) != {'version', 'capture_id', 'datasets', 'files'} or type(value['version']) is not int or value['version'] != 1 or not isinstance(value['capture_id'], str) or not value['capture_id'].strip() or not isinstance(value['datasets'], list) or not isinstance(value['files'], list):
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
        for entry in value['files']:
            if not isinstance(entry, dict) or set(entry) != {'source', 'snapshot', 'bytes'} or not isinstance(entry['source'], str) or not entry['source'].strip() or type(entry['bytes']) is not int or entry['bytes'] < 0 or entry['snapshot'] in snapshots:
                _invalid()
            target = _safe_file(path.parent, entry['snapshot'])
            if target.stat().st_size != entry['bytes']:
                _invalid()
            snapshots.add(entry['snapshot'])
            files.append(entry)
        fingerprint = hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':')).encode()).hexdigest()
        return {'datasets': datasets, 'private': {'capture_id': value['capture_id'], 'fingerprint': fingerprint, 'datasets': value['datasets'], 'files': files}}
    except (OSError, TypeError, KeyError, UnicodeError, json.JSONDecodeError):
        _invalid()
