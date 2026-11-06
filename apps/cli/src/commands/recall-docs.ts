import { documentSearchText } from 'second_brain';
import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const recallDocsCommand: CommandSpec = {
  ns: 'recall', verb: 'docs', nsDescription: '대화와 도구 사용을 검색합니다', usedFor: '확장이 등록한 리포트 문서를 검색합니다',
  required: ['query'], arguments: ['<query>'], examples: ['brain recall docs 검색어 --json'], output: '리포트 문서 출처와 본문 및 페이지 메타', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [{ flags: '--limit <n>', description: '최대 결과 수 (기본 5)' }],
  async run(context) {
    const result = await context.brain.recall.docs({ query: context.args[0] ?? '', ...(context.options.limit === undefined ? {} : { limit: Number(context.options.limit) }) });
    if (!result.ok) return result;
    return { ...result, text: recallText(documentSearchText(result.data), result.meta) };
  },
};
