"""Synthetic contracts for account-scoped Garmin read paths (not executed here)."""
import sqlite3
import sys
import unittest
from datetime import date, time
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import reader
from garmin_pipeline import capture, charts, coverage

USER = UUID('00000000-0000-4000-8000-000000000001')
CONNECTION = UUID('00000000-0000-4000-8000-000000000002')


class Result:
    def __init__(self, rows): self.rows = rows
    def __iter__(self): return iter(self.rows)
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows


class Conn:
    user_id = USER
    connection_id = CONNECTION
    def __init__(self, missing_order=False): self.calls, self.missing_order = [], missing_order
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if 'o.source_order FROM' in sql:
            return Result([('second', None if self.missing_order else 3), ('first', 9)])
        if 'SELECT raw FROM' in sql: return Result([('null',)])
        if 'status, detail, finished_at' in sql: return Result([])
        return Result([])


class ScopedReadersTest(unittest.TestCase):
    def assert_scoped(self, conn):
        for sql, args in conn.calls:
            self.assertIn(USER, args, sql)
            self.assertIn(CONNECTION, args, sql)
            self.assertNotIn('?', sql)
            self.assertIn('garmin.', sql)

    def test_capture_explicit_selection_is_scoped_and_keeps_null(self):
        conn = Conn()
        rows = capture.select(conn, days=[date(2026, 1, 2)], activity_ids=[])
        self.assertEqual(len(rows), len(coverage.DAY_ENDPOINTS))
        self.assertTrue(all(r.raw == 'null' for r in rows))
        self.assert_scoped(conn)

    def test_coverage_scopes_disjunction_and_empty_status(self):
        conn = Conn()
        cfg = SimpleNamespace(timezone='UTC', max_rejected_attempts=3)
        self.assertEqual(coverage.day_status(conn, date(2026, 1, 2)).status, coverage.NOT_RUN)
        items = coverage.items(conn, cfg, date(2026, 1, 2), date(2026, 1, 2))
        self.assertEqual(len(items), len(coverage.DAY_ENDPOINTS))
        raw_sql = next(sql for sql, _ in conn.calls if 'checked_at, raw' in sql)
        self.assertIn('AND ((scope', raw_sql)
        self.assert_scoped(conn)

    def test_charts_use_order_relation_and_reject_missing_order(self):
        conn = Conn()
        result = charts._read_strength(conn, date(2026, 1, 2))
        self.assertEqual([i['label'] for i in result['items']], ['second', 'first'])
        join = conn.calls[0][0]
        self.assertIn('o.user_id=e.user_id', join)
        self.assertIn('o.connection_id=e.connection_id', join)
        self.assertIn('o.source_order', join)
        self.assert_scoped(conn)
        with self.assertRaisesRegex(ValueError, 'source order'):
            charts._read_strength(Conn(missing_order=True), date(2026, 1, 2))

    def test_chart_sample_allowlist_and_scope(self):
        conn = Conn()
        charts._samples(conn, SimpleNamespace(timezone='UTC'), 'hr_sample', 'bpm', 0, 1)
        with self.assertRaises(ValueError):
            charts._samples(conn, None, 'hr_sample; DROP TABLE x', 'bpm', 0, 1)
        self.assert_scoped(conn)


class SourceRowidTest(unittest.TestCase):
    def make_db(self, sql):
        conn = sqlite3.connect(':memory:')
        conn.execute('pragma user_version=15')
        conn.execute(sql)
        self.addCleanup(conn.close)
        return conn

    def test_rowids_are_parallel_metadata_and_do_not_change_columns(self):
        conn = self.make_db('create table exercise_log(activity_id integer, exercise text, primary key(activity_id,exercise))')
        conn.execute("insert into exercise_log(rowid,activity_id,exercise) values (8,10,'synthetic-a'),(3,11,'synthetic-b')")
        table = reader.read_connection(conn)['tables']['exercise_log']
        self.assertEqual(table['columns'], ['activity_id', 'exercise'])
        self.assertEqual(table['keys'], ['activity_id', 'exercise'])
        self.assertEqual({r['exercise']: rowid for r, rowid in zip(table['rows'], table['rowids'], strict=True)},
                         {'synthetic-a': 8, 'synthetic-b': 3})
        self.assertTrue(all('rowid' not in r for r in table['rows']))

    def test_without_rowid_exercise_log_is_explicitly_rejected(self):
        conn = self.make_db('create table exercise_log(activity_id integer, exercise text, primary key(activity_id,exercise)) without rowid')
        with self.assertRaisesRegex(ValueError, 'PREFLIGHT_ROWID_UNSUPPORTED'):
            reader.read_connection(conn)

    def test_shadowed_rowid_uses_another_hidden_alias(self):
        conn = self.make_db('create table exercise_log(rowid text, activity_id integer, exercise text, primary key(activity_id,exercise))')
        conn.execute("insert into exercise_log(_rowid_,rowid,activity_id,exercise) values (7,'synthetic',1,'press')")
        table = reader.read_connection(conn)['tables']['exercise_log']
        self.assertEqual(table['rowids'], [7])
        self.assertEqual(table['rows'][0]['rowid'], 'synthetic')
