import { describe, expect, it } from 'vitest';
import { scanTranscripts, transcriptChanges } from '../src/capture/scan.js';
import {
  FAILURE_RETRY_KINDS,
  SESSION_INGEST_KIND,
  sessionIngestHandler,
} from '../src/capture/session-ingest-work.js';
import { failureFingerprint } from '../src/domain/failure.js';
import type { TranscriptFile } from '../src/domain/transcript-file.js';
import type { WorkItem } from '../src/domain/work-item.js';
import type { TranscriptListing } from '../src/ports/transcript.js';
import { fixedClock } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import { memoryTranscriptFolder } from '../src/testing/fakes/transcript-folder.js';
import { sampleSelfUserInput, sampleTranscriptFileInput } from '../src/testing/fixtures.js';

/**
 * The folder scan: which files it decides have changed, which of those it
 * leaves alone, and what it puts on the queue (AD-4, AD-7, Decisions 3 and 4 of
 * 2026-10-19).
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');
const DEADLINE = NOW.getTime() + 30_000;

/** One listing entry, with an instant a case can order by. */
function listing(
  sessionId: string,
  sizeBytes: number,
  modifiedAt = NOW,
  harness = 'demo',
): TranscriptListing {
  return {
    harness,
    harnessSessionId: sessionId,
    path: `/transcripts/${sessionId}.jsonl`,
    sizeBytes,
    modifiedAt,
  };
}

/** One history row for the same file, so the two can be compared. */
function row(sessionId: string, sizeBytes: number, harness = 'demo'): TranscriptFile {
  return {
    id: `01940000-0000-7000-8000-0000000000${sessionId.slice(-2)}`,
    harness,
    path: `/transcripts/${sessionId}.jsonl`,
    sizeBytes,
    fingerprint: `sha256:${'a'.repeat(64)}`,
    cursor: null,
    scannedAt: NOW,
  };
}

/** The ports one scan is given, with a folder holding these files. */
function kit(
  files: readonly TranscriptListing[],
  options: { store?: MemoryStore; listFailure?: string } = {},
): {
  store: MemoryStore;
  folder: ReturnType<typeof memoryTranscriptFolder>;
  dependencies: Parameters<typeof scanTranscripts>[0];
} {
  const store = options.store ?? memoryStore();
  const folder = memoryTranscriptFolder({
    harness: 'demo',
    files: files.map((file) => ({
      harnessSessionId: file.harnessSessionId,
      path: file.path,
      sizeBytes: file.sizeBytes,
      modifiedAt: file.modifiedAt,
    })),
    ...(options.listFailure === undefined ? {} : { listFailure: options.listFailure }),
  });
  return {
    store,
    folder,
    dependencies: {
      store,
      folders: [folder],
      clock: fixedClock(NOW),
      idGen: sequenceIdGen({ timestampMs: NOW.getTime() }),
    },
  };
}

/** The queue, as a case reads it. */
function queued(store: MemoryStore): WorkItem[] {
  return [...store.snapshot().workItems];
}

describe('transcriptChanges', () => {
  it('calls a file with no row at all changed', () => {
    expect(transcriptChanges([listing('session-a', 10)], [])).toHaveLength(1);
  });

  it('calls a file whose size is not the stored one changed, either way', () => {
    // Either way: a transcript that was compacted is smaller and is still a
    // file this brain has not read as it now stands.
    expect(transcriptChanges([listing('session-a', 20)], [row('session-a', 10)])).toHaveLength(1);
    expect(transcriptChanges([listing('session-a', 5)], [row('session-a', 10)])).toHaveLength(1);
  });

  it('calls a file of the stored size unchanged, whatever its instant says', () => {
    // The instant is not evidence: a copy, a restore and a backup tool all move
    // `mtime` without changing a byte.
    const moved = listing('session-a', 10, new Date('2026-05-06T07:08:09.000Z'));
    expect(transcriptChanges([moved], [row('session-a', 10)])).toEqual([]);
  });

  it('keys the history by harness as well as path', () => {
    // Two harnesses can keep a transcript at the same path — a test fixture
    // copied, a folder bind-mounted — and one row must not answer for the other.
    const elsewhere = row('session-a', 10, 'other');
    expect(transcriptChanges([listing('session-a', 10)], [elsewhere])).toHaveLength(1);
  });
});

describe('scanTranscripts', () => {
  it('queues one session_ingest per changed file, oldest first', async () => {
    const { store, dependencies } = kit([
      listing('session-b', 20, new Date('2026-03-04T05:00:00.000Z')),
      listing('session-a', 10, new Date('2026-03-04T04:00:00.000Z')),
    ]);

    const report = await scanTranscripts(dependencies, { deadline: DEADLINE });

    expect(report).toMatchObject({ changed: 2, enqueued: 2, skipped: 0 });
    // Oldest first, because a transcript the harness will delete soonest is
    // the one worth collecting first when a budget runs out.
    expect(queued(store).map((item) => item.targetId)).toEqual([
      'demo:session-a',
      'demo:session-b',
    ]);
    expect(queued(store).every((item) => item.kind === SESSION_INGEST_KIND)).toBe(true);
    expect(queued(store).every((item) => item.targetKind === 'session')).toBe(true);
    // Due at once, so the queue loop of this same drain picks it up (SM-5).
    expect(queued(store)[0]?.nextAttemptAt.getTime()).toBe(NOW.getTime());
  });

  it('writes nothing at all when nothing has changed', async () => {
    const store = memoryStore();
    expect(
      await store.recordTranscriptFile(
        sampleTranscriptFileInput({
          harness: 'demo',
          path: '/transcripts/session-a.jsonl',
          sizeBytes: 10,
        }),
      ),
    ).toMatchObject({ ok: true });
    const { dependencies } = kit([listing('session-a', 10)], { store });
    // The verbs that would take the write lock, watched: the opportunistic
    // drain at the end of every command must take no lock on a quiet machine
    // (AD-7, Design Notes).
    let writes = 0;
    const watched = {
      ...dependencies,
      store: {
        ...store,
        async addWork(input: Parameters<MemoryStore['addWork']>[0]) {
          writes += 1;
          return store.addWork(input);
        },
      },
    };

    const report = await scanTranscripts(watched, { deadline: DEADLINE });

    expect(report).toMatchObject({ changed: 0, enqueued: 0, skipped: 0 });
    expect(writes).toBe(0);
    expect(queued(store)).toEqual([]);
  });

  it('leaves alone a session that is already on the queue', async () => {
    const store = memoryStore();
    expect(
      await store.addWork({
        id: '01940000-0000-7000-8000-0000000000f1',
        kind: SESSION_INGEST_KIND,
        targetKind: 'session',
        targetId: 'demo:session-a',
        createdAt: NOW,
        nextAttemptAt: NOW,
      }),
    ).toMatchObject({ ok: true });
    const { dependencies } = kit([listing('session-a', 10)], { store });

    const report = await scanTranscripts(dependencies, { deadline: DEADLINE });

    expect(report).toMatchObject({ changed: 1, enqueued: 0, skipped: 1 });
    expect(queued(store)).toHaveLength(1);
  });

  it('leaves alone a session whose last collection failed and is unresolved', async () => {
    // Decision 4, 2026-10-19: a scan that re-enqueued it every five minutes
    // would retry a permanently broken transcript for ever, and the
    // ten-attempt rule would mean nothing. `failures retry` is the deliberate
    // act that asks for another go.
    const store = memoryStore();
    expect(
      await store.recordFailure({
        id: '01940000-0000-7000-8000-0000000000f2',
        targetKind: 'session',
        targetId: 'demo:session-a',
        stage: SESSION_INGEST_KIND,
        fingerprint: failureFingerprint({
          stage: SESSION_INGEST_KIND,
          input: 'session:demo:session-a',
          code: 'TRANSCRIPT_UNREADABLE',
        }),
        harness: 'demo',
        sessionId: null,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
        occurredAt: NOW,
      }),
    ).toMatchObject({ ok: true });
    const { dependencies } = kit([listing('session-a', 10), listing('session-b', 10)], { store });

    const report = await scanTranscripts(dependencies, { deadline: DEADLINE });

    expect(report).toMatchObject({ changed: 2, enqueued: 1, skipped: 1 });
    expect(queued(store).map((item) => item.targetId)).toEqual(['demo:session-b']);
  });

  it('queues a session again once its failure has been resolved', async () => {
    const store = memoryStore();
    expect(
      await store.recordFailure({
        id: '01940000-0000-7000-8000-0000000000f3',
        targetKind: 'session',
        targetId: 'demo:session-a',
        stage: SESSION_INGEST_KIND,
        fingerprint: 'sha256:whatever',
        harness: 'demo',
        sessionId: null,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
        occurredAt: NOW,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await store.resolveFailures({
        targetKind: 'session',
        targetId: 'demo:session-a',
        stage: SESSION_INGEST_KIND,
        now: NOW,
      }),
    ).toMatchObject({ ok: true, resolved: 1 });
    const { dependencies } = kit([listing('session-a', 10)], { store });

    const report = await scanTranscripts(dependencies, { deadline: DEADLINE });

    expect(report).toMatchObject({ enqueued: 1 });
  });

  it('stops at the deadline and leaves the rest for the next scan', async () => {
    const { store, dependencies } = kit([listing('session-a', 10), listing('session-b', 10)]);

    const report = await scanTranscripts(dependencies, { deadline: NOW.getTime() - 1 });

    expect(report.enqueued).toBe(0);
    expect(report.stopped).toContain('시간 예산');
    // Nothing about the scan remembers where it stopped: the next one finds
    // the same files, because the history still says nothing about them.
    expect(queued(store)).toEqual([]);
  });

  it('says so when a folder cannot be listed, and carries on with the others', async () => {
    const store = memoryStore();
    const broken = memoryTranscriptFolder({
      harness: 'broken',
      listFailure: 'EACCES: permission denied',
    });
    const fine = memoryTranscriptFolder({
      harness: 'demo',
      files: [
        {
          harnessSessionId: 'session-a',
          path: '/transcripts/session-a.jsonl',
          sizeBytes: 10,
          modifiedAt: NOW,
        },
      ],
    });

    const report = await scanTranscripts(
      {
        store,
        folders: [broken, fine],
        clock: fixedClock(NOW),
        idGen: sequenceIdGen({ timestampMs: NOW.getTime() }),
      },
      { deadline: DEADLINE },
    );

    // One harness's permissions are not another's: the sentence is reported and
    // the other folder is still scanned.
    expect(report.stopped).toContain('EACCES');
    expect(report.enqueued).toBe(1);
    expect(queued(store).map((item) => item.targetId)).toEqual(['demo:session-a']);
  });

  it('lists each folder once per scan', async () => {
    const { folder, dependencies } = kit([listing('session-a', 10)]);

    await scanTranscripts(dependencies, { deadline: DEADLINE });

    expect(folder.lists()).toBe(1);
  });
});

describe('the session_ingest handler', () => {
  /** One claimed item for a session, as the drain hands it over. */
  function item(targetId = 'demo:session-0001'): WorkItem {
    return {
      id: '01940000-0000-7000-8000-0000000000e1',
      kind: SESSION_INGEST_KIND,
      targetKind: 'session',
      targetId,
      createdAt: NOW,
      attempts: 1,
      nextAttemptAt: NOW,
      claimedAt: NOW,
      claimExpiresAt: new Date(NOW.getTime() + 600_000),
      claimedBy: 'drain',
      lastError: null,
      completedAt: null,
    };
  }

  it('collects the session as an import, and never through the spool', async () => {
    const store = memoryStore();
    const asked: unknown[] = [];
    const handler = sessionIngestHandler({
      ingest: async (input, options) => {
        asked.push({ input, options });
        return {
          ok: true,
          session: input.session,
          spooled: false,
          created: true,
          inserted: { messages: 1, toolNotes: 0 },
          droppedLines: { unreadable: 0 },
          warnings: [],
        };
      },
      store,
      clock: fixedClock(NOW),
    });

    expect(await handler(item())).toEqual({ ok: true });
    expect(asked).toEqual([
      {
        // No path: the handler has a token and the ingest looks the file up in
        // that harness's folder (Boundaries).
        input: { session: 'demo:session-0001', source: 'import' },
        // This path *is* the deferred one, so a mark in the spool would be a
        // second copy of work the queue is already holding (AD-21).
        options: { spoolOnUnwritable: false },
      },
    ]);
  });

  it('closes the failures of a session that finally went through', async () => {
    const store = memoryStore();
    expect(
      await store.recordFailure({
        id: '01940000-0000-7000-8000-0000000000e2',
        targetKind: 'session',
        targetId: 'demo:session-0001',
        stage: SESSION_INGEST_KIND,
        fingerprint: 'sha256:whatever',
        harness: 'demo',
        sessionId: null,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
        occurredAt: NOW,
      }),
    ).toMatchObject({ ok: true });
    const handler = sessionIngestHandler({
      ingest: async (input) => ({
        ok: true,
        session: input.session,
        spooled: false,
        created: false,
        inserted: { messages: 2, toolNotes: 0 },
        droppedLines: { unreadable: 0 },
        warnings: [],
      }),
      store,
      clock: fixedClock(NOW),
    });

    expect(await handler(item())).toEqual({ ok: true });

    const read = await store.listFailures({ includeResolved: true });
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) return;
    expect(read.failures[0]?.resolvedAt?.getTime()).toBe(NOW.getTime());
  });

  it.each([
    ['TRANSCRIPT_UNREADABLE'],
    ['USER_MISSING'],
  ])('calls %s permanent, so it is recorded on the first failure', async (code) => {
    const handler = sessionIngestHandler({
      ingest: async () => ({ ok: false, code: code as 'USER_MISSING', message: '안 됩니다' }),
      store: memoryStore(),
      clock: fixedClock(NOW),
    });

    // Neither is fixed by waiting: the harness has deleted the file, or the
    // install step that records the owner has not run (AD-21).
    expect(await handler(item())).toMatchObject({ ok: false, code, retryable: false });
  });

  it('hands a database code back as it is, so the item is released', async () => {
    const handler = sessionIngestHandler({
      ingest: async () => ({ ok: false, code: 'DB_LOCKED', message: '잠겨 있습니다' }),
      store: memoryStore(),
      clock: fixedClock(NOW),
    });

    const outcome = await handler(item());

    // No `retryable`: the classification sees a spool cause first and releases
    // the item with its attempt given back (AD-21).
    expect(outcome).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(outcome).not.toHaveProperty('retryable');
  });

  it('names the harness, and the session row when there is one', async () => {
    const store = memoryStore();
    expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
    const ensured = await store.ensureSession({
      id: '01940000-0000-7000-8000-0000000000e3',
      key: { harness: 'demo', harnessSessionId: 'session-0001' },
      userId: sampleSelfUserInput().id,
      machine: 'demo-machine',
      startedAt: NOW,
      ingestSource: 'import',
      startSource: null,
      workspaceId: null,
      checkout: null,
      firstCwd: null,
      tagSource: null,
  identityWork: null,
    });
    expect(ensured).toMatchObject({ ok: true });
    const handler = sessionIngestHandler({
      ingest: async () => ({
        ok: false,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
      }),
      store,
      clock: fixedClock(NOW),
    });

    expect(await handler(item())).toMatchObject({
      harness: 'demo',
      sessionId: '01940000-0000-7000-8000-0000000000e3',
    });
  });

  it('names the harness alone for a session no row exists for', async () => {
    const handler = sessionIngestHandler({
      ingest: async () => ({
        ok: false,
        code: 'TRANSCRIPT_UNREADABLE',
        message: '읽을 수 없습니다',
      }),
      store: memoryStore(),
      clock: fixedClock(NOW),
    });

    const outcome = await handler(item());

    // The token in `target_id` identifies it either way, and a session whose
    // very first collection failed has no row (AD-12).
    expect(outcome).toMatchObject({ harness: 'demo' });
    expect(outcome).not.toHaveProperty('sessionId');
  });
});

describe('FAILURE_RETRY_KINDS', () => {
  it('maps a session to collecting it again, and knows nothing else yet', () => {
    // A target kind that is not in here is reported as skipped rather than
    // guessed at: an item of a kind no handler claims would sit in the backlog
    // for ever (Boundaries).
    expect(FAILURE_RETRY_KINDS).toEqual({ session: SESSION_INGEST_KIND });
  });
});
