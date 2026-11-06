import { recallSearchText } from 'second_brain';
import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const recallChunksCommand: CommandSpec = {
  ns: 'recall', verb: 'chunks', nsDescription: '대화와 도구 사용을 검색합니다', usedFor: '대화 조각을 검색합니다',
  required: ['query'], arguments: ['<query>'], examples: ['brain recall chunks 검색어 --json'], output: '출처와 본문이 담긴 결과 목록과 페이지 메타', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [{ flags: '--source <names>', description: '확장 source 목록 (쉼표 구분)' }, { flags: '--limit <n>', description: '최대 결과 수 (기본 5)' }, { flags: '--worktree <id>', description: '가까운 작업 트리 식별자' }, { flags: '--project <id>', description: '가까운 프로젝트 식별자' }],
  async run(context) {
    const o = context.options;
    const result = await context.brain.recall.chunks({ query: context.args[0] ?? '', ...(typeof context.options.source === 'string' ? { sources: context.options.source.split(',').map(s => s.trim()).filter(Boolean) } : {}), ...(o.limit === undefined ? {} : { limit: Number(o.limit) }), ...(typeof o.worktree === 'string' ? { worktree: o.worktree } : {}), ...(typeof o.project === 'string' ? { project: o.project } : {}) });
    if (!result.ok) return result;
    return { ...result, text: recallText(recallSearchText(result.data), result.meta) };
  },
};
