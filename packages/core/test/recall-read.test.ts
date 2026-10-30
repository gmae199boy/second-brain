import { expect, it } from 'vitest';
import { readSessionPage } from '../src/sessions/read.js';
import { expandRecall } from '../src/recall/expand.js';
import { searchRecall } from '../src/recall/search.js';
import { maskOutputText, maskToolNoteTarget } from '../src/output/mask.js';
import type { SessionStore } from '../src/ports/store.js';
import type { RecallStore } from '../src/ports/recall-store.js';

it('동시각 메시지와 긴 메모를 가린 뒤 커서로 빠짐없이 읽는다', async () => {
  const at = new Date('2026-01-01T00:00:00Z');
  const target = 'NODE_ENV=production password=a ' + 'x '.repeat(8000);
  const message = { id: 'a', sessionId: 's', harnessMessageId: 'm', role: 'user' as const, model: null, body: '본문', occurredAt: at, gitBranch: null, isSubagentReport: false };
  const store = { readSession: async () => ({ ok: true as const, session: {} as never, messages: [message, { ...message, id: 'b', harnessMessageId: 'n' }], toolNotes: [{ id: 'note', sessionId: 's', harnessMessageId: 'm', ordinal: 0, tool: 'Bash', target, ok: true }, { id: 'orphan', sessionId: 's', harnessMessageId: 'missing', ordinal: 0, tool: 'Bash', target: '이름', ok: true }] }) } as unknown as SessionStore;
  let cursor: string | undefined; const rows: { id: string; body: string }[] = [];
  do { const page = await readSessionPage(store, { session: 'demo:id', limit: 1, ...(cursor ? { cursor } : {}) }); expect(page.ok).toBe(true); if (!page.ok) break; rows.push(...page.data); cursor = page.meta.next?.args.cursor as string | undefined; } while (cursor);
  expect(rows.filter(r => r.id === 'note').map(r => r.body).join('')).toBe(maskOutputText(maskToolNoteTarget(target)));
  expect(rows.map(r => r.id).filter((id,i,a) => a.indexOf(id) === i)).toEqual(['a', 'note', 'b', 'orphan']);
  const expanded = await expandRecall(store, { session: 'demo:id', ranges: [{ from_at: at.toISOString(), to_at: at.toISOString() }, { from_at: at.toISOString(), to_at: at.toISOString() }], before: 0, after: 0 });
  expect(expanded.ok && expanded.data.map(r => r.id)).toEqual(['a', 'b']);
});

it('검색 생략의 다음 읽기는 출처 시각을 사용하고 페이지 초과 여부와 독립적이다', async () => {
  const source = { kind: 'conversation' as const, session: 'demo:id', harness: 'demo', started_at: '2026-01-01T00:00:00.000Z', workspace_id: null, project_id: null, worktree_id: null, tag_source: null, from_at: '2026-01-02T00:00:00.000Z', to_at: '2026-01-02T00:00:00.000Z', chunk_id: 'id', body: '가'.repeat(9000) };
  const store: RecallStore = { searchRecall: async () => ({ ok: true, rows: [source] }) };
  const result = await searchRecall(store, 'chunks', { query: '가' });
  expect(result).toMatchObject({ ok: true, meta: { has_more: false, next: { ns: 'sessions', verb: 'read', args: { session: 'demo:id', from_at: source.from_at } } }, warnings: ['RESULT_TRUNCATED'] });
});

it('잘못된 시각과 범위를 실제 읽기 전에 거부한다', async () => {
  const store = { readSession: async () => { throw new Error('읽지 않아야 합니다'); } } as unknown as SessionStore;
  for (const from_at of ['2026-02-30T00:00:00Z', '2026-01-01', '잘못된 값']) {
    expect(await expandRecall(store, { session: 'demo:id', from_at, to_at: '2026-03-01T00:00:00Z' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
    expect(await readSessionPage(store, { session: 'demo:id', from_at })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  }
});

it('커서 발급 뒤 본문이 늘어나도 현재 행을 처음부터 읽고 다른 세션에서는 커서를 거부한다', async () => {
  const at = new Date('2026-01-01T00:00:00Z');
  let body = '가'.repeat(12000);
  const message = { id: 'a', sessionId: 's', harnessMessageId: 'm', role: 'user' as const, model: null, occurredAt: at, gitBranch: null, isSubagentReport: false };
  const store = { readSession: async () => ({ ok: true as const, session: {} as never, messages: [{ ...message, body }], toolNotes: [] }) } as unknown as SessionStore;
  const first = await readSessionPage(store, { session: 'demo:id' }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
  const cursor = first.meta.next.args.cursor as string;
  expect(await readSessionPage(store, { session: 'demo:other', cursor })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  body = '새 내용 ' + body;
  const changed = await readSessionPage(store, { session: 'demo:id', cursor });
  expect(changed.ok && changed.meta.hint).toContain('처음부터');
  expect(changed.ok && changed.data[0]?.body.startsWith('새 내용 ')).toBe(true);
});

it('반환하지 않는 여섯 번째의 가려질 토큰은 안전한 다섯 결과를 막지 않는다', async () => {
  const row = { kind: 'conversation' as const, session: 'demo:ok', harness: 'demo', started_at: '2026-01-01T00:00:00.000Z', workspace_id: null, project_id: null, worktree_id: null, tag_source: null, from_at: '2026-01-01T00:00:00.000Z', to_at: '2026-01-01T00:00:00.000Z', chunk_id: 'id', body: '검색' };
  const store: RecallStore = { searchRecall: async () => ({ ok: true, rows: [...Array.from({ length: 5 }, (_, i) => ({ ...row, chunk_id: String(i) })), { ...row, session: 'demo:token=a;' }] }) };
  const result = await searchRecall(store, 'chunks', { query: '검색' });
  expect(result).toMatchObject({ ok: true, meta: { count: 5, has_more: true } });
});
