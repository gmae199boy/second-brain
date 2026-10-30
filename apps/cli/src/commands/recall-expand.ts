import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const recallExpandCommand: CommandSpec = {
  ns: 'recall', verb: 'expand', nsDescription: '대화와 도구 사용을 검색합니다', usedFor: '검색 구간의 실제 메시지와 주변 문맥을 읽습니다', required: ['session'], arguments: ['<session>'], examples: ['brain recall expand claude:abc --from 2026-01-01T00:00:00Z --to 2026-01-01T01:00:00Z --json'], output: '시간순 메시지와 읽기 메타', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [{ flags: '--from <time>', description: '포함할 시작 시각' }, { flags: '--to <time>', description: '포함할 끝 시각' }, { flags: '--ranges <json>', description: '여러 from_at·to_at 구간의 JSON 배열' }, { flags: '--before <n>', description: '앞 문맥 수' }, { flags: '--after <n>', description: '뒤 문맥 수' }],
  async run(context) {
    const o = context.options;
    let ranges: { from_at: string; to_at: string }[] | undefined;
    if (typeof o.ranges === 'string') {
      try { ranges = JSON.parse(o.ranges) as typeof ranges; } catch { return { ok: false, code: 'INVALID_ARGUMENT', message: '구간 배열이 올바른 JSON이 아닙니다' }; }
    }
    const result = await context.brain.recall.expand({ session: context.args[0] ?? '', ...(ranges === undefined ? { from_at: String(o.from ?? ''), to_at: String(o.to ?? '') } : { ranges }), ...(o.before === undefined ? {} : { before: Number(o.before) }), ...(o.after === undefined ? {} : { after: Number(o.after) }) });
    if (!result.ok) return result;
    return { ...result, text: recallText(result.data.length ? result.data.map(r => `시각 ${r.occurred_at} ${r.role}: ${r.body}`) : [result.meta.hint ?? '해당 구간에 메시지가 없습니다'], result.meta) };
  },
};
