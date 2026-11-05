import unittest
from uuid import UUID

import query

USER = UUID('00000000-0000-4000-8000-000000000001')
ACCOUNT = UUID('00000000-0000-4000-8000-000000000002')
BASE = {'connection_id': str(ACCOUNT), 'timezone': 'Asia/Seoul', 'start_date': '2026-01-01', 'end_date': '2026-01-03', 'metric': 'steps'}


class Result:
    def __init__(self, rows): self.rows = rows
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows


class Connection:
    def __init__(self, rows, zone='Asia/Seoul'): self.rows, self.zone, self.calls = rows, zone, []
    def execute(self, sql, params):
        self.calls.append((sql, params))
        return Result([(self.zone,)] if 'account_connections' in sql else self.rows)


class QueryTest(unittest.TestCase):
    def test_nulls_sum_mean_and_empty(self):
        for mode, expected in [('sum', 40), ('mean', 20)]:
            conn = Connection([('2026-01-01', 10), ('2026-01-02', None), ('2026-01-03', 30)])
            result = query.execute(conn, USER, 'period-summary', {**BASE, 'aggregation': mode})
            self.assertEqual((result['value'], result['observed_count'], result['null_count']), (expected, 2, 1))
            self.assertEqual(conn.calls[1][1][:2], [USER, ACCOUNT])
        for rows, nulls in [([], 0), ([('2026-01-01', None)], 1)]:
            result = query.execute(Connection(rows), USER, 'period-summary', {**BASE, 'aggregation': 'sum'})
            self.assertEqual((result['value'], result['observed_count'], result['null_count']), (None, 0, nulls))

    def test_filters_parameterized_and_self_scoped(self):
        for metric in ('steps', 'workout.duration_s', 'exercise.reps', 'set.reps'):
            conn = Connection([])
            query.execute(conn, USER, 'daily-values', {**BASE, 'metric': metric, 'activity_type': 'strength', 'exercise': 'squat'})
            sql, args = conn.calls[-1]
            self.assertNotIn('squat', sql)
            self.assertIn('squat', args)
            self.assertEqual(args[:2], [USER, ACCOUNT])
            self.assertIn('connection_id', sql)

    def test_invalid_conditions_and_nonfinite_are_rejected(self):
        for change in ({'metric':'steps;drop table x'}, {'timezone':'No/Such_Zone'}, {'start_date':'2026-02-30'}, {'exercise':''}, {'unexpected':1}):
            with self.subTest(change=change), self.assertRaises(Exception): query.execute(Connection([]), USER, 'daily-values', {**BASE, **change})
        with self.assertRaises(ValueError): query.execute(Connection([]), USER, 'period-summary', {**BASE, 'metric':'weight_kg', 'aggregation':'sum'})
        with self.assertRaises(ValueError): query.execute(Connection([], 'UTC'), USER, 'daily-values', BASE)
        with self.assertRaises(ValueError): query.execute(Connection([('2026-01-01', float('nan'))]), USER, 'daily-values', BASE)

    def test_recent_latest_and_file_id(self):
        conn = Connection([('2026-01-03', 'day', 'synthetic summary', ACCOUNT)])
        result = query.execute(conn, USER, 'recent-evaluations', {'connection_id':str(ACCOUNT), 'timezone':'Asia/Seoul', 'scope':'day', 'limit':3})
        self.assertEqual(result['evaluations'][0]['file_id'], str(ACCOUNT))
        self.assertIn('garmin.evaluation e', conn.calls[1][0])
        self.assertIn('f.revision=e.revision', conn.calls[1][0])
        with self.assertRaises(ValueError): query.validate('recent-evaluations', {'connection_id':str(ACCOUNT), 'timezone':'UTC', 'scope':'bad', 'limit':1})


if __name__ == '__main__': unittest.main()
