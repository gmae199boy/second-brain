"""Channel handoff contracts; these tests run in ticket 21.8."""
import contextlib
import json
import sys
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch
from uuid import UUID
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import report_channel
from garmin_pipeline import report

DAY = date(2026, 1, 2)
REVISIONS = {'day': 1, '7d': 2, '30d': 3, 'all': 4}
ENV = {'BRAIN_WORK_ID': str(UUID(int=5)), 'BRAIN_ATTEMPT_TOKEN': str(UUID(int=6)),
       'BRAIN_SETTINGS_SNAPSHOT': json.dumps({'values': {'garmin.channel_conversation_id': str(UUID(int=7))}})}

class Cursor:
    def __init__(self, row=None, rows=()): self.row, self.rows = row, rows
    def fetchone(self): return self.row
    def fetchall(self): return self.rows

class Conn:
    user_id, connection_id = UUID(int=1), UUID(int=2)
    def __init__(self): self.calls = []
    def execute(self, sql, args):
        self.calls.append((sql,args))
        if 'select summary' in sql: return Cursor(('synthetic '+args[3],))
        if 'select i.name' in sql: return Cursor(rows=[('01.png','graph',UUID(int=8)),('50.png','graph',UUID(int=9)),('report.md','report',UUID(int=10))])
        if 'extension_channel_publish' in sql: return Cursor((UUID(int=11),))
        raise AssertionError(sql)

class ChannelTest(unittest.TestCase):
    def setup_conn(self, conn):
        stack=contextlib.ExitStack(); self.addCleanup(stack.close)
        stack.enter_context(patch.object(report_channel.store,'write_session',return_value=contextlib.nullcontext(conn)))
        stack.enter_context(patch.object(report_channel.store,'transaction',side_effect=lambda c: contextlib.nullcontext()))

    def test_revision_bundle_and_stable_retry(self):
        conn=Conn(); self.setup_conn(conn)
        report_channel.success(None,DAY,REVISIONS,UUID(int=10),ENV)
        report_channel.success(None,DAY,REVISIONS,UUID(int=10),ENV)
        calls=[args for sql,args in conn.calls if 'extension_channel_publish' in sql]
        self.assertEqual(calls[0],calls[1])
        self.assertEqual(calls[0][4], 'report')
        self.assertIn('7일: synthetic 7d', calls[0][6])
        self.assertEqual(calls[0][7], UUID(int=10))
        self.assertEqual([[photo['filename'] for photo in album] for album in json.loads(calls[0][8])], [['01.png'],['50.png']])
        self.assertFalse(any('delete' in sql.lower() for sql,_ in conn.calls))

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
                stack.enter_context(patch.object(report_channel.store, 'write_session', return_value=contextlib.nullcontext(conn)))
                stack.enter_context(patch.object(report_channel.store, 'transaction', side_effect=lambda c: contextlib.nullcontext()))
                report_channel.success(None, DAY, REVISIONS, UUID(int=10), ENV)
            albums = json.loads(next(args[8] for sql, args in conn.calls if 'extension_channel_publish' in sql))
            self.assertEqual([len(a) for a in albums], ([10, 1, 1] if count == 11 else [10, 10, 10, 10, 9, 1]))
            self.assertEqual([p['filename'] for a in albums for p in a], [f'{i:02}.png' for i in range(1, count+1)] + ['50.png'])

    def test_failure_notice_is_idempotent_and_never_deletes_evaluations(self):
        conn=Conn(); self.setup_conn(conn)
        report_channel.failure(None,DAY,ENV); report_channel.failure(None,DAY,ENV)
        calls=[args for sql,args in conn.calls if 'extension_channel_publish' in sql]
        self.assertEqual(calls[0],calls[1]); self.assertEqual(calls[0][4], 'report_failed')
        self.assertIn('report_failed', calls[0][6])
        self.assertFalse(any('delete' in sql.lower() for sql,_ in conn.calls))

    def test_channel_handoff_retry_does_not_regenerate(self):
        with patch.object(report, '_work_revisions', return_value=REVISIONS), patch('report_publish.publish_and_wait'), patch.object(report_channel, 'success', side_effect=RuntimeError('synthetic delivery failure')), patch.object(report.body, 'pending') as intake:
            with self.assertRaises(RuntimeError): report.run_supervised(None, object(), regenerate=True, today=DAY)
            intake.assert_not_called()
