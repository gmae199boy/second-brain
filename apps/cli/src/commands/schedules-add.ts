import { isoWithOffset } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';
export const schedulesAddCommand: CommandSpec = {
  ns: 'schedules', verb: 'add', nsDescription: '예약한 일을 관리합니다', usedFor: '매일 실행할 일을 예약합니다',
  required: ['kind', 'target-kind', 'target-id', 'at'], examples: ['brain schedules add --kind process_probe --target-kind probe --target-id daily --at 11:00'],
  output: '예약 id와 다음 실행 시각을 반환합니다', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  options: [ { flags: '--kind <kind>', description: '일감 종류', required: true }, { flags: '--target-kind <kind>', description: '대상 종류', required: true },
    { flags: '--target-id <id>', description: '대상 id', required: true }, { flags: '--at <HH:MM>', description: '현지 예약 시각', required: true } ],
  async run(context) {
    const r = await context.brain.schedules.add({ kind: String(context.options['kind']), targetKind: String(context.options['targetKind']), targetId: String(context.options['targetId']), localTime: String(context.options['at']) });
    if (!r.ok) return r;
    return { ok: true, data: { id: r.schedule.id, next_run_at: r.schedule.nextRunAt === null ? null : isoWithOffset(r.schedule.nextRunAt) }, text: [`예약 ${r.schedule.id}을 추가했습니다.`] };
  },
};
