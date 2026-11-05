"""Independent fixed SQLite oracle versus fenced real PostgreSQL normalization.

The enclosing TypeScript harness owns and disposes the DB, roles and home.
"""
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
from garmin_pipeline import dates, normalize, store

ROOT=Path(__file__).resolve().parents[1]
FIXTURE=ROOT/'fixtures/legacy/normalize_v8/input.json'
ORACLE=ROOT/'tests/oracle/src'
CHILD=ROOT/'tests/normalize_oracle_child.py'
FIXED_NOW=1792100000000


class NormalizeOracleIntegrationTest(unittest.TestCase):
    def test_real_normalize_matches_pinned_sqlite_and_recovers_projection_failure(self):
        fixture=json.loads(FIXTURE.read_text(encoding='utf-8'))
        # No product module is importable from the oracle's PYTHONPATH or cwd.
        with tempfile.TemporaryDirectory(prefix='garmin-normalize-oracle-') as tmp:
            env={'HOME':tmp,'PATH':os.defpath,'PYTHONPATH':str(ORACLE),'PYTHONDONTWRITEBYTECODE':'1'}
            child=subprocess.run([sys.executable,str(CHILD),str(FIXTURE)],cwd=tmp,env=env,
                                 text=True,capture_output=True,check=True,timeout=60)
        reference=json.loads(child.stdout)
        self.assertGreater(reference['initial']['processed'],0)
        self.assertGreater(reference['initial']['failed'],0)
        self.assertEqual(reference['rerun']['processed'],0)
        errors=[row for row in reference['initial']['snapshot']['normalize_result']['rows'] if not row['ok']]
        self.assertTrue(any(row['error_code']=='parse_error' for row in errors))
        for table in ('daily_metric','activity','body_battery_sample','hr_sample','stress_bb_sample',
                      'activity_hr_sample','exercise_set','normalize_result','day_summary','workout','exercise_log'):
            self.assertTrue(reference['initial']['snapshot'][table]['rows'],table)
        self.assertIsNone(reference['initial']['snapshot']['pending'])

        owner_dsn=os.environ['GARMIN_TEST_OWNER_DSN']; ext_dsn=os.environ['GARMIN_TEST_EXTENSION_DSN']
        account,work,token=uuid4(),uuid4(),uuid4()
        with psycopg.connect(owner_dsn,autocommit=True) as owner:
            user=owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute('insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,%s)',(user,account,'synthetic-'+str(account),fixture['timezone']))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')",(work,str(work)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s',(token,work))
            with psycopg.connect(ext_dsn,autocommit=True) as driver:
                conn=store.Connection(driver,store.AccountContext(user,account,work,token),readonly=False)
                self.assertTrue(driver.execute('select garmin.attempt_valid(%s,%s)',(work,token)).fetchone()[0])
                self.assertTrue(store._try_lock(conn,'write',transaction=False))
                with store.transaction(conn):
                    conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'history_start',%s)",(user,account,fixture['history_start']))
                    conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'normalize_version',%s)",(user,account,str(store.NORMALIZE_VERSION)))
                for item in fixture['items']:
                    store.upsert_raw(conn,scope=item['scope'],key=item['key'],endpoint=item['endpoint'],
                        payload=json.loads(item['raw']),library_version='synthetic',now_ms=item['fetched_at'])
                store.append_evaluation(conn,report_date='2026-10-15',scope='day',summary='synthetic',
                    judgments='[]',evidence='[]',next_checks='[]',report_md='synthetic',model='fake',created_at=1)
                raw_before=owner.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_response where user_id=%s and connection_id=%s order by scope,key,endpoint',(user,account)).fetchall()
                evaluation_before=owner.execute('select * from garmin.evaluation_revisions where user_id=%s and connection_id=%s',(user,account)).fetchall()

                def assert_snapshot(expected):
                    with driver.transaction():
                        for table, definition in expected.items():
                            if table in ('exercise_order','pending'): continue
                            columns=definition['columns']; keys=definition['keys']
                            fields=','.join('"'+column+'"' for column in columns)
                            rows=driver.execute(f'select {fields} from garmin."{table}" where user_id=%s and connection_id=%s',(user,account)).fetchall()
                            actual=[dict(zip(columns,row,strict=True)) for row in rows]
                            actual.sort(key=lambda row:json.dumps([row[key] for key in keys],ensure_ascii=False))
                            self.assertEqual(actual,definition['rows'],table)
                        order=driver.execute('select activity_id,exercise from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order',(user,account)).fetchall()
                        self.assertEqual([list(row) for row in order],expected['exercise_order'])
                        pending=driver.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()
                        self.assertEqual(list(pending) if pending else None,expected['pending'])

                with patch.object(dates,'now_ms',return_value=FIXED_NOW):
                    initial=normalize.run(conn,timezone=fixture['timezone'])
                    self.assertEqual((initial.processed,initial.failed),(reference['initial']['processed'],reference['initial']['failed']))
                    self.assertGreater(initial.processed,0)
                    assert_snapshot(reference['initial']['snapshot'])
                    rerun=normalize.run(conn,timezone=fixture['timezone'])
                    self.assertEqual((rerun.processed,rerun.failed),(reference['rerun']['processed'],reference['rerun']['failed']))
                    self.assertEqual(rerun.processed,0)
                    assert_snapshot(reference['rerun']['snapshot'])
                    rebuilt=normalize.run(conn,rebuild=True,timezone=fixture['timezone'])
                    self.assertEqual((rebuilt.processed,rebuilt.failed),(reference['rebuild']['processed'],reference['rebuild']['failed']))
                    assert_snapshot(reference['rebuild']['snapshot'])
                self.assertEqual(owner.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_response where user_id=%s and connection_id=%s order by scope,key,endpoint',(user,account)).fetchall(),raw_before)
                self.assertEqual(owner.execute('select * from garmin.evaluation_revisions where user_id=%s and connection_id=%s',(user,account)).fetchall(),evaluation_before)
                # A real PG projection write fails after a new item commits.
                # Removing only this test-owned trigger allows a zero-work retry.
                store.upsert_raw(conn,scope='day',key='2026-10-17',endpoint='user_summary',
                    payload={'totalSteps':321},library_version='synthetic',now_ms=FIXED_NOW)
                self.assertEqual(reference['post_update']['processed'],1)
                raw_before=owner.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_response where user_id=%s and connection_id=%s order by scope,key,endpoint',(user,account)).fetchall()
                owner.execute("create function garmin.test_oracle_projection_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic projection failure'; end $$")
                owner.execute('create trigger test_oracle_projection_failure before insert on garmin.day_summary for each row execute function garmin.test_oracle_projection_failure()')
                try:
                    with patch.object(dates,'now_ms',return_value=FIXED_NOW):
                        with self.assertRaisesRegex(psycopg.errors.RaiseException,'synthetic projection failure'):
                            normalize.run(conn,timezone=fixture['timezone'])
                    pending=owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()
                    self.assertIn('2026-10-17',json.loads(pending[0]))
                    self.assertEqual(owner.execute("select ok,error_code from garmin.normalize_result where user_id=%s and connection_id=%s and scope='day' and key='2026-10-17' and endpoint='user_summary'",(user,account)).fetchone(),(1,None))
                finally:
                    owner.execute('drop trigger test_oracle_projection_failure on garmin.day_summary')
                    owner.execute('drop function garmin.test_oracle_projection_failure()')
                with patch.object(dates,'now_ms',return_value=FIXED_NOW):
                    recovered=normalize.run(conn,timezone=fixture['timezone'])
                    self.assertEqual((recovered.processed,recovered.failed),(0,0))
                    assert_snapshot(reference['post_update']['snapshot'])
                self.assertEqual(owner.execute('select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_response where user_id=%s and connection_id=%s order by scope,key,endpoint',(user,account)).fetchall(),raw_before)
                self.assertEqual(owner.execute('select * from garmin.evaluation_revisions where user_id=%s and connection_id=%s',(user,account)).fetchall(),evaluation_before)

    def test_rebuild_retains_existing_pending_against_sqlite_oracle(self):
        references={}
        with tempfile.TemporaryDirectory(prefix='garmin-pending-oracle-') as tmp:
            env={'HOME':tmp,'PATH':os.defpath,'PYTHONPATH':str(ORACLE),'PYTHONDONTWRITEBYTECODE':'1'}
            for scenario in ('outside_history','history_after_last','no_day_raw'):
                child=subprocess.run([sys.executable,str(CHILD),'pending',scenario],cwd=tmp,env=env,
                                     text=True,capture_output=True,check=True,timeout=60)
                references[scenario]=json.loads(child.stdout)
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'],autocommit=True) as owner:
            user=owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            work,token=uuid4(),uuid4()
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')",(work,str(work)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s',(token,work))
            with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'],autocommit=True) as driver:
                for scenario,reference in references.items():
                    with self.subTest(scenario=scenario):
                        account=uuid4(); day='2026-01-01'
                        owner.execute("insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,'UTC')",(user,account,'pending-'+str(account)))
                        conn=store.Connection(driver,store.AccountContext(user,account,work,token),readonly=False)
                        self.assertTrue(store._try_lock(conn,'write',transaction=False))
                        history='2026-01-03' if scenario=='history_after_last' else '2026-01-02'
                        with store.transaction(conn):
                            conn.execute("insert into garmin.meta(user_id,connection_id,key,value) values (%s,%s,'history_start',%s),(%s,%s,'day_values_pending',%s)",(user,account,history,user,account,json.dumps([day])))
                        if scenario!='no_day_raw':
                            store.upsert_raw(conn,scope='day',key=day,endpoint='user_summary',payload={'totalSteps':12},library_version='synthetic',now_ms=1)
                        if scenario=='outside_history':
                            store.upsert_raw(conn,scope='day',key='2026-01-02',endpoint='user_summary',payload={'totalSteps':34},library_version='synthetic',now_ms=1)
                        owner.execute("insert into garmin.day_summary(user_id,connection_id,date,steps) values (%s,%s,%s,999)",(user,account,day))
                        raw_before=owner.execute('select scope,key,endpoint,raw from garmin.raw_response where user_id=%s and connection_id=%s order by scope,key,endpoint',(user,account)).fetchall()
                        pending_before=owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()[0]
                        if scenario!='no_day_raw':
                            original=normalize.digest.day_values
                            def fail_day(key,*args,**kwargs):
                                if key==day: raise ValueError('synthetic pending failure')
                                return original(key,*args,**kwargs)
                            for _ in range(2):
                                with patch.object(normalize.digest,'day_values',side_effect=fail_day), patch.object(dates,'now_ms',return_value=FIXED_NOW):
                                    with self.assertRaisesRegex(store.StoreError,'rebuild projection incomplete'):
                                        normalize.run(conn,rebuild=True,timezone='UTC')
                                self.assertEqual(owner.execute('select steps from garmin.day_summary where user_id=%s and connection_id=%s and date=%s',(user,account,day)).fetchone()[0],999)
                                self.assertEqual(owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()[0],pending_before)
                            self.assertEqual(json.loads(reference['failed']['pending'][0]),[day])
                        with patch.object(dates,'now_ms',return_value=FIXED_NOW):
                            normalize.run(conn,rebuild=True,timezone='UTC')
                        rows=owner.execute('select date,steps from garmin.day_summary where user_id=%s and connection_id=%s order by date',(user,account)).fetchall()
                        pending=owner.execute("select value from garmin.meta where user_id=%s and connection_id=%s and key='day_values_pending'",(user,account)).fetchone()
                        self.assertEqual([list(row) for row in rows],reference['recovered']['days'])
                        self.assertEqual(list(pending) if pending else None,reference['recovered']['pending'])
                        self.assertEqual(owner.execute('select scope,key,endpoint,raw from garmin.raw_response where user_id=%s and connection_id=%s order by scope,key,endpoint',(user,account)).fetchall(),raw_before)
                        driver.execute('select pg_advisory_unlock(hashtextextended(%s,0))',(store.account_write_lock_key(user,account),))
