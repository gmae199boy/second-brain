"""Validation and pure field-wise merging for body measurement sidecars.

Persistence and file handoff are deliberately separate from these operations.
"""
from datetime import date
import json
import math
from pathlib import PurePosixPath

_LIMITS = {
    'weight_kg': (500, False), 'skeletal_muscle_mass_kg': (300, False),
    'body_fat_mass_kg': (300, False), 'body_fat_percent': (100, False),
    'bmi': (200, False), 'total_body_water_l': (300, False),
    'protein_kg': (100, False), 'minerals_kg': (50, False),
    'basal_metabolic_rate_kcal': (10000, True), 'visceral_fat_level': (100, True),
    'inbody_score': (200, True),
}


def _pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('BODY_INVALID')
        result[key] = value
    return result


def _finite(value):
    value = float(value)
    if not math.isfinite(value):
        raise ValueError('BODY_INVALID')
    return value


def _constant(_):
    raise ValueError('BODY_INVALID')


def parse(data):
    try:
        doc = json.loads(data, object_pairs_hook=_pairs, parse_float=_finite, parse_constant=_constant)
        validate(doc)
        return doc
    except (ValueError, TypeError, UnicodeDecodeError, RecursionError, OverflowError):
        raise ValueError('BODY_INVALID') from None


def validate(doc):
    if not isinstance(doc, dict) or set(doc) != {'schema_version', 'measured_on', 'values', 'value_mtime_ns', 'source_files'} or type(doc['schema_version']) is not int or doc['schema_version'] != 1:
        raise ValueError('BODY_INVALID')
    day = doc['measured_on']
    if not isinstance(day, str) or date.fromisoformat(day).isoformat() != day:
        raise ValueError('BODY_INVALID')
    values, mtimes, sources = doc['values'], doc['value_mtime_ns'], doc['source_files']
    if not isinstance(values, dict) or not values or not isinstance(mtimes, dict) or values.keys() != mtimes.keys() or not isinstance(sources, list) or not sources:
        raise ValueError('BODY_INVALID')
    for key, value in values.items():
        if key not in _LIMITS or type(value) not in (int, float):
            raise ValueError('BODY_INVALID')
        maximum, integer = _LIMITS[key]
        if not 0 <= value <= maximum or (isinstance(value, float) and not math.isfinite(value)) or (integer and value != int(value)) or type(mtimes[key]) is not int or mtimes[key] < 0:
            raise ValueError('BODY_INVALID')
    if any(not isinstance(source, str) or not source or '\\' in source or PurePosixPath(source).is_absolute() or any(p in ('', '.', '..') for p in source.split('/')) for source in sources) or len(set(sources)) != len(sources):
        raise ValueError('BODY_INVALID')
    return doc


def merge(existing, incoming):
    """Merge one date; a later candidate wins a timestamp tie."""
    validate(incoming)
    if existing is None:
        return {**incoming, 'values': {key:int(value) if _LIMITS[key][1] else value for key,value in incoming['values'].items()}, 'value_mtime_ns': dict(incoming['value_mtime_ns']), 'source_files': list(incoming['source_files'])}
    validate(existing)
    if existing['measured_on'] != incoming['measured_on']:
        raise ValueError('BODY_INVALID')
    result = {**existing, 'values': dict(existing['values']), 'value_mtime_ns': dict(existing['value_mtime_ns']), 'source_files': list(existing['source_files'])}
    for key, value in incoming['values'].items():
        stamp = incoming['value_mtime_ns'][key]
        if stamp >= result['value_mtime_ns'].get(key, -1):
            result['values'][key] = int(value) if _LIMITS[key][1] else value
            result['value_mtime_ns'][key] = stamp
    for source in incoming['source_files']:
        if source not in result['source_files']:
            result['source_files'].append(source)
    return result


def read_source(home, relative):
    """Read a stable direct inbox/inbody file without following symbolic links.

    The returned identity must be rechecked before moving the source after core
    confirms the corresponding staged file request.
    """
    import hashlib
    import os
    import stat
    from artifacts import MAX_BYTES

    parts = relative.split('/') if isinstance(relative, str) else []
    if len(parts) != 3 or parts[:2] != ['inbox', 'inbody'] or parts[2] in ('', '.', '..') or parts[2].startswith('.') or '\\' in parts[2] or '\x00' in parts[2]:
        raise ValueError('BODY_INVALID')
    root = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    directory = None
    try:
        inbox = os.open('inbox', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=root)
        try:
            directory = os.open('inbody', os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=inbox)
        finally:
            os.close(inbox)
        if parts[2] not in os.listdir(directory):
            raise FileNotFoundError('BODY_SOURCE_MISSING')
        fd = os.open(parts[2], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        try:
            before = os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_BYTES:
                raise ValueError('BODY_INVALID')
            chunks = []
            while True:
                chunk = os.read(fd, min(1024 * 1024, MAX_BYTES + 1 - sum(map(len, chunks))))
                if not chunk:
                    break
                chunks.append(chunk)
                if sum(map(len, chunks)) > MAX_BYTES:
                    raise ValueError('BODY_INVALID')
            after = os.fstat(fd)
            current = os.stat(parts[2], dir_fd=directory, follow_symlinks=False)
            identity = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns, s.st_ctime_ns)
            data = b''.join(chunks)
            if identity(before) != identity(after) or identity(after) != identity(current) or len(data) != before.st_size:
                raise ValueError('BODY_CHANGED')
            return data, {'sha256': hashlib.sha256(data).hexdigest(), 'mtime_ns': before.st_mtime_ns,
                          'device': before.st_dev, 'inode': before.st_ino, 'size': before.st_size,
                          'ctime_ns': before.st_ctime_ns}
        finally:
            os.close(fd)
    finally:
        if directory is not None:
            os.close(directory)
        os.close(root)


def merge_with_provenance(existing, field_sources, incoming, incoming_sources):
    """Merge sidecars and keep the request identifiers that supplied each value.

    Callers derive incoming timestamps from source files and pass only confirmed
    request IDs; unconfirmed files must not be handed to this function.
    """
    if not isinstance(field_sources, dict) or not isinstance(incoming_sources, dict):
        raise ValueError('BODY_INVALID')
    validate(incoming)
    if existing is not None:
        validate(existing)
        if set(field_sources) != set(existing['values']):
            raise ValueError('BODY_INVALID')
    elif field_sources:
        raise ValueError('BODY_INVALID')
    if set(incoming_sources) != set(incoming['values']):
        raise ValueError('BODY_INVALID')
    for mapping in (field_sources, incoming_sources):
        if any(not isinstance(ids, list) or not ids or any(not isinstance(i, str) or not i for i in ids) or len(ids) != len(set(ids)) for ids in mapping.values()):
            raise ValueError('BODY_INVALID')
    combined = merge(existing, incoming)
    provenance = {key: list(ids) for key, ids in field_sources.items()}
    for key, stamp in incoming['value_mtime_ns'].items():
        if existing is None or stamp >= existing['value_mtime_ns'].get(key, -1):
            provenance[key] = list(incoming_sources[key])
    return combined, provenance
