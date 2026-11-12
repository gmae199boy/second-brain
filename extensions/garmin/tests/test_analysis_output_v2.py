"""합성 C1·C3 fixture를 통한 운동 분석 출력 계약 검증."""
import copy
import json
from pathlib import Path
import tempfile
import unittest

from garmin_pipeline import analysis_output, errors, report

ROOT = Path(__file__).resolve().parents[1]
FIXTURES = ROOT / 'fixtures' / 'training-analysis-v2'
SCHEMA = ROOT / 'src' / 'garmin_pipeline' / 'schemas' / analysis_output.SCHEMA


def fixture(name):
    return json.loads((FIXTURES / (name + '.json')).read_text())


class AnalysisOutputV2Test(unittest.TestCase):
    def read(self, data, measurements=None, schema=SCHEMA):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'output.json'
            output.write_text(json.dumps(data))
            return report._read_output(output, schema, measurements=measurements)

    def test_all_scopes_preserve_entire_c7_payload_and_message(self):
        for scope in ('day', '7d', '30d', 'all'):
            with self.subTest(scope=scope):
                data = fixture(scope); measurements = fixture('c1-mixed-day')
                measurements['scope'] = scope
                result = self.read(data, measurements)
                self.assertEqual(result.structured, data)
                self.assertEqual(result.message, data['message'])
                self.assertEqual(result.structured['measurements_version'], 'training_measurements_v1')

    def test_missing_fields_reason_codes_and_third_action_are_rejected(self):
        cases = []
        data = fixture('day'); del data['snapshot_id']; cases.append(data)
        data = fixture('day'); data['limitations'][0]['reason_code'] = 'invented'; cases.append(data)
        data = fixture('day'); data['next_workout_actions'] *= 3; cases.append(data)
        data = fixture('day'); data['data_cutoff'] = '2026-01-03T08:00:00'; cases.append(data)
        for data in cases:
            with self.subTest(data_keys=list(data)), self.assertRaises(report.WriterFailed) as caught:
                self.read(data)
            self.assertEqual(caught.exception.reason, errors.ReportFailReason.OUTPUT_INVALID)

    def test_unknown_duplicate_and_unresolved_refs_are_rejected_without_values(self):
        for mutation in ('unknown', 'duplicate', 'source'):
            data = fixture('day')
            if mutation == 'unknown': data['message']['evidence_refs'] = ['nonexistent']
            if mutation == 'duplicate': data['evidence_refs'].append(data['evidence_refs'][0])
            if mutation == 'source': data['evidence_refs'][0]['source_ref'] = 'training_measurements.json#/private-value'
            with self.subTest(mutation=mutation), self.assertRaises(report.WriterFailed) as caught:
                self.read(data, fixture('c1-mixed-day'))
            self.assertNotIn('private-value', str(caught.exception))

    def test_header_must_match_c1_mapping_and_snapshot(self):
        for key, value in [('scope', '7d'), ('snapshot_id', 'other'), ('measurements_version', 'other'),
                           ('profile_snapshot_id', 'other'), ('range', {'start':'2026-01-01','end':'2026-01-01','timezone':'UTC'})]:
            data = fixture('day'); data[key] = value
            with self.subTest(key=key), self.assertRaises(report.WriterFailed):
                self.read(data, fixture('c1-mixed-day'))

    def test_missing_sets_are_not_no_workout_and_every_exercise_is_required(self):
        m = fixture('c1-mixed-day')
        for mutation in ('no_workout', 'missing_strength', 'missing_aerobic'):
            d = fixture('day')
            if mutation == 'no_workout': d['training_summary']['state'] = 'no_workout'
            if mutation == 'missing_strength': d['strength_findings'] = []
            if mutation == 'missing_aerobic': d['aerobic_findings'] = []
            with self.subTest(mutation=mutation), self.assertRaises(report.WriterFailed): self.read(d, m)
        # 세트가 없는 HIIT도 운동이며 duration/HR 근거를 유지한다.
        self.assertEqual(m['current']['sessions'][1]['sets'], [])
        self.assertEqual(self.read(fixture('day'), m).structured['aerobic_findings'][0]['activity_type'], 'hiit')

    def test_walk_unknown_grade_requires_explicit_limitation(self):
        for mutation in ('grade', 'reason'):
            d = fixture('day')
            if mutation == 'grade': d['aerobic_findings'][1]['grade_status'] = 'recorded'
            else: d['limitations'] = [x for x in d['limitations'] if x['reason_code'] != 'incline_unrecorded']
            with self.subTest(mutation=mutation), self.assertRaises(report.WriterFailed):
                self.read(d, fixture('c1-mixed-day'))

    def test_rest_day_and_failed_output_have_explicit_states(self):
        d = fixture('day'); m = fixture('c1-rest-day')
        d['training_summary']['state'] = 'no_workout'
        d['strength_findings'] = []; d['aerobic_findings'] = []; d['evidence_refs'] = []
        d['progression']['evidence_refs'] = []; d['next_workout_actions'] = []
        d['message']['evidence_refs'] = []; d['limitations'] = []
        self.assertEqual(self.read(d, m).structured['training_summary']['state'], 'no_workout')
        d = fixture('day'); d['status'] = 'failed'; d['message'] = None
        self.assertEqual(self.read(d).status, 'failed')
        d['message'] = fixture('day')['message']
        with self.assertRaises(report.WriterFailed): self.read(d)
        d = fixture('day'); d['message'] = None
        with self.assertRaises(report.WriterFailed): self.read(d)

    def test_legacy_output_keeps_existing_fields_and_no_structured_data(self):
        data = {key: fixture('day')[key] for key in ('status','summary','report_md','judgments','evidence','next_checks')}
        data['message'] = None
        schema = SCHEMA.with_name('daily_analysis_output.schema.json')
        result = self.read(data, schema=schema)
        self.assertIsNone(result.structured)
        self.assertEqual(result.report_md, data['report_md'])

    def test_v2_selected_only_for_c1_regular_inputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); folder = root / 'day'; folder.mkdir()
            self.assertIsNone(analysis_output.measurements_for_inputs(root, ['day']))
            (folder / 'training_measurements.json').write_text(json.dumps(fixture('c1-mixed-day')))
            self.assertEqual(analysis_output.measurements_for_inputs(root, ['day'])['schema_version'], 'training_measurements_v1')
            self.assertIsNone(analysis_output.measurements_for_inputs(root, ['day'], 'custom'))

    def test_skills_keep_exercise_priority_and_scope_roles(self):
        for skill in ('garmin-daily-analysis', 'garmin-period-review'):
            text = (ROOT / 'skills' / skill / 'SKILL.md').read_text()
            for term in ('모든 운동', '최대 2개', '경사 미기록', 'RIR', 'partial_volume', 'profile_status', 'missing_fields'):
                self.assertIn(term, text)
            self.assertNotIn('회복 판정 한 줄', text)
            self.assertLess(text.index('## 운동 중심 판단 순서'), text.index('## 출력 v2'))

    def test_same_type_sessions_require_real_complete_activity_refs(self):
        m = fixture('c1-mixed-day'); second = copy.deepcopy(m['current']['sessions'][2])
        second['session_id'] = 'second-walk'; m['current']['sessions'].append(second)
        for refs in (['synthetic-2'], [], ['invented'], ['synthetic-1']):
            d = fixture('day'); d['aerobic_findings'][1]['activity_refs'] = refs
            with self.subTest(refs=refs), self.assertRaises(report.WriterFailed): self.read(d, m)
        d['aerobic_findings'][1]['activity_refs'] = ['synthetic-2', 'second-walk']
        self.assertEqual(self.read(d, m).status, 'ok')

    def test_recorded_and_unrecorded_grade_can_be_split_or_grouped(self):
        m = fixture('c1-mixed-day'); second = copy.deepcopy(m['current']['sessions'][2])
        second['session_id'] = 'graded-walk'; second['incline'] = 5
        m['current']['sessions'].append(second)
        d = fixture('day'); row = copy.deepcopy(d['aerobic_findings'][1])
        row['activity_refs'] = ['graded-walk']; row['grade_status'] = 'recorded'
        d['aerobic_findings'].append(row)
        self.assertEqual(self.read(d, m).status, 'ok')
        d = fixture('day'); d['aerobic_findings'][1]['activity_refs'].append('graded-walk')
        self.assertEqual(self.read(d, m).status, 'ok')

    def test_limitations_must_link_to_the_affected_existing_finding(self):
        for target in ('aerobic_findings[0]', 'aerobic_findings[99]', 'invented'):
            d = fixture('day'); d['limitations'][0]['affected_judgment'] = target
            with self.subTest(target=target), self.assertRaises(report.WriterFailed):
                self.read(d, fixture('c1-mixed-day'))

    def test_writer_prompt_names_selected_output_schema(self):
        from types import SimpleNamespace
        cfg = SimpleNamespace(path=Path('/synthetic/config'), report_reasoning_effort='medium', report_model='synthetic')
        for schema in ('daily_analysis_output.schema.json', analysis_output.SCHEMA):
            argv = report.codex_argv(cfg, Path(schema), Path('/synthetic/output'), [],
                                     executable='fake', inputs=['day'], output_contract=schema)
            self.assertIn('출력 계약: ' + schema, argv[-1])
        for skill in ('garmin-daily-analysis','garmin-period-review'):
            text = (ROOT / 'skills' / skill / 'SKILL.md').read_text()
            self.assertIn('training_measurements.json`이 없으면 구 입력', text)

    def test_unknown_activity_type_is_preserved_without_inventing_a_type(self):
        m = fixture('c1-mixed-day'); m['current']['sessions'][2]['type'] = None
        d = fixture('day'); d['aerobic_findings'][1]['activity_type'] = None
        d['aerobic_findings'][1]['grade_status'] = 'not_applicable'
        self.assertEqual(self.read(d, m).structured['aerobic_findings'][1]['activity_type'], None)
        d['aerobic_findings'][1]['activity_type'] = 'walking'
        with self.assertRaises(report.WriterFailed): self.read(d, m)
