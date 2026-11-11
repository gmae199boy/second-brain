"""가짜 게시 파일·core 파일 서버를 이용한 재발신 첨부 계약."""
import contextlib
import unittest
from datetime import date, datetime, timezone
from unittest.mock import patch
from uuid import UUID

import report_publish as publication
from test_report_publish import Cursor

DAY = date(2026, 1, 2)
REVISIONS = {'day': 1, '7d': 2, '30d': 3, 'all': 4}
CREATED = datetime(2026, 1, 2, tzinfo=timezone.utc)
ENV = {'BRAIN_EXTENSION_HOME': '/synthetic', 'BRAIN_TARGET_ID': '2026-01-02',
       'BRAIN_WORK_ID': str(UUID(int=5)), 'BRAIN_ATTEMPT_TOKEN': str(UUID(int=6))}
DOCUMENT = (UUID(int=10), b'full report', CREATED)
PHOTOS = [('01.png', UUID(int=11), b'png one', CREATED, UUID(int=20)),
          ('50.png', UUID(int=12), b'png trend', CREATED, UUID(int=21))]


class FileServer:
    user_id, connection_id = UUID(int=1), UUID(int=2)
    def __init__(self):
        self.requests = {}; self.state = 'completed'; self.bundle = DOCUMENT; self.photos = PHOTOS
    def execute(self, sql, args):
        if 'select b.request_id' in sql: return Cursor(self.bundle)
        if 'select i.name' in sql: return Cursor(rows=self.photos)
        if 'select status,file_id' in sql:
            if args[0] not in self.requests: return Cursor()
            return Cursor((self.state, UUID(int=99) if self.state == 'completed' else None))
        if 'insert into brain.file_requests' in sql:
            previous = self.requests.setdefault(args[0], args)
            # core의 재접수 계약처럼 work/attempt만 달라질 수 있다.
            assert previous[:9] == args[:9] and previous[11:] == args[11:]
            return Cursor()
        raise AssertionError(sql)


class SendAttachmentsTest(unittest.TestCase):
    def setup_server(self, server):
        stack = contextlib.ExitStack(); self.addCleanup(stack.close)
        stack.enter_context(patch.object(publication.store, 'write_session', return_value=contextlib.nullcontext(server)))
        stack.enter_context(patch.object(publication.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()))
        stack.enter_context(patch.object(publication.report, '_assert_attempt_current'))
        stack.enter_context(patch.object(publication.report, '_abi_progress'))
        self.stage = stack.enter_context(patch.object(publication, 'stage'))
        return stack

    def test_existing_files_reused_without_render_and_target_scoped_copies_are_idempotent(self):
        server = FileServer(); self.setup_server(server)
        with patch.object(publication, 'publish_and_wait', side_effect=AssertionError('render forbidden')):
            first = publication.saved_send_attachments(None, DAY, REVISIONS, ENV)
            second = publication.saved_send_attachments(None, DAY, REVISIONS, dict(ENV, BRAIN_WORK_ID=str(UUID(int=50))))
        self.assertEqual(first, second)
        self.assertEqual(first[2], 'published')
        self.assertEqual([item[0] for item in first[1]], ['01.png', '50.png'])
        self.assertEqual(len(server.requests), 3)
        self.assertEqual(self.stage.call_count, 3)
        self.assertEqual({args[9] for args in server.requests.values()}, {ENV['BRAIN_WORK_ID']})
        self.assertEqual({args[5].encode('ascii') for args in server.requests.values()},
                         {publication._hash(data).encode() for data in (DOCUMENT[1], PHOTOS[0][2], PHOTOS[1][2])})

    def test_default_explicit_and_original_publication_share_result_event(self):
        import report_channel
        server = FileServer(); self.setup_server(server)
        original_execute = server.execute
        events = {}
        calls = []
        def execute(sql, args):
            if 'extension_event_emit' in sql:
                calls.append(args)
                return Cursor((events.setdefault((args[2], args[3]), UUID(int=100 + len(events))),))
            return original_execute(sql, args)
        server.execute = execute
        with patch.object(report_channel.report_message, 'load', return_value='[brain-markup-v1]summary'):
            for target in ('default', DAY.isoformat()):
                env = dict(ENV, BRAIN_TARGET_ID=target)
                document, rows, _ = publication.saved_send_attachments(None, DAY, REVISIONS, env)
                report_channel.success(None, DAY, REVISIONS, document, env, attachment_rows=rows)
            report_channel.success(None, DAY, REVISIONS, DOCUMENT[0], ENV,
                                   attachment_rows=[(name, 'graph', request) for name, request, *_ in PHOTOS])
        self.assertEqual(len(calls), 3)
        self.assertEqual(len(events), 1)
        self.assertEqual(len({args[7] for args in calls}), 3)
        self.assertEqual({args[4] for args in calls}, {DAY.isoformat()})
        self.assertTrue(all(args[6] == '[brain-markup-v1]summary' for args in calls))

    def test_unpublished_evaluation_restores_with_existing_renderer_once(self):
        server = FileServer(); server.bundle = None; self.setup_server(server)
        def restore(*args, **kwargs): server.bundle = DOCUMENT
        with patch.object(publication, '_prepare') as render, \
             patch.object(publication, 'publish_bundle_document', side_effect=restore) as freeze:
            result = publication.saved_send_attachments(None, DAY, REVISIONS, ENV)
        self.assertEqual(result[2], 'restored')
        self.assertEqual(render.call_count, 4)
        freeze.assert_called_once_with(None, DAY, REVISIONS, ENV, prepare_only=True)
        # 공용 원본 요청은 게시하지 않고 사본 세 개만 날짜 target에 등록한다.
        self.assertEqual(len(server.requests), 3)

    def test_incomplete_graph_is_not_silently_omitted(self):
        server = FileServer(); server.photos = [('01.png', UUID(int=11), b'png', CREATED, None)]
        self.setup_server(server)
        self.assertIsNone(publication.saved_bundle(None, DAY, REVISIONS))

    def test_copy_pending_polls_all_files_and_failed_copy_does_not_send(self):
        server = FileServer(); self.setup_server(server); server.state = 'pending'
        with patch.object(publication.time, 'monotonic', side_effect=[0, 61]):
            with self.assertRaises(publication.FilesPending):
                publication.saved_send_attachments(None, DAY, REVISIONS, ENV)
        self.assertEqual(len(server.requests), 3)
        server.state = 'failed'
        with self.assertRaises(publication.FilesFailed):
            publication.saved_send_attachments(None, DAY, REVISIONS, ENV)

    def test_staging_io_failure_is_retryable_without_attachmentless_success(self):
        server = FileServer(); self.setup_server(server)
        self.stage.side_effect = OSError('synthetic full disk')
        with self.assertRaises(OSError): publication.saved_send_attachments(None, DAY, REVISIONS, ENV)
        self.assertEqual(server.requests, {})

    def test_restore_then_normal_report_keeps_connection_target_ownership(self):
        """복원·일반 게시를 실제 함수로 연결하고 core의 불변 원본 target 검사를 흉내 낸다."""
        import json
        from pathlib import Path
        from garmin_pipeline import charts
        class Server(FileServer):
            def __init__(self):
                super().__init__(); self.bundle = None; self.photos = []; self.publications = {}; self.links = {}
                self.origins = {}; self.targets = {ENV['BRAIN_WORK_ID']: ENV['BRAIN_TARGET_ID'], str(UUID(int=50)): str(self.connection_id)}
            def execute(self, sql, args):
                if 'select 1 from garmin.report_publications' in sql: return Cursor((1,) if args in self.publications else None)
                if 'select report_md' in sql: return Cursor(('saved ' + args[3],))
                if 'insert into garmin.report_publications' in sql: self.publications[args] = []; return Cursor()
                if 'insert into garmin.report_publication_items' in sql:
                    self.publications[args[:5]].append((args[5], args[6], args[7], args[8], args[9], CREATED)); return Cursor()
                if 'select name from garmin.report_publication_items' in sql:
                    return Cursor(rows=[(r[0],) for r in self.publications.get((*args[:3], 'day', args[3]), []) if r[1]=='graph'])
                if 'select content,request_id,created_at from garmin.report_bundle_files' in sql:
                    return Cursor(None if self.bundle is None else (self.bundle[1], self.bundle[0], self.bundle[2]))
                if 'insert into garmin.report_bundle_files' in sql:
                    self.bundle = (args[6], args[5], CREATED); return Cursor((args[5], args[6], CREATED))
                if 'select b.request_id' in sql:
                    return Cursor(self.bundle if self.bundle and (args[-1] or self.bundle[0] in self.links) else None)
                if 'select i.name' in sql:
                    if 'i.kind=\'graph\'' in sql:
                        return Cursor(rows=[(r[0],r[4],r[3],r[5],self.links.get(r[4], (None,))[0])
                            for r in self.publications.get((*args[:3], 'day', args[3]), []) if r[1]=='graph'])
                    return Cursor(rows=self.publications.get(args, []))
                if 'insert into brain.file_requests' in sql:
                    # bundle INSERT의 고정 text/markdown 인자 자리를 정규화한다.
                    normalized = args if len(args)==12 else (*args[:7], 'text/markdown', *args[7:])
                    result = super().execute(sql, normalized)
                    self.origins.setdefault(args[0], self.targets[normalized[9]])
                    return result
                if 'insert into garmin.evaluation_files' in sql:
                    request, kind, path_hash = (args[4], 'report', args[5]) if len(args)==6 else (args[5],args[6],args[7])
                    self.links.setdefault(request, (None, kind, path_hash)); return Cursor()
                if 'update garmin.evaluation_files' in sql:
                    request = args[5] if "scope='day'" in sql else args[6]
                    link = self.links[request]; self.links[request] = (args[0],link[1],link[2]); return Cursor()
                if 'select kind,original_path_hash,file_id' in sql:
                    link = self.links[args[5]]; return Cursor((link[1],link[2],link[0]))
                if 'select file_id,original_path_hash' in sql:
                    link = self.links[args[4]]; return Cursor((link[0],link[2]))
                return super().execute(sql,args)
        server = Server(); self.setup_server(server)
        def render(cfg, day, folder, *, strict):
            (Path(folder) / '01.png').write_bytes(b'png one')
            return [charts.Graph('01.png', 'graph')]
        with patch.object(publication.charts, 'render', side_effect=render) as draw:
            sent, photos, source = publication.saved_send_attachments(None, DAY, REVISIONS, ENV)
            self.assertEqual(source, 'restored'); draw.assert_called_once()
            self.assertEqual(set(server.origins.values()), {ENV['BRAIN_TARGET_ID']})
            normal = dict(ENV, BRAIN_WORK_ID=str(UUID(int=50)), BRAIN_TARGET_ID=str(server.connection_id))
            publication.publish(None, DAY, REVISIONS, normal)
            document = publication.publish_bundle_document(None, DAY, REVISIONS, normal)
        self.assertEqual(server.origins[document], str(server.connection_id))
        original_graph = next(row[4] for rows in server.publications.values() for row in rows if row[1]=='graph')
        self.assertEqual(server.origins[original_graph], str(server.connection_id))
        self.assertNotEqual(sent, document)
        self.assertNotEqual(photos[0][2], original_graph)
