import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { sql } from 'kysely';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';
import { withWrite } from '../src/write.js';

/**
 * The second migration: the queue of AD-21 and the file tables of AD-23 and
 * AD-24. The helpers below are the shape `schema.test.ts` uses, written out
 * again rather than shared, because a test fixture that two files depend on is
 * a third thing to keep in step and these are four lines each.
 */

/** Caller-minted ids, in the UUIDv7 shape every row carries (AD-8). */
function id(ordinal: number): string {
  return `01950000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
}

/** `sha256:` and 64 lower-case hex digits, which is what `files` accepts (AD-23). */
function hash(ordinal: number): string {
  return `sha256:${ordinal.toString(16).padStart(2, '0').repeat(32)}`;
}

const ids = {
  user: id(0),
  session: id(1),
  message: id(2),
  fileA: id(10),
  brainA: id(11),
  externalA: id(12),
  extractionA: id(13),
  chunkA: id(14),
  nameA: id(15),
  metadataA: id(16),
  attachmentA: id(17),
  work: id(18),
  fileB: id(20),
  brainB: id(21),
  extractionB: id(22),
  chunkB: id(23),
};

/** The row 0001 writes, and the one 0002 writes beside it (AD-15, AD-24). */
const CHUNK_CONFIG = '019a0000-0000-7000-8000-000000000001';
const DOCUMENT_CHUNK_CONFIG = '019a0000-0000-7000-8000-000000000002';
const DOCUMENT_CHUNK_PARAMS = '{"targetChars":1200,"overlapChars":120}';

const SEEDED_AT = '2026-02-03T04:05:06.000Z';
const LATER = '2026-02-03T04:05:07.000Z';

// Korean, because the trigram tokenizer is in the schema for languages that do
// not put spaces between words (AD-15); a sentence of English words would pass
// with any tokenizer at all.
const DOCUMENT_BODY = '어제 받은 회의록 초안';
const FILE_NAME = '어제 받은 회의록 초안.pdf';
const OTHER_BODY = '지난달 영수증 모음';
const NEEDLE = '"회의록"';
// One of the trigrams the tokenizer makes of it, so the stored blocks can be
// searched for a term and not for the whole sentence.
const NEEDLE_TRIGRAM = '회의록';

const EXTRACTOR = 'doc/1+demo-0.0.0';

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-files-'));
  directories.push(directory);
  return directory;
}

/** A fresh file brought up to date by the migrations this package ships. */
async function migratedPath(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const applied = await runSqliteMigrations({ path });
  expect(applied).toEqual({
    ok: true,
    from: 0,
    to: 3,
    applied: ['0001_initial.sql', '0002_files_and_work.sql', '0003_users.sql'],
  });
  return path;
}

function open(path: string): SqliteConnection {
  const opened = openSqlite({ path, busyTimeoutMs: 3000 });
  if (!opened.ok) throw new Error(`could not open ${path}: ${opened.message}`);
  connections.push(opened.connection);
  return opened.connection;
}

type Row = Readonly<Record<string, string | number | null>>;

/** Quote every identifier, because `text` and `key` are column names. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function insertSql(table: string, row: Row, tail = ''): string {
  const columns = Object.keys(row);
  const placeholders = columns.map(() => '?').join(', ');
  return `insert into ${quote(table)} (${columns.map(quote).join(', ')})
               values (${placeholders}) ${tail}`;
}

function insert(connection: SqliteConnection, table: string, row: Row, tail = ''): void {
  connection.database
    .prepare(insertSql(table, row, tail))
    .run(...(Object.values(row) as SQLInputValue[]));
}

function count(connection: SqliteConnection, table: string): number {
  const row = connection.database.prepare(`select count(*) as n from ${quote(table)}`).get();
  return Number(row?.n ?? -1);
}

/** How many rows of an FTS index the needle finds. */
function matches(connection: SqliteConnection, index: string, needle: string): number {
  const row = connection.database
    .prepare(`select count(*) as n from ${index} where ${index} match ?`)
    .get(needle);
  return Number(row?.n ?? -1);
}

/**
 * How many of an index's stored segment blocks still hold the text. A `match`
 * that finds nothing only says the index will not answer with the row;
 * `delete` writes a tombstone by default and leaves the terms in the blocks
 * until some later merge, which for a redaction is the text still on disk
 * (AD-11).
 */
function blocksHolding(connection: SqliteConnection, index: string, text: string): number {
  const row = connection.database
    .prepare(`select count(*) as n from ${index}_data where instr(cast(block as text), ?) > 0`)
    .get(text);
  return Number(row?.n ?? -1);
}

/**
 * One row per new table, plus the session and message the attachment hangs
 * from. Two files, because half of what the triggers refuse is a pointer at
 * the other one's rows.
 */
function seed(connection: SqliteConnection): void {
  // Before the session: `sessions.user_id` points at it (AD-12).
  insert(connection, 'users', {
    id: ids.user,
    name: 'brain-owner',
    is_self: 1,
    created_at: SEEDED_AT,
  });
  insert(connection, 'sessions', {
    id: ids.session,
    harness: 'demo',
    harness_session_id: 'session-0001',
    user_id: ids.user,
    machine: 'demo-machine',
    started_at: SEEDED_AT,
    ingest_source: 'live',
  });
  insert(connection, 'messages', {
    id: ids.message,
    session_id: ids.session,
    harness_message_id: 'h-1',
    seq: 0,
    role: 'user',
    body: 'the draft is attached',
    occurred_at: SEEDED_AT,
  });

  insert(connection, 'files', {
    id: ids.fileA,
    content_hash: hash(1),
    size_bytes: 2048,
    first_seen_at: SEEDED_AT,
  });
  insert(connection, 'file_locations', {
    id: ids.brainA,
    file_id: ids.fileA,
    store_kind: 'local',
    locator: '01/02/0102030405.pdf',
    ownership: 'brain',
    first_seen_at: SEEDED_AT,
  });
  insert(connection, 'file_locations', {
    id: ids.externalA,
    file_id: ids.fileA,
    store_kind: 'local',
    locator: 'demo/inbox/draft.pdf',
    ownership: 'external',
    first_seen_at: SEEDED_AT,
  });
  insert(connection, 'document_extractions', {
    id: ids.extractionA,
    file_id: ids.fileA,
    extractor_version: EXTRACTOR,
    media_type: 'application/pdf',
    status: 'ok',
    started_at: SEEDED_AT,
    finished_at: LATER,
  });
  insert(connection, 'document_chunks', {
    id: ids.chunkA,
    extraction_id: ids.extractionA,
    ordinal: 0,
    page: 1,
    body: DOCUMENT_BODY,
  });
  insert(connection, 'file_names', {
    id: ids.nameA,
    file_id: ids.fileA,
    name_source: 'attachment_name',
    text: FILE_NAME,
  });
  insert(connection, 'file_metadata', {
    id: ids.metadataA,
    file_id: ids.fileA,
    key: 'captured_at',
    value: SEEDED_AT,
  });
  insert(connection, 'message_attachments', {
    id: ids.attachmentA,
    message_id: ids.message,
    ordinal: 0,
    source_kind: 'demo/paste',
    source_ref: 'p-1',
    display_name: FILE_NAME,
    file_id: ids.fileA,
    status: 'stored',
  });
  insert(connection, 'work_items', {
    id: ids.work,
    kind: 'extract',
    target_kind: 'file',
    target_id: ids.fileA,
    created_at: SEEDED_AT,
    next_attempt_at: SEEDED_AT,
  });

  insert(connection, 'files', {
    id: ids.fileB,
    content_hash: hash(2),
    size_bytes: 64,
    first_seen_at: SEEDED_AT,
  });
  insert(connection, 'file_locations', {
    id: ids.brainB,
    file_id: ids.fileB,
    store_kind: 'drive',
    locator: 'drive-file-0002',
    ownership: 'brain',
    first_seen_at: SEEDED_AT,
  });
  insert(connection, 'document_extractions', {
    id: ids.extractionB,
    file_id: ids.fileB,
    extractor_version: EXTRACTOR,
    media_type: 'image/jpeg',
    status: 'ok',
    started_at: SEEDED_AT,
    finished_at: LATER,
  });
  insert(connection, 'document_chunks', {
    id: ids.chunkB,
    extraction_id: ids.extractionB,
    ordinal: 0,
    page: null,
    body: OTHER_BODY,
  });
}

/** A migrated file with one row per new table, open. */
async function seeded(): Promise<SqliteConnection> {
  const connection = open(await migratedPath());
  seed(connection);
  return connection;
}

describe('the upgrade from 0001 through 0003', () => {
  it('keeps the rows and the keys of the two tables it has to rebuild', async () => {
    // Only the first file, so the database stops at version 1 the way an
    // install from before this story did. A folder the caller names is not
    // held to `SQLITE_SCHEMA_VERSION`, which is how the tests reach it.
    const directory = await scratch();
    await copyFile(
      join(SQLITE_MIGRATIONS_DIRECTORY, '0001_initial.sql'),
      join(directory, '0001_initial.sql'),
    );
    const path = join(await scratch(), 'brain.db');
    expect(await runSqliteMigrations({ path, directory })).toEqual({
      ok: true,
      from: 0,
      to: 1,
      applied: ['0001_initial.sql'],
    });

    // A chunk pointing at the default config, because `index_configs` is the
    // one table 0002 has to drop and rebuild and `chunks` is what refers to it.
    const before = open(path);
    insert(before, 'sessions', {
      id: ids.session,
      harness: 'demo',
      harness_session_id: 'session-0001',
      user_id: 'owner',
      machine: 'demo-machine',
      started_at: SEEDED_AT,
      ingest_source: 'live',
    });
    insert(before, 'chunks', {
      id: id(30),
      session_id: ids.session,
      index_config_id: CHUNK_CONFIG,
      seq_from: 0,
      seq_to: 0,
      body: 'a chunk from before the upgrade',
    });
    await before.close();
    connections.splice(connections.indexOf(before), 1);

    expect(await runSqliteMigrations({ path })).toEqual({
      ok: true,
      from: 1,
      to: 3,
      applied: ['0002_files_and_work.sql', '0003_users.sql'],
    });

    const after = open(path);
    // The stashed row came back under its own id, beside the new one.
    expect(
      after.database.prepare('select id, kind from index_configs order by id').all(),
    ).toEqual([
      { id: CHUNK_CONFIG, kind: 'chunk' },
      { id: DOCUMENT_CHUNK_CONFIG, kind: 'document_chunk' },
    ]);
    // `chunks` still refers to `index_configs` by that name, and the rows it
    // points at are the ones that were put back.
    expect(count(after, 'chunks')).toBe(1);
    // The session survived 0003's rebuild of `sessions`, and the user id it
    // named got a row to point at rather than being stranded.
    expect(count(after, 'sessions')).toBe(1);
    expect(
      after.database.prepare('select id, name, is_self from users').all(),
    ).toEqual([{ id: 'owner', name: 'owner', is_self: 0 }]);
    expect(after.database.prepare('pragma foreign_key_check').all()).toEqual([]);
    // The unique index went with the dropped table and had to be recreated.
    expect(
      after.database
        .prepare(`select name from sqlite_master where type = 'index' and name = ?`)
        .all('index_configs_key_idx'),
    ).toEqual([{ name: 'index_configs_key_idx' }]);
  });
});

interface DuplicateKeyCase {
  table: string;
  key: string;
  first: Row;
  /** Same key, different row: the insert must be refused. */
  second: Row;
}

function duplicateKeyCases(): DuplicateKeyCase[] {
  const workItem = {
    id: id(101),
    kind: 'extract',
    target_kind: 'file',
    target_id: ids.fileB,
    created_at: SEEDED_AT,
    next_attempt_at: SEEDED_AT,
  };
  const file = {
    id: id(102),
    content_hash: hash(3),
    size_bytes: 1,
    first_seen_at: SEEDED_AT,
  };
  const location = {
    id: id(103),
    file_id: ids.fileA,
    store_kind: 'local',
    locator: 'demo/inbox/other.pdf',
    ownership: 'external',
    first_seen_at: SEEDED_AT,
  };
  const attachment = {
    id: id(104),
    message_id: ids.message,
    ordinal: 1,
    source_kind: 'demo/paste',
  };
  const extraction = {
    id: id(105),
    file_id: ids.fileB,
    extractor_version: 'doc/2+demo-0.0.0',
    started_at: SEEDED_AT,
  };
  const chunk = {
    id: id(106),
    extraction_id: ids.extractionB,
    ordinal: 5,
    body: 'a piece of the other document',
  };
  const name = {
    id: id(107),
    file_id: ids.fileB,
    name_source: 'location_path',
    text: 'demo/inbox/other.pdf',
  };
  const metadata = {
    id: id(108),
    file_id: ids.fileB,
    key: 'width',
    value: '1024',
  };

  const other = (row: Row, ordinal: number): Row => ({ ...row, id: id(ordinal) });

  return [
    {
      table: 'work_items',
      key: '(kind, target_kind, target_id) of the open rows',
      first: workItem,
      second: other(workItem, 201),
    },
    { table: 'files', key: 'content_hash', first: file, second: other(file, 202) },
    {
      table: 'file_locations',
      key: '(file_id, store_kind, locator)',
      first: location,
      second: other(location, 203),
    },
    {
      table: 'message_attachments',
      key: '(message_id, ordinal)',
      first: attachment,
      second: other(attachment, 204),
    },
    {
      table: 'document_extractions',
      key: '(file_id, extractor_version) of the generations still running',
      first: extraction,
      second: other(extraction, 205),
    },
    {
      table: 'document_chunks',
      key: '(extraction_id, ordinal)',
      first: chunk,
      second: { ...other(chunk, 206), body: 'another piece' },
    },
    {
      table: 'file_names',
      key: '(file_id, name_source, text)',
      first: name,
      second: other(name, 207),
    },
    {
      table: 'file_metadata',
      key: '(file_id, key)',
      first: metadata,
      second: { ...other(metadata, 208), value: '2048' },
    },
  ];
}

describe('the idempotency keys of the file tables (AD-8)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it.each(duplicateKeyCases())(
    '$table is unique on $key, and the second insert is a no-op under do nothing',
    ({ table, first, second }) => {
      connection.database.exec('begin');
      try {
        insert(connection, table, first);
        const after = count(connection, table);
        expect(() => insert(connection, table, second)).toThrow(/UNIQUE constraint failed/);
        // The only idempotent insert this schema allows (AD-8): it changes
        // nothing and raises nothing.
        insert(connection, table, second, 'on conflict do nothing');
        expect(count(connection, table)).toBe(after);
      } finally {
        connection.database.exec('rollback');
      }
    },
  );
});

describe('one open work item per target (AD-21)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it('refuses a second open item for the same work, and allows one once the first is done', () => {
    const again = {
      id: id(301),
      kind: 'extract',
      target_kind: 'file',
      target_id: ids.fileA,
      created_at: SEEDED_AT,
      next_attempt_at: SEEDED_AT,
    };
    expect(() => insert(connection, 'work_items', again)).toThrow(/UNIQUE constraint failed/);

    // The same request after the first one finished is new work, not a
    // duplicate: the index is partial on `completed_at is null` for exactly
    // this, because a session is chunked again every time it grows.
    connection.database.exec(
      `update work_items set completed_at = '${LATER}' where id = '${ids.work}'`,
    );
    insert(connection, 'work_items', again);
    expect(count(connection, 'work_items')).toBe(2);

    // And the new one is now the open one.
    expect(() => insert(connection, 'work_items', { ...again, id: id(302) })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it('refuses a claim that is only half made', () => {
    expect(() =>
      insert(connection, 'work_items', {
        id: id(303),
        kind: 'mirror',
        target_kind: 'session',
        target_id: ids.session,
        created_at: SEEDED_AT,
        next_attempt_at: SEEDED_AT,
        claimed_at: SEEDED_AT,
        claim_expires_at: null,
        claimed_by: 'drain-1',
      }),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('the extraction generations (AD-24)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it('allows one running generation per version, and another once it has finished', () => {
    const running = {
      id: id(401),
      file_id: ids.fileA,
      extractor_version: EXTRACTOR,
      started_at: SEEDED_AT,
    };
    // The seeded generation is finished, so this one may start.
    insert(connection, 'document_extractions', running);
    expect(() =>
      insert(connection, 'document_extractions', { ...running, id: id(402) }),
    ).toThrow(/UNIQUE constraint failed/);

    connection.database.exec(
      `update document_extractions set status = 'ok', finished_at = '${LATER}'
         where id = '${running.id}'`,
    );
    insert(connection, 'document_extractions', { ...running, id: id(403) });
  });

  it.each([
    { name: 'a generation that finished without saying how', status: null, finished: LATER },
    { name: 'a generation that says how before it finished', status: 'ok', finished: null },
  ])('refuses $name', ({ status, finished }) => {
    expect(() =>
      insert(connection, 'document_extractions', {
        id: id(404),
        file_id: ids.fileB,
        extractor_version: 'doc/3+demo-0.0.0',
        status,
        started_at: SEEDED_AT,
        finished_at: finished,
      }),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('the change rules for files (AD-11, AD-23)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it.each([
    { statement: `update files set content_hash = '${hash(9)}'`, table: 'files' },
    { statement: `update files set size_bytes = 1`, table: 'files' },
    { statement: `update files set first_seen_at = '${LATER}'`, table: 'files' },
    { statement: `update files set redacted_at = '${LATER}'`, table: 'files' },
    { statement: `delete from files`, table: 'files' },
    {
      statement: `insert or replace into files (id, content_hash, size_bytes, first_seen_at)
                       values ('${id(501)}', '${hash(1)}', 1, '${SEEDED_AT}')`,
      table: 'files',
    },
  ])('refuses `$statement`', ({ statement, table }) => {
    expect(() => connection.database.exec(statement)).toThrow(
      new RegExp(`${table}[\\s\\S]*immutable`),
    );
  });

  it('lets the two pointers move, to this file’s own rows', () => {
    connection.database.exec(
      `update files set home_location_id = '${ids.brainA}',
                       current_extraction_id = '${ids.extractionA}'
         where id = '${ids.fileA}'`,
    );
    expect(
      connection.database
        .prepare('select home_location_id, current_extraction_id from files where id = ?')
        .get(ids.fileA),
    ).toEqual({ home_location_id: ids.brainA, current_extraction_id: ids.extractionA });
  });

  // Both pointers are checked on the way in as well as on the way through: a
  // `before update of` trigger never sees a row that arrived with the pointer
  // already set, and the cycle between the two tables means a caller may write
  // the file after its locations exist.
  const arriving = (ordinal: number, pointer: string, target: string): string =>
    `insert into files (id, content_hash, size_bytes, first_seen_at, ${pointer})
          values ('${id(ordinal)}', '${hash(ordinal)}', 1, '${SEEDED_AT}', '${target}')`;

  it.each([
    {
      name: 'a home at a location the user owns',
      statement: `update files set home_location_id = '${ids.externalA}' where id = '${ids.fileA}'`,
      message: /home_location_id must be a brain-owned location of the same file/,
    },
    {
      name: 'a home at another file’s location',
      statement: `update files set home_location_id = '${ids.brainB}' where id = '${ids.fileA}'`,
      message: /home_location_id must be a brain-owned location of the same file/,
    },
    {
      name: 'a current generation of another file',
      statement: `update files set current_extraction_id = '${ids.extractionB}'
                    where id = '${ids.fileA}'`,
      message: /current_extraction_id must be an extraction of the same file/,
    },
    {
      name: 'a file arriving with a home at somebody else’s location',
      statement: arriving(0x51, 'home_location_id', ids.brainA),
      message: /home_location_id must be a brain-owned location of the same file/,
    },
    {
      name: 'a file arriving with a home the user owns',
      statement: arriving(0x52, 'home_location_id', ids.externalA),
      message: /home_location_id must be a brain-owned location of the same file/,
    },
    {
      name: 'a file arriving with somebody else’s current generation',
      statement: arriving(0x53, 'current_extraction_id', ids.extractionA),
      message: /current_extraction_id must be an extraction of the same file/,
    },
  ])('refuses $name', ({ statement, message }) => {
    expect(() => connection.database.exec(statement)).toThrow(message);
  });

  it('takes the redaction mark once, and never back or onward', async () => {
    const marked = await withWrite(
      connection,
      async (held) => {
        // Not together with a content column: the marker buys `redacted_at`
        // and nothing else, so a redaction cannot carry a rewrite in with it.
        // The two pointers stay free, marked or not -- `files.redact` moves
        // them itself.
        await expect(
          sql`update files set redacted_at = ${LATER}, size_bytes = 1
                where id = ${ids.fileA}`.execute(held),
        ).rejects.toThrow(/files[\s\S]*immutable/);
        await expect(sql`delete from files where id = ${ids.fileA}`.execute(held)).rejects.toThrow(
          /files[\s\S]*immutable/,
        );

        await sql`update files set redacted_at = ${LATER} where id = ${ids.fileA}`.execute(held);

        // Set is set. A second masking does not move the time, and nothing
        // un-masks.
        await expect(
          sql`update files set redacted_at = null where id = ${ids.fileA}`.execute(held),
        ).rejects.toThrow(/files[\s\S]*immutable/);
        await expect(
          sql`update files set redacted_at = ${SEEDED_AT} where id = ${ids.fileA}`.execute(held),
        ).rejects.toThrow(/files[\s\S]*immutable/);
        return 'masked';
      },
      { redact: true },
    );
    expect(marked).toEqual({ ok: true, value: 'masked' });

    expect(
      connection.database.prepare('select redacted_at from files where id = ?').get(ids.fileA),
    ).toEqual({ redacted_at: LATER });
    // The marker is a variable in this process, not a property of the row, so
    // it has to be down again the moment the transaction ended.
    expect(connection.isRedactAllowed()).toBe(false);
    expect(() => connection.database.exec(`update files set size_bytes = 1`)).toThrow(
      /files[\s\S]*immutable/,
    );
  });
});

describe('the change rules for file_locations (AD-23)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it.each([
    { statement: `update file_locations set ownership = 'brain'` },
    { statement: `update file_locations set locator = 'elsewhere.pdf'` },
    { statement: `update file_locations set store_kind = 'drive'` },
    { statement: `update file_locations set remote_checksum = 'c0ffee'` },
    { statement: `delete from file_locations` },
  ])('refuses `$statement`', ({ statement }) => {
    expect(() => connection.database.exec(statement)).toThrow(
      /file_locations[\s\S]*immutable/,
    );
  });

  it('lets the verification and the deletion be recorded, once each', () => {
    connection.database.exec(
      `update file_locations set verified_at = '${LATER}', deleted_at = '${LATER}'
         where id = '${ids.externalA}'`,
    );
    expect(
      connection.database
        .prepare('select verified_at, deleted_at from file_locations where id = ?')
        .get(ids.externalA),
    ).toEqual({ verified_at: LATER, deleted_at: LATER });

    // A one-way fill, like `files.redacted_at`: a verification that could be
    // withdrawn, or a deletion that could be un-recorded, would let the move
    // path delete the last copy of something it had already called gone.
    for (const statement of [
      `update file_locations set verified_at = null where id = '${ids.externalA}'`,
      `update file_locations set verified_at = '${SEEDED_AT}' where id = '${ids.externalA}'`,
      `update file_locations set deleted_at = null where id = '${ids.externalA}'`,
      `update file_locations set deleted_at = '${SEEDED_AT}' where id = '${ids.externalA}'`,
    ]) {
      expect(() => connection.database.exec(statement)).toThrow(
        /file_locations[\s\S]*immutable/,
      );
    }
  });
});

describe('an attachment’s content and the status that goes with it (AD-23)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it.each([
    { name: 'a stored attachment with no content', status: 'stored', file: null },
    { name: 'a missing attachment that has content anyway', status: 'missing_at_ingest', file: ids.fileB },
    { name: 'a status nobody writes', status: 'pending', file: null },
    { name: 'content with no status to say it is stored', status: null, file: ids.fileB },
  ])('refuses $name', ({ status, file }) => {
    expect(() =>
      insert(connection, 'message_attachments', {
        id: id(601),
        message_id: ids.message,
        ordinal: 9,
        source_kind: 'demo/paste',
        file_id: file,
        status,
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('allows the state between the parser’s write and collection’s', () => {
    insert(connection, 'message_attachments', {
      id: id(602),
      message_id: ids.message,
      ordinal: 10,
      source_kind: 'demo/paste',
      source_ref: 'p-2',
      display_name: 'later.pdf',
      file_id: null,
      status: null,
    });
    expect(
      connection.database.prepare('select status, file_id from message_attachments where id = ?').get(id(602)),
    ).toEqual({ status: null, file_id: null });
  });
});

describe('the types SQLite does not have', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  // The cases name the type, because without it TypeScript unions the rows and
  // every column missing from one case comes back as `undefined`, which `Row`
  // does not allow.
  it.each<{ name: string; table: string; row: Row }>([
    {
      name: 'a content hash that is not sha256 and lower-case hex',
      table: 'files',
      row: {
        id: id(701),
        content_hash: 'sha256:NOTAHASH',
        size_bytes: 1,
        first_seen_at: SEEDED_AT,
      },
    },
    {
      name: 'a content hash in upper case, which would be the same bytes twice',
      table: 'files',
      row: {
        id: id(702),
        content_hash: hash(0xab).toUpperCase().replace('SHA256', 'sha256'),
        size_bytes: 1,
        first_seen_at: SEEDED_AT,
      },
    },
    {
      name: 'a size that is not a size',
      table: 'files',
      row: {
        id: id(703),
        content_hash: hash(4),
        size_bytes: -1,
        first_seen_at: SEEDED_AT,
      },
    },
    {
      name: 'an instant that is not the canonical 24 characters',
      table: 'work_items',
      row: {
        id: id(704),
        kind: 'extract',
        target_kind: 'file',
        target_id: id(999),
        created_at: '2026-10-14T01:02:03Z',
        next_attempt_at: SEEDED_AT,
      },
    },
    {
      name: 'a capture time that claims a zone it does not spell',
      table: 'file_metadata',
      row: {
        id: id(705),
        // The other file, which has no `captured_at` row: on `fileA` the key
        // is already taken and the UNIQUE would be a second reason to refuse.
        file_id: ids.fileB,
        key: 'captured_at',
        value: '2026:10:14 01:02:03',
      },
    },
    {
      name: 'a store nobody has',
      table: 'file_locations',
      row: {
        id: id(706),
        file_id: ids.fileA,
        store_kind: 'dropbox',
        locator: 'x',
        ownership: 'brain',
        first_seen_at: SEEDED_AT,
      },
    },
    {
      name: 'an ownership that is neither',
      table: 'file_locations',
      row: {
        id: id(707),
        file_id: ids.fileA,
        store_kind: 'local',
        locator: 'y',
        ownership: 'shared',
        first_seen_at: SEEDED_AT,
      },
    },
    {
      name: 'a name from somewhere this schema does not collect names',
      table: 'file_names',
      row: {
        id: id(708),
        file_id: ids.fileA,
        name_source: 'guess',
        text: 'z.pdf',
      },
    },
  ])('refuses $name', ({ table, row }) => {
    expect(() => insert(connection, table, row)).toThrow(/CHECK constraint failed/);
  });

  it('keeps the original EXIF text out of the canonical column, and in its own key', () => {
    insert(connection, 'file_metadata', {
      id: id(709),
      file_id: ids.fileA,
      key: 'captured_at_local',
      value: '2026:10:14 01:02:03',
    });
    expect(
      connection.database.prepare('select value from file_metadata where id = ?').get(id(709)),
    ).toEqual({ value: '2026:10:14 01:02:03' });
  });

  it('refuses a REAL where the column says INTEGER, because the tables are STRICT', () => {
    expect(() =>
      insert(connection, 'message_attachments', {
        id: id(710),
        message_id: ids.message,
        ordinal: 1.5,
        source_kind: 'demo/paste',
      }),
    ).toThrow(/cannot store REAL value in INTEGER column/);
  });
});

describe('the document chunking config this migration writes (AD-24)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it('is one row, with the document-shaped parameters', () => {
    expect(
      connection.database
        .prepare(
          `select id, kind, model, dimensions, chunk_params from index_configs
            where kind = 'document_chunk'`,
        )
        .all(),
    ).toEqual([
      {
        id: DOCUMENT_CHUNK_CONFIG,
        kind: 'document_chunk',
        model: null,
        dimensions: null,
        chunk_params: DOCUMENT_CHUNK_PARAMS,
      },
    ]);
  });

  it.each([
    {
      name: 'the same values written in another key order',
      kind: 'document_chunk',
      params: '{"overlapChars":120,"targetChars":1200}',
    },
    {
      name: 'a spelling with whitespace in it, so one value has one text',
      kind: 'document_chunk',
      params: '{"targetChars": 1200, "overlapChars": 120}',
    },
    {
      name: 'the conversation shape on a document config',
      kind: 'document_chunk',
      params: '{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400}',
    },
    {
      name: 'the document shape on a conversation config',
      kind: 'chunk',
      params: DOCUMENT_CHUNK_PARAMS,
    },
  ])('refuses $name', ({ kind, params }) => {
    expect(() =>
      insert(connection, 'index_configs', {
        id: id(801),
        kind,
        model: null,
        dimensions: null,
        chunk_params: params,
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('treats a second insert of the same config as the no-op an installer wants', () => {
    const before = count(connection, 'index_configs');
    insert(
      connection,
      'index_configs',
      {
        id: id(802),
        kind: 'document_chunk',
        model: null,
        dimensions: null,
        chunk_params: DOCUMENT_CHUNK_PARAMS,
      },
      'on conflict do nothing',
    );
    expect(count(connection, 'index_configs')).toBe(before);
    expect(() =>
      insert(connection, 'index_configs', {
        id: id(803),
        kind: 'document_chunk',
        model: null,
        dimensions: null,
        chunk_params: DOCUMENT_CHUNK_PARAMS,
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('the keyword indexes over document text and file names (AD-15, AD-24)', () => {
  it('find a Korean phrase in both, and lose it from the blocks when a name is rewritten', async () => {
    const connection = await seeded();

    expect(matches(connection, 'document_chunks_fts', NEEDLE)).toBe(1);
    expect(matches(connection, 'file_names_fts', NEEDLE)).toBe(1);
    expect(blocksHolding(connection, 'document_chunks_fts', NEEDLE_TRIGRAM)).toBeGreaterThan(0);
    expect(blocksHolding(connection, 'file_names_fts', NEEDLE_TRIGRAM)).toBeGreaterThan(0);

    // A name rewritten is an ordinary write and has to take the old text with
    // it, the same as a deletion does.
    connection.database.exec(
      `update file_names set "text" = '지난달 영수증.pdf' where id = '${ids.nameA}'`,
    );
    expect(matches(connection, 'file_names_fts', NEEDLE)).toBe(0);
    expect(blocksHolding(connection, 'file_names_fts', NEEDLE_TRIGRAM)).toBe(0);
    expect(matches(connection, 'file_names_fts', '"영수증"')).toBe(1);
  });

  it('lose the masked file\u2019s text from both indexes, rows and blocks alike', async () => {
    const connection = await seeded();
    connection.database.exec(
      `update files set current_extraction_id = '${ids.extractionA}' where id = '${ids.fileA}'`,
    );

    // The whole of `files.redact` as far as this migration owns it: the mark,
    // and the generation, the chunks and the names of that content going with
    // it, in one transaction. The indexes follow by trigger.
    const redacted = await withWrite(
      connection,
      async (held) => {
        await sql`update files set redacted_at = ${LATER}, current_extraction_id = null
                   where id = ${ids.fileA}`.execute(held);
        await sql`delete from document_chunks where extraction_id = ${ids.extractionA}`.execute(
          held,
        );
        await sql`delete from document_extractions where id = ${ids.extractionA}`.execute(held);
        await sql`delete from file_names where file_id = ${ids.fileA}`.execute(held);
        return 'masked';
      },
      { redact: true },
    );
    expect(redacted).toEqual({ ok: true, value: 'masked' });

    expect(matches(connection, 'document_chunks_fts', NEEDLE)).toBe(0);
    expect(matches(connection, 'file_names_fts', NEEDLE)).toBe(0);
    // Not only unfindable: gone from the stored blocks as well, which is what
    // `secure-delete` is turned on for.
    expect(blocksHolding(connection, 'document_chunks_fts', NEEDLE_TRIGRAM)).toBe(0);
    expect(blocksHolding(connection, 'file_names_fts', NEEDLE_TRIGRAM)).toBe(0);
    // The other file's document is untouched by any of it.
    expect(matches(connection, 'document_chunks_fts', '"영수증"')).toBe(1);
  });
});
