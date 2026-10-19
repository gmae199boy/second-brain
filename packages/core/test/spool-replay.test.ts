import { describe, expect, it } from 'vitest';
import { encodeSpoolLine, type SpoolRecord } from '../src/domain/spool-record.js';
import { replaySpool, type SpoolReplayHandlers } from '../src/spool/replay.js';
import { memorySpool, type MemorySpool } from '../src/testing/fakes/spool.js';
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
function failingAfter(count: number): { handlers: SpoolReplayHandlers; seen: SpoolRecord[] } {
  const seen: SpoolRecord[] = [];
  return {
    seen,
    handlers: {
      session_ingest: async (record) => {
        if (seen.length >= count) {
          return { ok: false, message: 'the database is still unreachable' };
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

describe('replaySpool when every record goes back in', () => {
  it('hands each record to the handler of its kind and removes the file', async () => {
    const spool = memorySpool();
    const records = await withFiles(spool, 2);
    const { handlers, seen } = accepting();

    const report = await replaySpool({ spool, handlers });

    expect(report).toEqual({ completed: 2, replayed: 2 });
    // The records as they were written, ids and instants included: a replay
    // never makes a value of its own (AD-9).
    expect(seen).toEqual(records);
    // And nothing is waiting any more.
    expect(await spool.stats()).toMatchObject({ ok: true, records: 0, earliest: null });
  });

  it('walks the files oldest first, and every line of each one in order', async () => {
    const spool = memorySpool();
    const first = sampleSpoolRecord({ id: IDS[0] });
    const second = sampleSpoolRecord({ id: IDS[1] });
    const third = sampleSpoolRecord({ id: IDS[2] });
    expect(await spool.append([first, second])).toMatchObject({ ok: true });
    expect(await spool.append([third])).toMatchObject({ ok: true });
    const { handlers, seen } = accepting();

    const report = await replaySpool({ spool, handlers });

    expect(report).toEqual({ completed: 2, replayed: 3 });
    expect(seen.map((record) => record.id)).toEqual([first.id, second.id, third.id]);
  });

  it('stops at the file budget it was given', async () => {
    const spool = memorySpool();
    await withFiles(spool, 3);
    const { handlers, seen } = accepting();

    const report = await replaySpool({ spool, handlers }, { maxFiles: 2 });

    // No `stopped`: reaching the budget is the run finishing, not something
    // going wrong, and the rest is the next drain's.
    expect(report).toEqual({ completed: 2, replayed: 2 });
    expect(seen).toHaveLength(2);
    expect(await spool.stats()).toMatchObject({ records: 1 });
  });

  it('reports an empty spool as a run with nothing to do', async () => {
    const spool = memorySpool();
    const { handlers } = accepting();

    expect(await replaySpool({ spool, handlers })).toEqual({ completed: 0, replayed: 0 });
  });
});

describe('replaySpool when a record does not go back in', () => {
  it('puts the file back whole and stops the run', async () => {
    const spool = memorySpool();
    await withFiles(spool, 2);
    const { handlers } = failingAfter(0);

    const report = await replaySpool({ spool, handlers });

    expect(report.completed).toBe(0);
    expect(report.replayed).toBe(0);
    expect(report.stopped).toContain('the database is still unreachable');
    // Both files are still waiting, and the one that was claimed is claimable
    // again: a released file is a file nothing has consumed.
    expect(await spool.stats()).toMatchObject({ records: 2 });
    expect(await spool.claim()).toMatchObject({ ok: true, claim: { lines: [expect.any(String)] } });
  });

  it('keeps the whole file even when some of its lines did go in', async () => {
    // Half a file replayed and the file put back: the records are idempotent on
    // their ids, so a later drain doing those lines again changes nothing, and
    // dropping them would lose the rest (AD-8). Rewriting only what is left is
    // story 12's.
    const spool = memorySpool();
    const records = [
      sampleSpoolRecord({ id: IDS[0] }),
      sampleSpoolRecord({ id: IDS[1] }),
      sampleSpoolRecord({ id: IDS[2] }),
    ];
    expect(await spool.append(records)).toMatchObject({ ok: true });
    const { handlers, seen } = failingAfter(2);

    const report = await replaySpool({ spool, handlers });

    expect(report.completed).toBe(0);
    expect(report.replayed).toBe(2);
    expect(report.stopped).toContain('3번째 줄');
    expect(seen).toHaveLength(2);
    expect(await spool.stats()).toMatchObject({ records: 3 });
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

    await replaySpool({ spool, handlers });

    // One call, not three: the reason the first file failed is the reason the
    // next two would, and walking them would be three attempts on one problem.
    expect(calls).toBe(1);
  });

  it('stops on a line nothing can read, and does not delete the file', async () => {
    // A line from a build this one does not know, which is the realistic shape
    // of a line a replay cannot read — along with the half-written line a
    // killed process leaves. `append` refuses to make either, so the file is
    // handed over directly.
    const ahead = encodeSpoolLine(sampleSpoolRecord());
    expect(ahead.ok).toBe(true);
    const spoolWithBrokenLine = spoolHolding([
      ahead.ok ? ahead.line.replace('"schema_version":1', '"schema_version":99') : '',
    ]);
    const { handlers, seen } = accepting();

    const report = await replaySpool({ spool: spoolWithBrokenLine, handlers });

    expect(report.completed).toBe(0);
    expect(report.stopped).toContain('1번째 줄');
    expect(seen).toEqual([]);
    // Still there: a line this build cannot read may be one a later build can,
    // and nothing may throw away a write that never reached the database.
    expect(await spoolWithBrokenLine.stats()).toMatchObject({ records: 1 });
  });

  it('stops on a kind nobody handles, and does not delete the file', async () => {
    const spool = memorySpool();
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });

    // A build with no handler registered: the file is left alone rather than
    // dropped, because the records are still writes that have not landed.
    const report = await replaySpool({ spool, handlers: {} });

    expect(report.completed).toBe(0);
    expect(report.stopped).toContain('session_ingest');
    expect(await spool.stats()).toMatchObject({ records: 1 });
  });

  it('says so when the file could not even be put back', async () => {
    const spool = memorySpool({ releaseFailure: 'the spool folder went away' });
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    const { handlers } = failingAfter(0);

    const report = await replaySpool({ spool, handlers });

    // Both halves: why it failed, and that the file is now stuck as a claim
    // somebody will have to take back by the stale rule (AD-9).
    expect(report.stopped).toContain('the database is still unreachable');
    expect(report.stopped).toContain('the spool folder went away');
  });

  it('stops when a claim itself cannot be made', async () => {
    const spool = memorySpool({ claimFailure: 'the spool folder is unreadable' });

    const report = await replaySpool({ spool, handlers: accepting().handlers });

    expect(report).toMatchObject({ completed: 0, replayed: 0 });
    expect(report.stopped).toContain('the spool folder is unreadable');
  });

  it('stops, rather than carrying on, when a replayed file cannot be removed', async () => {
    const spool = memorySpool({ completeFailure: 'the file is read-only' });
    await withFiles(spool, 2);
    const { handlers, seen } = accepting();

    const report = await replaySpool({ spool, handlers });

    // The records are in; the file is not gone. Carrying on inside this run
    // would replay the same file again, where stopping leaves it for a later
    // drain — which is harmless, because the records are idempotent (AD-8).
    expect(report.completed).toBe(0);
    expect(report.replayed).toBe(1);
    expect(report.stopped).toContain('the file is read-only');
    expect(seen).toHaveLength(1);
  });
});

/** A spool whose one file holds exactly these lines, for the unreadable case. */
function spoolHolding(lines: readonly string[]): MemorySpool {
  const inner = memorySpool();
  let claimed = false;
  return {
    ...inner,
    async claim() {
      if (claimed) return { ok: true, claim: null };
      claimed = true;
      return { ok: true, claim: { handle: 'held.claiming', lines: [...lines] } };
    },
    async release() {
      claimed = false;
      return { ok: true };
    },
    async stats() {
      return { ok: true, records: lines.length, earliest: null };
    },
  };
}
