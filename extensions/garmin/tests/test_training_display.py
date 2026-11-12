"""합성 기록으로 한글 표시·한 줄 수행·직전 비교를 검증한다."""
import copy
import json
from pathlib import Path
import unittest
from garmin_pipeline import training_display as display, report_message

FIXTURE = Path(__file__).resolve().parents[1] / 'fixtures/training-analysis-v2/c1-mixed-day.json'


def measurements():
    return json.loads(FIXTURE.read_text())


def strength_session(identity, key, load, reps, day='2026-01-02', kind='weighted'):
    return {'session_id': identity, 'type': 'strength_training', 'completed_date': day,
            'start_at': day + 'T09:00:00+09:00', 'sets': [
                {'exercise_key': key, 'display_name': key, 'set_type': 'ACTIVE',
                 'equipment': None, 'variant': key, 'load_kind': kind, 'load_kg': load,
                 'reps': rep, 'role': 'unknown'} for rep in reps]}


class TrainingDisplayTest(unittest.TestCase):
    def test_exact_variant_mapping_and_fallback_inventory(self):
        missing = set()
        self.assertEqual(display.display_name('PUSH_UP_WEIGHTED_PUSH_UP'), '웨이티드 푸시업')
        self.assertEqual(display.display_name('DEADLIFT_ROMANIAN_DEADLIFT'), '루마니안 데드리프트')
        self.assertEqual(display.display_name('ROW_DUMBBELL_ROW'), '덤벨 로우')
        self.assertEqual(display.display_name('walking'), '걷기')
        fallback = display.display_name('SYNTHETIC_UNMAPPED_VARIANT', missing)
        self.assertIn('미등록 운동', fallback)
        self.assertNotIn('SYNTHETIC', fallback)
        self.assertEqual(missing, {'SYNTHETIC_UNMAPPED_VARIANT'})
        self.assertEqual(display.display_name('SYNTHETIC_UNMAPPED_VARIANT'), fallback)
        self.assertNotEqual(display.display_name('SYNTHETIC_OTHER_VARIANT'), fallback)

    def test_one_line_and_only_most_recent_same_variant_comparison(self):
        value = measurements()
        key = 'PUSH_UP_WEIGHTED_PUSH_UP'
        current = strength_session('new', key, 40, [15, 14, 12])
        value['current']['sessions'] = [current]; value['current']['strength'] = []
        value['comparison'] = {'sessions': [strength_session('old', key, 50, [8, 8, 8], '2025-12-01'),
            strength_session('recent', key, 40, [15, 13, 12], '2026-01-01')], 'strength': []}
        lines = display.performance_lines(value)
        self.assertEqual(lines, ['웨이티드 푸시업 40kg × 15·14·12 (직전 대비 반복 ↑)'])
        self.assertNotIn('2025-', '\n'.join(lines))
        value['comparison']['sessions'][-1]['sets'][0]['reps'] = 15
        value['comparison']['sessions'][-1]['sets'][1]['reps'] = 14
        self.assertIn('반복 =', display.performance_lines(value)[0])
        for row in value['comparison']['sessions'][-1]['sets']: row['load_kg'] = 45
        self.assertIn('직전 45kg 대비 무게 ↓', display.performance_lines(value)[0])
        value['comparison']['sessions'] = []
        self.assertIn('첫 기록 · 비교창 내', display.performance_lines(value)[0])

    def test_missing_bodyweight_and_different_variant_are_not_comparable(self):
        value = measurements(); key = 'ROW_DUMBBELL_ROW'
        value['current']['strength'] = []
        current = strength_session('new', key, None, [10, 10], kind='missing')
        value['current']['sessions'] = [current]
        value['comparison'] = {'sessions': [strength_session('old', key, 14, [10, 10], '2026-01-01')], 'strength': []}
        self.assertIn('무게 미기록 × 10·10 (비교 불가)', display.performance_lines(value)[0])
        for row in current['sets']: row['load_kind'] = 'bodyweight'
        self.assertIn('맨몸 × 10·10 (비교 불가)', display.performance_lines(value)[0])
        value['comparison']['sessions'][0]['sets'][0]['exercise_key'] = 'ROW_OTHER'
        value['comparison']['sessions'][0]['sets'][1]['exercise_key'] = 'ROW_OTHER'
        self.assertIn('첫 기록', display.performance_lines(value)[0])

    def test_model_view_provides_korean_and_inventory_without_mutating_source(self):
        value = measurements(); before = copy.deepcopy(value)
        value['current']['sessions'][0]['sets'][0]['exercise_key'] = 'UNMAPPED_NEW_VARIANT'
        view = display.localized_measurements(value)
        self.assertIn('UNMAPPED_NEW_VARIANT', view['display']['missing_labels'])
        self.assertIn('미등록 운동', view['current']['sessions'][0]['sets'][0]['display_name'])
        self.assertEqual(view['current']['sessions'][2]['display_name'], '걷기')
        self.assertNotIn('display', value)
        self.assertEqual(value['current']['sessions'][1], before['current']['sessions'][1])

    def test_enrichment_localizes_document_and_ignores_model_performance_lines(self):
        value = measurements()
        data = {'report_md': 'PUSH_UP_WEIGHTED_PUSH_UP 및 walking',
                'performance_lines': ['모델이 만든 과거 기록 나열'], 'strength_findings': []}
        result = display.enrich_analysis(data, value)
        self.assertEqual(result['report_md'], '웨이티드 푸시업 및 걷기')
        self.assertNotIn('모델이', '\n'.join(result['performance_lines']))
        self.assertEqual(data['performance_lines'], ['모델이 만든 과거 기록 나열'])

    def test_day_and_month_message_are_short_and_one_row_per_exercise(self):
        for scope in ('day', '30d'):
            path = Path(__file__).parent / 'fixtures/messages-v2' / (scope + '.json')
            structure = json.loads(path.read_text())
            value = measurements(); value['scope'] = scope
            value['current']['sessions'] = [strength_session('new', 'PUSH_UP_WEIGHTED_PUSH_UP', 40, [15, 14, 12])]
            value['current']['strength'] = []
            structure = display.enrich_analysis(structure, value)
            text = report_message.render_scope(structure)
            self.assertLessEqual(report_message.utf16_length(text), 1500)
            block = text.split('\n운동 수행\n')[1].split('\n\n')[0]
            self.assertEqual(len(block.splitlines()), 1)
            self.assertIn('웨이티드 푸시업', block)
            self.assertNotIn('PUSH_UP', text)
            self.assertNotIn('2025-', block)

    def test_missing_set_strength_session_remains_visible(self):
        value = measurements()
        value['current']['sessions'] = [dict(strength_session('missing', 'CURL', 10, []), duration_s=600)]
        value['current']['strength'] = []
        self.assertEqual(display.performance_lines(value), ['근력 운동 1회 · 10분 (세트 상세 미기록 · 비교 불가)'])

    def test_multiple_day_sessions_are_all_included_without_average_of_averages(self):
        value = measurements(); key = 'PUSH_UP_WEIGHTED_PUSH_UP'
        walk = copy.deepcopy(value['current']['sessions'][2])
        walk.update(session_id='walk1', duration_s=600, distance_m=500, hr_avg=120)
        second = copy.deepcopy(walk); second.update(session_id='walk2', duration_s=1200, distance_m=1000, hr_avg=140)
        value['current']['sessions'] = [strength_session('new1', key, 40, [15, 14]), strength_session('new2', key, 40, [12, 11]), walk, second]
        value['current']['strength'] = []
        lines = display.performance_lines(value)
        self.assertIn('2회 · 4세트 · 1차 40kg × 15·14 / 2차 40kg × 12·11', lines[0])
        self.assertIn('2회 합계 · 30분 · 1500m · 세션 평균 심박 120~140', lines[1])

    def test_registered_variants_keep_distinct_human_labels(self):
        for first, second in [('ROW_DUMBBELL_ROW', 'ROW_DUMBBELL_ROW_WHEELCHAIR'),
                              ('TOTAL_BODY_BURPEE', 'TOTAL_BODY_BURPEE_WHEELCHAIR')]:
            self.assertNotEqual(display.display_name(first), display.display_name(second))
            self.assertIn('휠체어', display.display_name(second))
