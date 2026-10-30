import { contentHash } from '../domain/sha256.js';
import { validRecallTime } from '../recall/time.js';
import type { SessionStore } from '../ports/store.js';
import { boundedResults } from '../recall/results.js';
import { maskOutputText, toolNoteForOutput } from '../output/mask.js';

type PageRow = { kind: 'message' | 'tool'; id: string; at: string | null; body: string; [key: string]: unknown };
export interface ReadInput { session: string; limit?: number; cursor?: string; from_at?: string; note?: string }
type Position = { key: string; offset: number; generation: string };
type High = { at: string; id: string };
type Cursor = Position & { session: string; high: High | null; orphan: Position | null; orphanHigh: string | null; ambiguityHigh: string | null; orphanGeneration: string; linkedResume: boolean };
function validPosition(value: unknown): value is Position {
  if (!value || typeof value !== 'object') return false;
  const v = value as Position;
  return typeof v.key === 'string' && v.key.length > 0 && typeof v.generation === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v.generation) && Number.isSafeInteger(v.offset) && v.offset >= 0;
}
function decode(value: string): Cursor | null {
  try {
    const result: unknown = JSON.parse(atob(value.replaceAll('-', '+').replaceAll('_', '/')));
    if (!validPosition(result)) return null;
    const v = result as Cursor;
    return typeof v.session === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v.session) && (v.high === null || (!!v.high && typeof v.high.id === 'string' && typeof v.high.at === 'string' && validRecallTime(v.high.at))) && (v.orphan === null || validPosition(v.orphan)) && (v.ambiguityHigh === null || (typeof v.ambiguityHigh === 'string' && v.ambiguityHigh.length > 0)) && typeof v.orphanGeneration === 'string' && /^sha256:[a-f0-9]{64}$/u.test(v.orphanGeneration) && typeof v.linkedResume === 'boolean' && (v.orphanHigh === null || (typeof v.orphanHigh === 'string' && v.orphanHigh.length > 0)) ? v : null;
  } catch { return null; }
}
function encode(value: Cursor): string { return btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', ''); }
export async function readSessionPage(store: SessionStore, input: ReadInput) {
  // [ASSUMPTION] 한 페이지는 기본 메시지 50건, 최대 200건이다.
  const limit = input.limit ?? 50;
  const cursor = input.cursor === undefined ? null : decode(input.cursor);
  if (!input.session || maskOutputText(input.session) !== input.session || (input.from_at !== undefined && !validRecallTime(input.from_at)) || (input.cursor !== undefined && (input.from_at !== undefined || input.note !== undefined)) || !Number.isInteger(limit) || limit < 1 || limit > 200 || (input.cursor !== undefined && (!cursor || cursor.session !== contentHash(input.session)))) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '세션, 페이지 크기 또는 커서가 올바르지 않습니다' };
  const read = await store.readSession(input.session);
  if (!read.ok) return read;
  const messages = [...read.messages].sort((a,b) => a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id));
  const rows: PageRow[] = [];
  for (const m of messages) {
    rows.push({ kind: 'message', id: m.id, at: m.occurredAt.toISOString(), role: m.role, body: maskOutputText(m.body) });
    for (const n of read.toolNotes.filter(n => n.harnessMessageId === m.harnessMessageId).sort((a,b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))) rows.push({ kind: 'tool', id: n.id, at: m.occurredAt.toISOString(), message_id: m.id, tool: n.tool, body: maskOutputText(toolNoteForOutput(n).target), ok: n.ok });
  }
  for (const n of read.toolNotes.filter(n => !messages.some(m => m.harnessMessageId === n.harnessMessageId)).sort((a,b) => a.id.localeCompare(b.id))) rows.push({ kind: 'tool', id: n.id, at: null, message_id: null, tool: n.tool, body: maskOutputText(toolNoteForOutput(n).target), ok: n.ok });
  const messageRows = rows.filter(row => row.at !== null);
  const orphanRows = rows.filter(row => row.at === null);
  const orphanGeneration = contentHash(JSON.stringify(orphanRows.map(row => row.id)));
  // [ASSUMPTION] 구성원이 바뀌면 순서를 추정하지 않고 현재 고아 목록을 다시 읽는다.
  const orphansChanged = cursor !== null && cursor.orphanGeneration !== orphanGeneration;
  let high: High | null = cursor?.high ?? null;
  const orphanHigh = orphansChanged ? null : cursor?.orphanHigh ?? null;
  const ambiguityHigh = cursor?.ambiguityHigh ?? null;
  const pendingConnected = cursor?.orphan ? messageRows.some(row => row.id === cursor.orphan!.key) : false;
  const pending = cursor?.orphan && (!orphansChanged || pendingConnected) ? cursor.orphan : null;
  let candidates: PageRow[];
  let target: Position | null = cursor;
  if (cursor?.orphan) {
    // 연결된 보류 메모는 부분 위치를 유지하고, 고아 구성원이 바뀌면 목록을 재탐색한다.
    const oldPending = cursor.orphan;
    const later = messageRows.filter(row => {
      if (pending && row.id === pending.key) return true;
      const owner = row.kind === 'message' ? row.id : String(row.message_id);
      return !high || row.at! > high.at || (row.at === high.at && (owner > high.id || (cursor.linkedResume && owner === high.id)));
    });
    const remainingOrphans = orphansChanged ? orphanRows : orphanRows.filter(row => (!orphanHigh || row.id > orphanHigh) && (pendingConnected || row.id >= oldPending.key));
    if (!orphansChanged && !later.some(row => row.id === oldPending.key) && !remainingOrphans.some(row => row.id === oldPending.key)) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '고아 메모 커서가 현재 세션에 없습니다' };
    const isPendingTarget = cursor.key === oldPending.key;
    const position = later.findIndex(row => row.id === cursor.key);
    if (!isPendingTarget && position < 0) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '메시지 커서가 현재 세션에 없습니다' };
    const messageStart = isPendingTarget && !cursor.linkedResume ? 0 : Math.max(0, position);
    candidates = [...later.slice(messageStart), ...remainingOrphans];
    if (isPendingTarget) target = pending && candidates[0]?.id === pending.key ? pending : null;
    else if (candidates[0]?.id !== cursor.key) target = null;
  } else {
    const start = cursor ? rows.findIndex(r => r.id === cursor.key) : input.note ? rows.findIndex(r => r.id === input.note) : input.from_at ? rows.findIndex(r => r.at !== null && Date.parse(r.at) >= Date.parse(input.from_at!)) : 0;
    if (start < 0 && !cursor && !input.note) return { ok: true as const, data: [], warnings: [], meta: { count: 0, has_more: false, hint: '해당 시각 이후 메시지가 없습니다' } };
    if (start < 0) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '커서가 현재 세션에 없습니다' };
    candidates = rows.slice(start).filter(row => row.at !== null || !orphanHigh || row.id > orphanHigh);
    if (!cursor && start > 0) {
      const first = rows[start];
      const owner = first?.kind === 'tool' && first.at !== null ? first.message_id : undefined;
      const prior = rows.slice(0, start).filter(row => row.kind === 'message' && row.id !== owner).at(-1);
      if (prior?.at) high = { id: prior.id, at: prior.at };
    }
  }
  // [ASSUMPTION] 새 메시지에 연결된 오래된 id의 메모는 이전 출력 여부가 모호해 재출력하고 안내한다.
  const ambiguous = new Set(candidates.filter(row => row.kind === 'tool' && row.at !== null && ambiguityHigh !== null && row.id <= ambiguityHigh).map(row => row.id));
  const page: PageRow[] = [];
  let messageCount = 0;
  for (const row of candidates) {
    if ((row.kind === 'message' || row.at === null) && messageCount >= limit) { page.push(row); break; }
    page.push(row);
    if (row.kind === 'message' || row.at === null) messageCount += 1;
  }
  const hasExtra = page.length > 0 && (page[page.length - 1]!.kind === 'message' || page[page.length - 1]!.at === null) && messageCount >= limit && page.filter(row => row.kind === 'message' || row.at === null).length > limit;
  const pageSize = page.length - (hasExtra ? 1 : 0);
  const fullBodies = page.map(row => row.body);
  const positions = [target, pending].filter((position, index, all): position is Position => position !== null && all.findIndex(other => other?.key === position.key) === index);
  const offsets = new Map<string, number>();
  const changedRows = new Set<string>();
  for (const position of positions) {
    const index = page.findIndex(row => row.id === position.key);
    if (index < 0) continue;
    const original = fullBodies[index]!;
    const changed = position.generation !== contentHash(original);
    if (!changed && position.offset > Array.from(original).length) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '커서 위치가 올바르지 않습니다' };
    if (changed) changedRows.add(position.key);
    const offset = changed ? 0 : position.offset;
    offsets.set(position.key, offset);
    if (offset) page[index] = { ...page[index]!, body: Array.from(original).slice(offset).join('') };
  }
  const currentOffset = page[0] ? offsets.get(page[0].id) ?? 0 : 0;
  const answer = boundedResults(page.slice(0, pageSize), { get: (r: PageRow) => r.body, set: (r, body) => ({ ...r, body }) }, budget => {
    const nextIndex = budget.nextIndex ?? (hasExtra ? pageSize : null);
    let next: string | undefined;
    if (nextIndex !== null && page[nextIndex]) {
      const offset = budget.truncated && nextIndex === 0 ? currentOffset + Array.from(budget.data[0]?.body ?? '').length : 0;
      const nextRow = page[nextIndex]!;
      const owner = (row: PageRow) => row.kind === 'message' ? row.id : row.at !== null ? String(row.message_id) : null;
      const consumed = page.slice(0, nextIndex);
      const lastOwner = [...consumed].reverse().map(owner).find(id => id !== null);
      let completed = high;
      const emittedPendingOwner = pending?.key === nextRow.id && nextRow.at !== null && consumed.some(row => row.kind === 'message' && row.id === owner(nextRow));
      if (lastOwner && (owner(nextRow) !== lastOwner || emittedPendingOwner)) {
        const message = messages.find(m => m.id === lastOwner);
        if (message) completed = { id: message.id, at: message.occurredAt.toISOString() };
      }
      let completedOrphan = orphanHigh;
      // 연결된 보류 메모는 현재 고아 스캔 경계가 아니다.
      for (const row of consumed) if (row.at === null && (!completedOrphan || row.id > completedOrphan)) completedOrphan = row.id;
      let completedAmbiguity = ambiguityHigh;
      for (const row of consumed) if ((row.at === null || row.id === pending?.key) && (!completedAmbiguity || row.id > completedAmbiguity)) completedAmbiguity = row.id;
      const pendingConsumed = pending && consumed.some(row => row.id === pending.key);
      const retained = pendingConsumed ? null : pending;
      const position: Position = nextIndex > 0 && retained?.key === nextRow.id
        ? retained : { key: nextRow.id, offset, generation: contentHash(fullBodies[nextIndex]!) };
      const remaining = candidates.slice(nextIndex).find(row => row.at === null && (!completedOrphan || row.id > completedOrphan));
      const orphan = nextRow.at === null || retained?.key === nextRow.id ? position : retained ?? (remaining ? { key: remaining.id, offset: 0, generation: contentHash(remaining.body) } : null);
      next = encode({ ...position, session: contentHash(input.session), high: completed, orphan, orphanHigh: completedOrphan, ambiguityHigh: completedAmbiguity, orphanGeneration, linkedResume: nextRow.at !== null && completed !== null && owner(nextRow) === completed.id });
    }
    return { warnings: budget.truncated ? ['RESULT_TRUNCATED' as const] : [], meta: { count: budget.data.length, has_more: next !== undefined, ...(budget.truncated ? { omitted: { count: budget.omitted, reason: '결과 크기 한도' } } : {}), ...(next ? { next: { ns: 'sessions', verb: 'read', args: { session: input.session, cursor: next, limit } } } : {}), ...((orphansChanged || budget.data.some(row => changedRows.has(row.id)) || budget.data.some(row => ambiguous.has(row.id))) ? { hint: [orphansChanged ? '고아 메모 구성이 바뀌어 현재 목록을 처음부터 다시 읽습니다' : '', budget.data.some(row => changedRows.has(row.id)) ? '본문이 바뀌어 현재 행의 처음부터 다시 읽었습니다' : '', budget.data.some(row => ambiguous.has(row.id)) ? '연결된 메모의 이전 출력 여부가 모호해 다시 표시할 수 있습니다' : ''].filter(Boolean).join(' ') } : rows.length === 0 ? { hint: '세션에 메시지가 없습니다' } : {}) } };
  }, data => data.length ? data.map(r => `종류 ${r.kind}, 시각 ${r.at ?? '없음'}: ${r.body}`) : ['세션에 메시지가 없습니다']);
  if (answer.ok && answer.warnings.length && answer.data[0]?.id === page[0]?.id && answer.data[0]?.body === '' && (fullBodies[0] ?? '').length > currentOffset) return { ok: false as const, code: 'INVALID_ARGUMENT', message: '본문을 진행할 수 없는 결과 크기입니다' };
  return answer;
}
