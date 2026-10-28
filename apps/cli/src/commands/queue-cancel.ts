import type { CommandSpec } from '../dispatch.js';
export const queueCancelCommand: CommandSpec = {
  ns: 'queue', verb: 'cancel', nsDescription: '밀린 일을 처리합니다',
  usedFor: '일감의 취소를 요청합니다', required: ['id'], arguments: ['<id>'],
  examples: ['brain queue cancel <id> --json'], output: '일감 id와 취소 상태(`cancelled`, `requested`, `already_closed`)를 반환합니다',
  risk: 'write', hook: false, dryRun: false, writes: true, drain: false,
  preflight(context) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.args[0] ?? ''))
      return { ok: false, code: 'USAGE', message: '일감 id는 UUID여야 합니다', exit: 2 };
    return undefined;
  },
  async run(context) {
    const result = await context.brain.queue.cancel({ id: context.args[0]! });
    if (!result.ok) return result;
    return { ok: true, data: { id: result.id, state: result.state }, text: [
      result.state === 'requested' ? '취소 요청을 접수했습니다.' : result.state === 'cancelled' ? '일감을 취소했습니다.' : '이미 닫힌 일감입니다.',
    ] };
  },
};
