import { recallSearchText } from 'second_brain';
import { recallText } from './recall-text.js';
import type { CommandSpec } from '../dispatch.js';
export const recallToolsCommand: CommandSpec = {
  ns: 'recall', verb: 'tools', nsDescription: '대화와 도구 사용을 검색합니다', usedFor: '도구 메모를 검색합니다', required: ['query'], arguments: ['<query>'], examples: ['brain recall tools 검색어 --json'], output: '출처와 도구 메모 목록 및 페이지 메타', risk: 'read', hook: false, dryRun: false, drain: false,
  options: [{ flags: '--limit <n>', description: '최대 결과 수 (기본 5)' }, { flags: '--worktree <id>', description: '가까운 작업 트리 식별자' }, { flags: '--project <id>', description: '가까운 프로젝트 식별자' }],
  async run(context) {
    const o = context.options;
    const result = await context.brain.recall.tools({ query: context.args[0] ?? '', ...(o.limit === undefined ? {} : { limit: Number(o.limit) }), ...(typeof o.worktree === 'string' ? { worktree: o.worktree } : {}), ...(typeof o.project === 'string' ? { project: o.project } : {}) });
    if (!result.ok) return result;
    return { ...result, text: recallText(recallSearchText(result.data), result.meta) };
  },
};
