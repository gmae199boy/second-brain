import { describe, expect, it } from 'vitest';
import { SESSION_INGEST_KIND } from '../src/capture/session-ingest-work.js';
import { FAILURES_LIST_LIMIT, listFailures } from '../src/failures/list.js';
import { retryFailures } from '../src/failures/retry.js';
import { DOCUMENT_EXTRACT_KIND } from '../src/files/extract-work.js';
import type {
  ReadFileExtractionStateResult,
  RecordFailureInput,
} from '../src/ports/store.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';

/**
 * `failures.list` and `failures.retry`: the record is read and never written by
 * the first, and the second writes to the queue and never to the record (AD-21).
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');

/** One recorded failure, as any path records it. */
function failure(overrides: Partial<RecordFailureInput> = {}): RecordFailureInput {
  return {
    id: '01940000-0000-7000-8000-0000000000d1',
    targetKind: 'session',
    targetId: 'demo:session-0001',
    stage: SESSION_INGEST_KIND,
    fingerprint: 'sha256:one',
    harness: 'demo',
    sessionId: null,
    code: 'TRANSCRIPT_UNREADABLE',
    message: '읽을 수 없습니다',
    occurredAt: NOW,
    ...overrides,
  };
}

/** A store holding these failures, recorded in the order given. */
async function holding(...inputs: readonly RecordFailureInput[]): Promise<MemoryStore> {
  const store = memoryStore();
  for (const input of inputs) {
    expect(await store.recordFailure(input)).toMatchObject({ ok: true });
  }
  return store;
}

/**
 * One file's extraction state, with only the two columns a retry asks about
 * worth setting.
 *
 * Everything else is filler: `retryFailures` reads `redactedAt` and
 * `sourceUnreachableAt` and nothing else, and a case that built a real file row
 * for each of them would be proving something about the ingest.
 */
function extractionState(
  fileId: string,
  marks: { redactedAt?: Date; sourceUnreachableAt?: Date },
): ReadFileExtractionStateResult {
  return {
    ok: true,
    fileId,
    contentHash: 'sha256:demo',
    sizeBytes: 3,
    home: { storeKind: 'local', ownership: 'brain', locator: 'files/demo' },
    redactedAt: marks.redactedAt ?? null,
    sourceUnreachableAt: marks.sourceUnreachableAt ?? null,
    currentExtractionId: null,
    openExtraction: null,
    lastAttempt: 1,
  };
}

function retryDependencies(store: MemoryStore): {
  store: MemoryStore;
  clock: ReturnType<typeof fixedClock>;
  idGen: ReturnType<typeof sequenceIdGen>;
} {
  return {
    store,
    clock: fixedClock(NOW),
    idGen: sequenceIdGen({ timestampMs: NOW.getTime() }),
  };
}

describe('failures.list', () => {
  it('answers the unresolved rows, newest first, with a count', async () => {
    const store = await holding(
      failure(),
      failure({
        id: '01940000-0000-7000-8000-0000000000d2',
        fingerprint: 'sha256:two',
        occurredAt: new Date('2026-03-04T06:06:07.000Z'),
      }),
    );

    const result = await listFailures({ store });

    expect(result).toMatchObject({ ok: true, count: 2, hasMore: false });
    if (!result.ok) return;
    expect(result.failures.map((row) => row.fingerprint)).toEqual([
      'sha256:two',
      'sha256:one',
    ]);
  });

  it('leaves out what somebody has already fixed, unless asked', async () => {
    const store = await holding(failure());
    expect(
      await store.resolveFailures({
        targetKind: 'session',
        targetId: 'demo:session-0001',
        stage: SESSION_INGEST_KIND,
        now: NOW,
      }),
    ).toMatchObject({ ok: true });

    expect(await listFailures({ store })).toMatchObject({ ok: true, count: 0 });
    expect(await listFailures({ store }, { all: true })).toMatchObject({ ok: true, count: 1 });
  });

  it('narrows to one kind of target', async () => {
    const store = await holding(
      failure(),
      failure({
        id: '01940000-0000-7000-8000-0000000000d3',
        targetKind: 'file',
        targetId: 'sha256:demo',
        fingerprint: 'sha256:three',
      }),
    );

    const result = await listFailures({ store }, { targetKind: 'file' });

    expect(result).toMatchObject({ ok: true, count: 1 });
    if (!result.ok) return;
    expect(result.failures[0]?.targetKind).toBe('file');
  });

  it('says there is more rather than how much more', async () => {
    // Decided by asking for one row more than the page and dropping it, which
    // is the convention of every paged read here (Conventions, AD-15).
    const store = await holding(
      failure(),
      failure({ id: '01940000-0000-7000-8000-0000000000d4', fingerprint: 'sha256:two' }),
    );

    const result = await listFailures({ store }, { limit: 1 });

    expect(result).toMatchObject({ ok: true, count: 1, hasMore: true });
  });

  it.each([[0], [FAILURES_LIST_LIMIT.max + 1], [1.5]])(
    'refuses a limit of %s as a USAGE',
    async (limit) => {
      const store = await holding(failure());

      expect(await listFailures({ store }, { limit })).toMatchObject({
        ok: false,
        code: 'USAGE',
      });
    },
  );

  it('passes a database that could not be read straight back', async () => {
    const store = memoryStore();
    const unavailable: MemoryStore = {
      ...store,
      async listFailures() {
        return { ok: false, code: 'DB_UNAVAILABLE', message: '파일이 없습니다' };
      },
    };

    expect(await listFailures({ store: unavailable })).toMatchObject({
      ok: false,
      code: 'DB_UNAVAILABLE',
    });
  });
});

describe('failures.retry', () => {
  it('queues one item per target, due at once', async () => {
    const store = await holding(failure());

    const result = await retryFailures(retryDependencies(store));

    expect(result).toMatchObject({ ok: true, added: 1, alreadyOpen: 0, skipped: [] });
    const items = store.snapshot().workItems;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: SESSION_INGEST_KIND,
      targetKind: 'session',
      targetId: 'demo:session-0001',
    });
    expect(items[0]?.nextAttemptAt.getTime()).toBe(NOW.getTime());
  });

  it('asks once for a target that failed at more than one stage', async () => {
    // A session that failed three ways is one session to collect again, and the
    // open-row key would have collapsed the duplicates anyway — at the cost of
    // a write lock per duplicate (AD-21).
    const store = await holding(
      failure(),
      failure({
        id: '01940000-0000-7000-8000-0000000000d5',
        stage: 'other_work',
        fingerprint: 'sha256:two',
      }),
    );

    const result = await retryFailures(retryDependencies(store));

    expect(result).toMatchObject({ ok: true, added: 1 });
    expect(store.snapshot().workItems).toHaveLength(1);
  });

  it('counts a target that already had an open item apart', async () => {
    const store = await holding(failure());
    expect(
      await store.addWork({
        id: '01940000-0000-7000-8000-0000000000d6',
        kind: SESSION_INGEST_KIND,
        targetKind: 'session',
        targetId: 'demo:session-0001',
        createdAt: NOW,
        nextAttemptAt: NOW,
      }),
    ).toMatchObject({ ok: true });

    expect(await retryFailures(retryDependencies(store))).toMatchObject({
      ok: true,
      added: 0,
      alreadyOpen: 1,
    });
  });

  it('skips a kind of target nothing in this build can retry, and says how many', async () => {
    // `message` rather than `session` or `file`: those two have a kind of work
    // each, and this case is about the one thing the table cannot answer.
    const store = await holding(
      failure({
        id: '01940000-0000-7000-8000-0000000000d7',
        targetKind: 'message',
        stage: 'unknown_stage',
        targetId: 'message-one',
        fingerprint: 'sha256:three',
      }),
      failure({
        id: '01940000-0000-7000-8000-0000000000d8',
        targetKind: 'message',
        stage: 'unknown_stage',
        targetId: 'message-two',
        fingerprint: 'sha256:four',
      }),
    );

    const result = await retryFailures(retryDependencies(store));

    expect(result).toMatchObject({
      ok: true,
      added: 0,
      skipped: [{ targetKind: 'message', count: 2 }],
    });
    expect(store.snapshot().workItems).toEqual([]);
  });

  it('asks for a file whose extraction failed to be read again', async () => {
    const store = await holding(
      failure({
        id: '01940000-0000-7000-8000-0000000000d9',
        targetKind: 'file',
        stage: DOCUMENT_EXTRACT_KIND,
        targetId: '01940000-0000-7000-8000-00000000f001',
        fingerprint: 'sha256:five',
      }),
    );

    // The store has no row for this file, so the state read says
    // `FILE_NOT_FOUND` — and that is queued exactly as before: the handler
    // closes work about something that no longer exists as done.
    expect(await retryFailures(retryDependencies(store))).toMatchObject({
      ok: true,
      added: 1,
      skipped: [],
      redacted: 0,
      sourceUnreachable: 0,
    });
    expect(store.snapshot().workItems[0]).toMatchObject({
      kind: DOCUMENT_EXTRACT_KIND,
      targetKind: 'file',
      targetId: '01940000-0000-7000-8000-00000000f001',
    });
  });

  it.each(['toString', '__proto__'])('treats prototype property %s as an unknown stage', async (stage) => {
    const store = await holding(failure({ stage }));
    expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, added: 1 });
    expect(store.snapshot().workItems[0]?.kind).toBe('session_ingest');
  });

  it('queues distinct stages for one target while deduplicating each kind', async () => {
    const store = await holding(
      failure(),
      failure({ id: '01940000-0000-7000-8000-000000000891', stage: 'session_identity', fingerprint: 'sha256:identity' }),
      failure({ id: '01940000-0000-7000-8000-000000000892', stage: 'session_identity', fingerprint: 'sha256:identity-other' }),
    );
    expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, added: 2 });
    expect(store.snapshot().workItems.map((item) => item.kind).sort()).toEqual(['session_identity', 'session_ingest']);
  });

  it('leaves the failure rows exactly as they were', async () => {
    // The row is a record: what marks one resolved is the work going through,
    // not the asking (`resolveFailures`).
    const store = await holding(failure());

    expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true });

    const read = await store.listFailures({ includeResolved: true });
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;
    expect(read.failures[0]).toMatchObject({ resolvedAt: null, code: 'TRANSCRIPT_UNREADABLE' });
  });

  it('narrows to one kind of target when asked', async () => {
    const store = await holding(
      failure(),
      failure({
        id: '01940000-0000-7000-8000-0000000000d9',
        targetKind: 'file',
        targetId: 'sha256:demo',
        fingerprint: 'sha256:five',
      }),
    );

    const result = await retryFailures(retryDependencies(store), { targetKind: 'session' });

    expect(result).toMatchObject({ ok: true, added: 1, skipped: [] });
  });

  it('가려서·원본에 닿을 수 없어 다시 읽을 수 없는 파일은 세고 넣지 않는다', async () => {
    const store = await holding(
      failure({
        id: '01940000-0000-7000-8000-0000000000e1',
        targetKind: 'file',
        stage: DOCUMENT_EXTRACT_KIND,
        targetId: 'file-redacted',
        fingerprint: 'sha256:six',
      }),
      failure({
        id: '01940000-0000-7000-8000-0000000000e2',
        targetKind: 'file',
        stage: DOCUMENT_EXTRACT_KIND,
        targetId: 'file-unreachable',
        fingerprint: 'sha256:seven',
      }),
      failure({
        id: '01940000-0000-7000-8000-0000000000e3',
        targetKind: 'file',
        stage: DOCUMENT_EXTRACT_KIND,
        targetId: 'file-readable',
        fingerprint: 'sha256:eight',
      }),
    );
    // The three states are answered here rather than built: the fake has no
    // file redaction at all, and what this case is about is the one read this
    // verb makes before it queues anything (port contract).
    const states: MemoryStore = {
      ...store,
      async readFileExtractionState(fileId) {
        return extractionState(fileId, {
          ...(fileId === 'file-redacted' ? { redactedAt: NOW } : {}),
          ...(fileId === 'file-unreachable' ? { sourceUnreachableAt: NOW } : {}),
        });
      },
    };

    const result = await retryFailures(retryDependencies(states));

    expect(result).toMatchObject({
      ok: true,
      added: 1,
      alreadyOpen: 0,
      redacted: 1,
      sourceUnreachable: 1,
      skipped: [],
    });
    // Only the one that could be read got an item: the other two would have
    // been closed without doing anything, leaving the failure rows untouched.
    expect(states.snapshot().workItems.map((item) => item.targetId)).toEqual(['file-readable']);
  });

  it.each(['DB_UNAVAILABLE', 'DB_LOCKED'] as const)('파일의 상태를 읽을 수 없으면 %s로 멈춘다', async code => {
    const store = await holding(
      failure({
        id: '01940000-0000-7000-8000-0000000000e4',
        targetKind: 'file',
        stage: DOCUMENT_EXTRACT_KIND,
        targetId: 'file-unknown',
        fingerprint: 'sha256:nine',
      }),
    );
    const unreadable: MemoryStore = {
      ...store,
      async readFileExtractionState() {
        return { ok: false, code, message: '파일을 열 수 없습니다' };
      },
    };

    expect(await retryFailures(retryDependencies(unreadable))).toMatchObject({
      ok: false,
      code,
    });
    expect(unreadable.snapshot().workItems).toEqual([]);
  });

  it('stops at a database that would not take the write', async () => {
    const store = await holding(failure());
    const locked: MemoryStore = {
      ...store,
      async addWork() {
        return { ok: false, code: 'DB_LOCKED', message: '다른 연결이 쓰고 있습니다' };
      },
    };

    expect(await retryFailures(retryDependencies(locked))).toMatchObject({
      ok: false,
      code: 'DB_LOCKED',
    });
  });
});

it('retries a failed Drive recovery as Drive recovery even for a redacted file', async () => {
  const {failureFingerprint}=await import('../src/domain/failure.js');const store=memoryStore(),workId='01940000-0000-7000-8000-000000000331';
  expect(await store.addWork({id:workId,kind:'drive_migrate',targetKind:'file',targetId:'redacted-file',createdAt:NOW,nextAttemptAt:NOW})).toMatchObject({ok:true});
  expect(await store.claimWork({now:NOW,kinds:['drive_migrate'],claimedBy:'worker'})).toMatchObject({ok:true,item:{id:workId,serializationKey:null}});
  expect(await store.recordFailure(failure({targetKind:'file',targetId:'redacted-file',stage:'drive_migrate',code:'FILES_UNAVAILABLE',fingerprint:failureFingerprint({stage:'drive_migrate',input:'file:redacted-file',code:'FILES_UNAVAILABLE'}),closeWork:{id:workId,claimedBy:'worker',now:NOW}}))).toMatchObject({ok:true,outcome:'recorded'});
  expect(store.snapshot().workItems).toEqual(expect.arrayContaining([expect.objectContaining({id:workId,outcome:'failed',completedAt:NOW,serializationKey:null})]));
  expect(await retryFailures(retryDependencies(store),{targetKind:'file'})).toMatchObject({ok:true,added:1,redacted:0});
  expect(store.snapshot().workItems.filter(item=>item.completedAt===null)).toEqual([expect.objectContaining({kind:'drive_migrate',targetKind:'file',targetId:'redacted-file',serializationKey:null})]);
});

it('skips a Drive failure without an identifiable closed original',async()=>{
  const store=await holding(failure({targetKind:'file',targetId:'redacted-file',stage:'drive_migrate',code:'FILES_UNAVAILABLE',fingerprint:'drive-recovery'}));
  expect(await retryFailures(retryDependencies(store),{targetKind:'file'})).toMatchObject({ok:true,added:0,skipped:[{targetKind:'file',count:1}]});
  expect(store.snapshot().workItems).toEqual([]);
});

it('keeps core retries independent from extension retry errors and deduplicates unknown stages', async () => {
  const store = await holding(failure());
  store.retryExtensionFailure = async () => ({ ok: false, code: 'DB_LOCKED', message: 'registry locked' });
  expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, added: 1 });
  const unknown = await holding(
    failure({ targetKind: 'extension', targetId: 'default', stage: 'garmin.collect' }),
    failure({ id: '01940000-0000-7000-8000-0000000000d2', targetKind: 'extension', targetId: 'default', stage: 'garmin.collect', fingerprint: 'second' }),
  );
  let calls = 0;
  unknown.retryExtensionFailure = async () => { calls++; return { ok: true, state: 'skipped' }; };
  expect(await retryFailures(retryDependencies(unknown))).toMatchObject({ ok: true, skipped: [{ targetKind: 'extension', count: 1 }] });
  expect(calls).toBe(2);
  unknown.retryExtensionFailure = async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: 'failed' });
  expect(await retryFailures(retryDependencies(unknown))).toEqual({ ok: false, code: 'DB_UNAVAILABLE', message: 'failed' });
});

it('retries distinct registered stages for file and session targets after an unsafe candidate', async () => {
  const { failureFingerprint } = await import('../src/domain/failure.js');
  const store = memoryStore();
  await store.recordExtensionInstall({ name: 'garmin', version: '1', now: NOW, workKinds: ['garmin.collect', 'garmin.report'] });
  for (const [n, kind, targetKind] of [[1, 'garmin.collect', 'file'], [2, 'garmin.report', 'session']] as const) {
    const id = `01940000-0000-7000-8000-${String(n).padStart(12,'0')}`;
    const token = `01940000-0000-7000-8001-${String(n).padStart(12,'0')}`;
    await store.addWork({ id, kind, targetKind, targetId: 'same', createdAt: NOW, nextAttemptAt: NOW });
    await store.claimSupervisedWork({ now: NOW, kinds: [kind], claimedBy: 'worker', attemptToken: token });
    await store.finishSupervisedWork({ id, attemptToken: token, now: NOW, outcome: 'failed', errorCode: 'BAD', errorRetryable: false, failure: { id: `01940000-0000-7000-8002-${String(n).padStart(12,'0')}`, stage: kind, fingerprint: failureFingerprint({ stage: kind, input: `${targetKind}:same`, code: 'BAD' }), code: 'BAD', message: 'failed', occurredAt: NOW } });
  }
  await store.recordFailure(failure({ id: '01940000-0000-7000-8000-000000000099', targetKind: 'file', targetId: 'same', stage: 'garmin.collect', fingerprint: 'unsafe', occurredAt: new Date(NOW.getTime()+1000) }));
  expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, added: 2, skipped: [] });
  expect(store.snapshot().workItems.filter(item => item.completedAt === null).map(item => item.kind).sort()).toEqual(['garmin.collect','garmin.report']);
});

it('treats reordered nested input as equal when reusing extension work', async () => {
  const { failureFingerprint } = await import('../src/domain/failure.js');
  const store = memoryStore(), kind = 'garmin.collect', id = '01940000-0000-7000-8000-000000000201', token = '01940000-0000-7000-8000-000000000202';
  await store.recordExtensionInstall({ name: 'garmin', version: '1', now: NOW, workKinds: [kind] });
  const work = { id, kind, targetKind: 'extension', targetId: 'default', createdAt: NOW, nextAttemptAt: NOW };
  await store.enqueueExtensionWork({ name: 'garmin', version: '1', input: { a: 1, nested: { x: 1, y: 2 } }, work });
  await store.claimSupervisedWork({ now: NOW, kinds: [kind], claimedBy: 'worker', attemptToken: token });
  await store.finishSupervisedWork({ id, attemptToken: token, now: NOW, outcome: 'failed', errorCode: 'BAD', errorRetryable: false, failure: { id: '01940000-0000-7000-8000-000000000203', stage: kind, fingerprint: failureFingerprint({ stage: kind, input: 'extension:default', code: 'BAD' }), code: 'BAD', message: 'failed', occurredAt: NOW } });
  await store.enqueueExtensionWork({ name: 'garmin', version: '1', input: { nested: { y: 2, x: 1 }, a: 1 }, work: { ...work, id: '01940000-0000-7000-8000-000000000204' } });
  expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, alreadyOpen: 1, skipped: [] });
});

it('queues two extension stages once each for one target', async () => {
  const { failureFingerprint } = await import('../src/domain/failure.js');
  const store = memoryStore();
  await store.recordExtensionInstall({ name: 'garmin', version: '1', now: NOW, workKinds: ['garmin.collect','garmin.report'] });
  for (const [n, kind] of [[1,'garmin.collect'],[2,'garmin.report']] as const) {
    const id = `01940000-0000-7000-8003-${String(n).padStart(12,'0')}`, token = `01940000-0000-7000-8004-${String(n).padStart(12,'0')}`;
    await store.addWork({ id, kind, targetKind: 'extension', targetId: 'default', createdAt: NOW, nextAttemptAt: NOW });
    await store.claimSupervisedWork({ now: NOW, kinds: [kind], claimedBy: 'worker', attemptToken: token });
    await store.finishSupervisedWork({ id, attemptToken: token, now: NOW, outcome: 'failed', errorCode: 'BAD', errorRetryable: false, failure: { id: `01940000-0000-7000-8005-${String(n).padStart(12,'0')}`, stage: kind, fingerprint: failureFingerprint({ stage: kind, input: 'extension:default', code: 'BAD' }), code: 'BAD', message: 'failed', occurredAt: NOW } });
  }
  await store.recordFailure(failure({ id:'01940000-0000-7000-8005-000000000003', targetKind:'extension',targetId:'default',stage:'garmin.collect',fingerprint:'other' }));
  expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok:true,added:2,skipped:[] });
  expect(store.snapshot().workItems.filter(item => item.completedAt === null).map(item => item.kind).sort()).toEqual(['garmin.collect','garmin.report']);
});

it.each(['file', 'session'] as const)('does not route a removed extension stage for %s to legacy core work', async targetKind => {
  const { failureFingerprint } = await import('../src/domain/failure.js');
  const store = memoryStore(), kind = 'garmin.collect';
  const workId = '01940000-0000-7000-8000-000000000301', token = '01940000-0000-7000-8000-000000000302';
  await store.recordExtensionInstall({ name: 'garmin', version: '1', now: NOW, workKinds: [kind] });
  await store.addWork({ id: workId, kind, targetKind, targetId: 'synthetic', createdAt: NOW, nextAttemptAt: NOW });
  await store.claimSupervisedWork({ now: NOW, kinds: [kind], claimedBy: 'worker', attemptToken: token });
  await store.finishSupervisedWork({ id: workId, attemptToken: token, now: NOW, outcome: 'failed', errorCode: 'BAD', errorRetryable: false, failure: { id: '01940000-0000-7000-8000-000000000303', stage: kind, fingerprint: failureFingerprint({ stage: kind, input: `${targetKind}:synthetic`, code: 'BAD' }), code: 'BAD', message: 'failed', occurredAt: NOW } });
  await store.recordExtensionInstall({ name: 'garmin', version: '2', now: NOW, workKinds: [] });
  expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, added: 0, alreadyOpen: 0, skipped: [{ targetKind, count: 1 }] });
  expect(store.snapshot().workItems.filter(row => row.completedAt === null)).toEqual([]);
});

it('skips cancelling equivalent work and distinguishes missing, resolved and unregistered failures in memory', async () => {
  const { failureFingerprint } = await import('../src/domain/failure.js');
  const store = memoryStore(), kind = 'garmin.collect', workId = '01940000-0000-7000-8000-000000000311', token = '01940000-0000-7000-8000-000000000312', failureId = '01940000-0000-7000-8000-000000000313';
  const retry = (id: string) => store.retryExtensionFailure({ failureId: id, id: '01940000-0000-7000-8000-000000000319', now: NOW });
  expect(await retry('01940000-0000-7000-8000-000000000318')).toEqual({ ok: true, state: 'skipped' });
  await store.recordExtensionInstall({ name: 'garmin', version: '1', now: NOW, workKinds: [kind] });
  await store.addWork({ id: workId, kind, targetKind: 'extension', targetId: 'default', createdAt: NOW, nextAttemptAt: NOW });
  await store.claimSupervisedWork({ now: NOW, kinds: [kind], claimedBy: 'worker', attemptToken: token });
  await store.finishSupervisedWork({ id: workId, attemptToken: token, now: NOW, outcome: 'failed', errorCode: 'BAD', errorRetryable: false, failure: { id: failureId, stage: kind, fingerprint: failureFingerprint({ stage: kind, input: 'extension:default', code: 'BAD' }), code: 'BAD', message: 'failed', occurredAt: NOW } });
  expect(await retry(failureId)).toEqual({ ok: true, state: 'created' });
  await store.claimSupervisedWork({ now: NOW, kinds: [kind], claimedBy: 'worker', attemptToken: '01940000-0000-7000-8000-000000000314' });
  expect(await store.requestWorkCancel({ id: '01940000-0000-7000-8000-000000000319', now: NOW })).toMatchObject({ ok: true, state: 'requested' });
  expect(await store.retryExtensionFailure({ failureId, id: '01940000-0000-7000-8000-000000000315', now: NOW })).toEqual({ ok: true, state: 'skipped' });
  expect(await retryFailures(retryDependencies(store))).toMatchObject({ ok: true, added: 0, alreadyOpen: 0, skipped: [{ targetKind: 'extension', count: 1 }] });
  await store.recordExtensionInstall({ name: 'garmin', version: '2', now: NOW, workKinds: [] });
  expect(await retry(failureId)).toEqual({ ok: true, state: 'unregistered' });
  await store.resolveFailures({ targetKind: 'extension', targetId: 'default', stage: kind, now: NOW });
  expect(await retry(failureId)).toEqual({ ok: true, state: 'skipped' });
});
