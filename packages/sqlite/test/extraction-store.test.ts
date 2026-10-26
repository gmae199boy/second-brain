import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import {
  DOCUMENT_CHUNK_BATCH_MAX,
  DOCUMENT_CHUNK_INDEX_CONFIG_ID,
  encodeChunkLocator,
  workKindPolicy,
  type ChunkLocator,
  type ExtractionChunkInput,
  type ExtractionClaim,
  type SchemaStore,
  type Store,
} from '@second-brain/core';
import { extractionStoreContract } from '@second-brain/core/testing';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';
import { withWrite } from '../src/write.js';

/**
 * The extraction capability against the file this package writes: the shared
 * contract, and the things only a real database can be held to — that a
 * generation's text leaves the keyword index when its rows go, that the stored
 * locator is the codec's own spelling, that a redacted file is refused, and that
 * a full batch fits inside the two-second rule (AD-7, AD-24).
 */

const AT = '2026-01-01T00:00:00.000Z';
const T0 = new Date('2026-03-04T05:06:07.000Z');
const EXTRACT_KIND = 'document_extract';
const CLAIM_FOR_MS = workKindPolicy(EXTRACT_KIND).claimForMs;
const FILE_ID = '01980000-0000-7000-8000-000000000001';

const directories: string[] = [];
const stores: (Store & SchemaStore)[] = [];

afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-extractions-'));
  directories.push(directory);
  return directory;
}

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const migrated = await runSqliteMigrations({ path });
  expect(migrated.ok).toBe(true);
  return path;
}

function freshStore(path: string): Store & SchemaStore {
  const store = sqliteStore({ path });
  stores.push(store);
  return store;
}

/**
 * A database with one `files` row, written straight in.
 *
 * The attachment path that normally creates it is the attachment contract's
 * subject; what these cases need is content to extract, so the row goes in
 * directly and the case stays about extraction.
 */
async function seeded(): Promise<{ path: string; store: Store & SchemaStore }> {
  const path = await migratedPath();
  await onConnection(path, (database) => {
    database.exec(`
      insert into files (id, content_hash, size_bytes, first_seen_at)
           values ('${FILE_ID}', 'sha256:' || printf('%064d', 1), 1024, '${AT}');
    `);
  });
  return { path, store: freshStore(path) };
}

/** Borrow a connection of our own, for the raw reads and the redaction write. */
async function onConnection<T>(
  path: string,
  use: (database: DatabaseSync) => T | Promise<T>,
): Promise<T> {
  const connection = openConnection(path);
  try {
    return await use(connection.database);
  } finally {
    await connection.close();
  }
}

function openConnection(path: string): SqliteConnection {
  const opened = openSqlite({ path, busyTimeoutMs: 3000 });
  if (!opened.ok) throw new Error(opened.message);
  return opened.connection;
}

/** Take the extraction claim on the seeded file, as a drain run does. */
async function takeClaim(
  store: Store,
  input: { workItemId: string; now: Date; claimedBy: string },
): Promise<ExtractionClaim> {
  expect(
    await store.addWork({
      id: input.workItemId,
      kind: EXTRACT_KIND,
      targetKind: 'file',
      targetId: FILE_ID,
      createdAt: input.now,
      nextAttemptAt: input.now,
    }),
  ).toMatchObject({ ok: true });
  const claimed = await store.claimWork({
    now: input.now,
    kinds: [EXTRACT_KIND],
    claimedBy: input.claimedBy,
  });
  if (!claimed.ok || claimed.item === null) throw new Error('추출 일감을 청구하지 못했습니다');
  return { workItemId: claimed.item.id, claimedBy: input.claimedBy };
}

function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** Past `FILE_ID`, so no minted id can collide with the seeded file's. */
let nextId = 100;
function id(): string {
  nextId += 1;
  return `01980000-0000-7000-8000-${String(nextId).padStart(12, '0')}`;
}

function textChunk(ordinal: number, body: string): ExtractionChunkInput {
  return {
    id: id(),
    ordinal,
    body,
    chunkLocator: { type: 'text', start: ordinal * 100, end: ordinal * 100 + body.length },
    page: null,
  };
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

describe('SQLite 추출 세대 계약', () => {
  for (const testCase of extractionStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => freshStore(await migratedPath()));
    });
  }
});

describe('the SQLite extraction store and the schema behind it', () => {
  it('지워진 세대의 본문은 fts에서도 사라지고 현재 세대의 본문만 찾힌다', async () => {
    const { path, store } = await seeded();
    const claim = await takeClaim(store, { workItemId: id(), now: T0, claimedBy: 'drain-a' });

    // A reading that is replaced by a newer one.
    const replaced = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-1', startedAt: at(1), claim,
    });
    if (!replaced.ok) throw new Error(replaced.message);
    expect(
      await store.appendExtractionChunks({
        extractionId: replaced.extraction.id,
        chunks: [textChunk(0, 'replacedbody')],
      }),
    ).toEqual({ ok: true, appended: 1 });
    expect(await ftsMatches(path, 'replacedbody')).toBe(1);
    expect(
      await store.finishExtraction({
        extractionId: replaced.extraction.id,
        finishedAt: at(2),
        outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: null },
      }),
    ).toMatchObject({ ok: true, current: true });

    // The reading that takes over.
    const current = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-2', startedAt: at(3), claim,
    });
    if (!current.ok) throw new Error(current.message);
    expect(
      await store.appendExtractionChunks({
        extractionId: current.extraction.id,
        chunks: [textChunk(0, 'currentbody')],
      }),
    ).toEqual({ ok: true, appended: 1 });
    expect(
      await store.finishExtraction({
        extractionId: current.extraction.id,
        finishedAt: at(4),
        outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: null },
      }),
    ).toMatchObject({ ok: true, current: true });

    // A reading that failed.
    const failed = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-2', startedAt: at(5), claim,
    });
    if (!failed.ok) throw new Error(failed.message);
    expect(
      await store.appendExtractionChunks({
        extractionId: failed.extraction.id,
        chunks: [textChunk(0, 'failedbody')],
      }),
    ).toEqual({ ok: true, appended: 1 });
    expect(
      await store.finishExtraction({
        extractionId: failed.extraction.id,
        finishedAt: at(6),
        outcome: { status: 'failed', failedStage: 'chunk', error: '멈췄습니다', mediaType: 'text/plain' },
      }),
    ).toMatchObject({ ok: true, current: false });

    // And a reading whose claim expired, closed by the next one.
    const stale = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-2', startedAt: at(7), claim,
    });
    if (!stale.ok) throw new Error(stale.message);
    expect(
      await store.appendExtractionChunks({
        extractionId: stale.extraction.id,
        chunks: [textChunk(0, 'stalebody')],
      }),
    ).toEqual({ ok: true, appended: 1 });
    const later = at(CLAIM_FOR_MS);
    const second = await takeClaim(store, {
      workItemId: claim.workItemId, now: later, claimedBy: 'drain-b',
    });
    const recovered = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-2', startedAt: later, claim: second,
    });
    expect(recovered).toMatchObject({ ok: true, closedStale: { id: stale.extraction.id, status: 'failed' } });

    for (const gone of ['replacedbody', 'failedbody', 'stalebody']) {
      expect(await ftsMatches(path, gone)).toBe(0);
    }
    expect(await ftsMatches(path, 'currentbody')).toBe(1);
    // The index is external content: the rows it was built from are the measure.
    const chunkCount = await onConnection(path, (database) =>
      (database.prepare('select count(*) as n from document_chunks').get() as { n: number }).n,
    );
    expect(chunkCount).toBe(1);
  });

  it('저장된 chunk_locator와 page는 코덱의 출력과 같다', async () => {
    const { path, store } = await seeded();
    const claim = await takeClaim(store, { workItemId: id(), now: T0, claimedBy: 'drain-a' });
    const begun = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'pdf-1', startedAt: at(1), claim,
    });
    if (!begun.ok) throw new Error(begun.message);

    // The keys deliberately out of canonical order, so the row can only match
    // the codec's spelling if the store ran the codec.
    const locator = { bbox: [0.1, 0.2, 0.8, 0.9], page: 4, type: 'pdf' } as unknown as ChunkLocator;
    const chunkId = id();
    expect(
      await store.appendExtractionChunks({
        extractionId: begun.extraction.id,
        chunks: [{ id: chunkId, ordinal: 0, body: 'pdf 본문', chunkLocator: locator, page: 4 }],
      }),
    ).toEqual({ ok: true, appended: 1 });

    const encoded = encodeChunkLocator(locator);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    const row = await onConnection(path, (database) =>
      database
        .prepare('select chunk_locator, page from document_chunks where id = ?')
        .get(chunkId) as { chunk_locator: string; page: number | null },
    );
    expect(row).toEqual({ chunk_locator: encoded.text, page: encoded.page });

    // And the read hands back the position the codec decodes from that text.
    const read = await store.listExtractionChunks(begun.extraction.id);
    expect(read).toEqual({
      ok: true,
      chunks: [{
        id: chunkId,
        extractionId: begun.extraction.id,
        ordinal: 0,
        page: 4,
        body: 'pdf 본문',
        chunkLocator: encoded.locator,
      }],
    });
  });

  it('가린 파일은 새 세대를 열지 못하고 돌아온 성공은 redacted로 닫힌다', async () => {
    const { path, store } = await seeded();
    const claim = await takeClaim(store, { workItemId: id(), now: T0, claimedBy: 'drain-a' });
    const begun = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-1', startedAt: at(1), claim,
    });
    if (!begun.ok) throw new Error(begun.message);
    expect(
      await store.appendExtractionChunks({
        extractionId: begun.extraction.id,
        chunks: [textChunk(0, 'secretbody')],
      }),
    ).toEqual({ ok: true, appended: 1 });

    // The redaction transaction of AD-11, which is the only thing allowed to
    // fill `redacted_at` — and a connection of its own, because the marker the
    // triggers consult belongs to the connection that raised it.
    const connection = openConnection(path);
    try {
      const written = await withWrite(
        connection,
        async (db) => {
          await sql`update files set redacted_at = ${AT} where id = ${FILE_ID}`.execute(db);
        },
        { redact: true },
      );
      expect(written.ok).toBe(true);
    } finally {
      await connection.close();
    }

    const refused = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-1', startedAt: at(2), claim,
    });
    expect(refused).toMatchObject({ ok: false, code: 'FILE_REDACTED' });
    expect(
      await store.appendExtractionChunks({
        extractionId: begun.extraction.id,
        chunks: [textChunk(1, 'morebody')],
      }),
    ).toMatchObject({ ok: false, code: 'FILE_REDACTED' });

    // The reading that was already running comes back successful, and is closed
    // `redacted`: its text may not be kept and the pointer may not move to it.
    // The chunking generation it names goes too — the pieces it cut are gone, so
    // there is nothing left for `index_config_id` to be about.
    const closed = await store.finishExtraction({
      extractionId: begun.extraction.id,
      finishedAt: at(3),
      outcome: {
        status: 'ok',
        mediaType: 'text/plain',
        indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID,
      },
    });
    expect(closed).toMatchObject({
      ok: true,
      current: false,
      extraction: { status: 'redacted', indexConfigId: null },
    });
    expect(await store.listExtractionChunks(begun.extraction.id)).toEqual({ ok: true, chunks: [] });
    expect(await ftsMatches(path, 'secretbody')).toBe(0);
    const state = await store.readFileExtractionState(FILE_ID);
    expect(state).toMatchObject({ ok: true, currentExtractionId: null, redactedAt: new Date(AT) });
  });

  it('2,000자 본문 200조각 배치 하나를 2초 안에 쓴다', async () => {
    const { store } = await seeded();
    const claim = await takeClaim(store, { workItemId: id(), now: T0, claimedBy: 'drain-a' });
    const begun = await store.beginExtraction({
      id: id(), fileId: FILE_ID, extractorVersion: 'text-1', startedAt: at(1), claim,
    });
    if (!begun.ok) throw new Error(begun.message);

    const chunks = Array.from({ length: DOCUMENT_CHUNK_BATCH_MAX }, (_unused, index) =>
      textChunk(index, `${String(index)} `.padEnd(2000, '본문입니다 ')),
    );
    expect(chunks[0]?.body.length).toBe(2000);
    const started = performance.now();
    const written = await store.appendExtractionChunks({
      extractionId: begun.extraction.id,
      chunks,
    });
    const elapsed = performance.now() - started;
    expect(written).toEqual({ ok: true, appended: DOCUMENT_CHUNK_BATCH_MAX });
    expect(elapsed).toBeLessThan(2000);
  });
});
