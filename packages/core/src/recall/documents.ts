import { decodeUtf8Text } from '../files/text-extractor.js';
import { withExtensionMetadata } from './extension-metadata.js';
import type { ExtensionStore } from '../ports/store.js';
import { contentHash } from '../domain/sha256.js';
import { decodeChunkLocator, type ChunkLocator } from '../domain/chunk-locator.js';
import { maskOutputText, maskOutputValue } from '../output/mask.js';
import type { DocumentRecallStore, DocumentRow } from '../ports/document-recall-store.js';
import { documentContext } from './document-context.js';
import { literalLikePattern } from './text-query.js';
import { boundedResults } from './results.js';

export interface DocumentSearchInput { sources?: string[]; query: string; limit?: number }
export interface ShowDocumentInput { file_id?: string | null; source_file_id?: string; chunk_locator?: string | null; extraction_id?: string | null; before?: number; after?: number; offset?: number; fingerprint?: string }
export function driveSourceUrl(remoteId:string):string|null { return /^[A-Za-z0-9_-]+$/.test(remoteId) && safe(remoteId) ? `https://drive.google.com/file/d/${remoteId}/view` : null; }
export function documentSearchText(rows: readonly DocumentRow[]): string[] {
  return rows.length ? rows.flatMap(({ body, ...source }) => [`출처 ${JSON.stringify(source)}`, ...(source.source_unreachable?['원본에 접근할 수 없습니다.']:[]), ...(source.stale?['보존된 본문은 현재 원격 버전보다 오래되었습니다.']:[]), ...(body?[`본문 ${body}`]:[])]) : ['일치하는 결과가 없습니다'];
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
  for (const { ordinal, source_remote_id, ...row } of found.rows.slice(0, limit)) {
    const url=source_remote_id===undefined?undefined:driveSourceUrl(source_remote_id);
    if(source_remote_id!==undefined && (!url || !row.source_file_id || !safe(row.source_file_id)))continue;
    if(row.extraction_id===null || row.chunk_locator===null || ordinal===null){
      if(row.extraction_id!==null||row.chunk_locator!==null||ordinal!==null||!row.source_file_id) return corrupt();
      rows.push({...row,...(url?{source_url:url}:{}),...(row.source_unreachable?{warning:'FILE_SOURCE_UNREACHABLE' as const}:{})});continue;
    }
    const whole=contexts.get(row.extraction_id),position=whole?.positioned.find(p=>p.piece.ordinal===ordinal);
    if(!whole||!position||position.piece.chunk_locator!==row.chunk_locator)return corrupt();
    rows.push({...row,...(url?{source_url:url}:{}),...(row.source_file_id&&row.source_unreachable?{warning:'FILE_SOURCE_UNREACHABLE' as const}:{}),body:whole.project(position.start,position.end)});
  }
  if(rows.some(r => (r.file_id!==null&&!safe(r.file_id)) || (r.chunk_locator!==null&&(!safe(r.chunk_locator)||!decodeChunkLocator(r.chunk_locator).ok)) || (r.extraction_id!==null&&!safe(r.extraction_id)))) return invalid('가려지거나 잘못된 문서 출처는 사용할 수 없습니다');
  const metadata = statusStore ? await withExtensionMetadata(statusStore, { ok:true as const }, [...(input.sources ?? []), ...rows.filter(row => !row.source_file_id).map(row => row.source)]) : undefined;
  if (metadata && !metadata.ok) return metadata;
  return boundedResults(rows, { get: r => r.body, set: (r, body) => ({ ...r, body }) }, budget => {
    const next = budget.nextIndex === null ? undefined : rows[budget.nextIndex];
    return { warnings: budget.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { ...(metadata?.meta ?? {}), count: budget.data.length, has_more: found.rows.length > limit,
      ...(rows.length ? {} : { hint: '일치하는 결과가 없습니다' }),
      ...(next ? { omitted: { count: budget.omitted, reason: '결과 크기 한도' }, next: { ns: 'files', verb: 'show', args: { ...(next.file_id&&next.chunk_locator?{file_id:next.file_id}:{}), ...(next.source_file_id?{source_file_id:next.source_file_id}:{}), ...(next.chunk_locator?{chunk_locator:next.chunk_locator}:{}), ...(next.extraction_id?{extraction_id:next.extraction_id}:{}) } } } : {}) } };
  }, documentSearchText);
}
function overlaps(a: ChunkLocator, b: ChunkLocator): boolean {
  if (a.type === 'text' && b.type === 'text') return a.start < b.end && b.start < a.end;
  if (a.type === 'pdf' && b.type === 'pdf') return a.page === b.page && (!a.bbox || !b.bbox || (a.bbox[0] <= b.bbox[2] && b.bbox[0] <= a.bbox[2] && a.bbox[1] <= b.bbox[3] && b.bbox[1] <= a.bbox[3]));
  return a.type === 'docx' && b.type === 'docx' && a.block === b.block;
}
export type DocumentOriginalReader = (fileId:string, extractionId:string) => Promise<{ok:true; bytes:Uint8Array|null} | {ok:false; code:'FILES_UNAVAILABLE'|'DB_UNAVAILABLE'|'DB_LOCKED'; message:string}>;
export async function showDocument(store: DocumentRecallStore, input: ShowDocumentInput, original?:DocumentOriginalReader) {
  if(input.source_file_id!==undefined){
    if(typeof input.source_file_id!=='string'||!input.source_file_id||!safe(input.source_file_id)||!store.readSourceDocument)return invalid('source 출처가 올바르지 않습니다');
    const found=await store.readSourceDocument(input.source_file_id);if(!found.ok)return {...found,message:maskOutputText(found.message)};
    const source=found.source;if(!source)return {...invalid('source 파일이 없습니다'),status:'not_found' as const};
    const url=driveSourceUrl(source.source_remote_id);if(!url||!safe(source.source_file_id)||(source.file_id!==null&&!safe(source.file_id)))return invalid('가려진 출처는 사용할 수 없습니다');
    if(input.file_id && input.file_id!==source.file_id)return invalid('파일과 source 출처가 다릅니다');
    const {source_remote_id:_remote,...rawSource}=source;
    const publicSource=maskOutputValue({...rawSource,...(rawSource.source_unreachable?{warning:'FILE_SOURCE_UNREACHABLE' as const}:{})});
    if(Array.from(JSON.stringify(publicSource)).length>6000)return invalid('source 출처가 너무 큽니다');
    if(input.chunk_locator==null){
      if(input.file_id!=null||input.extraction_id!=null||input.offset!==undefined||input.fingerprint!==undefined)return invalid('이름 출처의 문맥 입력이 올바르지 않습니다');
      return {ok:true as const,data:[] as {chunk_locator:string;body:string}[],warnings:[] as ('RESULT_TRUNCATED')[],meta:{count:0,has_more:false,generation_changed:false,source_unreachable:source.source_unreachable,next:undefined,extraction_id:null,source_file:{...publicSource,source_url:url}}};
    }
    if(!source.file_id)return invalid('본문이 없는 source입니다');
    return showFileDocument(store,{...input,file_id:source.file_id,chunk_locator:input.chunk_locator},undefined,{...publicSource,source_url:url});
  }
  if(typeof input.file_id!=='string'||typeof input.chunk_locator!=='string')return invalid('파일과 조각 위치가 필요합니다');
  return showFileDocument(store,{...input,file_id:input.file_id,chunk_locator:input.chunk_locator},original);
}
async function showFileDocument(store: DocumentRecallStore, input: ShowDocumentInput & {file_id:string;chunk_locator:string}, original?:DocumentOriginalReader, sourceFile?:Omit<import('../ports/document-recall-store.js').SourceDocument,'source_remote_id'> & {source_url:string}) {
  const before = input.before ?? 2, after = input.after ?? 2, offset = input.offset ?? 0;
  if (typeof input.file_id !== 'string' || !input.file_id || !safe(input.file_id) || typeof input.chunk_locator !== 'string' || !safe(input.chunk_locator) || (input.extraction_id != null && (typeof input.extraction_id !== 'string' || !safe(input.extraction_id))) || ![before, after].every(n => Number.isInteger(n) && n >= 0 && n <= 100) || !Number.isSafeInteger(offset) || offset < 0 || (offset > 0 && (!input.extraction_id || typeof input.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(input.fingerprint)))) return invalid('파일 출처 또는 문맥 개수가 올바르지 않습니다');
  const locator = decodeChunkLocator(input.chunk_locator); if (!locator.ok) return invalid('조각 위치가 올바르지 않습니다');
  const read = await store.readDocument(input.file_id); if (!read.ok) return { ...read, message: maskOutputText(read.message) };
  const s = read.snapshot;
  if (!s) return { ...invalid('파일이 없습니다'), status: 'not_found' as const };
  if (s.redacted) return { ...invalid('가린 파일입니다'), status: 'redacted' as const };
  if (!s.extraction_id) return { ...invalid('읽을 수 있는 추출 세대가 없습니다'), status: s.status ?? 'pending', source_unreachable: s.source_unreachable };
  if (!safe(s.extraction_id)) return invalid('가려진 추출 세대는 사용할 수 없습니다');
  let sourcePieces = s.pieces;
  if (original) {
    const readOriginal = await original(input.file_id, s.extraction_id);
    if (!readOriginal.ok) return {...readOriginal, message:maskOutputText(readOriginal.message)};
    if (readOriginal.bytes !== null && s.pieces.every(piece => { const loc=decodeChunkLocator(piece.chunk_locator); return loc.ok && loc.locator.type === 'text'; })) {
      const decoded = decodeUtf8Text(readOriginal.bytes); if (!decoded.ok) return corrupt();
      const chars=Array.from(decoded.text);
      sourcePieces = [];
      for (const piece of s.pieces) {
        const loc=decodeChunkLocator(piece.chunk_locator);
        if (!loc.ok || loc.locator.type !== 'text' || loc.locator.end > chars.length) return corrupt();
        sourcePieces.push({...piece,body:chars.slice(loc.locator.start,loc.locator.end).join('')});
      }
    }
  }
  const context = documentContext(sourcePieces);
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
  const changed = input.extraction_id != null && input.extraction_id !== s.extraction_id;
  const result = boundedResults(remainder, { get: r => r.body, set: (r, body) => ({ ...r, body }) }, budget => ({ warnings: budget.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { count: budget.data.length, has_more: budget.truncated, extraction_id: s.extraction_id, generation_changed: changed, source_unreachable: sourceFile?.source_unreachable ?? s.source_unreachable, ...(sourceFile ? {source_file:sourceFile} : {}), ...(restarted ? { hint: '추출 세대 또는 본문이 바뀌어 현재 위치에서 다시 시작했습니다' } : {}),
    ...(budget.truncated ? { omitted: { count: budget.omitted, reason: '결과 크기 한도' }, next: { ns: 'files', verb: 'show', args: { file_id: input.file_id, ...(sourceFile ? {source_file_id:sourceFile.source_file_id} : {}), chunk_locator: input.chunk_locator, extraction_id: s.extraction_id, before, after, offset: start + budget.data.reduce((n,r) => n + Array.from(r.body).length, 0), fingerprint } } } : {}) } }), data => [...(changed ? ['추출 세대가 바뀌었습니다.'] : []), ...((sourceFile?.source_unreachable ?? s.source_unreachable) ? ['원본에 접근할 수 없습니다.'] : []), ...(sourceFile ? [`출처 ${JSON.stringify(sourceFile)}`] : []), ...(sourceFile?.stale ? ['보존된 본문은 현재 원격 버전보다 오래되었습니다.'] : []), ...data.map(r => `위치 ${r.chunk_locator}\n본문 ${r.body}`)]);
  if (result.ok && result.meta.next && result.meta.next.args.offset === start) return invalid('출처가 너무 커 이어 읽을 수 없습니다');
  return result;
}
