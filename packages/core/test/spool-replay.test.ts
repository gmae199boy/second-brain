import { describe, expect, it } from 'vitest';
import { MAX_WORK_ATTEMPTS } from '../src/domain/work-item.js';
import {
  decodeSpoolLine,
  encodeSpoolLine,
  type SpoolRecord,
} from '../src/domain/spool-record.js';
import {
  replaySpool,
  type ReplaySpoolDependencies,
  type SpoolReplayHandlers,
} from '../src/spool/replay.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memorySpool, type MemorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import { sampleSpoolRecord } from '../src/testing/fixtures.js';

/**
 * The replay frame against the in-memory spool: what it does with a file whose
 * records all went in, and what it does with one that did not.
 *
 * What is deliberately not in here is a `session_ingest` handler. The frame
 * does not know what a record means — that is the whole point of the handlers
 * coming from outside — so the handlers below record what they were given and
 * answer what the case needs them to.
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');

/** The ports the frame needs beside the spool and the handlers. */
function deps(
  spool: MemorySpool,
  handlers: SpoolReplayHandlers,
  store: MemoryStore = memoryStore(),
): ReplaySpoolDependencies & { store: MemoryStore } {
  return {
    spool,
    handlers,
    store,
    clock: fixedClock(NOW),
    idGen: sequenceIdGen({ timestampMs: NOW.getTime() }),
  };
}

/** A handler that takes everything, and the records it was handed. */
function accepting(): { handlers: SpoolReplayHandlers; seen: SpoolRecord[] } {
  const seen: SpoolRecord[] = [];
  return {
    seen,
    handlers: {
      session_ingest: async (record) => {
        seen.push(record);
        return { ok: true };
      },
    },
  };
}

/** A handler that takes the first `count` records and then refuses. */
function failingAfter(
  count: number,
  code?: string,
): { handlers: SpoolReplayHandlers; seen: SpoolRecord[] } {
  const seen: SpoolRecord[] = [];
  return {
    seen,
    handlers: {
      session_ingest: async (record) => {
        if (seen.length >= count) {
          return code === undefined
            ? { ok: false, message: 'the database is still unreachable' }
            : { ok: false, code, message: 'the database is still unreachable' };
        }
        seen.push(record);
        return { ok: true };
      },
    },
  };
}

/** Ids a case can tell apart. */
const IDS = [
  '01940000-0000-7000-8000-0000000000c1',
  '01940000-0000-7000-8000-0000000000c2',
  '01940000-0000-7000-8000-0000000000c3',
];

/** One file per id, so the frame has that many files to walk. */
async function withFiles(spool: MemorySpool, count: number): Promise<SpoolRecord[]> {
  const records: SpoolRecord[] = [];
  for (let index = 0; index < count; index += 1) {
    const record = sampleSpoolRecord({ id: IDS[index] });
    records.push(record);
    expect(await spool.append([record])).toMatchObject({ ok: true });
  }
  return records;
}

/** The records of every line still waiting, so a case can read their counts. */
function waiting(spool: MemorySpool): SpoolRecord[] {
  return spool
    .files()
    .flatMap((file) => file.lines)
    .flatMap((line) => {
      const decoded = decodeSpoolLine(line);
      return decoded.ok ? [decoded.record] : [];
    });
}

describe('replaySpool when every record goes back in', () => {
  it('hands each record to the handler of its kind and removes the file', async () => {
    const spool = memorySpool();
    const records = await withFiles(spool, 2);
    const { handlers, seen } = accepting();

    const report = await replaySpool(deps(spool, handlers));

    expect(report).toEqual({ completed: 2, replayed: 2, failed: 0 });
    // The records as they were written, ids and instants included: a replay
    // never makes a value of its own (AD-9).
    expect(seen).toEqual(records);
    // And nothing is waiting any more.
    expect(await spool.stats()).toMatchObject({ ok: true, records: 0, earliest: null, failed: 0 });
  });

  it('walks the files oldest first, and every line of each one in order', async () => {
    const spool = memorySpool();
    const first = sampleSpoolRecord({ id: IDS[0] });
    const second = sampleSpoolRecord({ id: IDS[1] });
    const third = sampleSpoolRecord({ id: IDS[2] });
    expect(await spool.append([first, second])).toMatchObject({ ok: true });
    expect(await spool.append([third])).toMatchObject({ ok: true });
    const { handlers, seen } = accepting();

    const report = await replaySpool(deps(spool, handlers));

    expect(report).toEqual({ completed: 2, replayed: 3, failed: 0 });
    expect(seen.map((record) => record.id)).toEqual([first.id, second.id, third.id]);
  });

  it('stops at the file budget it was given', async () => {
    const spool = memorySpool();
    await withFiles(spool, 3);
    const { handlers, seen } = accepting();

    const report = await replaySpool(deps(spool, handlers), { maxFiles: 2 });

    // No `stopped`: reaching the budget is the run finishing, not something
    // going wrong, and the rest is the next drain's.
    expect(report).toEqual({ completed: 2, replayed: 2, failed: 0 });
    expect(seen).toHaveLength(2);
    expect(await spool.stats()).toMatchObject({ records: 1 });
  });

  it('stops at the deadline it shares with the rest of the drain', async () => {
    const spool = memorySpool();
    await withFiles(spool, 2);
    const { handlers, seen } = accepting();

    const report = await replaySpool(deps(spool, handlers), {
      deadline: NOW.getTime() - 1,
    });

    expect(report).toMatchObject({ completed: 0, replayed: 0 });
    expect(report.stopped).toContain('시간 예산');
    expect(seen).toEqual([]);
  });

  it('reports an empty spool as a run with nothing to do', async () => {
    const spool = memorySpool();
    const { handlers } = accepting();

    expect(await replaySpool(deps(spool, handlers))).toEqual({
      completed: 0,
      replayed: 0,
      failed: 0,
    });
  });
});

describe('replaySpool when a record does not go back in', () => {
  it('writes the record back with its attempt raised, and stops the run', async () => {
    const spool = memorySpool();
    await withFiles(spool, 2);
    const { handlers } = failingAfter(0);

    const report = await replaySpool(deps(spool, handlers));

    expect(report.completed).toBe(0);
    expect(report.replayed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.stopped).toContain('the database is still unreachable');
    // Both records are still waiting — the one that was tried, now carrying one
    // attempt, and the file behind it, untouched.
    expect(await spool.stats()).toMatchObject({ records: 2 });
    expect(waiting(spool).map((record) => [record.id, record.attempts ?? 0])).toEqual(
      expect.arrayContaining([
        [IDS[0], 1],
        [IDS[1], 0],
      ]),
    );
  });

  it('keeps only the lines that did not go in', async () => {
    // The whole point of the rewrite: a record that landed is gone from the
    // spool, and the two that did not are the file a later drain claims.
    const spool = memorySpool();
    expect(
      await spool.append([
        sampleSpoolRecord({ id: IDS[0] }),
        sampleSpoolRecord({ id: IDS[1] }),
        sampleSpoolRecord({ id: IDS[2] }),
      ]),
    ).toMatchObject({ ok: true });
    const { handlers, seen } = failingAfter(2);

    const report = await replaySpool(deps(spool, handlers));

    expect(report.completed).toBe(0);
    expect(report.replayed).toBe(2);
    expect(report.stopped).toContain('3번째 줄');
    expect(seen).toHaveLength(2);
    expect(waiting(spool).map((record) => [record.id, record.attempts ?? 0])).toEqual([
      [IDS[2], 1],
    ]);
  });

  it('stops without walking the files behind the one that failed', async () => {
    const spool = memorySpool();
    await withFiles(spool, 3);
    let calls = 0;
    const handlers: SpoolReplayHandlers = {
      session_ingest: async () => {
        calls += 1;
        return { ok: false, message: 'still unreachable' };
      },
    };

    await replaySpool(deps(spool, handlers));

    // One call, not three: the reason the first file failed is the reason the
    // next two would, and walking them would be three attempts on one problem.
    expect(calls).toBe(1);
  });

  it('hands the whole file back untouched when the database refused a write', async () => {
    const spool = memorySpool();
    await withFiles(spool, 2);
    const { handlers } = failingAfter(0, 'DB_LOCKED');

    const report = await replaySpool(deps(spool, handlers));

    // Not an attempt: the record is fine and the database is not, so nothing
    // about the line changes and the caller is told which way (AD-21).
    expect(report.unwritable).toBe('DB_LOCKED');
    expect(waiting(spool).every((record) => (record.attempts ?? 0) === 0)).toBe(true);
    expect(await spool.stats()).toMatchObject({ records: 2 });
  });

  it('moves a line nothing can read aside rather than stopping on it for ever', async () => {
    // A line from a build this one does not know, which is the realistic shape
    // of a line a replay cannot read — along with the half-written line a
    // killed process leaves. `append` refuses to make either, so the file is
    // built by hand (Decision 5, 2026-10-19).
    const ahead = encodeSpoolLine(sampleSpoolRecord({ id: IDS[0] }));
    const fine = encodeSpoolLine(sampleSpoolRecord({ id: IDS[1] }));
    expect(ahead.ok && fine.ok).toBe(true);
    if (!ahead.ok || !fine.ok) return;
    const lines = [
      ahead.line.replace('"schema_version":1', '"schema_version":99').trimEnd(),
      fine.line.trimEnd(),
    ];
    const held = spoolHolding(lines);
    const { handlers, seen } = accepting();

    const report = await replaySpool(deps(held, handlers));

    // The readable line went in, the unreadable one was moved aside, and the
    // run did not stop on the file for ever: one broken line from a killed
    // process must not hold up every record behind it.
    expect(report.replayed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.stopped).toContain('1번째 줄');
    expect(seen.map((record) => record.id)).toEqual([IDS[1]]);
    expect(held.failedLines()).toHaveLength(1);
  });

  it('stops on a kind nobody handles, and does not delete the file', async () => {
    const spool = memorySpool();
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });

    // A build with no handler registered: the file is left alone rather than
    // dropped or aged towards `failed/`, because a record a newer build wrote
    // must survive an older build's drain (AD-21, Decision 4).
    const report = await replaySpool(deps(spool, {}));

    expect(report.completed).toBe(0);
    expect(report.stopped).toContain('session_ingest');
    expect(await spool.stats()).toMatchObject({ records: 1 });
    expect(waiting(spool).map((record) => record.attempts ?? 0)).toEqual([0]);
  });

  it('says so when the file could not even be put back', async () => {
    const spool = memorySpool({ releaseFailure: 'the spool folder went away' });
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    const { handlers } = failingAfter(0, 'DB_UNAVAILABLE');

    const report = await replaySpool(deps(spool, handlers));

    // Both halves: why it failed, and that the file is now stuck as a claim
    // somebody will have to take back by the stale rule (AD-9).
    expect(report.stopped).toContain('the database is still unreachable');
    expect(report.stopped).toContain('the spool folder went away');
  });

  it('stops when a claim itself cannot be made', async () => {
    const spool = memorySpool({ claimFailure: 'the spool folder is unreadable' });

    const report = await replaySpool(deps(spool, accepting().handlers));

    expect(report).toMatchObject({ completed: 0, replayed: 0 });
    expect(report.stopped).toContain('the spool folder is unreadable');
  });

  it('stops, rather than carrying on, when a replayed file cannot be removed', async () => {
    const spool = memorySpool({ completeFailure: 'the file is read-only' });
    await withFiles(spool, 2);
    const { handlers, seen } = accepting();

    const report = await replaySpool(deps(spool, handlers));

    // The records are in; the file is not gone. Carrying on inside this run
    // would replay the same file again, where stopping leaves it for a later
    // drain — which is harmless, because the records are idempotent (AD-8).
    expect(report.completed).toBe(0);
    expect(report.replayed).toBe(1);
    expect(report.stopped).toContain('the file is read-only');
    expect(seen).toHaveLength(1);
  });

  it('stops when the lines that are left cannot be written back', async () => {
    const spool = memorySpool({ rewriteFailure: 'the spool folder is full' });
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    const { handlers } = failingAfter(0);

    const report = await replaySpool(deps(spool, handlers));

    expect(report.stopped).toContain('the spool folder is full');
  });
});

describe('replaySpool and the ten attempts of a record', () => {
  it('records the failure and moves the line aside on the tenth', async () => {
    const spool = memorySpool();
    const store = memoryStore();
    expect(
      await spool.append([
        sampleSpoolRecord({ id: IDS[0], attempts: MAX_WORK_ATTEMPTS - 1 }),
      ]),
    ).toMatchObject({ ok: true });
    const { handlers } = failingAfter(0);

    const report = await replaySpool(deps(spool, handlers, store));

    expect(report.failed).toBe(1);
    // Nothing waiting any more, and the line kept where nobody will try it
    // again: a work log entry has no original to be read a second time, so it
    // is moved rather than deleted (AD-9).
    expect(await spool.stats()).toMatchObject({ records: 0, failed: 1 });
    expect(spool.failedLines()).toHaveLength(1);

    // And the record of it: the target is what the record was about, and the
    // stage is the record's own kind (Boundaries).
    const failures = store.snapshot().failures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      targetKind: 'session',
      stage: 'session_ingest',
      harness: 'demo',
      sessionId: null,
      resolvedAt: null,
    });
    expect(failures[0]?.occurredAt.getTime()).toBe(NOW.getTime());
  });

  it('hands the file back when the database refuses the record too', async () => {
    const spool = memorySpool();
    const store = memoryStore();
    const refusing: MemoryStore = {
      ...store,
      async recordFailure() {
        return { ok: false, code: 'DB_LOCKED', message: 'another writer holds the lock' };
      },
    };
    expect(
      await spool.append([
        sampleSpoolRecord({ id: IDS[0], attempts: MAX_WORK_ATTEMPTS - 1 }),
      ]),
    ).toMatchObject({ ok: true });
    const { handlers } = failingAfter(0);

    const report = await replaySpool(deps(spool, handlers, refusing));

    // `failures` is the only place that attempt is remembered, so the line is
    // not moved aside until the row is written: the whole file goes back
    // instead, with its attempt count as it was (NFR-2).
    expect(report.unwritable).toBe('DB_LOCKED');
    expect(report.failed).toBe(0);
    expect(spool.failedLines()).toEqual([]);
    expect(waiting(spool).map((record) => record.attempts ?? 0)).toEqual([
      MAX_WORK_ATTEMPTS - 1,
    ]);
  });
});

/** A spool whose one file holds exactly these lines, for the unreadable case. */
function spoolHolding(lines: readonly string[]): MemorySpool {
  const inner = memorySpool();
  let claimed = false;
  let held = [...lines];
  const failed: string[] = [];
  return {
    ...inner,
    async claim() {
      if (claimed) return { ok: true, claim: null };
      claimed = true;
      return { ok: true, claim: { handle: 'held.claiming', lines: [...held] } };
    },
    async release() {
      claimed = false;
      return { ok: true };
    },
    async complete() {
      held = [];
      return { ok: true };
    },
    async rewrite(_handle, input) {
      held = [...input.keep];
      failed.push(...input.failed);
      return { ok: true };
    },
    async stats() {
      return { ok: true, records: held.length, earliest: null, failed: failed.length };
    },
    failedLines: () => [...failed],
  };
}
