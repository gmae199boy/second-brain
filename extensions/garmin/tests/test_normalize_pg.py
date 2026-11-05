"""Synthetic normalize writer contracts; execution deferred to ticket 21.8."""
import sys
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from garmin_pipeline import normalize, store

USER = UUID('00000000-0000-4000-8000-000000000001')
CONNECTION = UUID('00000000-0000-4000-8000-000000000002')

class Result:
    def __init__(self, rows=()): self.rows = list(rows)
    def fetchone(self): return self.rows[0] if self.rows else None
    def fetchall(self): return self.rows
    def __iter__(self): return iter(self.rows)

class Conn:
    user_id, connection_id = USER, CONNECTION
    def __init__(self): self.calls, self.depth = [], 0
    def execute(self, sql, params=()):
        assert self.depth
        self.calls.append((sql, params))
        if 'MIN(key)' in sql: return Result([(None, None)])
        return Result()
    def executemany(self, sql, params):
        for row in params: self.execute(sql, row)

@contextmanager
def transaction(conn):
    conn.depth += 1
    try: yield conn
    finally: conn.depth -= 1

class NormalizePGTest(unittest.TestCase):
    def assert_scoped(self, conn):
        for sql, params in conn.calls:
            self.assertIn('garmin.', sql)
            self.assertNotIn('?', sql)
            self.assertIn(USER, params)
            self.assertIn(CONNECTION, params)

    def test_rebuild_stages_before_atomic_publish_and_preserves_raw(self):
        conn = Conn()
        with patch.object(store, 'transaction', transaction), patch.object(normalize, '_StageConnection', side_effect=lambda c: c):
            self.assertEqual(normalize.run(conn, rebuild=True, timezone='UTC'), (0, 0))
        sql = [sql for sql, _ in conn.calls]
        create = next(i for i, value in enumerate(sql) if value.startswith('CREATE TEMP TABLE'))
        publish = next(i for i, value in enumerate(sql) if value.startswith('DELETE FROM garmin.exercise_log_order'))
        self.assertLess(create, publish)
        self.assertTrue(any(value.startswith('INSERT INTO garmin.normalize_result SELECT * FROM pg_temp') for value in sql))
        self.assertFalse(any(value.startswith('DELETE FROM garmin.raw_response') or value.startswith('DELETE FROM garmin.evaluation') for value in sql))

    def test_item_scopes_join_samples_and_preserves_null(self):
        conn = Conn()
        with transaction(conn):
            normalize._work_set(conn)
            normalize._create_row(conn, '2026-01-01', {})
            normalize._write_columns(conn, normalize._TARGETS['day'], '2026-01-01', ('steps',), None)
            normalize._replace_samples(conn, normalize._TARGETS['day'], '2026-01-01',
                normalize.NORMALIZERS['heart_rates'].sample_table, [(1, 70)])
            normalize._record(conn, normalize._Item('day', '2026-01-01', 'heart_rates', 1), ok=True, error_code=None)
        join = conn.calls[0][0]
        self.assertIn('n.user_id=r.user_id', join)
        self.assertIn('n.connection_id=r.connection_id', join)
        update = next(params for sql, params in conn.calls if sql.startswith('UPDATE'))
        self.assertIsNone(update[0])
        self.assert_scoped(conn)

    def test_day_projection_inserts_order_in_same_transaction(self):
        conn = Conn()
        values = {'day_summary': {'date': '2026-01-01'}, 'workouts': [],
                  'exercise_logs': [{'activity_id': 5, 'exercise': 'b'}, {'activity_id': 5, 'exercise': 'a'}]}
        original = conn.execute
        def execute(sql, params=()):
            if "scope='day' AND key=" in sql:
                original(sql, params)
                return Result([('synthetic', '{}')])
            return original(sql, params)
        conn.execute = execute
        with patch.object(store, 'transaction', transaction), patch.object(normalize.digest, 'day_values', return_value=values):
            normalize._refresh_days(conn, [normalize._Item('day', '2026-01-01', 'synthetic', 1)], transaction, 'UTC', False, set())
        ordered = [(sql, args) for sql, args in conn.calls if 'INSERT INTO garmin.exercise_log_order' in sql]
        self.assertEqual([args[3] for _, args in ordered], ['b', 'a'])
        self.assertTrue(all('MAX(source_order)' in sql for sql, _ in ordered))
        self.assert_scoped(conn)

    def test_activity_pending_includes_both_source_and_existing_dates(self):
        conn=Conn(); original=conn.execute
        def execute(sql, params=()):
            original(sql, params)
            if 'SELECT day_key,start_ms' in sql: return Result([('2026-01-01',1767312000000)])
            if 'SELECT date FROM garmin.workout' in sql: return Result([('2025-12-31',)])
            return Result()
        conn.execute=execute
        with transaction(conn):
            days=normalize._item_days(conn,normalize._Item('activity','42','activity',1),{42:'2026-01-03'},'UTC')
        self.assertEqual(days,{'2025-12-31','2026-01-01','2026-01-02','2026-01-03'})
        self.assert_scoped(conn)

    def test_fence_errors_propagate(self):
        conn = Conn()
        @contextmanager
        def stale(_conn):
            raise store.StaleAttempt()
            yield
        with patch.object(store, 'transaction', transaction), patch.object(normalize, '_work_set', return_value=[normalize._Item('day', '2026-01-01', 'user_summary', 1)]):
            with self.assertRaises(store.StaleAttempt):
                normalize._process(conn, stale, timezone='UTC')

class NormalizeRecoveryIntegrationTest(unittest.TestCase):
    """Disposable PostgreSQL only; the 21.8 gate executes these tests."""
    def test_item_crash_and_atomic_rebuild_recovery(self):
        import json
        import os
        import psycopg
        from uuid import uuid4
        account, work, token = uuid4(), uuid4(), uuid4()
        day = '2026-01-02'
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'], autocommit=True) as owner:
            user=owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute("insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,'UTC')",(user,account,'test-'+str(account)))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','import','normalize-recovery',now(),now(),'supervised',now(),now()+interval '1 hour','test')",(work,))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s',(token,work))
            raw=json.dumps({'totalSteps':12,'totalDistanceMeters':None,'activeKilocalories':None,'moderateIntensityMinutes':None,'vigorousIntensityMinutes':None,'minHeartRate':None,'maxHeartRate':None})
            owner.execute("insert into garmin.raw_response(user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version) values (%s,%s,'day',%s,'user_summary',%s,1,1,'fixture')",(user,account,day,raw))
            owner.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'normalize_version',%s)",(user,account,str(store.NORMALIZE_VERSION)))
            owner.execute('insert into garmin.daily_metric(user_id,connection_id,day_key,steps) values (%s,%s,%s,999)',(user,account,day))
            owner.execute('insert into garmin.day_summary(user_id,connection_id,date,steps) values (%s,%s,%s,999)',(user,account,day))
            owner.execute("insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision) values (%s,%s,%s,'day','before','[]','[]','[]','before','fake',1,1)",(user,account,day))
            with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'],autocommit=True) as raw_conn:
                conn=store.Connection(raw_conn,store.AccountContext(user,account,work,token),readonly=False)
                self.assertTrue(store._try_lock(conn,'write',transaction=False))
                # Crash after item commit: pending survives and a zero-work rerun projects it.
                with patch.object(normalize,'_after_item_commit',side_effect=RuntimeError('crash after item')):
                    with self.assertRaisesRegex(RuntimeError,'crash after item'): normalize.run(conn,timezone='UTC')
                self.assertEqual(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()[0],json.dumps([day]))
                self.assertEqual(owner.execute('select steps from garmin.day_summary where user_id=%s and connection_id=%s and date=%s',(user,account,day)).fetchone()[0],999)
                self.assertEqual(normalize.run(conn,timezone='UTC').processed,0)
                self.assertIsNone(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone())
                self.assertEqual(owner.execute('select steps from garmin.day_summary where user_id=%s and connection_id=%s and date=%s',(user,account,day)).fetchone()[0],12)
                # Staging is invisible to a separate reader; abort before publication.
                owner.execute('update garmin.day_summary set steps=777 where user_id=%s and connection_id=%s and date=%s',(user,account,day))
                owner.execute("update garmin.meta set value='old' where user_id=%s and connection_id=%s and key='normalize_version'",(user,account))
                def observe(*_):
                    self.assertEqual(owner.execute('select steps from garmin.day_summary where user_id=%s and connection_id=%s and date=%s',(user,account,day)).fetchone()[0],777)
                    self.assertEqual(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='normalize_version'",(user,account)).fetchone()[0],'old')
                    raise RuntimeError('staging stop')
                with patch.object(normalize,'_before_rebuild_publish',side_effect=observe):
                    with self.assertRaisesRegex(RuntimeError,'staging stop'): normalize.run(conn,rebuild=True,timezone='UTC')
                # A real trigger failure during publish rolls the old projection back.
                owner.execute("create function garmin.test_normalize_publish_failure() returns trigger language plpgsql as $$ begin raise exception 'publish failure'; end $$")
                owner.execute('create trigger test_normalize_publish_failure before insert on garmin.day_summary for each row execute function garmin.test_normalize_publish_failure()')
                try:
                    with self.assertRaises(psycopg.Error): normalize.run(conn,rebuild=True,timezone='UTC')
                    self.assertEqual(owner.execute('select steps from garmin.day_summary where user_id=%s and connection_id=%s and date=%s',(user,account,day)).fetchone()[0],777)
                    self.assertEqual(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='normalize_version'",(user,account)).fetchone()[0],'old')
                finally:
                    owner.execute('drop trigger test_normalize_publish_failure on garmin.day_summary')
                    owner.execute('drop function garmin.test_normalize_publish_failure()')
                normalize.run(conn,rebuild=True,timezone='UTC')
                self.assertEqual(owner.execute('select steps from garmin.day_summary where user_id=%s and connection_id=%s and date=%s',(user,account,day)).fetchone()[0],12)
                self.assertEqual(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='normalize_version'",(user,account)).fetchone()[0],str(store.NORMALIZE_VERSION))
                self.assertEqual(owner.execute('select raw from garmin.raw_response where user_id=%s and connection_id=%s',(user,account)).fetchone()[0],raw)
                self.assertEqual(owner.execute('select revision,summary from garmin.evaluation_revisions where user_id=%s and connection_id=%s',(user,account)).fetchall(),[(1,'before')])

class RebuildDateRangeTest(unittest.TestCase):
    """Synthetic staging boundaries; no test or fixture executes before 21.8."""
    class RangeConn(Conn):
        def __init__(self, first, last, history, pending):
            super().__init__()
            self.first, self.last, self.history = first, last, history
            self.pending=set(pending)
            self.projected=[]
        def execute(self, sql, params=()):
            import json
            assert self.depth
            self.calls.append((sql,params))
            if 'SELECT value FROM garmin.meta' in sql and "key='day_values_pending'" in sql:
                return Result([(json.dumps(sorted(self.pending)),)] if self.pending else [])
            if 'SELECT activity_id, start_ms' in sql: return Result()
            if 'SELECT MIN(key), MAX(key)' in sql: return Result([(self.first,self.last)])
            if 'SELECT value FROM garmin.meta' in sql and "key='history_start'" in sql:
                return Result([(self.history,)] if self.history is not None else [])
            if 'SELECT endpoint,raw' in sql and "scope='day'" in sql:
                self.projected.append(params[-1])
                return Result([('user_summary','{}')])
            if 'INSERT INTO garmin.meta' in sql and "'day_values_pending'" in sql:
                self.pending=set(json.loads(params[-1]))
            if 'DELETE FROM garmin.meta' in sql and "'day_values_pending'" in sql:
                self.pending.clear()
            return Result()

    def refresh(self, conn, *, rebuild, items=(), previous=(), fail=(), durable=()):
        def project(day, *_args):
            if day in fail: raise ValueError('synthetic projection failure')
            return {'day_summary':{'date':day},'workouts':[],'exercise_logs':[]}
        with patch.object(store,'transaction',transaction), patch.object(normalize.digest,'day_values',side_effect=project):
            normalize._refresh_days(conn,items,transaction,'UTC',rebuild,set(previous),set(durable))

    def test_rebuild_discards_staging_pending_outside_history_and_last(self):
        conn=self.RangeConn('2026-01-01','2026-01-04','2026-01-02',
                            ['2025-12-31','2026-01-01','2026-01-03','2026-01-05'])
        self.refresh(conn,rebuild=True,previous=['2025-12-30'])
        self.assertEqual(conn.projected,['2026-01-02','2026-01-03','2026-01-04'])
        self.assertEqual(conn.pending,set())

    def test_existing_pending_is_added_beyond_range_but_new_staging_pending_is_not(self):
        conn=self.RangeConn('2026-01-01','2026-01-04','2026-01-02',
                            ['2025-12-31','2026-01-03','2026-01-05'])
        self.refresh(conn,rebuild=True,durable=['2026-01-01'],fail=['2026-01-01'])
        self.assertEqual(conn.projected,['2026-01-01','2026-01-02','2026-01-03','2026-01-04'])
        self.assertEqual(conn.pending,{'2026-01-01'})
        conn.projected.clear()
        self.refresh(conn,rebuild=True,durable=['2026-01-01'])
        self.assertEqual(conn.pending,set())
        self.assertIn('2026-01-01',conn.projected)

    def test_rebuild_without_history_starts_at_first_and_keeps_in_range_failure(self):
        conn=self.RangeConn('2026-01-02','2026-01-03',None,['2026-01-01','2026-01-02','2026-01-04'])
        self.refresh(conn,rebuild=True,fail=['2026-01-03'])
        self.assertEqual(conn.projected,['2026-01-02','2026-01-03'])
        self.assertEqual(conn.pending,{'2026-01-03'})

    def test_rebuild_empty_ranges_clear_staging_pending(self):
        for first,last,history in [(None,None,None),('2026-01-01','2026-01-02','2026-01-03')]:
            with self.subTest(first=first,history=history):
                conn=self.RangeConn(first,last,history,['2026-01-01','2026-01-05'])
                self.refresh(conn,rebuild=True)
                self.assertEqual(conn.projected,[])
                self.assertEqual(conn.pending,set())

    def test_empty_ranges_still_refresh_preexisting_pending(self):
        for first,last,history in [(None,None,None),('2026-01-01','2026-01-02','2026-01-03')]:
            with self.subTest(first=first,history=history):
                conn=self.RangeConn(first,last,history,['2026-01-05'])
                self.refresh(conn,rebuild=True,durable=['2026-01-01'])
                self.assertEqual(conn.projected,['2026-01-01'])
                self.assertEqual(conn.pending,set())

    def test_incremental_keeps_and_retries_pending_and_previous_dates(self):
        conn=self.RangeConn('2026-01-02','2026-01-03','2026-01-03',['2026-01-01','2026-01-04'])
        self.refresh(conn,rebuild=False,items=[normalize._Item('day','2026-01-02','user_summary',1)],
                     previous=['2025-12-31'],fail=['2026-01-01'])
        self.assertEqual(conn.projected,['2025-12-31','2026-01-01','2026-01-02','2026-01-04'])
        self.assertEqual(conn.pending,{'2026-01-01'})
        conn.projected.clear()
        self.refresh(conn,rebuild=False)
        self.assertEqual(conn.projected,['2026-01-01'])
        self.assertEqual(conn.pending,set())

class RebuildDateRangeIntegrationTest(unittest.TestCase):
    """Real fenced rebuilds; disposable PG lifetime belongs to the test harness."""
    def test_empty_day_input_empty_history_range_and_in_range_failure(self):
        import os
        import psycopg
        from uuid import uuid4
        from garmin_pipeline import digest
        work,token=uuid4(),uuid4()
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'],autocommit=True) as owner:
            user=owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')",(work,str(work)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s',(token,work))
            with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'],autocommit=True) as driver:
                for scenario in ('no_day_raw','history_after_last','projection_failure'):
                    with self.subTest(scenario=scenario):
                        account=uuid4()
                        owner.execute("insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,'UTC')",(user,account,'range-'+str(account)))
                        conn=store.Connection(driver,store.AccountContext(user,account,work,token),readonly=False)
                        self.assertTrue(driver.execute('select garmin.attempt_valid(%s,%s)',(work,token)).fetchone()[0])
                        store.upsert_raw(conn,scope='activity',key='42',endpoint='activity',
                            payload={'activityId':42,'summaryDTO':{'startTimeGMT':'2026-01-02T00:00:00.0','duration':60}},library_version='synthetic',now_ms=1)
                        if scenario!='no_day_raw':
                            store.upsert_raw(conn,scope='day',key='2026-01-01',endpoint='user_summary',
                                payload={'totalSteps':12},library_version='synthetic',now_ms=1)
                        if scenario=='history_after_last':
                            with store.transaction(conn):
                                conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'history_start','2026-01-02')",(user,account))
                        # An existing published projection must survive a failed rebuild.
                        if scenario=='projection_failure':
                            owner.execute("insert into garmin.day_summary(user_id,connection_id,date,steps) values (%s,%s,'2026-01-01',999)",(user,account))
                            original=digest.day_values
                            def fail(day,*args):
                                if day=='2026-01-01': raise ValueError('synthetic projection failure')
                                return original(day,*args)
                            with patch.object(digest,'day_values',side_effect=fail):
                                with self.assertRaisesRegex(store.StoreError,'rebuild projection incomplete'):
                                    normalize.run(conn,rebuild=True,timezone='UTC')
                            self.assertEqual(owner.execute("select steps from garmin.day_summary where user_id=%s and connection_id=%s and date='2026-01-01'",(user,account)).fetchone(),(999.0,))
                            with driver.transaction():
                                staged=driver.execute("select value from pg_temp.normalize_stage_meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()
                            self.assertEqual(__import__('json').loads(staged[0]),['2026-01-01'])
                            normalize.run(conn,rebuild=True,timezone='UTC')
                            self.assertEqual(owner.execute("select steps from garmin.day_summary where user_id=%s and connection_id=%s and date='2026-01-01'",(user,account)).fetchone(),(12.0,))
                        else:
                            result=normalize.run(conn,rebuild=True,timezone='UTC')
                            self.assertGreater(result.processed,0)
                            self.assertEqual(owner.execute('select count(*) from garmin.day_summary where user_id=%s and connection_id=%s',(user,account)).fetchone()[0],0)
                            self.assertIsNone(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone())
