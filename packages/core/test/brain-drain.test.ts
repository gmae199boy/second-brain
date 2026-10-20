import { describe, expect, it } from 'vitest';
import { createBrain, type BrainDependencies } from '../src/brain.js';
import { SESSION_INGEST_KIND } from '../src/capture/session-ingest-work.js';
import { DRAIN_BUDGET_MS } from '../src/domain/work-item.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryParser, memoryTranscript } from '../src/testing/fakes/parser.js';
import { memoryRepositories } from '../src/testing/fakes/repository.js';
import { memorySpool, type MemorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import { memoryTranscriptReader } from '../src/testing/fakes/transcript.js';
import {
  memoryTranscriptFolder,
  type MemoryTranscriptFolder,
} from '../src/testing/fakes/transcript-folder.js';
import { sampleSelfUserInput, sampleSpoolRecord } from '../src/testing/fixtures.js';

/**
 * One drain run, whole: the spool goes back in, the folders are scanned, and
 * the queue is worked — in that order, under one deadline (Design Notes).
 *
 * This is where the three steps of story 12 meet, so the cases here are about
 * the seams between them rather than about any one of them: that a scan's item
 * is collected in the same run, that an unwritable database ends the run before
 * the scan, and that the counts of all three are in one answer.
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');
const PATH = '/transcripts/session-0001.jsonl';
const TOKEN = 'demo:session-0001';

interface Kit {
  brain: ReturnType<typeof createBrain>;
  store: MemoryStore;
  spool: MemorySpool;
  folder: MemoryTranscriptFolder;
}

/**
 * A brain over the memory fakes, with one transcript on the disk and an owner
 * recorded — which is the least a collection needs (AD-12).
 */
async function kit(
  options: { withFolder?: boolean; store?: MemoryStore; spool?: MemorySpool } = {},
): Promise<Kit> {
  const store = options.store ?? memoryStore();
  expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  const spool = options.spool ?? memorySpool();
  const folder = memoryTranscriptFolder({
    harness: 'demo',
    files: [
      {
        harnessSessionId: 'session-0001',
        path: PATH,
        sizeBytes: memoryTranscript.length,
        modifiedAt: NOW,
      },
    ],
  });
  const dependencies: BrainDependencies = {
    // The schema version is doctor's question and nothing a drain asks, so the
    // fake answers it beside the memory store rather than having one of its own.
    store: {
      ...store,
      async readSchemaVersion() {
        return { ok: true, version: { version: 6, appliedAt: NOW } };
      },
    },
    spool,
    schemaVersion: 6,
    clock: fixedClock(NOW),
    idGen: sequenceIdGen({ timestampMs: NOW.getTime() }),
    parsers: [memoryParser()],
    transcripts: memoryTranscriptReader({ files: { [PATH]: memoryTranscript } }),
    ...(options.withFolder === false ? {} : { transcriptFolders: [folder] }),
    repositories: memoryRepositories(),
    machine: 'demo-machine',
  };
  return { brain: createBrain(dependencies), store, spool, folder };
}

describe('brain.queue.drain', () => {
  it('scans the folders and collects what it found in the same run', async () => {
    // Which is what makes one `brain queue drain` on a fresh install collect
    // everything on the disk (SM-5): the scan comes before the queue loop, so
    // the item it adds is claimed by that same loop.
    const { brain, store } = await kit();

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({
      replayed: 0,
      spoolFailed: 0,
      enqueued: 1,
      claimed: 1,
      completed: 1,
      failed: 0,
      stopped: 'empty',
    });
    const sessions = store.snapshot().sessions;
    expect(sessions).toHaveLength(1);
    // A session a folder scan found is an import, however many live turns
    // follow it (Table Contract).
    expect(sessions[0]).toMatchObject({ harnessSessionId: 'session-0001', ingestSource: 'import' });
    expect(store.snapshot().messages.length).toBeGreaterThan(0);
  });

  it('writes the history, so a second run finds nothing to do', async () => {
    const { brain, store } = await kit();

    const first = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
    const messagesAfterFirst = store.snapshot().messages.length;
    const second = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(first.enqueued).toBe(1);
    expect(messagesAfterFirst).toBeGreaterThan(0);
    // The history is what stops the second run: the listing and the row agree
    // about the size, so nothing changed (Decision 2, 2026-10-19).
    expect(store.snapshot().transcriptFiles).toHaveLength(1);
    expect(second).toMatchObject({ enqueued: 0, claimed: 0, stopped: 'empty' });
    // And every table holds what it held after the first run (SM-5, AD-8).
    expect(store.snapshot().sessions).toHaveLength(1);
    expect(store.snapshot().messages).toHaveLength(messagesAfterFirst);
  });

  it('does nothing at all with no transcript folder', async () => {
    const { brain, store } = await kit({ withFolder: false });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({ enqueued: 0, claimed: 0, stopped: 'empty' });
    expect(store.snapshot().sessions).toEqual([]);
  });

  it('replays a spooled mark as a live session, and resolves what it recorded', async () => {
    const { brain, store, spool } = await kit({ withFolder: false });
    expect(
      await spool.append([sampleSpoolRecord({ transcriptPath: PATH })]),
    ).toMatchObject({ ok: true });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({ replayed: 1, spoolFailed: 0, enqueued: 0 });
    expect(await spool.stats()).toMatchObject({ records: 0, failed: 0 });
    // A mark written by a hook is about a session happening now, so the row it
    // creates is `live` and not an import (Table Contract).
    expect(store.snapshot().sessions[0]).toMatchObject({ ingestSource: 'live' });
  });

  it('stops before the scan when the database will not take a write', async () => {
    // The replay finds that out first, and a scan that enqueued work against
    // the same database would fail and cost an attempt for nothing (AD-9).
    const store = memoryStore();
    const locked: MemoryStore = {
      ...store,
      async findSession() {
        return { ok: false, code: 'DB_UNAVAILABLE', message: '파일을 열 수 없습니다' };
      },
    };
    const { brain, folder } = await kit({ store: locked });
    expect(await brain.sessions.ingest({ session: TOKEN, transcriptPath: PATH })).toMatchObject({
      ok: true,
      spooled: true,
    });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });

    expect(report).toMatchObject({
      stopped: 'unwritable',
      code: 'DB_UNAVAILABLE',
      enqueued: 0,
      claimed: 0,
    });
    // The folder was never listed: the run ended at the replay.
    expect(folder.lists()).toBe(0);
  });

  it('puts every count of one run in one answer', async () => {
    const { brain } = await kit({ withFolder: false });

    const report = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.opportunistic });

    // A person reading `brain queue drain` wants the spool, the folders and the
    // queue in one line, so the three numbers are on one report.
    expect(Object.keys(report).sort()).toEqual(
      [
        'claimed',
        'completed',
        'enqueued',
        'failed',
        'lost',
        'released',
        'replayed',
        'retried',
        'spoolFailed',
        'spooled',
        'stopped',
      ].sort(),
    );
  });
});

describe('brain.failures', () => {
  it('reads what is recorded and asks for it to be done again', async () => {
    const { brain, store } = await kit({ withFolder: false });
    expect(
      await store.recordFailure({
        id: '01940000-0000-7000-8000-0000000000b1',
        targetKind: 'session',
        targetId: TOKEN,
        stage: SESSION_INGEST_KIND,
        fingerprint: 'sha256:one',
        harness: 'demo',
        sessionId: null,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
        occurredAt: NOW,
      }),
    ).toMatchObject({ ok: true });

    expect(await brain.failures.list()).toMatchObject({ ok: true, count: 1 });
    expect(await brain.failures.retry()).toMatchObject({ ok: true, added: 1 });
    expect(store.snapshot().workItems[0]).toMatchObject({
      kind: SESSION_INGEST_KIND,
      targetId: TOKEN,
    });
  });
});
