"""분석 없는 manual의 날짜·계정·기존 평가 선택 계약."""
import contextlib
import json
import unittest
from datetime import date
from unittest.mock import patch

import report_runtime as runtime
from garmin_pipeline import report, store
from test_report_runtime import report_env, setting
from test_collect_runtime import CONNECTION


class ReportSendTest(unittest.TestCase):
    def env(self, target='default'):
        env = report_env('garmin.report_send')
        env['BRAIN_TARGET_ID'] = target
        setting(env, 'garmin.connection_id', CONNECTION)
        snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
        del snapshot['values']['garmin.analysis_model']
        env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)
        return env

    def test_default_and_explicit_date_never_analyze_or_publish(self):
        for target, expected in [('default', date(2026, 11, 11)), ('2026-01-02', date(2026, 1, 2))]:
            with self.subTest(target=target), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(store, 'supervised_account', return_value=contextlib.nullcontext()))
                stack.enter_context(patch.object(store, 'report_session', return_value=contextlib.nullcontext()))
                stack.enter_context(patch.object(store, 'write_session', return_value=contextlib.nullcontext(object())))
                validation = stack.enter_context(patch.object(runtime, 'validate_account'))
                stack.enter_context(patch('garmin_pipeline.dates.today', return_value=date(2026, 11, 11)))
                revisions = {'day': 1, '7d': 2, '30d': 3, 'all': 4}
                select = stack.enter_context(patch.object(report, '_work_revisions', return_value=revisions))
                send = stack.enter_context(patch('report_channel.success', return_value='synthetic-request'))
                analyze = stack.enter_context(patch.object(report, 'run_supervised', side_effect=AssertionError('analysis forbidden')))
                writer = stack.enter_context(patch.object(report, 'CodexWriter', side_effect=AssertionError('writer forbidden')))
                publish = stack.enter_context(patch('report_publish.publish_and_wait', side_effect=AssertionError('publication forbidden')))
                skills = stack.enter_context(patch.object(runtime, 'install_skills'))
                env = self.env(target)
                result = json.loads(runtime.run(env))
                self.assertEqual(result, {'status': 'queued', 'request_id': 'synthetic-request'})
                self.assertEqual(str(validation.call_args.args[1].connection_id), CONNECTION)
                self.assertEqual(select.call_args.args[1:], (expected, False))
                self.assertEqual(send.call_args.args[1:], (expected, revisions, None, env))
                analyze.assert_not_called(); writer.assert_not_called(); publish.assert_not_called(); skills.assert_not_called()

    def test_bad_date_or_connection_never_opens_store(self):
        for value in ('2026-02-30', '20260102', CONNECTION, '2026-1-2'):
            with self.subTest(value=value), patch.object(store, 'report_session') as session:
                with self.assertRaises(runtime.InvalidReportInput): runtime.run(self.env(value))
                session.assert_not_called()
        env = self.env(); setting(env, 'garmin.connection_id', 'invalid')
        with patch.object(store, 'report_session') as session:
            with self.assertRaises(runtime.InvalidReportInput): runtime.run(env)
            session.assert_not_called()

    def test_incomplete_saved_evaluations_fail_without_send(self):
        with contextlib.ExitStack() as stack:
            stack.enter_context(patch.object(store, 'supervised_account', return_value=contextlib.nullcontext()))
            stack.enter_context(patch.object(store, 'report_session', return_value=contextlib.nullcontext()))
            stack.enter_context(patch.object(store, 'write_session', return_value=contextlib.nullcontext(object())))
            stack.enter_context(patch.object(runtime, 'validate_account'))
            stack.enter_context(patch.object(report, '_work_revisions', return_value={'day': 1}))
            send = stack.enter_context(patch('report_channel.success'))
            with self.assertRaises(runtime.InvalidReportInput): runtime.run(self.env())
            send.assert_not_called()
