import type { CommandSpec } from '../dispatch.js';
import { scheduleIdPreflight } from './list-options.js';
export const schedulesRunCommand: CommandSpec = {
  ns: 'schedules', verb: 'run', nsDescription: '예약한 일을 관리합니다', usedFor: '예약을 지금 실행합니다', required: ['id'], arguments: ['<id>'],
  examples: ['brain schedules run <id> --json'], output: '예약 id와 일감 id·생성 여부를 반환합니다',
  risk: 'write', writes: true, drain: false, hook: false, dryRun: false, preflight: scheduleIdPreflight,
  async run(context) {
    const r = await context.brain.schedules.run({ scheduleId: context.args[0]! }); if (!r.ok) return r;
    return { ok: true, data: { schedule_id: context.args[0]!, work_id: r.workId, created: r.created }, text: ['예약을 실행 요청했습니다.'] };
  },
};
