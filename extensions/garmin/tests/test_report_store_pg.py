"""Synthetic report storage contracts; execution deferred to ticket 21.8."""
import contextlib
import json
import os
import sys
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from garmin_pipeline import report, store

USER = UUID('00000000-0000-4000-8000-000000000001')
ACCOUNT = UUID('00000000-0000-4000-8000-000000000002')
DAY = date(2026, 1, 2)

class Result:
    def __init__(self, row=None): self.row = row
    def fetchone(self): return self.row

class Conn:
    user_id, connection_id, readonly = USER, ACCOUNT, False
    def __init__(self): self.rows, self.calls, self.depth = [], [], 0
    def close(self): pass
    def execute(self, sql, args=()):
        self.calls.append((sql, args))
        if 'insert into garmin.evaluation_revisions' in sql:
            assert self.depth == 2
            revision = len(self.rows) + 1
            self.rows.append((args[2], args[3], args[4], args[5], args[6], args[7], args[8], args[9], args[10], revision))
            return Result((revision,))
        if 'from garmin.evaluation where' in sql:
            assert args == (USER, ACCOUNT, DAY.isoformat(), 'day')
            return Result(self.rows[-1] if self.rows else None)
        if 'SELECT EXISTS' in sql: return Result((False,))
        return Result()

@contextlib.contextmanager
def transaction(conn):
    assert conn.depth in (0, 1)
    conn.depth += 1
    try: yield conn
    finally: conn.depth -= 1

class ReportStoreTest(unittest.TestCase):
    def test_two_revisions_and_latest_reader(self):
        conn = Conn()
        @contextlib.contextmanager
        def session(_cfg): yield conn
        cfg = SimpleNamespace(report_model='synthetic')
        def analysis(text):
            return SimpleNamespace(summary='summary ' + text, judgments=[], evidence=[], next_checks=[], report_md=text,
                message={'headline': text, 'recommendations': [], 'trend_line': '', 'limitations': []})
        with patch.dict(os.environ, {'BRAIN_WORK_ID':str(USER)}), patch.object(store, 'transaction', transaction), patch.object(store, 'write_session', session), \
             patch.object(store, 'read_connection', return_value=conn):
            self.assertIsNone(report._today_evaluation(cfg, DAY, 'day'))
            report._save_evaluation(cfg, DAY, 'day', analysis('first'))
            report._save_evaluation(cfg, DAY, 'day', analysis('second'))
            self.assertEqual(report._today_evaluation(cfg, DAY, 'day'), ('second', 'summary second'))
        self.assertEqual([row[-1] for row in conn.rows], [1, 2])
        self.assertEqual(conn.rows[0][6], 'first')
        self.assertEqual(json.loads(conn.rows[1][3]), [])
        saved = [args for sql, args in conn.calls if 'insert into garmin.evaluation_revisions' in sql]
        self.assertEqual([json.loads(args[11])['headline'] for args in saved], ['first', 'second'])
        for sql, args in conn.calls:
            if 'evaluation_revisions' in sql or 'from garmin.evaluation where' in sql:
                self.assertIn(USER, args)
                self.assertIn(ACCOUNT, args)

    def test_model_work_occurs_between_write_transactions(self):
        conn = Conn()
        @contextlib.contextmanager
        def session(_cfg): yield conn
        class Writer:
            def write(self, cfg, inputs):
                self.assert_outside()
                return SimpleNamespace(status='ok', report_md='synthetic', summary='summary', usage=None,
                                       judgments=[], evidence=[], next_checks=[])
            def assert_outside(self): assert conn.depth == 0
        cfg = SimpleNamespace(report_model='synthetic')
        with patch.dict(os.environ, {'BRAIN_WORK_ID':str(USER)}), patch.object(store, 'transaction', transaction), patch.object(store, 'write_session', session):
            result, _, failure, _ = report._evaluate(cfg, Writer(), [], 'day', [])
            self.assertIsNone(failure)
            report._save_evaluation(cfg, DAY, 'day', result)
        self.assertEqual(conn.depth, 0)

    def test_manifest_does_not_expose_standalone_operations(self):
        manifest = json.loads((Path(__file__).resolve().parents[1] / 'manifest.json').read_text())
        entries = [manifest['connection_check']['entry'], *(work['entry'] for work in manifest['work'])]
        self.assertFalse(any(name in entry for entry in entries for name in ('config.py', 'schedule.py', 'telegram.py', 'cli.py')))
