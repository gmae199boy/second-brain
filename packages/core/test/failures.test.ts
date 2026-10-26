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

  it('파일의 상태를 읽을 수 없으면 그 코드로 멈춘다', async () => {
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
        return { ok: false, code: 'DB_UNAVAILABLE', message: '파일을 열 수 없습니다' };
      },
    };

    expect(await retryFailures(retryDependencies(unreadable))).toMatchObject({
      ok: false,
      code: 'DB_UNAVAILABLE',
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
