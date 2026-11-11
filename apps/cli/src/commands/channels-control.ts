import { readFile } from 'node:fs/promises';
import type { CommandSpec } from '../dispatch.js';
const meta = { ns: 'channels', nsDescription: '채널과 topic 발신을 관리합니다', risk: 'write' as const, writes: true, drain: false, hook: false, dryRun: false } as const;
const invalid = (message: string) => ({ ok: false as const, code: 'INVALID_ARGUMENT', message, exit: 2 as const });
export const channelsRouteCommand: CommandSpec = {
  ...meta, verb: 'route', required: ['action'], arguments: ['<action>', '[topic]'], usedFor: 'topic 경로를 set/list/remove 합니다',
  options: [{ flags: '--topic <topic>', description: '발신 topic' }, { flags: '--messenger <id>', description: '메신저 ID 또는 별칭' }, { flags: '--channel <id>', description: '해당 메신저 안의 채널 ID 또는 별칭' }],
  examples: ['brain channels route set garmin.report --messenger <id> --channel <id>'], output: '주제와 메신저·채널 ID',
  async run({ brain, args, options }) {
    if (!['set','list','remove'].includes(args[0]!)) return invalid('route set/list/remove 중 하나를 지정하세요');
    const result = await brain.channels.route({ action: args[0] as 'set' | 'list' | 'remove', topic: args[1] ?? options['topic'] as string | undefined, messengerId: options['messenger'] as string | undefined, channelId: options['channel'] as string | undefined });
    return result.ok ? { ok: true, data: { routes: result.routes }, text: result.routes.map(r => `${r.topic}: ${r.messengerId} / ${r.channelId}`) } : result;
  },
};
export const channelsSubscribeCommand: CommandSpec = {
  ...meta, verb: 'subscribe', required: ['action'], arguments: ['<action>', '[event]'], usedFor: '결과 이벤트의 발송 목적지와 시각 구독을 set/list/remove 합니다',
  options: [{ flags: '--messenger <id>', description: '메신저 ID 또는 별칭' }, { flags: '--channel <id>', description: '채널 ID 또는 별칭' },
    { flags: '--at <time>', description: 'immediate(기본) 또는 매일 현지 HH:MM' }, { flags: '--tz <zone>', description: 'IANA 시간대(생략하면 사용자 timezone)' }],
  examples: ['brain channels subscribe set garmin.report.completed --messenger personal --channel reports --at 08:20'], output: '이벤트 구독과 유효 발송 시각·시간대',
  async run({ brain, args, options }) {
    if (!['set','list','remove'].includes(args[0]!)) return invalid('subscribe set/list/remove 중 하나를 지정하세요');
    const result = await brain.channels.subscribe({ action: args[0] as 'set' | 'list' | 'remove', event: args[1],
      messengerId: options['messenger'] as string | undefined, channelId: options['channel'] as string | undefined,
      at: options['at'] as string | undefined, timeZone: options['tz'] as string | undefined });
    return result.ok ? { ok: true, data: { subscriptions: result.subscriptions }, text: result.subscriptions.map(s => `${s.event}: ${s.messengerId} / ${s.channelId}, ${s.at} (${s.timeZone}, ${s.timeZoneSource})`) } : result;
  },
};
export const channelsSendCommand: CommandSpec = {
  ...meta, verb: 'send', required: [], usedFor: 'topic으로 지금 또는 지정 시각에 발신을 접수합니다',
  options: [{ flags: '--topic <topic>', description: '발신 topic' }, { flags: '--messenger <id>', description: '직접 발신 메신저' }, { flags: '--channel <id>', description: '직접 발신 채널' }, { flags: '--text <text>', description: '메시지 본문(-는 stdin)' },
    { flags: '--file <path>', description: '본문을 읽을 UTF-8 파일' }, { flags: '--at <timestamp>', description: '시간대가 포함된 ISO 시각' }, { flags: '--key <key>', description: '재접수 멱등 키' }],
  examples: ['brain channels send --topic garmin.report --text -'], output: '발신 요청 ID',
  async run({ brain, options, stdin }) {
    const text = options['text'] as string | undefined, file = options['file'] as string | undefined;
    if ((text === undefined) === (file === undefined)) return invalid('--text 또는 --file 중 하나를 지정하세요');
    let body: string;
    try { body = file !== undefined ? await readFile(file, 'utf8') : text === '-' ? await stdin() : text!; }
    catch { return invalid('본문 파일을 읽을 수 없습니다'); }
    const result = await brain.channels.send({ topic: options['topic'] as string | undefined, messengerId: options['messenger'] as string | undefined, channelId: options['channel'] as string | undefined, text: body, at: options['at'] as string | undefined, key: options['key'] as string | undefined });
    return result.ok ? { ok: true, data: { id: result.id }, text: [result.id] } : result;
  },
};
export const channelsSendPendingCommand: CommandSpec = {
  ...meta, verb: 'send-pending', required: [], usedFor: '보관된 미경로 요청과 닫힌 실패를 명시적으로 발신 대기열에 넣습니다',
  options: [{ flags: '--topic <topic>', description: '기존 발신 topic(--event와 택일)' }, { flags: '--event <event>', description: '보관한 결과 이벤트 이름' }, { flags: '--date <date>', description: 'topic은 UTC 접수일, event는 대상 날짜 YYYY-MM-DD' }, { flags: '--id <uuid>', description: 'topic은 발신 요청 ID, event는 이벤트 ID' }],
  examples: ['brain channels send-pending --topic garmin.report --id <uuid>'], output: '이번에 발신 접수한 요청 수',
  async run({ brain, options }) {
    const result = await brain.channels.sendPending({ topic: options['topic'] as string | undefined, event: options['event'] as string | undefined, id: options['id'] as string | undefined, date: options['date'] as string | undefined });
    return result.ok ? { ok: true, data: { count: result.count }, text: [`${result.count}건을 발신 대기열에 넣었습니다`] } : result;
  },
};
