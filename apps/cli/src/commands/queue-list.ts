import { isoWithOffset, QUEUE_LIST_LIMIT } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
import { listLimit } from './list-options.js';
export const queueListCommand: CommandSpec = {
  ns: 'queue', verb: 'list', nsDescription: '밀린 일을 처리합니다', usedFor: '일감의 상태와 사용량을 봅니다', required: [],
  examples: ['brain queue list --all --json'], output: '일감 목록 items와 상태·attempt·걸린 시간·토큰 및 건수 count·더 있는지 has_more를 반환합니다', risk: 'read', hook: false, dryRun: false,
  options: [{ flags: '--all', description: '닫힌 일감도 함께 봅니다' }, { flags: '--kind <kind>', description: '이 종류의 일감만 봅니다' }, { flags: '--limit <n>', description: `몇 건까지 볼지 (1~200, 기본 ${QUEUE_LIST_LIMIT.default})` }],
  async run(context) {
    const limit = listLimit(context.options['limit']); if (!limit.ok) return limit;
    const r = await context.brain.queue.list({ all: context.options['all'] === true, ...(typeof context.options['kind'] === 'string' ? { kind: context.options['kind'] } : {}), ...(limit.value === undefined ? {} : { limit: limit.value }) });
    if (!r.ok) return r;
    const at = (d: Date | null) => d === null ? null : isoWithOffset(d);
    return { ok: true, data: { items: r.items.map(i => ({ id: i.id, kind: i.kind, target_kind: i.targetKind, target_id: i.targetId,
      execution_class: i.executionClass, state: i.state, attempts: i.attempts, next_attempt_at: at(i.nextAttemptAt), created_at: at(i.createdAt), completed_at: at(i.completedAt), cancel_requested_at: at(i.cancelRequestedAt),
      last_error: i.lastError, attempt_outcome: i.attemptOutcome, attempt_started_at: at(i.attemptStartedAt), last_progress_at: at(i.lastProgressAt), elapsed_ms: i.elapsedMs,
      usage: i.usage === null ? null : { input_tokens: i.usage.inputTokens, cached_input_tokens: i.usage.cachedInputTokens, output_tokens: i.usage.outputTokens } })) },
      meta: { count: r.count, has_more: r.hasMore }, text: [...r.items.map(i => `일감 ${i.id} 종류 ${i.kind}, 상태 ${i.state}, 시도 ${i.attempts}회, attempt 결과 ${i.attemptOutcome ?? '없음'}, 마지막 진행 ${at(i.lastProgressAt) ?? '없음'}, 걸린 시간 ${i.elapsedMs ?? '없음'} 밀리초, 입력 토큰 ${i.usage?.inputTokens ?? '없음'}, 캐시 토큰 ${i.usage?.cachedInputTokens ?? '없음'}, 출력 토큰 ${i.usage?.outputTokens ?? '없음'}`), `일감 ${r.count}건.`] };
  },
};
