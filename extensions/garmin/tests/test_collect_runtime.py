"""Supervised input and fail-closed boundary; execution deferred to 21.8."""
import contextlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import collect_runtime as runtime
from garmin_pipeline import store

USER = '00000000-0000-4000-8000-000000000001'
CONNECTION = '00000000-0000-4000-8000-000000000002'
WORK = '00000000-0000-4000-8000-000000000003'
TOKEN = '00000000-0000-4000-8000-000000000004'


def environment():
    return {'BRAIN_ABI_VERSION': '1', 'BRAIN_WORK_KIND': 'garmin.collect',
        'BRAIN_TARGET_KIND': 'extension', 'BRAIN_TARGET_ID': CONNECTION,
        'BRAIN_USER_ID': USER, 'BRAIN_WORK_ID': WORK, 'BRAIN_ATTEMPT_TOKEN': TOKEN,
        'BRAIN_RUN_GENERATION': '1', 'BRAIN_DATABASE_URL': 'postgres://synthetic/db',
        'BRAIN_EXTENSION_HOME': '/synthetic/extension',
        'BRAIN_SETTINGS_SNAPSHOT': json.dumps({'version': 1, 'extension': 'garmin',
            'user_id': USER, 'values': {'garmin.timezone': 'UTC', 'garmin.tokenstore': '/synthetic/tokenstore'}})}


class EnvelopeTest(unittest.TestCase):
    def test_context_and_original_protection_defaults(self):
        account, cfg = runtime.envelope(environment())
        self.assertEqual(account, store.AccountContext(UUID(USER), UUID(CONNECTION), UUID(WORK), UUID(TOKEN)))
        self.assertEqual((cfg.date_pause_seconds, cfg.call_pause_min_seconds, cfg.call_pause_max_seconds), (5, 1, 2))
        self.assertEqual((cfg.max_dates_per_run, cfg.max_rejected_attempts, cfg.max_consecutive_403), (10, 3, 3))

    def test_invalid_envelopes_fail_before_store(self):
        for key, value in [('BRAIN_TARGET_ID', 'default'), ('BRAIN_USER_ID', 'bad'),
                           ('BRAIN_ATTEMPT_TOKEN', 'bad'), ('BRAIN_WORK_KIND', 'garmin.import'),
                           ('BRAIN_RUN_GENERATION', '0')]:
            env = environment(); env[key] = value
            with self.subTest(key=key), patch.object(store, 'write_session') as session:
                with self.assertRaises(runtime.InvalidCollectInput): runtime.run(env)
                session.assert_not_called()
        env = environment(); snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT']); snapshot['user_id'] = CONNECTION
        env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)
        with self.assertRaises(runtime.InvalidCollectInput): runtime.envelope(env)

    def test_selected_context_and_safe_credential_boundary(self):
        class Result:
            def fetchone(self): return ('UTC',)
        class Conn:
            def execute(self, sql, args):
                if 'timezone' in sql: self.args = args; return Result()
                if 'max(id)' in sql: return type('R', (), {'fetchone': lambda self: (0,)})()
                return type('R', (), {'fetchone': lambda self: None})()
        conn = Conn(); seen = []
        @contextlib.contextmanager
        def bind(account):
            seen.append(account)
            yield
        @contextlib.contextmanager
        def session(cfg): yield conn
        @contextlib.contextmanager
        def transaction(connection): yield connection
        with patch.object(store, 'supervised_account', bind), patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run') as collect_run:
            runtime.run(environment(), port_factory=lambda cfg, conn, sleep: 'fake-port')
            self.assertEqual(collect_run.call_args.args[2], 'fake-port')
            self.assertTrue(collect_run.call_args.kwargs['manual'])
            self.assertIsInstance(collect_run.call_args.kwargs['notifier'], runtime.ports.TableNotifier)
        self.assertEqual(seen[0].connection_id, UUID(CONNECTION))
        self.assertEqual(conn.args, (UUID(USER), UUID(CONNECTION)))

    def test_missing_or_other_account_stops_before_credentials(self):
        class Result:
            def fetchone(self): return None
        class Conn:
            def execute(self, sql, args): return Result()
        @contextlib.contextmanager
        def session(cfg): yield Conn()
        @contextlib.contextmanager
        def transaction(connection): yield connection
        with patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime, 'verify_credentials') as verify:
            with self.assertRaises(runtime.InvalidCollectInput): runtime.run(environment())
            verify.assert_not_called()


class EntryTest(unittest.TestCase):
    def test_entry_classifies_without_exposing_exception_text(self):
        import collect as entry
        import io
        from contextlib import redirect_stdout
        for error, code, retry in [(runtime.InvalidCollectInput('secret'), 'COLLECT_INVALID', False),
                                   (store.LockTimeout('secret'), 'COLLECT_LOCKED', True),
                                   (OSError('secret'), 'COLLECT_UNAVAILABLE', True)]:
            out = io.StringIO()
            with patch.object(runtime, 'run', side_effect=error), redirect_stdout(out):
                self.assertEqual(entry.main(), 1)
            self.assertEqual(json.loads(out.getvalue()), {'abi': 1, 'type': 'error', 'code': code, 'retryable': retry})
        out = io.StringIO()
        with patch.object(runtime, 'run', return_value=json.dumps({'status': 'partial', 'runs': 1, 'errors': 2})), redirect_stdout(out):
            self.assertEqual(entry.main(), 0)
        self.assertEqual(json.loads(json.loads(out.getvalue())['summary']), {'status': 'partial', 'runs': 1, 'errors': 2})

    def test_import_failure_still_emits_one_safe_abi_event(self):
        import builtins
        import collect as entry
        import io
        from contextlib import redirect_stdout
        original = builtins.__import__
        def fail(name, *args, **kwargs):
            if name == 'collect_runtime': raise ImportError('secret')
            return original(name, *args, **kwargs)
        out = io.StringIO()
        with patch('builtins.__import__', side_effect=fail), redirect_stdout(out):
            self.assertEqual(entry.main(), 1)
        self.assertEqual(json.loads(out.getvalue()), {'abi': 1, 'type': 'error', 'code': 'COLLECT_UNAVAILABLE', 'retryable': True})

    def test_final_status_and_failure_count_are_returned(self):
        class Conn:
            def execute(self, sql, args):
                value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, 'partial') if 'select id, status' in sql else (2,)))
                return type('R', (), {'fetchone': lambda self: value})()
        @contextlib.contextmanager
        def session(cfg): yield Conn()
        @contextlib.contextmanager
        def transaction(conn): yield conn
        with patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run'):
            self.assertEqual(json.loads(runtime.run(environment(), port_factory=lambda *args, **kwargs: None)), {'status': 'partial', 'runs': 1, 'errors': 2})

    def test_all_queries_are_fenced_and_collect_is_outside_transaction(self):
        class Conn:
            depth = 0
            def execute(self, sql, args):
                if self.depth != 1: raise AssertionError('query outside transaction')
                value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, 'success') if 'select id, status' in sql else (0,)))
                return type('R', (), {'fetchone': lambda self: value})()
        conn = Conn()
        @contextlib.contextmanager
        def session(cfg): yield conn
        @contextlib.contextmanager
        def transaction(value):
            value.depth += 1
            try: yield value
            finally: value.depth -= 1
        def collect_run(*args, **kwargs): self.assertEqual(conn.depth, 0)
        with patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run', side_effect=collect_run):
            self.assertEqual(json.loads(runtime.run(environment(), port_factory=lambda *args, **kwargs: None)), {'status': 'success', 'runs': 1, 'errors': 0})

    def test_domain_statuses_map_to_fixed_public_vocabulary(self):
        for status, public in [('success', 'success'), ('partial', 'partial'), ('auth_failed', 'auth_required'),
                               ('rate_limited', 'blocked'), ('blocked_403', 'blocked'), ('skipped_blocked', 'blocked'), ('error', 'error')]:
            class Conn:
                def execute(self, sql, args):
                    value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, status) if 'select id, status' in sql else (2,)))
                    return type('R', (), {'fetchone': lambda self: value})()
            @contextlib.contextmanager
            def session(cfg): yield Conn()
            @contextlib.contextmanager
            def transaction(conn): yield conn
            with self.subTest(status=status), patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run'):
                self.assertEqual(json.loads(runtime.run(environment(), port_factory=lambda *args, **kwargs: None)), {'status': public, 'runs': 1, 'errors': 2})
