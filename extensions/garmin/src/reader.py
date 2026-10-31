"""원본 SQLite의 표와 열을 변경 없이 읽는다."""
import sqlite3
from contextlib import closing
from pathlib import Path


def quoted(name):
    return '"' + name.replace('"', '""') + '"'


def read_snapshot(path):
    path = Path(path)
    if not path.is_absolute() or not path.is_file():
        raise ValueError('PREFLIGHT_INVALID')
    with closing(sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)) as conn:
        conn.execute('pragma query_only = on')
        version = conn.execute('pragma user_version').fetchone()[0]
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
            rows = [dict(zip(names, row)) for row in conn.execute('select ' + ','.join(quoted(column) for column in names) + ' from ' + quoted(name))]
            tables[name] = {'columns': names, 'column_metadata': [{'name': c[1], 'type': c[2], 'not_null': bool(c[3]), 'default': c[4], 'primary_key_position': c[5], 'hidden': c[6]} for c in columns], 'keys': keys, 'rows': rows}
        return {'schema': version, 'tables': tables}
