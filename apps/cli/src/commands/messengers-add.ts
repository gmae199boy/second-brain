import type { CommandSpec } from '../dispatch.js';
export const messengersAddCommand: CommandSpec = {
  ns: 'messengers', verb: 'add', nsDescription: '메신저 계정과 봇을 관리합니다', usedFor: '자격 증명을 가진 메신저를 등록하거나 갱신합니다',
  required: ['kind'], arguments: ['<kind>'], options: [{ flags: '--token <value>', description: '봇 토큰(-는 stdin)', required: true }, { flags: '--id <uuid>', description: '갱신할 메신저 ID' }, { flags: '--name <name>', description: '메신저 별칭' }],
  examples: ['brain messengers add telegram --name reports --token -'], output: 'messengerId와 configured(비밀 제외)', risk: 'write', writes: true, drain: false, hook: false, dryRun: false,
  async run({ brain, args, options, stdin }) {
    const token = options['token'] === '-' ? (await stdin()).replace(/\r?\n$/, '') : String(options['token']);
    const result = await brain.channels.configureMessenger({ kind: args[0]!, token, messengerId: options['id'] as string | undefined, name: options['name'] as string | undefined });
    return result.ok ? { ok: true, data: { messengerId: result.messengerId, configured: true }, text: [`메신저 ${result.messengerId} (토큰 설정됨)`] } : result;
  },
};

export const messengersListCommand: CommandSpec = {
  ns: 'messengers', verb: 'list', nsDescription: '메신저 계정과 봇을 관리합니다', usedFor: '등록한 메신저와 그 안의 채널을 조회합니다',
  required: [], examples: ['brain messengers list --json'], output: '메신저·채널 ID, 별칭, 종류, 자격 증명 설정 여부', risk: 'read', hook: false, dryRun: false,
  async run({ brain }) {
    const result = await brain.channels.inventory();
    return result.ok ? { ok: true, data: { messengers: result.messengers, channels: result.channels }, text: [...result.messengers.map(m => `메신저 ${m.messengerId} (${m.name ?? m.kind}), 자격 증명 ${m.configured ? '설정됨' : '레거시 설정 사용'}`), ...result.channels.map(c => `메신저 ${c.messengerId}, 채널 ${c.channelId} (${c.name ?? '별칭 없음'})`)] } : result;
  },
};
