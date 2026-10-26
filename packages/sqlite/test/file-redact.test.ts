import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DOCUMENT_CHUNK_INDEX_CONFIG_ID,
  DOCUMENT_EXTRACT_KIND,
  brainLocator,
  contentHashOfBytes,
  failureFingerprint,
  planFileRedaction,
  type IngestAttachment,
} from '@second-brain/core';
import {
  fixedClock,
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
  sequenceIdGen,
} from '@second-brain/core/testing';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';
import { sqliteAttachmentStore } from '../src/attachments.js';
import { sqliteExtractionStore } from '../src/extractions.js';
import { sqliteWorkStore } from '../src/work.js';

/**
 * Masking one file on the real schema: what leaves the database file, what the
 * keyword indexes answer afterwards, and what a refusal in the middle leaves
 * behind.
 *
 * The contract cases (`fileRedactionContract`) already hold this adapter and
 * the in-memory fake to the same answers. What only a real file can show is in
 * here: the bytes on the disk, the FTS rows, the triggers of 0002 and 0008, the
 * redaction marker coming down, and `DB_LOCKED`.
 */

const dirs: string[] = [];
const connections: SqliteConnection[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(dirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

/** Neutral words that appear nowhere else in the fixture. */
const CHUNK_BODY = 'needlebody-unmistakable 첫 줄입니다.';
const NAME = 'sharednote-unmistakable.txt';
const BYTES = Uint8Array.of(31, 32, 33);
const T0 = new Date('2026-03-04T05:06:07.000Z');
const at = (offsetMs: number): Date => new Date(T0.getTime() + offsetMs);

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'brain-file-redact-'));
  dirs.push(dir);
  const path = join(dir, 'brain.db');
  expect((await runSqliteMigrations({ path })).ok).toBe(true);
  const ids = sequenceIdGen({ start: 8000, timestampMs: 1770000000000 });

  const seed = sqliteStore({ path });
  expect((await seed.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
  expect((await seed.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
  const batch = sampleIngestBatch();
  const first = batch.messages[0]!;
  const second = batch.messages[1]!;
  const hash = contentHashOfBytes(BYTES);
  const file = {
    id: ids.next(),
    contentHash: hash,
    sizeBytes: BYTES.length,
    location: { id: ids.next(), storeKind: 'local' as const, ownership: 'brain' as const,
      locator: brainLocator(hash.slice(7), BYTES) },
  };
  const attachments: IngestAttachment[] = [first, second].map((message) => ({
    id: ids.next(), harnessMessageId: message.harnessMessageId, ordinal: 0,
    sourceKind: 'file', sourceRef: null, displayName: NAME,
    file: { ...file, external: null },
  }));
  expect((await seed.ingest({ ...batch, attachments })).ok).toBe(true);
  await seed.close();

  const opened = openSqlite({ path, busyTimeoutMs: 30 });
  if (!opened.ok) throw new Error(opened.message);
  const connection = opened.connection;
  connections.push(connection);
  const connect = () => ({ ok: true as const, connection });
  const attachmentStore = sqliteAttachmentStore(connect);
  const extractionStore = sqliteExtractionStore(connect);
  const workStore = sqliteWorkStore(connect);
  const db = connection.database;

  const fileId = (db.prepare('select id from files').get() as { id: string }).id;
  const locationId = (db.prepare('select id from file_locations').get() as { id: string }).id;

  // A name, a metadata row and one successful reading: the three derived things
  // a masking takes away.
  expect(await attachmentStore.writeFileNames({
    names: [{ id: ids.next(), fileId, nameSource: 'attachment_name', text: NAME }],
  })).toEqual({ ok: true, inserted: 1 });
  db.prepare('insert into file_metadata (id, file_id, key, value) values (?, ?, ?, ?)')
    .run(ids.next(), fileId, 'width', '640');

  const added = await workStore.addWork({ id: ids.next(), kind: DOCUMENT_EXTRACT_KIND,
    targetKind: 'file', targetId: fileId, createdAt: T0, nextAttemptAt: T0 });
  expect(added.ok).toBe(true);
  const claimed = await workStore.claimWork({ now: T0, kinds: [DOCUMENT_EXTRACT_KIND], claimedBy: 'drain-a' });
  if (!claimed.ok || claimed.item === null) throw new Error('청구 실패');
  const claim = { workItemId: claimed.item.id, claimedBy: 'drain-a' };
  const begun = await extractionStore.beginExtraction({ id: ids.next(), fileId,
    extractorVersion: 'text-1', startedAt: at(1), claim });
  if (!begun.ok) throw new Error('세대 실패');
  expect((await extractionStore.appendExtractionChunks({ extractionId: begun.extraction.id,
    chunks: [{ id: ids.next(), ordinal: 0, body: CHUNK_BODY, page: null,
      chunkLocator: { type: 'text', start: 0, end: CHUNK_BODY.length } }] })).ok).toBe(true);
  expect((await extractionStore.finishExtraction({ extractionId: begun.extraction.id,
    finishedAt: at(2), outcome: { status: 'ok', mediaType: 'text/plain',
      indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID } })).ok).toBe(true);

  // And an open failure about reading it, which the masking settles.
  const recorded = await workStore.recordFailure({ id: ids.next(), targetKind: 'file', targetId: fileId,
    stage: DOCUMENT_EXTRACT_KIND,
    fingerprint: failureFingerprint({ stage: DOCUMENT_EXTRACT_KIND, input: fileId, code: 'EXTRACTION_FAILED' }),
    harness: null, sessionId: null, code: 'EXTRACTION_FAILED', message: '읽기 실패', occurredAt: at(3) });
  expect(recorded.ok).toBe(true);

  const redact = (now = at(10)) => attachmentStore.redactFile({
    fileId, plan: (current) => planFileRedaction(current, { clock: fixedClock(now), idGen: ids }),
  });
  return { path, connection, db, fileId, locationId, hash, claim, extraction: begun.extraction.id,
    attachmentStore, extractionStore, workStore, redact, ids };
}

function matches(db: SqliteConnection['database'], table: string, needle: string): number {
  return (db.prepare(`select count(*) as n from ${table} where ${table} match ?`)
    .get(`"${needle}"`) as { n: number }).n;
}

function snapshot(db: SqliteConnection['database']) {
  return ['files', 'file_locations', 'file_names', 'file_metadata', 'document_extractions',
    'document_chunks', 'redactions', 'work_items', 'failures']
    .map((table) => db.prepare(`select * from ${table}`).all());
}

describe('SQLite 파일 가리기', () => {
  it('조각·이름·메타데이터와 디스크 바이트를 지우고 기록과 일감을 남긴다', async () => {
    const f = await fixture();
    expect(matches(f.db, 'document_chunks_fts', 'needlebody-unmistakable')).toBe(1);
    expect(matches(f.db, 'file_names_fts', 'sharednote-unmistakable.txt')).toBe(1);

    expect(await f.redact()).toMatchObject({ ok: true, messages: 2, alreadyRedacted: false,
      extractionsRemoved: 1, chunksRemoved: 1, namesRemoved: 1, metadataRemoved: 1,
      blobDeletesQueued: 1, failuresResolved: 1 });

    expect(matches(f.db, 'document_chunks_fts', 'needlebody-unmistakable')).toBe(0);
    expect(matches(f.db, 'file_names_fts', 'sharednote-unmistakable.txt')).toBe(0);
    for (const table of ['file_names', 'file_metadata', 'document_extractions', 'document_chunks']) {
      expect(f.db.prepare(`select count(*) as n from ${table}`).get(), table).toEqual({ n: 0 });
    }
    expect(f.db.prepare('select redacted_at, current_extraction_id from files').get())
      .toEqual({ redacted_at: '2026-03-04T05:06:07.010Z', current_extraction_id: null });
    expect(f.db.prepare('select message_id, tool_note_id, file_id, start, "end", kind, content_hash, pattern_version from redactions').all())
      .toEqual([{ message_id: null, tool_note_id: null, file_id: f.fileId, start: null, end: null,
        kind: 'manual', content_hash: f.hash, pattern_version: null }]);
    // The place is a record of where the bytes were, and it is never deleted.
    expect(f.db.prepare('select id, deleted_at from file_locations').all())
      .toEqual([{ id: f.locationId, deleted_at: null }]);
    // The provenance of the attachment stays: the message really carried it.
    expect(f.db.prepare('select count(*) as n from message_attachments where status = ?').get('stored'))
      .toEqual({ n: 2 });
    expect(f.db.prepare(`select kind, target_kind, target_id from work_items
      where kind = 'blob_delete'`).all())
      .toEqual([{ kind: 'blob_delete', target_kind: 'file_location', target_id: f.locationId }]);
    expect(f.db.prepare('select resolved_at from failures').all())
      .toEqual([{ resolved_at: '2026-03-04T05:06:07.010Z' }]);

    expect(f.connection.isRedactAllowed()).toBe(false);
    expect(f.db.prepare('pragma secure_delete').get()).toEqual({ secure_delete: 0 });
    // The marker is down, so the ordinary immutability rules are back.
    expect(() => f.db.exec('update files set redacted_at = null')).toThrow();

    await f.connection.close();
    connections.splice(connections.indexOf(f.connection), 1);
    for (const suffix of ['', '-wal']) {
      const bytes = await readFile(f.path + suffix).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return Buffer.alloc(0);
        throw error;
      });
      expect(bytes.includes(Buffer.from('needlebody-unmistakable')), suffix).toBe(false);
    }
  });

  it('두 번째 가리기는 아무것도 지우지 않고 남은 Brain 사본만 다시 넣는다', async () => {
    const f = await fixture();
    expect(await f.redact()).toMatchObject({ ok: true, alreadyRedacted: false });
    const before = snapshot(f.db);
    expect(await f.redact(at(20))).toMatchObject({ ok: true, alreadyRedacted: true,
      extractionsRemoved: 0, chunksRemoved: 0, namesRemoved: 0, metadataRemoved: 0,
      failuresResolved: 0, blobDeletesQueued: 1 });
    // One row, because `addWork` is find-or-create on the open-row key.
    expect(snapshot(f.db)).toEqual(before);
    expect(await f.attachmentStore.markFileLocationDeleted({ id: f.locationId, deletedAt: at(30) }))
      .toMatchObject({ ok: true, marked: true });
    expect(await f.redact(at(40))).toMatchObject({ ok: true, blobDeletesQueued: 0 });
  });

  it('진행 중인 세대는 조각만 잃고 그 일꾼이 스스로 redacted로 닫는다', async () => {
    const f = await fixture();
    const open = await f.extractionStore.beginExtraction({ id: f.ids.next(), fileId: f.fileId,
      extractorVersion: 'text-2', startedAt: at(5), claim: f.claim });
    if (!open.ok) throw new Error('세대 실패');
    expect((await f.extractionStore.appendExtractionChunks({ extractionId: open.extraction.id,
      chunks: [{ id: f.ids.next(), ordinal: 0, body: CHUNK_BODY, page: null,
        chunkLocator: { type: 'text', start: 0, end: 4 } }] })).ok).toBe(true);

    expect(await f.redact()).toMatchObject({ ok: true, chunksRemoved: 2, extractionsRemoved: 1 });
    // The open row stays; its pieces are gone.
    expect(f.db.prepare('select id, finished_at from document_extractions').all())
      .toEqual([{ id: open.extraction.id, finished_at: null }]);
    expect(f.db.prepare('select count(*) as n from document_chunks').get()).toEqual({ n: 0 });
    expect(await f.extractionStore.appendExtractionChunks({ extractionId: open.extraction.id,
      chunks: [{ id: f.ids.next(), ordinal: 1, body: '늦은 조각', page: null,
        chunkLocator: { type: 'text', start: 9, end: 12 } }] }))
      .toMatchObject({ ok: false, code: 'FILE_REDACTED' });
    expect(await f.extractionStore.finishExtraction({ extractionId: open.extraction.id,
      finishedAt: at(20), outcome: { status: 'ok', mediaType: 'text/plain',
        indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID } }))
      .toMatchObject({ ok: true, current: false, extraction: { status: 'redacted' } });
    expect(f.db.prepare('select current_extraction_id from files').get())
      .toEqual({ current_extraction_id: null });
    expect(await f.extractionStore.beginExtraction({ id: f.ids.next(), fileId: f.fileId,
      extractorVersion: 'text-2', startedAt: at(30), claim: f.claim }))
      .toMatchObject({ ok: false, code: 'FILE_REDACTED' });
  });

  it.each(['redactions', 'file_names', 'work_items'])('%s 쓰기가 거절되면 전부 롤백한다', async (table) => {
    const f = await fixture();
    const before = snapshot(f.db);
    const operation = table === 'file_names' ? 'delete' : 'insert';
    f.db.exec(`create trigger fail_file_redact before ${operation} on ${table} begin select raise(abort, 'injected'); end`);
    await expect(f.redact()).rejects.toThrow('injected');
    expect(snapshot(f.db)).toEqual(before);
    expect(f.connection.isRedactAllowed()).toBe(false);
    expect(f.db.prepare('pragma secure_delete').get()).toEqual({ secure_delete: 0 });
    expect(matches(f.db, 'document_chunks_fts', 'needlebody-unmistakable')).toBe(1);
    expect(matches(f.db, 'file_names_fts', 'sharednote-unmistakable.txt')).toBe(1);
  });

  it('잠긴 데이터베이스는 아무것도 바꾸지 않고 표시를 내린다', async () => {
    const f = await fixture();
    const before = snapshot(f.db);
    const other = openSqlite({ path: f.path, busyTimeoutMs: 1 });
    if (!other.ok) throw new Error(other.message);
    connections.push(other.connection);
    other.connection.database.exec('begin immediate');
    try {
      expect(await f.redact()).toMatchObject({ ok: false, code: 'DB_LOCKED' });
      expect(f.connection.isRedactAllowed()).toBe(false);
      expect(f.db.prepare('pragma secure_delete').get()).toEqual({ secure_delete: 0 });
    } finally { other.connection.database.exec('rollback'); }
    expect(snapshot(f.db)).toEqual(before);

    const missing = sqliteStore({ path: join(dirs[0]!, 'missing.db') });
    expect(await missing.redactFile({ fileId: f.fileId,
      plan: () => { throw new Error('계획을 물어서는 안 됩니다'); } }))
      .toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await missing.readFileSharing({ fileId: f.fileId }))
      .toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await missing.listRedactedContentHashes([f.hash]))
      .toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    // No hashes is answered without opening anything at all.
    expect(await missing.listRedactedContentHashes([])).toEqual({ ok: true, hashes: [] });
    await missing.close();
  });
});
