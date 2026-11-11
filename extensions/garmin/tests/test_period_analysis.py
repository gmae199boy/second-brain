"""수동 기간 분석의 입력·실패·재시도·완료 후 발신 계약."""
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
             patch.object(runtime,'_analyze') as analyze, patch.object(runtime,'_send') as send:
            result=json.loads(runtime.run(env))
            self.assertEqual(result['revision'],2)
            analyze.assert_not_called(); send.assert_called_once_with(unittest.mock.ANY,saved,env)
            send.reset_mock()
            runtime.run(env); send.assert_called_once_with(unittest.mock.ANY,saved,env)
            send.reset_mock(); lookup.return_value=None
            analyze.side_effect=runtime.report.SupervisedReportFailed('synthetic')
            with self.assertRaises(runtime.report.SupervisedReportFailed): runtime.run(env)
            send.assert_not_called()

    def test_other_work_kind_is_rejected(self):
        with self.assertRaises(runtime.InvalidReportInput): runtime.run(report_env())
