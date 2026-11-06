import pg from 'pg';
import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { chunkConversation, conversationChunkHandler, conversationFingerprint, literalLikePattern, planRedaction, redactMessage } from '@second-brain/core';
import { postgresStore } from '../src/index.js';
import { conversationFixture } from './conversation-fixture.js';
import { clock } from './fixture.js';

// 전체 JSON 방식의 독립 oracle. 제품 지문 함수와 chunker를 사용하지 않는다.
function expectedFingerprint(config: unknown, messages: readonly { id: string; occurredAt: Date; body: string }[]) {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v !== null && typeof v === 'object'
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, value]) => [k, stable(value)])) : v;
  const sorted = [...messages].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const json = JSON.stringify([stable(config), sorted.map(m => [m.id, m.occurredAt.toISOString(), m.body])]);
  return 'sha256:' + createHash('sha256').update(json, 'utf8').digest('hex');
}

it.each(['동시 반입', '가리기'] as const)('snapshot barrier 뒤 %s의 최종 행과 지문 및 조각은 독립 기대값과 같다', async operation => {
  const f = await conversationFixture('비밀 보존');
  const other = postgresStore({ databaseUrl: f.db.appUrl });
  const third = postgresStore({ databaseUrl: f.db.appUrl });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let signal!: () => void; const ready = new Promise<void>(resolve => { signal = resolve; });
  let running: ReturnType<ReturnType<typeof conversationChunkHandler>> | undefined;
  try {
    const initial = f.batch.messages[0]!;
    const expected = [{ id: initial.id, occurredAt: initial.occurredAt, body: operation === '가리기' ? '[REDACTED:manual] 보존' : initial.body }];
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'oracle-reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const instrumented = { ...f.store, async readConversationSnapshot(sessionId: string) {
      const result = await f.store.readConversationSnapshot(sessionId);
      signal(); await gate; return result;
    } };
    running = conversationChunkHandler({ store: instrumented, clock, idGen: f.ids })(claim.item);
    await ready; // 첫 snapshot 완료, handler의 확정은 gate에서 대기한다.
    if (operation === '동시 반입') {
      const batch = structuredClone(f.batch); batch.toolNotes = [];
      batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'concurrent-oracle'; batch.messages[0]!.body = '새 본문';
      expected.push({ id: batch.messages[0]!.id, occurredAt: batch.messages[0]!.occurredAt, body: batch.messages[0]!.body });
      // 두 실제 연결이 같은 새 batch를 경쟁 반입한다.
      const results = await Promise.all([other.ingest(batch), third.ingest(batch)]);
      for (const result of results) expect(result.ok).toBe(true);
      expect(results.reduce((n, result) => n + (result.ok ? result.inserted.messages : 0), 0)).toBe(1);
    } else {
      expect(await other.redactMessage({ messageId: initial.id, plan: current => planRedaction(current, { mode: 'text', text: '비밀', kind: 'manual' }, { now: clock.now, newId: () => f.ids.next() }) })).toMatchObject({ ok: true });
    }
    release();
    expect(await running).toMatchObject({ ok: false, code: 'CONVERSATION_STALE' });
    expect(await f.db.rows('select id from brain.chunks')).toEqual([]);
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const snapshot = await f.store.readConversationSnapshot(f.sessionId);
    if (!snapshot.ok || !snapshot.snapshot) throw new Error('최종 snapshot 실패');
    const ordered = [...expected].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    expect(snapshot.snapshot.messages).toEqual(ordered);
    expect(snapshot.snapshot.fingerprint).toBe(expectedFingerprint(snapshot.snapshot.config, expected));
    expect(await f.db.rows<{ n: number }>('select count(*)::int as n from brain.messages')).toEqual([{ n: expected.length }]);
    const chunks = await f.db.rows<{ body: string; part: number; from_at: Date; to_at: Date }>('select body,part,from_at,to_at from brain.chunks');
    // 짧고 같은 시각인 fixture는 독립적으로 단일 part 0 조각이다.
    expect(chunks).toEqual([{ body: ordered.map(m => m.body).join('\n'), part: 0, from_at: ordered[0]!.occurredAt, to_at: ordered.at(-1)!.occurredAt }]);
  } finally { release(); if (running) await running; await third.close(); await other.close(); await f.close(); }
}, 30000);

it('snapshot 이후 유효 설정 변경은 옛 지문 확정을 거부한다', async () => {
  const f = await conversationFixture('설정 변경');
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'config-reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const before = await f.store.readConversationSnapshot(f.sessionId);
    if (!before.ok || !before.snapshot) throw new Error('snapshot 실패');
    await f.db.query("update brain.index_configs set chunk_params = jsonb_set(chunk_params, '{targetChars}', '1199') where id='019a0000-0000-7000-8000-000000000003'");
    const message = f.batch.messages[0]!;
    const chunk = { id: f.ids.next(), fromAt: message.occurredAt, toAt: message.occurredAt, body: message.body, part: 0 };
    expect(await f.store.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item.id, claimedBy: 'config-reader', now: clock.now(), fingerprint: before.snapshot.fingerprint, chunks: [chunk] })).toEqual({ ok: true, committed: false });
    expect(await f.db.rows('select id from brain.chunks')).toEqual([]);
    const after = await f.store.readConversationSnapshot(f.sessionId);
    if (!after.ok || !after.snapshot) throw new Error('변경 snapshot 실패');
    expect(after.snapshot.fingerprint).toBe(expectedFingerprint(after.snapshot.config, [{ id: message.id, occurredAt: message.occurredAt, body: message.body }]));
    expect(after.snapshot.fingerprint).not.toBe(before.snapshot.fingerprint);
    expect(await f.store.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item.id, claimedBy: 'config-reader', now: clock.now(), fingerprint: after.snapshot.fingerprint, chunks: [chunk] })).toEqual({ ok: true, committed: true });
    expect(await f.db.rows('select body,part from brain.chunks')).toEqual([{ body: message.body, part: 0 }]);
  } finally { await f.close(); }
}, 30000);

it('긴 본문과 NUL을 보존하고 재처리와 literal 검색을 한다', async () => {
  const f = await conversationFixture('한글%_\\Ab\0' + 'x'.repeat(5000));
  try {
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const rows = await f.db.rows<{ id: string; body: string; body_raw: Buffer | null; part: number }>('select id,body,body_raw,part from brain.chunks order by part');
    expect(rows.map(r => r.part)).toEqual([1, 2, 3]);
    expect(rows[0]!.body).toContain('�'); expect(rows[0]!.body_raw?.includes(0)).toBe(true);
    const found = await f.store.searchConversationChunks({ pattern: literalLikePattern('한글%_\\ab') });
    expect(found.ok && found.chunks[0]!.body).toContain('\0');
    const snapshot = await f.store.readConversationSnapshot(f.sessionId); expect(snapshot.ok && snapshot.snapshot).toBeTruthy();
    expect(await f.drain()).toMatchObject({ claimed: 0 });
    expect(await f.db.rows('select id from brain.chunks order by part')).toEqual(rows.map(r => ({ id: r.id })));
  } finally { await f.close(); }
}, 30000);

it('읽은 뒤 다른 연결이 추가하면 낡은 확정을 거부하고 다시 생성한다', async () => {
  const f = await conversationFixture('처음'); const other = postgresStore({ databaseUrl: f.db.appUrl });
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const staleCommit = (async () => { await barrier; return f.store.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item!.id, claimedBy: 'reader', now: clock.now(), fingerprint: read.snapshot!.fingerprint, chunks: chunkConversation(read.snapshot!.messages, read.snapshot!.config).map(c => ({ ...c, id: f.ids.next() })) }); })();
    const batch = structuredClone(f.batch); batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'new'; batch.messages[0]!.body = '추가'; batch.toolNotes = [];
    try { expect(await other.ingest(batch)).toMatchObject({ ok: true }); } finally { release(); }
    const stale = await staleCommit;
    expect(stale).toEqual({ ok: true, committed: false });
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const latest = await f.store.readConversationSnapshot(f.sessionId); if (!latest.ok || !latest.snapshot) throw new Error('읽기 실패');
    expect(latest.snapshot.fingerprint).toBe(conversationFingerprint(latest.snapshot.config, latest.snapshot.messages));
    expect(JSON.stringify(await f.db.rows('select body from brain.chunks'))).toContain('추가');
  } finally { await other.close(); await f.close(); }
}, 30000);

it('가리기 후 기존 조각을 즉시 지우고 재생성한다', async () => {
  const f = await conversationFixture('지울말 보존');
  try {
    await f.drain();
    const result = await f.store.redactMessage({ messageId: f.batch.messages[0]!.id, plan: current => planRedaction(current, { mode: 'text', text: '지울말', kind: 'manual' }, { now: clock.now, newId: () => f.ids.next() }) });
    expect(result).toMatchObject({ ok: true });
    expect(JSON.stringify(await f.db.rows('select body from brain.chunks'))).not.toContain('지울말');
    expect(await f.drain()).toMatchObject({ completed: 1 });
    expect(JSON.stringify(await f.db.rows('select body from brain.chunks'))).toContain('[REDACTED:manual]');
  } finally { await f.close(); }
}, 30000);

it('읽기 뒤 가리기가 일어나면 낡은 조각을 확정하지 않는다', async () => {
  const f = await conversationFixture('가릴말 보존'); const other = postgresStore({ databaseUrl: f.db.appUrl });
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    let release!: () => void; const barrier = new Promise<void>(resolve => { release = resolve; });
    const staleCommit = (async () => { await barrier; return f.store.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item!.id, claimedBy: 'reader', now: clock.now(), fingerprint: read.snapshot!.fingerprint, chunks: chunkConversation(read.snapshot!.messages, read.snapshot!.config).map(c => ({ ...c, id: f.ids.next() })) }); })();
    try { const redacted = await other.redactMessage({ messageId: f.batch.messages[0]!.id, plan: current => planRedaction(current, { mode: 'text', text: '가릴말', kind: 'manual' }, { now: clock.now, newId: () => f.ids.next() }) }); expect(redacted).toMatchObject({ ok: true }); } finally { release(); }
    expect(await staleCommit).toEqual({ ok: true, committed: false });
    expect(await f.drain()).toMatchObject({ completed: 1 });
    expect(JSON.stringify(await f.db.rows('select body from brain.chunks'))).not.toContain('가릴말');
  } finally { await other.close(); await f.close(); }
}, 30000);

it('재생성 일감 쓰기가 실패하면 가리기 전체가 되돌아간다', async () => {
  const f = await conversationFixture('가릴말 보존');
  try {
    await f.drain();
    const before = await f.db.rows(`select (select jsonb_agg(m) from brain.messages m) as messages, (select jsonb_agg(c) from brain.chunks c) as chunks, (select jsonb_agg(r) from brain.redactions r) as redactions, (select jsonb_agg(w order by id) from brain.work_items w) as work`);
    await f.db.query(`create function brain.reject_chunk_work() returns trigger language plpgsql as $$ begin if new.kind = 'conversation_chunk' then raise exception 'test failure'; end if; return new; end $$; create trigger reject_chunk_work before insert or update on brain.work_items for each row execute function brain.reject_chunk_work()`);
    const homeBefore = await readdir(f.home);
    const result = await redactMessage({ store: f.store, clock, idGen: f.ids }, { message: f.batch.messages[0]!.id, text: '가릴말', confirm: true });
    expect(result.ok).toBe(false);
    expect(await readdir(f.home)).toEqual(homeBefore);
    const after = await f.db.rows(`select (select jsonb_agg(m) from brain.messages m) as messages, (select jsonb_agg(c) from brain.chunks c) as chunks, (select jsonb_agg(r) from brain.redactions r) as redactions, (select jsonb_agg(w order by id) from brain.work_items w) as work`);
    expect(after).toEqual(before);
  } finally { await f.close(); }
}, 30000);

it('메시지 추가 뒤 변하지 않은 앞 조각의 행을 유지한다', async () => {
  const f = await conversationFixture('가'.repeat(1200));
  try {
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const before = await f.db.rows('select id,body,from_at,to_at,part from brain.chunks');
    const batch = structuredClone(f.batch); batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'append'; batch.messages[0]!.occurredAt = new Date(batch.messages[0]!.occurredAt.getTime() + 1000); batch.messages[0]!.body = '뒤';
    expect(await f.store.ingest(batch)).toMatchObject({ ok: true });
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const after = await f.db.rows('select id,body,from_at,to_at,part from brain.chunks order by from_at,to_at');
    expect(after).toHaveLength(2); expect(after).toContainEqual(before[0]);
    expect(after[1]!.body).toContain('뒤');
  } finally { await f.close(); }
}, 30000);

it('검색 포트는 독립 LIKE 결과와 일치하고 실패를 빈 결과와 구별한다', async () => {
  const f = await conversationFixture('한글 % _ \\ MiXeD' + 'x'.repeat(1200));
  const client = new pg.Client({ connectionString: f.db.url }); await client.connect();
  try {
    const batch = structuredClone(f.batch); batch.toolNotes = [];
    for (const [i, body] of [[1, '한글 보통'], [2, '그 밖의 본문']] as const) { batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = `검색${i}`; batch.messages[0]!.occurredAt = new Date(f.batch.messages[0]!.occurredAt.getTime() + i * 1000); batch.messages[0]!.body = body + 'y'.repeat(1200); expect(await f.store.ingest(batch)).toMatchObject({ ok: true }); }
    await f.drain();
    expect((await f.db.rows('select id from brain.chunks')).length).toBeGreaterThan(1);
    for (const query of ['한글', '%', '_', '\\', 'mixed', '없음']) {
      const pattern = literalLikePattern(query);
      const independentlyEscaped = '%' + [...query].map(c => ['%', '_', '\\'].includes(c) ? '\\' + c : c).join('') + '%';
      const expected = (await client.query<{ id: string }>("select id from brain.chunks where lower(body) like lower($1) escape '\\' order by id", [independentlyEscaped])).rows;
      const actual = await f.store.searchConversationChunks({ pattern });
      expect(actual.ok && actual.chunks.map(c => c.id)).toEqual(expected.map(c => c.id));
    }
  } finally { await client.end(); await f.close(); }
  expect((await f.store.searchConversationChunks({ pattern: '%x%' })).ok).toBe(false);
}, 30000);

it('세션 잠금 대기 한도를 지키고 만료된 청구는 확정하지 않는다', async () => {
  const f = await conversationFixture('잠금 시험');
  const slow = postgresStore({ databaseUrl: f.db.appUrl, lockTimeoutMs: 100, queryTimeoutMs: 2000 });
  const client = new pg.Client({ connectionString: f.db.url }); await client.connect();
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    const input = { sessionId: f.sessionId, workId: claim.item.id, claimedBy: 'reader', now: clock.now(), fingerprint: read.snapshot.fingerprint, chunks: chunkConversation(read.snapshot.messages, read.snapshot.config).map(c => ({ ...c, id: f.ids.next() })) };
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${f.batch.key.harness}:${f.batch.key.harnessSessionId}`]);
    expect(await slow.commitConversationChunks(input)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    await client.query('rollback');
    expect(await f.store.commitConversationChunks({ ...input, now: new Date(claim.item.claimExpiresAt!.getTime() + 1) })).toEqual({ ok: true, committed: false });
    expect(await f.db.rows('select id from brain.chunks')).toEqual([]);
  } finally { await client.query('rollback').catch(() => {}); await client.end(); await slow.close(); await f.close(); }
}, 30000);

it('완료된 세션을 다시 청구해도 같은 행을 유지한다', async () => {
  const f = await conversationFixture('재청구');
  try {
    await f.drain(); const before = await f.db.rows('select * from brain.chunks');
    expect(await f.store.addWork({ id: f.ids.next(), kind: 'conversation_chunk', targetKind: 'session', targetId: f.sessionId, createdAt: clock.now(), nextAttemptAt: clock.now() })).toMatchObject({ ok: true, created: true });
    expect(await f.drain()).toMatchObject({ claimed: 1, completed: 1 });
    expect(await f.db.rows('select * from brain.chunks')).toEqual(before);
  } finally { await f.close(); }
}, 30000);

it('여러 앞 조각을 유지하고 추가된 뒤쪽만 갱신한다', async () => {
  const f = await conversationFixture('가'.repeat(1200));
  try {
    const batch = structuredClone(f.batch); batch.toolNotes = [];
    for (let i = 1; i <= 3; i++) { const m = batch.messages[0]!; m.id = f.ids.next(); m.harnessMessageId = `추가${i}`; m.occurredAt = new Date(f.batch.messages[0]!.occurredAt.getTime() + i * 1000); m.body = String(i).repeat(1200); expect(await f.store.ingest(batch)).toMatchObject({ ok: true }); }
    await f.drain(); const before = await f.db.rows<{ id: string }>('select id from brain.chunks order by from_at,to_at'); expect(before.length).toBeGreaterThan(1);
    batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = '마지막'; batch.messages[0]!.occurredAt = new Date(f.batch.messages[0]!.occurredAt.getTime() + 4000); batch.messages[0]!.body = '끝';
    expect(await f.store.ingest(batch)).toMatchObject({ ok: true }); await f.drain();
    const after = await f.db.rows<{ id: string }>('select id from brain.chunks order by from_at,to_at');
    expect(after.slice(0, before.length)).toEqual(before);
  } finally { await f.close(); }
}, 30000);

it('동시각 메시지 셋과 여러 긴 본문을 유일한 part로 저장한다', async () => {
  const f = await conversationFixture('첫째');
  try {
    const batch = structuredClone(f.batch); batch.toolNotes = [];
    for (const [i, body] of [[1, '둘째'], [2, '셋째']] as const) { batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = `동시${i}`; batch.messages[0]!.body = body; expect(await f.store.ingest(batch)).toMatchObject({ ok: true }); }
    await f.drain(); const group = await f.db.rows<{ body: string; part: number }>('select body,part from brain.chunks');
    expect(group).toEqual([{ body: '첫째\n둘째\n셋째', part: 0 }]);
    for (const i of [3, 4]) { batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = `긴${i}`; batch.messages[0]!.body = String(i).repeat(5000); expect(await f.store.ingest(batch)).toMatchObject({ ok: true }); }
    await f.drain(); const parts = await f.db.rows<{ part: number }>('select part from brain.chunks order by part');
    expect(parts.map(p => p.part)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  } finally { await f.close(); }
}, 30000);

it.each(['추가', '가리기'] as const)('확정 후 완료 전 %s가 일어나면 청구를 잃고 재생성한다', async operation => {
  const f = await conversationFixture('가릴말'); const other = postgresStore({ databaseUrl: f.db.appUrl });
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    expect(await f.store.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item.id, claimedBy: 'reader', now: clock.now(), fingerprint: read.snapshot.fingerprint, chunks: chunkConversation(read.snapshot.messages, read.snapshot.config).map(c => ({ ...c, id: f.ids.next() })) })).toEqual({ ok: true, committed: true });
    if (operation === '추가') { const batch = structuredClone(f.batch); batch.toolNotes = []; batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = '뒤'; batch.messages[0]!.body = '추가'; expect(await other.ingest(batch)).toMatchObject({ ok: true }); }
    else expect(await other.redactMessage({ messageId: f.batch.messages[0]!.id, plan: current => planRedaction(current, { mode: 'text', text: '가릴말', kind: 'manual' }, { now: clock.now, newId: () => f.ids.next() }) })).toMatchObject({ ok: true });
    expect(await f.store.completeWork({ id: claim.item.id, claimedBy: 'reader', now: clock.now() })).toEqual({ ok: true, outcome: 'lost' });
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const text = JSON.stringify(await f.db.rows('select body from brain.chunks'));
    if (operation === '추가') expect(text).toContain('추가'); else expect(text).not.toContain('가릴말');
  } finally { await other.close(); await f.close(); }
}, 30000);

it('교체된 청구는 기존 작업자의 확정을 거부한다', async () => {
  const f = await conversationFixture('청구');
  try {
    const first = await f.store.claimWork({ now: clock.now(), claimedBy: 'old', kinds: ['conversation_chunk'] }); if (!first.ok || !first.item) throw new Error('청구 실패');
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    const later = new Date(first.item.claimExpiresAt!.getTime() + 1);
    const next = await f.store.claimWork({ now: later, claimedBy: 'new', kinds: ['conversation_chunk'] }); expect(next.ok && next.item?.id).toBe(first.item.id);
    expect(await f.store.commitConversationChunks({ sessionId: f.sessionId, workId: first.item.id, claimedBy: 'old', now: later, fingerprint: read.snapshot.fingerprint, chunks: chunkConversation(read.snapshot.messages, read.snapshot.config).map(c => ({ ...c, id: f.ids.next() })) })).toEqual({ ok: true, committed: false });
  } finally { await f.close(); }
}, 30000);

it('지원하지 않는 규칙 설정은 조각을 확정하지 않는다', async () => {
  const f = await conversationFixture('설정');
  try {
    await f.db.query("update brain.index_configs set chunk_params = jsonb_set(chunk_params, '{rules,version}', '2') where id='019a0000-0000-7000-8000-000000000003'");
    const result = await f.store.readConversationSnapshot(f.sessionId); expect(result.ok).toBe(false);
    expect(await f.db.rows('select * from brain.chunks')).toEqual([]);
  } finally { await f.close(); }
}, 30000);

it.each(['추가', '가리기'] as const)('실제 handler snapshot barrier 뒤 %s가 끼면 낡은 확정을 거부한다', async operation => {
  const f = await conversationFixture('가릴말'); const other = postgresStore({ databaseUrl: f.db.appUrl });
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let signal!: () => void; const ready = new Promise<void>(resolve => { signal = resolve; });
  let running: ReturnType<ReturnType<typeof conversationChunkHandler>> | undefined;
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'barrier-reader', kinds: ['conversation_chunk'] });
    if (!claim.ok || !claim.item) throw new Error('청구 실패');
    const instrumented = { ...f.store, async readConversationSnapshot(sessionId: string) {
      const snapshot = await f.store.readConversationSnapshot(sessionId); signal(); await gate; return snapshot;
    } };
    running = conversationChunkHandler({ store: instrumented, clock, idGen: f.ids })(claim.item);
    await ready;
    if (operation === '추가') { const batch = structuredClone(f.batch); batch.toolNotes = []; batch.messages[0]!.id = f.ids.next(); batch.messages[0]!.harnessMessageId = 'barrier'; batch.messages[0]!.body = '새 입력'; expect(await other.ingest(batch)).toMatchObject({ ok: true }); }
    else expect(await other.redactMessage({ messageId: f.batch.messages[0]!.id, plan: current => planRedaction(current, { mode: 'text', text: '가릴말', kind: 'manual' }, { now: clock.now, newId: () => f.ids.next() }) })).toMatchObject({ ok: true });
    release();
    expect(await running).toMatchObject({ ok: false, code: 'CONVERSATION_STALE' });
    expect(await f.db.rows('select * from brain.chunks')).toEqual([]);
    expect(await f.drain()).toMatchObject({ completed: 1 });
    const result = JSON.stringify(await f.db.rows('select body from brain.chunks'));
    if (operation === '추가') expect(result).toContain('새 입력'); else expect(result).not.toContain('가릴말');
  } finally { release(); if (running) await running; await other.close(); await f.close(); }
}, 30000);

it('NUL 검색어를 저장 검색 투영에 맞춰 논리 원문을 돌려준다', async () => {
  const f = await conversationFixture('앞\0뒤');
  try {
    await f.drain();
    const found = await f.store.searchConversationChunks({ pattern: literalLikePattern('앞\0뒤') });
    expect(found.ok && found.chunks.map(c => c.body)).toEqual(['앞\0뒤']);
    const rawPattern = await f.store.searchConversationChunks({ pattern: '%앞\0뒤%' });
    expect(rawPattern.ok && rawPattern.chunks.map(c => c.body)).toEqual(['앞\0뒤']);
  } finally { await f.close(); }
}, 30000);

it('잠금을 기다리는 동안 같은 소유자의 청구가 만료되면 확정하지 않는다', async () => {
  const f = await conversationFixture('만료');
  const blocked = postgresStore({ databaseUrl: f.db.appUrl, applicationName: 'chunk-expiry-test', lockTimeoutMs: 2000, queryTimeoutMs: 4000 });
  const holder = new pg.Client({ connectionString: f.db.url }); await holder.connect();
  let running: ReturnType<typeof blocked.commitConversationChunks> | undefined;
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'same-owner', kinds: ['conversation_chunk'] }); if (!claim.ok || !claim.item) throw new Error('청구 실패');
    await f.db.query(`update brain.work_items set claim_expires_at = '${new Date(clock.now().getTime() + 250).toISOString()}' where id='${claim.item.id}'`);
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    await holder.query('begin'); await holder.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`${f.batch.key.harness}:${f.batch.key.harnessSessionId}`]);
    running = blocked.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item.id, claimedBy: 'same-owner', now: clock.now(), fingerprint: read.snapshot.fingerprint, chunks: chunkConversation(read.snapshot.messages, read.snapshot.config).map(c => ({ ...c, id: f.ids.next() })) });
    await expect.poll(async () => (await f.db.rows<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name='chunk-expiry-test' and wait_event_type='Lock'"))[0]!.n, { timeout: 1000, interval: 20 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    await holder.query('rollback');
    expect(await running).toEqual({ ok: true, committed: false });
    expect(await f.db.rows('select * from brain.chunks')).toEqual([]);
  } finally { await holder.query('rollback').catch(() => {}); if (running) await running; await holder.end(); await blocked.close(); await f.close(); }
}, 30000);

it('첫 유효기간 검사 뒤 조각 테이블에서 기다리다 만료되면 모든 쓰기를 롤백한다', async () => {
  const f = await conversationFixture('지연된 확정');
  const blocked = postgresStore({ databaseUrl: f.db.appUrl, applicationName: 'chunk-write-expiry', lockTimeoutMs: 2000, queryTimeoutMs: 4000 });
  const holder = new pg.Client({ connectionString: f.db.url }); await holder.connect();
  let running: ReturnType<typeof blocked.commitConversationChunks> | undefined;
  try {
    const claim = await f.store.claimWork({ now: clock.now(), claimedBy: 'same-owner', kinds: ['conversation_chunk'] }); if (!claim.ok || !claim.item) throw new Error('청구 실패');
    await f.db.query(`update brain.work_items set claim_expires_at = '${new Date(clock.now().getTime() + 250).toISOString()}' where id='${claim.item.id}'`);
    const read = await f.store.readConversationSnapshot(f.sessionId); if (!read.ok || !read.snapshot) throw new Error('읽기 실패');
    await holder.query('begin'); await holder.query('lock table brain.chunks in access exclusive mode');
    running = blocked.commitConversationChunks({ sessionId: f.sessionId, workId: claim.item.id, claimedBy: 'same-owner', now: clock.now(), fingerprint: read.snapshot.fingerprint, chunks: chunkConversation(read.snapshot.messages, read.snapshot.config).map(c => ({ ...c, id: f.ids.next() })) });
    await expect.poll(async () => (await f.db.rows<{ n: number }>("select count(*)::int as n from pg_stat_activity where application_name='chunk-write-expiry' and wait_event_type='Lock'"))[0]!.n, { timeout: 1000, interval: 20 }).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 300));
    await holder.query('rollback');
    expect(await running).toEqual({ ok: true, committed: false });
    expect(await f.db.rows('select * from brain.chunks')).toEqual([]);
  } finally { await holder.query('rollback').catch(() => {}); if (running) await running; await holder.end(); await blocked.close(); await f.close(); }
}, 30000);
