"""합성 SQLite의 TEXT 저장 바이트와 타입 보존을 독립적으로 검사한다."""
import base64
from pathlib import Path
import sqlite3
import sys
from tempfile import TemporaryDirectory

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from batch_import import canonical, encoded
from reader import InvalidSQLiteText, read_snapshot
from raw_codec import project, restore

with TemporaryDirectory() as directory:
    for sql_encoding, encoding in [('UTF-8', 'utf-8'), ('UTF-16le', 'utf-16le'), ('UTF-16be', 'utf-16be')]:
        path = Path(directory) / (sql_encoding + '.db')
        with sqlite3.connect(path) as db:
            db.execute(f"pragma encoding = '{sql_encoding}'")
            db.execute('pragma user_version = 15')
            db.execute('create table sample (id integer primary key, value)')
            values = [None, '', '\x00', '\ufffd', r'\u0000', '한글', b'\x00\xff', 42]
            db.executemany('insert into sample(value) values (?)', [(value,) for value in values])
            if encoding == 'utf-8':
                db.execute("insert into sample(value) values (cast(x'80ff' as text))")
        snapshot = read_snapshot(path)
        assert snapshot['encoding'] == encoding
        rows = snapshot['tables']['sample']['rows']
        for row, expected in zip(rows, values):
            assert row['value'] == expected
            if isinstance(expected, str):
                item = encoded(row['value'])
                assert item == {'type': 'text', 'encoding': encoding, 'base64': base64.b64encode(expected.encode(encoding)).decode('ascii')}
                restored = restore(*project(row['value']))
                assert restored == expected
                assert project(restored) == project(row['value'])
        assert len({canonical(encoded(row['value'])) for row in rows}) == len(rows)
        if encoding == 'utf-8':
            assert isinstance(rows[-1]['value'], InvalidSQLiteText)
            assert encoded(rows[-1]['value']) == {'type': 'text', 'encoding': encoding, 'base64': 'gP8='}
            assert encoded(restore(*project(rows[-1]['value']))) == encoded(rows[-1]['value'])

    assert restore(*project(None)) is None
    assert project('\x00')[0] == '\ufffd'
    for pair in [('wrong', b'\x00', 'utf-8'), ('text', None, 'utf-8'), (None, b'a', 'utf-8'), ('x', b'x', 'bad')]:
        try:
            restore(*pair)
        except ValueError:
            pass
        else:
            raise AssertionError('invalid raw pair accepted')

# 구분자는 canonical 배열 구조의 일부가 아니므로 scope/key 경계가 겹치지 않는다.
assert canonical([encoded('a/b'), encoded('c')]) != canonical([encoded('a'), encoded('b/c')])
print('SQLite 원형·타입·인코딩 및 canonical key 검증 성공')
