"""Supervised analysis ordering and fencing contracts; run in 21.8."""
import contextlib
import io
import json
import sys
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import report_runtime
from garmin_pipeline import errors, report, store
from test_report_runtime import report_env

DAY = date(2026, 1, 2)


class SupervisedReportTest(unittest.TestCase):
    def setUp(self):
        _, self.cfg = report_runtime.envelope(report_env())
        self.rows = {}
        self.calls = []
        self.pending = []
        self.fail = None
        self.leave_pending = False
        self.new_pending = []
        self.stale = False
        test = self
        class Writer:
            def intake(self, cfg, inputs):
                test.calls.append('intake')
                if test.fail != 'intake' and not test.leave_pending:
                    test.pending = [item for item in test.pending if item not in inputs] + test.new_pending
                return {'status': 'failed' if test.fail == 'intake' else 'ok', 'detail': 'synthetic'}
            def write(self, cfg, inputs): return self.analysis('day')
            def period(self, cfg, inputs, scope): return self.analysis(scope)
            def analysis(self, scope):
                test.calls.append(scope)
                if test.fail == scope:
                    raise report.WriterFailed(errors.ReportFailReason.CODEX_FAILED)
                return report.DailyAnalysis('ok', 'synthetic', 'summary', [], [], [])
        self.writer = Writer()
        self.exported = SimpleNamespace(path=self.cfg.data_dir / 'report-input' / 'day',
            manifest={}, days={}, activities={}, labels={}, body=[])
        self.completed_scopes = report._completed_scopes
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.work_rows = {}
        self.stack.enter_context(patch.object(report, '_work_revisions', side_effect=lambda cfg, day, regenerate: dict(self.work_rows) if regenerate else {k: len(v) for k, v in self.rows.items()}))
        self.stack.enter_context(patch.object(report, '_read_work_revisions', side_effect=lambda cfg, day: {k: len(v) for k, v in self.rows.items()}))
        self.stack.enter_context(patch('report_publish.publish_and_wait'))
        self.stack.enter_context(patch('report_channel.success'))
        self.stack.enter_context(patch.object(report.body, 'pending', side_effect=lambda cfg: list(self.pending)))
        self.stack.enter_context(patch.object(report.report_input, 'build', return_value=self.exported))
        self.stack.enter_context(patch.object(report.report_input, 'build_period', side_effect=lambda cfg, folder, day, scope: folder / scope))
        self.stack.enter_context(patch.object(report.report_input, 'write_json'))
        self.stack.enter_context(patch.object(report.digest, 'build', return_value={}))
        def save(cfg, day, scope, result):
            if self.stale: raise store.StaleAttempt('stale')
            self.calls.append('saved:' + scope)
            self.rows.setdefault(scope, []).append(result.report_md)
            self.work_rows[scope] = len(self.rows[scope])
        self.stack.enter_context(patch.object(report, '_save_evaluation', side_effect=save))
        self.stack.enter_context(patch.object(report, '_assert_attempt_current', side_effect=lambda cfg: None))

    def run_report(self, regenerate=False):
        if regenerate: self.work_rows = {}
        return report.run_supervised(self.cfg, self.writer, regenerate=regenerate, today=DAY)

    def test_order_immediate_append_then_resume_missing_scopes(self):
        self.fail = '30d'
        with self.assertRaises(report.SupervisedReportFailed): self.run_report()
        self.assertEqual(self.calls, ['day', 'saved:day', '7d', 'saved:7d', '30d', 'all', 'saved:all'])
        self.fail = None; self.calls.clear()
        self.assertEqual(self.run_report(), {'status': 'success', 'scopes': 1})
        self.assertEqual(self.calls, ['30d', 'saved:30d'])

    def test_complete_skip_and_explicit_regenerate_append(self):
        self.run_report(); first = {k: list(v) for k, v in self.rows.items()}; self.calls.clear()
        self.assertEqual(self.run_report(), {'status': 'noop', 'scopes': 0})
        self.assertEqual(self.calls, [])
        self.run_report(regenerate=True)
        for scope, old in first.items():
            self.assertEqual(self.rows[scope][:1], old)
            self.assertEqual(len(self.rows[scope]), 2)

    def test_failed_regenerate_preserves_previous_revisions(self):
        self.run_report(); before = {k: list(v) for k, v in self.rows.items()}
        self.fail = 'day'
        with self.assertRaises(report.SupervisedReportFailed): self.run_report(regenerate=True)
        self.assertEqual(self.rows['day'], before['day'])
        for scope in ('7d', '30d', 'all'):
            self.assertEqual(self.rows[scope][:1], before[scope])
            self.assertEqual(len(self.rows[scope]), 2)

    def test_intake_failure_continues_analysis_and_pending_survives(self):
        self.pending = ['inbox/inbody/input.txt']; self.fail = 'intake'
        with self.assertRaises(report.SupervisedReportFailed): self.run_report()
        self.assertEqual(self.calls, ['intake', 'day', 'saved:day', '7d', 'saved:7d', '30d', 'saved:30d', 'all', 'saved:all'])
        self.assertEqual(self.pending, ['inbox/inbody/input.txt'])
        self.fail = None; self.calls.clear(); self.run_report()
        self.assertEqual(self.calls, [])
        self.run_report(regenerate=True)
        self.assertEqual(self.calls[0], 'intake')

    def test_intake_ok_with_original_pending_is_failure_but_scopes_continue_and_complete_day_skips(self):
        self.pending = ['inbox/inbody/first.txt', 'inbox/inbody/second.txt']
        self.leave_pending = True
        with self.assertRaises(report.SupervisedReportFailed): self.run_report()
        self.assertEqual(self.calls, ['intake', 'day', 'saved:day', '7d', 'saved:7d', '30d', 'saved:30d', 'all', 'saved:all'])
        self.assertEqual(self.pending, ['inbox/inbody/first.txt', 'inbox/inbody/second.txt'])
        self.calls.clear()
        self.assertEqual(self.run_report(), {'status': 'noop', 'scopes': 0})
        self.assertEqual(self.calls, [])
        self.leave_pending = False
        self.run_report(regenerate=True)
        self.assertEqual(self.pending, [])

    def test_only_initial_pending_must_be_handled_including_reject(self):
        self.pending = ['inbox/inbody/rejected.txt']
        self.new_pending = ['inbox/inbody/new-arrival.txt']
        self.assertEqual(self.run_report(), {'status': 'success', 'scopes': 4})
        self.assertEqual(self.pending, ['inbox/inbody/new-arrival.txt'])

    def test_intake_ok_with_some_initial_inputs_remaining_is_failure(self):
        self.pending = ['inbox/inbody/handled.txt', 'inbox/inbody/left.txt']
        def partial(cfg, inputs):
            self.calls.append('intake')
            self.pending = [inputs[1]]
            return {'status': 'ok', 'detail': 'synthetic'}
        with patch.object(self.writer, 'intake', side_effect=partial):
            with self.assertRaises(report.SupervisedReportFailed): self.run_report()
        self.assertEqual(set(self.rows), {'day', '7d', '30d', 'all'})
        self.assertEqual(self.pending, ['inbox/inbody/left.txt'])

    def test_initial_pending_file_error_reports_failure_after_all_scopes_and_skips_complete_day(self):
        with patch.object(report.body, 'pending', side_effect=OSError('synthetic')):
            with self.assertRaises(report.SupervisedReportFailed): self.run_report()
        self.assertEqual(self.calls, ['day', 'saved:day', '7d', 'saved:7d', '30d', 'saved:30d', 'all', 'saved:all'])
        self.calls.clear()
        with patch.object(report.body, 'pending', side_effect=AssertionError('skip must not read')):
            self.assertEqual(self.run_report(), {'status': 'noop', 'scopes': 0})
        self.assertEqual(self.calls, [])

    def test_pending_recheck_file_error_continues_all_scopes(self):
        self.pending = ['inbox/inbody/input.txt']
        with patch.object(report.body, 'pending', side_effect=[list(self.pending), OSError('synthetic')]):
            with self.assertRaises(report.SupervisedReportFailed): self.run_report()
        self.assertEqual(self.calls, ['intake', 'day', 'saved:day', '7d', 'saved:7d', '30d', 'saved:30d', 'all', 'saved:all'])

    def test_period_local_file_error_does_not_stop_later_scopes(self):
        for error in (OSError('synthetic'), json.JSONDecodeError('synthetic', '', 0), UnicodeDecodeError('utf8', b'\xff', 0, 1, 'synthetic')):
            self.rows.clear(); self.calls.clear()
            def build(cfg, folder, day, scope):
                if scope == '7d': raise error
                return folder / scope
            with self.subTest(error=type(error).__name__), patch.object(report.report_input, 'build_period', side_effect=build):
                with self.assertRaises(report.SupervisedReportFailed): self.run_report()
            self.assertEqual(self.calls, ['day', 'saved:day', '30d', 'saved:30d', 'all', 'saved:all'])
            self.calls.clear()
            self.assertEqual(self.run_report(), {'status':'success', 'scopes':1})
            self.assertEqual(self.calls, ['7d', 'saved:7d'])

    def test_period_store_and_cancel_errors_stop_before_later_scopes(self):
        import psycopg
        for error in (store.StaleAttempt('stale'), psycopg.OperationalError('db'), KeyboardInterrupt()):
            self.rows.clear(); self.calls.clear()
            with self.subTest(error=type(error).__name__), patch.object(report.report_input, 'build_period', side_effect=error):
                with self.assertRaises(type(error)): self.run_report()
            self.assertEqual(self.calls, ['day', 'saved:day'])

    def test_pending_store_and_cancel_errors_propagate_initial_and_recheck(self):
        import psycopg
        for error in (store.StaleAttempt('stale'), psycopg.OperationalError('db'), KeyboardInterrupt()):
            for recheck in (False, True):
                self.rows.clear(); self.calls.clear(); self.pending = ['inbox/inbody/input.txt']
                effects = [list(self.pending), error] if recheck else [error]
                with self.subTest(error=type(error).__name__, recheck=recheck), patch.object(report.body, 'pending', side_effect=effects):
                    with self.assertRaises(type(error)): self.run_report()
                self.assertEqual(self.calls, ['intake'] if recheck else [])

    def test_stale_save_stops_and_never_records_success(self):
        self.stale = True
        with self.assertRaises(store.StaleAttempt): self.run_report()
        self.assertEqual(self.rows, {})
        self.assertEqual(self.calls, ['day'])

    def test_revoked_after_failed_scope_stops_before_next_model(self):
        self.fail = 'day'
        checks = iter([None, store.StaleAttempt('stale')])
        def check(cfg):
            result = next(checks)
            if result: raise result
        with patch.object(report, '_assert_attempt_current', side_effect=check):
            with self.assertRaises(store.StaleAttempt): self.run_report()
        self.assertEqual(self.calls, ['day'])
        self.assertEqual(self.rows, {})

    def test_store_failure_from_writer_does_not_become_scope_failure(self):
        with patch.object(self.writer, 'write', side_effect=store.StaleAttempt('stale')):
            with self.assertRaises(store.StaleAttempt): self.run_report()
        self.assertEqual(self.rows, {})

    def test_cancel_during_scope_stops_before_later_models(self):
        with patch.object(self.writer, 'write', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt): self.run_report()
        self.assertEqual(self.rows, {})
        self.assertEqual(self.calls, [])

    def test_latest_scope_snapshot_closes_on_success_and_error(self):
        conn = SimpleNamespace(close=lambda: self.calls.append('closed'))
        with patch.object(store, 'read_connection', return_value=conn), patch.object(store, 'latest_evaluation', side_effect=[('row',), None, None, None]):
            self.assertEqual(self.completed_scopes(self.cfg, DAY), {'day'})
        self.assertEqual(self.calls, ['closed']); self.calls.clear()
        with patch.object(store, 'read_connection', return_value=conn), patch.object(store, 'latest_evaluation', side_effect=RuntimeError('failure')):
            with self.assertRaises(RuntimeError): self.completed_scopes(self.cfg, DAY)
        self.assertEqual(self.calls, ['closed'])


class RuntimeBindingTest(unittest.TestCase):
    def test_invalid_channel_stops_before_model(self):
        env = report_env()
        class Conn:
            def execute(self, sql, args):
                return SimpleNamespace(fetchone=lambda: ('UTC',) if 'account_connections' in sql else (False,))
        scope = lambda *args, **kwargs: contextlib.nullcontext(Conn())
        with patch.object(store, 'supervised_account', scope), patch.object(store, 'report_session', scope), \
             patch.object(store, 'write_session', scope), patch.object(store, 'transaction', scope), \
             patch.object(report, 'run_supervised') as model:
            with self.assertRaises(report_runtime.InvalidReportInput): report_runtime.run(env, writer='fake')
            model.assert_not_called()

    def test_account_and_report_lock_span_model_and_all_appends(self):
        states = []
        @contextlib.contextmanager
        def account_context(account):
            states.append(('account-enter', account.connection_id))
            yield
            states.append(('account-exit', account.connection_id))
        @contextlib.contextmanager
        def report_session(cfg, blocking):
            states.append(('lock-enter', blocking)); yield; states.append(('lock-exit', blocking))
        @contextlib.contextmanager
        def write_session(cfg):
            states.append(('write-enter',)); yield 'conn'; states.append(('write-exit',))
        def validate(conn, account, cfg, conversation): states.append(('validate', conn))
        def analysis(cfg, writer, regenerate):
            states.append(('analysis', regenerate))
            return {'status': 'success', 'scopes': 4}
        env = report_env('garmin.report_regenerate')
        with patch.object(store, 'supervised_account', account_context), patch.object(store, 'report_session', report_session), \
             patch.object(store, 'write_session', write_session), patch.object(report_runtime, 'validate_account', validate), \
             patch.object(report_runtime, 'install_skills', side_effect=lambda cfg: states.append(('skills',))), \
             patch.object(report, 'run_supervised', side_effect=analysis):
            self.assertEqual(json.loads(report_runtime.run(env, writer='fake')), {'status': 'success', 'scopes': 4})
        self.assertEqual([event[0] for event in states], ['account-enter', 'lock-enter', 'write-enter', 'validate', 'write-exit', 'skills', 'analysis', 'lock-exit', 'account-exit'])
        self.assertEqual(states[-3], ('analysis', True))
        self.assertIn(('lock-enter', False), states)

    def test_regenerate_busy_fails_without_waiting_or_running_model(self):
        calls = []
        @contextlib.contextmanager
        def report_session(cfg, blocking):
            calls.append(blocking)
            raise store.ReportLockBusy('busy')
            yield
        with patch.object(store, 'report_session', report_session), patch.object(report, 'run_supervised') as run:
            with self.assertRaises(store.ReportLockBusy):
                report_runtime.run(report_env('garmin.report_regenerate'), writer='fake')
            run.assert_not_called()
        self.assertEqual(calls, [False])

    def test_normal_report_uses_blocking_lock(self):
        calls = []
        @contextlib.contextmanager
        def report_session(cfg, blocking):
            calls.append(blocking)
            raise store.ReportLockBusy('synthetic')
            yield
        with patch.object(store, 'report_session', report_session):
            with self.assertRaises(store.ReportLockBusy): report_runtime.run(report_env(), writer='fake')
        self.assertEqual(calls, [True])

    def test_entry_emits_one_safe_event(self):
        import report as entry
        for error, code in [(report_runtime.InvalidReportInput('private'), 'REPORT_INVALID'),
                            (store.StaleAttempt('private'), 'REPORT_STALE'),
                            (report.SupervisedReportFailed('private'), 'REPORT_FAILED')]:
            out = io.StringIO()
            with patch.object(report_runtime, 'run', side_effect=error), contextlib.redirect_stdout(out):
                self.assertEqual(entry.main(), 1)
            self.assertEqual(json.loads(out.getvalue())['code'], code)
            self.assertNotIn('private', out.getvalue())

    def test_report_lock_serializes_same_account_not_different_accounts(self):
        import threading
        from uuid import UUID
        from test_collect_runtime import USER, CONNECTION, WORK, TOKEN
        lock_map = {UUID(CONNECTION): threading.Lock(), UUID('00000000-0000-4000-8000-000000000099'): threading.Lock()}
        first_inside = threading.Event(); release = threading.Event()
        same_inside = threading.Event(); other_inside = threading.Event()
        errors_seen = []
        class Conn:
            def __init__(self): self.lock = lock_map[store._account_context.get().connection_id]
            def close(self): self.lock.release()
        def worker(connection, inside, wait=False):
            try:
                account = store.AccountContext(UUID(USER), connection, UUID(WORK), UUID(TOKEN))
                with store.supervised_account(account), store.report_session(None, blocking=True):
                    inside.set()
                    if wait: release.wait(2)
            except BaseException as error: errors_seen.append(error)
        with patch.object(store, '_connect', side_effect=lambda **kwargs: Conn()), \
             patch.object(store, '_acquire', side_effect=lambda conn, *args, **kwargs: conn.lock.acquire()):
            threads = [threading.Thread(target=worker, args=(UUID(CONNECTION), first_inside, True)),
                       threading.Thread(target=worker, args=(UUID(CONNECTION), same_inside)),
                       threading.Thread(target=worker, args=(UUID('00000000-0000-4000-8000-000000000099'), other_inside))]
            try:
                threads[0].start(); self.assertTrue(first_inside.wait(1))
                threads[1].start(); threads[2].start()
                self.assertTrue(other_inside.wait(1)); self.assertFalse(same_inside.is_set())
            finally:
                release.set()
                for thread in threads:
                    if thread.ident is not None: thread.join(2)
            self.assertTrue(same_inside.is_set()); self.assertEqual(errors_seen, [])

class ScheduledReportTest(unittest.TestCase):
    def test_supervisor_date_is_used_and_invalid_never_starts(self):
        env=report_env(); env.update(BRAIN_OCCURRENCES='["2026-01-02T02:00:00.000+00:00"]',BRAIN_RANGE_FROM='2026-01-02',BRAIN_RANGE_TO='2026-01-02')
        @contextlib.contextmanager
        def scope(*args, **kwargs): yield 'conn'
        with patch.object(store,'supervised_account',scope), patch.object(store,'report_session',scope), patch.object(store,'write_session',scope), patch.object(report_runtime,'validate_account'), patch.object(report_runtime,'install_skills'), patch.object(report,'run_supervised',return_value={'status':'success','scopes':4}) as run:
            report_runtime.run(env,writer='fake')
            self.assertEqual(run.call_args.kwargs['today'],date(2026,1,2))
        env['BRAIN_RANGE_TO']='2026-01-03'
        with patch.object(store,'report_session') as session:
            with self.assertRaises(report_runtime.InvalidReportInput): report_runtime.run(env,writer='fake')
            session.assert_not_called()
