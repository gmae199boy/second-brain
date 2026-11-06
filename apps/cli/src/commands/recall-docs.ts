import { documentSearchText } from 'second_brain';
import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const recallDocsCommand: CommandSpec = {
  ns: 'recall', verb: 'docs', nsDescription: '대화와 도구 사용을 검색합니다', usedFor: '리포트와 외부 source 문서 본문·이름을 검색합니다',
  required: ['query'], arguments: ['<query>'], examples: ['brain recall docs 검색어 --source garmin --json'], output: '문서 출처와 본문 또는 이름·접근 상태', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [{ flags: '--source <names>', description: '확장 source 목록 (쉼표 구분)' }, { flags: '--limit <n>', description: '최대 결과 수 (기본 5)' }],
  async run(context) {
    const result = await context.brain.recall.docs({ query: context.args[0] ?? '', ...(typeof context.options.source === 'string' ? { sources: context.options.source.split(',').map(s => s.trim()).filter(Boolean) } : {}), ...(context.options.limit === undefined ? {} : { limit: Number(context.options.limit) }) });
    if (!result.ok) return result;
    return { ...result, text: recallText(documentSearchText(result.data), result.meta) };
  },
};
