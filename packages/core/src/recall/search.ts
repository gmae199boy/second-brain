import { withExtensionMetadata } from './extension-metadata.js';
import type { ExtensionStore } from '../ports/store.js';
import type { RecallStore, RecallRow } from '../ports/recall-store.js';
import { literalLikePattern } from './text-query.js';
import { boundedResults } from './results.js';
import { maskOutputText, maskToolNoteTarget } from '../output/mask.js';

/** 텍스트에서도 원문 조회에 필요한 모든 출처를 보존한다. */
export function recallSearchText(rows: readonly RecallRow[]): string[] {
  if (rows.length === 0) return ['일치하는 결과가 없습니다'];
  return rows.flatMap(({ body, ...source }) => [`출처 ${JSON.stringify(source)}`, `본문 ${body}`]);
}

export interface SearchInput { sources?: string[]; query: string; limit?: number; worktree?: string; project?: string }
export async function searchRecall(store: RecallStore, kind: 'chunks' | 'tools', input: SearchInput, statusStore?: Pick<ExtensionStore, 'listExtensionInventory' | 'getExtensionPublicStatus'>) {
  // [ASSUMPTION] 검색은 기본 다섯 건이며 관련도는 대소문자를 무시한 리터럴 일치 횟수다.
  const limit = input.limit ?? 5;
  if (typeof input.query !== 'string' || !input.query || !Number.isInteger(limit) || limit < 1 || limit > 200) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '검색어와 1~200 사이의 개수가 필요합니다' };
  const found = await store.searchRecall({ kind, query: input.query.replaceAll('\0', '�'), pattern: literalLikePattern(input.query), limit: limit + 1, ...(input.worktree ? { worktree: input.worktree } : {}), ...(input.project ? { project: input.project } : {}) });
  if (!found.ok) return found;
  const selected = found.rows.slice(0, limit);
  if (selected.some(row => maskOutputText(row.session) !== row.session)) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '가려진 세션 출처로는 다음 읽기를 실행할 수 없습니다' };
  const rows = selected.map(row => kind === 'tools' ? { ...row, body: maskToolNoteTarget(row.body) } : row);
  const metadata = statusStore ? await withExtensionMetadata(statusStore, { ok:true as const }, input.sources) : undefined;
  if (metadata && !metadata.ok) return metadata;
  return boundedResults(rows, { get: (r: RecallRow) => r.body, set: (r, body) => ({ ...r, body }) }, budget => {
    const nextRow = budget.nextIndex === null ? undefined : rows[budget.nextIndex];
    return { warnings: budget.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { ...(metadata?.meta ?? {}), count: budget.data.length, has_more: found.rows.length > limit, ...(rows.length === 0 ? { hint: '일치하는 결과가 없습니다' } : {}), ...(budget.truncated && nextRow ? { omitted: { count: budget.omitted, reason: '결과 크기 한도' }, next: { ns: 'sessions', verb: 'read', args: { session: nextRow.session, ...(nextRow.from_at ? { from_at: nextRow.from_at } : { note: nextRow.tool_note_id }) } } } : {}) } };
  }, recallSearchText);
}
