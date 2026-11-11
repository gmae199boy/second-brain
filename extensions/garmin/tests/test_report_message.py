"""합성 값으로만 검증하는 메시지 서식 수락 계약."""
import unittest
from datetime import date
from garmin_pipeline import report_message as message


class MessageTest(unittest.TestCase):
    def evaluations(self):
        limitation = '직전 기간 측정값·프로필 없음'
        return {
            'day': {'summary': '과거 요약', 'message': {'headline': '약함 (이틀 연속)',
                'recommendations': ['오늘은 고강도 운동 대신 회복 우선', '다음 근력 운동은 세트 수를 줄여 재개'],
                'trend_line': '', 'limitations': [limitation]}},
            **{scope: {'summary': '과거 요약', 'message': {'trend_line': text, 'limitations': [limitation]}}
               for scope, text in [('7d', '후반으로 갈수록 회복 약화'),
                    ('30d', '등락 크고 최근 동반 악화 → 증량보다 부담 조절'),
                    ('all', '11월이 10월보다 낫지만 최근 저하로 증량 보류')]}}

    def test_approved_layout_snapshot(self):
        result = message.render(date(2026, 11, 11), self.evaluations(),
            {'sleep_total_s': 19920, 'sleep_score': 45, 'hrv_avg': 27, 'wake_bb': 22})
        self.assertEqual(result, '''[brain-markup-v1]
# 🩺 Garmin 일일 리포트 · 11/11 (수)

**오늘 회복: 약함 (이틀 연속)**
- 수면 5:32 · 점수 45
- HRV 27 ms
- 기상 Body Battery 22

👉 오늘은 고강도 운동 대신 회복 우선
👉 다음 근력 운동은 세트 수를 줄여 재개

## 📈 추세
- 7일: 후반으로 갈수록 회복 약화
- 30일: 등락 크고 최근 동반 악화 → 증량보다 부담 조절
- 전체: 11월이 10월보다 낫지만 최근 저하로 증량 보류

ℹ️ 비교 기준 부족: 직전 기간 측정값·프로필 없음''')

    def test_old_revision_fallback_and_deduplicated_limitations(self):
        old = {scope: {'summary': '회복이 약하다. 직전 기간 측정값이 부족하다.',
            'judgments': '[]', 'next_checks': '["다음 운동의 부담을 줄인다"]'} for scope in message.SCOPES}
        result = message.render(date(2026, 11, 11), old, {})
        self.assertIn('오늘 회복: 회복이 약하다.', result)
        self.assertEqual(result.count('직전 기간 측정값이 부족하다'), 1)
        self.assertIn('👉 다음 운동의 부담을 줄인다', result)
        self.assertIn('수면 측정 없음 · 점수 측정 없음', result)
        self.assertNotIn('이틀', result)

    def test_db_metrics_win_over_llm_numbers_and_keep_zero(self):
        evaluations = self.evaluations()
        evaluations['day']['summary'] = '수면 99시간, HRV 999'
        result = message.render(date(2026, 11, 11), evaluations,
            {'sleep_total_s': 0, 'sleep_score': 0, 'hrv_avg': 0, 'wake_bb': 0})
        self.assertIn('수면 0:00 · 점수 0', result)
        self.assertIn('HRV 0 ms', result)
        self.assertNotIn('999', result)

    def test_untrusted_emphasis_long_lines_and_nonfinite_metrics(self):
        evaluations = self.evaluations()
        evaluations['day']['message']['headline'] = '**' + 'x' * 10000
        result = message.render(date(2026, 11, 11), evaluations, {'hrv_avg': float('nan')})
        self.assertLess(len(result.encode('utf-16-le')) // 2, 4000)
        self.assertIn('HRV 측정 없음', result)
        self.assertEqual(result.count('**'), 2)

    def test_legacy_summary_advice_and_recovery_shortage_are_not_limitations(self):
        old = {scope: {'summary': '회복이 부족하다. 오늘은 휴식을 우선한다. 비교 측정값이 없다.'} for scope in message.SCOPES}
        result = message.render(date(2026, 11, 11), old, {})
        self.assertIn('오늘 회복: 회복이 부족하다.', result)
        self.assertIn('👉 오늘은 휴식을 우선한다.', result)
        self.assertEqual(result.count('비교 측정값이 없다'), 1)

    def test_personal_baseline_with_weak_recovery_is_not_missing_evidence(self):
        for judgments in ([], ['개인 기준보다 HRV가 낮고 회복이 부족하다.']):
            old = {scope: {'summary': '개인 기준보다 HRV가 낮고 회복이 부족하다.', 'judgments': judgments} for scope in message.SCOPES}
            result = message.render(date(2026, 11, 11), old, {})
            self.assertIn('오늘 회복: 개인 기준보다 HRV가 낮고 회복이 부족하다.', result)
            self.assertNotIn('비교 기준 부족', result)

    def test_limitation_in_next_checks_is_printed_only_once(self):
        old = {scope: {'summary': '회복이 약하다. 비교 데이터가 없다.', 'next_checks': ['비교 데이터가 없다.']} for scope in message.SCOPES}
        result = message.render(date(2026, 11, 11), old, {})
        self.assertEqual(result.count('비교 데이터가 없다'), 1)
        self.assertNotIn('👉 비교 데이터', result)
