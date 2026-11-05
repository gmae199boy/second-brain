"""The imported CLI must not bypass the extension supervisor."""
import unittest

from garmin_pipeline import cli


class StandaloneBoundaryTest(unittest.TestCase):
    def test_cli_rejects_before_loading_config(self):
        with self.assertRaisesRegex(RuntimeError, 'Standalone Garmin CLI is disabled'):
            cli.main(['collect'])
