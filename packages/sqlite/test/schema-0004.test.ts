import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';
import { withWrite } from '../src/write.js';

/**
 * The fourth migration: the columns pre-store masking, the parser, drain and
 * extraction write into, and the three tables rebuilt to make room for them
 * (AD-11, AD-21, AD-23, AD-24).
 *
 * Two things are being held here. First, that the upgrade carries every row of
 * a version 3 database across — the three rebuilds are a `drop` and a copy, and
 * a copy that loses a row is a copy nobody can run twice. Second, that the new
 * keys, checks and triggers refuse what they say they refuse: nothing writes
 * these columns yet, so the schema is the whole of the promise until the
 * stories that use them arrive.
 */

/** Caller-minted ids, in the UUIDv7 shape every row carries (AD-8). */
function id(ordinal: number): string {
  return `01960000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
}

/** `sha256:` and 64 lower-case hex digits, which is what `files` accepts (AD-23). */
function hash(ordinal: number): string {
  return `sha256:${ordinal.toString(16).padStart(2, '0').repeat(32)}`;
}

const ids = {
  user: id(1),
  session: id(2),
  message: id(3),
  redaction: id(4),
  failure: id(5),
  file: id(10),
  extractionFirst: id(11),
  extractionSecond: id(12),
  chunk: id(13),
  work: id(14),
};

const SEEDED_AT = '2026-02-03T04:05:06.000Z';
const LATER = '2026-02-03T04:05:07.000Z';
const LATEST = '2026-02-03T04:05:08.000Z';

const EXTRACTOR = 'doc/1+demo-0.0.0';
/** The session token, the one spelling a session has outside this process. */
const SESSION_TOKEN = 'demo:session-0001';

// Canonical chunk locators, in the one spelling 0004 lets in: `type` first, no
// whitespace, and `page` only on a PDF (AD-24).
const PDF_LOCATOR = '{"type":"pdf","page":4}';
const TEXT_LOCATOR = '{"type":"text","start":0,"end":12}';

/**
 * The claim query of drain, written out because `work_items_due_idx` is shaped
 * for this one plan: least attempted first, due now, oldest id breaking the
 * tie. Story 2.11 sends this shape; a change to either has to be a change to
 * both, and the plan assertion below is what says so.
 */
const CLAIM_QUERY = `select id from work_items
                      where completed_at is null and next_attempt_at <= ?
                      order by attempts asc, id asc
                      limit ?`;

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-0004-'));
  directories.push(directory);
  return directory;
}

function open(path: string): SqliteConnection {
  const opened = openSqlite({ path, busyTimeoutMs: 3000 });
  if (!opened.ok) throw new Error(`could not open ${path}: ${opened.message}`);
  connections.push(opened.connection);
  return opened.connection;
}

type Row = Readonly<Record<string, string | number | null>>;

/** Quote every identifier, because `end` and `start` are column names. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function insert(connection: SqliteConnection, table: string, row: Row): void {
  const columns = Object.keys(row);
  connection.database
    .prepare(
      `insert into ${quote(table)} (${columns.map(quote).join(', ')})
            values (${columns.map(() => '?').join(', ')})`,
    )
    .run(...(Object.values(row) as SQLInputValue[]));
}

/**
 * A file that stopped at version 3, the way an install from before this story
 * did: only the first three migration files, copied into a folder of this
 * test's own. A folder the caller names is not held to
 * `SQLITE_SCHEMA_VERSION`, which is how the tests reach it.
 */
async function versionThreePath(): Promise<string> {
  const directory = await scratch();
  for (const name of ['0001_initial.sql', '0002_files_and_work.sql', '0003_users.sql']) {
    await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
  }
  const path = join(await scratch(), 'brain.db');
  expect(await runSqliteMigrations({ path, directory })).toEqual({
    ok: true,
    from: 0,
    to: 3,
    applied: ['0001_initial.sql', '0002_files_and_work.sql', '0003_users.sql'],
  });
  return path;
}

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const applied = await runSqliteMigrations({ path });
  expect(applied).toMatchObject({ ok: true, to: 7 });
  return path;
}

/**
 * One row in every table 0004 touches, written against the version 3 schema:
 * the shape the upgrade has to carry across.
 */
function seedVersionThree(connection: SqliteConnection): void {
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
  insert(connection, 'redactions', {
    id: ids.redaction,
    message_id: ids.message,
    start: 4,
    end: 9,
    kind: 'api_key',
    content_hash: 'not-a-real-hash',
    occurred_at: SEEDED_AT,
  });
  insert(connection, 'failures', {
    id: ids.failure,
    harness: 'demo',
    harness_session_id: 'session-0001',
    stage: 'ingest',
    fingerprint: 'c0ffee',
    session_id: ids.session,
    code: 'DB_UNAVAILABLE',
    message: 'the database was not there',
    occurred_at: SEEDED_AT,
    resolved_at: null,
  });
  insert(connection, 'files', {
    id: ids.file,
    content_hash: hash(1),
    size_bytes: 2048,
    first_seen_at: SEEDED_AT,
  });
  // Two generations of one file, started in this order: what the upgrade has to
  // turn into `attempt` 1 and 2.
  insert(connection, 'document_extractions', {
    id: ids.extractionSecond,
    file_id: ids.file,
    extractor_version: 'doc/2+demo-0.0.0',
    status: 'ok',
    started_at: LATER,
    finished_at: LATEST,
  });
  insert(connection, 'document_extractions', {
    id: ids.extractionFirst,
    file_id: ids.file,
    extractor_version: EXTRACTOR,
    status: 'ok',
    started_at: SEEDED_AT,
    finished_at: LATER,
  });
  // A piece with a page and no locator, because nothing recorded one yet.
  insert(connection, 'document_chunks', {
    id: ids.chunk,
    extraction_id: ids.extractionSecond,
    ordinal: 0,
    page: 7,
    body: '어제 받은 회의록 초안',
  });
  insert(connection, 'work_items', {
    id: ids.work,
    kind: 'extract',
    target_kind: 'file',
    target_id: ids.file,
    created_at: SEEDED_AT,
    next_attempt_at: SEEDED_AT,
  });
}

describe('the upgrade from version 3 to version 4', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    const path = await versionThreePath();
    const before = open(path);
    seedVersionThree(before);
    await before.close();
    connections.splice(connections.indexOf(before), 1);

    expect(await runSqliteMigrations({ path })).toEqual({
      ok: true,
      from: 3,
      to: 7,
      applied: [
        '0004_capture_columns.sql',
        '0005_identity_and_records.sql',
        '0006_drop_message_seq.sql',
      '0007_session_tag_source.sql',
      ],
    });

    connection = open(path);
  });

  it('leaves every row where it was, under its own id', () => {
    for (const table of [
      'users',
      'sessions',
      'messages',
      'redactions',
      'failures',
      'files',
      'document_chunks',
      'work_items',
    ]) {
      expect(connection.database.prepare(`select count(*) as n from ${table}`).get()?.n).toBe(1);
    }
    expect(
      connection.database.prepare('select count(*) as n from document_extractions').get()?.n,
    ).toBe(2);
    expect(connection.database.prepare('pragma foreign_key_check').all()).toEqual([]);
  });

  it('carries the masked span over as a message redaction with no pattern version', () => {
    expect(connection.database.prepare('select * from redactions').all()).toEqual([
      {
        id: ids.redaction,
        message_id: ids.message,
        file_id: null,
        start: 4,
        end: 9,
        kind: 'api_key',
        content_hash: 'not-a-real-hash',
        occurred_at: SEEDED_AT,
        pattern_version: null,
        // 0005's column, which no row written before it has anything to put in.
        tool_note_id: null,
      },
    ]);
  });

  it('moves the failure onto the session token as its target key', () => {
    expect(
      connection.database
        .prepare(
          `select target_kind, target_id, stage, fingerprint, harness, session_id
             from failures`,
        )
        .all(),
    ).toEqual([
      {
        target_kind: 'session',
        target_id: SESSION_TOKEN,
        stage: 'ingest',
        fingerprint: 'c0ffee',
        harness: 'demo',
        session_id: ids.session,
      },
    ]);
  });

  it('numbers the generations of a file by the order they were started', () => {
    expect(
      connection.database
        .prepare(
          `select id, attempt, failed_stage, index_config_id
             from document_extractions order by attempt`,
        )
        .all(),
    ).toEqual([
      { id: ids.extractionFirst, attempt: 1, failed_stage: null, index_config_id: null },
      { id: ids.extractionSecond, attempt: 2, failed_stage: null, index_config_id: null },
    ]);
  });

  it('leaves the columns nobody has written yet empty, and the old page alone', () => {
    expect(
      connection.database.prepare('select git_branch, is_subagent_report from messages').all(),
    ).toEqual([{ git_branch: null, is_subagent_report: 0 }]);
    expect(
      connection.database.prepare('select source_unreachable_at from files').all(),
    ).toEqual([{ source_unreachable_at: null }]);
    // The locator of a piece written before 0004 is unknown, not invented: the
    // page it already had stays exactly as it was.
    expect(connection.database.prepare('select page, chunk_locator from document_chunks').all()).toEqual(
      [{ page: 7, chunk_locator: null }],
    );
  });

  it('lets a write that leaves an old piece’s null locator where it was through', () => {
    // Nothing is taken away, so the trigger has nothing to refuse: a bulk
    // re-write touching the column must not trip over the rows before 0004.
    connection.database.exec('update document_chunks set chunk_locator = null');
    expect(connection.database.prepare('select page, chunk_locator from document_chunks').all()).toEqual(
      [{ page: 7, chunk_locator: null }],
    );
  });

  it('applies nothing the second time', async () => {
    const path = await migratedPath();
    expect(await runSqliteMigrations({ path })).toEqual({ ok: true, from: 7, to: 7, applied: [] });
  });
});

describe('the extraction key of 0004 (AD-24)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = open(await migratedPath());
    insert(connection, 'files', {
      id: ids.file,
      content_hash: hash(1),
      size_bytes: 2048,
      first_seen_at: SEEDED_AT,
    });
  });

  it('refuses a second generation with the same attempt number', () => {
    const first = {
      id: id(101),
      file_id: ids.file,
      extractor_version: EXTRACTOR,
      attempt: 1,
      status: 'ok',
      started_at: SEEDED_AT,
      finished_at: LATER,
    };
    insert(connection, 'document_extractions', first);
    expect(() =>
      insert(connection, 'document_extractions', { ...first, id: id(102) }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('allows one running generation per file, whatever version it is, and another once it is done', () => {
    const running = {
      id: id(103),
      file_id: ids.file,
      extractor_version: EXTRACTOR,
      attempt: 2,
      started_at: SEEDED_AT,
    };
    insert(connection, 'document_extractions', running);
    // A different extractor version is still a second reading of the same file.
    expect(() =>
      insert(connection, 'document_extractions', {
        ...running,
        id: id(104),
        attempt: 3,
        extractor_version: 'doc/9+demo-0.0.0',
      }),
    ).toThrow(/UNIQUE constraint failed/);

    connection.database.exec(
      `update document_extractions set status = 'failed', finished_at = '${LATER}',
              failed_stage = 'extract'
         where id = '${running.id}'`,
    );
    insert(connection, 'document_extractions', { ...running, id: id(105), attempt: 3 });
  });

  it.each([
    { name: 'an attempt below one', attempt: 0, status: null, stage: null },
    { name: 'a stage on a generation that did not fail', attempt: 9, status: 'ok', stage: 'read' },
    { name: 'a stage nobody extracts in', attempt: 9, status: 'failed', stage: 'upload' },
  ])('refuses $name', ({ attempt, status, stage }) => {
    expect(() =>
      insert(connection, 'document_extractions', {
        id: id(106),
        file_id: ids.file,
        extractor_version: EXTRACTOR,
        attempt,
        status,
        started_at: SEEDED_AT,
        finished_at: status === null ? null : LATER,
        failed_stage: stage,
      }),
    ).toThrow(/CHECK constraint failed/);
  });
});

describe('the failure target key of 0004 (AD-21)', () => {
  let connection: SqliteConnection;

  const failure = {
    id: id(201),
    target_kind: 'session',
    target_id: SESSION_TOKEN,
    stage: 'ingest',
    fingerprint: 'c0ffee',
    harness: 'demo',
    session_id: null,
    code: 'DB_UNAVAILABLE',
    message: 'the database was not there',
    occurred_at: SEEDED_AT,
    // Both `not null` with no default since 0005, which this file's own rows
    // have to fill because `migratedPath` is at the shipped version.
    first_occurred_at: SEEDED_AT,
    occurrences: 1,
  };

  beforeAll(async () => {
    connection = open(await migratedPath());
    // A session failure is recordable with no session row to point at, which is
    // the whole reason the key is the token and not the row (AD-12).
    insert(connection, 'failures', failure);
  });

  it('refuses a second failure with the same target, stage and fingerprint', () => {
    expect(() => insert(connection, 'failures', { ...failure, id: id(202) })).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it.each([
    { name: 'another kind of target', id: id(211), change: { target_kind: 'file' } },
    {
      name: 'another target of the same kind',
      id: id(212),
      change: { target_id: 'demo:session-0002' },
    },
    { name: 'another stage', id: id(213), change: { stage: 'extract' } },
    { name: 'another fingerprint', id: id(214), change: { fingerprint: 'beef' } },
  ])('allows one that differs by $name', ({ id: rowId, change }) => {
    insert(connection, 'failures', { ...failure, id: rowId, ...change });
  });
});

describe('the redaction record of 0004 (AD-11, AD-23)', () => {
  let connection: SqliteConnection;

  const messageRedaction = {
    id: id(301),
    message_id: ids.message,
    file_id: null,
    start: 0,
    end: 3,
    kind: 'api_key',
    content_hash: 'not-a-real-hash',
    occurred_at: SEEDED_AT,
    pattern_version: 'secrets/1',
  };

  beforeAll(async () => {
    connection = open(await migratedPath());
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
      role: 'user',
      body: 'the key is somewhere in here',
      occurred_at: SEEDED_AT,
    });
    insert(connection, 'files', {
      id: ids.file,
      content_hash: hash(1),
      size_bytes: 2048,
      first_seen_at: SEEDED_AT,
    });
    insert(connection, 'redactions', messageRedaction);
  });

  it('takes a file redaction, which has no range because the whole content goes', () => {
    insert(connection, 'redactions', {
      ...messageRedaction,
      id: id(302),
      message_id: null,
      file_id: ids.file,
      start: null,
      end: null,
    });
    expect(
      connection.database
        .prepare('select file_id, start, "end", pattern_version from redactions where id = ?')
        .get(id(302)),
    ).toEqual({ file_id: ids.file, start: null, end: null, pattern_version: 'secrets/1' });
  });

  it.each([
    {
      name: 'a redaction of both a message and a file',
      row: { id: id(303), file_id: ids.file },
    },
    {
      name: 'a redaction of nothing at all',
      row: { id: id(304), message_id: null },
    },
    {
      name: 'a file redaction that claims a range',
      row: { id: id(305), message_id: null, file_id: ids.file },
    },
    {
      name: 'a message redaction with no range',
      row: { id: id(306), start: null, end: null },
    },
    {
      name: 'a message range that is not half-open',
      row: { id: id(307), start: 4, end: 4 },
    },
  ])('refuses $name', ({ row }) => {
    expect(() => insert(connection, 'redactions', { ...messageRedaction, ...row })).toThrow(
      /CHECK constraint failed/,
    );
  });

  it.each([
    `update redactions set kind = 'token'`,
    `update redactions set content_hash = 'another-hash'`,
    `delete from redactions`,
  ])('refuses `%s` outright', (statement) => {
    expect(() => connection.database.exec(statement)).toThrow(/redactions[\s\S]*immutable/);
  });

  it('refuses the same under a raised redaction marker: the marker writes, it does not edit', async () => {
    const marked = await withWrite(
      connection,
      async (held) => {
        await expect(sql`update redactions set kind = 'token'`.execute(held)).rejects.toThrow(
          /redactions[\s\S]*immutable/,
        );
        await expect(sql`delete from redactions`.execute(held)).rejects.toThrow(
          /redactions[\s\S]*immutable/,
        );
        // Writing a new one is what the marker is for, and it still works.
        await sql`insert into redactions (id, message_id, file_id, start, "end", kind,
                                          content_hash, occurred_at, pattern_version)
                       values (${id(308)}, ${ids.message}, null, 10, 14, 'api_key',
                               'not-a-real-hash', ${SEEDED_AT}, 'secrets/1')`.execute(held);
        return 'checked';
      },
      { redact: true },
    );
    expect(marked).toEqual({ ok: true, value: 'checked' });
  });
});

describe('the new message columns of 0004 (AD-4, AD-11)', () => {
  let connection: SqliteConnection;
  const BODY = 'the key is somewhere in here';

  beforeAll(async () => {
    connection = open(await migratedPath());
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
      role: 'user',
      body: BODY,
      occurred_at: SEEDED_AT,
      git_branch: 'feature/capture',
      is_subagent_report: 1,
    });
  });

  it('refuses anything but 0 or 1 for the subagent mark', () => {
    expect(() =>
      insert(connection, 'messages', {
        id: id(401),
        session_id: ids.session,
        harness_message_id: 'h-2',
        role: 'assistant',
        body: 'x',
        occurred_at: SEEDED_AT,
        is_subagent_report: 2,
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it.each([
    `update messages set git_branch = 'main'`,
    `update messages set is_subagent_report = 0`,
  ])('refuses `%s`', (statement) => {
    expect(() => connection.database.exec(statement)).toThrow(/messages[\s\S]*immutable/);
  });

  it('refuses them under a raised marker too, and still lets the body alone through', async () => {
    const marked = await withWrite(
      connection,
      async (held) => {
        await expect(sql`update messages set git_branch = 'main'`.execute(held)).rejects.toThrow(
          /messages[\s\S]*immutable/,
        );
        await expect(
          sql`update messages set is_subagent_report = 0`.execute(held),
        ).rejects.toThrow(/messages[\s\S]*immutable/);
        await sql`update messages set body = 'the key is [REDACTED:api_key]'`.execute(held);
        return 'checked';
      },
      { redact: true },
    );
    expect(marked).toEqual({ ok: true, value: 'checked' });

    expect(
      connection.database.prepare('select body, git_branch, is_subagent_report from messages').all(),
    ).toEqual([
      {
        body: 'the key is [REDACTED:api_key]',
        git_branch: 'feature/capture',
        is_subagent_report: 1,
      },
    ]);
  });
});

describe('the chunk locator of 0004 (AD-24)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = open(await migratedPath());
    insert(connection, 'files', {
      id: ids.file,
      content_hash: hash(1),
      size_bytes: 2048,
      first_seen_at: SEEDED_AT,
    });
    insert(connection, 'document_extractions', {
      id: ids.extractionFirst,
      file_id: ids.file,
      extractor_version: EXTRACTOR,
      attempt: 1,
      status: 'ok',
      started_at: SEEDED_AT,
      finished_at: LATER,
    });
  });

  it('takes a canonical PDF locator whose page matches the column, and a text range with none', () => {
    insert(connection, 'document_chunks', {
      id: id(501),
      extraction_id: ids.extractionFirst,
      ordinal: 0,
      page: 4,
      body: 'a page of the document',
      chunk_locator: PDF_LOCATOR,
    });
    insert(connection, 'document_chunks', {
      id: id(502),
      extraction_id: ids.extractionFirst,
      ordinal: 1,
      page: null,
      body: 'a stretch of plain text',
      chunk_locator: TEXT_LOCATOR,
    });
    expect(
      connection.database
        .prepare('select page, chunk_locator from document_chunks order by ordinal')
        .all(),
    ).toEqual([
      { page: 4, chunk_locator: PDF_LOCATOR },
      { page: null, chunk_locator: TEXT_LOCATOR },
    ]);
  });

  it.each([
    {
      name: 'a locator spelled with whitespace in it',
      page: null,
      locator: '{"type": "text", "start": 0, "end": 12}',
    },
    { name: 'a kind of locator nobody produces', page: null, locator: '{"type":"zip"}' },
    {
      name: 'a PDF locator whose page is not the column',
      page: 9,
      locator: PDF_LOCATOR,
    },
    { name: 'a page on something that is not a PDF', page: 4, locator: TEXT_LOCATOR },
  ])('refuses $name', ({ page, locator }) => {
    expect(() =>
      insert(connection, 'document_chunks', {
        id: id(503),
        extraction_id: ids.extractionFirst,
        ordinal: 9,
        page,
        body: 'a piece',
        chunk_locator: locator,
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('refuses a new piece with no locator at all, and refuses taking one away', () => {
    expect(() =>
      insert(connection, 'document_chunks', {
        id: id(504),
        extraction_id: ids.extractionFirst,
        ordinal: 10,
        page: null,
        body: 'a piece from nowhere',
      }),
    ).toThrow(/chunk_locator is required/);
    expect(() =>
      connection.database.exec('update document_chunks set chunk_locator = null'),
    ).toThrow(/chunk_locator is required/);
  });
});

describe('the claim index of 0004 (AD-21)', () => {
  it('answers the claim query from the index, in its order, with no temporary sort', async () => {
    const connection = open(await migratedPath());
    const plan = connection.database
      .prepare(`explain query plan ${CLAIM_QUERY}`)
      .all(SEEDED_AT, 10)
      .map((row) => String(row.detail))
      .join('\n');

    expect(plan).toContain('work_items_due_idx');
    // The whole point of the column order: the index is already in `attempts,
    // id` order, so the planner has nothing left to sort.
    expect(plan).not.toContain('TEMP B-TREE');
  });

  it('answers it in that order: least attempted first, oldest id breaking the tie', async () => {
    const connection = open(await migratedPath());
    const item = (ordinal: number, attempts: number, due: string, completed: string | null) => ({
      id: id(ordinal),
      kind: 'extract',
      target_kind: 'file',
      target_id: `file-${String(ordinal)}`,
      created_at: SEEDED_AT,
      attempts,
      next_attempt_at: due,
      completed_at: completed,
    });
    insert(connection, 'work_items', item(601, 3, SEEDED_AT, null));
    insert(connection, 'work_items', item(602, 0, SEEDED_AT, null));
    insert(connection, 'work_items', item(603, 0, SEEDED_AT, null));
    // Not due yet, and already done: neither is in the backlog the index holds.
    insert(connection, 'work_items', item(604, 0, LATEST, null));
    insert(connection, 'work_items', item(605, 0, SEEDED_AT, LATER));

    expect(
      connection.database
        .prepare(CLAIM_QUERY)
        .all(SEEDED_AT, 10)
        .map((row) => String(row.id)),
    ).toEqual([id(602), id(603), id(601)]);
  });
});
