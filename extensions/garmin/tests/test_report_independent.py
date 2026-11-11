"""수집 상태·시각과 독립된 분석과 연속 운동 창 수락 계약."""
import contextlib
import unittest
from datetime import date, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import patch
from zoneinfo import ZoneInfo

from garmin_pipeline import report, report_input, store
from test_report_input_pg import FakeConnection, Result
from test_report_runtime import report_env
import report_runtime


class IndependentTest(unittest.TestCase):
    def test_legacy_report_and_regenerate_reach_inputs_without_collect_observation(self):
        _, cfg = report_runtime.envelope(report_env())
        class ReachedInput(Exception): pass
        for regenerate in (False, True):
            with self.subTest(regenerate=regenerate), contextlib.ExitStack() as stack:
                stack.enter_context(patch.object(store, 'report_session', return_value=contextlib.nullcontext()))
                stack.enter_context(patch.object(report, '_today_evaluation', return_value=None))
                read = stack.enter_context(patch.object(store, 'read_connection', side_effect=AssertionError('수집 상태 관측 금지')))
                sleep = stack.enter_context(patch.object(report.time, 'sleep', side_effect=AssertionError('수집 대기 금지')))
                stack.enter_context(patch.object(report, '_pending_inputs', side_effect=ReachedInput))
                with self.assertRaises(ReachedInput): report.run(cfg, object(), regenerate=regenerate)
                read.assert_not_called(); sleep.assert_not_called()

    def test_running_failed_or_missing_collect_does_not_replace_snapshot_cutoff(self):
        cfg = SimpleNamespace(timezone='UTC')
        started = int(datetime(2026, 1, 2, 17, tzinfo=ZoneInfo('UTC')).timestamp() * 1000)
        for status in ('running', 'failed', 'not_run'):
            conn = FakeConnection()
            original = conn.execute
            def execute(sql, params=()):
                if 'FROM garmin.run' in sql:
                    return Result([] if status == 'not_run' else [(started - 3600000, status, 'synthetic', None)])
                return original(sql, params)
            conn.execute = execute
            with self.subTest(status=status), patch.object(store, 'read_connection', return_value=conn):
                result = report_input._snapshot(cfg, date(2026, 1, 2), started, [])
                self.assertEqual(result[3], started)
                self.assertEqual(result[5]['status'], status)
                self.assertEqual(result[4], report_input.workout_window(date(2026, 1, 2), 'UTC')[0])

    def test_adjacent_calendar_windows_cover_midnight_and_dst_without_overlap(self):
        for zone in ('UTC', 'Asia/Seoul', 'America/New_York'):
            for day in (date(2026, 3, 9), date(2026, 11, 2)):
                start, end = report_input.workout_window(day, zone)
                next_start, next_end = report_input.workout_window(day + timedelta(days=1), zone)
                self.assertEqual(end, next_start)
                for completed in (start, end - 1, end, next_end - 1):
                    self.assertEqual(sum(low <= completed < high for low, high in ((start, end), (next_start, next_end))), 1)

    def test_overnight_workout_belongs_once_to_completion_date(self):
        def epoch(day, hour):
            return int(datetime(2026, 1, day, hour, tzinfo=ZoneInfo('UTC')).timestamp() * 1000)
        conn = FakeConnection(); original = conn.execute
        activities = [('overnight', epoch(1, 23), 7200), ('before', epoch(1, 12), 1800)]
        def execute(sql, params=()):
            if 'SELECT activity_id, start_ms, duration_s' in sql: return Result(activities)
            return original(sql, params)
        conn.execute = execute
        # 실제 activity ID 계약은 숫자다.
        activities[:] = [('1', epoch(1, 23), 7200), ('2', epoch(1, 12), 1800)]
        with patch.object(store, 'read_connection', return_value=conn):
            first = report_input._snapshot(SimpleNamespace(timezone='UTC'), date(2026, 1, 2), epoch(2, 2), [])
            second = report_input._snapshot(SimpleNamespace(timezone='UTC'), date(2026, 1, 3), epoch(3, 2), [])
        self.assertEqual(first[2], ['2'])
        self.assertEqual(second[2], ['1'])

    def test_fractional_duration_keeps_true_midnight_and_cutoff_boundary(self):
        from datetime import UTC
        start = datetime(2026, 1, 1, 23, 59, tzinfo=UTC)
        raw = {'activity': {'summaryDTO': {'startTimeGMT': start.isoformat(), 'duration': 59.6}}}
        completed = report_input.activity_completion(raw, int(start.timestamp() * 1000), 60)
        midnight = datetime(2026, 1, 2, tzinfo=UTC)
        self.assertEqual(completed, midnight.timestamp() * 1000 - 400)
        self.assertLess(completed, midnight.timestamp() * 1000)
        raw['activity']['summaryDTO']['duration'] = 60.001
        self.assertGreater(report_input.activity_completion(raw, int(start.timestamp() * 1000), 60), midnight.timestamp() * 1000)

    def test_preserved_int64_extremes_use_existing_sqlite_overflow_contract(self):
        self.assertEqual(report_input.activity_completion({}, -9223370269499575908, 9223372036854776), 1767355199488)
        self.assertEqual(report_input.activity_completion({}, -9223372036854775808, 9223372036854775), -808)
        self.assertLess(report_input.activity_completion({}, 0, -9223372036854775808), 0)
