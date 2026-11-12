"""Synthetic model view preserves training coverage and original evidence paths."""
import copy
import json
from pathlib import Path
import unittest
from garmin_pipeline import compact_measurements, analysis_output

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/training-analysis-v2/c1-mixed-day.json'

class CompactMeasurementsTest(unittest.TestCase):
    def test_every_session_set_window_missing_value_and_reference_is_preserved(self):
        original = json.loads(FIXTURE.read_text())
        original['comparison'] = copy.deepcopy(original['current'])
        before = copy.deepcopy(original)
        result = compact_measurements.build(original)
        self.assertEqual(original, before)
        view = result['measurements']
        self.assertEqual(view['recovery_context'], original['recovery_context'])
        self.assertEqual(view['limitations'], original['limitations'])
        for window in ('current','comparison'):
            self.assertEqual(view[window]['strength'], original[window]['strength'])
            self.assertEqual(view[window]['coverage'], original[window]['coverage'])
            self.assertEqual(len(view[window]['sessions']), len(original[window]['sessions']))
            for compact, raw in zip(view[window]['sessions'], original[window]['sessions']):
                for key in raw:
                    if key != 'heart_rate': self.assertEqual(compact[key], raw[key])
                summary = compact['heart_rate_summary']
                self.assertEqual(summary['sample_count'], len(raw['heart_rate']))
                self.assertEqual(analysis_output._pointer(original, summary['source_ref']), raw['heart_rate'])
        for row in result['evidence_ref_index']:
            self.assertEqual(analysis_output._pointer(original, row['source_ref'])['session_id'], row['session_id'])
            analysis_output._pointer(original, row['sets_ref'])

    def test_dense_samples_are_summarized_not_truncated_or_changed_to_zone_time(self):
        original = json.loads(FIXTURE.read_text())
        rows = [{'at':f'synthetic-{i}', 'bpm':100 + i % 20} for i in range(10000)]
        original['current']['sessions'][0]['heart_rate'] = rows
        view = compact_measurements.build(original)['measurements']
        summary = view['current']['sessions'][0]['heart_rate_summary']
        self.assertEqual(summary['sample_count'], 10000)
        self.assertEqual(summary['mean_bpm'], 109.5)
        self.assertEqual(summary['quality'], 'unknown')
        self.assertEqual(view['current']['sessions'][0]['zones'], original['current']['sessions'][0]['zones'])
        self.assertLess(len(json.dumps(view)), len(json.dumps(original)) / 2)
