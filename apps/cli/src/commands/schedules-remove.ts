import type { CommandSpec } from '../dispatch.js';
import { scheduleIdPreflight } from './list-options.js';
export const schedulesRemoveCommand: CommandSpec = {
  ns: 'schedules', verb: 'remove', nsDescription: '예약한 일을 관리합니다', usedFor: '예약을 지웁니다', required: ['id'], arguments: ['<id>'],
  examples: ['brain schedules remove <id> --json'], output: '예약 삭제 결과를 반환합니다',
  risk: 'write', writes: true, drain: false, hook: false, dryRun: false, preflight: scheduleIdPreflight,
  async run(context) {
    const r = await context.brain.schedules.remove({ id: context.args[0]! }); if (!r.ok) return r;
    return { ok: true, data: { id: r.id }, text: ['예약을 지웠습니다.'] };
  },
};
