"""실 계정 호출 없이 가짜 CLI로 C6 계약을 검증한다."""
import json
import os
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch

from garmin_pipeline import analysis_agent as agent, report
import report_runtime
from test_report_runtime import report_env, setting


class AnalysisAgentTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='analysis-agent-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        _, cfg = report_runtime.envelope(report_env())
        self.cfg = replace(cfg, path=self.root / 'runtime', data_dir=self.root / 'data',
                           analysis_agent='claude', report_model='sonnet')
        folder = self.root / 'inputs'
        folder.mkdir()
        (folder / 'scope.json').write_text('{"scope":"7d","synthetic":true}')
        (self.root / 'profile.md').write_text('synthetic-profile')
        self.inputs = ['inputs', 'profile.md']
        for target, value in (('_owned_process_group', 123), ('_cleanup_owned_group', None)):
            patcher = patch.object(report, target, return_value=value)
            patcher.start(); self.addCleanup(patcher.stop)

    def fake(self, mode='ok'):
        path = self.root / 'claude'
        code = '''import json, os, sys, time
from pathlib import Path
args = sys.argv[1:]
mode = MODE
if args == ['--version']:
    print('2.1.290 (Claude Code)' if mode != 'old' else '2.1.200 (Claude Code)')
elif args == ['auth','status']:
    print(json.dumps({'loggedIn':mode != 'logout','authMethod':'api_key' if mode == 'api' else 'claude.ai'}))
    if mode == 'logout': sys.exit(1)
else:
    assert '--safe-mode' in args and '--bare' not in args
    assert args[args.index('--tools') + 1] == ''
    assert args[args.index('--permission-prompts') + 1] == 'none'
    assert '--strict-mcp-config' in args and '--no-session-persistence' in args
    assert args[args.index('--model') + 1] == 'sonnet'
    assert args[args.index('--effort') + 1] == 'high'
    for key in ('BRAIN_DATABASE_URL','BRAIN_ATTEMPT_TOKEN','BRAIN_SETTINGS_SNAPSHOT','ANTHROPIC_API_KEY',
                'ANTHROPIC_AUTH_TOKEN','CLAUDE_CODE_USE_BEDROCK','OPENAI_API_KEY','CODEX_API_KEY','CLAUDE_CODE_OAUTH_TOKEN'):
        assert key not in os.environ
    assert os.environ['HOME'].endswith('analysis-home')
    instructions = Path(args[args.index('--append-system-prompt-file') + 1]).read_text()
    assert not instructions.startswith('---') and '$garmin-' not in instructions
    assert 'garmin-period-review' in instructions or 'garmin-daily-analysis' in instructions
    data = json.load(sys.stdin)
    assert data['scope'] in ('day','7d','30d','all','custom')
    assert any(f['content'] == 'synthetic-profile' for f in data['files'])
    if mode == 'timeout':
        time.sleep(10)
    if mode == 'exit':
        print('private synthetic payload', file=sys.stderr); sys.exit(19)
    result = {'status':'ok','summary':'synthetic','report_md':'synthetic',
              'judgments':[],'evidence':[],'next_checks':[],'message':None}
    if mode == 'schema': result['summary'] = 1
    if mode == 'failed': result['status'] = 'failed'
    envelope = {'type':'result','subtype':'success','is_error':False,'structured_output':result,
                'usage':{'input_tokens':10,'cache_read_input_tokens':2,'cache_creation_input_tokens':3,'output_tokens':4}}
    if mode == 'missing': del envelope['structured_output']
    if mode == 'refusal': envelope['subtype'] = 'error_during_execution'; envelope['is_error'] = True
    if mode == 'text': print('```json\\n' + json.dumps(result) + '\\n```')
    elif mode == 'large': print('x' * (4 * 1024 * 1024 + 1))
    else: print(json.dumps(envelope))
'''.replace('MODE', repr(mode))
        path.write_text('#!' + sys.executable + '\n' + code)
        path.chmod(0o700)
        return str(path)

    def run_fake(self, mode='ok', scope='7d', timeout=2):
        executable = self.fake(mode)
        env = {'HOME': str(self.root / 'analysis-home'), 'PATH':os.defpath,
               **dict.fromkeys(('ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','OPENAI_API_KEY','CODEX_API_KEY',
                 'CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_OAUTH_TOKEN','BRAIN_DATABASE_URL','BRAIN_ATTEMPT_TOKEN','BRAIN_SETTINGS_SNAPSHOT'), 'private')}
        with patch.dict(os.environ, env, clear=True):
            writer = report.AnalysisWriter(provider='claude', executable=executable, timeout_seconds=timeout)
            return writer.period(self.cfg, self.inputs, scope) if scope else writer.write(self.cfg, self.inputs)

    def test_all_analysis_scopes_use_structured_output_and_native_usage(self):
        for scope in (None, '7d', '30d', 'all', 'custom'):
            with self.subTest(scope=scope):
                result = self.run_fake(scope=scope)
                self.assertEqual(result.status, 'ok')
                self.assertEqual(result.usage, {'input_tokens':10,'cache_read_input_tokens':2,
                    'cache_creation_input_tokens':3,'output_tokens':4})
                self.assertNotIn('cached_input_tokens', result.usage)
                self.assertEqual(list(self.cfg.data_dir.iterdir()), [])

    def test_bad_envelopes_schema_text_and_resource_limits_are_rejected(self):
        for mode in ('missing', 'refusal', 'schema', 'text', 'large'):
            with self.subTest(mode=mode), self.assertRaises(report.WriterFailed) as raised:
                self.run_fake(mode)
            self.assertEqual(raised.exception.reason, 'output_invalid')
            self.assertNotIn('private', str(raised.exception))
            self.assertEqual(list(self.cfg.data_dir.iterdir()), [])

    def test_preflight_rejects_old_cli_and_api_login(self):
        for mode, reason in (('old','agent_capability_unsupported'), ('api','agent_login_required'), ('logout','agent_login_required')):
            with self.subTest(mode=mode), self.assertRaises(report.WriterFailed) as raised:
                self.run_fake(mode)
            self.assertEqual(raised.exception.reason, reason)
            self.assertEqual(list(self.cfg.data_dir.iterdir()), [])

    def test_timeout_and_nonzero_exit_use_neutral_failures_and_cleanup(self):
        for mode, reason in (('timeout','agent_timeout'), ('exit','agent_failed')):
            with self.subTest(mode=mode), self.assertRaises(report.WriterFailed) as raised:
                self.run_fake(mode, timeout=.5 if mode == 'timeout' else 2)
            self.assertEqual(raised.exception.reason, reason)
            self.assertNotIn('private', str(raised.exception))
            self.assertEqual(list(self.cfg.data_dir.iterdir()), [])

    def test_configuration_checks_combinations_before_spawn(self):
        for provider, model, effort in (('claude','gpt-synthetic','high'), ('codex','sonnet','high'),
            ('claude','sonnet','none'), ('claude','sonnet','minimal'), ('claude','sonnet','max')):
            with self.subTest(provider=provider, model=model, effort=effort), patch.object(report.subprocess,'Popen') as spawn:
                with self.assertRaises(report.WriterFailed):
                    report.AnalysisWriter(provider=provider, executable=self.fake()).write(
                        replace(self.cfg, report_model=model, report_reasoning_effort=effort), self.inputs)
                spawn.assert_not_called()
        agent.validate_selection('claude', 'opus', 'max')
        env = report_env(); setting(env,'garmin.analysis_agent','claude'); setting(env,'garmin.analysis_model','sonnet')
        self.assertEqual(report_runtime.envelope(env)[1].analysis_agent, 'claude')
        setting(env,'garmin.analysis_reasoning_effort','minimal')
        with self.assertRaises(report_runtime.InvalidReportInput): report_runtime.envelope(env)

    def test_selected_writer_and_intake_stay_on_their_provider(self):
        fake = self.fake()
        env = {'BRAIN_ANALYSIS_AGENT':'claude', 'BRAIN_ANALYSIS_EXECUTABLE':fake,'BRAIN_CODEX_PATH':fake}
        writer = report.analysis_writer(self.cfg, env, body_handler='synthetic')
        self.assertEqual(writer.provider, 'claude')
        with patch.object(report.CodexWriter, '_execute', return_value={'status':'ok'}) as intake:
            self.assertEqual(writer.intake(self.cfg, []), {'status':'ok'})
            self.assertIsNone(intake.call_args.args[0].report_model)
            self.assertTrue(intake.call_args.kwargs['intake'])
        self.assertEqual(report.stored_model(self.cfg), 'claude:sonnet')
        with self.assertRaises(report.AnalysisAgentNotFound):
            report.analysis_executable('claude', {'BRAIN_ANALYSIS_AGENT':'codex','BRAIN_CODEX_PATH':fake})

    def test_input_symlinks_and_missing_files_are_rejected(self):
        (self.root / 'inputs' / 'link.json').symlink_to(self.root / 'profile.md')
        with self.assertRaises(report.WriterFailed): self.run_fake()

    def test_shared_environment_preserves_login_location_without_runtime_secrets(self):
        with patch.dict(os.environ, {'HOME':'/synthetic','PATH':'/bin','CODEX_HOME':'/synthetic/codex',
            'CLAUDE_CONFIG_DIR':'/synthetic/claude','BRAIN_DATABASE_URL':'private','BRAIN_ATTEMPT_TOKEN':'private'}, clear=True):
            self.assertEqual(report._codex_env(), {'HOME':'/synthetic','PATH':'/bin','CODEX_HOME':'/synthetic/codex'})
            self.assertEqual(agent.analysis_environment('claude'), {'HOME':'/synthetic','PATH':'/bin','CLAUDE_CONFIG_DIR':'/synthetic/claude'})

    def test_bounded_json_rejects_deep_input_and_private_modes(self):
        path = self.root / 'output'
        agent.private_write(path, '[' * 2000 + '0' + ']' * 2000)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)
        with self.assertRaises(ValueError): agent.bounded_json(path)

    def test_missing_requested_scope_or_profile_is_rejected(self):
        for inputs in (['missing-scope', 'profile.md'], ['inputs', 'missing-profile.md']):
            self.inputs = inputs
            with self.subTest(inputs=inputs), self.assertRaises(report.WriterFailed): self.run_fake()


class ActualSupervisionTest(unittest.TestCase):
    def test_claude_timeout_reaps_real_descendants_in_owned_group(self):
        import subprocess
        with tempfile.TemporaryDirectory(prefix='analysis-supervision-') as temporary:
            root = Path(temporary)
            child = root / 'child.pid'
            script = '''
import os, subprocess, sys
from pathlib import Path
from types import SimpleNamespace
from garmin_pipeline import report
report.KILL_GRACE_SECONDS = .2
cfg = SimpleNamespace(path=Path(sys.argv[1]) / 'config')
code = "import os,signal,time; from pathlib import Path; signal.signal(signal.SIGTERM, signal.SIG_IGN); Path(" + repr(sys.argv[2]) + ").write_text(str(os.getpid())); time.sleep(30)"
parent = "import subprocess,sys,time; subprocess.Popen([sys.executable,'-c'," + repr(code) + "]); time.sleep(30)"
try:
    report.AnalysisWriter._run(cfg, [sys.executable,'-c',parent], .5, provider='claude', cwd=Path(sys.argv[1]))
except report.WriterFailed as error:
    print(error.reason)
    assert not report._group_members(os.getpid())
else:
    raise AssertionError('timeout required')
'''
            process = subprocess.run([sys.executable, '-c', script, str(root), str(child)],
                env={**os.environ, 'PYTHONPATH': str(Path(__file__).resolve().parents[1] / 'src')},
                capture_output=True, text=True, timeout=10, start_new_session=True)
            self.assertEqual(process.returncode, 0, process.stderr)
            self.assertEqual(process.stdout.strip(), 'agent_timeout')
            self.assertTrue(child.is_file())
