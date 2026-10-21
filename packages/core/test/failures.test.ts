import { describe, expect, it } from 'vitest';
import { SESSION_INGEST_KIND } from '../src/capture/session-ingest-work.js';
import { FAILURES_LIST_LIMIT, listFailures } from '../src/failures/list.js';
import { retryFailures } from '../src/failures/retry.js';
import type { RecordFailureInput } from '../src/ports/store.js';
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
    const store = await holding(
      failure({
        id: '01940000-0000-7000-8000-0000000000d7',
        targetKind: 'file',
        stage: 'unknown_stage',
        targetId: 'sha256:demo',
        fingerprint: 'sha256:three',
      }),
      failure({
        id: '01940000-0000-7000-8000-0000000000d8',
        targetKind: 'file',
        stage: 'unknown_stage',
        targetId: 'sha256:other',
        fingerprint: 'sha256:four',
      }),
    );

    const result = await retryFailures(retryDependencies(store));

    expect(result).toMatchObject({
      ok: true,
      added: 0,
      skipped: [{ targetKind: 'file', count: 2 }],
    });
    expect(store.snapshot().workItems).toEqual([]);
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
