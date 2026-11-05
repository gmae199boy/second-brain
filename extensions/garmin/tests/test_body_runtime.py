"""Supervised body ledger contracts; execution deferred to 21.8."""
import contextlib
import io
import json
import os
import shutil
import subprocess
import time
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import body_runtime as runtime
import body_ipc
import report_runtime
from garmin_pipeline import body, store
from test_collect_runtime import CONNECTION, USER
from test_report_runtime import report_env


class BodyRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = report_env()
        self.env['BRAIN_EXTENSION_HOME'] = self.temp.name
        self.account, self.cfg = report_runtime.envelope(self.env)
        self.root = self.cfg.path.parent
        self.inbox = self.cfg.inbox_dir / 'inbody'
        self.inbox.mkdir(parents=True)
        self.active = False
        self.valid = True
        self.row = ('UTC',)
        test = self
        class Conn:
            def execute(self, sql, args):
                assert test.active
                test.assertEqual(args, (UUID(USER), UUID(CONNECTION)))
                return type('Result', (), {'fetchone': lambda _: test.row})()
        conn = Conn()
        @contextlib.contextmanager
        def session(cfg): yield conn
        @contextlib.contextmanager
        def transaction(_conn):
            if not test.valid: raise store.StaleAttempt('stale')
            test.active = True
            try: yield conn
            finally: test.active = False
        self.stack = contextlib.ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(store, 'write_session', session))
        self.stack.enter_context(patch.object(store, 'transaction', transaction))

    def source(self, name, content='synthetic'):
        path = self.inbox / name
        path.write_text(content)
        return path.relative_to(self.root).as_posix()

    def ipc_command(self, *args, text=None, stale=False, cancel=False):
        # The CLI gets no DB connection details; only the parent invokes the fenced host handler.
        root = self.root / 'ipc-test'
        root.mkdir(exist_ok=True)
        script = Path(runtime.__file__)
        env = {'PATH': os.defpath, 'HOME': self.temp.name, 'BRAIN_BODY_IPC_DIR': str(root)}
        child = subprocess.Popen([sys.executable, str(script), *args], env=env,
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if child.stdin:
            child.stdin.write(text or '')
            child.stdin.close()
            child.stdin = None
        error = None
        deadline = time.monotonic() + 10
        while child.poll() is None and time.monotonic() < deadline:
            try:
                body_ipc.service(root, lambda action, **kwargs: runtime.execute(self.env, action, **kwargs), active=lambda: child.poll() is None)
            except (store.StaleAttempt, KeyboardInterrupt) as exc:
                error = exc
                if isinstance(exc, KeyboardInterrupt):
                    shutil.rmtree(root)
                break
            time.sleep(.01)
        if error:
            child.wait(timeout=5)
        elif child.poll() is None:
            child.kill(); child.wait()
            self.fail('body CLI did not complete')
        stdout, stderr = child.communicate(timeout=5)
        if stale:
            self.assertIsInstance(error, store.StaleAttempt)
        elif cancel:
            self.assertIsInstance(error, KeyboardInterrupt)
        else:
            self.assertIsNone(error)
        return child.returncode, stdout, stderr

    def test_cli_to_host_requests_pending_write_invalid_and_reject(self):
        source = self.source('a.txt')
        code, out, _ = self.ipc_command('pending')
        self.assertEqual((code, out.splitlines()), (0, [source]))
        code, _, _ = self.ipc_command('write', '2020-01-02', '--source', source, text='{"weight_kg":NaN}')
        self.assertNotEqual(code, 0)
        self.assertTrue((self.root / source).exists())
        code, out, _ = self.ipc_command('write', '2020-01-02', '--source', source, text='{"weight_kg":70}')
        self.assertEqual(code, 0)
        self.assertEqual(json.loads((self.root / json.loads(out)['body_path']).read_text())['values'], {'weight_kg':70})
        rejected = self.source('reject.txt')
        code, out, _ = self.ipc_command('reject', rejected)
        self.assertEqual(code, 0)
        self.assertIn('/unreadable/', out)

    def test_cli_to_host_stale_attempt_cannot_publish(self):
        source = self.source('stale.txt')
        self.valid = False
        code, _, _ = self.ipc_command('write', '2020-01-02', '--source', source,
                                     text='{"weight_kg":70}', stale=True)
        self.assertNotEqual(code, 0)
        self.assertTrue((self.root / source).exists())
        self.assertFalse((self.cfg.data_dir / 'body/2020-01-02.json').exists())

    def test_scope_closure_cancels_unhandled_cli_request(self):
        import shutil
        root = self.root / 'ipc-cancel'; root.mkdir()
        env = {'PATH': os.defpath, 'HOME': self.temp.name, 'BRAIN_BODY_IPC_DIR': str(root)}
        child = subprocess.Popen([sys.executable, str(Path(runtime.__file__)), 'pending'], env=env,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + 10
            while not list(root.glob('*.request')) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(list(root.glob('*.request')))
            shutil.rmtree(root)
            child.communicate(timeout=5)
            self.assertNotEqual(child.returncode, 0)
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_unhandled_write_request_is_discarded_at_scope_close_and_not_replayed(self):
        source = self.source('cancelled.txt')
        root = self.root / 'ipc-abandoned'; root.mkdir()
        env = {'PATH': os.defpath, 'HOME': self.temp.name, 'BRAIN_BODY_IPC_DIR': str(root)}
        child = subprocess.Popen([sys.executable, str(Path(runtime.__file__)), 'write', '2020-01-02', '--source', source],
                                 env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            child.stdin.write('{"weight_kg":70}'); child.stdin.close(); child.stdin = None
            deadline = time.monotonic() + 10
            while not list(root.glob('*.request')) and time.monotonic() < deadline:
                time.sleep(.01)
            self.assertTrue(list(root.glob('*.request')))
            shutil.rmtree(root)
            child.communicate(timeout=5)
            self.assertNotEqual(child.returncode, 0)
            self.assertEqual(runtime.execute(self.env, 'pending'), [source])
            self.assertFalse((self.cfg.data_dir / 'body/2020-01-02.json').exists())
            next_scope = self.root / 'ipc-next'; next_scope.mkdir()
            with patch.object(runtime, 'execute') as handler:
                body_ipc.service(next_scope, handler, active=lambda: True)
                handler.assert_not_called()
            code, _, _ = self.ipc_command('write', '2020-01-02', '--source', source, text='{"weight_kg":70}')
            self.assertEqual(code, 0)
            self.assertEqual(runtime.execute(self.env, 'pending'), [])
        finally:
            if child.poll() is None: child.kill(); child.wait()

    def test_pending_write_and_processed_preserve_schema(self):
        source = self.source('a.txt')
        self.assertEqual(runtime.execute(self.env, 'pending'), [source])
        result = runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[source], text='{"weight_kg": 72.4}')
        self.assertEqual(result['measured_on'], '2020-01-02')
        doc = json.loads((self.root / result['body_path']).read_text())
        self.assertEqual(doc['values'], {'weight_kg': 72.4})
        self.assertEqual(doc['source_files'], [source])
        self.assertEqual(runtime.execute(self.env, 'pending'), [])
        self.assertTrue((self.root / result['processed'][0]).is_file())

    def test_invalid_measurement_remains_pending_then_retry(self):
        source = self.source('retry.txt')
        for value in ('{"weight_kg":1,"weight_kg":2}', '{"unknown":1}', '{"weight_kg":NaN}'):
            with self.subTest(value=value), self.assertRaises(body.BodyError):
                runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[source], text=value)
            self.assertEqual(runtime.execute(self.env, 'pending'), [source])
        runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[source], text='{"weight_kg":70}')
        self.assertEqual(runtime.execute(self.env, 'pending'), [])

    def test_mtime_merge_keeps_newer_measurement_and_adds_new_fields(self):
        first = self.source('first.txt')
        os.utime(self.root / first, ns=(2_000_000_000, 2_000_000_000))
        result = runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[first], text='{"weight_kg":70}')
        second = self.source('second.txt')
        os.utime(self.root / second, ns=(1_000_000_000, 1_000_000_000))
        runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[second], text='{"weight_kg":71,"bmi":24}')
        doc = json.loads((self.root / result['body_path']).read_text())
        self.assertEqual(doc['values'], {'weight_kg': 70, 'bmi': 24})
        self.assertEqual(doc['source_files'], [first, second])

    def test_reject_requires_current_attempt_and_keeps_other_pending(self):
        source = self.source('bad.txt'); other = self.source('other.txt')
        self.valid = False
        with self.assertRaises(store.StaleAttempt): runtime.execute(self.env, 'reject', path=source)
        self.assertTrue((self.root / source).exists())
        self.valid = True
        moved = runtime.execute(self.env, 'reject', path=source)
        self.assertIn('/unreadable/', moved)
        self.assertEqual(runtime.execute(self.env, 'pending'), [other])

    def test_cancellation_before_replace_preserves_pending_and_previous_measurement(self):
        first = self.source('first.txt')
        result = runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[first], text='{"weight_kg":70}')
        old = (self.root / result['body_path']).read_bytes()
        second = self.source('second.txt')
        with patch.object(body, '_atomic_write', side_effect=KeyboardInterrupt):
            with self.assertRaises(KeyboardInterrupt):
                runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2), sources=[second], text='{"weight_kg":71}')
        self.assertEqual((self.root / result['body_path']).read_bytes(), old)
        self.assertEqual(runtime.execute(self.env, 'pending'), [second])

    def test_ipc_cancel_after_atomic_replace_preserves_pending_and_retry_merges(self):
        first, second = self.source('first.txt'), self.source('second.txt')
        for name, mtime in ((first, 3_000_000_000), (second, 2_000_000_000)):
            os.utime(self.root / name, ns=(mtime, mtime))
        atomic_write = body._atomic_write
        def after_replace(path, text):
            atomic_write(path, text)
            raise KeyboardInterrupt()
        with patch.object(body, '_atomic_write', side_effect=after_replace):
            code, _, _ = self.ipc_command('write', '2020-01-02', '--source', first, '--source', second,
                                          text='{"weight_kg":70}', cancel=True)
        self.assertNotEqual(code, 0)
        sidecar = self.cfg.data_dir / 'body/2020-01-02.json'
        published = json.loads(sidecar.read_text())
        self.assertEqual(published['values'], {'weight_kg': 70})
        self.assertEqual(published['source_files'], [first, second])
        self.assertEqual(runtime.execute(self.env, 'pending'), [first, second])
        code, out, _ = self.ipc_command('write', '2020-01-02', '--source', first, '--source', second,
                                        text='{"weight_kg":70,"bmi":22}')
        self.assertEqual(code, 0)
        recovered = json.loads(sidecar.read_text())
        self.assertEqual(recovered['values'], {'weight_kg':70, 'bmi':22})
        self.assertEqual(recovered['source_files'], [first, second])
        self.assertEqual(runtime.execute(self.env, 'pending'), [])
        self.assertEqual(len(json.loads(out)['processed']), 2)
        self.assertTrue((self.inbox / 'processed/first.txt').is_file())
        self.assertTrue((self.inbox / 'processed/second.txt').is_file())

    def test_ipc_cancel_after_first_move_retries_only_remaining_source(self):
        first, second = self.source('first.txt'), self.source('second.txt')
        for name, mtime in ((first, 3_000_000_000), (second, 2_000_000_000)):
            os.utime(self.root / name, ns=(mtime, mtime))
        move = body._move
        def after_first_move(source, directory):
            move(source, directory)
            raise KeyboardInterrupt()
        with patch.object(body, '_move', side_effect=after_first_move):
            code, _, _ = self.ipc_command('write', '2020-01-02', '--source', first, '--source', second,
                                          text='{"weight_kg":70}', cancel=True)
        self.assertNotEqual(code, 0)
        sidecar = self.cfg.data_dir / 'body/2020-01-02.json'
        published = json.loads(sidecar.read_text())
        self.assertEqual(published['values'], {'weight_kg':70})
        self.assertEqual(published['source_files'], [first, second])
        self.assertEqual(runtime.execute(self.env, 'pending'), [second])
        self.assertTrue((self.inbox / 'processed/first.txt').is_file())
        code, out, _ = self.ipc_command('write', '2020-01-02', '--source', second,
                                        text='{"weight_kg":80,"bmi":22}')
        self.assertEqual(code, 0)
        recovered = json.loads(sidecar.read_text())
        self.assertEqual(recovered['values'], {'weight_kg':70, 'bmi':22})
        self.assertEqual(recovered['source_files'], [first, second])
        self.assertEqual(runtime.execute(self.env, 'pending'), [])
        self.assertEqual(len(json.loads(out)['processed']), 1)
        self.assertTrue((self.inbox / 'processed/first.txt').is_file())
        self.assertTrue((self.inbox / 'processed/second.txt').is_file())

    def test_rejects_other_account_and_standalone_without_filesystem_change(self):
        source = self.source('a.txt'); self.row = None
        with self.assertRaises(report_runtime.InvalidReportInput): runtime.execute(self.env, 'pending')
        with self.assertRaises(report_runtime.InvalidReportInput): runtime.execute({}, 'pending')
        self.assertTrue((self.root / source).exists())
        with patch.dict(os.environ, {}, clear=True), patch('sys.stderr', new_callable=io.StringIO) as error:
            self.assertEqual(runtime.main(['pending']), 1)
            self.assertEqual(error.getvalue(), 'body command failed\n')

    def test_installs_all_packaged_skills_into_selected_runtime(self):
        report_runtime.install_skills(self.cfg)
        target = self.root / '.agents' / 'skills'
        for name in ('garmin-body-intake', 'garmin-daily-analysis', 'garmin-period-review'):
            self.assertTrue((target / name / 'SKILL.md').is_file())
        intake = (target / 'garmin-body-intake' / 'SKILL.md').read_text()
        self.assertIn('src/body_runtime.py', intake)
        self.assertNotIn('garmin-pipeline body', intake)

    def test_cli_rejects_dates_and_untrusted_sources_without_mutation(self):
        original = self.source('original.txt')
        result = runtime.execute(self.env, 'write', measured_on=date(2020, 1, 2),
                                 sources=[original], text='{"weight_kg":68}')
        sidecar = self.root / result['body_path']
        before = sidecar.read_bytes()
        source = self.source('safe.txt')
        outside = Path(self.temp.name) / 'outside.txt'
        outside.write_text('outside')
        (self.inbox / 'link.txt').symlink_to(outside)
        for day, candidate in [('2999-01-01', source), ('20200102', source),
                               ('2020-01-02', str(outside)),
                               ('2020-01-02', '../outside.txt'),
                               ('2020-01-02', 'inbox/inbody/link.txt')]:
            with self.subTest(day=day, source=candidate):
                code, _, _ = self.ipc_command('write', day, '--source', candidate,
                                               text='{"weight_kg":70}')
                self.assertNotEqual(code, 0)
                self.assertEqual((self.root / source).read_text(), 'synthetic')
                self.assertEqual(outside.read_text(), 'outside')
                self.assertEqual(sidecar.read_bytes(), before)
