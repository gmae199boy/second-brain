"""Public supervised input contracts; execution deferred to ticket 21.8."""
import json
import sys
import unittest
from datetime import time
from pathlib import Path
from unittest.mock import Mock, patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
import collect_runtime
import report_runtime
from test_collect_runtime import environment
from test_report_runtime import report_env


KINDS = ('garmin.collect', 'garmin.report', 'garmin.report_regenerate')


def make_env(kind):
    env = environment() if kind == 'garmin.collect' else report_env(kind)
    offset = KINDS.index(kind) * 10
    for key, number in (('BRAIN_USER_ID', 1), ('BRAIN_TARGET_ID', 2),
                        ('BRAIN_WORK_ID', 3), ('BRAIN_ATTEMPT_TOKEN', 4)):
        env[key] = str(UUID(int=offset + number))
    snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
    snapshot['user_id'] = env['BRAIN_USER_ID']
    env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)
    return env


def edit_snapshot(env, edit):
    snapshot = json.loads(env['BRAIN_SETTINGS_SNAPSHOT'])
    edit(snapshot)
    env['BRAIN_SETTINGS_SNAPSHOT'] = json.dumps(snapshot)


class SupervisedInputContractTest(unittest.TestCase):
    def assert_rejected_before_io(self, kind, env):
        runtime = collect_runtime if kind == 'garmin.collect' else report_runtime
        error = runtime.InvalidCollectInput if kind == 'garmin.collect' else runtime.InvalidReportInput
        external = Mock()
        with patch.object(runtime.store, 'supervised_account') as bind, \
             patch.object(runtime.store, 'write_session') as write, \
             patch.object(runtime.store, 'report_session') as report_session, \
             patch.object(collect_runtime.collect, 'run') as collect, \
             patch.object(report_runtime, 'install_skills') as install:
            with self.assertRaises(error):
                if kind == 'garmin.collect':
                    runtime.run(env, port_factory=external)
                else:
                    runtime.run(env, writer=external)
            for boundary in (bind, write, report_session, collect, install, external):
                boundary.assert_not_called()

    def test_context_and_config_are_consumer_specific(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                env = make_env(kind)
                runtime = collect_runtime if kind == 'garmin.collect' else report_runtime
                account, cfg = runtime.envelope(env)
                self.assertEqual(tuple(map(str, (account.user_id, account.connection_id,
                                                  account.work_id, account.attempt_token))),
                                 tuple(env[key] for key in ('BRAIN_USER_ID', 'BRAIN_TARGET_ID',
                                                             'BRAIN_WORK_ID', 'BRAIN_ATTEMPT_TOKEN')))
                self.assertEqual((cfg.environment, cfg.timezone), ('runtime', 'UTC'))
                self.assertEqual((cfg.collect_time, cfg.retry_time, cfg.report_time),
                                 (time(11), time(11, 15), time(11, 30)))
                self.assertEqual((cfg.report_wait_minutes, cfg.date_pause_seconds, cfg.call_pause_min_seconds,
                                  cfg.call_pause_max_seconds, cfg.max_dates_per_run, cfg.max_rejected_attempts,
                                  cfg.max_consecutive_403, cfg.lock_wait_seconds, cfg.cffi_api_session),
                                 (30, 5, 1, 2, 10, 3, 3, 60, False))
                home = Path('/synthetic/extension')
                if kind == 'garmin.collect':
                    self.assertEqual((cfg.path, cfg.tokenstore, cfg.data_dir, cfg.reports_dir, cfg.inbox_dir,
                                      cfg.profile_path),
                                     (home / 'unused-config', Path('/synthetic/tokenstore'), home, home, home,
                                      home / 'unused-profile'))
                    self.assertEqual((cfg.report_model, cfg.report_reasoning_effort, cfg.report_codex_timeout_minutes),
                                     (None, 'high', 20))
                else:
                    root = home / 'reports' / 'accounts' / env['BRAIN_USER_ID'] / env['BRAIN_TARGET_ID']
                    self.assertEqual((cfg.path, cfg.tokenstore, cfg.data_dir, cfg.reports_dir, cfg.inbox_dir,
                                      cfg.profile_path),
                                     (root / 'runtime-config', root / 'unused-tokenstore', root / 'data',
                                      root / 'reports', root / 'inbox', root / 'profile.md'))
                    self.assertEqual((cfg.report_model, cfg.report_reasoning_effort, cfg.report_codex_timeout_minutes),
                                     ('synthetic-model', 'high', 20))

    def test_invalid_envelopes_fail_closed(self):
        mutations = [
            ('abi', lambda e: e.update(BRAIN_ABI_VERSION='2')),
            ('kind', lambda e: e.update(BRAIN_WORK_KIND='garmin.import')),
            ('target kind', lambda e: e.update(BRAIN_TARGET_KIND='user')),
            ('database', lambda e: e.update(BRAIN_DATABASE_URL='sqlite:///db')),
            ('generation empty', lambda e: e.update(BRAIN_RUN_GENERATION='')),
            ('generation zero', lambda e: e.update(BRAIN_RUN_GENERATION='0')),
            ('generation leading zero', lambda e: e.update(BRAIN_RUN_GENERATION='01')),
            ('generation non-ascii', lambda e: e.update(BRAIN_RUN_GENERATION='١')),
            ('generation too long', lambda e: e.update(BRAIN_RUN_GENERATION='1234567890')),
            ('user', lambda e: e.update(BRAIN_USER_ID='bad')),
            ('connection', lambda e: e.update(BRAIN_TARGET_ID='00000000-0000-0000-0000-00000000000A')),
            ('work', lambda e: e.update(BRAIN_WORK_ID='bad')),
            ('attempt', lambda e: e.update(BRAIN_ATTEMPT_TOKEN='bad')),
            ('missing field', lambda e: e.pop('BRAIN_WORK_ID')),
            ('malformed json', lambda e: e.update(BRAIN_SETTINGS_SNAPSHOT='{')),
            ('snapshot not object', lambda e: e.update(BRAIN_SETTINGS_SNAPSHOT='[]')),
            ('snapshot extra', lambda e: edit_snapshot(e, lambda s: s.update(extra=1))),
            ('snapshot missing', lambda e: edit_snapshot(e, lambda s: s.pop('values'))),
            ('snapshot bool version', lambda e: edit_snapshot(e, lambda s: s.update(version=True))),
            ('snapshot version', lambda e: edit_snapshot(e, lambda s: s.update(version=2))),
            ('snapshot extension', lambda e: edit_snapshot(e, lambda s: s.update(extension='other'))),
            ('snapshot user', lambda e: edit_snapshot(e, lambda s: s.update(user_id=str(UUID(int=99))))),
            ('settings shape', lambda e: edit_snapshot(e, lambda s: s.update(values=[]))),
            ('home path', lambda e: e.update(BRAIN_EXTENSION_HOME='relative')),
        ]
        for kind in KINDS:
            for name, mutate in mutations:
                with self.subTest(kind=kind, case=name):
                    env = make_env(kind)
                    mutate(env)
                    self.assert_rejected_before_io(kind, env)

    def test_consumers_reject_each_other_work_kinds(self):
        for kind in KINDS:
            for wrong_kind in KINDS:
                if (kind == 'garmin.collect') == (wrong_kind == 'garmin.collect'):
                    continue
                with self.subTest(consumer=kind, wrong_kind=wrong_kind):
                    env = make_env(kind)
                    edit_snapshot(env, lambda s: s['values'].update({
                        'garmin.analysis_model': 'model',
                        'garmin.channel_conversation_id': str(UUID(int=7)),
                        'garmin.tokenstore': '/synthetic/tokenstore'}))
                    env['BRAIN_WORK_KIND'] = wrong_kind
                    self.assert_rejected_before_io(kind, env)

    def test_validation_order_with_multiple_invalid_fields(self):
        for kind in KINDS:
            runtime = collect_runtime if kind == 'garmin.collect' else report_runtime
            error = runtime.InvalidCollectInput if kind == 'garmin.collect' else runtime.InvalidReportInput
            env = make_env(kind)
            original_user = env['BRAIN_USER_ID']
            original_snapshot = env['BRAIN_SETTINGS_SNAPSHOT']
            env.update(BRAIN_ABI_VERSION='2', BRAIN_DATABASE_URL='invalid',
                       BRAIN_RUN_GENERATION='0', BRAIN_USER_ID='AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA',
                       BRAIN_SETTINGS_SNAPSHOT='{')
            for label, message, repair in (
                ('abi', 'wrong work', lambda: env.update(BRAIN_ABI_VERSION='1')),
                ('database', 'invalid database', lambda: env.update(BRAIN_DATABASE_URL='postgres://synthetic/db')),
                ('generation', 'invalid generation', lambda: env.update(BRAIN_RUN_GENERATION='1')),
                ('uuid', 'non-canonical UUID', lambda: env.update(BRAIN_USER_ID=original_user)),
            ):
                with self.subTest(kind=kind, stage=label):
                    with self.assertRaises(error) as caught:
                        runtime.envelope(env)
                    self.assertEqual(str(caught.exception.__cause__), message)
                    repair()
            with self.subTest(kind=kind, stage='snapshot'):
                with self.assertRaises(error) as caught:
                    runtime.envelope(env)
                self.assertIsInstance(caught.exception.__cause__, json.JSONDecodeError)
            env['BRAIN_SETTINGS_SNAPSHOT'] = original_snapshot
            edit_snapshot(env, lambda s: s['values'].update({'garmin.unknown': 'x'}))
            with self.subTest(kind=kind, stage='settings'):
                with self.assertRaises(error) as caught:
                    runtime.envelope(env)
                self.assertEqual(str(caught.exception.__cause__), 'invalid settings')

    def test_postgresql_scheme_and_nine_digit_generation_are_accepted(self):
        for kind in KINDS:
            with self.subTest(kind=kind):
                env = make_env(kind)
                env.update(BRAIN_DATABASE_URL='postgresql://synthetic/db', BRAIN_RUN_GENERATION='999999999')
                runtime = collect_runtime if kind == 'garmin.collect' else report_runtime
                account, cfg = runtime.envelope(env)
                self.assertEqual(str(account.user_id), env['BRAIN_USER_ID'])
                self.assertEqual(cfg.timezone, 'UTC')

    def test_each_string_setting_rejects_non_strings(self):
        keys = ('garmin.timezone', 'garmin.connection_id', 'garmin.tokenstore',
                'garmin.capture_manifest', 'garmin.legacy_conversation_id',
                'garmin.analysis_agent',
                'garmin.analysis_model', 'garmin.analysis_reasoning_effort')
        for kind in KINDS:
            for key in keys:
                for value in (123, None):
                    with self.subTest(kind=kind, key=key, value=value):
                        env = make_env(kind)
                        edit_snapshot(env, lambda s: s['values'].update({key: value}))
                        self.assert_rejected_before_io(kind, env)

    def test_report_timeout_accepts_boundaries_and_integral_float(self):
        for kind in ('garmin.report', 'garmin.report_regenerate'):
            for value, expected in ((1, 1), (9007199254740991, 9007199254740991), (45.0, 45)):
                with self.subTest(kind=kind, value=value):
                    env = make_env(kind)
                    edit_snapshot(env, lambda s: s['values'].update({'garmin.analysis_timeout_minutes': value}))
                    _, cfg = report_runtime.envelope(env)
                    self.assertEqual(cfg.report_codex_timeout_minutes, expected)
                    self.assertIs(type(cfg.report_codex_timeout_minutes), int)

    def test_duplicate_keys_collect_last_value_report_rejects_at_any_depth(self):
        for kind in KINDS:
            for location in ('root', 'values'):
                with self.subTest(kind=kind, location=location):
                    env = make_env(kind)
                    raw = env['BRAIN_SETTINGS_SNAPSHOT']
                    if location == 'root':
                        raw = raw.replace('"version": 1', '"version": 2, "version": 1', 1)
                    else:
                        raw = raw.replace('"garmin.timezone": "UTC"',
                                          '"garmin.timezone": "not-used", "garmin.timezone": "UTC"', 1)
                    env['BRAIN_SETTINGS_SNAPSHOT'] = raw
                    if kind == 'garmin.collect':
                        _, cfg = collect_runtime.envelope(env)
                        self.assertEqual(cfg.timezone, 'UTC')
                    else:
                        self.assert_rejected_before_io(kind, env)

    def test_nested_duplicate_is_rejected_during_report_decode(self):
        for kind in ('garmin.report', 'garmin.report_regenerate'):
            env = make_env(kind)
            raw = env['BRAIN_SETTINGS_SNAPSHOT']
            env['BRAIN_SETTINGS_SNAPSHOT'] = raw.replace(
                '"values": {', '"values": {"garmin.unknown": {"x": 1, "x": 2}, ', 1)
            with self.subTest(kind=kind), self.assertRaises(report_runtime.InvalidReportInput) as caught:
                report_runtime.envelope(env)
            self.assertEqual(str(caught.exception.__cause__), 'duplicate snapshot key')
            self.assert_rejected_before_io(kind, env)

    def test_typed_settings_and_consumer_requirements(self):
        invalid = [('garmin.unknown', 'x'), ('garmin.timezone', 1),
                   ('garmin.analysis_agent', 'other'), ('garmin.analysis_model', '  '),
                   ('garmin.analysis_reasoning_effort', 'invalid'),
                   ('garmin.analysis_timeout_minutes', True), ('garmin.analysis_timeout_minutes', 0),
                   ('garmin.analysis_timeout_minutes', 1.5), ('garmin.analysis_timeout_minutes', '20'),
                   ('garmin.analysis_timeout_minutes', 9007199254740992)]
        for kind in KINDS:
            for key, value in invalid:
                with self.subTest(kind=kind, setting=key, value=value):
                    env = make_env(kind)
                    edit_snapshot(env, lambda s: s['values'].update({key: value}))
                    self.assert_rejected_before_io(kind, env)
            for key in ('garmin.timezone', 'garmin.tokenstore' if kind == 'garmin.collect' else 'garmin.analysis_model'):
                with self.subTest(kind=kind, missing=key):
                    env = make_env(kind)
                    edit_snapshot(env, lambda s: s['values'].pop(key))
                    self.assert_rejected_before_io(kind, env)
            if kind != 'garmin.collect':
                for value in (None, 'bad', 'AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'):
                    env = make_env(kind)
                    edit_snapshot(env, lambda s: s['values'].update({'garmin.channel_conversation_id': value}))
                    report_runtime.envelope(env)
                env = make_env(kind)
                edit_snapshot(env, lambda s: s['values'].pop('garmin.channel_conversation_id', None))
                report_runtime.envelope(env)
        # The collect builder omits both report-only required settings.
        _, cfg = collect_runtime.envelope(make_env('garmin.collect'))
        self.assertIsNone(cfg.report_model)
        for kind in KINDS:
            env = make_env(kind)
            edit_snapshot(env, lambda s: s['values'].update({'garmin.analysis_agent': 'codex',
                'garmin.analysis_model': 'model', 'garmin.analysis_reasoning_effort': 'medium',
                'garmin.analysis_timeout_minutes': 45}))
            runtime = collect_runtime if kind == 'garmin.collect' else report_runtime
            _, cfg = runtime.envelope(env)
            if kind == 'garmin.collect':
                self.assertEqual((cfg.report_model, cfg.report_reasoning_effort, cfg.report_codex_timeout_minutes),
                                 (None, 'high', 20))
            else:
                self.assertEqual((cfg.report_model, cfg.report_reasoning_effort, cfg.report_codex_timeout_minutes),
                                 ('model', 'medium', 45))


if __name__ == '__main__':
    unittest.main()
