"""Unit contracts for the supervised store; database integration uses dedicated test roles."""
import os
import unittest
from contextlib import contextmanager
from unittest.mock import patch
from uuid import UUID

import psycopg
from psycopg.pq import TransactionStatus
from garmin_pipeline import store

USER = UUID('00000000-0000-4000-8000-000000000001')
CONNECTION = UUID('00000000-0000-4000-8000-000000000002')
WORK = UUID('00000000-0000-4000-8000-000000000003')
TOKEN = UUID('00000000-0000-4000-8000-000000000004')


class Cursor:
    def __init__(self, raw=None, row=None): self.raw, self.row = raw, row
    def execute(self, query, params=None, **kwargs):
        self.row = self.raw.execute(query, params, **kwargs).row
        return self
    def executemany(self, query, params):
        for item in params: self.execute(query, item)
    def fetchone(self): return self.row
    def close(self): pass


class FakeRaw:
    def __init__(self, *, version=store.NATIVE_SCHEMA_VERSION, account=True, attempt=True, raw=None):
        self.version, self.account, self.attempt, self.value = version, account, attempt, raw
        self.commands, self.closed, self.depth = [], False, 0
        self.info = type('Info', (), {'transaction_status': TransactionStatus.IDLE})()

    def execute(self, query, params=None, **kwargs):
        self.commands.append((query, params))
        if query.startswith('BEGIN'): self.info.transaction_status = TransactionStatus.INTRANS
        if query in ('ROLLBACK', 'COMMIT'): self.info.transaction_status = TransactionStatus.IDLE
        if 'native_schema_version' in query: return Cursor(row=(self.version,))
        if 'from garmin.account_connections' in query: return Cursor(row=(CONNECTION,) if self.account else None)
        if 'attempt_valid' in query: return Cursor(row=(self.attempt,))
        if 'pg_try_advisory' in query: return Cursor(row=(True,))
        if 'insert into garmin.raw_response' in query:
            if self.value is None: self.value = params[5]
            return Cursor()
        if 'select raw,fetched_at,checked_at,library_version from garmin.raw_current' in query: return Cursor(row=(self.value, 1, 1, '0') if self.value is not None else None)
        if 'returning revision' in query: return Cursor(row=(2,))
        return Cursor()

    def cursor(self, *args, **kwargs): return Cursor(self)

    @contextmanager
    def transaction(self):
        nested = self.depth > 0 or self.info.transaction_status == TransactionStatus.INTRANS
        self.commands.append(('SAVEPOINT' if nested else 'BEGIN', None))
        self.depth += 1
        self.info.transaction_status = TransactionStatus.INTRANS
        try:
            yield
        except BaseException:
            self.commands.append(('ROLLBACK TO SAVEPOINT' if nested else 'ROLLBACK', None))
            raise
        else:
            self.commands.append(('RELEASE SAVEPOINT' if nested else 'COMMIT', None))
        finally:
            self.depth -= 1
            if not nested: self.info.transaction_status = TransactionStatus.IDLE

    def close(self): self.closed = True


class StoreTest(unittest.TestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {'BRAIN_DATABASE_URL': 'postgresql://invalid/test',
            'BRAIN_USER_ID': str(USER), 'BRAIN_WORK_ID': str(WORK),
            'BRAIN_ATTEMPT_TOKEN': str(TOKEN), 'BRAIN_ACCOUNT': 'synthetic'}, clear=True)
        self.env.start(); self.addCleanup(self.env.stop)

    def test_read_starts_snapshot_before_schema_and_scopes_account(self):
        raw = FakeRaw()
        with patch.object(store.psycopg, 'connect', return_value=raw):
            conn = store.read_connection(None)
        self.assertEqual(raw.commands[0][0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.assertEqual(raw.commands[2][1], (USER, 'synthetic'))
        self.assertEqual((conn.user_id, conn.connection_id), (USER, CONNECTION))
        conn.close(); self.assertTrue(raw.closed)

    def test_unknown_account_or_schema_fails_closed(self):
        for raw in (FakeRaw(account=False), FakeRaw(version=13)):
            with patch.object(store.psycopg, 'connect', return_value=raw):
                with self.assertRaises(store.StoreError): store.read_connection(None)
            self.assertTrue(raw.closed)

    def test_missing_context_does_not_connect(self):
        del os.environ['BRAIN_ACCOUNT']
        with patch.object(store.psycopg, 'connect') as connect:
            with self.assertRaises(store.StoreError): store.read_connection(None)
            connect.assert_not_called()

    def test_explicit_supervised_selection_is_scoped_and_restored(self):
        raw = FakeRaw()
        del os.environ['BRAIN_ACCOUNT']
        account = store.AccountContext(USER, CONNECTION, WORK, TOKEN)
        with store.supervised_account(account), patch.object(store.psycopg, 'connect', return_value=raw):
            conn = store.read_connection(None)
            self.assertEqual(raw.commands[2][1], (USER, CONNECTION))
            self.assertIn('connection_id=%s', raw.commands[2][0])
            conn.close()
        with patch.object(store.psycopg, 'connect') as connect:
            with self.assertRaises(store.StoreError): store.read_connection(None)
            connect.assert_not_called()

    def test_supervised_context_must_match_envelope(self):
        account = store.AccountContext(USER, CONNECTION, WORK, CONNECTION)
        with store.supervised_account(account), patch.object(store.psycopg, 'connect') as connect:
            with self.assertRaises(store.StoreError): store.read_connection(None)
            connect.assert_not_called()

    def test_session_stays_idle_and_stale_transaction_rolls_back(self):
        raw = FakeRaw()
        cfg = type('Config', (), {'lock_wait_seconds': 0})()
        with patch.object(store.psycopg, 'connect', return_value=raw):
            with store.write_session(cfg) as conn:
                self.assertEqual(raw.info.transaction_status, TransactionStatus.IDLE)
                self.assertFalse(any('attempt_valid' in sql for sql, _ in raw.commands))
                with self.assertRaises(store.StaleAttempt):
                    with store.transaction(conn):
                        conn.execute('insert into garmin.meta values (%s)', ('synthetic',))
                        raw.attempt = False
                self.assertEqual(raw.info.transaction_status, TransactionStatus.IDLE)
            self.assertTrue(raw.closed)
        self.assertIn(('ROLLBACK', None), raw.commands)
        self.assertNotIn(('COMMIT', None), raw.commands)
        self.assertIn('pg_try_advisory_lock', next(sql for sql, _ in raw.commands if 'pg_try_advisory' in sql))

    def test_unscoped_writes_and_cursors_are_rejected(self):
        raw = FakeRaw()
        conn = store.Connection(raw, store.AccountContext(USER, CONNECTION, WORK, TOKEN), readonly=False)
        with self.assertRaises(store.StoreError): conn.execute('insert into garmin.meta values (1)')
        with self.assertRaises(store.StoreError): conn.executemany('insert into garmin.meta values (%s)', [(1,)])
        with self.assertRaises(store.StoreError): conn.cursor()
        with self.assertRaises(store.StoreError): store.savepoint(conn).__enter__()
        self.assertFalse(hasattr(conn, 'raw'))

    def test_report_lock_is_session_scoped_and_idle(self):
        raw = FakeRaw()
        with patch.object(store.psycopg, 'connect', return_value=raw):
            with store.report_session(None, blocking=False):
                self.assertEqual(raw.info.transaction_status, TransactionStatus.IDLE)
                self.assertFalse(any('attempt_valid' in sql for sql, _ in raw.commands))
        self.assertTrue(raw.closed)

    def test_lock_releases_connection_on_exception(self):
        raw = FakeRaw()
        cfg = type('Config', (), {'lock_wait_seconds': 0})()
        with patch.object(store.psycopg, 'connect', return_value=raw):
            with self.assertRaisesRegex(ValueError, 'synthetic'):
                with store.write_session(cfg):
                    raise ValueError('synthetic')
        self.assertTrue(raw.closed)
        self.assertEqual(raw.info.transaction_status, TransactionStatus.IDLE)

    def test_statement_cannot_end_or_escape_transaction(self):
        raw = FakeRaw()
        conn = store.Connection(raw, store.AccountContext(USER, CONNECTION, WORK, TOKEN), readonly=False)
        with store.transaction(conn):
            for sql in ('COMMIT', 'select 1; commit', '/* comment */ commit'):
                with self.assertRaises(store.StoreError): conn.execute(sql)

    def test_successful_transaction_fences_and_commits_once(self):
        raw = FakeRaw()
        conn = store.Connection(raw, store.AccountContext(USER, CONNECTION, WORK, TOKEN), readonly=False)
        with store.transaction(conn):
            conn.execute('insert into garmin.meta values (%s)', ('synthetic',))
        self.assertEqual(sum('attempt_valid' in sql for sql, _ in raw.commands), 2)
        self.assertEqual(raw.commands[-1][0], 'COMMIT')
        self.assertEqual(raw.info.transaction_status, TransactionStatus.IDLE)

    def test_callers_cannot_end_the_fenced_transaction(self):
        raw = FakeRaw()
        conn = store.Connection(raw, store.AccountContext(USER, CONNECTION, WORK, TOKEN), readonly=False)
        for sql in ('COMMIT', ' begin', 'ROLLBACK', 'SAVEPOINT s'):
            with self.assertRaises(store.StoreError): conn.execute(sql)
        self.assertEqual(raw.commands, [])

    def test_append_revision_is_serialized_and_scoped(self):
        raw = FakeRaw()
        conn = store.Connection(raw, store.AccountContext(USER, CONNECTION, WORK, TOKEN), readonly=False)
        rev = store.append_evaluation(conn, report_date='2026-01-01', scope='day', summary='synthetic',
            judgments='[]', evidence='[]', next_checks='[]', report_md='', model='', created_at=1)
        self.assertEqual(rev, 2)
        self.assertTrue(any('pg_advisory_xact_lock' in sql for sql, _ in raw.commands))
        sql, args = next((sql, args) for sql, args in raw.commands if 'returning revision' in sql)
        self.assertIn('user_id=%s and connection_id=%s', sql)
        self.assertEqual(args[:2], (USER, CONNECTION))
        self.assertEqual(args[-4:], (USER, CONNECTION, '2026-01-01', 'day'))

    def test_raw_observation_does_not_overwrite_original(self):
        raw = FakeRaw(raw='{"a": 1}')
        conn = store.Connection(raw, store.AccountContext(USER, CONNECTION, WORK, TOKEN), readonly=False)
        store.upsert_raw(conn, scope='day', key='synthetic', endpoint='x', payload={'a': 2}, library_version='1', now_ms=2)
        self.assertEqual(raw.value, '{"a": 1}')
        observation = next(args for sql, args in raw.commands if 'insert into garmin.raw_observations' in sql)
        state = next(args for sql, args in raw.commands if 'insert into garmin.raw_current_state' in sql)
        self.assertEqual(observation[5:], ('{"a": 2}', 2, '1'))
        self.assertEqual(state[5:], ('{"a": 2}', 2, 2, '1'))


# Only dedicated synthetic databases may supply these test credentials. The owner
# connection inspects catalog ACLs, and the extension and non-extension connections
# exercise the function using the same isolated database.
class SchemaVersionSecurityTest(unittest.TestCase):
    def test_version_function_is_private_and_scoped(self):
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN']) as owner:
            row = owner.execute('''select pg_catalog.pg_get_userbyid(p.proowner), p.prosecdef,
                p.proconfig, exists (select 1 from pg_catalog.aclexplode(coalesce(p.proacl, pg_catalog.acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE'),
                pg_catalog.has_function_privilege('brain_ext_garmin',p.oid,'execute')
                from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
                where n.nspname='garmin' and p.proname='native_schema_version' and p.pronargs=0''').fetchone()
            self.assertEqual(row[0], 'brain_owner'); self.assertTrue(row[1]); self.assertFalse(row[3]); self.assertTrue(row[4])
            self.assertIn('search_path=""', row[2])
            expected = owner.execute("select max(version) from brain.schema_migrations where owner='garmin'").fetchone()[0]
        self.assertEqual(expected, store.NATIVE_SCHEMA_VERSION)
        with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as ext:
            self.assertEqual(ext.execute('select garmin.native_schema_version()').fetchone()[0], expected)
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                ext.execute('select * from brain.schema_migrations')
        with psycopg.connect(os.environ['GARMIN_TEST_OTHER_DSN']) as other:
            with self.assertRaises(psycopg.errors.InsufficientPrivilege):
                other.execute('select garmin.native_schema_version()')
