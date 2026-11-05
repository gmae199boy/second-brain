"""Product packaging and retired entry-point contracts; run in 21.8."""
import hashlib
import json
import re
import tomllib
import unittest
from datetime import date
from pathlib import Path

from garmin_pipeline import config, errors, ports

ROOT = Path(__file__).resolve().parents[1]


class ProductBoundaryTest(unittest.TestCase):
    def test_source_has_no_legacy_operating_routes(self):
        forbidden = re.compile(r'api\.telegram\.org|TelegramAdapter|TelegramNotifier|TelegramReportSink|TelegramNoticeSender|launchctl|launchd|install-schedule|config\.load\s*\(|import\s+tomllib|GARMIN_PIPELINE_CONFIG|config\.toml')
        hits = [(str(path.relative_to(ROOT)), match.group()) for path in (ROOT/'src').rglob('*.py') for match in forbidden.finditer(path.read_text(encoding='utf-8'))]
        self.assertEqual(hits, [])
        self.assertFalse((ROOT/'src/garmin_pipeline/telegram.py').exists())
        self.assertFalse((ROOT/'src/garmin_pipeline/schedule.py').exists())
        self.assertFalse(hasattr(config, 'load'))

    def test_python_distribution_excludes_oracle_and_fixtures(self):
        project = tomllib.loads((ROOT/'pyproject.toml').read_text(encoding='utf-8'))
        discovery = project['tool']['setuptools']['packages']['find']
        self.assertEqual(discovery['where'], ['src'])
        self.assertIn('garmin_pipeline.*', discovery['include'])
        self.assertIn('oracle.*', discovery['exclude'])
        manifest = (ROOT/'MANIFEST.in').read_text(encoding='utf-8').splitlines()
        self.assertIn('prune tests', manifest)
        self.assertIn('prune fixtures', manifest)
        self.assertIn('exclude UPSTREAM.md', manifest)
        runtime = json.loads((ROOT/'manifest.json').read_text(encoding='utf-8'))
        if 'files' in runtime:
            self.assertTrue(all(not name.startswith(('tests/', 'fixtures/')) and name != 'UPSTREAM.md' for name in runtime['files']))

    def test_oracle_is_pinned_and_notice_semantics_survive(self):
        upstream = (ROOT/'UPSTREAM.md').read_text(encoding='utf-8')
        for name in ('digest.py', 'report_input.py'):
            path = ROOT/'tests/oracle/src/garmin_pipeline'/name
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            self.assertIn(f'{digest}  src/garmin_pipeline/{name}', upstream)
        notice = ports.notice_text(date(2026, 1, 2), errors.NotifyEvent.REPORT_FAILED, 'codex_failed')
        self.assertIn('report_failed', notice)
        self.assertIn('리포트 작성 실패', notice)
        self.assertIn('codex_failed', notice)
