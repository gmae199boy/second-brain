import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  DOCUMENT_EXTRACTOR_VERSION,
  DOCUMENT_EXTRACT_KIND,
  DRAIN_BUDGET_MS,
  documentExtractHandler,
  drainQueue,
  enqueueDocumentExtractions,
  type FileLocation,
  type FileStore,
  type IngestAttachment,
  type SchemaStore,
  type Store,
} from '@second-brain/core';
import {
  fixedClock,
  memoryFileStore,
  memorySpool,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
  sequenceIdGen,
} from '@second-brain/core/testing';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';
import { withWrite } from '../src/write.js';

/**
 * Reading a stored attachment on the real file: the queueing step, Core's
 * handler and this package's generation store together (AD-24).
 *
 * The two things only a real database can be held to are what is here. The
 * pieces land in the keyword index of 0002, which is what makes a document
 * findable at all and which the in-memory fake has nothing like. And a redacted
 * file is neither queued nor opened — the column is this schema's, and the fake
 * has no file redaction at all (port contract).
 */

const NOW = new Date('2026-03-04T05:06:07.000Z');
/** An ASCII needle, so the default FTS tokenizer certainly makes a token of it. */
const NOTE = '# Report\n\nneedlebody first line.\nsecond line.\n';

const directories: string[] = [];
const stores: (Store & SchemaStore)[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function migratedPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-extract-'));
  directories.push(directory);
  const path = join(directory, 'brain.db');
  expect(await runSqliteMigrations({ path })).toMatchObject({ ok: true });
  return path;
}

interface Kit {
  path: string;
  store: Store & SchemaStore;
  files: FileStore;
  clock: ReturnType<typeof fixedClock>;
  idGen: { next(): string };
  fileId: string;
  home: FileLocation;
}

/**
 * An installed brain's database with one stored text attachment, made the way
 * the ingest makes it: the bytes into the file store first, then the rows.
 */
async function kit(bytes = Buffer.from(NOTE, 'utf8')): Promise<Kit> {
  const path = await migratedPath();
  const store = sqliteStore({ path });
  stores.push(store);
  const files = memoryFileStore();
  const clock = fixedClock(NOW);
  const idGen = sequenceIdGen({ start: 8000, timestampMs: NOW.getTime() });

  expect(await store.ensureSelfUser(sampleSelfUserInput())).toMatchObject({ ok: true });
  expect(
    await store.ensureSession(sampleEnsureSessionInput({ firstCwd: '/demo/repo' })),
  ).toMatchObject({ ok: true });

  const put = await files.put(Uint8Array.from(bytes));
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
        sizeBytes: bytes.length,
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

  return { path, store, files, clock, idGen, fileId: file.id, home: file.home };
}

/**
 * The two halves of one drain run, with nothing else in the way: queue what is
 * waiting, then work the queue with the one handler this story adds.
 *
 * `extractorVersion` goes to both halves at once, because what a build is is
 * one version: a case that gave the queueing step one and the handler another
 * would be a build that disagrees with itself. Given, it is how a case makes
 * the generation an older build would have left behind.
 *
 * The answer carries the queueing step's own counts under `reextract`, which
 * are the files it met and could not queue at all (`files/extract-work.ts`).
 */
async function drain(subject: Kit, options: { extractorVersion?: string } = {}) {
  const { store, files, clock, idGen } = subject;
  const version =
    options.extractorVersion === undefined ? {} : { extractorVersion: options.extractorVersion };
  const reextract = await enqueueDocumentExtractions(
    { store, clock, idGen },
    { deadline: clock.now().getTime() + DRAIN_BUDGET_MS.command, ...version },
  );
  const queue = await drainQueue(
    { store, spool: memorySpool(), clock, idGen },
    {
      budgetMs: DRAIN_BUDGET_MS.command,
      handlers: {
        [DOCUMENT_EXTRACT_KIND]: documentExtractHandler({ store, files, clock, idGen, ...version }),
      },
    },
  );
  return { ...queue, reextract };
}

async function onConnection<T>(path: string, use: (database: DatabaseSync) => T): Promise<T> {
  const connection = openConnection(path);
  try {
    return use(connection.database);
  } finally {
    await connection.close();
  }
}

function openConnection(path: string): SqliteConnection {
  const opened = openSqlite({ path, busyTimeoutMs: 3000 });
  if (!opened.ok) throw new Error(opened.message);
  return opened.connection;
}

/** How many pieces the keyword index of 0002 finds for one needle. */
async function ftsMatches(path: string, needle: string): Promise<number> {
  return onConnection(path, (database) => {
    const row = database
      .prepare('select count(*) as n from document_chunks_fts where document_chunks_fts match ?')
      .get(`"${needle}"`) as { n: number } | undefined;
    return row?.n ?? 0;
  });
}

describe('SQLite에서 drain이 텍스트 첨부를 조각으로 만든다', () => {
  it('조각 본문이 fts로 찾히고 위치는 text 범위로 남는다', async () => {
    const subject = await kit();

    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    const state = await subject.store.readFileExtractionState(subject.fileId);
    expect(state).toMatchObject({ ok: true, sourceUnreachableAt: null });
    if (!state.ok || state.currentExtractionId === null) throw new Error('포인터가 없습니다');
    const chunks = await subject.store.listExtractionChunks(state.currentExtractionId);
    expect(chunks).toMatchObject({ ok: true });
    if (!chunks.ok) return;
    expect(chunks.chunks).toHaveLength(1);
    expect(chunks.chunks[0]).toMatchObject({
      ordinal: 0,
      body: NOTE,
      page: null,
      chunkLocator: { type: 'text', start: 0, end: Array.from(NOTE).length },
    });
    // The column holds the codec's one spelling, which is what the row says
    // rather than what the type says (`domain/chunk-locator.ts`).
    const stored = await onConnection(subject.path, (database) =>
      database
        .prepare('select chunk_locator, page from document_chunks')
        .all() as { chunk_locator: string; page: number | null }[],
    );
    expect(stored).toEqual([
      { chunk_locator: `{"type":"text","start":0,"end":${String(Array.from(NOTE).length)}}`, page: null },
    ]);
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(1);

    // And a second run has nothing to do: the generation row is what keeps the
    // file out of the queueing step's read.
    expect(await drain(subject)).toMatchObject({ claimed: 0, stopped: 'empty' });
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(1);
  });

  it('가린 파일은 넣지도 않고 일감이 와도 세대를 열지 않는다', async () => {
    const subject = await kit();

    // The redaction transaction of AD-11 — the only thing allowed to fill
    // `redacted_at`, and on a connection of its own because the marker the
    // triggers consult belongs to the connection that raised it.
    const connection = openConnection(subject.path);
    try {
      const written = await withWrite(
        connection,
        async (db) => {
          await sql`update files set redacted_at = ${'2026-01-01T00:00:00.000Z'} where id = ${subject.fileId}`.execute(db);
        },
        { redact: true },
      );
      expect(written).toMatchObject({ ok: true });
    } finally {
      await connection.close();
    }

    // Not queued: the read that feeds the queue leaves a redacted file out.
    expect(await subject.store.listFilesAwaitingExtraction({ limit: 10 })).toEqual({
      ok: true,
      fileIds: [],
    });
    expect(await drain(subject)).toMatchObject({ claimed: 0, stopped: 'empty' });

    // And an item that arrives anyway — from `failures retry`, or from a build
    // that queued it before the redaction — closes without opening a reading.
    expect(
      await subject.store.addWork({
        id: subject.idGen.next(),
        kind: DOCUMENT_EXTRACT_KIND,
        targetKind: 'file',
        targetId: subject.fileId,
        createdAt: NOW,
        nextAttemptAt: NOW,
      }),
    ).toMatchObject({ ok: true, created: true });
    expect(await drain(subject)).toMatchObject({ claimed: 1, completed: 1, failed: 0 });

    expect(await subject.store.listExtractions(subject.fileId)).toEqual({
      ok: true,
      extractions: [],
    });
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(0);
    const failures = await subject.store.listFailures({ targetKind: 'file' });
    expect(failures).toMatchObject({ ok: true, failures: [] });
  });
});

describe('SQLite에서 버전이 오르면 다시 읽고 읽을 수 없는 것은 센다', () => {
  it('새 세대의 조각이 fts로 찾히고 옛 세대와 그 조각은 사라진다', async () => {
    const subject = await kit();
    // The reading an older build left behind, which is the state this path is
    // about: a successful generation stamped with another version.
    expect(await drain(subject, { extractorVersion: 'doc/0' })).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(1);

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 1, completed: 1, failed: 0 });
    expect(report.reextract).toEqual({ redacted: 0, sourceUnreachable: 0 });
    const rows = await subject.store.listExtractions(subject.fileId);
    expect(rows).toMatchObject({ ok: true });
    if (!rows.ok) return;
    // The replacement closed itself, moved the pointer and then took the older
    // generation's pieces and row away, so the keyword index holds the new
    // reading's text exactly once (AD-24).
    expect(rows.extractions).toHaveLength(1);
    expect(rows.extractions[0]).toMatchObject({
      attempt: 2,
      status: 'ok',
      extractorVersion: DOCUMENT_EXTRACTOR_VERSION,
    });
    const state = await subject.store.readFileExtractionState(subject.fileId);
    expect(state).toMatchObject({ ok: true, currentExtractionId: rows.extractions[0]?.id });
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(1);
    expect(
      await onConnection(
        subject.path,
        (database) =>
          (database.prepare('select count(*) as n from document_chunks').get() as { n: number }).n,
      ),
    ).toBe(1);

    // And the drain after that has nothing to do: the generation of this
    // version is what keeps the file out of the read.
    const third = await drain(subject);
    expect(third).toMatchObject({ claimed: 0, stopped: 'empty' });
    expect(third.reextract).toEqual({ redacted: 0, sourceUnreachable: 0 });
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(1);
  });

  it('뒤처진 파일이 가려졌으면 넣지 않고 redacted로 센다', async () => {
    const subject = await kit();
    expect(await drain(subject, { extractorVersion: 'doc/0' })).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    const before = await subject.store.listExtractions(subject.fileId);

    // The redaction transaction of AD-11, which is the only thing allowed to
    // fill `redacted_at`, on a connection of its own: the marker the triggers
    // consult belongs to the connection that raised it.
    const connection = openConnection(subject.path);
    try {
      expect(
        await withWrite(
          connection,
          async (db) => {
            await sql`update files set redacted_at = ${'2026-01-01T00:00:00.000Z'} where id = ${subject.fileId}`.execute(db);
          },
          { redact: true },
        ),
      ).toMatchObject({ ok: true });
    } finally {
      await connection.close();
    }

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 0, stopped: 'empty' });
    // Only an adapter with the column can be held to this one: the in-memory
    // fake has no file redaction and always answers zero (port contract).
    expect(report.reextract).toEqual({ redacted: 1, sourceUnreachable: 0 });
    expect(await subject.store.listExtractions(subject.fileId)).toEqual(before);
  });

  it('뒤처진 파일의 원본에 닿을 수 없으면 넣지 않고 세어서 조각을 그대로 둔다', async () => {
    const subject = await kit();
    expect(await drain(subject, { extractorVersion: 'doc/0' })).toMatchObject({
      claimed: 1,
      completed: 1,
    });
    const before = await subject.store.listExtractions(subject.fileId);
    expect(
      await subject.store.setFileSourceUnreachable({
        fileId: subject.fileId,
        unreachableAt: NOW,
      }),
    ).toEqual({ ok: true });

    const report = await drain(subject);

    expect(report).toMatchObject({ claimed: 0, stopped: 'empty' });
    expect(report.reextract).toEqual({ redacted: 0, sourceUnreachable: 1 });
    // The pieces of the last reading that worked keep answering searches, which
    // is the whole reason the mark touches that column and nothing else.
    expect(await subject.store.listExtractions(subject.fileId)).toEqual(before);
    expect(await ftsMatches(subject.path, 'needlebody')).toBe(1);
  });
});
