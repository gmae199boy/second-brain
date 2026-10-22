import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { REPOSITORY_UNANSWERED, sessionIdentityHandler } from '../src/capture/session-identity-work.js';
import { retryFailures } from '../src/failures/retry.js';
import {
  memoryStore, memorySpool, memoryParser, memoryTranscript, memoryRepositories,
  memoryTranscriptReader, memoryTranscriptFolder, sequenceIdGen,
  sampleSelfUserInput, sampleEnsureSessionInput, sampleCheckoutInput,
  sampleSessionKey, sampleSessionToken,
} from '../src/testing/index.js';
import type { InspectResult } from '../src/ports/repository.js';

const PATH = '/transcripts/session-0001.jsonl';
const CWD = '/demo/repo';
const unknown: InspectResult = { kind: 'unknown', reason: 'git_missing', message: 'git을 실행할 수 없습니다' };
const checkout = { remoteUrl: 'git@github.com:Brain-Owner/Notes.git', commonDir: '/demo/repo/.git', worktreePath: CWD };

async function kit(content = memoryTranscript) {
  let time = Date.parse('2026-01-03T00:00:00.000Z');
  const clock = { now: () => new Date(time) };
  const store = memoryStore();
  await store.ensureSelfUser(sampleSelfUserInput());
  const idGen = sequenceIdGen({ timestampMs: time });
  const repositories = memoryRepositories({ [CWD]: unknown });
  const transcripts = memoryTranscriptReader({ files: { [PATH]: content } });
  const folder = memoryTranscriptFolder({ files: [{
    path: PATH, harnessSessionId: sampleSessionKey.harnessSessionId, sizeBytes: content.length, modifiedAt: clock.now(),
  }] });
  const deps = {
    store: { ...store, async readSchemaVersion() { return { ok: true as const, version: null }; } },
    spool: memorySpool(), parsers: [memoryParser()], repositories, transcripts,
    transcriptFolders: [folder], clock, idGen, schemaVersion: 6, machine: 'demo-machine',
  };
  const brain = createBrain(deps);
  const add = () => store.addWork({
    id: idGen.next(), kind: 'session_identity', targetKind: 'session', targetId: sampleSessionToken,
    createdAt: clock.now(), nextAttemptAt: clock.now(),
  });
  return { deps, store, repositories, transcripts, folder, brain, add,
    advance: () => { time += 24 * 60 * 60 * 1000; } };
}

describe('deferred session identity', () => {
  it('captures unknown identity atomically and fills it after git returns', async () => {
    const k = await kit();
    expect(await k.brain.sessions.ingest({ session: sampleSessionToken, transcriptPath: PATH })).toMatchObject({ ok: true, created: true });
    expect(k.store.snapshot().sessions[0]).toMatchObject({ projectId: null, worktreeId: null });
    expect(k.store.snapshot().workItems).toMatchObject([{ kind: 'session_identity', completedAt: null }]);
    k.repositories.set(CWD, checkout);
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ completed: 1 });
    expect(k.store.snapshot().sessions[0]?.projectId).not.toBeNull();
    expect(k.store.snapshot().workItems[0]?.completedAt).not.toBeNull();
    expect(k.store.snapshot().failures).toEqual([]);
  });

  it.each([false, true])('definite non-repository and no cwd create no identity work (no cwd: %s)', async (noCwd) => {
    const content = noCwd ? memoryTranscript.replaceAll('"cwd":"/demo/repo"', '"cwd":null') : memoryTranscript;
    const k = await kit(content);
    k.repositories.set(CWD, { kind: 'not_repository' });
    expect(await k.brain.sessions.ingest({ session: sampleSessionToken, transcriptPath: PATH })).toMatchObject({ ok: true });
    expect(k.store.snapshot().workItems).toEqual([]);
    if (noCwd) expect(k.repositories.inspects()).toEqual([]);
  });

  it.each(['ingest', 'handler'] as const)('시작 폴더가 첫 메시지와 다르면 %s도 시작 폴더에서 추정한다', async (mode) => {
    const start = '/demo/gone';
    const content = JSON.stringify({ ...JSON.parse(memoryTranscript), startCwd: start });
    const k = await kit(content);
    k.repositories.set(start, { kind: 'missing' });
    k.repositories.set('/demo', { kind: 'checkout', checkout });
    if (mode === 'ingest') {
      expect(await k.brain.sessions.ingest({ session: sampleSessionToken, transcriptPath: PATH })).toMatchObject({ ok: true });
    } else {
      await k.store.ensureSession(sampleEnsureSessionInput());
      const added = await k.add();
      if (!added.ok) throw new Error(added.message);
      expect(await sessionIdentityHandler(k.deps)(added.item)).toEqual({ ok: true });
    }
    expect(k.repositories.inspects()).toEqual([start, '/demo']);
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: start, tagSource: 'ancestor' });
    expect(k.store.snapshot().worktrees[0]).toMatchObject({ path: start });
  });

  it('two overlapping initial ingests open one item', async () => {
    const k = await kit();
    const results = await Promise.all([1, 2].map(() => k.brain.sessions.ingest({ session: sampleSessionToken, transcriptPath: PATH })));
    expect(results.every((result) => result.ok)).toBe(true);
    expect(k.store.snapshot().sessions).toHaveLength(1);
    expect(k.store.snapshot().workItems).toHaveLength(1);
  });

  it('closes work for an already tagged session without making checkout rows or reading evidence', async () => {
    const k = await kit();
    await k.store.ensureSession(sampleEnsureSessionInput({ checkout: sampleCheckoutInput() }));
    const before = k.store.snapshot();
    k.folder.remove(PATH);
    k.transcripts.remove(PATH);
    await k.add();
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ completed: 1 });
    const after = k.store.snapshot();
    expect(after.projects).toEqual(before.projects);
    expect(after.worktrees).toEqual(before.worktrees);
    expect(after.sessions[0]?.projectId).toEqual(before.sessions[0]?.projectId);
    expect(k.repositories.inspects()).toEqual([]);
    expect(k.transcripts.reads()).toEqual([]);
  });

  it.each(['not_repository', 'no_cwd', 'no_session'])('closes successful empty branch %s', async (branch) => {
    const k = await kit(branch === 'no_cwd' ? memoryTranscript.replaceAll('"cwd":"/demo/repo"', '"cwd":null') : memoryTranscript);
    if (branch !== 'no_session') await k.store.ensureSession(sampleEnsureSessionInput());
    if (branch === 'not_repository') k.repositories.set(CWD, { kind: 'not_repository' });
    const added = await k.add();
    if (!added.ok) throw new Error(added.message);
    expect(await sessionIdentityHandler(k.deps)(added.item)).toEqual({ ok: true });
    expect(k.store.snapshot().sessions[0]?.projectId ?? null).toBeNull();
  });


  it('transcript에 cwd가 없으면 저장된 근거 폴더를 유지한다', async () => {
    const k = await kit(memoryTranscript.replaceAll('"cwd":"/demo/repo"', '"cwd":null'));
    await k.store.ensureSession(sampleEnsureSessionInput({ firstCwd: CWD }));
    k.repositories.set(CWD, checkout);
    const added = await k.add();
    if (!added.ok) throw new Error(added.message);
    expect(await sessionIdentityHandler(k.deps)(added.item)).toEqual({ ok: true });
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: CWD, tagSource: 'cwd' });
  });

  it('transcript가 지워져도 저장된 첫 cwd로 판단한다', async () => {
    const k = await kit();
    await k.store.ensureSession(sampleEnsureSessionInput({ firstCwd: CWD }));
    await k.add();
    k.folder.remove(PATH);
    k.repositories.set(CWD, checkout);
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ completed: 1 });
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: CWD, tagSource: 'cwd' });
  });

  it('재판단이 비움으로 끝나도 근거를 보존하고 닫힌 일감을 다시 만들지 않는다', async () => {
    const k = await kit();
    await k.store.ensureSession(sampleEnsureSessionInput());
    k.repositories.set(CWD, { kind: 'not_repository' });
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ completed: 2 });
    expect(k.store.snapshot().sessions[0]).toMatchObject({ firstCwd: CWD, tagSource: null });
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ claimed: 0 });
    expect(k.store.snapshot().workItems.filter((item) => item.kind === 'session_identity')).toHaveLength(1);
  });

  it('근거 없이 영구 실패한 재판단도 다시 열지 않는다', async () => {
    const k = await kit();
    await k.store.ensureSession(sampleEnsureSessionInput());
    k.folder.remove(PATH);
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ failed: 1 });
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ claimed: 0 });
    expect(k.store.snapshot().workItems).toHaveLength(1);
  });

  it('records unreadable transcripts permanently on the first attempt', async () => {
    const k = await kit();
    await k.store.ensureSession(sampleEnsureSessionInput());
    await k.add();
    k.folder.remove(PATH);
    expect(await k.brain.queue.drain({ budgetMs: 100 })).toMatchObject({ failed: 1, retried: 0 });
    expect(k.store.snapshot().failures).toMatchObject([{
      stage: 'session_identity', code: 'TRANSCRIPT_UNREADABLE', harness: 'demo', sessionId: sampleEnsureSessionInput().id,
    }]);
  });

  it('retries unknown answers nine times then records a failure; retry keeps the identity kind', async () => {
    const k = await kit();
    await k.brain.sessions.ingest({ session: sampleSessionToken, transcriptPath: PATH });
    for (let attempt = 1; attempt <= 10; attempt++) {
      const result = await k.brain.queue.drain({ budgetMs: 100 });
      expect(result).toMatchObject(attempt < 10 ? { retried: 1, failed: 0 } : { failed: 1, retried: 0 });
      k.advance();
    }
    expect(k.store.snapshot().failures).toMatchObject([{ stage: 'session_identity', code: REPOSITORY_UNANSWERED }]);
    expect(await retryFailures(k.deps)).toMatchObject({ ok: true, added: 1 });
    expect(k.store.snapshot().workItems.at(-1)).toMatchObject({ kind: 'session_identity', completedAt: null });
    k.repositories.set(CWD, checkout);
    await k.brain.queue.drain({ budgetMs: 100 });
    expect(k.store.snapshot().failures[0]?.resolvedAt).not.toBeNull();
  });

  it('propagates read and fill failures and missing parsers as values', async () => {
    const k = await kit();
    await k.store.ensureSession(sampleEnsureSessionInput());
    const added = await k.add();
    if (!added.ok) throw new Error(added.message);
    const unavailable = { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '데이터베이스를 읽을 수 없습니다' };
    expect(await sessionIdentityHandler({ ...k.deps, store: { ...k.deps.store, findSession: async () => unavailable } })(added.item)).toMatchObject(unavailable);
    expect(await sessionIdentityHandler({ ...k.deps, parsers: [] })(added.item)).toMatchObject({ ok: false, code: 'USAGE' });
    k.repositories.set(CWD, checkout);
    expect(await sessionIdentityHandler({ ...k.deps, store: { ...k.deps.store, fillSessionTags: async () => unavailable } })(added.item)).toMatchObject(unavailable);
  });
});
