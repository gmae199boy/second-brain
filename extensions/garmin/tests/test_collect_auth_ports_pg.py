"""Synthetic account and transaction contracts; execution deferred to 21.8."""
import contextlib
import sys
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from garmin_pipeline import auth, collect, coverage, errors, ports, store

USER = UUID('00000000-0000-4000-8000-000000000001')
ACCOUNT = UUID('00000000-0000-4000-8000-000000000002')
DAY = date(2026, 1, 2)

class Result:
    def __init__(self, rows=()): self.rows = list(rows)
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows

class Conn:
    user_id, connection_id = USER, ACCOUNT
    def __init__(self): self.depth, self.calls, self.notification = 0, [], False
    def execute(self, sql, args=()):
        assert self.depth == 1
        self.calls.append((sql, args))
        if 'INSERT INTO garmin.notification' in sql:
            if self.notification: return Result()
            self.notification = True
            return Result([(DAY.isoformat(),)])
        if 'INSERT INTO garmin.run' in sql and 'RETURNING id' in sql: return Result([(7,)])
        if 'UPDATE garmin.run' in sql and 'RETURNING' in sql:
            return Result([(7, DAY.isoformat())])
        return Result()

@contextlib.contextmanager
def transaction(conn):
    assert conn.depth == 0
    conn.depth += 1
    try: yield conn
    finally: conn.depth -= 1

class CollectPortsPGTest(unittest.TestCase):
    def setUp(self):
        self.conn = Conn()
        self.tx = patch.object(store, 'transaction', transaction)
        self.tx.start()
        self.addCleanup(self.tx.stop)
        lock = patch.object(store, 'identity_lock')
        lock.start()
        self.addCleanup(lock.stop)

    def assert_scoped(self):
        for sql, args in self.conn.calls:
            self.assertIn('garmin.', sql)
            self.assertNotIn('?', sql)
            self.assertIn(USER, args)
            self.assertIn(ACCOUNT, args)

    def test_abandon_commits_before_notification(self):
        conn = self.conn
        class Notifier:
            def notify(self, day, event, detail):
                assert conn.depth == 0
                self.call = (day, event, detail)
        notifier = Notifier()
        collect._abandon_running(conn, notifier)
        self.assertEqual(notifier.call[0], DAY)
        self.assertIn('user_id=%s AND connection_id=%s', conn.calls[0][0])
        self.assert_scoped()

    def test_fetch_failure_records_only_after_network_call(self):
        conn = self.conn
        class Session:
            def fetch_day(self, endpoint, day):
                assert conn.depth == 0
                raise errors.Rejected('synthetic')
        result = collect._fetch(conn, Session(), 7, DAY, 'day', DAY.isoformat(), 'user_summary')
        self.assertEqual(result, coverage.FetchErrorKind.REJECTED)
        self.assertIn('garmin.fetch_error', conn.calls[0][0])
        self.assert_scoped()

    def test_notification_deduplicates_and_sends_outside_transaction(self):
        conn = self.conn
        class Sender:
            def send(self, *args, **kwargs):
                assert conn.depth == 0
                return None
        notifier = ports.TelegramNotifier(conn, Sender(), budget_seconds=10)
        self.assertTrue(notifier.notify(DAY, errors.NotifyEvent.ERROR, 'synthetic'))
        self.assertFalse(notifier.notify(DAY, errors.NotifyEvent.ERROR, 'other'))
        self.assertEqual(sum('garmin.delivery' in sql for sql, _ in conn.calls), 1)
        self.assert_scoped()

    def test_coverage_read_runs_inside_transaction(self):
        def items(conn, *args):
            self.assertEqual(conn.depth, 1)
            return []
        cfg = SimpleNamespace(max_dates_per_run=4)
        with patch.object(coverage, 'items', items):
            self.assertEqual(collect._plan(self.conn, cfg, DAY, DAY, lambda _: False), [])
            self.assertEqual(collect._pending_activities(self.conn, cfg, DAY, lambda _: False), [])

    def test_auth_network_precedes_transaction(self):
        conn = self.conn
        @contextlib.contextmanager
        def session(_cfg): yield conn
        def login(*_args): self.assertEqual(conn.depth, 0)
        cfg = SimpleNamespace(tokenstore=Path('/synthetic'))
        with patch.object(auth, '_prepare_tokenstore'), patch.object(auth.garmin, 'interactive_login', login), \
             patch.object(store, 'write_session', session), patch.object(auth.dates, 'today', return_value=DAY):
            self.assertEqual(auth.login(cfg), 0)
        self.assertIn('garmin.auth_event', conn.calls[0][0])
        self.assert_scoped()

    def test_run_uses_returned_id_and_scoped_update(self):
        conn = self.conn
        cfg = SimpleNamespace(timezone='UTC')
        with patch.object(collect, '_abandon_running'), \
             patch.object(collect, '_enter', return_value=collect._exclude_nothing), \
             patch.object(collect, '_history_start', return_value=DAY), \
             patch.object(collect, '_plan', return_value=[]), \
             patch.object(collect, '_first_call_endpoints', return_value=()), \
             patch.object(collect, '_detail', return_value=''), \
             patch.object(collect, '_notify_end'):
            collect._collect_once(conn, cfg, None, None, today=DAY, started_at=1,
                                  force=False, manual=False, recent_lists=False, notifier=None)
        self.assertIn('RETURNING id', conn.calls[0][0])
        self.assertEqual(conn.calls[1][1][-1], 7)
        self.assertIn('user_id=%s AND connection_id=%s', conn.calls[1][0])
        self.assert_scoped()

    def test_first_call_and_rejected_are_scoped(self):
        self.assertEqual(collect._first_call_endpoints(self.conn), collect.FIRST_CALL_ENDPOINTS)
        self.assertFalse(collect._rejected_exclude(self.conn, DAY)(SimpleNamespace(scope='day', key='x', endpoint='x')))
        self.assert_scoped()
