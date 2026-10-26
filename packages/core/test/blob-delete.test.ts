import { describe, expect, it } from 'vitest';
import { createBrain, type Brain, type BrainDependencies } from '../src/brain.js';
import type { FileLocation } from '../src/domain/file.js';
import type { IngestAttachment } from '../src/domain/ingest-batch.js';
import { utf8Bytes } from '../src/domain/sha256.js';
import { DRAIN_BUDGET_MS } from '../src/domain/work-item.js';
import {
  BLOB_DELETE_KIND,
  FILE_LOCATION_NOT_FOUND,
  FILE_LOCATION_TARGET_KIND,
  LOCATION_REFUSED,
  blobDeleteHandler,
  blobDeleteWork,
} from '../src/files/blob-delete-work.js';
import type { Clock } from '../src/ports/clock.js';
import type { FileStore } from '../src/ports/file-store.js';
import type { IdGen } from '../src/ports/id-gen.js';
import type { SchemaStore, Store } from '../src/ports/store.js';
import { memoryFileStore } from '../src/testing/fakes/file-store.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memoryParser } from '../src/testing/fakes/parser.js';
import { memoryRepositories } from '../src/testing/fakes/repository.js';
import { memorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore, type MemoryStore } from '../src/testing/fakes/store.js';
import { memoryTranscriptReader } from '../src/testing/fakes/transcript.js';
import {
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
} from '../src/testing/fixtures.js';

/**
 * `blob_delete` against the in-memory fakes: the nine rows of the I/O matrix.
 *
 * Three of them go through `brain.queue.drain` — the ordinary deletion, the
 * second item about the same place, and a user's own file — because what those
 * three are about is the seam: one place is emptied, marked and closed by one
 * drain, and a second item about it changes nothing. The rest call the handler
 * on its own, because what they ask about is one answer and the gate that
 * produced it.
 *
 * One row is deliberately elsewhere: the command end to end, with the real
 * local file store and its root and link rules
 * (`apps/cli/test/sessions-ingest.test.ts`).
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');
const NOTE = '# 제목\n\n본문 첫 줄입니다.\n';
/** The fifteen minutes a temporary failure waits (`DEFAULT_WORK_POLICY`). */
const TRANSIENT_DELAY_MS = 900_000;

interface MovableClock extends Clock {
  advance(ms: number): void;
}

function movableClock(start: Date): MovableClock {
  let now = start;
  return {
    now: () => now,
    advance(ms) {
      now = new Date(now.getTime() + ms);
    },
  };
}

/** What a gated file store is told to answer about `delete`, and what it was asked. */
interface FilesGate {
  /** `null` to pass the call through to the fake underneath. */
  fail?: 'FILES_UNAVAILABLE' | null;
  /** How many times `delete` was called, so a case can ask that it was not. */
  deletes: number;
  /** The locations it was asked about, in order. */
  asked: FileLocation[];
}

/**
 * The fake file store with one switch in front of its `delete`.
 *
 * Only `delete` is gated: everything else in here belongs to the ingest, and a
 * gate on it would be testing the ingest. `LOCATION_REFUSED` needs no switch —
 * the fake refuses a locator outside the store's own syntax by itself, which is
 * the condition the matrix row is about.
 */
function gatedFiles(inner: FileStore, gate: FilesGate): FileStore {
  return {
    ...inner,
    async delete(location) {
      gate.deletes += 1;
      gate.asked.push(location);
      if (gate.fail !== undefined && gate.fail !== null) {
        return { ok: false, code: gate.fail, message: `${gate.fail} 라고 답하도록 했습니다` };
      }
      return inner.delete(location);
    },
  };
}

/** What a gated store refuses the marking with, and for how many calls. */
interface MarkGate {
  code: 'DB_UNAVAILABLE' | 'DB_LOCKED';
  /** How many more calls are refused before the real store sees them. */
  refusals: number;
  calls: number;
}

function gatedStore(inner: Store & SchemaStore, gate: MarkGate): Store & SchemaStore {
  return {
    ...inner,
    async markFileLocationDeleted(input) {
      gate.calls += 1;
      if (gate.refusals > 0) {
        gate.refusals -= 1;
        return { ok: false, code: gate.code, message: `${gate.code} 라고 답하도록 했습니다` };
      }
      return inner.markFileLocationDeleted(input);
    },
  };
}

/** Where the four places of this file are, by the id the ingest gave them. */
interface Places {
  /** Brain's own copy: `local`, `brain`, and a locator the store accepts. */
  brain: string;
  /** The user's original: `local`, `external`. */
  external: string;
  /** A copy in Drive: `drive`, `brain`. */
  drive: string;
  /** Brain's own, with a locator outside the store's syntax. */
  outside: string;
}

interface Kit {
  brain: Brain;
  store: MemoryStore;
  files: FileStore;
  gate: FilesGate;
  clock: MovableClock;
  idGen: IdGen;
  places: Places;
  /** Where Brain's copy of the bytes lives, for a case that asks if they went. */
  home: FileLocation & { storeKind: 'local'; ownership: 'brain' };
  fileId: string;
}

interface KitOptions {
  /** Wrapped around the memory store, for a marking that has to refuse. */
  wrap?: (store: Store & SchemaStore) => Store & SchemaStore;
  /** Leave the bytes out of the file store, for the "already gone" row. */
  withoutBlob?: boolean;
}

/**
 * A brain with one stored attachment that has four places, and nothing else to
 * do: no transcript folders, so the scan queues nothing, and a session that
 * already carries a cwd, so the identity step has no candidate.
 *
 * The one drain at the end is the settling run: the stored file is read into
 * pieces there, so every drain a case runs afterwards is about this story alone
 * — and a deletion that happens first would otherwise leave the extraction with
 * bytes it cannot reach.
 */
async function kit(options: KitOptions = {}): Promise<Kit> {
  const bytes = utf8Bytes(NOTE);
  const store = memoryStore();
  const clock = movableClock(NOW);
  const idGen = sequenceIdGen({ start: 8000, timestampMs: NOW.getTime() });
  const inner = memoryFileStore();
  const gate: FilesGate = { deletes: 0, asked: [] };
  const files = gatedFiles(inner, gate);

  expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  expect(
    await store.ensureSession(sampleEnsureSessionInput({ firstCwd: '/demo/repo' })),
  ).toMatchObject({ ok: true });

  const put = await inner.put(bytes);
  if (!put.ok) throw new Error(put.message);
  const hash = put.contentHash;
  const batch = sampleIngestBatch();
  const message = batch.messages[0];
  if (message === undefined) throw new Error('표본 묶음에 메시지가 없습니다');
  const fileId = idGen.next();
  const places: Places = {
    brain: idGen.next(),
    external: idGen.next(),
    drive: idGen.next(),
    outside: idGen.next(),
  };
  const base = {
    harnessMessageId: message.harnessMessageId,
    sourceKind: 'file',
    sourceRef: '~/project/note.md',
    displayName: 'note.md',
  };
  const file = { id: fileId, contentHash: hash, sizeBytes: bytes.length };
  // Four places of one file, put there the way the ingest puts them: the ingest
  // carries two per attachment, so the Drive copy and the unacceptable locator
  // arrive as further attachments of the same content (AD-23).
  const attachments: IngestAttachment[] = [
    {
      ...base, id: idGen.next(), ordinal: 0,
      file: {
        ...file,
        location: { id: places.brain, ...put.location },
        external: { id: places.external, storeKind: 'local', ownership: 'external', locator: '~/project/note.md' },
      },
    },
    {
      ...base, id: idGen.next(), ordinal: 1,
      file: {
        ...file,
        location: { id: places.drive, storeKind: 'drive', ownership: 'brain', locator: 'drive-file-0001' },
        external: null,
      },
    },
    {
      ...base, id: idGen.next(), ordinal: 2,
      file: {
        ...file,
        location: { id: places.outside, storeKind: 'local', ownership: 'brain', locator: 'outside/note.md' },
        external: null,
      },
    },
  ];
  expect(await store.ingest({ ...batch, attachments })).toMatchObject({ ok: true });
  const rows = await store.listFileLocations(fileId);
  if (!rows.ok) throw new Error(rows.message);
  expect(rows.locations.map((location) => location.id).sort()).toEqual(
    [places.brain, places.drive, places.external, places.outside].sort(),
  );

  const withSchema: Store & SchemaStore = {
    ...store,
    async readSchemaVersion() {
      return { ok: true, version: { version: 8, appliedAt: NOW } };
    },
  };
  const dependencies: BrainDependencies = {
    store: options.wrap === undefined ? withSchema : options.wrap(withSchema),
    spool: memorySpool(),
    files,
    schemaVersion: 8,
    clock,
    idGen,
    parsers: [memoryParser()],
    transcripts: memoryTranscriptReader({ files: {} }),
    repositories: memoryRepositories(),
    machine: 'demo-machine',
  };
  const brain = createBrain(dependencies);
  // The settling run: it reads the file, and after it the queue is empty.
  const settled = await brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
  expect(settled).toMatchObject({ failed: 0, released: 0, stopped: 'empty' });
  expect(store.snapshot().failures).toEqual([]);
  if (options.withoutBlob === true) {
    const removed = await inner.delete(put.location);
    expect(removed).toEqual({ ok: true, deleted: true });
  }

  return { brain, store, files, gate, clock, idGen, places, home: put.location, fileId };
}

/** One drain run with the command budget, which is every case's drain. */
async function drain(subject: Kit) {
  return subject.brain.queue.drain({ budgetMs: DRAIN_BUDGET_MS.command });
}

/** Put one `blob_delete` item on the queue, the way 10.12 and epic 8 will. */
async function enqueue(subject: Kit, locationId: string) {
  const added = await subject.store.addWork(
    blobDeleteWork({ id: subject.idGen.next(), locationId, at: subject.clock.now() }),
  );
  expect(added).toMatchObject({ ok: true, created: true });
}

/** The handler on its own, with the kit's ports behind it. */
function handler(subject: Kit) {
  return blobDeleteHandler({ store: subject.store, files: subject.files, clock: subject.clock });
}

/** One item of this kind, as the handler receives it from the drain. */
function item(id: string, locationId: string) {
  return {
    id,
    kind: BLOB_DELETE_KIND,
    targetKind: FILE_LOCATION_TARGET_KIND,
    targetId: locationId,
    createdAt: NOW,
    attempts: 1,
    nextAttemptAt: NOW,
    claimedAt: NOW,
    claimExpiresAt: new Date(NOW.getTime() + 600_000),
    claimedBy: 'claim-0001',
    lastError: null,
    completedAt: null,
  };
}

/** One place as the store now holds it. */
async function place(subject: Kit, locationId: string) {
  const read = await subject.store.readFileLocation(locationId);
  if (!read.ok) throw new Error(read.message);
  return read.location;
}

/** Whether Brain's copy of the bytes is still there. */
async function blobExists(subject: Kit) {
  const read = await subject.files.exists(subject.home);
  if (!read.ok) throw new Error(read.message);
  return read.exists;
}

/** The deletion failures this brain recorded, which most paths must not create. */
function recorded(subject: Kit) {
  return subject.store
    .snapshot()
    .failures.filter((failure) => failure.stage === BLOB_DELETE_KIND);
}

function deleteItems(subject: Kit) {
  return subject.store.snapshot().workItems.filter((row) => row.kind === BLOB_DELETE_KIND);
}

describe('drain이 블롭 하나를 지우고 그 위치에 표시를 남긴다', () => {
  it('brain·local 위치의 바이트를 지우고 deleted_at을 채운다', async () => {
    const subject = await kit();
    await enqueue(subject, subject.places.brain);

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, completed: 1, failed: 0, released: 0, stopped: 'empty' });
    expect(await blobExists(subject)).toBe(false);
    expect((await place(subject, subject.places.brain)).deletedAt).toEqual(NOW);
    expect(subject.gate.asked).toEqual([subject.home]);
    expect(recorded(subject)).toEqual([]);
    expect(deleteItems(subject).map((row) => row.completedAt)).toEqual([NOW]);
    // The other three places of the same file are untouched: the work was about
    // one place and not about the file.
    for (const id of [subject.places.external, subject.places.drive, subject.places.outside]) {
      expect((await place(subject, id)).deletedAt).toBe(null);
    }
  });

  it('같은 위치의 두 번째 일감은 FileStore를 다시 부르지 않고 첫 값을 지킨다', async () => {
    const subject = await kit();
    await enqueue(subject, subject.places.brain);
    expect(await drain(subject)).toMatchObject({ completed: 1 });
    const deletes = subject.gate.deletes;

    // The same bytes collected again revive the same locator, and an item about
    // a place that was emptied once must not delete that new blob (Design Notes).
    const put = await subject.files.put(utf8Bytes(NOTE));
    expect(put).toMatchObject({ ok: true });
    subject.clock.advance(60_000);
    await enqueue(subject, subject.places.brain);

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, completed: 1, failed: 0, stopped: 'empty' });
    expect(subject.gate.deletes).toBe(deletes);
    expect(await blobExists(subject)).toBe(true);
    expect((await place(subject, subject.places.brain)).deletedAt).toEqual(NOW);
    expect(recorded(subject)).toEqual([]);
  });

  it('사용자 자신의 external 위치는 FileStore를 부르지 않고 거부로 기록한다', async () => {
    const subject = await kit();
    await enqueue(subject, subject.places.external);

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, completed: 0, failed: 1, stopped: 'empty' });
    expect(subject.gate.deletes).toBe(0);
    expect(await blobExists(subject)).toBe(true);
    expect((await place(subject, subject.places.external)).deletedAt).toBe(null);
    expect(recorded(subject)).toMatchObject([
      {
        targetKind: FILE_LOCATION_TARGET_KIND,
        targetId: subject.places.external,
        stage: BLOB_DELETE_KIND,
        code: LOCATION_REFUSED,
      },
    ]);
  });
});

describe('blob_delete handler의 나머지 답', () => {
  it('블롭이 이미 없어도 성공으로 치고 표시를 남긴다', async () => {
    const subject = await kit({ withoutBlob: true });

    expect(await handler(subject)(item('item-gone', subject.places.brain))).toEqual({ ok: true });

    expect(subject.gate.deletes).toBe(1);
    expect((await place(subject, subject.places.brain)).deletedAt).toEqual(NOW);
  });

  it.each(['DB_UNAVAILABLE', 'DB_LOCKED'] as const)('표시 쓰기가 %s이면 그 코드로 돌려주고 다음 시도가 마저 끝낸다', async (code) => {
    const gate: MarkGate = { code, refusals: 1, calls: 0 };
    const subject = await kit({ wrap: (store) => gatedStore(store, gate) });
    await enqueue(subject, subject.places.brain);

    const first = await drain(subject);

    // Released and not retried: nothing was tried, so no attempt was spent
    // (AD-21). The bytes are gone and the place is not marked, which is the one
    // in-between state this handler leaves.
    expect(first).toMatchObject({ claimed: 1, released: 1, failed: 0, stopped: 'unwritable', code });
    expect(await blobExists(subject)).toBe(false);
    expect((await place(subject, subject.places.brain)).deletedAt).toBe(null);
    expect(deleteItems(subject).map((row) => row.attempts)).toEqual([0]);
    expect(recorded(subject)).toEqual([]);

    subject.clock.advance(1000);
    const second = await drain(subject);

    expect(second).toMatchObject({ claimed: 1, completed: 1, failed: 0, stopped: 'empty' });
    expect((await place(subject, subject.places.brain)).deletedAt).toEqual(
      new Date(NOW.getTime() + 1000),
    );
    expect(gate.calls).toBe(2);
    expect(recorded(subject)).toEqual([]);
  });

  it('drive 위치는 FileStore를 부르지 않고 즉시 거부한다', async () => {
    const subject = await kit();

    expect(await handler(subject)(item('item-drive', subject.places.drive))).toMatchObject({
      ok: false,
      code: LOCATION_REFUSED,
      retryable: false,
    });

    expect(subject.gate.deletes).toBe(0);
    expect((await place(subject, subject.places.drive)).deletedAt).toBe(null);
  });

  it('루트 밖 locator는 port의 거부를 그대로 기록하고 표시하지 않는다', async () => {
    const subject = await kit();

    expect(await handler(subject)(item('item-outside', subject.places.outside))).toMatchObject({
      ok: false,
      code: LOCATION_REFUSED,
      retryable: false,
    });

    // Asked, and refused by the store's own rule: the locator is outside the
    // syntax the files root accepts.
    expect(subject.gate.deletes).toBe(1);
    expect((await place(subject, subject.places.outside)).deletedAt).toBe(null);
    expect(await blobExists(subject)).toBe(true);
  });

  it('저장소가 일시적으로 없으면 기다렸다 다시 한다', async () => {
    const subject = await kit();
    subject.gate.fail = 'FILES_UNAVAILABLE';
    await enqueue(subject, subject.places.brain);

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, retried: 1, failed: 0, stopped: 'empty' });
    expect(deleteItems(subject).map((row) => row.nextAttemptAt)).toEqual([
      new Date(NOW.getTime() + TRANSIENT_DELAY_MS),
    ]);
    expect(await blobExists(subject)).toBe(true);
    expect((await place(subject, subject.places.brain)).deletedAt).toBe(null);
    expect(recorded(subject)).toEqual([]);

    subject.gate.fail = null;
    subject.clock.advance(TRANSIENT_DELAY_MS);
    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1, stopped: 'empty' });
    expect(await blobExists(subject)).toBe(false);
  });

  it('없는 위치 id는 즉시 기록하고 다시 시도하지 않는다', async () => {
    const subject = await kit();
    await enqueue(subject, 'no-such-location');

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, completed: 0, retried: 0, failed: 1, stopped: 'empty' });
    expect(subject.gate.deletes).toBe(0);
    expect(recorded(subject)).toMatchObject([
      {
        targetKind: FILE_LOCATION_TARGET_KIND,
        targetId: 'no-such-location',
        stage: BLOB_DELETE_KIND,
        code: FILE_LOCATION_NOT_FOUND,
      },
    ]);
  });

  it('기록된 blob_delete 실패는 failures retry가 같은 일감으로 다시 넣는다', async () => {
    const subject = await kit();
    await enqueue(subject, subject.places.external);
    expect(await drain(subject)).toMatchObject({ failed: 1 });
    expect(recorded(subject)).toHaveLength(1);

    // The one line in `FAILURE_RETRY_STAGES`: without it this target kind is
    // nothing this build knows a retry for, and the command counts it as
    // skipped instead of queueing anything (`failures/retry.ts`).
    const retried = await subject.brain.failures.retry();

    expect(retried).toMatchObject({ ok: true, added: 1, alreadyOpen: 0, skipped: [] });
    expect(deleteItems(subject).filter((row) => row.completedAt === null)).toMatchObject([
      {
        kind: BLOB_DELETE_KIND,
        targetKind: FILE_LOCATION_TARGET_KIND,
        targetId: subject.places.external,
      },
    ]);
  });
});
