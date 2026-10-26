import { describe, expect, it } from 'vitest';
import { createBrain, type Brain, type BrainDependencies } from '../src/brain.js';
import {
  DOCUMENT_CHUNK_PARAMS,
  DOCUMENT_EXTRACT_MAX_BYTES,
} from '../src/domain/document.js';
import { contentHashOfBytes, type FileLocation } from '../src/domain/file.js';
import { DOCUMENT_CHUNK_INDEX_CONFIG_ID } from '../src/domain/index-config.js';
import type { IngestAttachment } from '../src/domain/ingest-batch.js';
import { utf8Bytes } from '../src/domain/sha256.js';
import { DRAIN_BUDGET_MS, MAX_WORK_ATTEMPTS } from '../src/domain/work-item.js';
import {
  DOCUMENT_EXTRACT_KIND,
  EXTRACTION_FAILED,
  FILE_CONTENT_MISMATCH,
  FILE_SOURCE_UNREACHABLE,
  documentExtractHandler,
  enqueueDocumentExtractions,
} from '../src/files/extract-work.js';
import { DOCUMENT_EXTRACTOR_VERSION, type DocumentExtractor } from '../src/files/extractors.js';
import { TEXT_MEDIA_TYPE } from '../src/files/text-extractor.js';
import type { Clock } from '../src/ports/clock.js';
import type { FileStore } from '../src/ports/file-store.js';
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
 * `document_extract` through a whole brain: the step that queues the files and
 * the handler that reads them (AD-21, AD-24).
 *
 * Every case here runs `brain.queue.drain`, because what is being checked is the
 * seam between the two halves — a file that was stored is queued, read, cut and
 * closed by one drain, and a file that has been answered is not queued again.
 * The store and the file store are the in-memory fakes; a read that fails is a
 * fake file store with a gate in front of it, which is the only way to ask what
 * a brain does when the bytes are briefly out of reach.
 *
 * Two rows of the matrix are deliberately elsewhere: a redacted file, because
 * only an adapter with the column can be held to it
 * (`packages/sqlite/test/document-extract.test.ts`), and the command end to end
 * (`apps/cli/test/sessions-ingest.test.ts`).
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');
const NOTE = '# 제목\n\n본문 첫 줄입니다.\n본문 둘째 줄입니다.\n';

/** A clock a case can move, for the backing off of a temporary failure. */
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

/** What a gated file store is told to answer, and what it was asked. */
interface FilesGate {
  /** `null` to pass the call through to the fake underneath. */
  fail?: 'FILES_UNAVAILABLE' | 'FILE_NOT_FOUND' | 'LOCATION_REFUSED' | null;
  /** Bytes to hand back instead of the stored ones, for the corruption case. */
  substitute?: Uint8Array | null;
  /** How many times `get` was called, so a case can ask that it was not. */
  gets: number;
}

/**
 * The fake file store with one switch in front of its `get`.
 *
 * Only `get` is gated, because that is the one call the extraction worker
 * makes: everything else in here is the ingest's, and a gate on it would be
 * testing the ingest.
 */
function gatedFiles(inner: FileStore, gate: FilesGate): FileStore {
  return {
    ...inner,
    async get(location) {
      gate.gets += 1;
      if (gate.fail !== undefined && gate.fail !== null) {
        return { ok: false, code: gate.fail, message: `${gate.fail} 라고 답하도록 했습니다` };
      }
      if (gate.substitute !== undefined && gate.substitute !== null) {
        return { ok: true, bytes: gate.substitute };
      }
      return inner.get(location);
    },
  };
}

interface Kit {
  brain: Brain;
  store: MemoryStore;
  files: FileStore;
  gate: FilesGate;
  clock: MovableClock;
  idGen: { next(): string };
  /** Where the bytes of the stored file live, for a case that removes them. */
  home: FileLocation;
  fileId: string;
}

interface KitOptions {
  /** The attachment's bytes. */
  bytes?: Uint8Array;
  /** The size the ingest records, when a case wants it to differ (too_large). */
  sizeBytes?: number;
  /** Wrapped around the memory store, for a store verb that has to refuse. */
  wrap?: (store: Store & SchemaStore) => Store & SchemaStore;
}

/**
 * A brain with one stored text attachment and nothing else to do: no transcript
 * folders, so the scan queues nothing, and a session that already carries a cwd,
 * so the identity step has no candidate. Whatever the drain reports is therefore
 * about this story alone.
 */
async function kit(options: KitOptions = {}): Promise<Kit> {
  const bytes = options.bytes ?? utf8Bytes(NOTE);
  const store = memoryStore();
  const clock = movableClock(NOW);
  const idGen = sequenceIdGen({ start: 7000, timestampMs: NOW.getTime() });
  const inner = memoryFileStore();
  const gate: FilesGate = { gets: 0 };
  const files = gatedFiles(inner, gate);

  expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  expect(
    await store.ensureSession(sampleEnsureSessionInput({ firstCwd: '/demo/repo' })),
  ).toMatchObject({ ok: true });

  // The bytes go in the way the ingest puts them there: the file store first,
  // then the row that names where they went (AD-7).
  const put = await inner.put(bytes);
  if (!put.ok) throw new Error(put.message);
  const batch = sampleIngestBatch();
  const message = batch.messages[0];
  if (message === undefined) throw new Error('표본 묶음에 메시지가 없습니다');
  const attachments: IngestAttachment[] = [
    {
      id: idGen.next(),
      harnessMessageId: message.harnessMessageId,
      ordinal: 0,
      sourceKind: 'file',
      sourceRef: '~/notes/report.md',
      displayName: 'report.md',
      file: {
        id: idGen.next(),
        contentHash: put.contentHash,
        sizeBytes: options.sizeBytes ?? bytes.length,
        location: { id: idGen.next(), ...put.location },
        external: null,
      },
    },
  ];
  expect(await store.ingest({ ...batch, attachments })).toMatchObject({ ok: true });
  const rows = await store.listMessageAttachments(message.id);
  if (!rows.ok) throw new Error(rows.message);
  const file = rows.attachments[0]?.file ?? null;
  if (file === null || file.home === null) throw new Error('첨부가 파일 행을 만들지 않았습니다');

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
  return {
    brain: createBrain(dependencies),
    store,
    files,
    gate,
    clock,
    idGen,
    home: file.home,
    fileId: file.id,
  };
}

/** One drain run with the command budget, which is every case's drain. */
async function drain(kit: Kit, handlers?: Parameters<Brain['queue']['drain']>[0]['handlers']) {
  return kit.brain.queue.drain({
    budgetMs: DRAIN_BUDGET_MS.command,
    ...(handlers === undefined ? {} : { handlers }),
  });
}

/** The file's generations, newest last, as the store holds them. */
async function generations(kit: Kit) {
  const read = await kit.store.listExtractions(kit.fileId);
  if (!read.ok) throw new Error(read.message);
  return read.extractions;
}

/** The pieces of the file's current generation, in order. */
async function currentChunks(kit: Kit) {
  const state = await kit.store.readFileExtractionState(kit.fileId);
  if (!state.ok) throw new Error(state.message);
  if (state.currentExtractionId === null) return [];
  const read = await kit.store.listExtractionChunks(state.currentExtractionId);
  if (!read.ok) throw new Error(read.message);
  return read.chunks;
}

/** The file's open failure rows, which most paths must not create. */
function fileFailures(kit: Kit) {
  return kit.store.snapshot().failures.filter((failure) => failure.targetKind === 'file');
}

function extractItems(kit: Kit) {
  return kit.store.snapshot().workItems.filter((item) => item.kind === DOCUMENT_EXTRACT_KIND);
}

describe('drain이 붙인 텍스트 문서를 조각으로 만든다', () => {
  it('txt·md를 ok 세대와 text 위치의 조각과 포인터로 남긴다', async () => {
    const subject = await kit();

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, completed: 1, failed: 0, stopped: 'empty' });
    const [generation] = await generations(subject);
    expect(generation).toMatchObject({
      fileId: subject.fileId,
      attempt: 1,
      status: 'ok',
      mediaType: TEXT_MEDIA_TYPE,
      extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
      indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID,
      failedStage: null,
    });
    const state = await subject.store.readFileExtractionState(subject.fileId);
    expect(state).toMatchObject({ ok: true, currentExtractionId: generation?.id });

    const chunks = await currentChunks(subject);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({
      ordinal: 0,
      body: NOTE,
      page: null,
      chunkLocator: { type: 'text', start: 0, end: Array.from(NOTE).length },
    });
    expect(fileFailures(subject)).toEqual([]);
  });

  it('조각이 한 배치보다 많아도 모두 한 세대에 들어간다', async () => {
    // Long enough for more than two hundred pieces, which is more than one
    // `appendExtractionChunks` may carry: `writeExtractionChunks` cuts it into
    // batches and they all belong to the one generation (AD-7, AD-24).
    const text = '문서 내용 '.repeat(50_000);
    const subject = await kit({ bytes: utf8Bytes(text) });

    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1 });

    const rows = await generations(subject);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe('ok');
    const chunks = await currentChunks(subject);
    expect(chunks.length).toBeGreaterThan(200);
    expect(chunks.map((chunk) => chunk.ordinal)).toEqual(
      chunks.map((_unused, index) => index),
    );
    // The last piece ends where the document does, so nothing was lost between
    // the batches.
    expect(chunks.at(-1)?.chunkLocator).toMatchObject({
      type: 'text',
      end: Array.from(text).length,
    });
    expect(fileFailures(subject)).toEqual([]);
  });

  it('두 번째 drain은 새 일감도 새 시도도 만들지 않는다', async () => {
    const subject = await kit();
    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1 });
    const after = { items: extractItems(subject), rows: await generations(subject) };
    const chunks = await currentChunks(subject);

    const second = await drain(subject);

    expect(second).toMatchObject({ claimed: 0, completed: 0, stopped: 'empty' });
    expect(extractItems(subject)).toEqual(after.items);
    expect(await generations(subject)).toEqual(after.rows);
    expect(await currentChunks(subject)).toEqual(chunks);
  });

  it('이름만 txt인 바이너리는 unsupported로 한 번에 닫히고 실패 행을 남기지 않는다', async () => {
    // A real PNG header. The display name says `.md`, and nothing reads it: the
    // format is decided from the content alone (Boundaries).
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
    const subject = await kit({ bytes: png });

    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    const [generation] = await generations(subject);
    expect(generation).toMatchObject({ status: 'unsupported', mediaType: null, failedStage: null });
    const state = await subject.store.readFileExtractionState(subject.fileId);
    expect(state).toMatchObject({ ok: true, currentExtractionId: null });
    expect(fileFailures(subject)).toEqual([]);
    // One attempt, and the item is closed: the generation row is what keeps the
    // next drain from asking again.
    expect(extractItems(subject)).toHaveLength(1);
    expect(extractItems(subject)[0]).toMatchObject({ attempts: 1 });
    expect(await drain(subject)).toMatchObject({ claimed: 0 });
  });

  it('상한을 넘는 크기는 바이트를 읽지도 않고 too_large로 닫는다', async () => {
    const subject = await kit({ sizeBytes: DOCUMENT_EXTRACT_MAX_BYTES + 1 });

    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    expect((await generations(subject))[0]).toMatchObject({
      status: 'too_large',
      mediaType: null,
    });
    // The point of checking the recorded size: eight mebibytes are never read
    // into memory to find out that they are eight mebibytes.
    expect(subject.gate.gets).toBe(0);
    expect(fileFailures(subject)).toEqual([]);
  });
});

describe('추출이 실패하는 길', () => {
  it('일시 읽기 실패는 열 번 다시 하고 그 뒤에 파일 실패를 기록한다', async () => {
    const subject = await kit();
    subject.gate.fail = 'FILES_UNAVAILABLE';

    for (let attempt = 1; attempt < MAX_WORK_ATTEMPTS; attempt += 1) {
      expect(await drain(subject)).toMatchObject({ claimed: 1, retried: 1, failed: 0 });
      // Nothing recorded yet: a store that cannot answer right now is somebody
      // else's hiccup, and the record is for the tenth time it happens (AD-21).
      expect(fileFailures(subject)).toEqual([]);
      expect((await generations(subject)).at(-1)).toMatchObject({
        status: 'failed',
        failedStage: 'read',
      });
      // The long wait of the kind, so nothing is due until the clock moves.
      expect(await drain(subject)).toMatchObject({ claimed: 0, stopped: 'empty' });
      subject.clock.advance(900_000);
    }

    expect(await drain(subject)).toMatchObject({ claimed: 1, failed: 1, retried: 0 });
    const [recorded] = fileFailures(subject);
    expect(recorded).toMatchObject({
      targetKind: 'file',
      targetId: subject.fileId,
      stage: DOCUMENT_EXTRACT_KIND,
      code: 'FILES_UNAVAILABLE',
      resolvedAt: null,
    });
    expect(extractItems(subject)[0]).toMatchObject({ attempts: MAX_WORK_ATTEMPTS });
    // Every attempt left a generation, and none of them is current.
    expect((await generations(subject)).length).toBe(MAX_WORK_ATTEMPTS);
    expect(await currentChunks(subject)).toEqual([]);

    // The bytes come back, `failures retry` asks again, and the drain at the end
    // of that command is what actually does it (FR-5).
    subject.gate.fail = null;
    expect(await subject.brain.failures.retry()).toMatchObject({ ok: true, added: 1 });
    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1 });

    const rows = await generations(subject);
    // The success swept every closed generation away with it (AD-24).
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'ok', attempt: MAX_WORK_ATTEMPTS + 1 });
    expect((await currentChunks(subject))[0]?.body).toBe(NOTE);
    expect(fileFailures(subject)[0]?.resolvedAt).toEqual(subject.clock.now());
  });

  it('원본이 사라지면 옛 조각을 그대로 두고 닿을 수 없다고 표시한다', async () => {
    const subject = await kit();
    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1 });
    const good = (await generations(subject))[0];
    const chunks = await currentChunks(subject);
    expect(chunks).toHaveLength(1);

    // The blob goes, and a new item arrives — which is what `failures retry` or
    // a later story's version bump would create.
    expect(await subject.files.delete(subject.home)).toMatchObject({ ok: true, deleted: true });
    expect(
      await subject.store.addWork({
        id: subject.idGen.next(),
        kind: DOCUMENT_EXTRACT_KIND,
        targetKind: 'file',
        targetId: subject.fileId,
        createdAt: subject.clock.now(),
        nextAttemptAt: subject.clock.now(),
      }),
    ).toMatchObject({ ok: true, created: true });

    expect(await drain(subject)).toMatchObject({ claimed: 1, failed: 1 });

    expect(fileFailures(subject)[0]).toMatchObject({
      code: FILE_SOURCE_UNREACHABLE,
      stage: DOCUMENT_EXTRACT_KIND,
    });
    const state = await subject.store.readFileExtractionState(subject.fileId);
    expect(state).toMatchObject({ ok: true, sourceUnreachableAt: subject.clock.now() });
    // The pointer and the text of the reading that worked are untouched: a file
    // whose bytes are gone keeps answering searches (AD-24).
    expect(state).toMatchObject({ currentExtractionId: good?.id });
    expect(await currentChunks(subject)).toEqual(chunks);

    // The next drain does not queue it, and an item that arrives anyway opens no
    // generation at all.
    expect(await drain(subject)).toMatchObject({ claimed: 0, stopped: 'empty' });
    const before = await generations(subject);
    expect(
      await subject.store.addWork({
        id: subject.idGen.next(),
        kind: DOCUMENT_EXTRACT_KIND,
        targetKind: 'file',
        targetId: subject.fileId,
        createdAt: subject.clock.now(),
        nextAttemptAt: subject.clock.now(),
      }),
    ).toMatchObject({ ok: true, created: true });
    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1 });
    expect(await generations(subject)).toEqual(before);
  });

  it('바이트의 해시가 다르면 손상으로 한 번에 기록한다', async () => {
    const subject = await kit();
    subject.gate.substitute = utf8Bytes('다른 내용입니다');

    expect(await drain(subject)).toMatchObject({ claimed: 1, failed: 1, retried: 0 });

    expect((await generations(subject))[0]).toMatchObject({
      status: 'failed',
      failedStage: 'read',
    });
    expect(fileFailures(subject)[0]).toMatchObject({ code: FILE_CONTENT_MISMATCH });
    // Recorded on the first failure: another attempt would read the same wrong
    // bytes (AD-21).
    expect(extractItems(subject)[0]).toMatchObject({ attempts: 1, completedAt: expect.anything() });
  });

  it('추출기가 읽지 못하면 extract 단계의 실패로 기록한다', async () => {
    const subject = await kit();
    const broken: DocumentExtractor = {
      name: 'broken',
      detect: () => 'text/broken',
      extract: async () => ({ ok: false, message: '시험용 추출기가 멈췄습니다' }),
    };

    // The one call's handlers, which is the seam the handler factory's
    // `extractors` argument exists for.
    const report = await drain(subject, {
      [DOCUMENT_EXTRACT_KIND]: documentExtractHandler({
        store: subject.store,
        files: subject.files,
        clock: subject.clock,
        idGen: subject.idGen,
        extractors: [broken],
      }),
    });

    expect(report).toMatchObject({ claimed: 1, failed: 1 });
    expect((await generations(subject))[0]).toMatchObject({
      status: 'failed',
      failedStage: 'extract',
      mediaType: 'text/broken',
    });
    expect(fileFailures(subject)[0]).toMatchObject({ code: EXTRACTION_FAILED });
    // The extractor's sentence is kept, and the attachment's text is not.
    expect(fileFailures(subject)[0]?.message).toContain('시험용 추출기가 멈췄습니다');
    expect(fileFailures(subject)[0]?.message).not.toContain('본문');
  });

  it('begin이 DB_LOCKED면 일감을 돌려주고 시도를 되돌린다', async () => {
    const subject = await kit({
      wrap: (store) => ({
        ...store,
        async beginExtraction() {
          return { ok: false, code: 'DB_LOCKED', message: '데이터베이스가 잠겼습니다' };
        },
      }),
    });

    const report = await drain(subject);

    expect(report).toMatchObject({
      claimed: 1,
      released: 1,
      failed: 0,
      stopped: 'unwritable',
      code: 'DB_LOCKED',
    });
    // Nothing was tried, so nothing was attempted (AD-21), and the file is still
    // waiting to be read.
    expect(extractItems(subject)[0]).toMatchObject({ attempts: 0, completedAt: null });
    expect(await generations(subject)).toEqual([]);
    expect(fileFailures(subject)).toEqual([]);
    expect(await subject.store.listFilesAwaitingExtraction({ limit: 10 })).toEqual({
      ok: true,
      fileIds: [subject.fileId],
    });
  });
});

describe('조각 설정', () => {
  it('세대가 남기는 설정 id는 0002가 심은 행의 것이고 자른 값과 같다', async () => {
    // The constant and the seeded row are kept in step by hand, because no verb
    // reads `index_configs`: the reading records the id and cuts with the
    // constant (`domain/document.ts`).
    expect(DOCUMENT_CHUNK_PARAMS).toEqual({ targetChars: 1200, overlapChars: 120 });
    expect(DOCUMENT_CHUNK_INDEX_CONFIG_ID).toBe('019a0000-0000-7000-8000-000000000002');
    const subject = await kit();
    await drain(subject);
    expect((await generations(subject))[0]?.indexConfigId).toBe(DOCUMENT_CHUNK_INDEX_CONFIG_ID);
  });

  it('넣기 단계는 마감이 지나면 더 넣지 않는다', async () => {
    // Every `addWork` is a write transaction, so the loop asks the clock before
    // each one: an opportunistic two-second run must not spend its budget
    // queueing a backlog (AD-7). The files it did not get to are still the
    // files nothing has read, so the next drain's own read finds them.
    const subject = await kit();
    const now = subject.clock.now();

    await enqueueDocumentExtractions(
      { store: subject.store, clock: subject.clock, idGen: subject.idGen },
      { deadline: now.getTime() },
    );

    expect(extractItems(subject)).toEqual([]);
    expect(await subject.store.listFilesAwaitingExtraction({ limit: 10 })).toEqual({
      ok: true,
      fileIds: [subject.fileId],
    });

    // One millisecond of budget is enough for the one file there is.
    await enqueueDocumentExtractions(
      { store: subject.store, clock: subject.clock, idGen: subject.idGen },
      { deadline: now.getTime() + 1 },
    );
    expect(extractItems(subject)).toHaveLength(1);
  });

  it('빈 텍스트는 조각 없이 ok로 닫힌다', async () => {
    const subject = await kit({ bytes: utf8Bytes('') });

    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1 });

    expect((await generations(subject))[0]).toMatchObject({
      status: 'ok',
      mediaType: TEXT_MEDIA_TYPE,
    });
    expect(await currentChunks(subject)).toEqual([]);
    expect(fileFailures(subject)).toEqual([]);
  });

  it('바이트의 해시는 수집 때의 것과 같아야 읽는다', async () => {
    // The guard is on the hash the row carries and not on a second hash of the
    // same bytes: what it protects against is the location holding something
    // else now.
    const subject = await kit();
    const state = await subject.store.readFileExtractionState(subject.fileId);
    expect(state).toMatchObject({ ok: true, contentHash: contentHashOfBytes(utf8Bytes(NOTE)) });
  });
});
