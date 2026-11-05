"""Real PG contract checks, restricted to the disposable test-db fixture.

The harness installs Garmin and supplies owner and extension DSNs. Immutable rows
are deliberately left in that database until the owning fixture drops it.
"""
import concurrent.futures
import hashlib
import json
import os
import tempfile
import subprocess
import sys
import threading
import unittest
from datetime import date, time
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import uuid4

import psycopg
from garmin_pipeline import charts, coverage, report_input, store, normalize
from collect_credentials import CredentialEvidenceError, verify_credentials

DAY = '2026-01-01'
REPORT_DAY = date(2026, 1, 2)
CFG = SimpleNamespace(timezone='UTC', collect_time=time(7), max_rejected_attempts=3)


class RealStoreContractTest(unittest.TestCase):
    def setUp(self):
        self.owner_dsn = os.environ['GARMIN_TEST_OWNER_DSN']
        self.ext_dsn = os.environ['GARMIN_TEST_EXTENSION_DSN']
        self.work, self.token = uuid4(), uuid4()
        self.other_user = uuid4()
        self.accounts = []
        with psycopg.connect(self.owner_dsn, autocommit=True) as owner:
            self.user = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            owner.execute('insert into brain.users(id,name,is_self,created_at) values (%s,%s,0,now())', (self.other_user,'synthetic-test'))
            for user in (self.user,self.user,self.other_user):
                connection, identity = uuid4(), 'synthetic-' + uuid4().hex
                owner.execute('insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values (%s,%s,%s,%s)', (user,connection,identity,'UTC'))
                self.accounts.append((user,connection,identity))
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised')", (self.work,str(self.work)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(self.token,self.work))
            owner.execute("update brain.work_items set current_attempt_token=%s,claimed_at=now(),claim_expires_at=now()+interval '1 hour',claimed_by='synthetic' where id=%s",(self.token,self.work))
        with psycopg.connect(self.ext_dsn) as ext:
            self.assertTrue(ext.execute('select garmin.attempt_valid(%s,%s)',(self.work,self.token)).fetchone()[0])

    def writer(self, account):
        user, connection, _ = account
        return store.Connection(psycopg.connect(self.ext_dsn,autocommit=True),
            store.AccountContext(user,connection,self.work,self.token),readonly=False)

    def envelope(self, account):
        return patch.dict(os.environ,{'BRAIN_DATABASE_URL':self.ext_dsn,'BRAIN_USER_ID':str(account[0]),
            'BRAIN_ACCOUNT':account[2],'BRAIN_WORK_ID':str(self.work),'BRAIN_ATTEMPT_TOKEN':str(self.token)})

    def append(self, conn, report_date, scope, text):
        return store.append_evaluation(conn,report_date=report_date,scope=scope,summary=text,
            judgments='[]',evidence='[]',next_checks='[]',report_md='report '+text,model='synthetic',created_at=1)

    def test_credential_binding_fence_and_competing_accounts(self):
        with tempfile.TemporaryDirectory(prefix='garmin-binding-') as tmp:
            root = Path(os.path.realpath(tmp))
            paths = []
            for index, account in enumerate(self.accounts[:2]):
                path = root / str(index); path.mkdir(mode=0o700)
                token_file = path / 'garmin_tokens.json'
                token_file.write_bytes(b'synthetic-shared-token'); token_file.chmod(0o600)
                evidence = {'version': 1, 'user_id': str(account[0]), 'connection_id': str(account[1]),
                    'external_identity': account[2], 'token_sha256': hashlib.sha256(b'synthetic-shared-token').hexdigest()}
                evidence_file = path / 'brain-account-binding.json'
                evidence_file.write_text(json.dumps(evidence)); evidence_file.chmod(0o600)
                paths.append(path)
            barrier = threading.Barrier(2, timeout=5)
            def bind(index):
                writer = self.writer(self.accounts[index])
                try:
                    barrier.wait()
                    with store.transaction(writer): verify_credentials(writer, SimpleNamespace(tokenstore=paths[index]))
                    return 'bound'
                except CredentialEvidenceError:
                    return 'rejected'
                finally:
                    writer.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                outcomes = list(pool.map(bind, (0, 1)))
            self.assertEqual(sorted(outcomes), ['bound', 'rejected'])
            with psycopg.connect(self.owner_dsn, autocommit=True) as owner:
                rows = owner.execute('select connection_id, tokenstore_ref from garmin.account_connections where user_id=%s and connection_id=any(%s)', (self.user, [a[1] for a in self.accounts[:2]])).fetchall()
                self.assertEqual(sum(value is not None for _, value in rows), 1)
                owner.execute('update brain.work_items set current_attempt_token=null where id=%s', (self.work,))
            writer = self.writer(self.accounts[outcomes.index('rejected')])
            try:
                with self.assertRaises(store.StaleAttempt):
                    with store.transaction(writer): verify_credentials(writer, SimpleNamespace(tokenstore=paths[outcomes.index('rejected')]))
            finally:
                writer.close()

    def test_raw_observations_current_semantics_and_fence(self):
        account = self.accounts[0]; writer = self.writer(account)
        key = '2026-01-05'; endpoint = 'user_summary'
        try:
            oracle = json.loads(subprocess.check_output([sys.executable, str(Path(__file__).with_name('raw_oracle_child.py'))], text=True))
            observed = []
            def put(payload, at, version):
                store.upsert_raw(writer, scope='day', key=key, endpoint=endpoint, payload=payload, library_version=version, now_ms=at)
            def current():
                with psycopg.connect(self.ext_dsn) as reader:
                    return reader.execute('select raw,fetched_at,checked_at,library_version from garmin.raw_current where user_id=%s and connection_id=%s and scope=%s and key=%s and endpoint=%s', (*account[:2], 'day', key, endpoint)).fetchone()
            put(None, 1, 'v1'); self.assertEqual(current(), ('null', 1, 1, 'v1')); observed.append(list(current()))
            put(None, 2, 'v2'); self.assertEqual(current(), ('null', 1, 2, 'v1')); observed.append(list(current()))
            put({'totalSteps': 10}, 3, 'v3'); self.assertEqual(current(), ('{"totalSteps": 10}', 3, 3, 'v3')); observed.append(list(current()))
            with store.transaction(writer):
                self.assertIn(('day', key, endpoint, 3), [tuple(item) for item in normalize._work_set(writer)])
                normalize._record(writer, normalize._Item('day', key, endpoint, 3), ok=True, error_code=None)
            put({'totalSteps': 10}, 4, 'v4'); self.assertEqual(current(), ('{"totalSteps": 10}', 3, 4, 'v3')); observed.append(list(current()))
            put(None, 5, 'v5'); self.assertEqual(current(), ('{"totalSteps": 10}', 3, 5, 'v3')); observed.append(list(current()))
            with store.transaction(writer):
                self.assertNotIn(('day', key, endpoint, 3), [tuple(item) for item in normalize._work_set(writer)])
            put({'totalSteps': 20}, 6, 'v6'); self.assertEqual(current(), ('{"totalSteps": 20}', 6, 6, 'v6')); observed.append(list(current()))
            self.assertEqual(observed, oracle)
            with store.transaction(writer):
                self.assertIn(('day', key, endpoint, 6), [tuple(item) for item in normalize._work_set(writer)])
            with psycopg.connect(self.ext_dsn, autocommit=True) as ext:
                self.assertEqual(ext.execute('select raw from garmin.raw_response where user_id=%s and connection_id=%s and key=%s', (*account[:2], key)).fetchone(), ('null',))
                rows = ext.execute('select raw,observed_at,library_version from garmin.raw_observations where user_id=%s and connection_id=%s and key=%s order by id', (*account[:2], key)).fetchall()
                self.assertEqual(rows, [('null',1,'v1'),('null',2,'v2'),('{"totalSteps": 10}',3,'v3'),('{"totalSteps": 10}',4,'v4'),('null',5,'v5'),('{"totalSteps": 20}',6,'v6')])
                with self.assertRaises(psycopg.errors.RaiseException):
                    ext.execute('update garmin.raw_observations set raw=%s where user_id=%s and connection_id=%s and key=%s', ('{}',*account[:2],key))
            with psycopg.connect(self.owner_dsn, autocommit=True) as owner:
                owner.execute('update brain.work_items set current_attempt_token=null where id=%s', (self.work,))
            with self.assertRaises(store.StaleAttempt): put({'totalSteps': 30}, 7, 'v7')
            self.assertEqual(current(), ('{"totalSteps": 20}', 6, 6, 'v6'))
            with psycopg.connect(self.ext_dsn) as reader:
                self.assertEqual(reader.execute('select count(*) from garmin.raw_observations where user_id=%s and connection_id=%s and key=%s', (*account[:2], key)).fetchone()[0], 6)
        finally:
            writer.close()

    def test_imported_raw_becomes_current_without_mutating_import(self):
        account = self.accounts[0]; writer = self.writer(account)
        key = '2026-01-06'
        try:
            with psycopg.connect(self.owner_dsn, autocommit=True) as owner:
                owner.execute('insert into garmin.raw_response(user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)', (*account[:2], 'day', key, 'user_summary', '{"totalSteps": 1}', 1, 1, 'import'))
            store.upsert_raw(writer, scope='day', key=key, endpoint='user_summary', payload={'totalSteps': 2}, library_version='new', now_ms=2)
            with psycopg.connect(self.ext_dsn) as ext:
                args = (*account[:2], key)
                self.assertEqual(ext.execute('select raw from garmin.raw_response where user_id=%s and connection_id=%s and key=%s', args).fetchone(), ('{"totalSteps": 1}',))
                self.assertEqual(ext.execute('select raw,fetched_at from garmin.raw_current where user_id=%s and connection_id=%s and key=%s', args).fetchall(), [('{"totalSteps": 2}',2)])
        finally:
            writer.close()

    def test_report_snapshot_reads_second_day_and_activity_payload_preserving_originals(self):
        account = self.accounts[0]; writer = self.writer(account)
        try:
            for scope, key, endpoint, first, second in (
                ('day', DAY, 'sleep_data', {'marker': 'day-first'}, {'marker': 'day-second'}),
                ('activity', '77', 'activity', {'marker': 'activity-first'}, {'marker': 'activity-second'}),
            ):
                store.upsert_raw(writer, scope=scope, key=key, endpoint=endpoint, payload=first, library_version='first', now_ms=1)
                store.upsert_raw(writer, scope=scope, key=key, endpoint=endpoint, payload=second, library_version='second', now_ms=2)
            with store.transaction(writer):
                writer.execute('insert into garmin.activity(user_id,connection_id,activity_id,day_key,start_ms,duration_s) values (%s,%s,%s,%s,%s,%s)', (*account[:2], 77, DAY, 1767312000000, 1))
            with self.envelope(account):
                notes = []
                snapshot = report_input._snapshot(CFG, REPORT_DAY, 1767398400000, notes)
            self.assertEqual(notes, [])
            self.assertEqual(snapshot[0][DAY]['sleep_data'], {'marker': 'day-second'})
            self.assertEqual(snapshot[1]['77']['activity'], {'marker': 'activity-second'})
            with psycopg.connect(self.ext_dsn) as reader:
                rows = reader.execute('select scope,key,endpoint,raw from garmin.raw_response where user_id=%s and connection_id=%s order by scope', account[:2]).fetchall()
            self.assertEqual({(scope, key, endpoint): json.loads(raw) for scope, key, endpoint, raw in rows},
                             {('day', DAY, 'sleep_data'): {'marker': 'day-first'},
                              ('activity', '77', 'activity'): {'marker': 'activity-first'}})
        finally:
            writer.close()

    def test_real_sequential_and_simultaneous_append_latest(self):
        account=self.accounts[0]; first=self.writer(account); second=self.writer(account)
        try:
            self.assertEqual(self.append(first,DAY,'day','first'),1)
            self.assertEqual(self.append(second,DAY,'day','second'),2)
            barrier=threading.Barrier(2,timeout=5)
            def append_parallel(conn,text):
                barrier.wait()
                return text,self.append(conn,DAY,'day',text)
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
                futures=[pool.submit(append_parallel,first,'parallel-a'),pool.submit(append_parallel,second,'parallel-b')]
                results=[f.result(timeout=10) for f in futures]
            self.assertEqual(sorted(revision for _,revision in results),[3,4])
            with self.envelope(account):
                reader=store.read_connection(None)
                try: latest=store.latest_evaluation(reader,report_date=DAY,scope='day')
                finally: reader.close()
            self.assertEqual((latest[2],latest[6],latest[9]),(dict((rev,text) for text,rev in results)[4], 'report '+dict((rev,text) for text,rev in results)[4],4))
            with psycopg.connect(self.ext_dsn) as ext:
                rows=ext.execute('select revision,summary,report_md from garmin.evaluation_revisions where user_id=%s and connection_id=%s and report_date=%s and scope=%s order by revision',(*account[:2],DAY,'day')).fetchall()
            self.assertEqual(rows[:2],[(1,'first','report first'),(2,'second','report second')])
            self.assertEqual({(summary,body) for _,summary,body in rows[2:]},{('parallel-a','report parallel-a'),('parallel-b','report parallel-b')})
        finally: first.close(); second.close()

    def test_real_immutable_raw_and_evaluation_triggers(self):
        account=self.accounts[0]; writer=self.writer(account)
        try:
            store.upsert_raw(writer,scope='day',key=DAY,endpoint='sleep_data',payload={'synthetic':1},library_version='fixture',now_ms=1)
            self.assertEqual(self.append(writer,DAY,'day','immutable'),1)
        finally: writer.close()
        statements=[
            ("update garmin.raw_response set raw='{}' where user_id=%s and connection_id=%s and scope='day' and key=%s",(*account[:2],DAY)),
            ("delete from garmin.raw_response where user_id=%s and connection_id=%s and scope='day' and key=%s",(*account[:2],DAY)),
            ("update garmin.evaluation_revisions set summary='changed' where user_id=%s and connection_id=%s and report_date=%s",(*account[:2],DAY)),
            ("delete from garmin.evaluation_revisions where user_id=%s and connection_id=%s and report_date=%s",(*account[:2],DAY)),
        ]
        with psycopg.connect(self.ext_dsn,autocommit=True) as ext:
            for sql,args in statements:
                with self.subTest(sql=sql):
                    with self.assertRaisesRegex(psycopg.errors.RaiseException,'immutable Garmin native row'):
                        with ext.transaction(): ext.execute(sql,args)
                    with ext.transaction():
                        self.assertEqual(json.loads(ext.execute('select raw from garmin.raw_response where user_id=%s and connection_id=%s and key=%s',(*account[:2],DAY)).fetchone()[0]),{'synthetic':1})
                        self.assertEqual(ext.execute('select revision,summary,report_md from garmin.evaluation_revisions where user_id=%s and connection_id=%s and report_date=%s',(*account[:2],DAY)).fetchall(),[(1,'immutable','report immutable')])

    def test_read_connection_holds_real_repeatable_read_snapshot(self):
        account=self.accounts[0]; writer=self.writer(account)
        try:
            with store.transaction(writer):
                writer.execute('insert into garmin.daily_metric(user_id,connection_id,day_key,steps) values (%s,%s,%s,%s)',(*account[:2],DAY,10))
            with self.envelope(account):
                reader=store.read_connection(None)
                try:
                    sql='select steps from garmin.daily_metric where user_id=%s and connection_id=%s and day_key=%s'
                    self.assertEqual(reader.execute(sql,(*account[:2],DAY)).fetchone(),(10,))
                    with store.transaction(writer):
                        writer.execute('update garmin.daily_metric set steps=%s where user_id=%s and connection_id=%s and day_key=%s',(20,*account[:2],DAY))
                    self.assertEqual(reader.execute(sql,(*account[:2],DAY)).fetchone(),(10,))
                finally: reader.close()
                newer=store.read_connection(None)
                try: self.assertEqual(newer.execute(sql,(*account[:2],DAY)).fetchone(),(20,))
                finally: newer.close()
        finally: writer.close()

    def test_scoped_readers_joins_subqueries_and_writes_with_three_accounts(self):
        for index,account in enumerate(self.accounts,1):
            writer=self.writer(account)
            try:
                store.upsert_raw(writer,scope='day',key=DAY,endpoint='sleep_data',
                    payload={'synthetic_marker':index},library_version='fixture',now_ms=1767312000000+index)
                store.upsert_raw(writer,scope='activity',key='77',endpoint='activity',
                    payload={'synthetic_marker':index},library_version='fixture',now_ms=1767312000000+index)
                self.assertEqual(self.append(writer,DAY,'day',f'day-{index}'),1)
                self.assertEqual(self.append(writer,DAY,'30d',f'month-{index}'),1)
                if index==2: self.assertEqual(self.append(writer,'2026-01-02','30d','month-2-later'),1)
                with store.transaction(writer):
                    writer.execute('insert into garmin.run(user_id,connection_id,local_date,started_at,finished_at,status,detail) values (%s,%s,%s,%s,%s,%s,%s)',(*account[:2],DAY,1767312000000,1767312000001,'success',f'run-{index}'))
                    writer.execute('insert into garmin.activity(user_id,connection_id,activity_id,day_key,start_ms,duration_s) values (%s,%s,%s,%s,%s,%s)',(*account[:2],77,DAY,1767312000000,1))
                    writer.execute('insert into garmin.workout(user_id,connection_id,activity_id,date,start_ms,duration_s) values (%s,%s,%s,%s,%s,%s)',(*account[:2],77,DAY,1767312000000,index))
                    writer.execute('insert into garmin.exercise_log(user_id,connection_id,activity_id,exercise,sets,max_kg,volume_kg) values (%s,%s,%s,%s,%s,%s,%s)',(*account[:2],77,'squat',index,index*10,index*100))
                    writer.execute('insert into garmin.exercise_log_order(user_id,connection_id,activity_id,exercise,source_order) values (%s,%s,%s,%s,%s)',(*account[:2],77,'squat',1))
                    writer.execute('insert into garmin.day_summary(user_id,connection_id,date,steps) values (%s,%s,%s,%s)',(*account[:2],DAY,index*100))
                    writer.execute('insert into garmin.hr_sample(user_id,connection_id,day_key,ts_ms,bpm) values (%s,%s,%s,%s,%s)',(*account[:2],DAY,1767312000000,index*10))
            finally: writer.close()
        for index,account in enumerate(self.accounts,1):
            with self.subTest(account=index), self.envelope(account):
                conn=store.read_connection(None)
                try:
                    self.assertEqual(store.latest_evaluation(conn,report_date=DAY,scope='day')[2],f'day-{index}')
                    self.assertEqual(coverage.day_status(conn,date.fromisoformat(DAY)).detail,f'run-{index}')
                    item=next(item for item in coverage.items(conn,CFG,date.fromisoformat(DAY),date.fromisoformat(DAY)) if item.endpoint=='sleep_data')
                    self.assertEqual((item.state,item.checked_at),(coverage.CoverageState.DATA,1767312000000+index))
                    self.assertEqual(charts._samples(conn,CFG,'hr_sample','bpm',1767311999999,1767312000001),[[1767312000000,index*10]])
                    strength=charts._read_strength(conn,REPORT_DAY)['items']
                    self.assertEqual(strength,[{'label':'squat','days':[{'day_key':DAY,'sets':index,'best_weight_kg':float(index*10),'volume_kg':float(index*100)}]}])
                finally: conn.close()
                snapshot=report_input._snapshot(CFG,REPORT_DAY,1767398400000,[])
                self.assertEqual(snapshot[0][DAY]['sleep_data'],{'synthetic_marker':index})
                self.assertEqual(snapshot[1]['77']['activity'],{'synthetic_marker':index})
                with tempfile.TemporaryDirectory(prefix='garmin-scoped-') as tmp:
                    folder=Path(tmp)
                    (folder/'manifest.json').write_text(json.dumps({'period_windows':{'all':{'from':'2025-12-01','to':'2026-01-02'}},'months':['2025-12','2026-01'],'data_cutoff':'2026-01-02T00:00:00+00:00'}))
                    result=report_input.build_period(CFG,folder,REPORT_DAY,'all')
                    evaluations=json.loads((result/'evaluations.json').read_text())
                    self.assertEqual([e['summary'] for e in evaluations],['month-2-later' if index==2 else f'month-{index}'])
                    values=json.loads((result/'day_values.json').read_text())
                    self.assertEqual(values['months'][0]['steps'],index*100)
                    self.assertEqual(values['exercises'][0]['volume_kg'],index*100)
        with psycopg.connect(self.ext_dsn) as ext:
            rows=ext.execute("select user_id,connection_id,raw from garmin.raw_response where user_id=any(%s) and scope='day' and key=%s and endpoint='sleep_data'",([self.user,self.other_user],DAY)).fetchall()
            self.assertEqual({(user,connection,json.loads(raw)['synthetic_marker']) for user,connection,raw in rows},{(account[0],account[1],index) for index,account in enumerate(self.accounts,1)})
