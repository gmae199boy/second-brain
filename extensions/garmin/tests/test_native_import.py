"""Synthetic native copy contracts; intentionally not executed until 21.8."""
import contextlib
import json
import os
import sqlite3
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import native_import as native
import reader
from contract import BY_VERSION

USER = UUID('00000000-0000-4000-8000-000000000001')
ACCOUNT = UUID('00000000-0000-4000-8000-000000000002')

class Cursor:
    def __init__(self): self.calls = []; self.result = None
    def execute(self, sql, args=()):
        self.calls.append((sql, args))
        if sql.startswith('select activity_id,exercise'):
            self.result = (7, 'synthetic')
        elif 'select source_dataset,source_batch,source_rowid from garmin.exercise_log_order' in sql:
            self.result = None
        elif 'select 1 from garmin.exercise_log_order' in sql:
            self.result = None
        return self
    def fetchone(self): return self.result

class NativeTest(unittest.TestCase):
    def test_schema16_reader_and_final_contract(self):
        conn = sqlite3.connect(':memory:')
        self.addCleanup(conn.close)
        conn.execute('pragma user_version=16')
        conn.execute('create table exercise_log(activity_id integer, exercise text, primary key(activity_id,exercise))')
        conn.execute("insert into exercise_log(rowid,activity_id,exercise) values (12,7,'synthetic')")
        result = reader.read_connection(conn)
        self.assertEqual(result['schema'], 16)
        self.assertEqual(result['tables']['exercise_log']['rowids'], [12])
        self.assertIn('evaluation', BY_VERSION[16])
        self.assertNotIn('activity_recovery', BY_VERSION[16])

    def test_user_and_timezone_validation(self):
        settings = {'user_id': str(USER), 'values': {'garmin.timezone': 'Asia/Seoul'}}
        with patch.dict(os.environ, {'BRAIN_USER_ID': str(USER)}, clear=True):
            self.assertEqual(native.envelope(settings), (USER, 'Asia/Seoul'))
            for zone in ('', 'not/a-real-zone', None):
                with self.assertRaises(ValueError): native.envelope({'user_id': str(USER), 'values': {'garmin.timezone': zone}})
            with self.assertRaises(ValueError): native.envelope({'user_id': str(ACCOUNT), 'values': settings['values']})
            with self.assertRaises(ValueError): native.envelope({'user_id': str(USER), 'values': {}})

    def test_invalid_text_and_blob_are_not_replaced(self):
        for value in (reader.InvalidSQLiteText(b'\xff','utf-8'), 'bad\0text', b'blob', float('nan')):
            with self.assertRaises((ValueError, UnicodeError)): native.clean(value)
        self.assertIsNone(native.clean(None))

    def test_exercise_row_and_source_rowid_written_in_same_unit(self):
        cur = Cursor(); table = {'columns':['activity_id','exercise'], 'keys':['activity_id','exercise']}
        native._copy_row(cur, USER, ACCOUNT, 'exercise_log', table, {'activity_id':7,'exercise':'synthetic'}, ('dataset','batch',12))
        inserts = [(sql,args) for sql,args in cur.calls if sql.startswith('insert into')]
        self.assertEqual(len(inserts),2)
        self.assertIn('garmin.exercise_log_order', inserts[1][0])
        self.assertEqual(inserts[1][1][4:7],('dataset','batch',12))
        self.assertEqual(inserts[0][1][:2], [USER, ACCOUNT])

    def test_existing_native_value_mismatch_blocks(self):
        cur = Cursor(); table = {'columns':['activity_id','exercise'], 'keys':['activity_id','exercise']}
        with self.assertRaisesRegex(ValueError, 'IMPORT_CONFLICT'):
            native._copy_row(cur, USER, ACCOUNT, 'exercise_log', table, {'activity_id':8,'exercise':'other'}, ('dataset','batch',2))

    def test_manifest_requires_explicit_timezone(self):
        manifest=json.loads((Path(__file__).resolve().parents[1]/'manifest.json').read_text())
        setting=next(s for s in manifest['settings'] if s['key']=='garmin.timezone')
        self.assertEqual(setting['scope'],'user')
        self.assertNotIn('default',setting)
        for kind in ('garmin.import','garmin.import_verify'):
            self.assertIn('garmin.timezone',next(w for w in manifest['work'] if w['kind']==kind)['required_settings'])

class MemoryConnection:
    """Minimal transactional ledger for exercising native crash boundaries."""
    def __init__(self): self.checkpoints={}; self.mappings={}; self.rows={}; self.result=None
    @contextlib.contextmanager
    def transaction(self):
        import copy
        before=copy.deepcopy((self.checkpoints,self.mappings,self.rows))
        try: yield self
        except BaseException:
            self.checkpoints,self.mappings,self.rows=before
            raise
    def cursor(self, **kwargs): return self
    def execute(self, sql, args=()):
        if sql.startswith('select source_hash,schema_version'):
            self.result=self.checkpoints.get(tuple(args))
        elif sql.startswith('insert into garmin.native_import_checkpoints'):
            self.checkpoints[tuple(args[:4])]=tuple(args[4:])
        elif sql.startswith('select native_key,content_hash'):
            self.result=self.mappings.get(tuple(args))
        elif sql.startswith('insert into garmin.native_import_mapping'):
            self.mappings[tuple(args[:5])]=tuple(args[-2:])
        elif sql.startswith('update garmin.native_import_checkpoints'):
            pass
        else: raise AssertionError(sql)
        return self
    def fetchone(self): return self.result

class NativeResumeTest(unittest.TestCase):
    def test_crash_before_and_after_row_commit_replays_without_duplication(self):
        conn=MemoryConnection(); settings={'user_id':str(USER),'values':{'garmin.timezone':'Asia/Seoul'}}
        capture={'private':{'capture_id':'synthetic','fingerprint':'synthetic'}}
        row={'key':'synthetic','value':None}; table={'columns':['key','value'],'keys':['key'],'rows':[row],'rowids':[1]}
        verified={'d':{'sha256':'hash','snapshot':{'schema':16,'tables':{'meta':table}}}}
        entries=[{'dataset':'d'}]
        def write(cur,user,connection,name,table,row,source_order):
            key=(user,connection,name,row['key'])
            if key in conn.rows and conn.rows[key]!=row: raise ValueError('IMPORT_CONFLICT')
            conn.rows[key]=dict(row)
        for stop in ('before','after'):
            conn=MemoryConnection(); reached=[]
            def seam(stage,*_args):
                if stage==stop and not reached:
                    reached.append(stage); raise RuntimeError('synthetic crash')
            with patch.dict(os.environ,{'BRAIN_USER_ID':str(USER)},clear=True), \
                 patch.object(native,'account',return_value={'confirmed':True,'account':'profile'}), \
                 patch.object(native,'account_locks',side_effect=lambda *_: contextlib.nullcontext()), patch.object(native,'_connect_account',return_value=ACCOUNT), \
                 patch.object(native,'check'), patch.object(native,'conflict',side_effect=ValueError('IMPORT_CONFLICT')), \
                 patch.object(native,'_copy_row',side_effect=write), \
                 patch.dict(native.BY_VERSION,{16:{'meta':['key','value']}}):
                with self.assertRaises(RuntimeError): native.copy(conn,capture,entries,verified,settings,seam)
                self.assertEqual(len(conn.rows), 0 if stop=='before' else 1)
                native.copy(conn,capture,entries,verified,settings)
                self.assertEqual(len(conn.rows),1)
                self.assertEqual(len(conn.mappings),1)
                changed={**verified,'d':{**verified['d'],'sha256':'changed'}}
                with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                    native.copy(conn,capture,entries,changed,settings)

    def test_different_local_ids_do_not_silently_overwrite(self):
        conn=MemoryConnection(); settings={'user_id':str(USER),'values':{'garmin.timezone':'UTC'}}
        capture={'private':{'capture_id':'synthetic','fingerprint':'synthetic'}}
        def snapshot(status):
            return {'schema':16,'tables':{'run':{'columns':['id','status'],'keys':['id'],
                'rows':[{'id':1,'status':status}],'rowids':[1]}}}
        entries=[{'dataset':'production'},{'dataset':'development'}]
        verified={'production':{'sha256':'a','snapshot':snapshot('success')},
                  'development':{'sha256':'b','snapshot':snapshot('error')}}
        with patch.dict(os.environ,{'BRAIN_USER_ID':str(USER)},clear=True), \
             patch.object(native,'account',return_value={'confirmed':True,'account':'profile'}), \
             patch.object(native,'account_locks',side_effect=lambda *_: contextlib.nullcontext()), patch.object(native,'_connect_account',return_value=ACCOUNT), patch.object(native,'check'), \
             patch.object(native,'_copy_row'), patch.object(native,'conflict',side_effect=ValueError('IMPORT_CONFLICT')), \
             patch.dict(native.BY_VERSION,{16:{'run':['id','status']}}):
            with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                native.copy(conn,capture,entries,verified,settings)

    def test_stale_attempt_stops_before_copy(self):
        conn=MemoryConnection(); settings={'user_id':str(USER),'values':{'garmin.timezone':'UTC'}}
        capture={'private':{'capture_id':'synthetic','fingerprint':'synthetic'}}
        table={'columns':['key','value'],'keys':['key'],'rows':[{'key':'x','value':None}],'rowids':[1]}
        verified={'d':{'sha256':'a','snapshot':{'schema':16,'tables':{'meta':table}}}}
        with patch.dict(os.environ,{'BRAIN_USER_ID':str(USER)},clear=True), \
             patch.object(native,'account',return_value={'confirmed':True,'account':'profile'}), \
             patch.object(native,'account_locks',side_effect=lambda *_: contextlib.nullcontext()), patch.object(native,'_connect_account',return_value=ACCOUNT), \
             patch.object(native,'check',side_effect=ValueError('IMPORT_INVALID')), \
             patch.object(native,'_copy_row') as write, patch.dict(native.BY_VERSION,{16:{'meta':['key','value']}}):
            with self.assertRaisesRegex(ValueError,'IMPORT_INVALID'):
                native.copy(conn,capture,[{'dataset':'d'}],verified,settings)
            write.assert_not_called()

class NativeOrderAndLockIntegrationTest(unittest.TestCase):
    """Real isolated PG connections; executions are deferred to ticket 21.8."""
    def test_two_sources_with_same_rowid_keep_order_and_resume(self):
        import hashlib
        import psycopg
        from batch_import import contract_fingerprint
        from uuid import uuid4
        uid = None
        profile = 'synthetic-' + uuid4().hex
        datasets = [profile + '-production', profile + '-development']
        raw_fingerprint = 'synthetic-fingerprint'
        capture = {'private': {'capture_id': profile, 'fingerprint': contract_fingerprint(raw_fingerprint)}}
        rows = [{'activity_id': 100, 'exercise': 'first'}, {'activity_id': 101, 'exercise': 'second'}]
        def table(row): return {'columns':['activity_id','exercise'],'keys':['activity_id','exercise'],'rows':[row],'rowids':[17]}
        entries = [{'dataset':name} for name in datasets]
        verified = {name:{'sha256':str(i),'snapshot':{'schema':16,'tables':{'exercise_log':table(rows[i])}}} for i,name in enumerate(datasets)}
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'], autocommit=True) as owner:
            uid = owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            for name in datasets:
                batch = hashlib.sha256(native.canonical([profile,name]).encode()).hexdigest()
                owner.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,true)',(name,profile))
                owner.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,now())',(batch,name))
            settings={'user_id':str(uid),'values':{'garmin.timezone':'UTC'}}
            try:
                with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as ext, \
                     patch.dict(os.environ,{'BRAIN_USER_ID':str(uid),'BRAIN_ACCOUNT':profile},clear=False), \
                     patch.object(native,'account',return_value={'confirmed':True,'account':profile}), \
                     patch.object(native,'check'), patch.dict(native.BY_VERSION,{16:{'exercise_log':['activity_id','exercise']}}):
                    native.copy(ext,capture,entries,verified,settings)
                    native.copy(ext,capture,entries,verified,settings)
                    connection=ext.execute('select connection_id from garmin.account_connections where user_id=%s and external_identity=%s',(uid,profile)).fetchone()[0]
                    ext.commit()
                    actual=ext.execute('select activity_id,exercise,source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order',(uid,connection)).fetchall()
                    self.assertEqual(actual,[(100,'first',1,datasets[0],hashlib.sha256(native.canonical([profile,datasets[0]]).encode()).hexdigest(),17),(101,'second',2,datasets[1],hashlib.sha256(native.canonical([profile,datasets[1]]).encode()).hexdigest(),17)])
                    verify_capture={'private':{'capture_id':profile,'fingerprint':raw_fingerprint}}
                    self.assertTrue(native.verify(ext,verify_capture,entries,verified,settings))
                    ext.rollback()
            finally:
                owner.execute('delete from garmin.native_import_mapping where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.native_import_checkpoints where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.exercise_log where user_id=%s and connection_id in (select connection_id from garmin.account_connections where user_id=%s and external_identity=%s)',(uid,uid,profile))
                owner.execute('delete from garmin.account_connections where user_id=%s and external_identity=%s',(uid,profile))
                owner.execute('delete from garmin.import_batches where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.datasets where dataset=any(%s)',(datasets,))

    def test_new_capture_publishes_selected_prefix_atomically_and_resumes(self):
        import hashlib
        import psycopg
        from batch_import import contract_fingerprint
        from uuid import uuid4
        profile='synthetic-'+uuid4().hex
        datasets=[profile+'-production',profile+'-development']
        captures=[profile+'-first',profile+'-second']
        fingerprint='synthetic-fingerprint'
        entries=[{'dataset':name} for name in datasets]
        def table(items):
            return {'columns':['activity_id','exercise'],'keys':['activity_id','exercise'],
                    'rows':[{'activity_id':n,'exercise':name} for n,name,_ in items],
                    'rowids':[rowid for _,_,rowid in items]}
        def sources(include_new):
            return {datasets[0]:{'sha256':'new' if include_new else 'old','snapshot':{'schema':16,'tables':{'exercise_log':table([(100,'A',17)]+([(102,'C',18)] if include_new else [(103,'D',19)]))}}},
                    datasets[1]:{'sha256':'other','snapshot':{'schema':16,'tables':{'exercise_log':table([(101,'B',17)])}}}}
        def capture(index, copy=False):
            return {'private':{'capture_id':captures[index], 'fingerprint':contract_fingerprint(fingerprint) if copy else fingerprint}}
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'],autocommit=True) as owner:
            uid=owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            for dataset in datasets:
                owner.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,true)',(dataset,profile))
                for capture_id in captures:
                    batch=hashlib.sha256(native.canonical([capture_id,dataset]).encode()).hexdigest()
                    owner.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,now())',(batch,dataset))
            settings={'user_id':str(uid),'values':{'garmin.timezone':'UTC'}}
            try:
                with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as ext, \
                     patch.dict(os.environ,{'BRAIN_USER_ID':str(uid),'BRAIN_ACCOUNT':profile},clear=False), \
                     patch.object(native,'account',return_value={'confirmed':True,'account':profile}), \
                     patch.object(native,'check'), patch.dict(native.BY_VERSION,{16:{'exercise_log':['activity_id','exercise']}}):
                    native.copy(ext,capture(0,True),entries,sources(False),settings)
                    connection=ext.execute('select connection_id from garmin.account_connections where user_id=%s and external_identity=%s',(uid,profile)).fetchone()[0]
                    ext.commit()
                    def order():
                        result=ext.execute('select exercise,source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order',(uid,connection)).fetchall()
                        ext.commit()
                        return result
                    batch=lambda i,d: hashlib.sha256(native.canonical([captures[i],d]).encode()).hexdigest()
                    old=[('A',1,datasets[0],batch(0,datasets[0]),17),('D',2,datasets[0],batch(0,datasets[0]),19),('B',3,datasets[1],batch(0,datasets[1]),17),('C',4,datasets[0],batch(1,datasets[0]),18)]
                    for stop in ('before_order_publish','during_order_publish'):
                        def seam(stage,*args):
                            if stage==stop:
                                if stage=='during_order_publish':
                                    with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as observer:
                                        visible=observer.execute('select exercise,source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order',(uid,connection)).fetchall()
                                        self.assertEqual(visible,old)
                                raise RuntimeError('synthetic interruption')
                        with self.assertRaisesRegex(RuntimeError,'synthetic interruption'):
                            native.copy(ext,capture(1,True),entries,sources(True),settings,seam)
                        self.assertEqual(order(),old)
                        self.assertFalse(native.verify(ext,capture(1),entries,sources(True),settings))
                        ext.rollback()
                    native.copy(ext,capture(1,True),entries,sources(True),settings)
                    expected=[('A',1,datasets[0],batch(1,datasets[0]),17),('C',2,datasets[0],batch(1,datasets[0]),18),('B',3,datasets[1],batch(1,datasets[1]),17),('D',4,datasets[0],batch(0,datasets[0]),19)]
                    self.assertEqual(order(),expected)
                    self.assertTrue(native.verify(ext,capture(1),entries,sources(True),settings))
                    ext.rollback()
                    native.copy(ext,capture(1,True),entries,sources(True),settings)
                    self.assertEqual(order(),expected)
            finally:
                owner.execute('delete from garmin.native_import_mapping where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.native_import_checkpoints where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.exercise_log where user_id=%s and connection_id in (select connection_id from garmin.account_connections where user_id=%s and external_identity=%s)',(uid,uid,profile))
                owner.execute('delete from garmin.account_connections where user_id=%s and external_identity=%s',(uid,profile))
                owner.execute('delete from garmin.import_batches where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.datasets where dataset=any(%s)',(datasets,))

    def test_snapshot_rowid_reuse_keeps_historical_suffix_and_recovers(self):
        import hashlib
        import psycopg
        from batch_import import contract_fingerprint
        from uuid import uuid4
        profile='synthetic-'+uuid4().hex
        datasets=[profile+'-production',profile+'-development']
        captures=[profile+'-'+str(i) for i in range(4)]
        entries=[{'dataset':name} for name in datasets]
        fingerprint='synthetic-reuse'
        def batch(i,dataset):
            return hashlib.sha256(native.canonical([captures[i],dataset]).encode()).hexdigest()
        def capture(i, copying=False):
            return {'private':{'capture_id':captures[i], 'fingerprint':contract_fingerprint(fingerprint) if copying else fingerprint}}
        def table(items):
            return {'columns':['activity_id','exercise'],'keys':['activity_id','exercise'],
                    'rows':[{'activity_id':n,'exercise':name} for n,name,_ in items],
                    'rowids':[rowid for _,_,rowid in items]}
        def sources(i):
            production=[[(100,'A',17)],[(102,'C',17),(100,'A',18)],[(103,'D',17),(100,'A',18)],[(102,'C',17),(100,'A',18)]][i]
            return {datasets[0]:{'sha256':'snapshot-'+str(i),'snapshot':{'schema':16,'tables':{'exercise_log':table(production)}}},
                    datasets[1]:{'sha256':'same','snapshot':{'schema':16,'tables':{'exercise_log':table([(101,'B',17)])}}}}
        with psycopg.connect(os.environ['GARMIN_TEST_OWNER_DSN'],autocommit=True) as owner:
            uid=owner.execute('select id from brain.users where is_self=1').fetchone()[0]
            work,token=uuid4(),uuid4()
            owner.execute("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values (%s,'garmin.import','synthetic',%s,now(),now(),'supervised',now(),now()+interval '1 hour','fixture')",(work,str(work)))
            owner.execute('insert into brain.work_attempts(token,work_item_id,started_at) values (%s,%s,now())',(token,work))
            owner.execute('update brain.work_items set current_attempt_token=%s where id=%s',(token,work))
            for dataset in datasets:
                owner.execute('insert into garmin.datasets(dataset,account,account_confirmed) values (%s,%s,true)',(dataset,profile))
                for i in range(4):
                    owner.execute('insert into garmin.import_batches(id,dataset,imported_at) values (%s,%s,now())',(batch(i,dataset),dataset))
            settings={'user_id':str(uid),'values':{'garmin.timezone':'UTC'}}
            try:
                with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as ext, \
                     patch.dict(os.environ,{'BRAIN_USER_ID':str(uid),'BRAIN_ACCOUNT':profile,'BRAIN_WORK_ID':str(work),'BRAIN_ATTEMPT_TOKEN':str(token)},clear=False), \
                     patch.object(native,'account',return_value={'confirmed':True,'account':profile}), \
                     patch.object(native,'check'), patch.dict(native.BY_VERSION,{16:{'exercise_log':['activity_id','exercise']}}):
                    native.copy(ext,capture(0,True),entries,sources(0),settings)
                    native.copy(ext,capture(1,True),entries,sources(1),settings)
                    self.assertTrue(native.verify(ext,capture(1),entries,sources(1),settings)); ext.rollback()
                    native.copy(ext,capture(2,True),entries,sources(2),settings)
                    connection=ext.execute('select connection_id from garmin.account_connections where user_id=%s and external_identity=%s',(uid,profile)).fetchone()[0]
                    ext.commit()
                    def order(conn):
                        return conn.execute('select exercise,source_order,source_dataset,source_batch,source_rowid from garmin.exercise_log_order where user_id=%s and connection_id=%s order by source_order',(uid,connection)).fetchall()
                    old=[('D',1,datasets[0],batch(2,datasets[0]),17),('A',2,datasets[0],batch(2,datasets[0]),18),('B',3,datasets[1],batch(2,datasets[1]),17),('C',4,datasets[0],batch(1,datasets[0]),17)]
                    for stop in ('before_order_publish','during_order_publish'):
                        def seam(stage,*_):
                            if stage==stop:
                                if stage=='during_order_publish':
                                    with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN']) as observer:
                                        self.assertEqual(order(observer),old)
                                raise RuntimeError('synthetic interruption')
                        with self.assertRaisesRegex(RuntimeError,'synthetic interruption'):
                            native.copy(ext,capture(3,True),entries,sources(3),settings,seam)
                        self.assertEqual(order(ext),old); ext.commit()
                        self.assertFalse(native.verify(ext,capture(3),entries,sources(3),settings)); ext.rollback()
                    native.copy(ext,capture(3,True),entries,sources(3),settings)
                    expected=[('C',1,datasets[0],batch(3,datasets[0]),17),('A',2,datasets[0],batch(3,datasets[0]),18),('B',3,datasets[1],batch(3,datasets[1]),17),('D',4,datasets[0],batch(2,datasets[0]),17)]
                    self.assertEqual(order(ext),expected); ext.commit()
                    self.assertTrue(native.verify(ext,capture(3),entries,sources(3),settings)); ext.rollback()
                    native.copy(ext,capture(3,True),entries,sources(3),settings)
                    self.assertEqual(order(ext),expected); ext.commit()
                    changed=sources(3); changed[datasets[0]]['sha256']='tampered'
                    with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                        native.copy(ext,capture(3,True),entries,changed,settings)
                    self.assertEqual(order(ext),expected); ext.commit()
            finally:
                owner.execute('delete from garmin.native_import_mapping where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.native_import_checkpoints where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.exercise_log where user_id=%s and connection_id in (select connection_id from garmin.account_connections where user_id=%s and external_identity=%s)',(uid,uid,profile))
                owner.execute('delete from garmin.account_connections where user_id=%s and external_identity=%s',(uid,profile))
                owner.execute('delete from garmin.import_batches where dataset=any(%s)',(datasets,))
                owner.execute('delete from garmin.datasets where dataset=any(%s)',(datasets,))

    def test_import_and_writer_share_session_lock_across_transactions(self):
        import psycopg
        from garmin_pipeline import store
        from uuid import uuid4
        uid, connection = uuid4(), uuid4()
        key = store.account_write_lock_key(uid,connection)
        with psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'],autocommit=True) as importer, \
             psycopg.connect(os.environ['GARMIN_TEST_EXTENSION_DSN'],autocommit=True) as writer:
            capture={'private':{'capture_id':'lock-test'}}
            entries=[{'dataset':'d'}]; verified={'d':{'snapshot':{}}}
            settings={'user_id':str(uid),'values':{'garmin.timezone':'UTC'}}
            wrapped = store.Connection(writer, store.AccountContext(uid, connection, uuid4(), uuid4()), readonly=False)
            with patch.dict(os.environ,{'BRAIN_USER_ID':str(uid),'BRAIN_ACCOUNT':'profile'},clear=False), \
                 patch.object(native,'account',return_value={'confirmed':True,'account':'profile'}), \
                 patch.object(native,'_connect_account',return_value=connection):
                with self.assertRaisesRegex(RuntimeError,'abort'):
                    with native.account_locks(importer,capture,entries,verified,settings):
                        with importer.transaction(): importer.execute('select 1')
                        self.assertFalse(store._try_lock(wrapped,'write',transaction=False))
                        raise RuntimeError('abort')
                self.assertTrue(store._try_lock(wrapped,'write',transaction=False))
                writer.execute('select pg_advisory_unlock(hashtextextended(%s,0))',(key,))
