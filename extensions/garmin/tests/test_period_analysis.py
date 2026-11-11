"""수동 기간 분석의 입력·실패·재시도·완료 후 결과 이벤트 계약."""
import contextlib
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import period_analysis_runtime as runtime
from test_report_runtime import report_env


class PeriodInputTest(unittest.TestCase):
    def test_valid_inclusive_single_day_and_focus(self):
        value = {'start_date': '2024-02-29', 'end_date': '2024-02-29'}
        self.assertEqual(runtime.validate_input(value), value)
        runtime.validate_input({**value, 'metric': 'steps', 'aggregation': 'sum', 'exercise': 'squat'})

    def test_invalid_dates_ranges_focus_send_and_extra_fields(self):
        valid = {'start_date': '2026-01-01', 'end_date': '2026-01-31'}
        for changes in ({'start_date': '2026-02-30'}, {'start_date': '2026-02-01'},
                        {'start_date': '20260101'}, {'end_date': None}, {'send': 1}, {'send': True}, {'send': False},
                        {'metric': 'unknown'}, {'metric': []}, {'aggregation': 'sum'},
                        {'metric': 'weight_kg', 'aggregation': 'sum'}, {'exercise': ''},
                        {'activity_type': ' '}, {'extra': 1}):
            with self.subTest(changes=changes), self.assertRaises(runtime.InvalidReportInput):
                runtime.validate_input({**valid, **changes})

    def test_completed_saved_retry_always_sends_without_invoking_model(self):
        env = report_env('garmin.period_analysis')
        conn = MagicMock()
        conn.execute.return_value.fetchone.return_value = {'start_date':'2026-01-01','end_date':'2026-01-31'} ,
        saved = ('2026-01-01','2026-01-31',2,'summary')
        with patch.object(runtime.store,'report_session',return_value=contextlib.nullcontext()), \
             patch.object(runtime.store,'write_session',return_value=contextlib.nullcontext(conn)), \
             patch.object(runtime.store,'transaction',return_value=contextlib.nullcontext()), \
             patch.object(runtime.report_runtime,'validate_account'), \
             patch.object(runtime,'_saved',return_value=saved) as lookup, \
             patch.object(runtime.report_runtime,'install_skills'), \
             patch.object(runtime.report, 'codex_executable', return_value='/synthetic/configured-codex') as executable, \
             patch.object(runtime.report, 'CodexWriter') as writer, \
             patch.object(runtime,'_analyze') as analyze, patch.object(runtime,'_emit') as send:
            result=json.loads(runtime.run(env))
            self.assertEqual(result['revision'],2)
            analyze.assert_not_called(); send.assert_called_once_with(unittest.mock.ANY,saved,env)
            send.reset_mock()
            runtime.run(env); send.assert_called_once_with(unittest.mock.ANY,saved,env)
            send.reset_mock(); lookup.return_value=None
            analyze.side_effect=runtime.report.SupervisedReportFailed('synthetic')
            with self.assertRaises(runtime.report.SupervisedReportFailed): runtime.run(env)
            send.assert_not_called()
            executable.assert_called_once_with(env)
            writer.assert_called_once_with(executable='/synthetic/configured-codex')

    def test_other_work_kind_is_rejected(self):
        with self.assertRaises(runtime.InvalidReportInput): runtime.run(report_env())

    def test_period_send_publishes_saved_document_and_attaches_it_once(self):
        from uuid import UUID
        import report_publish
        conn = MagicMock(); conn.user_id = UUID(int=1); conn.connection_id = UUID(int=2)
        events = {}
        published = []
        def execute(sql, args):
            cursor = MagicMock()
            if 'select report_md' in sql: cursor.fetchone.return_value = ('full period report', 1767225600000)
            elif 'select summary' in sql: cursor.fetchone.return_value = ('summary', [], [], None)
            elif 'extension_event_emit' in sql:
                self.assertTrue(published)
                cursor.fetchone.return_value = (events.setdefault((args[2], args[3]), UUID(int=100 + len(events))),)
            return cursor
        conn.execute.side_effect = execute
        saved = ('2026-01-01', '2026-01-31', 2, 'summary')
        with patch.object(runtime.store, 'write_session', return_value=contextlib.nullcontext(conn)), \
             patch.object(runtime.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()), \
             patch.object(runtime.report, '_assert_attempt_current'), \
             patch.object(report_publish, 'publish_send_copy', side_effect=lambda *a: published.append('done') or UUID(int=10)) as publish:
            first_id = runtime._emit(None, saved, report_env('garmin.period_analysis'))
            first = next(call.args[1] for call in conn.execute.call_args_list if 'extension_event_emit' in call.args[0])
            conn.execute.reset_mock()
            runtime._emit(None, saved, report_env('garmin.period_analysis'))
            second = next(call.args[1] for call in conn.execute.call_args_list if 'extension_event_emit' in call.args[0])
            self.assertEqual(len(events), 1)
            self.assertEqual(first_id, next(iter(events.values())))
            with patch.object(runtime.report_message, 'FORMAT_VERSION', 'report-v2'):
                runtime._emit(None, saved, report_env('garmin.period_analysis'))
            runtime._emit(None, (*saved[:2], 3, saved[3]), report_env('garmin.period_analysis'))
            self.assertEqual(len(events), 3)
        self.assertEqual(first, second)
        self.assertEqual(first[2], 'garmin.period_report.completed')
        self.assertEqual(first[4:6], ('2026-01-31', '2'))
        self.assertEqual(len(first), 9)
        self.assertEqual(first[7:9], (UUID(int=10), '[]'))
        self.assertEqual(publish.call_args.args[3], b'full period report')
