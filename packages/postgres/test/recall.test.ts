import { describe, expect, it } from 'vitest';
import { literalLikePattern, searchRecall, readSessionPage, expandRecall } from '@second-brain/core';
import { conversationFixture } from './conversation-fixture.js';

describe('대화 검색과 읽기', () => {
  it('실제 조각과 도구 출처를 검색하고 원문을 펼친다', async () => {
    const fixture = await conversationFixture('안녕하세요 검색 단어 %_\\\0');
    try {
      await fixture.drain();
      const result = await searchRecall(fixture.store, 'chunks', { query: '검색' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toHaveLength(1);
      const row = result.data[0]!;
      expect(row.chunk_id).toBeTruthy();
      const tools = await searchRecall(fixture.store, 'tools', { query: '도구' });
      expect(tools.ok && tools.data[0]?.tool_note_id).toBeTruthy();
      const expanded = await expandRecall(fixture.store, { session: row.session, ranges: [{ from_at: row.from_at!, to_at: row.to_at! }] });
      expect(expanded.ok && expanded.data.map(r => r.body)).toEqual(['안녕하세요 검색 단어 %_\\\0']);
      const read = await readSessionPage(fixture.store, { session: row.session });
      expect(read.ok && read.data.map(r => r.kind)).toEqual(['message', 'tool']);
      const special = await searchRecall(fixture.store, 'chunks', { query: '%_\\\0' });
      expect(special.ok && special.data).toHaveLength(1);
      const literal = await fixture.store.searchRecall({ kind: 'chunks', query: '없는%', pattern: literalLikePattern('없는%'), limit: 6 });
      expect(literal.ok && literal.rows).toEqual([]);
    } finally { await fixture.close(); }
  });
});

it.each(['chunks', 'tools'] as const)('%s 잠금 초과는 검색 실패로 반환한다', async kind => {
  const pg = await import('pg');
  const { postgresStore } = await import('../src/index.js');
  const f = await conversationFixture('검색');
  const holder = new pg.default.Client({ connectionString: f.db.url });
  const reader = postgresStore({ databaseUrl: f.db.appUrl, applicationName: `recall-lock-${kind}`, lockTimeoutMs: 100, queryTimeoutMs: 2000 });
  let pending: ReturnType<typeof reader.searchRecall> | undefined;
  try {
    await holder.connect(); await holder.query('begin');
    await holder.query(`lock table brain.${kind === 'chunks' ? 'chunks' : 'tool_notes'} in access exclusive mode`);
    pending = reader.searchRecall({ kind, query: '검색', pattern: literalLikePattern('검색'), limit: 6 });
    await expect.poll(async () => (await f.db.rows<{ n: number }>(`select count(*)::int n from pg_stat_activity where application_name='recall-lock-${kind}' and wait_event_type='Lock'`))[0]!.n, { timeout: 1000, interval: 5 }).toBe(1);
    expect(await pending).toMatchObject({ ok: false, code: 'SEARCH_FAILED' });
  } finally { await holder.query('rollback').catch(() => {}); if (pending) await pending; await holder.end(); await reader.close(); await f.close(); }
}, 30000);

it('작업 트리·프로젝트·전체 순서 다음 일치 횟수와 시각으로 정렬한다', async () => {
  const { sampleEnsureSessionInput, sampleCheckoutInput } = await import('@second-brain/core/testing');
  const { CONVERSATION_CHUNK_INDEX_CONFIG_ID } = await import('@second-brain/core');
  const pg = await import('pg'); const f = await conversationFixture('기존');
  const client = new pg.default.Client({ connectionString: f.db.url });
  try {
    await client.connect();
    const project = f.ids.next(), worktree = f.ids.next(), sibling = f.ids.next();
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const sessionId = f.ids.next(); const chunkId = f.ids.next(); ids.push(chunkId);
      const checkout = i < 4 ? sampleCheckoutInput({ projectId: project, worktreeId: i < 2 ? worktree : sibling, worktreePath: i < 2 ? '/fixture/a' : '/fixture/b' }) : null;
      const created = await f.store.ensureSession(sampleEnsureSessionInput({ id: sessionId, key: { harness: 'demo', harnessSessionId: `sort-${i}` }, checkout })); expect(created.ok).toBe(true);
      const body = i % 2 === 0 ? '검색 검색' : '검색';
      await client.query('insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) values($1,$2,$3,$4,$4,0,$5)', [chunkId, sessionId, CONVERSATION_CHUNK_INDEX_CONFIG_ID, new Date(Date.UTC(2026, 0, i + 1)).toISOString(), body]);
    }
    const result = await searchRecall(f.store, 'chunks', { query: '검색', worktree, project });
    expect(result.ok).toBe(true); if (!result.ok) return;
    expect(result.meta).toMatchObject({ count: 5, has_more: true });
    expect(result.data.map(row => row.chunk_id)).toEqual([ids[0], ids[1], ids[2], ids[3], ids[4]]);
    expect(result.data.every(row => row.kind === 'conversation' && row.session.startsWith('demo:') && row.started_at && row.from_at && row.to_at)).toBe(true);
  } finally { await client.end(); await f.close(); }
});

it('겹친 구간과 동시각 메시지는 재조각 뒤에도 같은 순서로 펼친다', async () => {
  const f = await conversationFixture('검색 첫 메시지');
  try {
    const batch = structuredClone(f.batch); batch.toolNotes = []; batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'same-time'; batch.messages[0]!.body = '동시각';
    expect((await f.store.ingest(batch)).ok).toBe(true); await f.drain();
    const found = await searchRecall(f.store, 'chunks', { query: '검색' }); if (!found.ok || !found.data[0]) throw new Error('검색 결과가 없습니다');
    const row = found.data[0]; const range = { from_at: row.from_at!, to_at: row.to_at! };
    const before = await expandRecall(f.store, { session: row.session, ranges: [range, range], before: 0, after: 0 });
    const appended = structuredClone(batch); appended.messages[0]!.id = f.ids.next(); appended.messages[0]!.harnessMessageId = 'later'; appended.messages[0]!.occurredAt = new Date(batch.messages[0]!.occurredAt.getTime() + 1000); appended.messages[0]!.body = '나중';
    expect((await f.store.ingest(appended)).ok).toBe(true); await f.drain();
    const after = await expandRecall(f.store, { session: row.session, ranges: [range, range], before: 0, after: 0 });
    expect(before.ok && before.data.map(m => m.id)).toHaveLength(2);
    expect(after).toEqual(before);
  } finally { await f.close(); }
});

it('실제 동시각 메시지와 고아 메모를 긴 본문까지 빠짐없이 페이지로 읽는다', async () => {
  const f = await conversationFixture('본문 '.repeat(3000));
  try {
    const batch = structuredClone(f.batch); batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'second'; batch.messages[0]!.body = '두 번째'; batch.toolNotes[0]!.id = f.ids.next(); batch.toolNotes[0]!.harnessMessageId = 'second'; batch.toolNotes[0]!.target = 'Bash SECRET=value';
    const orphan = structuredClone(batch.toolNotes[0]!); orphan.id = f.ids.next(); orphan.harnessMessageId = 'orphan'; orphan.target = 'Bash TOKEN=secret'; batch.toolNotes = [...batch.toolNotes, orphan];
    expect((await f.store.ingest(batch)).ok).toBe(true);
    const token = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    let cursor: string | undefined; const rows: { id: string; body: string }[] = [];
    do { const page = await readSessionPage(f.store, { session: token, limit: 1, ...(cursor ? { cursor } : {}) }); expect(page.ok).toBe(true); if (!page.ok) break; rows.push(...page.data); cursor = page.meta.next?.args.cursor as string | undefined; } while (cursor);
    expect(rows.filter(r => r.id === f.batch.messages[0]!.id).map(r => r.body).join('')).toBe(f.batch.messages[0]!.body);
    expect(new Set(rows.map(r => r.id)).size).toBe(5);
    expect(JSON.stringify(rows)).not.toMatch(/SECRET=value|TOKEN=secret/);
    expect(rows.some(r => r.id === orphan.id)).toBe(true);
  } finally { await f.close(); }
});

it('질의 오류는 빈 결과와 구별한다', async () => {
  const f = await conversationFixture('검색');
  try { await f.db.query('drop table brain.chunks cascade'); expect(await searchRecall(f.store, 'chunks', { query: '검색' })).toMatchObject({ ok: false, code: 'SEARCH_FAILED' }); }
  finally { await f.close(); }
});

it('긴 본문을 읽는 도중 수동 가리기가 일어나면 새 본문 처음부터 읽고 뒤 메시지로 진행한다', async () => {
  const { planRedaction } = await import('@second-brain/core');
  const { clock } = await import('./fixture.js');
  const f = await conversationFixture('비밀'.repeat(5000));
  try {
    const batch = structuredClone(f.batch); batch.toolNotes = []; batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'next-message'; batch.messages[0]!.occurredAt = new Date(batch.messages[0]!.occurredAt.getTime() + 1000); batch.messages[0]!.body = '다음 메시지';
    expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    expect(await f.store.redactMessage({ messageId: f.batch.messages[0]!.id, plan: current => planRedaction(current, { mode: 'text', text: '비밀'.repeat(5000), kind: 'manual' }, { now: clock.now, newId: () => f.ids.next() }) })).toMatchObject({ ok: true });
    const cursor = first.meta.next.args.cursor as string;
    const changed = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!changed.ok) throw new Error(changed.message);
    expect(changed.meta.hint).toContain('처음부터');
    expect(changed.data[0]?.body).toBe('[REDACTED:manual]');
    expect(changed.meta.next).toBeTruthy();
    const next = await readSessionPage(f.store, { session, cursor: changed.meta.next!.args.cursor as string, limit: 1 });
    expect(next.ok && next.data[0]?.body).toBe('다음 메시지');
  } finally { await f.close(); }
});

it.each(['timeout', 'disconnect'] as const)('드라이버의 코드 없는 연결 실패 %s는 DB_UNAVAILABLE이다', async mode => {
  const { createServer } = await import('node:net');
  const { postgresStore } = await import('../src/index.js');
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer(socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); if (mode === 'disconnect') socket.destroy(); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('포트가 없습니다');
  const reader = postgresStore({ databaseUrl: `postgresql://test:test@127.0.0.1:${address.port}/test`, connectTimeoutMs: 100 });
  try { expect(await searchRecall(reader, 'chunks', { query: '검색' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' }); }
  finally { await reader.close(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}, 30000);

it.each([1, 2])('고아 메모 %i건 재개 앞에 추가된 메시지와 연결 메모를 먼저 읽는다', async orphanCount => {
  const f = await conversationFixture('첫 메시지');
  try {
    const batch = structuredClone(f.batch); batch.messages = []; batch.attachments = [];
    const orphans = Array.from({ length: orphanCount }, (_, index) => ({ ...batch.toolNotes[0]!, id: f.ids.next(), harnessMessageId: `orphan-${index}`, target: `고아 ${index}` }));
    batch.toolNotes = orphans; expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    let cursor = first.meta.next.args.cursor as string;
    if (orphanCount === 2) { const one = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!one.ok || !one.meta.next) throw new Error('고아 커서가 없습니다'); expect(one.data[0]?.id).toBe(orphans[0]!.id); cursor = one.meta.next.args.cursor as string; }
    const appended = structuredClone(f.batch); appended.messages[0]!.id = f.ids.next(); appended.messages[0]!.harnessMessageId = 'append'; appended.messages[0]!.occurredAt = new Date(appended.messages[0]!.occurredAt.getTime() + 1000); appended.messages[0]!.body = '새 본문 '.repeat(2500);
    appended.toolNotes[0]!.id = f.ids.next(); appended.toolNotes[0]!.harnessMessageId = 'append'; appended.toolNotes[0]!.target = 'SECRET=value';
    expect((await f.store.ingest(appended)).ok).toBe(true);
    const seen: { id: string; body: string }[] = [];
    do { const page = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!page.ok) throw new Error(page.message); seen.push(...page.data); cursor = page.meta.next?.args.cursor as string; } while (cursor);
    expect(seen.filter(row => row.id === appended.messages[0]!.id).map(row => row.body).join('')).toBe(appended.messages[0]!.body);
    expect(seen.some(row => row.id === appended.toolNotes[0]!.id)).toBe(true);
    expect(seen.filter(row => row.id === orphans[orphanCount - 1]!.id)).toHaveLength(1);
    if (orphanCount === 2) expect(seen.some(row => row.id === orphans[0]!.id)).toBe(false);
    expect(JSON.stringify(seen)).not.toContain('SECRET=value');
  } finally { await f.close(); }
});

it('부분 출력한 긴 고아 메모를 보류한 채 새 메시지를 읽고 같은 문자 위치로 돌아간다', async () => {
  const f = await conversationFixture('첫 메시지');
  try {
    const batch = structuredClone(f.batch); batch.messages = []; batch.attachments = [];
    batch.toolNotes = [{ ...batch.toolNotes[0]!, id: f.ids.next(), harnessMessageId: 'long-orphan', target: '노트 '.repeat(5000) }];
    expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    const partial = await readSessionPage(f.store, { session, cursor: first.meta.next.args.cursor as string, limit: 1 }); if (!partial.ok || !partial.meta.next) throw new Error('부분 커서가 없습니다');
    expect(partial.warnings).toContain('RESULT_TRUNCATED');
    const added = structuredClone(f.batch); added.toolNotes = []; added.messages[0]!.id = f.ids.next(); added.messages[0]!.harnessMessageId = 'long-orphan'; added.messages[0]!.occurredAt = new Date(added.messages[0]!.occurredAt.getTime() + 1000); added.messages[0]!.body = '새 메시지';
    expect((await f.store.ingest(added)).ok).toBe(true);
    let cursor: string | undefined = partial.meta.next.args.cursor as string; const rows = [...partial.data]; let pages = 0;
    do { expect(++pages).toBeLessThan(20); const result = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!result.ok) throw new Error(result.message); rows.push(...result.data); cursor = result.meta.next?.args.cursor as string | undefined; } while (cursor);
    expect(rows.filter(row => row.id === batch.toolNotes[0]!.id).map(row => row.body).join('')).toBe(batch.toolNotes[0]!.target);
    expect(rows.filter(row => row.id === added.messages[0]!.id).map(row => row.body)).toEqual(['새 메시지']);
    expect(rows[1]?.id).toBe(added.messages[0]!.id);
  } finally { await f.close(); }
});

it('고아가 새 메시지에 연결되면 모호한 메모를 알리고 작은 id의 새 메모도 보존한다', async () => {
  const f = await conversationFixture('첫 메시지');
  try {
    const batch = structuredClone(f.batch); batch.messages = []; batch.attachments = [];
    const notes = [0, 1].map(index => ({ ...batch.toolNotes[0]!, id: f.ids.next(), harnessMessageId: `later-${index}`, target: `고아 ${index}` }));
    batch.toolNotes = notes; expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    const prior = await readSessionPage(f.store, { session, cursor: first.meta.next.args.cursor as string, limit: 1 }); if (!prior.ok || !prior.meta.next) throw new Error('두 번째 커서가 없습니다');
    expect(prior.data.map(row => row.id)).toEqual([notes[0]!.id]);
    const appended = structuredClone(f.batch); appended.toolNotes = []; appended.messages[0]!.id = f.ids.next(); appended.messages[0]!.harnessMessageId = 'later-1'; appended.messages[0]!.occurredAt = new Date(appended.messages[0]!.occurredAt.getTime() + 1000); appended.messages[0]!.body = '연결 메시지';
    const smallNote = { ...f.batch.toolNotes[0]!, id: '00000000-0000-7000-8000-000000000001', harnessMessageId: 'later-1', ordinal: 1, target: '새 작은 메모' };
    appended.toolNotes = [smallNote];
    const alreadyRead = { ...appended.messages[0]!, id: f.ids.next(), harnessMessageId: 'later-0', occurredAt: new Date(appended.messages[0]!.occurredAt.getTime() + 1000), body: '앞서 읽은 메모의 메시지' };
    appended.messages = [...appended.messages, alreadyRead];
    expect((await f.store.ingest(appended)).ok).toBe(true);
    let cursor: string | undefined = prior.meta.next.args.cursor as string; const seen: { id: string }[] = []; const hints: string[] = [];
    do { const page = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!page.ok) throw new Error(page.message); seen.push(...page.data); if (page.meta.hint) hints.push(page.meta.hint); cursor = page.meta.next?.args.cursor as string | undefined; } while (cursor);
    expect(seen.map(row => row.id)).toEqual([appended.messages[0]!.id, notes[1]!.id, smallNote.id, alreadyRead.id, notes[0]!.id]);
    expect(hints.some(hint => hint.includes('모호'))).toBe(true);
  } finally { await f.close(); }
});

it('고아 메모 220건을 작은 페이지로 빠짐없이 읽으며 커서 크기가 일정하게 유지된다', async () => {
  const f = await conversationFixture('첫 메시지');
  try {
    const batch = structuredClone(f.batch); batch.messages = []; batch.attachments = [];
    const notes = Array.from({ length: 220 }, (_, index) => ({ ...batch.toolNotes[0]!, id: f.ids.next(), harnessMessageId: `bulk-orphan-${index}`, target: `고아 ${index}` }));
    batch.toolNotes = notes; expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    let cursor: string | undefined; const rows: string[] = []; const sizes: number[] = []; let pages = 0;
    do {
      expect(++pages).toBeLessThan(150);
      const page = await readSessionPage(f.store, { session, limit: 3, ...(cursor ? { cursor } : {}) }); if (!page.ok) throw new Error(page.message);
      rows.push(...page.data.map(row => row.id)); cursor = page.meta.next?.args.cursor as string | undefined;
      if (cursor) sizes.push(cursor.length);
    } while (cursor);
    expect(rows.filter(id => notes.some(note => note.id === id))).toHaveLength(220);
    expect(new Set(rows).size).toBe(rows.length);
    expect(Math.max(...sizes)).toBeLessThan(1200);
  } finally { await f.close(); }
});

it.each(['EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'])('연결 오류 %s는 DB_UNAVAILABLE이다', async code => {
  const { postgresRecallStore } = await import('../src/recall.js');
  const error = Object.assign(new Error('연결 실패'), { code });
  const store = postgresRecallStore(() => ({ ok: true, connection: { db: { getExecutor() { throw error; } } as never } }));
  expect(await searchRecall(store, 'chunks', { query: '검색' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
});

it('연결된 긴 메시지 다음 보류 메모와 같은 메시지의 형제 메모를 모두 읽는다', async () => {
  const f = await conversationFixture('첫 메시지');
  try {
    const orphan = structuredClone(f.batch); orphan.messages = []; orphan.attachments = [];
    orphan.toolNotes = [{ ...orphan.toolNotes[0]!, id: f.ids.next(), harnessMessageId: 'linked-owner', target: '노트 '.repeat(500) }];
    expect((await f.store.ingest(orphan)).ok).toBe(true);
    const session = `${orphan.key.harness}:${orphan.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    const appended = structuredClone(f.batch); appended.messages[0]!.id = f.ids.next(); appended.messages[0]!.harnessMessageId = 'linked-owner'; appended.messages[0]!.occurredAt = new Date(appended.messages[0]!.occurredAt.getTime() + 1000); appended.messages[0]!.body = '가'.repeat(6100);
    appended.toolNotes = [{ ...appended.toolNotes[0]!, id: f.ids.next(), harnessMessageId: 'linked-owner', ordinal: 1, target: '형제 메모' }];
    expect((await f.store.ingest(appended)).ok).toBe(true);
    let cursor: string | undefined = first.meta.next.args.cursor as string; const rows: { id: string; body: string }[] = []; let pages = 0;
    do { expect(++pages).toBeLessThan(10); const result = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!result.ok) throw new Error(result.message); rows.push(...result.data); cursor = result.meta.next?.args.cursor as string | undefined; } while (cursor);
    expect(rows.map(row => row.id)).toEqual([appended.messages[0]!.id, orphan.toolNotes[0]!.id, appended.toolNotes[0]!.id]);
    expect(rows[2]!.body).toBe('형제 메모');
  } finally { await f.close(); }
});

it.each([1, 3])('연결 메모부터 시작해 긴 메모 %i건과 고아 메모를 끝까지 읽는다', async count => {
  const f = await conversationFixture('소유 메시지');
  try {
    const batch = structuredClone(f.batch); batch.messages = []; batch.attachments = [];
    const original = { ...f.batch.toolNotes[0]!, id: f.ids.next(), ordinal: 1, target: '메모 '.repeat(5000) };
    const siblings = Array.from({ length: count - 1 }, (_, index) => ({ ...original, id: f.ids.next(), ordinal: index + 2, target: '형제 '.repeat(2500) }));
    const orphan = { ...original, id: f.ids.next(), harnessMessageId: 'unlinked-note', ordinal: 0, target: '고아' };
    batch.toolNotes = [original, ...siblings, orphan]; expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    let cursor: string | undefined; const rows: { id: string; body: string }[] = []; let pages = 0;
    do { expect(++pages).toBeLessThan(30); const page = await readSessionPage(f.store, { session, limit: 1, ...(cursor ? { cursor } : { note: original.id }) }); if (!page.ok) throw new Error(page.message); rows.push(...page.data); cursor = page.meta.next?.args.cursor as string | undefined; } while (cursor);
    expect(rows.filter(row => row.id === original.id).map(row => row.body).join('')).toBe('메모 '.repeat(5000));
    for (const sibling of siblings) expect(rows.filter(row => row.id === sibling.id).map(row => row.body).join('')).toBe(sibling.target);
    expect(rows.filter(row => row.id === orphan.id)).toHaveLength(1);
    expect(rows.some(row => row.id === f.batch.messages[0]!.id)).toBe(false);
  } finally { await f.close(); }
});

it.each(['대기 앞', '이미 소비한 뒤', '부분 고아'])('고아 구성원 변경 %s은 작은 새 id를 재탐색하고 안내한다', async scenario => {
  const f = await conversationFixture('첫 메시지');
  try {
    const batch = structuredClone(f.batch); batch.messages = []; batch.attachments = [];
    const firstNote = { ...batch.toolNotes[0]!, id: '00000000-0000-7000-8000-000000000010', harnessMessageId: 'orphan-10', target: '처음 고아' };
    const pending = { ...batch.toolNotes[0]!, id: '00000000-0000-7000-8000-000000000020', harnessMessageId: 'orphan-20', target: scenario === '부분 고아' ? '긴 고아 '.repeat(5000) : '대기 고아' };
    batch.toolNotes = scenario === '대기 앞' ? [pending] : [firstNote, pending]; expect((await f.store.ingest(batch)).ok).toBe(true);
    const session = `${batch.key.harness}:${batch.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    let cursor = first.meta.next.args.cursor as string;
    if (scenario !== '대기 앞') { const page = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!page.ok || !page.meta.next) throw new Error('고아 커서가 없습니다'); expect(page.data[0]?.id).toBe(firstNote.id); cursor = page.meta.next.args.cursor as string; }
    if (scenario === '부분 고아') { const page = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!page.ok || !page.meta.next) throw new Error('부분 커서가 없습니다'); expect(page.data[0]?.body.length).toBeLessThan(pending.target.length); cursor = page.meta.next.args.cursor as string; }
    const small = { ...pending, id: '00000000-0000-7000-8000-000000000005', harnessMessageId: 'orphan-05', target: '새 고아' };
    batch.toolNotes = [small]; expect((await f.store.ingest(batch)).ok).toBe(true);
    let next: string | undefined = cursor; const rows: { id: string; body: string }[] = []; const hints: string[] = []; let pages = 0;
    do { expect(++pages).toBeLessThan(30); const page = await readSessionPage(f.store, { session, cursor: next, limit: 1 }); if (!page.ok) throw new Error(page.message); rows.push(...page.data); if (page.meta.hint) hints.push(page.meta.hint); next = page.meta.next?.args.cursor as string | undefined; } while (next);
    expect(rows.some(row => row.id === small.id)).toBe(true);
    expect(rows.filter(row => row.id === pending.id).map(row => row.body).join('')).toBe(pending.target);
    if (scenario !== '대기 앞') expect(rows.some(row => row.id === firstNote.id)).toBe(true);
    expect(hints.some(hint => hint.includes('고아 메모 구성'))).toBe(true);
  } finally { await f.close(); }
});

it('긴 보류 고아가 연결되고 동시에 작은 새 고아가 들어와도 두 위치를 끝까지 읽는다', async () => {
  const f = await conversationFixture('첫 메시지');
  try {
    const initial = structuredClone(f.batch); initial.messages = []; initial.attachments = [];
    const pending = { ...initial.toolNotes[0]!, id: '00000000-0000-7000-8000-000000000020', harnessMessageId: 'connect-pending', target: '긴 메모 '.repeat(5000) };
    initial.toolNotes = [pending]; expect((await f.store.ingest(initial)).ok).toBe(true);
    const session = `${initial.key.harness}:${initial.key.harnessSessionId}`;
    const first = await readSessionPage(f.store, { session, limit: 1 }); if (!first.ok || !first.meta.next) throw new Error('첫 커서가 없습니다');
    const next = structuredClone(f.batch); next.messages[0]!.id = f.ids.next(); next.messages[0]!.harnessMessageId = pending.harnessMessageId; next.messages[0]!.occurredAt = new Date(next.messages[0]!.occurredAt.getTime() + 1000); next.messages[0]!.body = '연결 메시지';
    const smaller = { ...pending, id: '00000000-0000-7000-8000-000000000010', harnessMessageId: 'new-small-orphan', target: '작은 고아' };
    const sibling = { ...pending, id: f.ids.next(), ordinal: pending.ordinal + 1, target: '연결 형제 '.repeat(4000) }; next.toolNotes = [smaller, sibling];
    expect((await f.store.ingest(next)).ok).toBe(true);
    let cursor: string | undefined = first.meta.next.args.cursor as string; const rows: { id: string; body: string }[] = []; const hints: string[] = []; let pages = 0;
    do { expect(++pages).toBeLessThan(20); const page = await readSessionPage(f.store, { session, cursor, limit: 1 }); if (!page.ok) throw new Error(page.message); rows.push(...page.data); if (page.meta.hint) hints.push(page.meta.hint); cursor = page.meta.next?.args.cursor as string | undefined; } while (cursor);
    expect(rows.filter(row => row.id === next.messages[0]!.id)).toHaveLength(1);
    expect(rows.filter(row => row.id === pending.id).map(row => row.body).join('')).toBe(pending.target);
    expect(rows.filter(row => row.id === smaller.id)).toHaveLength(1);
    expect(rows.filter(row => row.id === sibling.id).map(row => row.body).join('')).toBe(sibling.target);
    expect(hints.some(hint => hint.includes('고아 메모 구성'))).toBe(true);
  } finally { await f.close(); }
});
