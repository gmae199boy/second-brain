"""Supervised input and fail-closed boundary; execution deferred to 21.8."""
import contextlib
from datetime import date
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
                if "key='collect_backlog'" in sql:
                    return type('R', (), {'fetchone':lambda self:None})()
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
    def setUp(self):
        for patcher in (patch('garmin_pipeline.backlog.snapshot', return_value={
                'remaining_endpoints':2,'remaining_activities':1,'remaining_dates':1,'unplannable':0}),
                patch.object(runtime.collect, '_history_start', return_value=date(2026,1,1))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def summary(self, status, errors):
        return {'status':status,'runs':1,'errors':errors,'execution_status':status,'backlog_status':'partial',
            'remaining_endpoints':2,'remaining_activities':1,'remaining_dates':1,'unplannable':0,
            'deferred_dates':0,'deferred_endpoints':0,'deferred_first_call':0}

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
                if "key='collect_backlog'" in sql:
                    return type('R', (), {'fetchone':lambda self:None})()
                value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, 'partial') if 'select id, status' in sql else (2,)))
                return type('R', (), {'fetchone': lambda self: value})()
        @contextlib.contextmanager
        def session(cfg): yield Conn()
        @contextlib.contextmanager
        def transaction(conn): yield conn
        with patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run'):
            self.assertEqual(json.loads(runtime.run(environment(), port_factory=lambda *args, **kwargs: None)), self.summary('partial',2))

    def test_all_queries_are_fenced_and_collect_is_outside_transaction(self):
        class Conn:
            depth = 0
            def execute(self, sql, args):
                if self.depth != 1: raise AssertionError('query outside transaction')
                if "key='collect_backlog'" in sql:
                    return type('R', (), {'fetchone':lambda self:None})()
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
            self.assertEqual(json.loads(runtime.run(environment(), port_factory=lambda *args, **kwargs: None)), self.summary('success',0))

    def test_domain_statuses_map_to_fixed_public_vocabulary(self):
        for status, public in [('success', 'success'), ('partial', 'partial'), ('auth_failed', 'auth_required'),
                               ('rate_limited', 'blocked'), ('blocked_403', 'blocked'), ('skipped_blocked', 'blocked'), ('error', 'error')]:
            class Conn:
                def execute(self, sql, args):
                    if "key='collect_backlog'" in sql:
                        return type('R', (), {'fetchone':lambda self:None})()
                    value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, status) if 'select id, status' in sql else (2,)))
                    return type('R', (), {'fetchone': lambda self: value})()
            @contextlib.contextmanager
            def session(cfg): yield Conn()
            @contextlib.contextmanager
            def transaction(conn): yield conn
            with self.subTest(status=status), patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run'):
                self.assertEqual(json.loads(runtime.run(environment(), port_factory=lambda *args, **kwargs: None)), self.summary(public,2))

class ScheduledRuntimeTest(unittest.TestCase):
    def setUp(self):
        for patcher in (patch('garmin_pipeline.backlog.snapshot', return_value={
                'remaining_endpoints':0,'remaining_activities':0,'remaining_dates':0,'unplannable':0}),
                patch.object(runtime.collect, '_history_start', return_value=date(2026,1,1))):
            patcher.start()
            self.addCleanup(patcher.stop)

    def scheduled(self):
        env = environment()
        env.update(BRAIN_OCCURRENCES='["2026-01-02T02:00:00.000+00:00"]', BRAIN_RANGE_FROM='2026-01-02', BRAIN_RANGE_TO='2026-01-02')
        return env

    def test_scheduled_status_only_success_and_date_is_occurrence(self):
        from datetime import date
        for status in ('success', 'partial', 'rate_limited', 'blocked_403', 'auth_failed', 'skipped_blocked', 'error', None):
            class Conn:
                def execute(self, sql, args):
                    if "key='collect_backlog'" in sql:
                        return type('R', (), {'fetchone':lambda self:None})()
                    value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, status) if status is not None else None) if 'select id, status' in sql else ((5, 'success') if status == 'success' else None) if 'collect_work_runs w join' in sql else (0,))
                    return type('R', (), {'fetchone': lambda self: value})()
            @contextlib.contextmanager
            def session(cfg): yield Conn()
            @contextlib.contextmanager
            def transaction(conn): yield conn
            with self.subTest(status=status), patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.normalize, '_work_set', return_value=[]), patch.object(runtime.collect, 'run') as collect_run:
                if status == 'success':
                    self.assertEqual(json.loads(runtime.run(self.scheduled(), port_factory=lambda *a, **kw: None))['status'], 'success')
                else:
                    with self.assertRaises(runtime.ScheduledCollectIncomplete): runtime.run(self.scheduled(), port_factory=lambda *a, **kw: None)
                self.assertEqual(collect_run.call_args.kwargs['today'], date(2026, 1, 2))
                self.assertFalse(collect_run.call_args.kwargs['manual'])

    def test_projection_failure_and_pending_are_retryable_before_success(self):
        for failure, pending, unprocessed in ((True, False, []), (False, True, []), (False, False, ['item'])):
            class Conn:
                def execute(self, sql, args):
                    if "key='collect_backlog'" in sql:
                        return type('R', (), {'fetchone':lambda self:None})()
                    value = ('UTC',) if 'timezone' in sql else ((4,) if 'max(id)' in sql else ((5, 'success') if 'select id, status' in sql or 'collect_work_runs w join' in sql else ((failure,) if 'normalize_result' in sql else ((pending,) if 'day_values_pending' in sql else (0,)))))
                    return type('R', (), {'fetchone': lambda self: value})()
            @contextlib.contextmanager
            def session(cfg): yield Conn()
            @contextlib.contextmanager
            def transaction(conn): yield conn
            with self.subTest(failure=failure, pending=pending, unprocessed=unprocessed), patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run') as collect_run, patch.object(runtime.normalize, '_work_set', return_value=unprocessed):
                with self.assertRaises(runtime.ScheduledCollectIncomplete): runtime.run(self.scheduled(), port_factory=lambda *a, **kw: None)
                self.assertTrue(collect_run.call_args.kwargs['retry_normalize_failed'])
            failure = pending = False
            with patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run'), patch.object(runtime.normalize, '_work_set', return_value=[]):
                self.assertEqual(json.loads(runtime.run(self.scheduled(), port_factory=lambda *a, **kw: None))['status'], 'success')

    def test_noop_retry_resumes_only_own_recorded_success(self):
        class Conn:
            prior = (5, 'success')
            def execute(self, sql, args):
                if "key='collect_backlog'" in sql:
                    return type('R', (), {'fetchone':lambda self:None})()
                if 'collect_work_runs w join' in sql:
                    self.args = args
                    value = self.prior
                else:
                    value = ('UTC',) if 'timezone' in sql else ((5,) if 'max(id)' in sql else (None if 'select id, status' in sql else (0,)))
                return type('R', (), {'fetchone': lambda self: value})()
        conn=Conn()
        @contextlib.contextmanager
        def session(cfg): yield conn
        @contextlib.contextmanager
        def transaction(value): yield value
        with patch.object(store, 'write_session', session), patch.object(store, 'transaction', transaction), patch.object(runtime.collect, 'run'), patch.object(runtime.normalize, '_work_set', return_value=[]):
            self.assertEqual(json.loads(runtime.run(self.scheduled(), port_factory=lambda *a, **kw: None))['status'], 'success')
            self.assertEqual(conn.args, (UUID(WORK), UUID(USER), UUID(CONNECTION), '2026-01-02'))
            conn.prior = None
            with self.assertRaises(runtime.ScheduledCollectIncomplete): runtime.run(self.scheduled(), port_factory=lambda *a, **kw: None)

    def test_invalid_envelope_fails_before_external_or_db(self):
        invalid = [
            {'BRAIN_RANGE_TO': '2026-01-03'},
            {'BRAIN_OCCURRENCES': '[]'},
            {'BRAIN_OCCURRENCES': '["2026-01-02T02:00:00.000+00:00","2026-01-03T02:00:00.000+00:00"]'},
            {'BRAIN_OCCURRENCES': '["2026-01-02T02:00:00"]'},
        ]
        for change in invalid:
            env = self.scheduled(); env.update(change)
            with self.subTest(change=change), patch.object(store, 'write_session') as session:
                with self.assertRaises(runtime.InvalidCollectInput): runtime.run(env)
                session.assert_not_called()
        env = self.scheduled(); del env['BRAIN_RANGE_FROM']
        with self.assertRaises(runtime.InvalidCollectInput): runtime.run(env)

    def test_entry_reports_incomplete_as_retryable(self):
        import collect as entry
        import io
        from contextlib import redirect_stdout
        out=io.StringIO()
        with patch.object(runtime,'run',side_effect=runtime.ScheduledCollectIncomplete('private')), redirect_stdout(out):
            self.assertEqual(entry.main(),1)
        self.assertEqual(json.loads(out.getvalue()),{'abi':1,'type':'error','code':'COLLECT_INCOMPLETE','retryable':True})
