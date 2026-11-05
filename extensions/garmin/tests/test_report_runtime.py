"""Supervised report configuration contracts; execution deferred to 21.8."""
import contextlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import collect_runtime
import report_runtime as runtime
from garmin_pipeline import store
from test_collect_runtime import environment, USER, CONNECTION, WORK, TOKEN


def report_env(kind='garmin.report'):
    env = environment()
    env['BRAIN_WORK_KIND'] = kind
    setting(env, 'garmin.analysis_model', 'synthetic-model')
    return env


def setting(env, key, value):
    snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
    snapshot['values'][key] = value
    env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)


class ReportEnvelopeTest(unittest.TestCase):
    def test_kinds_defaults_and_account_scoped_config(self):
        for kind in ('garmin.report', 'garmin.report_regenerate'):
            account, cfg = runtime.envelope(report_env(kind))
            self.assertEqual(account, store.AccountContext(UUID(USER), UUID(CONNECTION), UUID(WORK), UUID(TOKEN)))
            self.assertEqual((cfg.report_model, cfg.report_reasoning_effort, cfg.report_codex_timeout_minutes), ('synthetic-model', 'high', 20))
            self.assertEqual(cfg.path.parent, Path('/synthetic/extension/reports/accounts') / USER / CONNECTION)
            self.assertEqual(cfg.timezone, 'UTC')

    def test_missing_model_is_rejected_before_report_execution_for_both_kinds(self):
        for kind in ('garmin.report', 'garmin.report_regenerate'):
            with self.subTest(kind=kind):
                env = report_env(kind)
                snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
                del snapshot['values']['garmin.analysis_model']
                env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)
                with patch.object(store, 'report_session') as session:
                    with self.assertRaises(runtime.InvalidReportInput):
                        runtime.run(env, writer='fake')
                    session.assert_not_called()
                env['BRAIN_WORK_KIND'] = 'garmin.collect'
                collect_runtime.envelope(env)

    def test_manifest_requires_model_for_both_report_kinds(self):
        manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
        for kind in ('garmin.report', 'garmin.report_regenerate'):
            declaration = next(item for item in manifest['work'] if item['kind'] == kind)
            self.assertIn('garmin.analysis_model', declaration['required_settings'])
            self.assertIn('garmin.timezone', declaration['required_settings'])

    def test_typed_settings_and_collect_coexist(self):
        env = report_env()
        for key, value in [('garmin.analysis_agent', 'codex'), ('garmin.analysis_model', 'example-model'),
                           ('garmin.analysis_reasoning_effort', 'medium'), ('garmin.analysis_timeout_minutes', 45)]:
            setting(env, key, value)
        _, cfg = runtime.envelope(env)
        self.assertEqual((cfg.report_model, cfg.report_reasoning_effort, cfg.report_codex_timeout_minutes), ('example-model', 'medium', 45))
        env['BRAIN_WORK_KIND'] = 'garmin.collect'
        collect_runtime.envelope(env)

    def test_invalid_settings_fail_closed(self):
        for key, value in [('garmin.analysis_agent', 'other'), ('garmin.analysis_model', ''),
                           ('garmin.analysis_reasoning_effort', 'invalid'), ('garmin.analysis_timeout_minutes', True),
                           ('garmin.analysis_timeout_minutes', 0), ('garmin.analysis_timeout_minutes', 1.5),
                           ('garmin.analysis_timeout_minutes', '20'), ('garmin.unknown', 'x'), ('garmin.timezone', 'invalid/timezone')]:
            with self.subTest(key=key, value=value):
                env = report_env(); setting(env, key, value)
                with self.assertRaises(runtime.InvalidReportInput): runtime.envelope(env)

    def test_invalid_envelope_and_snapshot_are_rejected(self):
        for key, value in [('BRAIN_TARGET_ID', 'default'), ('BRAIN_USER_ID', 'bad'),
                           ('BRAIN_ATTEMPT_TOKEN', 'bad'), ('BRAIN_WORK_ID', 'bad'),
                           ('BRAIN_WORK_KIND', 'garmin.collect'), ('BRAIN_RUN_GENERATION', '0'),
                           ('BRAIN_EXTENSION_HOME', 'relative')]:
            with self.subTest(key=key):
                env = report_env(); env[key] = value
                with self.assertRaises(runtime.InvalidReportInput): runtime.envelope(env)
        env = report_env(); snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT']); snapshot['user_id'] = CONNECTION
        env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)
        with self.assertRaises(runtime.InvalidReportInput): runtime.envelope(env)
        env['BRAIN_SETTINGS_SNAPSHOT'] = '{"version":1,"version":1}'
        with self.assertRaises(runtime.InvalidReportInput): runtime.envelope(env)

    def test_selected_account_and_timezone_are_checked_in_fenced_transaction(self):
        account, cfg = runtime.envelope(report_env())
        class Conn:
            row = ('UTC',)
            def execute(self, sql, args):
                self.args = args
                return type('Result', (), {'fetchone': lambda _: self.row})()
        conn = Conn(); entered = []
        @contextlib.contextmanager
        def transaction(c):
            entered.append(c)
            yield c
        with patch.object(store, 'transaction', transaction):
            runtime.validate_account(conn, account, cfg)
            self.assertEqual(conn.args, (UUID(USER), UUID(CONNECTION)))
            self.assertEqual(entered, [conn])
            for row in (None, ('Asia/Seoul',)):
                conn.row = row
                with self.assertRaises(runtime.InvalidReportInput): runtime.validate_account(conn, account, cfg)
