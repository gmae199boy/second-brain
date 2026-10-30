import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const sessionsReadCommand: CommandSpec = {
  ns: 'sessions', verb: 'read', nsDescription: '세션을 읽고 수집합니다', usedFor: '세션의 메시지와 도구 메모를 페이지로 읽습니다', required: ['session'], arguments: ['<session>'], examples: ['brain sessions read claude:abc --json'], output: '메시지와 도구 메모 및 다음 페이지 메타', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [{ flags: '--limit <n>', description: '페이지 크기 (기본 50)' }, { flags: '--cursor <cursor>', description: '다음 페이지 커서' }, { flags: '--from-at <time>', description: '이 시각부터 읽습니다' }, { flags: '--note <id>', description: '이 도구 메모부터 읽습니다' }],
  async run(context) { const o = context.options; const result = await context.brain.sessions.read({ session: context.args[0] ?? '', ...(o.limit === undefined ? {} : { limit: Number(o.limit) }), ...(typeof o.cursor === 'string' ? { cursor: o.cursor } : {}), ...(typeof o.fromAt === 'string' ? { from_at: o.fromAt } : {}), ...(typeof o.note === 'string' ? { note: o.note } : {}) }); if (!result.ok) return result; return { ...result, text: recallText(result.data.length ? result.data.map(r => `종류 ${r.kind}, 시각 ${r.at ?? '없음'}: ${r.body}`) : [result.meta.hint ?? '세션에 메시지가 없습니다'], result.meta) }; },
};
