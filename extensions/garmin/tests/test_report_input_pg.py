"""Account-scoped report input contracts; all data here is synthetic."""
import json
import tempfile
import unittest
from datetime import date, time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

from psycopg.rows import dict_row
from garmin_pipeline import report_input

USER = UUID('00000000-0000-4000-8000-000000000001')
CONNECTION = UUID('00000000-0000-4000-8000-000000000002')


class Result:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0] if self.rows else None
    def __iter__(self): return iter(self.rows)


class FakeConnection:
    user_id = USER
    connection_id = CONNECTION
    def __init__(self): self.calls, self.closed = [], False
    def execute(self, sql, params=()):
        self.calls.append((sql, params))
        if 'COUNT(*)' in sql: return Result([(1,)])
        if 'MIN(key' in sql: return Result([('2026-01-01',)])
        if 'FROM garmin.run' in sql: return Result([])
        if 'FROM garmin.evaluation' in sql:
            return Result([('2026-01-01', 'day', 'synthetic', '[]', '[]', '[]')])
        return Result([])
    def cursor(self, *, row_factory):
        assert row_factory is dict_row
        return DictCursor(self)
    def close(self): self.closed = True


class DictCursor:
    def __init__(self, conn): self.conn = conn
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def execute(self, sql, params):
        self.conn.calls.append((sql, params))
        self.sql = sql
    def fetchall(self):
        if 'FROM garmin.day_summary' in self.sql and 'AVG(' not in self.sql:
            return [{c: ('2026-01-01' if c == 'date' else None) for c in report_input._DAY_COLUMNS}]
        return []


class ReportInputPGTest(unittest.TestCase):
    def assert_scoped(self, conn):
        self.assertTrue(conn.closed)
        for sql, args in conn.calls:
            self.assertEqual(args[:2], (USER, CONNECTION), sql)
            self.assertNotIn('?', sql)
            self.assertNotIn('SELECT *', sql.upper())
            self.assertNotIn('BEGIN', sql.upper())

    def test_daily_snapshot_uses_scoped_tuple_reads(self):
        conn = FakeConnection()
        cfg = SimpleNamespace(timezone='UTC', collect_time=time(7))
        with patch.object(report_input.store, 'read_connection', return_value=conn):
            result = report_input._snapshot(cfg, date(2026, 1, 2), 1000, [])
        self.assertEqual(result[6], date(2026, 1, 1))
        self.assert_scoped(conn)

    def test_previous_evaluations_decode_json_and_use_separate_snapshot(self):
        conn = FakeConnection()
        with tempfile.TemporaryDirectory() as tmp:
            with patch.object(report_input.store, 'read_connection', return_value=conn):
                report_input._previous_evaluations(None, Path(tmp), date(2026, 1, 1), [])
            value = json.loads((Path(tmp) / 'previous_evaluations/day.json').read_text())
        self.assertEqual(value['judgments'], [])
        self.assertEqual(value['summary'], 'synthetic')
        self.assert_scoped(conn)

    def test_each_period_scopes_joins_and_only_emits_legacy_columns(self):
        for scope in ('7d', '30d', 'all'):
            conn = FakeConnection()
            with self.subTest(scope=scope), tempfile.TemporaryDirectory() as tmp:
                folder = Path(tmp)
                manifest = {'period_windows': {scope: {'from': '2026-01-01', 'to': '2026-01-02'}},
                            'months': ['2026-01'], 'data_cutoff': '2026-01-02T00:00:00+00:00'}
                (folder / 'manifest.json').write_text(json.dumps(manifest))
                with patch.object(report_input.store, 'read_connection', return_value=conn):
                    target = report_input.build_period(None, folder, date(2026, 1, 2), scope)
                values = json.loads((target / 'day_values.json').read_text())
                if scope != 'all':
                    self.assertEqual(list(values['day_summary'][0]), list(report_input._DAY_COLUMNS))
                    self.assertNotIn('user_id', values['day_summary'][0])
                    self.assertIsNone(values['day_summary'][0]['sleep_total_s'])
                else:
                    month_sql = next(sql for sql, _ in conn.calls if 'AVG(' in sql)
                    self.assertNotIn('AVG(user_id)', month_sql)
                    self.assertNotIn('AVG(connection_id)', month_sql)
                    subquery = next(sql for sql, _ in conn.calls if 'SELECT MAX(m.report_date' in sql)
                    self.assertIn('m.user_id=e.user_id', subquery)
                    self.assertIn('m.connection_id=e.connection_id', subquery)
                join = next(sql for sql, _ in conn.calls if 'JOIN garmin.workout' in sql)
                self.assertIn('w.user_id=e.user_id', join)
                self.assertIn('w.connection_id=e.connection_id', join)
                self.assert_scoped(conn)

class SQLiteCutoffArithmeticIntegrationTest(unittest.TestCase):
    """Independent SQLite expressions versus installed PG; deferred to 21.8."""
    def test_integer_and_real_overflow_boundaries_match_sqlite(self):
        import os
        import sqlite3
        import psycopg

        # The cancellation case rounds the product to 2**63 and the start to
        # -2**63 + 1767355199488 in binary64; their sum is 1767355199488.
        cancellation_start = -9223370269499575908
        cancellation_duration = 9223372036854776
        cases = [
            ('exact-integer-equal', 9007199254740993, 0, 9007199254740993, False),
            ('exact-integer-below', 9007199254740992, 0, 9007199254740993, True),
            ('integer-product-boundary', -9223372036854775808, 9223372036854775, -800, True),
            ('positive-product-overflow-cancellation', cancellation_start, cancellation_duration, 1767355200000, True),
            ('real-versus-inexact-integer-cutoff', -9214364837600034816, 9223372036854776, 9007199254740993, True),
            ('real-equal-cutoff', cancellation_start, cancellation_duration, 1767355199488, False),
            ('real-just-below-cutoff', cancellation_start, cancellation_duration, 1767355199489, True),
            ('real-above-cutoff', cancellation_start, cancellation_duration, 1767355199487, False),
            ('negative-product-overflow', 0, -9223372036854776, -9223372036854775808, False),
            ('positive-add-overflow', 9223372036854775807, 1, 9223372036854775807, False),
            ('negative-add-overflow', -9223372036854775808, -1, -9223372036854775808, False),
            ('negative-add-overflow-outside', -9223372036854775808, -2, -9223372036854775808, True),
            ('negative-integer', -1001, 1, 0, True),
            ('null-start', None, 1, 0, None),
            ('null-duration', 0, None, 0, None),
            ('null-cutoff', 0, 1, None, None),
        ]
        with sqlite3.connect(':memory:') as sqlite, psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as pg:
            for label, start, duration, cutoff, expected in cases:
                with self.subTest(label=label):
                    sqlite_result = sqlite.execute('select ? + ? * 1000 < ?', (start,duration,cutoff)).fetchone()[0]
                    pg_result = pg.execute('select garmin.activity_ends_before_cutoff(%s::bigint,%s::bigint,%s::bigint)', (start,duration,cutoff)).fetchone()[0]
                    self.assertEqual(None if sqlite_result is None else bool(sqlite_result), expected)
                    self.assertEqual(pg_result, expected)
