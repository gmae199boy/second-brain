import type { CommandSpec } from '../dispatch.js';

const description = '채널 발신 요청의 상태와 재전송을 관리합니다';
const line = (r: { messengerId?: string | null; channelId?: string | null; id: string; delivery: string; workState: string; attempts: number; nextAttemptAt: Date | null; unresolvedFailures: number; resendEligible: boolean }) =>
  `요청 ${r.id}: 메신저 ${r.messengerId ?? '미확정'}, 채널 ${r.channelId ?? '미확정'}, 발신 ${r.delivery}, 일감 ${r.workState}, 시도 ${r.attempts}, 다음 시도 ${r.nextAttemptAt?.toISOString() ?? '예정 없음'}, 미해결 실패 ${r.unresolvedFailures}, 재전송 ${r.resendEligible ? '가능' : '불가'}`;
export const channelsListCommand: CommandSpec = {
  ns: 'channels', verb: 'list', nsDescription: description, usedFor: '채널 요청을 조회합니다', required: [],
  examples: ['brain channels list --json'], output: '민감한 원문을 제외한 채널 요청 목록', risk: 'read', hook: false, dryRun: false,
  async run({ brain }) { const r = await brain.channels.list(); if (!r.ok) return r; return { ok: true, data: { requests: r.requests }, text: r.requests.map(line) }; },
};
export const channelsStatusCommand: CommandSpec = {
  ns: 'channels', verb: 'status', nsDescription: description, usedFor: '채널 요청 상태를 조회합니다', required: ['id'], arguments: ['<id>'],
  examples: ['brain channels status <request-id> --json'], output: '요청의 발신 및 일감 상태', risk: 'read', hook: false, dryRun: false,
  async run({ brain, args }) { const r = await brain.channels.status({ id: args[0]! }); if (!r.ok) return r; return { ok: true, data: r.request, text: [line(r.request)] }; },
};
export const channelsResendCommand: CommandSpec = {
  ns: 'channels', verb: 'resend', nsDescription: description, usedFor: '닫힌 실패 요청을 다시 발신하도록 접수합니다', required: ['id'], arguments: ['<id>'],
  examples: ['brain channels resend <request-id> --json'], output: '재전송 일감 ID', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run({ brain, args }) { const r = await brain.channels.resend({ id: args[0]! }); if (!r.ok) return r; return { ok: true, data: { workItemId: r.workItemId }, text: ['재전송을 접수했습니다. 상태를 다시 확인하세요.'] }; },
};

export const channelsAddCommand: CommandSpec = {
  ns: 'channels', verb: 'add', nsDescription: description, usedFor: '메신저 안에 목적지 채널을 발신 없이 등록합니다',
  required: [], arguments: ['[kind]'], examples: ['brain channels add --messenger <id> --chat <id> --name reports', 'brain channels add telegram'],
  options: [{ flags: '--messenger <id>', description: '메신저 ID 또는 별칭' }, { flags: '--chat <id>', description: '텔레그램 대화 ID' }, { flags: '--id <uuid>', description: '갱신할 채널 ID' }, { flags: '--name <name>', description: '메신저 안에서 유일한 채널 별칭' }, { flags: '--thread <id>', description: '텔레그램 주제·스레드 ID' }],
  output: '메신저 ID와 채널 ID', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run({ brain, args, options }) {
    if (options['messenger'] !== undefined) {
      const result = await brain.channels.configureChannel({ messengerId: String(options['messenger']), chatId: String(options['chat'] ?? ''), channelId: options['id'] as string | undefined, name: options['name'] as string | undefined, threadId: options['thread'] as string | undefined });
      return result.ok ? { ok: true, data: { messengerId: result.messengerId, channelId: result.channelId }, text: [`메신저 ${result.messengerId}, 채널 ${result.channelId}`] } : result;
    }
    if (args[0] !== 'telegram' || Object.keys(options).some(k => k !== 'json')) return { ok: false, code: 'INVALID_ARGUMENT', message: '--messenger와 --chat을 지정하세요', exit: 2 };
    const result = await brain.channels.add({ kind: args[0] });
    if (!result.ok) return result;
    return { ok: true, data: { conversationId: result.conversationId }, text: [result.conversationId] };
  },
};
