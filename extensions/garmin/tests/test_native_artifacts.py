"""Synthetic file request and revision-link contracts; not executed before 21.8."""
import contextlib
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'src'))
import native_artifacts as native

USER=UUID('00000000-0000-4000-8000-000000000001')
CONN=UUID('00000000-0000-4000-8000-000000000002')
FILE=UUID('00000000-0000-4000-8000-000000000003')

class Cursor:
    def __init__(self): self.mapping=None; self.status='pending'; self.link=None; self.result=None; self.inserted=[]; self.unassigned=None; self.conflicts=[]; self.selected=True
    @contextlib.contextmanager
    def transaction(self): yield self
    def cursor(self, **kwargs): return self
    def __enter__(self): return self
    def __exit__(self,*args): return False
    def execute(self, sql, args=()):
        self.result=None
        if sql.startswith('select request_id,content_hash,request_batch,created_at'):
            self.result=self.unassigned
        elif sql.startswith('insert into garmin.unassigned_file_requests'):
            self.unassigned=(args[3],args[4],args[5],'2026-01-01')
        elif sql.startswith('select target_id,content_hash,batch'):
            self.result=self.mapping
        elif sql.startswith('select status,file_id'):
            self.result=(self.status,FILE if self.status=='completed' else None) if self.mapping or self.unassigned else None
        elif sql.startswith('insert into garmin.import_mapping'):
            self.mapping=(args[4],args[5],args[6])
        elif sql.startswith('select imported_at'):
            self.result=('2026-01-01',)
        elif sql.startswith('insert into brain.file_requests'):
            self.inserted.append(args)
        elif sql.startswith('select native_key from garmin.native_import_mapping'):
            self.result=('["2026-01-02","day"]',) if self.selected else None
        elif sql.startswith('insert into garmin.evaluation_files'):
            self.link=(args[-2],args[-1],None)
        elif sql.startswith('select kind,original_path_hash,file_id'):
            self.result=self.link
        elif sql.startswith('update garmin.evaluation_files'):
            if self.link: self.link=(*self.link[:2],args[0])
        elif sql.startswith('select connection_id,report_date,scope,revision,kind,original_path_hash,file_id'):
            self.result=[(CONN,'2026-01-02','day',1,*self.link)] if self.link else []
        elif sql.startswith('insert into garmin.import_conflicts'):
            self.conflicts.append(args)
        elif sql.startswith('select count(*) from garmin.evaluation_files'):
            self.result=(0,)
        elif 'pg_advisory' in sql: pass
        else: raise AssertionError(sql)
        return self
    def fetchone(self): return self.result
    def fetchall(self): return self.result

class NativeArtifactsTest(unittest.TestCase):
    def inputs(self):
        table={'keys':['report_date','scope'],'rows':[{'report_date':'2026-01-02','scope':'day','report_md':'synthetic'}]}
        capture={'private':{'capture_id':'synthetic','version':2,'root':'/synthetic','files':[]}}
        entries=[{'dataset':'d','dataset_label':None}]
        verified={'d':{'snapshot':{'tables':{'evaluation':table,'raw_response':{'rows':[{'raw':'{\"userProfileId\":1}'}]}}}}}
        return capture,entries,verified

    def test_neutral_metadata_and_original_evaluation_provenance(self):
        capture,entries,verified=self.inputs()
        specs,_=native.plan(capture,entries,verified)
        self.assertEqual(specs[0]['data'],b'synthetic')
        metadata=specs[0]['metadata']
        self.assertEqual((metadata['kind'],metadata['report_date'],metadata['scope']),('report','2026-01-02','day'))
        self.assertEqual(len(metadata['original_path_hash']),64)
        self.assertNotIn('synthetic',str(metadata))
        self.assertEqual(specs[0]['candidates'][0][0],'d')

    def test_explicit_relation_and_unknown_provenance(self):
        capture,entries,verified=self.inputs()
        capture['private']['files']=[
            {'dataset':'d','artifact_key':'report','category':'report','source':'reports/day.md','snapshot':'r','bytes':1,'report_date':'2026-01-02','scope':'day'},
            {'dataset':'d','artifact_key':'graph','category':'image','source':'reports/g.png','snapshot':'g','bytes':1,'relations':[{'analysis_key':'report','role':'image'}]},
            {'dataset':'d','artifact_key':'unknown','category':'facts','source':'facts/x.json','snapshot':'f','bytes':1}]
        with patch.object(native,'read_relative',return_value=(b'x','hash')):
            specs,_=native.plan(capture,entries,verified)
        by_key={s['key']:s for s in specs if s['table']=='artifact'}
        self.assertEqual(by_key['graph']['metadata']['scope'],'day')
        self.assertEqual(len(by_key['graph']['candidates']),1)
        self.assertEqual(by_key['unknown']['candidates'],[])
        self.assertIsNone(by_key['unknown']['metadata']['report_date'])
        self.assertNotIn('reports/g.png',str(by_key['graph']['metadata']))

    def test_lower_priority_evaluation_file_is_unlinked(self):
        capture,entries,verified=self.inputs()
        entries.append({'dataset':'lower','dataset_label':None})
        verified['lower']=verified['d']
        specs,_=native.plan(capture,entries,verified)
        self.assertEqual(len(specs),2)
        self.assertEqual(len(specs[0]['candidates']),1)
        self.assertEqual(specs[1]['candidates'],[])

    def test_pending_then_complete_reuses_request_and_links_file(self):
        capture,entries,verified=self.inputs(); conn=Cursor(); stages=[]
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(USER),'BRAIN_ATTEMPT_TOKEN':str(CONN)},clear=True), \
             patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), patch.object(native,'check'), \
             patch.object(native,'locator_lock',locked), patch.object(native,'stage',side_effect=lambda *args: stages.append(args)):
            with self.assertRaises(native.FilesPending): native.publish(conn,capture,entries,verified,{})
            request=conn.mapping[0]
            self.assertIsNone(conn.link[2])
            conn.status='completed'
            native.publish(conn,capture,entries,verified,{})
            self.assertEqual(conn.mapping[0],request)
            self.assertEqual(conn.link[2],FILE)
            self.assertEqual(len(stages),1)
            self.assertEqual(conn.inserted[0][-1],conn.inserted[1][-1])

    def test_failed_and_stale_are_not_success(self):
        capture,entries,verified=self.inputs(); conn=Cursor(); conn.status='failed'
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(USER),'BRAIN_ATTEMPT_TOKEN':str(CONN)},clear=True), \
             patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), patch.object(native,'check'), \
             patch.object(native,'locator_lock',locked), patch.object(native,'stage'):
            with self.assertRaises(native.FilesFailed): native.publish(conn,capture,entries,verified,{})
        with patch.object(native,'_account_map',side_effect=ValueError('IMPORT_INVALID')):
            with self.assertRaises(ValueError): native.publish(conn,capture,entries,verified,{})

    def test_existing_request_content_mismatch_is_conflict(self):
        capture,entries,verified=self.inputs(); conn=Cursor()
        conn.mapping=(USER,'different-hash','batch')
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), patch.object(native,'check'), \
             patch.object(native,'locator_lock',locked), patch.object(native,'conflict',side_effect=ValueError('IMPORT_CONFLICT')), patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic'},clear=True):
            with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                native.publish(conn,capture,entries,verified,{})

    def test_v1_files_use_capture_namespace_and_neutral_metadata(self):
        capture,entries,verified=self.inputs()
        capture['private']['version']=1
        capture['private']['files']=[{'source':'report.md','snapshot':'r','bytes':1},
            {'source':'facts.json','snapshot':'f','bytes':1}, {'source':'graph.png','snapshot':'g','bytes':1}]
        with patch.object(native,'read_relative',return_value=(b'x','hash')):
            specs,unassigned=native.plan(capture,entries,verified)
        self.assertEqual(unassigned,[])
        files=[s for s in specs if s['dataset'] is None]
        self.assertEqual(len(files),3)
        self.assertEqual([s['metadata']['kind'] for s in files],['report','report','graph'])
        for spec in files:
            self.assertEqual(spec['candidates'],[])
            self.assertIsNone(spec['metadata']['scope'])
            self.assertIsNone(spec['metadata']['report_date'])
            self.assertEqual(spec['key'],spec['metadata']['original_path_hash'])
            namespace,batch=native._identity(capture,USER,spec)
            self.assertTrue(namespace.startswith('capture-unassigned:'))
            self.assertTrue(batch.startswith('capture-unassigned:'))
            self.assertNotEqual(native._identity(capture,CONN,spec)[0],namespace)

    def test_conflict_records_original_batch_after_transaction_rollback(self):
        capture,entries,verified=self.inputs(); conn=Cursor()
        conn.mapping=(USER,'different-hash','prior-batch')
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), patch.object(native,'check'), \
             patch.object(native,'locator_lock',locked), patch.object(native,'conflict',side_effect=ValueError('IMPORT_CONFLICT')) as record, \
             patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic'},clear=True):
            with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                native.publish(conn,capture,entries,verified,{})
        self.assertEqual(record.call_args.args[1:3],('d','prior-batch'))
        self.assertEqual(record.call_args.args[-1],'native_file_conflict')

    def test_v1_pending_resume_and_fingerprint_conflict(self):
        capture,entries,verified=self.inputs(); capture['private']['version']=1
        capture['private']['files']=[{'source':'facts.json','snapshot':'f','bytes':1}]
        with patch.object(native,'read_relative',return_value=(b'x','hash')):
            specs,_=native.plan(capture,entries,verified)
        spec=next(s for s in specs if s['dataset'] is None)
        conn=Cursor(); staged=[]
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(USER),'BRAIN_ATTEMPT_TOKEN':str(CONN)},clear=True), \
             patch.object(native,'check'), patch.object(native,'locator_lock',locked), \
             patch.object(native,'stage',side_effect=lambda *args: staged.append(args)), \
             patch.object(native,'conflict',side_effect=ValueError('IMPORT_CONFLICT')) as record:
            native._publish_one(conn,capture,verified,USER,{'d':CONN},spec)
            request=conn.unassigned[0]
            self.assertEqual(staged[0][-1],b'x')
            conn.status='completed'
            native._publish_one(conn,capture,verified,USER,{'d':CONN},spec)
            self.assertEqual(conn.unassigned[0],request)
            self.assertEqual(len(staged),1)
            with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                native._publish_one(conn,capture,verified,USER,{'d':CONN},{**spec,'data':b'y'})
            self.assertEqual(record.call_args.args[2],conn.unassigned[2])
            self.assertEqual(conn.unassigned[0],request)

    def test_v1_verify_rejects_pending_and_accepts_completed_unlinked_file(self):
        capture,entries,verified=self.inputs(); capture['private']['version']=1
        capture['private']['files']=[{'source':'report.md','snapshot':'r','bytes':1}]
        with patch.object(native,'read_relative',return_value=(b'x','hash')):
            specs,_=native.plan(capture,entries,verified)
        spec=next(s for s in specs if s['dataset'] is None)
        class VerifyCursor:
            status='pending'
            def cursor(self, **kwargs): return self
            def execute(self,sql,args=()):
                if sql.startswith('select connection_id,timezone'): self.result=(CONN,'UTC')
                elif sql.startswith('select request_id,content_hash'): self.result=(USER,native._fingerprint(spec),'batch','date')
                elif sql.startswith('select status,file_id'): self.result=(self.status, FILE if self.status=='completed' else None)
                elif sql.startswith('select connection_id,report_date'): self.result=[]
                else: raise AssertionError(sql)
                return self
            def fetchone(self): return self.result
            def fetchall(self): return self.result
        conn=VerifyCursor()
        with patch.object(native,'envelope',return_value=(USER,'UTC')), patch.object(native,'account',return_value={'confirmed':True,'account':'profile'}):
            self.assertEqual(native.verify(conn,capture,entries,verified,{},[spec]),(False,1))
            conn.status='completed'
            self.assertEqual(native.verify(conn,capture,entries,verified,{},[spec]),(True,1))

    def test_stale_attempt_does_not_record_conflict(self):
        capture,entries,verified=self.inputs(); conn=Cursor()
        conn.mapping=(USER,'different-hash','prior-batch')
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), \
             patch.object(native,'check',side_effect=ValueError('IMPORT_INVALID')), \
             patch.object(native,'locator_lock',locked), patch.object(native,'conflict') as record, \
             patch.object(native,'stage') as stage, patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic'},clear=True):
            with self.assertRaisesRegex(ValueError,'IMPORT_INVALID'):
                native.publish(conn,capture,entries,verified,{})
            record.assert_not_called(); stage.assert_not_called()

    def test_planning_relation_conflict_is_fenced_and_readonly_verify_never_writes(self):
        capture,entries,verified=self.inputs(); conn=Cursor()
        capture['private']['files']=[
            {'dataset':'d','artifact_key':'report','category':'report','source':'report.md','snapshot':'r','bytes':1,'report_date':'2026-01-02','scope':'day'},
            {'dataset':'d','artifact_key':'graph','category':'image','source':'graph.png','snapshot':'g','bytes':1,'report_date':'2026-01-01','scope':'day','relations':[{'analysis_key':'report','role':'image'}]}]
        conn.mapping=(USER,'old-fingerprint','original-batch')
        with patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), \
             patch.object(native,'check') as check, patch.object(native,'read_relative',return_value=(b'x','hash')):
            with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                native.publish(conn,capture,entries,verified,{})
            self.assertEqual(conn.mapping,(USER,'old-fingerprint','original-batch'))
            self.assertEqual(len(conn.conflicts),1)
            self.assertEqual(conn.conflicts[0][1:6],('d','original-batch','artifact','graph','native_file_conflict'))
            self.assertGreaterEqual(check.call_count,3)
        conn.conflicts.clear()
        with patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), \
             patch.object(native,'check',side_effect=[None,None,ValueError('IMPORT_INVALID')]), \
             patch.object(native,'read_relative',return_value=(b'x','hash')):
            with self.assertRaisesRegex(ValueError,'IMPORT_INVALID'):
                native.publish(conn,capture,entries,verified,{})
        self.assertEqual(conn.conflicts,[])
        with patch.object(native,'envelope',return_value=(USER,'UTC')), \
             patch.object(native,'read_relative',return_value=(b'x','hash')), \
             patch.object(native,'conflict') as record:
            with self.assertRaisesRegex(ValueError,'IMPORT_CONFLICT'):
                native.verify(conn,capture,entries,verified,{})
            record.assert_not_called()
        self.assertEqual(conn.conflicts,[])

    def test_completion_between_individual_and_final_scan_links_file(self):
        capture,entries,verified=self.inputs()
        class RaceCursor(Cursor):
            def __init__(self): super().__init__(); self.reads=0
            def execute(self,sql,args=()):
                if sql.startswith('select status,file_id'):
                    self.reads+=1
                    if self.reads==2: self.status='completed'
                return super().execute(sql,args)
        conn=RaceCursor(); stages=[]
        @contextlib.contextmanager
        def locked(*args): yield
        with patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(USER),'BRAIN_ATTEMPT_TOKEN':str(CONN)},clear=True), \
             patch.object(native,'_account_map',return_value=(USER,{'d':CONN})), patch.object(native,'check'), \
             patch.object(native,'locator_lock',locked), patch.object(native,'stage',side_effect=lambda *args:stages.append(args)):
            native.publish(conn,capture,entries,verified,{})
        self.assertEqual(conn.reads,2)
        self.assertEqual(conn.link[2],FILE)
        self.assertEqual(len(stages),1)

    def test_final_scan_retries_missing_selected_link_but_allows_unselected(self):
        capture,entries,verified=self.inputs(); conn=Cursor(); conn.status='completed'
        @contextlib.contextmanager
        def locked(*args): yield
        # Simulate an absent selected relation despite a completed request.
        original=conn.execute
        def execute(sql,args=()):
            if sql.startswith('insert into garmin.evaluation_files'): return conn
            if sql.startswith('select kind,original_path_hash,file_id'): conn.result=('report',native._path_hash(native.canonical(['evaluation','d',native._source_key(verified['d']['snapshot']['tables']['evaluation'],verified['d']['snapshot']['tables']['evaluation']['rows'][0]),'report_md'])),None); return conn
            return original(sql,args)
        conn.execute=execute
        with patch.dict(os.environ,{'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(USER),'BRAIN_ATTEMPT_TOKEN':str(CONN)},clear=True), \
             patch.object(native,'_account_map',return_value=(USER,{'d':CONN})),patch.object(native,'check'), \
             patch.object(native,'locator_lock',locked),patch.object(native,'stage'):
            with self.assertRaises(native.FilesPending): native.publish(conn,capture,entries,verified,{})
            conn.selected=False
            native.publish(conn,capture,entries,verified,{})
