"""Publication contracts; execution is deferred to ticket 21.8."""
import contextlib
import json
import sys
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import report_publish

DAY = date(2026, 1, 2)
USER = UUID(int=1)
CONNECTION = UUID(int=2)
REQUEST = UUID(int=3)
FILE = UUID(int=4)


class Cursor:
    def __init__(self, row=None, rows=()): self.row, self.rows = row, rows
    def fetchone(self): return self.row
    def fetchall(self): return self.rows


class Connection:
    user_id, connection_id = USER, CONNECTION
    def __init__(self, status): self.status, self.queries, self.link = status, [], None
    def execute(self, sql, args):
        self.queries.append((sql, args))
        if 'select i.name' in sql:
            return Cursor(rows=[('report.md', 'report', 'text/markdown', b'synthetic', REQUEST, datetime(2026, 1, 2, tzinfo=timezone.utc))])
        if 'select status,file_id' in sql:
            return Cursor((self.status, FILE if self.status == 'completed' else None))
        if 'update garmin.evaluation_files' in sql:
            self.link = args[0]
        if 'select kind,original_path_hash,file_id' in sql:
            insert = next(a for q, a in self.queries if 'insert into garmin.evaluation_files' in q)
            return Cursor((insert[-2], insert[-1], self.link))
        return Cursor()


class ReportPublishTest(unittest.TestCase):
    def publish(self, conn):
        env = {'BRAIN_EXTENSION_HOME': '/synthetic', 'BRAIN_WORK_ID': str(UUID(int=5)), 'BRAIN_ATTEMPT_TOKEN': str(UUID(int=6))}
        with patch.object(report_publish, '_prepare') as prepare, patch.object(report_publish.store, 'write_session', return_value=contextlib.nullcontext(conn)), patch.object(report_publish.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()), patch.object(report_publish, 'stage') as stage:
            try:
                report_publish.publish(None, DAY, {'day': 7}, env)
            finally:
                prepare.assert_called_once_with(None, DAY, 'day', 7, {'day': 7})
                if conn.status == 'completed': stage.assert_not_called()
                else: stage.assert_called_once()

    def test_pending_and_failed_preserve_revision_and_request_identity(self):
        requests = []
        for status, error in [('pending', report_publish.FilesPending), ('failed', report_publish.FilesFailed)]:
            conn = Connection(status)
            with self.assertRaises(error): self.publish(conn)
            args = next(a for q, a in conn.queries if 'insert into brain.file_requests' in q)
            metadata = json.loads(args[-1])
            self.assertEqual((metadata['kind'], metadata['report_date'], metadata['scope']), ('report', DAY.isoformat(), 'day'))
            self.assertEqual(len(metadata['original_path_hash']), 64)
            self.assertEqual(args[0], REQUEST)
            self.assertFalse(any('delete' in q.lower() for q, _ in conn.queries))
            requests.append(args[:10])
        self.assertEqual(requests[0], requests[1])

    def test_completed_result_is_linked_to_exact_revision(self):
        conn = Connection('completed')
        self.publish(conn)
        args = next(a for q, a in conn.queries if 'insert into garmin.evaluation_files' in q)
        self.assertEqual(args[:6], (USER, CONNECTION, DAY.isoformat(), 'day', 7, REQUEST))
        self.assertEqual(conn.link, FILE)

    def test_frozen_revision_is_reused_without_rendering_on_restart(self):
        class Existing(Connection):
            def execute(self, sql, args):
                if 'select 1 from garmin.report_publications' in sql: return Cursor((1,))
                if 'select report_md' in sql: return Cursor(('saved report',))
                raise AssertionError(sql)
        conn = Existing('pending')
        with patch.object(report_publish.store, 'write_session', return_value=contextlib.nullcontext(conn)), patch.object(report_publish.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()), patch.object(report_publish.charts, 'render') as render:
            report_publish._prepare(None, DAY, 'day', 7)
            render.assert_not_called()

    def test_render_failure_does_not_freeze_incomplete_publication(self):
        class New(Connection):
            def execute(self, sql, args):
                self.queries.append((sql, args))
                if 'select 1 from garmin.report_publications' in sql: return Cursor(None)
                if 'select report_md' in sql: return Cursor(('saved report',))
                raise AssertionError(sql)
        conn = New('pending')
        with patch.object(report_publish.store, 'write_session', return_value=contextlib.nullcontext(conn)), patch.object(report_publish.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()), patch.object(report_publish.charts, 'render', side_effect=OSError('synthetic')):
            with self.assertRaises(OSError): report_publish._prepare(None, DAY, 'day', 7)
        self.assertFalse(any('insert into garmin.report_publications' in sql for sql, _ in conn.queries))

    def test_completed_regeneration_retry_only_republishes_recorded_revisions(self):
        from garmin_pipeline import report
        revisions = {'day': 2, '7d': 3, '30d': 4, 'all': 5}
        with patch.dict('os.environ', {'BRAIN_WORK_ID': str(UUID(int=5))}), patch('garmin_pipeline.training_measurements.resolve_snapshot_root'), patch.object(report, '_work_revisions', return_value=revisions), patch.object(report_publish, 'publish_and_wait', side_effect=report_publish.FilesPending) as publish, patch.object(report.body, 'pending') as intake:
            with self.assertRaises(report_publish.FilesPending):
                report.run_supervised(None, object(), regenerate=True, today=DAY)
            publish.assert_called_once_with(None, DAY, revisions)
            intake.assert_not_called()

    def test_combined_document_waits_for_completion_and_reuses_request(self):
        revisions = {'day': 1, '7d': 2, '30d': 3, 'all': 4}
        class BundleConn(Connection):
            def __init__(self):
                super().__init__('pending'); self.saved = None; self.inserted = []
            def execute(self, sql, args):
                if 'select content,request_id,created_at' in sql: return Cursor(self.saved)
                if 'select report_md' in sql: return Cursor(('synthetic '+args[3],))
                if 'select name from garmin.report_publication_items' in sql: return Cursor(rows=[])
                if 'insert into garmin.report_bundle_files' in sql:
                    self.saved = (args[-2],args[-1],datetime(2026,1,2,tzinfo=timezone.utc)); return Cursor(self.saved)
                if 'select status,file_id' in sql: return Cursor((self.status, FILE if self.status == 'completed' else None))
                if 'insert into brain.file_requests' in sql: self.inserted.append(args); return Cursor()
                if 'update garmin.evaluation_files' in sql: self.link = args[0]; return Cursor()
                if 'select file_id,original_path_hash' in sql:
                    link = next(a for q,a in self.queries if 'insert into garmin.evaluation_files' in q)
                    return Cursor((self.link,link[-1]))
                self.queries.append((sql,args)); return Cursor()
        conn=BundleConn()
        env={'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(UUID(int=5)),'BRAIN_ATTEMPT_TOKEN':str(UUID(int=6))}
        with patch.object(report_publish.store,'write_session',return_value=contextlib.nullcontext(conn)), patch.object(report_publish.store,'transaction',side_effect=lambda c:contextlib.nullcontext()), patch.object(report_publish,'stage'):
            with self.assertRaises(report_publish.FilesPending): report_publish.publish_bundle_document(None,DAY,revisions,env)
            original = conn.saved[1]
            conn.status='completed'
            self.assertEqual(report_publish.publish_bundle_document(None,DAY,revisions,env),original)
        self.assertEqual(conn.inserted[0][0],conn.inserted[1][0])
        self.assertIn(b'synthetic 7d', bytes(conn.saved[0]))
        self.assertIn(b'synthetic 30d', bytes(conn.saved[0]))

    def test_submit_both_before_wait_and_progress_without_open_session(self):
        from garmin_pipeline import report
        events = []; elapsed = [0]
        def normal(*_):
            events.append('files')
            if elapsed[0] == 0: raise report_publish.FilesPending()
        def bundle(*_):
            events.append('bundle')
            if elapsed[0] == 0: raise report_publish.FilesPending()
            return REQUEST
        def sleep(seconds): events.append('sleep'); elapsed[0] += seconds
        with patch.object(report, '_assert_attempt_current', side_effect=lambda cfg: events.append('fence')), patch.object(report_publish, 'publish', side_effect=normal), patch.object(report_publish, 'publish_bundle_document', side_effect=bundle):
            result = report_publish.publish_and_wait(None, DAY, {'day': 1}, monotonic=lambda:elapsed[0], sleep=sleep, progress=lambda:events.append('progress'))
        self.assertEqual(result, REQUEST)
        self.assertEqual(events, ['fence','files','bundle','progress','sleep','fence','files','bundle'])

    def test_bounded_wait_and_revoked_attempt_stop_without_sleeping_in_transaction(self):
        from garmin_pipeline import report, store
        elapsed = [0]; events = []
        def sleep(seconds): elapsed[0] += seconds; events.append('sleep')
        def pending(*_): raise report_publish.FilesPending()
        with patch.object(report, '_assert_attempt_current', side_effect=[None, store.StaleAttempt('revoked')]), patch.object(report_publish, 'publish', side_effect=pending), patch.object(report_publish, 'publish_bundle_document', side_effect=pending):
            with self.assertRaises(store.StaleAttempt): report_publish.publish_and_wait(None, DAY, {}, monotonic=lambda:elapsed[0], sleep=sleep, progress=lambda:events.append('heartbeat'))
        self.assertEqual(events, ['heartbeat','sleep'])
        elapsed[0] = 0
        with patch.object(report, '_assert_attempt_current'), patch.object(report_publish, 'publish', side_effect=pending), patch.object(report_publish, 'publish_bundle_document', side_effect=pending), patch.object(report_publish, 'PENDING_WAIT_SECONDS', 3):
            with self.assertRaises(report_publish.FilesPending): report_publish.publish_and_wait(None, DAY, {}, monotonic=lambda:elapsed[0], sleep=sleep, progress=lambda:None)
        self.assertEqual(elapsed[0], 3)

    def test_file_failure_does_not_become_normal_pending(self):
        from garmin_pipeline import report
        with patch.object(report, '_assert_attempt_current'), patch.object(report_publish, 'publish', side_effect=report_publish.FilesFailed), patch.object(report_publish, 'publish_bundle_document') as bundle:
            with self.assertRaises(report_publish.FilesFailed): report_publish.publish_and_wait(None, DAY, {})
            bundle.assert_not_called()

    def test_graph_render_is_outside_write_session_and_shared_across_scopes(self):
        from garmin_pipeline import charts
        from types import SimpleNamespace
        state={'held':False,'rows':{},'graphs':[], 'renders':0}
        class GraphConn:
            user_id,connection_id=USER,CONNECTION
            def execute(self, sql, args):
                if 'select 1 from garmin.report_publications' in sql: return Cursor((1,) if args in state['rows'] else None)
                if 'select report_md' in sql: return Cursor(('synthetic '+args[3],))
                if 'select name from garmin.report_publication_items' in sql: return Cursor(rows=[(name,) for name in state['graphs']])
                if 'insert into garmin.report_publications' in sql: state['rows'][args]=[]
                if 'insert into garmin.report_publication_items' in sql:
                    state['rows'][args[:5]].append(args[6]);
                    if args[6]=='graph': state['graphs'].append(args[5])
                return Cursor()
        conn=GraphConn()
        @contextlib.contextmanager
        def session(_):
            self.assertFalse(state['held']); state['held']=True
            try: yield conn
            finally: state['held']=False
        def draw(cfg,day,folder,*,strict):
            self.assertFalse(state['held']); self.assertTrue(strict); state['renders']+=1
            (folder/'01.png').write_bytes(b'synthetic')
            return [charts.Graph('01.png','chart')]
        revisions={'day':1,'7d':2,'30d':3,'all':4}
        with patch.object(report_publish.store,'write_session',side_effect=session), patch.object(report_publish.store,'transaction',side_effect=lambda c:contextlib.nullcontext()), patch.object(report_publish.charts,'render',side_effect=draw):
            for scope in revisions: report_publish._prepare(SimpleNamespace(),DAY,scope,revisions[scope],revisions)
            report_publish._prepare(SimpleNamespace(),DAY,'day',1,revisions)
        self.assertEqual(state['renders'],1)
        self.assertEqual([kinds.count('graph') for kinds in state['rows'].values()], [1,0,0,0])

    def test_one_graph_request_links_every_scope_revision(self):
        revisions={'day':1,'7d':2,'30d':3,'all':4}
        class GraphLinks(Connection):
            def execute(self, sql, args):
                self.queries.append((sql,args))
                if 'select i.name' in sql:
                    if args[3]=='day': return Cursor(rows=[('01.png','graph','image/png',b'png',REQUEST,datetime(2026,1,2,tzinfo=timezone.utc))])
                    return Cursor(rows=[])
                if 'select status,file_id' in sql: return Cursor(('completed',FILE))
                if 'select kind,original_path_hash,file_id' in sql:
                    relation=next(a for q,a in self.queries if 'insert into garmin.evaluation_files' in q and a[:6]==args)
                    return Cursor((relation[-2],relation[-1],FILE))
                return Cursor()
        conn=GraphLinks('completed')
        with patch.object(report_publish,'_prepare'), patch.object(report_publish.store,'write_session',return_value=contextlib.nullcontext(conn)), patch.object(report_publish.store,'transaction',side_effect=lambda c:contextlib.nullcontext()), patch.object(report_publish,'stage'):
            report_publish.publish(None,DAY,revisions,{'BRAIN_EXTENSION_HOME':'/synthetic','BRAIN_WORK_ID':str(UUID(int=5)),'BRAIN_ATTEMPT_TOKEN':str(UUID(int=6))})
        links=[args for sql,args in conn.queries if 'insert into garmin.evaluation_files' in sql]
        self.assertEqual({(args[3],args[4],args[5]) for args in links}, {(scope,rev,REQUEST) for scope,rev in revisions.items()})
        self.assertEqual(len([sql for sql,_ in conn.queries if 'insert into brain.file_requests' in sql]),1)

    def test_strict_chart_failure_is_not_equivalent_to_empty_graphs(self):
        import tempfile
        from types import SimpleNamespace
        from garmin_pipeline import charts
        cfg=SimpleNamespace(data_dir=Path('/synthetic'))
        with tempfile.TemporaryDirectory() as folder, contextlib.ExitStack() as stack:
            cfg.data_dir=Path(folder)
            stack.enter_context(patch.object(charts,'_read_chart_data',return_value={}))
            for name in ('_yesterday','_daily_trend','_daily_workouts','_all_trend','_body_trend'):
                stack.enter_context(patch.object(charts,name,return_value=False))
            self.assertEqual(charts.render(cfg,DAY,Path(folder),strict=True),[])
            with patch.object(charts,'_yesterday',side_effect=OSError('synthetic')):
                with self.assertRaises(charts.ChartRenderFailed) as raised:
                    charts.render(cfg,DAY,Path(folder),strict=True)
                self.assertIn('01-yesterday.png', raised.exception.args[0])

    def test_wait_has_no_open_transaction_and_interrupt_propagates(self):
        from garmin_pipeline import report
        state={'transaction':0,'session':0}
        def submit(*_):
            state['session']+=1; state['transaction']+=1
            try: raise report_publish.FilesPending()
            finally: state['transaction']-=1; state['session']-=1
        def interrupted(_):
            self.assertEqual(state, {'transaction':0,'session':0})
            raise KeyboardInterrupt()
        def progress(): self.assertEqual(state, {'transaction':0,'session':0})
        with patch.object(report,'_assert_attempt_current'), patch.object(report_publish,'publish',side_effect=submit), patch.object(report_publish,'publish_bundle_document',side_effect=submit):
            with self.assertRaises(KeyboardInterrupt): report_publish.publish_and_wait(None,DAY,{},monotonic=lambda:0,sleep=interrupted,progress=progress)
