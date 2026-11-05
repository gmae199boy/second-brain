"""Schedule envelope contract; execution deferred to 21.8."""
import unittest
from datetime import date
from scheduled_date import scheduled_date


class ScheduledDateTest(unittest.TestCase):
    def test_uses_account_zone_not_utc_date(self):
        env={'BRAIN_OCCURRENCES':'["2026-01-01T16:30:00.000+00:00"]','BRAIN_RANGE_FROM':'2026-01-02','BRAIN_RANGE_TO':'2026-01-02'}
        self.assertEqual(scheduled_date(env,'Asia/Seoul'),date(2026,1,2))
        self.assertIsNone(scheduled_date({},'Asia/Seoul'))
        with self.assertRaises(ValueError): scheduled_date(env,'UTC')

    def test_missing_or_malformed_fields_are_rejected(self):
        for env in ({'BRAIN_RANGE_FROM':'2026-01-01'},
                    {'BRAIN_OCCURRENCES':'["2026-02-30T00:00:00.000+00:00"]','BRAIN_RANGE_FROM':'2026-02-30','BRAIN_RANGE_TO':'2026-02-30'},
                    {'BRAIN_OCCURRENCES':'["2026-01-01T00:00:00.000+00:00","2026-01-01T01:00:00.000+00:00"]','BRAIN_RANGE_FROM':'2026-01-01','BRAIN_RANGE_TO':'2026-01-01'}):
            with self.subTest(env=env), self.assertRaises(ValueError): scheduled_date(env,'UTC')
