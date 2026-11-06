import { withExtensionMetadata } from './extension-metadata.js';
import type { ExtensionStore } from '../ports/store.js';
import { contentHash } from '../domain/sha256.js';
import { decodeChunkLocator, type ChunkLocator } from '../domain/chunk-locator.js';
import { maskOutputText } from '../output/mask.js';
import type { DocumentRecallStore, DocumentRow } from '../ports/document-recall-store.js';
import { documentContext } from './document-context.js';
import { literalLikePattern } from './text-query.js';
import { boundedResults } from './results.js';

export interface DocumentSearchInput { sources?: string[]; query: string; limit?: number }
export interface ShowDocumentInput { file_id: string; chunk_locator: string; extraction_id?: string; before?: number; after?: number; offset?: number; fingerprint?: string }
export function documentSearchText(rows: readonly DocumentRow[]): string[] {
  return rows.length ? rows.flatMap(({ body, ...source }) => [`출처 ${JSON.stringify(source)}`, `본문 ${body}`]) : ['일치하는 결과가 없습니다'];
}
const corrupt = () => ({ ok: false as const, code: 'SEARCH_FAILED' as const, message: '저장된 문서 문맥을 읽을 수 없습니다' });
const invalid = (message: string) => ({ ok: false as const, code: 'INVALID_ARGUMENT' as const, message });
const safe = (value: string) => maskOutputText(value) === value && !value.includes('\0');
export async function searchDocuments(store: DocumentRecallStore, input: DocumentSearchInput, statusStore?: Pick<ExtensionStore, 'listExtensionInventory' | 'getExtensionPublicStatus'>) {
  const limit = input.limit ?? 5;
  if (typeof input.query !== 'string' || !input.query || !Number.isInteger(limit) || limit < 1 || limit > 200) return invalid('검색어와 1~200 사이의 개수가 필요합니다');
  const found = await store.searchDocuments({ query: input.query.replaceAll('\0', '�'), pattern: literalLikePattern(input.query), limit: limit + 1 });
  if (!found.ok) return { ...found, message: maskOutputText(found.message) };
  const rows: DocumentRow[] = [];
  const contexts = new Map<string, ReturnType<typeof documentContext>>();
  for (const context of found.contexts) {
    if (contexts.has(context.extraction_id)) return corrupt();
    contexts.set(context.extraction_id, documentContext(context.pieces));
  }
  for (const { ordinal, ...row } of found.rows.slice(0, limit)) {
    const whole = contexts.get(row.extraction_id);
    const position = whole?.positioned.find(p => p.piece.ordinal === ordinal);
    if (!whole || !position || position.piece.chunk_locator !== row.chunk_locator) return corrupt();
    rows.push({ ...row, body: whole.project(position.start, position.end) });
  }
  if (rows.some(r => !safe(r.file_id) || !safe(r.chunk_locator) || !safe(r.extraction_id) || !decodeChunkLocator(r.chunk_locator).ok)) return invalid('가려지거나 잘못된 문서 출처는 사용할 수 없습니다');
  const metadata = statusStore ? await withExtensionMetadata(statusStore, { ok:true as const }, [...(input.sources ?? []), ...rows.map(row => row.source)]) : undefined;
  if (metadata && !metadata.ok) return metadata;
  return boundedResults(rows, { get: r => r.body, set: (r, body) => ({ ...r, body }) }, budget => {
    const next = budget.nextIndex === null ? undefined : rows[budget.nextIndex];
    return { warnings: budget.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { ...(metadata?.meta ?? {}), count: budget.data.length, has_more: found.rows.length > limit,
      ...(rows.length ? {} : { hint: '일치하는 결과가 없습니다' }),
      ...(next ? { omitted: { count: budget.omitted, reason: '결과 크기 한도' }, next: { ns: 'files', verb: 'show', args: { file_id: next.file_id, chunk_locator: next.chunk_locator, extraction_id: next.extraction_id } } } : {}) } };
  }, documentSearchText);
}
function overlaps(a: ChunkLocator, b: ChunkLocator): boolean {
  if (a.type === 'text' && b.type === 'text') return a.start < b.end && b.start < a.end;
  if (a.type === 'pdf' && b.type === 'pdf') return a.page === b.page && (!a.bbox || !b.bbox || (a.bbox[0] <= b.bbox[2] && b.bbox[0] <= a.bbox[2] && a.bbox[1] <= b.bbox[3] && b.bbox[1] <= a.bbox[3]));
  return a.type === 'docx' && b.type === 'docx' && a.block === b.block;
}
export async function showDocument(store: DocumentRecallStore, input: ShowDocumentInput) {
  const before = input.before ?? 2, after = input.after ?? 2, offset = input.offset ?? 0;
  if (typeof input.file_id !== 'string' || !input.file_id || !safe(input.file_id) || typeof input.chunk_locator !== 'string' || !safe(input.chunk_locator) || (input.extraction_id !== undefined && (typeof input.extraction_id !== 'string' || !safe(input.extraction_id))) || ![before, after].every(n => Number.isInteger(n) && n >= 0 && n <= 100) || !Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && (!input.extraction_id || typeof input.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.fingerprint)))) return invalid('파일 출처 또는 문맥 개수가 올바르지 않습니다');
  const locator = decodeChunkLocator(input.chunk_locator); if (!locator.ok) return invalid('조각 위치가 올바르지 않습니다');
  const read = await store.readDocument(input.file_id); if (!read.ok) return { ...read, message: maskOutputText(read.message) };
  const s = read.snapshot;
  if (!s) return { ...invalid('파일이 없습니다'), status: 'not_found' as const };
  if (s.redacted) return { ...invalid('가린 파일입니다'), status: 'redacted' as const };
  if (!s.extraction_id) return { ...invalid('읽을 수 있는 추출 세대가 없습니다'), status: s.status ?? 'pending', source_unreachable: s.source_unreachable };
  if (!safe(s.extraction_id)) return invalid('가려진 추출 세대는 사용할 수 없습니다');
  const context = documentContext(s.pieces);
  if (!context) return corrupt();
  const pieces = context.positioned;
  const matching = pieces.flatMap((p,i) => overlaps(locator.locator, p.locator) ? [i] : []);
  if (!matching.length) return { ...invalid('현재 세대에 해당 위치가 없습니다'), status: 'location_not_found' as const };
  const first = Math.max(0, matching[0]! - before);
  const window = pieces.slice(first, Math.min(pieces.length, matching[matching.length - 1]! + after + 1));
  let covered: number | null = null;
  const emitted = new Set<number>();
  let previousGroup: number | undefined;
  const rows = window.map((p,i) => {
    let trim = 0;
    if (p.locator.type === 'text') {
      if (previousGroup !== p.group) covered = null;
      previousGroup = p.group;
      if (i > 0 && window[i-1]!.locator.type === 'text' && covered !== null) trim = Math.min(p.end-p.start, Math.max(0, covered - p.locator.start));
      covered = Math.max(covered ?? p.locator.start, p.locator.end);
    } else { covered = null; previousGroup = undefined; }
    return { chunk_locator: p.piece.chunk_locator, body: context.project(p.start + trim, p.end, emitted) };
  }).filter(p => p.body !== '');
  if (rows.some(r => !safe(r.chunk_locator))) return invalid('가려진 조각 위치를 반환할 수 없습니다');
  const fingerprint = contentHash(JSON.stringify([input.file_id, input.chunk_locator, before, after, context.text]));
  const restarted = offset > 0 && (input.extraction_id !== s.extraction_id || input.fingerprint !== fingerprint);
  const start = restarted ? 0 : offset;
  const total = rows.reduce((n,r) => n + Array.from(r.body).length, 0);
  if (start > total) return invalid('이어 읽을 위치가 범위를 벗어났습니다');
  let skipped = start;
  const remainder = rows.flatMap(row => {
    const chars = Array.from(row.body);
    if (skipped >= chars.length) { skipped -= chars.length; return []; }
    const body = chars.slice(skipped).join(''); skipped = 0; return [{ ...row, body }];
  });
  const changed = input.extraction_id !== undefined && input.extraction_id !== s.extraction_id;
  const result = boundedResults(remainder, { get: r => r.body, set: (r, body) => ({ ...r, body }) }, budget => ({ warnings: budget.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { count: budget.data.length, has_more: budget.truncated, extraction_id: s.extraction_id, generation_changed: changed, source_unreachable: s.source_unreachable, ...(restarted ? { hint: '추출 세대 또는 본문이 바뀌어 현재 위치에서 다시 시작했습니다' } : {}),
    ...(budget.truncated ? { omitted: { count: budget.omitted, reason: '결과 크기 한도' }, next: { ns: 'files', verb: 'show', args: { file_id: input.file_id, chunk_locator: input.chunk_locator, extraction_id: s.extraction_id, before, after, offset: start + budget.data.reduce((n,r) => n + Array.from(r.body).length, 0), fingerprint } } } : {}) } }), data => [...(changed ? ['추출 세대가 바뀌었습니다.'] : []), ...(s.source_unreachable ? ['원본에 접근할 수 없습니다.'] : []), ...data.map(r => `위치 ${r.chunk_locator}\n본문 ${r.body}`)]);
  if (result.ok && result.meta.next && result.meta.next.args.offset === start) return invalid('출처가 너무 커 이어 읽을 수 없습니다');
  return result;
}
