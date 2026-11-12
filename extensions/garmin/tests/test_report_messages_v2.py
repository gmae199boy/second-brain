"""C3 대역으로 검증하는 기간별 메시지·예산·불변 manifest 계약."""
import contextlib
import copy
import json
import unittest
from datetime import date
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import report_channel
from garmin_pipeline import errors, report, report_message as messages

FIXTURES = Path(__file__).parent / 'fixtures' / 'messages-v2'
DAY = date(2026, 1, 2)


def fixture(scope='day'):
    return json.loads((FIXTURES / (scope + '.json')).read_text())


class MessageV2Test(unittest.TestCase):
    def test_scope_isolation_and_actual_range(self):
        texts = []
        for scope in messages.SCOPES:
            value = fixture(scope)
            value['training_summary']['headline'] = '고유판정-' + scope
            value['limitations'][0]['detail'] = '고유한계-' + scope
            text = messages.render_scope(value)
            self.assertIn('고유판정-' + scope, text)
            self.assertIn('고유한계-' + scope, text)
            self.assertIn(value['range']['start'], text)
            self.assertIn(value['data_cutoff'], text)
            for other in set(messages.SCOPES) - {scope}:
                self.assertNotIn('고유판정-' + other, text)
            self.assertLessEqual(messages.utf16_length(text), 4000)
            texts.append(text)
        self.assertEqual(len(set(texts)), 4)

    def test_unknown_activity_type_is_not_listed_as_performance(self):
        value = fixture()
        value['aerobic_findings'][0]['activity_type'] = None
        self.assertNotIn('운동 수행', messages.render_scope(value))

    def test_budget_drops_whole_sentences_and_keeps_actions_and_limitations(self):
        value = fixture()
        sentence = '😀' * 2100 + '문장끝.'
        value['strength_findings'] = [{'exercise_key': '합성운동', 'observed_change': sentence,
                                      'interpretation': '짧은 해석 문장.'}] * 30
        text = messages.render_scope(value)
        self.assertLessEqual(messages.utf16_length(text), 4000)
        self.assertNotIn('😀', text)
        self.assertNotIn('합성운동', text)
        self.assertNotIn('운동 수행', text)
        self.assertIn(value['next_workout_actions'][0]['action'], text)
        self.assertIn(value['limitations'][0]['detail'], text)
        self.assertNotIn('…', text)

    def test_all_scopes_omit_performance_with_or_without_host_lines(self):
        for scope in messages.SCOPES:
            for enriched in (False, True):
                with self.subTest(scope=scope, enriched=enriched):
                    value = fixture(scope)
                    value['recovery_context'] = [{'context': '합성 회복 관측.', 'effect_on_training': '조건 유지.', 'uncertainty': '인과 불확실.'}]
                    if enriched:
                        value['performance_lines'] = ['합성 수행 기록 10kg × 10·10']
                    text = messages.render_scope(value)
                    self.assertNotIn('운동 수행', text)
                    self.assertNotIn('합성 수행 기록', text)
                    self.assertNotIn('상세 기록은 통합 문서 참고', text)
                    for label in ('판정', '다음 운동', '회복', '한계'):
                        self.assertIn('\n' + label + '\n', text)
                    # 수행 행의 유무·길이가 나머지 구획에 영향을 주지 않는다.
                    value['performance_lines'] = ['다른 수행 행' * 2000] * 20
                    self.assertEqual(messages.render_scope(value), text)

    def test_conditional_action_is_an_indivisible_semantic_unit(self):
        value = fixture()
        value['next_workout_actions'][0].update(action='무게를 올린다.', reason='합성 이유.', condition='통증이 없고 ' + '조건' * 2500 + '일 때만.')
        text = messages.render_scope(value)
        self.assertNotIn('무게를 올린다.', text)
        self.assertIn('일부 내용', text)
        self.assertLessEqual(messages.utf16_length(text), 4000)

    def test_missing_attachments_are_visible_without_mutating_manifest(self):
        manifest = {'version':2, 'messages':[{'itemId':'summary:'+scope, 'text':messages.render_scope(fixture(scope))} for scope in messages.SCOPES]}
        manifest['messages'][-1]['text'] += '\n통합 문서에서 전체 평가를 확인하세요.'
        original = copy.deepcopy(manifest)
        delivered = messages.delivery_messages(manifest, 'artifact_render_unavailable')
        self.assertIn('보고서·그래프 없음', delivered[-1]['text'])
        self.assertNotIn('통합 문서에서', delivered[-1]['text'])
        self.assertEqual(manifest, original)
        self.assertTrue(all(messages.utf16_length(item['text']) <= 4000 for item in delivered))

    def test_manifest_is_reused_after_renderer_changes(self):
        class Conn:
            user_id, connection_id = 'user', 'connection'
            saved = None
            def execute(self, sql, args):
                if 'select manifest' in sql: result = None if self.saved is None else (self.saved,)
                elif 'to_jsonb' in sql: result = (fixture(args[3]),)
                elif 'insert into' in sql:
                    self.saved = json.loads(args[-1]); result = None
                else: raise AssertionError(sql)
                return SimpleNamespace(fetchone=lambda: result)
        conn = Conn(); revisions = dict.fromkeys(messages.SCOPES, 1)
        first = messages.load_messages(conn, DAY, revisions)
        self.assertEqual([x['itemId'] for x in first['messages']], ['summary:' + x for x in messages.SCOPES])
        with patch.object(messages, 'render_scope', side_effect=AssertionError('재렌더 금지')):
            self.assertEqual(messages.load_messages(conn, DAY, revisions), first)

    def test_mixed_snapshot_never_forms_completed_message_bundle(self):
        class Conn:
            user_id, connection_id = 'user', 'connection'
            def execute(self, sql, args):
                value = fixture(args[3]) if 'to_jsonb' in sql else None
                if value and args[3] == '7d': value['snapshot_id'] = 'b' * 64
                return SimpleNamespace(fetchone=lambda: (value,) if value else None)
        with self.assertRaisesRegex(ValueError, 'snapshot mismatch'):
            messages.load_messages(Conn(), DAY, dict.fromkeys(messages.SCOPES, 1))

    def test_repeated_failure_class_stops_after_one_repair_and_records_terminal_result(self):
        with patch.object(report, '_scope_retry_state', return_value=(None, False)), \
             patch.object(report, '_reserve_scope_attempt', side_effect=[1, 2, 3, None]), \
             patch.object(report, '_record_scope_diagnostic') as record, \
             patch.object(report, '_assert_attempt_current'), \
             patch.object(report, '_evaluate', return_value=(None, None, errors.ReportFailReason.CODEX_FAILED, None)) as evaluate:
            result = report._evaluate_with_retries(None, None, [], '7d', [], DAY)
        self.assertIsNotNone(result[2]); self.assertEqual(evaluate.call_count, 2)
        self.assertEqual(record.call_count, 2)
        self.assertEqual([call.args[4].feedback for call in record.call_args_list], [None, 'AGENT_EXIT'])
        self.assertTrue(record.call_args.kwargs['terminal'])

    def test_success_stops_retrying_immediately_and_reuses_same_inputs(self):
        with patch.object(report, '_scope_retry_state', return_value=(None, False)), \
             patch.object(report, '_reserve_scope_attempt', side_effect=[1, 2]), \
             patch.object(report, '_record_scope_diagnostic') as record, \
             patch.object(report, '_assert_attempt_current'), \
             patch.object(report, '_evaluate', side_effect=[(None, None, 'failed', None), ('saved', None, None, None)]) as evaluate:
            self.assertEqual(report._evaluate_with_retries(None, None, ['fixed-snapshot'], 'day', [], DAY)[0], 'saved')
        self.assertEqual(evaluate.call_count, 2)
        self.assertTrue(all(call.args[2] == ['fixed-snapshot'] for call in evaluate.call_args_list))
        self.assertEqual(record.call_args.args[4].code, 'SUCCESS')

    def test_performance_rows_do_not_expand_other_sections(self):
        value = fixture()
        value['training_summary'].update(headline='판정' * 80 + '.', assessment='해석' * 80 + '.')
        value['next_workout_actions'] = [dict(value['next_workout_actions'][0], action=f'제안{i}' + '행동' * 80, reason='이유' * 50, condition='조건' * 50) for i in range(2)]
        value['performance_lines'] = [f'합성종목{i} 10kg × 10·10·10 (직전 대비 반복 =)' for i in range(12)]
        text = messages.render_scope(value)
        self.assertLessEqual(messages.utf16_length(text), 4000)
        for line in value['performance_lines']:
            self.assertNotIn(line, text)
        self.assertIn('제안0', text); self.assertIn('제안1', text)
        self.assertIn('한계', text)
        self.assertIn('판정' * 80, text)

    def test_one_overlong_action_has_explicit_placeholder_and_keeps_other_action(self):
        value = fixture()
        value['next_workout_actions'] = [dict(value['next_workout_actions'][0], condition='조건' * 1000),
                                        dict(value['next_workout_actions'][0], action='두번째 짧은 행동', condition='짧은 조건')]
        text = messages.render_scope(value)
        self.assertIn('조건을 포함한 다음 운동 제안은 통합 문서', text)
        self.assertIn('두번째 짧은 행동', text)
        self.assertIn('일부 내용', text)

    def test_recovery_keeps_context_effect_and_uncertainty_together(self):
        value = fixture()
        value['recovery_context'] = [{'context': '합성 회복 관측이다.', 'effect_on_training': '다음 수행은 유지한다.',
                                      'uncertainty': '원인으로 단정할 수 없다.'}]
        text = messages.render_scope(value)
        for part in value['recovery_context'][0].values():
            self.assertIn(part, text)

    def test_oversized_header_is_rejected_instead_of_exceeding_hard_limit(self):
        value = fixture(); value['range']['timezone'] = '합성' * 3000
        with self.assertRaisesRegex(ValueError, 'header exceeds'):
            messages.render_scope(value)
