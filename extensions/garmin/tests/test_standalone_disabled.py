"""The imported CLI must not bypass the extension supervisor."""
import unittest
from unittest.mock import patch

from garmin_pipeline import cli


class StandaloneBoundaryTest(unittest.TestCase):
    def test_cli_rejects_before_loading_config(self):
        with patch.object(cli.config, 'load', side_effect=AssertionError('config loaded')):
            with self.assertRaisesRegex(RuntimeError, 'Standalone Garmin CLI is disabled'):
                cli.main(['collect'])
