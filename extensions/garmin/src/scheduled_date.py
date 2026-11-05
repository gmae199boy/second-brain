"""Validate the core supervisor occurrence envelope without using wall-clock time."""
import json
import re
from datetime import date, datetime
from zoneinfo import ZoneInfo

_KEYS = ('BRAIN_OCCURRENCES', 'BRAIN_RANGE_FROM', 'BRAIN_RANGE_TO')
_INSTANT = re.compile(r'^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}(?:Z|[+-]\d{2}:\d{2})$')


def scheduled_date(env, timezone):
    present = [key in env for key in _KEYS]
    if not any(present): return None
    if not all(present): raise ValueError('incomplete schedule envelope')
    values = json.loads(env['BRAIN_OCCURRENCES'])
    if not isinstance(values, list) or len(values) != 1 or not isinstance(values[0], str) or not _INSTANT.fullmatch(values[0]):
        raise ValueError('one scheduled occurrence required')
    instant = datetime.fromisoformat(values[0].replace('Z', '+00:00'))
    if instant.utcoffset() is None: raise ValueError('missing offset')
    day = instant.astimezone(ZoneInfo(timezone)).date()
    for key in _KEYS[1:]:
        raw = env[key]
        if not isinstance(raw, str) or date.fromisoformat(raw).isoformat() != raw or raw != day.isoformat():
            raise ValueError('schedule date mismatch')
    return day
