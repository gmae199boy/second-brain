"""원본 SQLite의 표와 열을 변경 없이 읽는다."""
import sqlite3
from contextlib import closing
from pathlib import Path


class SQLiteText(str):
    """디코딩된 TEXT와 SQLite 데이터베이스 인코딩의 원래 바이트."""
    def __new__(cls, raw, encoding):
        value = super().__new__(cls, raw.decode(encoding, errors='strict'))
        value.raw = raw
        value.encoding = encoding
        return value


class InvalidSQLiteText:
    """디코딩 불가능한 TEXT를 BLOB이나 대체 문자로 가장하지 않는다."""
    def __init__(self, raw, encoding):
        self.raw = raw
        self.encoding = encoding

    def __eq__(self, other):
        return isinstance(other, InvalidSQLiteText) and (self.encoding, self.raw) == (other.encoding, other.raw)

    def __hash__(self):
        return hash((self.encoding, self.raw))


def text_value(raw, encoding):
    try:
        return SQLiteText(raw, encoding)
    except UnicodeDecodeError:
        return InvalidSQLiteText(raw, encoding)


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def read_snapshot(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_file() or path.with_name(path.name + '-wal').exists():
        raise ValueError('PREFLIGHT_INVALID')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro&immutable=1', uri=True)) as conn:
        return read_connection(conn)


def read_snapshot_bytes(data):
    # WAL sidecar는 호출자가 거부한다. SQLite는 WAL 헤더를 메모리 DB에서
    # 열 수 없으므로 메모리 복사본에서만 rollback 형식으로 읽는다.
    # https://www.sqlite.org/c3ref/deserialize.html
    if data[:16] == b'SQLite format 3\x00' and data[18:20] == b'\x02\x02':
        data = data[:18] + b'\x01\x01' + data[20:]
    with closing(sqlite3.connect(':memory:')) as conn:
        conn.deserialize(data)
        return read_connection(conn)


def read_connection(conn):
    conn.execute('pragma query_only = on')
    version = conn.execute('pragma user_version').fetchone()[0]
    encoding = {'UTF-8': 'utf-8', 'UTF-16le': 'utf-16le', 'UTF-16be': 'utf-16be'}[conn.execute('pragma encoding').fetchone()[0]]
    if version not in (10, 15):
        raise ValueError('PREFLIGHT_SCHEMA_UNSUPPORTED')
    tables = {}
    names = [r[0] for r in conn.execute("select name from sqlite_master where type='table' and name not like 'sqlite_%' order by name")]
    for name in names:
        columns = conn.execute('pragma table_xinfo(' + quoted(name) + ')').fetchall()
        keys = [c[1] for c in sorted((c for c in columns if c[5]), key=lambda c: c[5])]
        if name == 'notification' and {'local_date', 'event'} <= {c[1] for c in columns}:
            keys = ['local_date', 'event']
        names = [c[1] for c in columns]
        # TEXT만 BLOB으로 읽어 sqlite3의 암묵적인 UTF-8 디코딩을 피한다.
        projections = []
        for column in names:
            col = quoted(column)
            projections.extend((f'typeof({col})', f'case when typeof({col}) = \'text\' then cast({col} as blob) else {col} end'))
        rows = []
        for values in conn.execute('select ' + ','.join(projections) + ' from ' + quoted(name)):
            rows.append({column: text_value(values[i * 2 + 1], encoding) if values[i * 2] == 'text' else values[i * 2 + 1] for i, column in enumerate(names)})
        tables[name] = {'columns': names, 'column_metadata': [{'name': c[1], 'type': c[2], 'not_null': bool(c[3]), 'default': c[4], 'primary_key_position': c[5], 'hidden': c[6]} for c in columns], 'keys': keys, 'rows': rows}
    return {'schema': version, 'encoding': encoding, 'tables': tables}
