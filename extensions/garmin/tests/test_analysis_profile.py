"""합성 프로필만 사용하여 검증·작업 pin·입력 전달·하위 호환을 확인한다."""
import json
import sys
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'src'))
from garmin_pipeline import analysis_profile
from test_report_runtime import report_env, setting
import report_runtime
import period_analysis_runtime


class ProfileTest(unittest.TestCase):
    def cfg(self, root, raw=None, work=1):
        env = report_env()
        if raw is not None:
            setting(env, 'garmin.analysis_profile', raw)
        cfg = report_runtime.envelope(env)[1]
        return replace(cfg, data_dir=root / 'data', profile_path=root / 'account' / 'profile.md',
                       profile_snapshot_id=str(UUID(int=work)))

    def test_none_partial_complete_and_explicit_empty_lists(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            absent = analysis_profile.snapshot(self.cfg(root))
            self.assertEqual(absent['profile_status'], 'absent')
            self.assertEqual(set(absent['missing_fields']), set(analysis_profile.FIELDS))
            partial = analysis_profile.snapshot(self.cfg(root, '{"schema_version":1,"goals":{"primary":"감량"},"constraints":[]}', 2))
            self.assertEqual(partial['profile_status'], 'partial')
            self.assertNotIn('goals.primary', partial['missing_fields'])
            self.assertNotIn('constraints', partial['missing_fields'])
            self.assertIn('goals.target_weight_kg', partial['missing_fields'])
            profile = {'schema_version': 1, 'goals': {'primary': '감량', 'secondary': [], 'target_weight_kg': 75, 'target_date': '2028-02-29'},
                       'height_cm': 170, 'equipment': {'gym': [], 'home': [], 'availability': '미정'},
                       'preferences': {'preferred': [], 'avoid': []}, 'constraints': [],
                       'diet': {'usual_pattern': '사용자 입력'}, 'alcohol_units': [{'kind': '소주', 'unit': '병'}]}
            complete = analysis_profile.snapshot(self.cfg(root, json.dumps(profile), 3))
            self.assertEqual(complete['profile_status'], 'complete')
            self.assertEqual(complete['missing_fields'], [])
            self.assertEqual(complete['source'], 'db')
            self.assertNotIn('ml', complete['profile']['alcohol_units'][0])

    def test_same_work_all_scopes_and_retry_keep_profile_hash_new_work_reads_new_value(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cfg = self.cfg(root, '{"schema_version":1,"goals":{"primary":"감량"}}')
            expected = None
            for scope in ('day', '7d', '30d', 'all'):
                folder = root / scope
                folder.mkdir()
                metadata = analysis_profile.write(cfg, folder)
                value = (folder / 'profile.json').read_text(encoding='utf-8')
                expected = expected or value
                self.assertEqual(value, expected)
                self.assertIn('missing_fields', (folder / 'profile.md').read_text(encoding='utf-8'))
                self.assertEqual(metadata['sha256'], json.loads(value)['sha256'])
            changed = replace(cfg, analysis_profile='{"schema_version":1,"goals":{"primary":"유지"}}')
            self.assertEqual(analysis_profile.snapshot(changed), json.loads(expected))
            new = analysis_profile.snapshot(replace(changed, profile_snapshot_id=str(UUID(int=2))))
            self.assertNotEqual(new['sha256'], json.loads(expected)['sha256'])
            self.assertEqual(new['profile']['goals']['primary'], '유지')

    def test_only_current_account_file_fallback_db_wins_and_no_promotion(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cfg = self.cfg(root)
            old = root / 'data' / 'report-input' / 'old' / 'profile.md'
            old.parent.mkdir(parents=True)
            old.write_text('승격 금지', encoding='utf-8')
            self.assertEqual(analysis_profile.snapshot(cfg)['source'], 'none')
            cfg.profile_path.parent.mkdir(parents=True)
            cfg.profile_path.write_text('계정 사용자 자료', encoding='utf-8')
            fallback = analysis_profile.snapshot(replace(cfg, profile_snapshot_id=str(UUID(int=2))))
            self.assertEqual(fallback['source'], 'legacy_file')
            self.assertEqual(fallback['profile_status'], 'absent')
            self.assertEqual(fallback['legacy_markdown'], '계정 사용자 자료')
            db = self.cfg(root, '{"schema_version":1,"goals":{"primary":"감량"}}', 3)
            self.assertEqual(analysis_profile.snapshot(db)['source'], 'db')
            self.assertNotIn('legacy_markdown', analysis_profile.snapshot(db))
            # 명시적 빈 DB 문서도 기존 계정 파일보다 우선한다.
            empty = analysis_profile.snapshot(self.cfg(root, '{"schema_version":1}', 4))
            self.assertEqual(empty['source'], 'db')
            self.assertEqual(cfg.profile_path.read_text(encoding='utf-8'), '계정 사용자 자료')
            self.assertEqual(old.read_text(encoding='utf-8'), '승격 금지')

    def test_unreadable_legacy_is_distinct_and_does_not_abort_analysis(self):
        with tempfile.TemporaryDirectory() as directory:
            cfg = self.cfg(Path(directory))
            cfg.profile_path.parent.mkdir(parents=True)
            cfg.profile_path.write_bytes(b'\xff')
            value = analysis_profile.snapshot(cfg)
            self.assertEqual(value['source'], 'legacy_unreadable')
            self.assertEqual(value['profile_status'], 'absent')

    def test_runtime_snapshot_is_validated_and_detached_from_environment(self):
        env = report_env()
        setting(env, 'garmin.analysis_profile', '{"schema_version":1,"goals":{"primary":"감량"}}')
        cfg = report_runtime.envelope(env)[1]
        setting(env, 'garmin.analysis_profile', '{"schema_version":1,"goals":{"primary":"유지"}}')
        self.assertEqual(analysis_profile.parse(cfg.analysis_profile)['goals']['primary'], '감량')
        for raw in ('{}', '{"schema_version":2}', '{"schema_version":true}', '{"schema_version":1,"goals.primary":"감량"}',
                    '{"schema_version":1,"goals":{"target_weight_kg":0}}', '{"schema_version":1,"goals":{"target_weight_kg":true}}',
                    '{"schema_version":1,"goals":{"target_date":"2026-02-30"}}', '{"schema_version":1,"height_cm":NaN}',
                    '{"schema_version":1,"alcohol_units":[{"kind":"소주","unit":"병","abv_percent":101}]}',
                    '{"schema_version":1,"extra":1}'):
            with self.subTest(raw=raw):
                setting(env, 'garmin.analysis_profile', raw)
                with self.assertRaises(report_runtime.InvalidReportInput):
                    report_runtime.envelope(env)

    def test_profile_wire_encoding_budget_is_validated(self):
        raw = json.dumps({'schema_version': 1, 'constraints': ['\\' * 1800, '\\' * 1800]})
        self.assertLess(len(raw.encode('utf-8')), 8192)
        with self.assertRaises(ValueError):
            analysis_profile.parse(raw)

    def test_custom_period_receives_json_markdown_and_status_from_same_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            cfg = self.cfg(root, '{"schema_version":1,"goals":{"primary":"감량"}}')
            seen = []
            def period(config, folder, day, scope, **kwargs):
                value = json.loads((folder / 'profile.json').read_text(encoding='utf-8'))
                manifest = json.loads((folder / 'manifest.json').read_text(encoding='utf-8'))
                self.assertEqual(value['sha256'], manifest['analysis_profile']['sha256'])
                self.assertEqual(value['profile_status'], 'partial')
                seen.append(value)
                return folder
            with patch.object(period_analysis_runtime.report_input, 'build_period', side_effect=period), \
                 patch.object(period_analysis_runtime.report, '_assert_attempt_current'), \
                 patch.object(period_analysis_runtime.body, 'runtime_root', return_value=root), \
                 patch.object(period_analysis_runtime.report, '_evaluate', return_value=('result', None, None, None)) as evaluate:
                result = period_analysis_runtime._analyze(cfg, {'start_date': '2026-01-01', 'end_date': '2026-01-31'}, 'writer')
                self.assertEqual(result, 'result')
                self.assertEqual(len(seen), 1)
                self.assertTrue(evaluate.call_args.args[2][1].endswith('/profile.md'))


if __name__ == '__main__':
    unittest.main()
