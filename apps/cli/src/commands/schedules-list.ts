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
    const daily = (expr: string | null) => { const m = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(expr ?? ''); return m ? `${String(Number(m[2])).padStart(2, '0')}:${String(Number(m[1])).padStart(2, '0')}` : null; };
    const trigger = (s: (typeof r.schedules)[number]) => s.triggerKind === 'cron' ? `cron ${s.cronExpr} (${s.timeZone})` : s.triggerKind === 'once' ? `once ${at(s.runAt)}` : `interval ${s.intervalSeconds}초`;
    return { ok: true, data: { schedules: r.schedules.map(s => ({ id: s.id, kind: s.kind, hold_group: s.holdGroup, target_kind: s.targetKind, target_id: s.targetId,
      trigger_kind: s.triggerKind, cron: s.cronExpr, run_at: at(s.runAt), time_zone_source: s.timeZoneSource, schedule_key: s.scheduleKey, extension: s.extension, enabled: s.enabled, local_time: s.triggerKind === 'cron' ? daily(s.cronExpr) : null, time_zone: s.timeZone, interval_seconds: s.intervalSeconds, next_run_at: at(s.nextRunAt), last_run_at: at(s.lastRunAt), created_at: isoWithOffset(s.createdAt) })) },
      meta: { count: r.count, has_more: r.hasMore }, text: [...r.schedules.map(s => `예약 ${s.id} 종류 ${s.kind} 대상 ${s.targetKind} ${s.targetId}, ${trigger(s)}, 다음 실행 ${at(s.nextRunAt) ?? '없음'}${s.enabled ? '' : ', 비활성'}${s.held ? ', 보류 중' : ''}`), `예약 ${r.count}건.`] };
  },
};
