"""원천 TEXT의 표시값과 권위 바이트 사이의 공통 가역 표현."""
from reader import SQLiteText, InvalidSQLiteText
import base64

ENCODINGS = frozenset(('utf-8', 'utf-16le', 'utf-16be'))
DATASET_PREFIX = '~dataset1:'


def dataset_ref(value):
    if not isinstance(value, str): raise ValueError('IMPORT_INVALID')
    if '\x00' in value or value.startswith(DATASET_PREFIX):
        return DATASET_PREFIX + base64.urlsafe_b64encode(value.encode('utf-8', errors='strict')).decode('ascii')
    return value


def project(value):
    if value is None:
        return None, None, None
    if isinstance(value, (SQLiteText, InvalidSQLiteText)):
        raw, encoding = value.raw, value.encoding
    elif isinstance(value, str):
        raw, encoding = value.encode('utf-8', errors='strict'), 'utf-8'
    else:
        raise ValueError('IMPORT_INVALID')
    if encoding not in ENCODINGS:
        raise ValueError('IMPORT_INVALID')
    try:
        logical = raw.decode(encoding, errors='strict')
    except UnicodeDecodeError:
        # 원형은 바이트에 남기고 표시값은 유효하지 않은 단위마다 대체한다.
        return raw.decode(encoding, errors='replace').replace('\x00', '\ufffd'), raw, encoding
    display = logical.replace('\x00', '\ufffd')
    if encoding == 'utf-8' and display == logical:
        return display, None, None
    return display, raw, encoding


def restore(display, raw, encoding):
    if raw is None:
        if encoding is not None or (display is not None and (not isinstance(display, str) or '\x00' in display)):
            raise ValueError('IMPORT_INVALID')
        return display
    if display is None or encoding not in ENCODINGS:
        raise ValueError('IMPORT_INVALID')
    raw = bytes(raw)
    try:
        value = SQLiteText(raw, encoding)
    except UnicodeDecodeError:
        value = InvalidSQLiteText(raw, encoding)
    if project(value) != (display, raw, encoding):
        raise ValueError('IMPORT_INVALID')
    return value
