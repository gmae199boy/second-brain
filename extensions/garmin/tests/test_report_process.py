"""Model process boundary tests; execution deferred to 21.8."""
import io
import json
import tempfile
from dataclasses import replace
import os
import subprocess
import sys
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from garmin_pipeline import errors, report
from test_report_runtime import report_env
import report_runtime


class ModelProcessTest(unittest.TestCase):
    def setUp(self):
        _, self.cfg = report_runtime.envelope(report_env())
        self.real_group = report._owned_process_group
        self.real_cleanup = report._cleanup_owned_group
        group = patch.object(report, '_owned_process_group', return_value=123)
        cleanup = patch.object(report, '_cleanup_owned_group')
        group.start(); cleanup.start()
        self.addCleanup(group.stop); self.addCleanup(cleanup.stop)

    def test_cleanup_rejects_non_owned_group_without_signalling(self):
        with patch.object(report.os, 'getpid', return_value=9), patch.object(report.os, 'getpgrp', return_value=8), patch.object(report.os, 'getsid', return_value=8), patch.object(report.os, 'kill') as kill:
            # The shared group must be owned by this report entry.
            with patch.object(report, '_owned_process_group', self.real_group):
                with self.assertRaises(report.ProcessCleanupError): self.real_cleanup(8)
            kill.assert_not_called()

    def test_cleanup_terminates_owned_descendants_before_return(self):
        with patch.object(report, '_owned_process_group', return_value=123), \
             patch.object(report, '_group_members', side_effect=[[456], []]), \
             patch.object(report.os, 'getpgid', return_value=123), \
             patch.object(report.os, 'kill') as kill, patch.object(report.time, 'sleep'):
            self.real_cleanup(123)
        kill.assert_called_once_with(456, report.signal.SIGTERM)

    def test_unconfirmed_descendants_abort_following_scope(self):
        with patch.object(report, '_owned_process_group', return_value=123), \
             patch.object(report, '_group_members', return_value=[456]), \
             patch.object(report.os, 'getpgid', return_value=123), \
             patch.object(report.os, 'kill'), patch.object(report.time, 'monotonic', side_effect=[0, 10, 10, 20]):
            with self.assertRaises(report.ProcessCleanupError): self.real_cleanup(123)

    def test_argv_preserves_workspace_schema_prompt_and_images(self):
        cfg = self.cfg.__class__(**{**vars(self.cfg), 'report_model': 'synthetic-model'})
        argv = report.codex_argv(cfg, Path('/schema'), Path('/output'), ['image.jpg'], 'fake-codex', inputs=['image.jpg'], intake=True)
        self.assertEqual(argv[:8], ['fake-codex', 'exec', '-C', str(cfg.path.parent), '-s', 'workspace-write', '--skip-git-repo-check', '--ephemeral'])
        self.assertIn('--json', argv)
        self.assertEqual(argv[argv.index('--output-schema') + 1], '/schema')
        self.assertEqual(argv[argv.index('-o') + 1], '/output')
        self.assertIn('$garmin-body-intake', argv[argv.index('-o') + 2])
        self.assertEqual(argv[-2:], ['-i', 'image.jpg'])

    def test_environment_strips_api_keys_preserves_login_and_path(self):
        with patch.dict(os.environ, {'HOME': '/synthetic/home', 'PATH': '/synthetic/bin', 'OPENAI_API_KEY': 'private', 'CODEX_API_KEY': 'private'}, clear=True):
            self.assertEqual(report._codex_env(), {'HOME': '/synthetic/home', 'PATH': '/synthetic/bin'})

    def test_model_inherits_supervisor_group_and_progress_is_not_model_stream(self):
        proc = Mock(); proc.wait.side_effect = [subprocess.TimeoutExpired('fake', 30), 0, 0]; proc.poll.side_effect = [None, 0]
        progress = Mock()
        with patch.object(report.subprocess, 'Popen', return_value=proc) as popen, patch.object(report, '_trap_sigterm', return_value=(False, None)), patch.object(report.time, 'monotonic', side_effect=[0, 0, 30, 30, 31]):
            report.CodexWriter._run(self.cfg, ['fake'], 120, stdout=subprocess.DEVNULL, progress=progress)
        self.assertFalse(popen.call_args.kwargs['start_new_session'])
        self.assertEqual(popen.call_args.kwargs['stdout'], subprocess.DEVNULL)
        progress.assert_called_once()
        proc.terminate.assert_not_called()
        proc.wait.assert_called()
        out = io.StringIO()
        with redirect_stdout(out): report._abi_progress()
        self.assertEqual(out.getvalue(), '{"abi": 1, "type": "progress"}\n')

    def test_fake_codex_rejects_unknown_skill_instead_of_defaulting_to_day(self):
        fake = Path(__file__).resolve().parent / 'report-fixture/codex'
        env = {'PATH': os.defpath, 'BRAIN_EXTENSION_HOME':'/synthetic/extension',
               'BRAIN_TARGET_ID':'synthetic', 'BRAIN_WORK_ID':'synthetic',
               'BRAIN_ATTEMPT_TOKEN':'synthetic'}
        result = subprocess.run([sys.executable, str(fake), '$garmin-unknown'], env=env,
                                capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 18)

    def test_default_public_writer_emits_abi_progress_not_model_stream(self):
        with tempfile.TemporaryDirectory(prefix='writer-progress-') as tmp:
            root = Path(tmp)
            cfg = replace(self.cfg, path=root / 'config', data_dir=root / 'data')
            proc = Mock(); proc.wait.side_effect = [subprocess.TimeoutExpired('fake', 30), 0, 0]
            proc.poll.side_effect = [None, 0]
            def spawn(argv, **kwargs):
                Path(argv[argv.index('-o') + 1]).write_text(json.dumps({
                    'status':'ok', 'summary':'synthetic', 'report_md':'synthetic',
                    'judgments':[], 'evidence':[], 'next_checks':[], 'message':None}))
                kwargs['stdout'].write(b'{"type":"turn.completed","synthetic":"model-stream"}\n')
                kwargs['stdout'].flush()
                return proc
            out = io.StringIO()
            with patch.dict(os.environ, {'BRAIN_ABI_VERSION':'1'}), \
                 patch.object(report.subprocess, 'Popen', side_effect=spawn), \
                 patch.object(report, '_trap_sigterm', return_value=(False, None)), \
                 patch.object(report.time, 'monotonic', side_effect=[0, 0, 30, 30, 31]), \
                 redirect_stdout(out):
                result = report.CodexWriter().write(cfg, ['data/report-input/day'])
            self.assertEqual(result.status, 'ok')
            self.assertEqual(out.getvalue(), '{"abi": 1, "type": "progress"}\n')
            self.assertNotIn('model-stream', out.getvalue())

    def test_host_rechecks_model_and_deadline_before_each_queued_body_request(self):
        # First handler models a slow fenced commit; the second must not begin
        # when the model exits or the deadline elapses during that commit.
        for stop in ('exit', 'timeout'):
            with self.subTest(stop=stop), tempfile.TemporaryDirectory(prefix='ipc-guard-') as tmp:
                root = Path(tmp); clock = {'now': 0.0}; handled = []
                proc = Mock(); proc.returncode = None; proc.poll.return_value = None
                proc.wait.return_value = 0
                def spawn(argv, **kwargs):
                    ipc = Path(kwargs['env']['BRAIN_BODY_IPC_DIR'])
                    payload = {'action':'pending','measured_on':None,'sources':[], 'text':None,'path':None}
                    for name in ('0' * 32, '1' * 32):
                        (ipc / (name + '.request')).write_text(json.dumps(payload))
                    return proc
                def handle(action, **kwargs):
                    handled.append(action)
                    if stop == 'exit':
                        proc.poll.return_value = 0; proc.returncode = 0
                    else:
                        clock['now'] = 11.0
                    return []
                with patch.object(report.subprocess, 'Popen', side_effect=spawn), \
                     patch.object(report, '_trap_sigterm', return_value=(False, None)), \
                     patch.object(report, '_end_child'), \
                     patch.object(report.time, 'monotonic', side_effect=lambda: clock['now']):
                    if stop == 'timeout':
                        with self.assertRaises(report.WriterFailed) as error:
                            report.CodexWriter._run(self.cfg, ['fake'], 10, body_handler=handle, workdir=root)
                        self.assertEqual(error.exception.reason, errors.ReportFailReason.CODEX_TIMEOUT)
                    else:
                        report.CodexWriter._run(self.cfg, ['fake'], 10, body_handler=handle, workdir=root)
                self.assertEqual(handled, ['pending'])
                self.assertFalse((root / 'body-ipc' / (('1' * 32) + '.response')).exists())

    def test_timeout_kills_and_reaps_direct_child(self):
        proc = Mock(); proc.poll.return_value = None
        proc.wait.side_effect = [subprocess.TimeoutExpired('fake', 1), subprocess.TimeoutExpired('fake', 5), -9]
        with patch.object(report.subprocess, 'Popen', return_value=proc), patch.object(report, '_trap_sigterm', return_value=(False, None)), patch.object(report.time, 'monotonic', side_effect=[0, 0, 2, 2, 2]):
            with self.assertRaises(report.WriterFailed) as error:
                report.CodexWriter._run(self.cfg, ['fake'], 1)
        self.assertEqual(error.exception.reason, errors.ReportFailReason.CODEX_TIMEOUT)
        proc.terminate.assert_called_once(); proc.kill.assert_called_once()

    def test_cancellation_reaps_child_without_signalling_supervisor_group(self):
        proc = Mock(); proc.poll.return_value = None
        proc.wait.side_effect = [SystemExit(143), -15, -15]
        with patch.object(report.subprocess, 'Popen', return_value=proc), patch.object(report, '_trap_sigterm', return_value=(False, None)), patch.object(os, 'killpg') as killpg:
            with self.assertRaises(SystemExit): report.CodexWriter._run(self.cfg, ['fake'], 60)
        proc.terminate.assert_called_once()
        killpg.assert_not_called()

    def test_nonzero_exit_is_classified_without_child_output(self):
        proc = Mock(); proc.wait.side_effect = [7, 7]; proc.poll.return_value = 7
        with patch.object(report.subprocess, 'Popen', return_value=proc), patch.object(report, '_trap_sigterm', return_value=(False, None)):
            with self.assertRaises(report.WriterFailed) as error:
                report.CodexWriter._run(self.cfg, ['fake'], 10)
        self.assertEqual(error.exception.reason, errors.ReportFailReason.CODEX_FAILED)
        self.assertEqual(error.exception.detail, 'exit=7')
