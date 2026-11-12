"""C1·C2 수락 시험. 모든 입력·계정·시각은 합성 자료다."""
import json
import tempfile
import unittest
from datetime import date, datetime, UTC
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from jsonschema import Draft202012Validator
from garmin_pipeline import report_input, training_measurements as training, store
from test_report_input_pg import FakeConnection

SCHEMA = json.loads((Path(training.__file__).parent / 'schemas/training_measurements_v1.schema.json').read_text())


def manifest():
    return {'report_date':'2026-01-03','timezone':'UTC','data_cutoff':'2026-01-03T08:00:00+00:00','snapshot_id':'a'*64}


def activity(start='2026-01-02T10:00:00+00:00', kind='strength_training', weights=(10000,-1,0,None,-20), duration=1800):
    return {'activity':{'activityTypeDTO':{'typeKey':kind},'summaryDTO':{'startTimeGMT':start,'duration':duration,
            'averageHR':110,'maxHR':150,'distance':2000,'averageSpeed':2,'movingDuration':1500}},
        'activity_details':{'metricDescriptors':[{'key':'directTimestamp','metricsIndex':0},{'key':'directHeartRate','metricsIndex':1}],
                           'activityDetailMetrics':[{'metrics':[int(datetime.fromisoformat(start).timestamp()*1000),110]}]},
        'activity_exercise_sets':{'exerciseSets':[{'setType':'ACTIVE','exercises':[{'category':'PUSH_UP','probability':0.1},{'category':'SQUAT','name':'BARBELL_SQUAT','probability':0.9}],
            'startTime':start,'duration':60,'weight':weight,'repetitionCount':10} for weight in weights]}}


class TrainingTest(unittest.TestCase):
    def build(self, scope='day', activities=None, days=None):
        return training.build_training_measurements(manifest(),days or {},activities or {},{},[],scope)

    def test_published_fixtures_and_produced_values_validate_schema(self):
        fixtures=Path(__file__).parents[1]/'fixtures/training_measurements'
        for path in fixtures.glob('*.json'): Draft202012Validator(SCHEMA).validate(json.loads(path.read_text()))
        for scope in training.SCOPES:
            Draft202012Validator(SCHEMA).validate(self.build(scope,{'1':activity()}))

    def test_load_kinds_partial_volume_and_max_weight_reps(self):
        value=self.build(activities={'1':activity()})['current']
        sets=value['sessions'][0]['sets']
        self.assertEqual([s['load_kind'] for s in sets],['weighted','bodyweight','missing','missing','unknown'])
        self.assertEqual(sets[0]['exercise_key'],'SQUAT_BARBELL_SQUAT')
        self.assertEqual(sets[0]['start_at'],'2026-01-02T10:00:00+00:00')
        self.assertEqual(sets[0]['end_at'],'2026-01-02T10:01:00+00:00')
        total=value['strength'][0]
        self.assertEqual((total['sets'],total['reps'],total['volume_kg'],total['volume_sets']),(5,50,100,1))
        self.assertEqual(total['max_kg_reps'],[10])
        self.assertTrue(total['volume_partial'])
        self.assertEqual(value['coverage']['missing_load_sets'],3)
        self.assertEqual(total['comparability']['status'],'limited')

    def test_bodyweight_has_reps_without_zero_or_bodymass_volume(self):
        value=self.build(activities={'1':activity(weights=(-1,-1))})['current']['strength'][0]
        self.assertEqual(value['reps'],20)
        self.assertIsNone(value['volume_kg'])
        self.assertIsNone(value['max_kg'])
        self.assertEqual(value['bodyweight_sets'],2)

    def test_completion_date_includes_every_activity_and_excludes_in_progress(self):
        activities={'1':activity('2026-01-01T23:45:00+00:00'),
                    '2':activity(),'3':activity('2026-01-03T07:45:00+00:00'),
                    '4':activity('2026-01-02T13:00:00+00:00',kind='walking',weights=())}
        value=self.build(activities=activities)['current']
        self.assertEqual({s['session_id'] for s in value['sessions']},{'1','2','4'})
        self.assertTrue(all(s['completed_date']=='2026-01-02' for s in value['sessions']))
        walk=next(s for s in value['sessions'] if s['type']=='walking')
        self.assertIn('incline_not_recorded',walk['limitations'])
        self.assertEqual(walk['pace_s_km'],500)
        self.assertEqual(walk['heart_rate'][0]['bpm'],110)

    def test_no_workout_and_hiit_without_sets_do_not_invent_strength(self):
        empty=self.build()['current']
        self.assertEqual(empty['coverage']['sessions'],0)
        self.assertEqual(empty['strength'],[])
        value=self.build(activities={'1':activity(kind='hiit',weights=())})['current']
        self.assertEqual(value['strength'],[])
        self.assertIn('sets_not_available',value['sessions'][0]['limitations'])

    def test_comparison_windows_are_nonoverlapping_and_all_keeps_monthly_reps(self):
        for scope,first,last in [('7d','2025-12-20','2025-12-26'),('30d','2025-11-04','2025-12-03')]:
            value=self.build(scope)
            self.assertEqual((value['comparison']['from'],value['comparison']['to']),(first,last))
            self.assertLess(value['comparison']['to'],value['current']['from'])
        value=self.build('all',{'1':activity(),'2':activity('2025-11-02T10:00:00+00:00')})
        self.assertIsNone(value['comparison'])
        self.assertEqual([m['reps'] for m in value['current']['strength'][0]['monthly']],[50,50])

    def seal_fixture(self,root):
        import hashlib
        report_input.write_json(root/'manifest.json',manifest())
        report_input.write_json(root/'labels/exercise_types_ko.json',{})
        for scope in training.SCOPES:
            folder=root/'day' if scope=='day' else root/'period'/scope
            report_input.write_json(folder/'training_measurements.json',self.build(scope))
            for name in (('manifest','digest') if scope=='day' else ('scope','day_values','previous','evaluations')):
                report_input.write_json(folder/f'{name}.json',{})
        hashes={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in root.rglob('*') if p.is_file()}
        report_input.write_json(root/'snapshot.json',{'snapshot_id':'a'*64,'complete':True,'files':hashes,
            'data_cutoff':manifest()['data_cutoff'],'report_date':manifest()['report_date'],'profile_snapshot_id':None})

    def test_offline_loader_and_snapshot_resolution(self):
        with tempfile.TemporaryDirectory() as tmp:
            cfg=SimpleNamespace(data_dir=Path(tmp))
            root=cfg.data_dir/'report-snapshots'/('a'*64)
            self.seal_fixture(root)
            with patch.object(store,'read_connection',side_effect=AssertionError('DB 재조회 금지')):
                self.assertEqual(training.resolve_snapshot_root(cfg,'a'*64),root)
                self.assertEqual(training.load_training_measurements(root,'day')['scope'],'day')
            with self.assertRaises(ValueError): training.resolve_snapshot_root(cfg,'../outside')
            with self.assertRaises(FileNotFoundError): training.resolve_snapshot_root(cfg,'b'*64)
            with self.assertRaises(ValueError): training.load_training_measurements(root,'custom')

    def test_single_read_snapshot_and_retries_reuse_without_reading_db(self):
        import hashlib
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)
            cfg=SimpleNamespace(data_dir=root/'data',reports_dir=root/'reports',profile_path=root/'profile.md',timezone='UTC')
            conn=FakeConnection()
            with patch.object(store,'read_connection',return_value=conn) as read, patch.object(report_input.body,'load_schema',return_value={}), patch('garmin_pipeline.digest.build',return_value={}):
                exported=report_input.prepare_snapshot(cfg,date(2026,1,3),'synthetic-work',started_at=1767427200000)
                self.assertEqual(read.call_count,1)
                self.assertTrue(conn.closed)
            self.assertEqual(exported.path.name,training.snapshot_id_for('synthetic-work',date(2026,1,3)))
            for scope in training.SCOPES:
                value=training.load_training_measurements(exported.path,scope)
                self.assertEqual(value['snapshot_id'],exported.path.name)
                self.assertEqual(value['data_cutoff'],exported.manifest['data_cutoff'])
            with patch.object(store,'read_connection',side_effect=AssertionError('재시도는 DB를 읽지 않는다')):
                again=report_input.prepare_snapshot(cfg,date(2026,1,3),'synthetic-work',started_at=99999)
                self.assertEqual(again.manifest,exported.manifest)
                self.assertEqual(report_input.build_period(cfg,again.path,date(2026,1,3),'7d'),again.path/'period/7d')
            self.assertFalse((exported.path/'day/previous_report.md').exists())
            self.assertFalse((exported.path/'day/previous_evaluations/7d.json').exists())
            for scope in ('7d','30d','all'):
                self.assertEqual(json.loads((exported.path/'period'/scope/'evaluations.json').read_text()),[])
                previous=json.loads((exported.path/'period'/scope/'previous.json').read_text())
                self.assertNotIn('summary',previous)
                self.assertNotIn('judgments',previous)

    def test_successful_scope_results_filters_account_snapshot_and_status(self):
        class Rows:
            def fetchall(self): return [('day',3,{'status':'ok','snapshot_id':'a'*64})]
        class Conn:
            user_id='synthetic-user'; connection_id='synthetic-account'
            def execute(self,sql,args):
                self.sql,self.args=sql,args
                return Rows()
        conn=Conn()
        result=store.successful_scope_results(conn,report_date='2026-01-03',snapshot_id='a'*64)
        self.assertEqual(result['day']['revision'],3)
        self.assertIn("structured->>'status'='ok'",conn.sql)
        self.assertIn('user_id=%s and connection_id=%s',conn.sql)
        self.assertEqual(conn.args,('synthetic-user','synthetic-account','2026-01-03','a'*64))
        self.assertNotEqual(training.snapshot_id_for('work','2026-01-03'),training.snapshot_id_for('work','2026-01-04'))


    def test_tampered_missing_and_incomplete_snapshot_inputs_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'report-snapshots'/('a'*64)
            cfg=SimpleNamespace(data_dir=Path(tmp))
            self.seal_fixture(root)
            path=root/'period/7d/training_measurements.json'
            original=path.read_bytes()
            value=json.loads(original);value['current']['coverage']['sessions']=99
            report_input.write_json(path,value)
            with self.assertRaisesRegex(ValueError,'hash mismatch'): training.resolve_snapshot_root(cfg,'a'*64)
            with self.assertRaisesRegex(ValueError,'hash mismatch'): training.load_training_measurements(root,'7d')
            path.unlink()
            with self.assertRaises(FileNotFoundError): training.resolve_snapshot_root(cfg,'a'*64)
            path.write_bytes(original)
            self.assertEqual(training.resolve_snapshot_root(cfg,'a'*64),root)
            standalone=Path(tmp)/'standalone';standalone.mkdir()
            report_input.write_json(standalone/'training_measurements.json',{'schema_version':training.SCHEMA_VERSION,'scope':'day'})
            with self.assertRaisesRegex(ValueError,'invalid training'): training.load_training_measurements(standalone)

    def test_all_representatives_preserve_real_sets_without_duplicate_sampling(self):
        for count in (1,2,3,4):
            value=self.build('all',{'1':activity(weights=(-1,)*count)})
            rows=value['current']['strength'][0]['same_load_reps'][0]['observations']
            self.assertEqual(len(rows),min(count,3))
            self.assertEqual(sum(r['reps'] for r in rows),10*min(count,3))

    def test_snapshot_period_values_share_c1_window_and_training_source(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);cfg=SimpleNamespace(data_dir=root/'data',reports_dir=root/'reports',profile_path=root/'profile.md',timezone='UTC')
            conn=FakeConnection()
            with patch.object(store,'read_connection',return_value=conn), patch.object(report_input.body,'load_schema',return_value={}), patch('garmin_pipeline.digest.build',return_value={}):
                exported=report_input.prepare_snapshot(cfg,date(2026,1,3),'period-boundaries',started_at=1767427200000)
            for scope in ('7d','30d','all'):
                folder=exported.path/'period'/scope
                info=json.loads((folder/'scope.json').read_text())
                c1=training.load_training_measurements(exported.path,scope)
                self.assertEqual((info['from'],info['to'],info['actual_days']),
                                 (c1['current']['from'],c1['current']['to'],c1['current']['actual_days']))
                legacy=json.loads((folder/'day_values.json').read_text())
                self.assertEqual(legacy['training_measurements_ref'],'training_measurements.json')
                self.assertNotIn('workout',legacy);self.assertNotIn('workouts',legacy)
                for sql,args in conn.calls:
                    if ('date BETWEEN' in sql or 'w.date BETWEEN' in sql) and 'raw_current' not in sql and 'scope=%s' not in sql:
                        self.assertLessEqual(args[-1],'2026-01-02')

    def test_existing_legacy_work_revision_is_an_explicit_compatibility_error(self):
        import contextlib
        from garmin_pipeline import report
        class Rows:
            def fetchall(self): return [('day',1,None)]
        class Conn:
            user_id='synthetic-user';connection_id='synthetic-account'
            def execute(self,sql,args): return Rows()
        @contextlib.contextmanager
        def session(_): yield Conn()
        with patch.dict('os.environ',{'BRAIN_WORK_ID':'synthetic-work'}), patch.object(store,'write_session',session), patch.object(store,'transaction',lambda conn:contextlib.nullcontext()):
            with self.assertRaisesRegex(store.StoreError,'incompatible snapshot'):
                report._work_revisions(None,date(2026,1,3),False)

    def test_day_comparison_crossing_oldest_boundary_keeps_raw_evidence(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            cfg = SimpleNamespace(data_dir=root/'data', reports_dir=root/'reports',
                profile_path=root/'profile.md', timezone='UTC')
            cutoff = int(datetime(2026, 1, 3, 8, tzinfo=UTC).timestamp()*1000)
            snapshot = ({'2025-12-03': {}}, {'boundary': activity('2025-12-02T23:50:00+00:00')},
                ['boundary'], cutoff, 0, {'status': 'not_run'}, date(2025, 12, 3), [])
            with patch.object(store, 'read_connection', return_value=FakeConnection()), \
                 patch.object(report_input.body, 'load_schema', return_value={}), \
                 patch('garmin_pipeline.digest.build', return_value={}), \
                 patch.object(report_input, '_snapshot', return_value=snapshot):
                exported = report_input.prepare_snapshot(cfg, date(2026, 1, 3), 'comparison-boundary', started_at=cutoff)
            value = training.load_training_measurements(exported.path, 'day')
            self.assertEqual([session['session_id'] for session in value['comparison']['sessions']], ['boundary'])
            for session in value['current']['sessions'] + value['comparison']['sessions']:
                for ref in session['source_refs']:
                    self.assertTrue((exported.path/'day'/ref.split('#')[0]).is_file(), ref)
                for strength_set in session['sets']:
                    self.assertTrue((exported.path/'day'/strength_set['source_ref'].split('#')[0]).is_file())

    def test_profile_worker_fixture_and_raw_evidence_are_frozen_for_every_scope(self):
        import shutil
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp);cfg=SimpleNamespace(data_dir=root/'data',reports_dir=root/'reports',profile_path=root/'profile.md',timezone='UTC')
            cfg.profile_path.write_text('합성 프로필')
            original_build,original_period=report_input.build,report_input.build_period
            profile={'status':'configured','primary_goal':'synthetic-goal','plan':{'sets':3}}
            def profile_build(*args,**kwargs):
                exported=original_build(*args,**kwargs)
                exported.manifest['profile_snapshot_id']='synthetic-profile'
                report_input.write_json(exported.path/'profile.json',profile)
                report_input.write_json(exported.path/'manifest.json',exported.manifest)
                return exported
            def profile_period(*args,**kwargs):
                folder=original_period(*args,**kwargs)
                for name in ('profile.json','profile.md'):shutil.copyfile(args[1]/name,folder/name)
                return folder
            cutoff=int(datetime(2026,1,3,8,tzinfo=UTC).timestamp()*1000)
            snapshot=({'2026-01-02':{}},{'1':activity()},['1'],cutoff,0,{'status':'not_run'},date(2026,1,2),[])
            with patch.object(store,'read_connection',return_value=FakeConnection()), patch.object(report_input.body,'load_schema',return_value={}), patch('garmin_pipeline.digest.build',return_value={}), patch.object(report_input,'_snapshot',return_value=snapshot), patch.object(report_input,'build',side_effect=profile_build), patch.object(report_input,'build_period',side_effect=profile_period):
                exported=report_input.prepare_snapshot(cfg,date(2026,1,3),'profile-and-source',started_at=cutoff)
            for scope in training.SCOPES:
                folder=exported.path/'day' if scope=='day' else exported.path/'period'/scope
                self.assertEqual(json.loads((folder/'profile.json').read_text()),profile)
                self.assertIn('합성 프로필', (folder/'profile.md').read_text())
                value=training.load_training_measurements(exported.path,scope)
                self.assertEqual(value['profile']['snapshot_id'],'synthetic-profile')
                self.assertEqual(value['profile']['status'],'configured')
                for session in value['current']['sessions']:
                    self.assertTrue((folder/session['source_refs'][0]).is_file())
            cfg.profile_path.write_text('새 합성 프로필')
            with patch.object(store,'read_connection',side_effect=AssertionError('snapshot 재사용')):
                again=report_input.prepare_snapshot(cfg,date(2026,1,3),'profile-and-source',started_at=0)
                self.assertIn('합성 프로필', (again.path/'day/profile.md').read_text())


    def test_missing_snapshot_metadata_never_falls_back_to_standalone_mode(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/'report-snapshots'/('a'*64)
            self.seal_fixture(root)
            (root/'snapshot.json').unlink()
            with self.assertRaises(FileNotFoundError): training.load_training_measurements(root,'7d')
            with self.assertRaises(FileNotFoundError): training.load_training_measurements(root/'period/7d')
            with self.assertRaises(FileNotFoundError): training.load_training_measurements(root/'day')
            standalone=Path(tmp)/'standalone'
            report_input.write_json(standalone/'training_measurements.json',self.build())
            self.assertEqual(training.load_training_measurements(standalone)['scope'],'day')

    def test_previous_checks_uses_report_date_instead_of_measurement_end(self):
        from test_report_input_pg import Result
        class PreviousConnection(FakeConnection):
            def execute(self,sql,params=()):
                if 'next_checks,revision,model,created_at' in sql:
                    self.calls.append((sql,params))
                    rows=[('2026-01-02','7d','["latest"]',2,'synthetic',2),
                          ('2026-01-01','7d','["older"]',1,'synthetic',1)]
                    return Result([r for r in rows if r[0]<params[-1]][:1])
                return super().execute(sql,params)
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp)
            report_input.write_json(folder/'manifest.json',{'period_windows':{'7d':{'from':'2025-12-27','to':'2026-01-02'}},
                'months':['2025-12','2026-01'],'data_cutoff':manifest()['data_cutoff']})
            with patch.object(store,'read_connection',return_value=PreviousConnection()):
                period=report_input.build_period(None,folder,date(2026,1,3),'7d')
            previous=json.loads((period/'previous.json').read_text())
            self.assertEqual(previous['report_date'],'2026-01-02')
            self.assertEqual(previous['revision'],2)
            self.assertEqual(previous['elapsed_days'],1)
            self.assertEqual(previous['next_checks'],['latest'])


    def test_recovery_is_json_serializable_and_uses_observed_personal_baseline(self):
        from garmin_pipeline.digest import _Digest
        def sleep(engine,inp,day):
            return {'total_s':400 if day=='2026-01-01' else 500,'hrv_avg':20,
                    '_start':datetime(2026,1,1,22,tzinfo=UTC),'_end':datetime(2026,1,2,6,tzinfo=UTC)}
        with patch.object(_Digest,'sleep_for',sleep), patch.object(_Digest,'full_day',return_value={'resting_hr':60,'bb_wake':80}):
            value=self.build(days={'2026-01-01':{},'2026-01-02':{}})
        json.dumps(value,allow_nan=False)
        row=next(r for r in value['recovery_context'] if r['date']=='2026-01-02')['measurements']
        self.assertNotIn('_start',row['sleep'])
        self.assertEqual(row['sleep_end_at'],'2026-01-02T06:00:00+00:00')
        baseline=row['baseline_changes']['sleep_total_s']
        self.assertEqual(baseline,{'value':500,'baseline_mean':400,'delta':100,'observed_days':1})
