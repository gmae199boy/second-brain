"""Fake network through SQLite and real fenced PG collect; execution deferred to 21.8."""
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import uuid4

import psycopg
from garmin_pipeline import collect, coverage, dates, digest, normalize, store
from collect_oracle_support import DAY, NOW, FakeNetwork, cfg, fixture, recheck_scenario, timezone_scenario

ROOT = Path(__file__).resolve().parents[1]


class CollectOraclePGTest(unittest.TestCase):
    def test_collect_interruption_resume_pending_and_sqlite_matrix(self):
        with tempfile.TemporaryDirectory(prefix='garmin-collect-oracle-') as tmp:
            env = {'HOME': tmp, 'PATH': os.defpath,
                   'PYTHONPATH': os.pathsep.join((str(ROOT / 'tests/oracle/src'), str(ROOT / 'tests'))),
                   'PYTHONDONTWRITEBYTECODE': '1'}
            child = subprocess.run([sys.executable, str(ROOT / 'tests/collect_oracle_child.py')],
                                   cwd=tmp, env=env, capture_output=True, text=True, check=True, timeout=60)
            expected = json.loads(child.stdout)
        owner_dsn = os.environ['GARMIN_TEST_OWNER_DSN']; ext_dsn = os.environ['GARMIN_TEST_EXTENSION_DSN']
        account, work, token = uuid4(), uuid4(), uuid4()
        with psycopg.connect(owner_dsn, autocommit=True) as owner:
            user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute("insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,'Asia/Seoul')", (user, account, 'synthetic-' + str(account)))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.collect','extension',%s,now(),now(),'supervised',now(),now()+interval '1 hour','synthetic')", (work, str(account)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())', (token, work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s', (token, work))
            with psycopg.connect(ext_dsn, autocommit=True) as driver:
                conn = store.Connection(driver, store.AccountContext(user, account, work, token), readonly=False)
                self.assertTrue(store._try_lock(conn, 'write', transaction=False))
                with store.transaction(conn):
                    conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'history_start',%s),(%s,%s,'normalize_version',%s)", (user, account, DAY.isoformat(), user, account, str(store.NORMALIZE_VERSION)))
                interrupted = FakeNetwork(fixture()['items'], fail_after=5)
                resumed = FakeNetwork(fixture()['items'])
                with patch.object(dates, 'now_ms', return_value=NOW), patch.object(dates, 'system_timezone', return_value='Asia/Seoul'):
                    with self.assertRaisesRegex(RuntimeError, 'synthetic interruption'):
                        collect.run(conn, cfg(), interrupted, interrupted.sleep, today=DAY, started_at=NOW, manual=True)
                    before = owner.execute('select scope,key,endpoint,raw from garmin.raw_current where user_id=%s and connection_id=%s order by scope collate "C",key collate "C",endpoint collate "C"', (user, account)).fetchall()
                    self.assertEqual([list(row) for row in before], expected['before'])
                    with patch.object(digest, 'day_values', side_effect=ValueError('synthetic projection failure')):
                        collect.run(conn, cfg(), resumed, resumed.sleep, today=DAY, started_at=NOW + 1, manual=True)
                    pending = owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'", (user, account)).fetchone()
                    self.assertEqual(list(pending) if pending else None, expected['pending_before'])
                    self.assertIsNotNone(pending)
                    normalize.run(conn, timezone=cfg().timezone)
                    with store.transaction(conn):
                        items = [list(row) for row in coverage.items(conn, cfg(), DAY, DAY)]
                    self.assertEqual(items, expected['coverage'])
                self.assertEqual(interrupted.requests, expected['requests_before'])
                self.assertEqual(resumed.requests, expected['requests_after'])
                retained = {(row[0], row[1], row[2], row[3]) for row in expected['raw']}
                self.assertTrue({tuple(row) for row in expected['before']} <= retained)
                metric = next(row for row in expected['tables']['daily_metric']['rows'] if row['day_key'] == DAY.isoformat())
                self.assertEqual((metric['readiness_score'], metric['readiness_level']), (81, 'HIGH'))
                self.assertTrue(any(row[3] == 'null' for row in expected['raw']))
                self.assertTrue(any(row[:4] == ['day', DAY.isoformat(), 'daily_weigh_ins', 'null'] for row in expected['raw']))
                exercise_order = owner.execute('select activity_id,exercise from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order', (user, account)).fetchall()
                self.assertEqual([list(row) for row in exercise_order], expected['exercise_order'])
                self.assertTrue(interrupted.requests)
                self.assertFalse(set(map(tuple, interrupted.requests)) & set(map(tuple, resumed.requests)))
                self.assertEqual([list(row) for row in owner.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_current where user_id=%s and connection_id=%s order by scope collate "C",key collate "C",endpoint collate "C"', (user, account)).fetchall()], expected['raw'])
                self.assertEqual([list(row) for row in owner.execute('select local_date,started_at,finished_at,status,detail from garmin.run where user_id=%s and connection_id=%s order by id', (user, account)).fetchall()], expected['runs'])
                for table, definition in expected['tables'].items():
                    columns, keys = definition['columns'], definition['keys']
                    fields = ','.join('"' + column + '"' for column in columns)
                    rows = owner.execute(f'select {fields} from garmin."{table}" where user_id=%s and connection_id=%s', (user, account)).fetchall()
                    values = [dict(zip(columns, row, strict=True)) for row in rows]
                    values.sort(key=lambda row: json.dumps([row[key] for key in keys], ensure_ascii=False))
                    self.assertEqual(values, definition['rows'], table)
                raw = owner.execute('select scope,key,endpoint,raw from garmin.raw_current where user_id=%s and connection_id=%s', (user, account)).fetchall()
                days = {endpoint: json.loads(body) for scope, key, endpoint, body in raw if scope == 'day' and key == DAY.isoformat()}
                activities = {}
                for scope, key, endpoint, body in raw:
                    if scope == 'activity': activities.setdefault(key, {})[endpoint] = json.loads(body)
                self.assertEqual(digest.day_values(DAY.isoformat(), days, activities, {}, cfg().timezone), expected['digest'])
                pending = owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'", (user, account)).fetchone()
                self.assertEqual(list(pending) if pending else None, expected['pending'])
                for table in ('daily_metric', 'day_summary', 'activity', 'workout', 'exercise_log'):
                    self.assertTrue(expected['tables'][table]['rows'], table)

    def test_recheck_freshness_and_timezone_boundary_match_pinned_sqlite(self):
        with tempfile.TemporaryDirectory(prefix='garmin-recheck-oracle-') as tmp:
            env = {'HOME': tmp, 'PATH': os.defpath,
                   'PYTHONPATH': os.pathsep.join((str(ROOT / 'tests/oracle/src'), str(ROOT / 'tests'))),
                   'PYTHONDONTWRITEBYTECODE': '1'}
            child = subprocess.run([sys.executable, str(ROOT / 'tests/collect_recheck_oracle_child.py')],
                                   cwd=tmp, env=env, capture_output=True, text=True, check=True, timeout=60)
            expected = json.loads(child.stdout)
        owner_dsn = os.environ['GARMIN_TEST_OWNER_DSN']; ext_dsn = os.environ['GARMIN_TEST_EXTENSION_DSN']
        with psycopg.connect(owner_dsn, autocommit=True) as owner:
            user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            def scenario(fn, timezone):
                account, work, token = uuid4(), uuid4(), uuid4()
                owner.execute('insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,%s)', (user, account, 'synthetic-' + str(account), timezone))
                owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.collect','extension',%s,now(),now(),'supervised',now(),now()+interval '1 hour','synthetic')", (work, str(account)))
                owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())', (token, work))
                owner.execute('update brain.work_items set current_attempt_token=%s where id=%s', (token, work))
                with psycopg.connect(ext_dsn, autocommit=True) as driver:
                    conn = store.Connection(driver, store.AccountContext(user, account, work, token), readonly=False)
                    self.assertTrue(store._try_lock(conn, 'write', transaction=False))
                    with store.transaction(conn):
                        conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'history_start',%s),(%s,%s,'normalize_version',%s)", (user, account, DAY.isoformat(), user, account, str(store.NORMALIZE_VERSION)))
                    def snapshot(connection, today, local_cfg):
                        with store.transaction(connection):
                            return {'raw': [list(row) for row in connection.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_current where user_id=%s and connection_id=%s order by scope collate "C",key collate "C",endpoint collate "C"', (user, account)).fetchall()],
                                    'runs': [list(row) for row in connection.execute('select local_date,started_at,finished_at,status,detail from garmin.run where user_id=%s and connection_id=%s order by id', (user, account)).fetchall()],
                                    'coverage': [list(item) for item in coverage.items(connection, local_cfg, DAY, today)]}
                    return fn(conn, snapshot)
            actual = scenario(recheck_scenario, 'Asia/Seoul')
            self.assertEqual(actual, expected['recheck'])
            first, second, third = actual['steps']
            self.assertEqual([step['today'] for step in actual['steps']], ['2026-10-15', '2026-10-16', '2026-10-16'])
            def raw(step, day, endpoint):
                return next(row for row in step['raw'] if row[:3] == ['day', day, endpoint])
            old = raw(first, '2026-10-15', 'user_summary')
            new = raw(second, '2026-10-15', 'user_summary')
            self.assertNotEqual(old[3], 'null')
            self.assertEqual((new[3], new[4], new[6]), (old[3], old[4], old[6]))
            self.assertGreater(new[5], old[5])
            self.assertIn(['day', '2026-10-15', 'user_summary'], second['requests'])
            self.assertIn(['day', '2026-10-16', 'user_summary'], third['requests'])
            activity = ['activity', actual['activity_id'], 'activity_exercise_sets']
            listing = ['day', '2026-10-15', 'activities_by_date']
            self.assertIn(activity, first['requests']); self.assertIn(activity, second['requests'])
            self.assertLess(second['requests'].index(listing), second['requests'].index(activity))
            self.assertNotIn(activity, third['requests'])
            zones = {zone: scenario(lambda conn, snap: timezone_scenario(conn, snap, zone), zone) for zone in ('UTC', 'Asia/Seoul')}
            self.assertEqual(zones, expected['zones'])
            self.assertEqual(zones['UTC']['today'], '2026-10-15')
            self.assertEqual(zones['Asia/Seoul']['today'], '2026-10-16')
            self.assertNotIn('timezone_mismatch', zones['UTC']['runs'][-1][-1])
            self.assertIn('timezone_mismatch', zones['Asia/Seoul']['runs'][-1][-1])
