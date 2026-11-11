"""결과 이벤트의 payload·저장 순서·멱등 계약 대역."""
import contextlib
import json
import os
import sys
import unittest
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch
from uuid import UUID
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import report_channel
import role_probe
from garmin_pipeline import report

DAY = date(2026, 1, 2)
REVISIONS = {'day': 1, '7d': 2, '30d': 3, 'all': 4}
ENV = {'BRAIN_WORK_ID': str(UUID(int=5)), 'BRAIN_ATTEMPT_TOKEN': str(UUID(int=6)),
       'BRAIN_WORK_KIND': 'garmin.report'}

class Cursor:
    def __init__(self, row=None, rows=()): self.row, self.rows = row, rows
    def fetchone(self): return self.row
    def fetchall(self): return self.rows

class Conn:
    user_id, connection_id = UUID(int=1), UUID(int=2)
    def __init__(self): self.calls, self.requests = [], {}
    def execute(self, sql, args):
        self.calls.append((sql,args))
        if 'select summary' in sql: return Cursor(('synthetic '+args[3], '[]', '[]', None))
        if 'select sleep_total_s' in sql: return Cursor((19920,45,27,22))
        if 'select i.name' in sql: return Cursor(rows=[('01.png','graph',UUID(int=8)),('50.png','graph',UUID(int=9)),('report.md','report',UUID(int=10))])
        if 'extension_event_emit' in sql:
            identity = (args[2], args[3])
            return Cursor((self.requests.setdefault(identity, UUID(int=11 + len(self.requests))),))
        raise AssertionError(sql)

class ChannelTest(unittest.TestCase):
    def setup_conn(self, conn):
        stack=contextlib.ExitStack(); self.addCleanup(stack.close)
        stack.enter_context(patch('report_publish.saved_bundle', return_value=((None, b'document', None),
            [(f'{i:02}.png', None, f'graph:{i}'.encode(), None, None) for i in range(1, 100)])))
        stack.enter_context(patch.object(report_channel.store,'write_session',return_value=contextlib.nullcontext(conn)))
        stack.enter_context(patch.object(report_channel.store,'transaction',side_effect=lambda c: contextlib.nullcontext()))

    def test_revision_bundle_and_stable_retry(self):
        conn=Conn(); self.setup_conn(conn)
        first = report_channel.success(None,DAY,REVISIONS,UUID(int=10),ENV)
        second = report_channel.success(None,DAY,REVISIONS,UUID(int=10),ENV)
        self.assertEqual(first, second)
        self.assertEqual(len(conn.requests), 1)
        calls=[args for sql,args in conn.calls if 'extension_event_emit' in sql]
        self.assertEqual(calls[0],calls[1])
        self.assertEqual(calls[0][2], 'garmin.report.completed')
        self.assertEqual(len(calls[0]), 9)
        self.assertEqual(calls[0][4], DAY.isoformat())
        self.assertEqual(json.loads(calls[0][5]), REVISIONS)
        self.assertIn('7일: synthetic 7d', calls[0][6])
        self.assertEqual(calls[0][7], UUID(int=10))
        self.assertEqual([[photo['filename'] for photo in album] for album in json.loads(calls[0][8])], [['01.png'],['50.png']])
        self.assertFalse(any('delete' in sql.lower() for sql,_ in conn.calls))


    def test_message_only_resend_and_format_version_idempotency(self):
        conn = Conn(); self.setup_conn(conn)
        first = report_channel.success(None, DAY, REVISIONS, None, ENV)
        retry = report_channel.success(None, DAY, REVISIONS, None, ENV)
        self.assertEqual(first, retry)
        with patch.object(report_channel.report_message, 'FORMAT_VERSION', 'report-v2'):
            changed = report_channel.success(None, DAY, REVISIONS, None, ENV)
        self.assertNotEqual(first, changed)
        for sql, args in conn.calls:
            if 'extension_event_emit' in sql:
                self.assertIsNone(args[7]); self.assertIsNone(args[8])
                self.assertTrue(args[6].startswith('[brain-markup-v1]'))
                self.assertIn('수면 5:32 · 점수 45', args[6])
        self.assertFalse(any('select i.name' in sql for sql, _ in conn.calls))

    def test_regenerate_new_revision_sends_once_and_same_revision_retry_reuses_id(self):
        conn = Conn(); self.setup_conn(conn)
        first = report_channel.success(None, DAY, REVISIONS, UUID(int=10), ENV)
        changed = dict(REVISIONS, day=2)
        regenerated = report_channel.success(None, DAY, changed, UUID(int=10), ENV)
        retried = report_channel.success(None, DAY, changed, UUID(int=10), ENV)
        self.assertNotEqual(first, regenerated)
        self.assertEqual(regenerated, retried)
        self.assertEqual(len(conn.requests), 2)
        calls = [args for sql, args in conn.calls if 'extension_event_emit' in sql]
        self.assertNotEqual(calls[0][3], calls[1][3])
        self.assertNotEqual(calls[0][5], calls[1][5])
        self.assertEqual(calls[1], calls[2])

    def test_album_chunks_preserve_group_order_at_boundaries(self):
        for count in (11, 49):
            conn = Conn()
            original = conn.execute
            def execute(sql, args):
                if 'select i.name' in sql:
                    return Cursor(rows=[(f'{i:02}.png', 'graph', UUID(int=i+100)) for i in range(1, count+1)] + [('50.png', 'graph', UUID(int=200))])
                return original(sql, args)
            conn.execute = execute
            with self.subTest(count=count), contextlib.ExitStack() as stack:
                stack.enter_context(patch('report_publish.saved_bundle', return_value=((None, b'document', None),
                    [(f'{i:02}.png', None, b'graph', None, None) for i in range(1, 100)])))
                stack.enter_context(patch.object(report_channel.store, 'write_session', return_value=contextlib.nullcontext(conn)))
                stack.enter_context(patch.object(report_channel.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()))
                report_channel.success(None, DAY, REVISIONS, UUID(int=10), ENV)
            albums = json.loads(next(args[8] for sql, args in conn.calls if 'extension_event_emit' in sql))
            self.assertEqual([len(a) for a in albums], ([10, 1, 1] if count == 11 else [10, 10, 10, 10, 9, 1]))
            self.assertEqual([p['filename'] for a in albums for p in a], [f'{i:02}.png' for i in range(1, count+1)] + ['50.png'])

    def test_past_and_current_results_are_recorded_without_delivery_settings(self):
        conn = Conn(); self.setup_conn(conn)
        for day in (DAY, DAY - timedelta(days=1)):
            self.assertIsNotNone(report_channel.success(None, day, REVISIONS, UUID(int=10), ENV))
            self.assertEqual(conn.calls[-1][1][4], day.isoformat())
        self.assertEqual(len(conn.requests), 2)

    def test_unrouted_handoff_after_file_publish_keeps_analysis_success(self):
        # 구독·메신저 없는 core도 이벤트를 보관하고 정상 id를 반환하는 계약 대역이다.
        conn = Conn(); self.setup_conn(conn)
        for day, regenerate, expected in ((DAY, False, 1), (DAY - timedelta(days=1), False, 1),
                                          (DAY - timedelta(days=1), True, 1)):
            conn.calls.clear(); conn.requests.clear()
            published = []
            original = conn.execute
            def execute(sql, args):
                if 'extension_event_emit' in sql:
                    self.assertEqual(published, ['files-complete'])
                return original(sql, args)
            with self.subTest(day=day, regenerate=regenerate), patch.dict(os.environ, ENV), \
                 patch.object(report, '_work_revisions', return_value=REVISIONS), \
                 patch('report_publish.publish_and_wait', side_effect=lambda *args: published.append('files-complete') or UUID(int=10)), \
                 patch.object(conn, 'execute', side_effect=execute):
                self.assertEqual(report.run_supervised(None, object(), today=day, regenerate=regenerate),
                                 {'status': 'noop', 'scopes': 0})
            self.assertEqual(len(conn.requests), expected)
            self.assertEqual(published, ['files-complete'])

    def test_role_probe_requires_event_emit_and_allows_legacy_channel_grants(self):
        queries = []
        def safely(conn, query, args=(), default=None):
            queries.append(query)
            if 'select exists(select 1 from pg_proc' in query:
                return [(False,)]
            if 'has_function_privilege' in query:
                return [('extension_event_emit' in query,)]
            return None
        with patch.object(role_probe, 'safely', side_effect=safely):
            checks = role_probe.probe_role(object())
        self.assertTrue(checks['event_emit_execute'])
        self.assertTrue(checks['no_excess_functions'])
        self.assertNotIn('send_execute', checks)
        with patch.object(role_probe, 'safely', side_effect=lambda conn, query, *a: [(False,)] if 'has_function_privilege' in query else None):
            self.assertFalse(role_probe.probe_role(object())['event_emit_execute'])
        self.assertNotIn('conversation_execute', checks)
        self.assertTrue(any('extension_channel_publish' in q for q in queries if 'select exists(select 1 from pg_proc' in q))
        self.assertTrue(any('extension_channel_conversation_valid' in q for q in queries if 'select exists(select 1 from pg_proc' in q))
        self.assertFalse(any('extension_channel_conversation_valid' in q for q in queries if 'select exists(select 1 from pg_proc' not in q))
        self.assertFalse(any('extension_channel_publish' in q for q in queries if 'select exists(select 1 from pg_proc' not in q))

    def test_channel_handoff_retry_does_not_regenerate(self):
        with patch.object(report, '_work_revisions', return_value=REVISIONS), patch('report_publish.publish_and_wait'), patch.object(report_channel, 'success', side_effect=RuntimeError('synthetic delivery failure')), patch.object(report.body, 'pending') as intake:
            with self.assertRaises(RuntimeError): report.run_supervised(None, object(), today=DAY)
            intake.assert_not_called()

    def test_attachment_upgrade_and_manifest_changes_have_stable_distinct_keys(self):
        conn = Conn(); self.setup_conn(conn)
        legacy = report_channel.success(None, DAY, REVISIONS, None, ENV)
        photos = [('01.png', 'graph', UUID(int=8))]
        attached = report_channel.success(None, DAY, REVISIONS, UUID(int=10), ENV, attachment_rows=photos)
        retry = report_channel.success(None, DAY, REVISIONS, UUID(int=10), ENV, attachment_rows=photos)
        changed = report_channel.success(None, DAY, REVISIONS, UUID(int=12), ENV, attachment_rows=photos)
        self.assertNotEqual(legacy, attached); self.assertEqual(attached, retry); self.assertEqual(attached, changed)
        with patch('report_publish.saved_bundle', return_value=((None, b'new document', None), [('01.png', None, b'graph:1', None, None)])):
            upgraded = report_channel.success(None, DAY, REVISIONS, UUID(int=12), ENV, attachment_rows=photos)
        self.assertNotEqual(attached, upgraded)
        report_channel.success(None, DAY, REVISIONS, None, ENV, missing_reason='artifact_render_unavailable')
        self.assertIn('보고서·그래프 없음', conn.calls[-1][1][6])


class ProductBoundaryTest(unittest.TestCase):
    def test_source_and_package_never_call_delivery_functions(self):
        import re
        root = Path(__file__).resolve().parents[3]
        for folder in (root / 'extensions/garmin/src', root / 'plugins/garmin/package/src'):
            for path in folder.rglob('*.py'):
                with self.subTest(path=path.relative_to(root)):
                    self.assertIsNone(re.search(r'select\s+brain\.extension_channel_(?:send|publish)\s*\(', path.read_text(), re.I))
                    self.assertNotIn('_should_send', path.read_text())
