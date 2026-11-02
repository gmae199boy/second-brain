"""Validate the immutable Garmin settings snapshot shared by workers."""
import json
import math
import re
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


def decode(raw=None, *, require_timezone=False, strict=True):
    if raw is None or raw == '':
        snapshot = {'values': {}}
    else:
        if len(raw.encode('utf-8')) > 16384:
            raise ValueError('COLLECT_INVALID')
        snapshot = json.loads(raw)
    if not isinstance(snapshot, dict) or not isinstance(snapshot.get('values'), dict):
        raise ValueError('COLLECT_INVALID')
    if strict and (set(snapshot) != {'version', 'extension', 'values'}
                   or type(snapshot['version']) is not int or snapshot['version'] != 1
                   or snapshot['extension'] != 'garmin'):
        raise ValueError('COLLECT_INVALID')
    if not strict and (set(snapshot) - {'version', 'extension', 'values'}
                       or ('version' in snapshot and (type(snapshot['version']) is not int or snapshot['version'] != 1))
                       or ('extension' in snapshot and snapshot['extension'] != 'garmin')):
        raise ValueError('COLLECT_INVALID')
    manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
    declarations = {entry['key']: entry for entry in manifest['settings']}
    values = {}
    for key, entry in declarations.items():
        if 'default' not in entry:
            continue
        default = entry['default']
        if not isinstance(default, str):
            raise ValueError('COLLECT_INVALID')
        if entry['type'] == 'number':
            if not re.fullmatch(r'-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?', default):
                raise ValueError('COLLECT_INVALID')
            default = float(default)
            if not math.isfinite(default):
                raise ValueError('COLLECT_INVALID')
        elif entry['type'] == 'boolean':
            if default not in ('true', 'false'):
                raise ValueError('COLLECT_INVALID')
            default = default == 'true'
        values[key] = default
    for key, value in snapshot['values'].items():
        declaration = declarations.get(key)
        if declaration is None:
            raise ValueError('COLLECT_INVALID')
        kind = declaration['type']
        if (kind == 'string' and not isinstance(value, str)
            or kind == 'boolean' and type(value) is not bool
            or kind == 'number' and (type(value) not in (int, float) or not math.isfinite(value))
            or kind not in ('string', 'boolean', 'number')):
            raise ValueError('COLLECT_INVALID')
        values[key] = value
    for key in ('garmin.date_pause_seconds', 'garmin.call_pause_min_seconds',
                'garmin.call_pause_max_seconds', 'garmin.lock_wait_seconds'):
        if values[key] < 0:
            raise ValueError('COLLECT_INVALID')
    for key, minimum in (('garmin.max_dates_per_run', 3), ('garmin.max_rejected_attempts', 1),
                         ('garmin.max_consecutive_403', 1)):
        if values[key] < minimum or values[key] != int(values[key]):
            raise ValueError('COLLECT_INVALID')
    if values['garmin.call_pause_min_seconds'] > values['garmin.call_pause_max_seconds']:
        raise ValueError('COLLECT_INVALID')
    if not values['garmin.tokenstore']:
        raise ValueError('COLLECT_INVALID')
    zone = values.get('garmin.timezone')
    if zone is not None:
        try:
            if not zone:
                raise ValueError()
            ZoneInfo(zone)
        except (ZoneInfoNotFoundError, ValueError):
            raise ValueError('COLLECT_INVALID') from None
    elif require_timezone:
        raise ValueError('COLLECT_INVALID')
    return values
