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

    def test_default_and_explicit_date_reuse_attachments_without_analysis(self):
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
                publish = stack.enter_context(patch('report_publish.saved_send_attachments', return_value=('document', [('01.png', 'graph', 'photo')], 'published')))
                skills = stack.enter_context(patch.object(runtime, 'install_skills'))
                env = self.env(target)
                result = json.loads(runtime.run(env))
                self.assertEqual(result, {'status': 'recorded', 'event_id': 'synthetic-request', 'attachments': 'published', 'attachment_reason': None})
                self.assertEqual(str(validation.call_args.args[1].connection_id), CONNECTION)
                self.assertEqual(select.call_args.args[1:], (expected, False))
                send.assert_called_once()
                self.assertEqual(send.call_args.args[1:], (expected, revisions, 'document', env))
                self.assertEqual(send.call_args.kwargs['attachment_rows'], [('01.png', 'graph', 'photo')])
                publish.assert_called_once_with(unittest.mock.ANY, expected, revisions, env)
                analyze.assert_not_called(); writer.assert_not_called(); skills.assert_not_called()

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

    def test_render_unavailable_is_explicit_but_pending_is_retryable(self):
        from garmin_pipeline import charts
        import report_publish
        for error, fallback in ((report_publish.RenderUnavailable(), True),
                                (OSError('staging failed'), False),
                                (report_publish.FilesPending(), False), (report_publish.FilesFailed(), False)):
            with self.subTest(error=type(error).__name__), contextlib.ExitStack() as stack:
                for name in ('supervised_account', 'report_session', 'write_session'):
                    stack.enter_context(patch.object(store, name, return_value=contextlib.nullcontext(object())))
                stack.enter_context(patch.object(runtime, 'validate_account'))
                stack.enter_context(patch.object(report, '_work_revisions', return_value={'day':1,'7d':1,'30d':1,'all':1}))
                stack.enter_context(patch('report_publish.saved_send_attachments', side_effect=error))
                send = stack.enter_context(patch('report_channel.success', return_value='request'))
                if fallback:
                    result = json.loads(runtime.run(self.env('2026-01-02')))
                    self.assertEqual(result['attachment_reason'], 'artifact_render_unavailable')
                    self.assertEqual(send.call_args.kwargs['missing_reason'], result['attachment_reason'])
                else:
                    with self.assertRaises(type(error)): runtime.run(self.env('2026-01-02'))
                    send.assert_not_called()
