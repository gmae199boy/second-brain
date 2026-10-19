import { describe, expect, it } from 'vitest';
import { failureFingerprint } from '../src/domain/failure.js';
import { DRAIN_BUDGET_MS, MAX_WORK_ATTEMPTS } from '../src/domain/work-item.js';
import type { Clock } from '../src/ports/clock.js';
import type { WorkItem } from '../src/domain/work-item.js';
import type { ClaimWorkInput, WorkStore } from '../src/ports/store.js';
import {
  drainQueue,
  type DrainQueueReport,
  type WorkHandler,
} from '../src/queue/drain.js';
import {
  memorySpool,
  memoryStore,
  sampleWorkInput,
  sequenceIdGen,
  type MemorySpool,
  type MemoryStore,
} from '../src/testing/index.js';

/**
 * The drain loop against the memory store, a memory spool and a clock the test
 * moves by hand: every row of the I/O matrix that is about the loop rather than
 * about one adapter (AD-7, AD-21).
 *
 * Nothing in here is a real kind of work. `demo_work` is the fixture's neutral
 * kind, and the handlers are written per case — which is the point: this build
 * ships no handlers at all, so the loop has to be checked on handlers that are
 * only ever handed in (Boundaries).
 */

const START = new Date('2026-02-03T04:05:06.000Z');
const KIND = 'demo_work';

/** A clock the test moves, so a retry schedule can be walked attempt by attempt. */
function movableClock(start: Date): Clock & { advance(ms: number): void; at(): Date } {
  let time = start.getTime();
  return {
    now: () => new Date(time),
    advance(ms: number): void {
      time += ms;
    },
    at: () => new Date(time),
  };
}

interface Harness {
  store: MemoryStore;
  spool: MemorySpool;
  clock: Clock & { advance(ms: number): void; at(): Date };
  drain(handler: WorkHandler, budgetMs?: number): Promise<DrainQueueReport>;
}

/** One brain's worth of queue, with one item of `demo_work` already on it. */
async function withItem(options: { spoolFails?: boolean } = {}): Promise<Harness> {
  const store = memoryStore();
  const spool = memorySpool(
    options.spoolFails === true ? { appendFailure: 'this spool is full' } : {},
  );
  const clock = movableClock(START);
  const added = await store.addWork(
    sampleWorkInput({ kind: KIND, createdAt: START, nextAttemptAt: START }),
  );
  expect(added.ok).toBe(true);

  let run = 0;
  return {
    store,
    spool,
    clock,
    drain: (handler, budgetMs = DRAIN_BUDGET_MS.command) =>
      drainQueue(
        {
          store,
          spool,
          clock,
          // A fresh generator per run, so the `claimedBy` of two runs differ.
          idGen: sequenceIdGen({ timestampMs: START.getTime(), start: (run += 1) * 100 }),
        },
        { budgetMs, handlers: { [KIND]: handler } },
      ),
  };
}

/** The one item on the queue, as the store holds it. */
function stored(store: MemoryStore): WorkItem {
  const item = store.snapshot().workItems[0];
  if (item === undefined) throw new Error('the queue is empty');
  return item;
}

describe('an item that fails with an error nobody classified', () => {
  it('backs off exponentially and is recorded on the tenth attempt', async () => {
    const { store, clock, drain } = await withItem();
    const failing: WorkHandler = async () => ({
      ok: false,
      code: 'DEMO_FAILED',
      message: 'nope',
    });

    // The first nine attempts are retries, at 1s, 2s, 4s … (AD-21).
    const waits: number[] = [];
    for (let attempt = 1; attempt < MAX_WORK_ATTEMPTS; attempt += 1) {
      const report = await drain(failing);
      expect(report, `attempt ${String(attempt)}`).toMatchObject({
        claimed: 1,
        retried: 1,
        failed: 0,
        stopped: 'empty',
      });
      const item = stored(store);
      expect(item.attempts).toBe(attempt);
      expect(item.completedAt).toBe(null);
      waits.push(item.nextAttemptAt.getTime() - clock.at().getTime());
      // The schedule is what makes the item unavailable, so the test's clock is
      // what makes the next attempt happen at all.
      clock.advance(item.nextAttemptAt.getTime() - clock.at().getTime());
    }
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000]);

    // The tenth is the record, and it closes the item (AD-21).
    const last = await drain(failing);
    expect(last).toMatchObject({ claimed: 1, retried: 0, failed: 1, stopped: 'empty' });
    expect(stored(store).attempts).toBe(MAX_WORK_ATTEMPTS);
    expect(stored(store).completedAt).not.toBe(null);

    const failures = store.snapshot().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      targetKind: 'session',
      stage: KIND,
      code: 'DEMO_FAILED',
      message: 'nope',
      // Drain knows which item failed, not which conversation it was about.
      harness: null,
      sessionId: null,
      resolvedAt: null,
    });
    expect(failures[0]?.fingerprint).toBe(
      failureFingerprint({
        stage: KIND,
        input: `session:${stored(store).targetId}`,
        code: 'DEMO_FAILED',
      }),
    );

    // The same work asked for again is a new row: the completed one is out of
    // the open key (AD-21).
    const again = await store.addWork(
      sampleWorkInput({
        kind: KIND,
        id: '01940000-0000-7000-8000-0000000000ff',
        createdAt: clock.at(),
        nextAttemptAt: clock.at(),
      }),
    );
    expect(again).toMatchObject({ ok: true, created: true });
  });

  it('treats a handler that threw the same way, and does not die with it', async () => {
    const { store, drain } = await withItem();

    const report = await drain(async () => {
      throw new Error('the handler blew up\nand said more');
    });

    expect(report).toMatchObject({ claimed: 1, retried: 1, failed: 0, stopped: 'empty' });
    // One line of it, under the Core code that is deliberately not in the code
    // table, and the item is still open for another attempt.
    expect(stored(store).lastError).toBe('the handler blew up');
    expect(stored(store).completedAt).toBe(null);
  });
});

describe('an item that fails permanently', () => {
  it('is recorded on the first failure, whoever said it was permanent', async () => {
    for (const outcome of [
      // The code table's answer: `USAGE` is `retryable: false`.
      { ok: false as const, code: 'USAGE', message: '잘못된 인자' },
      // And the handler's own, which wins over the table.
      { ok: false as const, code: 'DEMO_FAILED', message: '형식이 깨졌습니다', retryable: false },
    ]) {
      const { store, drain } = await withItem();

      const report = await drain(async () => outcome);

      expect(report, outcome.code).toMatchObject({
        claimed: 1,
        retried: 0,
        failed: 1,
        stopped: 'empty',
      });
      expect(stored(store).attempts).toBe(1);
      expect(stored(store).completedAt).not.toBe(null);
      expect(store.snapshot().failures).toHaveLength(1);
    }
  });

  it('records the information columns a handler gave, and null for the ones it did not', async () => {
    // `harness` and `session_id` are information and both nullable: the drain
    // knows which item failed, not which conversation it was about, so they
    // come from the handler (Table Contract).
    const withBoth = await withItem();
    await withBoth.drain(async () => ({
      ok: false,
      code: 'DEMO_FAILED',
      message: '형식이 깨졌습니다',
      retryable: false,
      harness: 'demo',
      sessionId: '01940000-0000-7000-8000-00000000aaaa',
    }));
    expect(withBoth.store.snapshot().failures[0]).toMatchObject({
      harness: 'demo',
      sessionId: '01940000-0000-7000-8000-00000000aaaa',
    });

    const withNeither = await withItem();
    await withNeither.drain(async () => ({
      ok: false,
      code: 'DEMO_FAILED',
      message: '형식이 깨졌습니다',
      retryable: false,
    }));
    expect(withNeither.store.snapshot().failures[0]).toMatchObject({
      harness: null,
      sessionId: null,
    });
  });
});

describe('an item that failed on somebody else’s hiccup', () => {
  it('waits until the instant the handler named', async () => {
    const { store, clock, drain } = await withItem();
    const retryAfter = new Date(START.getTime() + 90_000);

    const report = await drain(async () => ({
      ok: false,
      code: 'DEMO_BUSY',
      message: '429',
      retryable: true,
      retryAfter,
    }));

    expect(report).toMatchObject({ claimed: 1, retried: 1, stopped: 'empty' });
    expect(stored(store).nextAttemptAt.getTime()).toBe(retryAfter.getTime());

    // Not a moment before: the claim query is what enforces it.
    clock.advance(89_000);
    expect(await drain(async () => ({ ok: true }))).toMatchObject({
      claimed: 0,
      stopped: 'empty',
    });
    clock.advance(1_000);
    expect(await drain(async () => ({ ok: true }))).toMatchObject({
      claimed: 1,
      completed: 1,
      stopped: 'empty',
    });
  });

  it('waits the long interval when the handler named no instant', async () => {
    const { store, clock, drain } = await withItem();

    await drain(async () => ({ ok: false, code: 'DEMO_BUSY', message: '503', retryable: true }));

    // Fifteen minutes, the default policy's long wait (AD-21) — not the one
    // second an unclassified first failure would have got.
    expect(stored(store).nextAttemptAt.getTime() - clock.at().getTime()).toBe(900_000);
  });
});

describe('a claim that was lost', () => {
  it('changes nothing, and the attempt count follows the live claim only', async () => {
    const { store, clock, drain } = await withItem();

    // The claim expires while the handler is working, and another worker takes
    // the row: the first worker's answer must not land (Design Notes).
    const report = await drain(async (item) => {
      clock.advance(700_000);
      const stolen = await store.claimWork({
        now: clock.at(),
        claimedBy: 'other-drain',
        kinds: [item.kind],
      });
      expect(stolen).toMatchObject({ ok: true });
      return { ok: true };
    });

    // `budget`, because the handler moved the clock well past it: what this
    // case is about is the `lost` beside it.
    expect(report).toMatchObject({ claimed: 1, completed: 0, lost: 1, stopped: 'budget' });
    const item = stored(store);
    // Two claims, two attempts, and the row is still open and still held by the
    // worker that took it over.
    expect(item.attempts).toBe(2);
    expect(item.completedAt).toBe(null);
    expect(item.claimedBy).toBe('other-drain');
  });

  it('writes no failure row when the record would have closed a lost claim', async () => {
    const { store, clock, drain } = await withItem();

    const report = await drain(async (item) => {
      clock.advance(700_000);
      await store.claimWork({ now: clock.at(), claimedBy: 'other-drain', kinds: [item.kind] });
      // Permanent, so the verdict is `record` on the first failure.
      return { ok: false, code: 'USAGE', message: '잘못된 인자' };
    });

    expect(report).toMatchObject({ claimed: 1, failed: 0, lost: 1, stopped: 'budget' });
    expect(store.snapshot().failures).toEqual([]);
    expect(stored(store).completedAt).toBe(null);
  });
});

describe('a database that will not take a write', () => {
  it('hands the item back, undoes the attempt, and stops the run', async () => {
    const { store, drain } = await withItem();

    const report = await drain(async () => ({
      ok: false,
      code: 'DB_LOCKED',
      message: '쓰기 잠금을 얻지 못했습니다',
    }));

    expect(report).toMatchObject({
      claimed: 1,
      released: 1,
      failed: 0,
      stopped: 'unwritable',
      code: 'DB_LOCKED',
    });
    const item = stored(store);
    // Nothing was tried, so nothing was attempted (AD-21), and no failure row.
    expect(item.attempts).toBe(0);
    expect(item.claimedBy).toBe(null);
    expect(item.completedAt).toBe(null);
    expect(store.snapshot().failures).toEqual([]);
  });

  it('spools the failure record the database refused, and stops', async () => {
    const { store, spool, drain } = await withItem();
    // The record itself is what cannot be written, so the store answers the
    // record verb and nothing else with a lock.
    const locked: WorkStore = {
      ...store,
      async recordFailure() {
        return { ok: false, code: 'DB_LOCKED', message: '실패를 기록할 수 없습니다' };
      },
    };
    const clock = movableClock(START);

    const report = await drainQueue(
      { store: locked, spool, clock, idGen: sequenceIdGen({ timestampMs: START.getTime() }) },
      {
        budgetMs: DRAIN_BUDGET_MS.command,
        handlers: { [KIND]: async () => ({ ok: false, code: 'USAGE', message: '잘못된 인자' }) },
      },
    );

    expect(report).toMatchObject({
      claimed: 1,
      failed: 0,
      spooled: 1,
      stopped: 'unwritable',
      code: 'DB_LOCKED',
    });
    const records = spool.records();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'failure',
      payload: {
        targetKind: 'session',
        stage: KIND,
        code: 'USAGE',
        message: '잘못된 인자',
        workItemId: stored(store).id,
      },
    });
    // The record and the close are one transaction, and it did not happen: the
    // item is still open, so a later drain meets it again.
    expect(stored(store).completedAt).toBe(null);
  });

  it('stops under the same code when the spool cannot take it either', async () => {
    const { store, spool, drain: _unused } = await withItem({ spoolFails: true });
    const locked: WorkStore = {
      ...store,
      async recordFailure() {
        return { ok: false, code: 'DB_UNAVAILABLE', message: '데이터베이스에 닿지 못했습니다' };
      },
    };

    const report = await drainQueue(
      {
        store: locked,
        spool,
        clock: movableClock(START),
        idGen: sequenceIdGen({ timestampMs: START.getTime() }),
      },
      {
        budgetMs: DRAIN_BUDGET_MS.command,
        handlers: { [KIND]: async () => ({ ok: false, code: 'USAGE', message: '잘못된 인자' }) },
      },
    );

    expect(report).toMatchObject({ spooled: 0, stopped: 'unwritable', code: 'DB_UNAVAILABLE' });
  });
});

describe('the budget of one run', () => {
  it('finishes the item in hand and claims no more', async () => {
    const store = memoryStore();
    const clock = movableClock(START);
    for (const ordinal of [1, 2, 3]) {
      const added = await store.addWork(
        sampleWorkInput({
          kind: KIND,
          id: `01940000-0000-7000-8000-00000000002${String(ordinal)}`,
          targetId: `demo:session-000${String(ordinal)}`,
          createdAt: START,
          nextAttemptAt: START,
        }),
      );
      expect(added.ok).toBe(true);
    }

    const handled: string[] = [];
    const report = await drainQueue(
      {
        store,
        spool: memorySpool(),
        clock,
        idGen: sequenceIdGen({ timestampMs: START.getTime() }),
      },
      {
        budgetMs: DRAIN_BUDGET_MS.opportunistic,
        handlers: {
          [KIND]: async (item) => {
            handled.push(item.id);
            // Past the budget, inside the handler: the item in hand is never
            // interrupted, and the next claim is what notices (Boundaries).
            clock.advance(DRAIN_BUDGET_MS.opportunistic + 1);
            return { ok: true };
          },
        },
      },
    );

    expect(report).toMatchObject({ claimed: 1, completed: 1, stopped: 'budget' });
    expect(handled).toHaveLength(1);
    expect(store.snapshot().workItems.filter((item) => item.completedAt !== null)).toHaveLength(1);
  });

  it('claims nothing at all when the budget was gone before the first claim', async () => {
    const { store, spool, clock } = await withItem();
    const calls: ClaimWorkInput[] = [];
    const watched: WorkStore = {
      ...store,
      async claimWork(query) {
        calls.push(query);
        return store.claimWork(query);
      },
    };

    const report = await drainQueue(
      { store: watched, spool, clock, idGen: sequenceIdGen({ timestampMs: START.getTime() }) },
      { budgetMs: 0, handlers: { [KIND]: async () => ({ ok: true }) } },
    );

    expect(report).toMatchObject({ claimed: 0, stopped: 'budget' });
    expect(calls).toEqual([]);
  });
});

describe('a queue with nothing to do', () => {
  it('never takes the write lock', async () => {
    const store = memoryStore();
    const calls: ClaimWorkInput[] = [];
    const watched: WorkStore = {
      ...store,
      async claimWork(query) {
        calls.push(query);
        return store.claimWork(query);
      },
    };

    const report = await drainQueue(
      {
        store: watched,
        spool: memorySpool(),
        clock: movableClock(START),
        idGen: sequenceIdGen({ timestampMs: START.getTime() }),
      },
      { budgetMs: DRAIN_BUDGET_MS.command, handlers: { [KIND]: async () => ({ ok: true }) } },
    );

    expect(report).toMatchObject({ claimed: 0, stopped: 'empty' });
    // The whole point of `hasDueWork`: a drain with nothing to do must not
    // queue behind whatever is writing (AD-7).
    expect(calls).toEqual([]);
  });

  it('claims nothing when the only item is of a kind nobody handles', async () => {
    const store = memoryStore();
    expect(
      await store.addWork(
        sampleWorkInput({ kind: 'unknown_work', createdAt: START, nextAttemptAt: START }),
      ),
    ).toMatchObject({ ok: true });

    const report = await drainQueue(
      {
        store,
        spool: memorySpool(),
        clock: movableClock(START),
        idGen: sequenceIdGen({ timestampMs: START.getTime() }),
      },
      { budgetMs: DRAIN_BUDGET_MS.command, handlers: { [KIND]: async () => ({ ok: true }) } },
    );

    expect(report).toMatchObject({ claimed: 0, stopped: 'empty' });
    // Untouched: an old build must not close a new build's work (Decision 4).
    expect(stored(store)).toMatchObject({ attempts: 0, completedAt: null, claimedBy: null });
  });

  it('stops as unwritable when even the lock-free read fails', async () => {
    const store = memoryStore();
    const unreachable: WorkStore = {
      ...store,
      async hasDueWork() {
        return { ok: false, code: 'DB_UNAVAILABLE', message: '데이터베이스에 닿지 못했습니다' };
      },
    };

    const report = await drainQueue(
      {
        store: unreachable,
        spool: memorySpool(),
        clock: movableClock(START),
        idGen: sequenceIdGen({ timestampMs: START.getTime() }),
      },
      { budgetMs: DRAIN_BUDGET_MS.command, handlers: { [KIND]: async () => ({ ok: true }) } },
    );

    expect(report).toMatchObject({ claimed: 0, stopped: 'unwritable', code: 'DB_UNAVAILABLE' });
  });
});

describe('the drain budgets', () => {
  it('is thirty seconds for a command and two for an opportunistic run', () => {
    // The numbers live in Core, so the CLI and the dispatcher read the same two
    // rather than each carrying one (AD-7).
    expect(DRAIN_BUDGET_MS).toEqual({ command: 30_000, opportunistic: 2_000 });
  });
});
