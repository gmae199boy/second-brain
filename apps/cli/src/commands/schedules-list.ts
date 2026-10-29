import { isoWithOffset, SCHEDULES_LIST_LIMIT } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
import { listLimit } from './list-options.js';
export const schedulesListCommand: CommandSpec = {
  ns: 'schedules', verb: 'list', nsDescription: '예약한 일을 관리합니다', usedFor: '예약한 일을 봅니다', required: [],
  examples: ['brain schedules list --json'], output: '예약 목록 schedules와 건수 count·더 있는지 has_more를 반환합니다', risk: 'read', hook: false, dryRun: false,
  options: [{ flags: '--limit <n>', description: `몇 건까지 볼지 (1~200, 기본 ${SCHEDULES_LIST_LIMIT.default})` }],
  async run(context) {
    const limit = listLimit(context.options['limit']); if (!limit.ok) return limit;
    const r = await context.brain.schedules.list(limit.value === undefined ? {} : { limit: limit.value }); if (!r.ok) return r;
    const at = (d: Date | null) => d === null ? null : isoWithOffset(d);
    return { ok: true, data: { schedules: r.schedules.map(s => ({ id: s.id, kind: s.kind, hold_group: s.holdGroup, target_kind: s.targetKind, target_id: s.targetId,
      local_time: s.localTime, time_zone: s.timeZone, interval_seconds: s.intervalSeconds, next_run_at: at(s.nextRunAt), last_run_at: at(s.lastRunAt), created_at: isoWithOffset(s.createdAt) })) },
      meta: { count: r.count, has_more: r.hasMore }, text: [...r.schedules.map(s => `예약 ${s.id} 종류 ${s.kind} 대상 ${s.targetKind} ${s.targetId}, 시각 ${s.localTime ?? '없음'}${s.held ? ', 보류 중' : ''}`), `예약 ${r.count}건.`] };
  },
};
