import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import {
  SQLITE_MIGRATIONS_DIRECTORY,
  SQLITE_SCHEMA_VERSION,
  runSqliteMigrations,
} from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';
import { withWrite } from '../src/write.js';

/**
 * The Table Contract minus `embeddings`, which arrives the day embedding is
 * switched on (AD-15). This is the source of truth's own list: a table that
 * arrives here without being written down is the drift AD-22 is about, and this
 * is where it shows. The Postgres replica is behind by the file tables of
 * AD-23 and AD-24 until epic 7 catches it up, so its own test's list is the
 * shorter one on purpose.
 */
const EXPECTED_TABLES = [
  'chunks',
  'context_injections',
  'document_chunks',
  'document_extractions',
  'failures',
  'file_locations',
  'file_metadata',
  'file_names',
  'files',
  'index_configs',
  'log_entries',
  'log_entry_edits',
  'message_attachments',
  'messages',
  'projects',
  'redactions',
  'schedules',
  'schema_version',
  'sessions',
  'tool_notes',
  'transcript_files',
  'users',
  'work_items',
  'workspaces',
  'worktrees',
];

/** Caller-minted ids, in the UUIDv7 shape every row carries (AD-8). */
function id(ordinal: number): string {
  return `01940000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
}

const ids = {
  workspace: id(1),
  project: id(2),
  worktree: id(3),
  session: id(4),
  message: id(5),
  toolNote: id(6),
  rule: id(7),
  edit: id(8),
  indexConfig: id(9),
  chunk: id(10),
  injection: id(11),
  failure: id(12),
  transcriptFile: id(13),
  redaction: id(14),
  user: id(15),
};

/** The row the migration itself writes (AD-15). */
const DEFAULT_INDEX_CONFIG = '019a0000-0000-7000-8000-000000000001';
const DEFAULT_CHUNK_PARAMS = '{"targetChars":1200,"overlapMessages":1,"splitMessagesOverChars":2400}';

const SEEDED_AT = '2026-02-03T04:05:06.000Z';

// A neutral stand-in for a secret, so the fixture carries no real one
// (Conventions: public repository hygiene).
const SECRET = 'sk-0123456789';
// One of the trigrams the tokenizer makes of it, so the stored blocks can be
// searched for a term and not for the whole string.
const SECRET_TRIGRAM = '345';
// Korean, because the trigram tokenizer is in the schema for languages that do
// not put spaces between words (AD-15); a sentence of English words would pass
// with any tokenizer at all.
const KOREAN = '어제 결정한 저장소 방향';
const NEEDLE = '"저장소"';
const MESSAGE_BODY = `the key is ${SECRET}, and ${KOREAN}`;
const TOOL_TARGET = `/demo/repo/${SECRET}/readme.md`;

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-schema-'));
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
    to: 9,
    applied: [
      '0001_initial.sql',
      '0002_files_and_work.sql',
      '0003_users.sql',
      '0004_capture_columns.sql',
      '0005_identity_and_records.sql',
      '0006_drop_message_seq.sql',
      '0007_session_tag_source.sql',
      '0008_attachment_rules.sql',
      '0009_schedules.sql',
    ],
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

/** Quote every identifier, because `end`, `start` and `text` are column names. */
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
 * that finds nothing only says the index will not answer with the row; `delete`
 * writes a tombstone by default and leaves the terms in the blocks until some
 * later merge, which for a redaction is the secret still on disk (AD-11).
 */
function blocksHolding(connection: SqliteConnection, index: string, text: string): number {
  const row = connection.database
    .prepare(`select count(*) as n from ${index}_data where instr(cast(block as text), ?) > 0`)
    .get(text);
  return Number(row?.n ?? -1);
}

/**
 * One row per table, in dependency order. `redactions` is left to the tests
 * that write it, and the chunk config is the one the migration already wrote.
 */
function seed(connection: SqliteConnection): void {
  insert(connection, 'workspaces', { id: ids.workspace, name: 'demo-workspace' });
  insert(connection, 'projects', {
    id: ids.project,
    remote_identity: 'example.com/demo/repo',
    workspace_id: ids.workspace,
    // `not null` since 0005. `example.com` is not one of the hosts the key
    // folds, so it is the remote spelled exactly as it stands.
    identity_key: 'example.com/demo/repo',
  });
  insert(connection, 'worktrees', {
    id: ids.worktree,
    project_id: ids.project,
    path: '/demo/repo',
    removed_at: null,
  });
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
    workspace_id: ids.workspace,
    project_id: ids.project,
    worktree_id: ids.worktree,
    tag_source: 'cwd',
    ingest_source: 'live',
    start_source: 'startup',
  });
  insert(connection, 'messages', {
    id: ids.message,
    session_id: ids.session,
    harness_message_id: 'h-1',
    role: 'user',
    model: null,
    body: MESSAGE_BODY,
    occurred_at: SEEDED_AT,
  });
  insert(connection, 'tool_notes', {
    id: ids.toolNote,
    session_id: ids.session,
    harness_message_id: 'h-1',
    ordinal: 0,
    tool: 'read',
    target: TOOL_TARGET,
    ok: 1,
  });
  insert(connection, 'log_entries', {
    id: ids.rule,
    kind: 'rule',
    session_id: ids.session,
    occurred_at: SEEDED_AT,
    recorded_at: SEEDED_AT,
    author_model: null,
    text: KOREAN,
    rule_state: 'on',
    apply_project_id: ids.project,
    supersedes_id: null,
  });
  insert(connection, 'log_entry_edits', {
    id: ids.edit,
    log_entry_id: ids.rule,
    previous_text: 'an earlier sentence',
    edited_at: SEEDED_AT,
  });
  insert(connection, 'index_configs', {
    id: ids.indexConfig,
    kind: 'chunk',
    model: null,
    dimensions: null,
    chunk_params: '{"targetChars":900,"overlapMessages":1,"splitMessagesOverChars":2400}',
  });
  insert(connection, 'chunks', {
    id: ids.chunk,
    session_id: ids.session,
    index_config_id: DEFAULT_INDEX_CONFIG,
    // The stretch of conversation the chunk covers, as the instants of its
    // first and last message -- here the one message above (migration 0006).
    from_at: SEEDED_AT,
    to_at: SEEDED_AT,
    body: MESSAGE_BODY,
  });
  insert(connection, 'context_injections', {
    id: ids.injection,
    session_id: ids.session,
    attempted_at: SEEDED_AT,
    ok: 1,
    code: null,
    chars: 420,
  });
  insert(connection, 'failures', {
    id: ids.failure,
    target_kind: 'session',
    target_id: 'demo:session-0001',
    stage: 'ingest',
    fingerprint: 'c0ffee',
    harness: 'demo',
    session_id: ids.session,
    code: 'DB_UNAVAILABLE',
    message: 'the database was not there',
    occurred_at: SEEDED_AT,
    resolved_at: null,
    // Both `not null` with no default since 0005.
    first_occurred_at: SEEDED_AT,
    occurrences: 1,
  });
  insert(connection, 'transcript_files', {
    id: ids.transcriptFile,
    harness: 'demo',
    path: '/demo/transcripts/session-0001.jsonl',
    size_bytes: 1024,
    fingerprint: 'f1',
    last_harness_message_id: 'h-1',
    cursor_fingerprint: 'f1',
    scanned_at: SEEDED_AT,
  });
}

/** A migrated file with one row per table, open. */
async function seeded(): Promise<SqliteConnection> {
  const connection = open(await migratedPath());
  seed(connection);
  return connection;
}

/** The ordinary tables: no views, no virtual tables, no FTS5 shadow tables. */
function tableNames(connection: SqliteConnection): string[] {
  return connection.database
    .prepare(
      `select name from pragma_table_list
        where schema = 'main' and type = 'table' and name not like 'sqlite_%'
        order by name`,
    )
    .all()
    .map((row) => String(row.name));
}

describe('the migration this package ships', () => {
  it('creates exactly the Table Contract, every table STRICT, and the default chunk config', async () => {
    const connection = open(await migratedPath());

    expect(tableNames(connection)).toEqual(EXPECTED_TABLES);
    // Without STRICT a column takes whatever it is handed, and a replica that
    // copies the data has no way back.
    const loose = connection.database
      .prepare(
        `select name from pragma_table_list
          where schema = 'main' and type = 'table' and name not like 'sqlite_%' and strict = 0`,
      )
      .all()
      .map((row) => String(row.name));
    expect(loose).toEqual([]);

    // The conversation chunking row, which is the one 0001 writes. The document
    // chunking row beside it belongs to 0002 and is checked in
    // `schema-files.test.ts`, so each migration's seed has one owner.
    expect(
      connection.database
        .prepare(
          `select id, kind, model, dimensions, chunk_params from index_configs
            where kind = 'chunk'`,
        )
        .all(),
    ).toEqual([
      {
        id: DEFAULT_INDEX_CONFIG,
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params: DEFAULT_CHUNK_PARAMS,
      },
    ]);
  });

  it('answers the store with the version this package ships and every capability probe ok', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      const stored = await store.readSchemaVersion();
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.version?.version).toBe(SQLITE_SCHEMA_VERSION);

      const health = await store.checkHealth();
      expect(health.ok).toBe(true);
      if (!health.ok) return;
      expect(health.source.probes.map((probe) => [probe.id, probe.ok])).toEqual([
        ['writable', true],
        ['wal', true],
        ['fts5-trigram', true],
        ['foreign-keys', true],
      ]);
    } finally {
      await store.close();
    }
  });

  it('applies nothing the second time and leaves the schema and the rows alone', async () => {
    const path = await migratedPath();
    const connection = open(path);
    const before = tableNames(connection);
    const configs = count(connection, 'index_configs');

    expect(await runSqliteMigrations({ path })).toEqual({ ok: true, from: 9, to: 9, applied: [] });

    expect(tableNames(connection)).toEqual(before);
    expect(count(connection, 'index_configs')).toBe(configs);
  });

  it('reaches exactly SQLITE_SCHEMA_VERSION', async () => {
    const numbered = (await readdir(SQLITE_MIGRATIONS_DIRECTORY))
      .map((name) => /^(\d{4})_.+\.sql$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));

    expect(numbered.length).toBeGreaterThan(0);
    expect(Math.max(...numbered)).toBe(SQLITE_SCHEMA_VERSION);
  });
});

describe('the immutability triggers (AD-11)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  // The two that look like inserts are in here on purpose: `INSERT OR REPLACE`
  // deletes the conflicting row and an upsert updates it, so a table whose
  // triggers only watched `update ... set` would let a rewrite in through the
  // insert path (AD-8).
  it.each([
    { statement: `update messages set body = 'rewritten'`, table: 'messages' },
    { statement: `update messages set occurred_at = '2026-03-04T05:06:07.000Z'`, table: 'messages' },
    { statement: `delete from messages`, table: 'messages' },
    {
      statement: `insert or replace into messages (id, session_id, harness_message_id, role, body, occurred_at)
                       values ('${id(55)}', '${ids.session}', 'h-1', 'user', 'rewritten', '${SEEDED_AT}')`,
      table: 'messages',
    },
    {
      statement: `insert into messages (id, session_id, harness_message_id, role, body, occurred_at)
                       values ('${id(56)}', '${ids.session}', 'h-1', 'user', 'rewritten', '${SEEDED_AT}')
                  on conflict (session_id, harness_message_id) do update set body = 'rewritten'`,
      table: 'messages',
    },
    { statement: `update tool_notes set target = 'elsewhere'`, table: 'tool_notes' },
    { statement: `delete from tool_notes`, table: 'tool_notes' },
    {
      statement: `insert or replace into tool_notes (id, session_id, harness_message_id, ordinal, tool, target, ok)
                       values ('${id(57)}', '${ids.session}', 'h-1', 0, 'read', 'elsewhere', 1)`,
      table: 'tool_notes',
    },
    {
      statement: `insert into tool_notes (id, session_id, harness_message_id, ordinal, tool, target, ok)
                       values ('${id(58)}', '${ids.session}', 'h-1', 0, 'read', 'elsewhere', 1)
                  on conflict (session_id, harness_message_id, ordinal) do update set target = 'elsewhere'`,
      table: 'tool_notes',
    },
  ])('refuses `$statement`', ({ statement, table }) => {
    expect(() => connection.database.exec(statement)).toThrow(
      new RegExp(`${table}[\\s\\S]*immutable`),
    );
  });

  it('leaves the rows exactly as they were', () => {
    expect(connection.database.prepare('select body, occurred_at from messages').all()).toEqual([
      { body: MESSAGE_BODY, occurred_at: SEEDED_AT },
    ]);
    expect(connection.database.prepare('select target from tool_notes').all()).toEqual([
      { target: TOOL_TARGET },
    ]);
  });

  it('refuses a marked update that touches any column but the text it masks', async () => {
    const marked = await withWrite(
      connection,
      async (held) => {
        await expect(
          sql`update messages set body = 'rewritten', role = 'assistant'`.execute(held),
        ).rejects.toThrow(/messages[\s\S]*immutable/);
        await expect(sql`delete from messages`.execute(held)).rejects.toThrow(
          /messages[\s\S]*immutable/,
        );
        await expect(
          sql`update tool_notes set target = 'elsewhere', tool = 'write'`.execute(held),
        ).rejects.toThrow(/tool_notes[\s\S]*immutable/);
        return 'checked';
      },
      { redact: true },
    );
    expect(marked).toEqual({ ok: true, value: 'checked' });
  });

  it('lowers the marker again when a marked write rolls back, so the next update is refused', async () => {
    const boom = new Error('the redaction chain gave up');
    await expect(
      withWrite(
        connection,
        async () => {
          throw boom;
        },
        { redact: true },
      ),
    ).rejects.toThrow(boom);

    expect(connection.isRedactAllowed()).toBe(false);
    expect(() => connection.database.exec(`update messages set body = 'rewritten'`)).toThrow(
      /messages[\s\S]*immutable/,
    );
  });
});

describe('a redaction, the one way past the triggers (AD-11)', () => {
  it('masks the body and the tool note, and takes the removed text out of every index', async () => {
    const connection = await seeded();

    expect(matches(connection, 'chunks_fts', `"${SECRET}"`)).toBe(1);
    expect(matches(connection, 'tool_notes_fts', `"${SECRET}"`)).toBe(1);
    expect(blocksHolding(connection, 'chunks_fts', SECRET_TRIGRAM)).toBeGreaterThan(0);
    expect(blocksHolding(connection, 'tool_notes_fts', SECRET_TRIGRAM)).toBeGreaterThan(0);

    // The whole chain of AD-11 in one transaction: the body, the tool note and
    // the chunks built from that message. The index follows by trigger, which
    // is the part this migration owns.
    const redacted = await withWrite(
      connection,
      async (held) => {
        await sql`update messages set body = ${`the key is [REDACTED:api_key], and ${KOREAN}`}
                   where id = ${ids.message}`.execute(held);
        await sql`update tool_notes set target = ${'/demo/repo/[REDACTED:api_key]/readme.md'}
                   where id = ${ids.toolNote}`.execute(held);
        await sql`delete from chunks where session_id = ${ids.session}`.execute(held);
        await sql`insert into redactions (id, message_id, start, "end", kind, content_hash, occurred_at)
                       values (${ids.redaction}, ${ids.message}, 11, ${11 + SECRET.length},
                               'api_key', 'not-a-real-hash', ${SEEDED_AT})`.execute(held);
        return 'masked';
      },
      { redact: true },
    );
    expect(redacted).toEqual({ ok: true, value: 'masked' });

    // Nowhere: not in the rows, not in the indexes that were built from them.
    const bodies = connection.database
      .prepare('select body from messages')
      .all()
      .map((row) => String(row.body));
    const targets = connection.database
      .prepare('select target from tool_notes')
      .all()
      .map((row) => String(row.target));
    expect(bodies.join('\n')).not.toContain(SECRET);
    expect(targets.join('\n')).not.toContain(SECRET);
    expect(matches(connection, 'chunks_fts', `"${SECRET}"`)).toBe(0);
    expect(matches(connection, 'tool_notes_fts', `"${SECRET}"`)).toBe(0);
    expect(matches(connection, 'log_entries_fts', `"${SECRET}"`)).toBe(0);
    // Not only unfindable: gone from the stored blocks as well, which is what
    // `secure-delete` is turned on for.
    expect(blocksHolding(connection, 'chunks_fts', SECRET_TRIGRAM)).toBe(0);
    expect(blocksHolding(connection, 'tool_notes_fts', SECRET_TRIGRAM)).toBe(0);

    // The marker is a variable in this process, not a property of the row, so
    // it has to be down again the moment the transaction ended.
    expect(connection.isRedactAllowed()).toBe(false);
    expect(() => connection.database.exec(`update messages set body = 'rewritten'`)).toThrow(
      /messages[\s\S]*immutable/,
    );
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
  const workspace = { id: id(101), name: 'second-workspace' };
  const project = {
    id: id(102),
    remote_identity: 'example.com/demo/other',
    workspace_id: null,
    identity_key: 'example.com/demo/other',
  };
  const worktree = { id: id(103), project_id: ids.project, path: '/demo/other' };
  const session = {
    id: id(104),
    harness: 'demo',
    harness_session_id: 'session-0002',
    user_id: ids.user,
    machine: 'demo-machine',
    started_at: SEEDED_AT,
    ingest_source: 'live',
    start_source: null,
  };
  const message = {
    id: id(105),
    session_id: ids.session,
    harness_message_id: 'h-2',
    role: 'assistant',
    body: 'a second message',
    occurred_at: SEEDED_AT,
  };
  const toolNote = {
    id: id(106),
    session_id: ids.session,
    harness_message_id: 'h-2',
    ordinal: 0,
    tool: 'read',
    target: '/demo/repo/other.md',
    ok: 1,
  };
  const logEntry = {
    id: id(107),
    kind: 'progress',
    session_id: ids.session,
    occurred_at: SEEDED_AT,
    recorded_at: SEEDED_AT,
    text: 'got the migration in',
  };
  const edit = {
    id: id(108),
    log_entry_id: ids.rule,
    previous_text: 'an earlier sentence',
    edited_at: SEEDED_AT,
  };
  // `model` and `dimensions` stay null on both, which is what the `coalesce`
  // index is there for: SQLite's own `unique` counts every null as its own
  // value and would let the second one in.
  const indexConfig = {
    id: id(109),
    kind: 'chunk',
    model: null,
    dimensions: null,
    chunk_params: '{"targetChars":1500,"overlapMessages":1,"splitMessagesOverChars":2400}',
  };
  const chunk = {
    id: id(110),
    session_id: ids.session,
    index_config_id: DEFAULT_INDEX_CONFIG,
    from_at: '2026-02-03T04:05:07.000Z',
    to_at: '2026-02-03T04:05:08.000Z',
    body: 'a chunk',
  };
  const redaction = {
    id: id(111),
    message_id: ids.message,
    start: 0,
    end: 3,
    kind: 'api_key',
    content_hash: 'not-a-real-hash',
    occurred_at: SEEDED_AT,
  };
  const injection = {
    id: id(112),
    session_id: ids.session,
    attempted_at: SEEDED_AT,
    ok: 0,
    code: 'DB_UNAVAILABLE',
    chars: 0,
  };
  const failure = {
    id: id(113),
    target_kind: 'session',
    target_id: 'demo:session-0002',
    stage: 'ingest',
    fingerprint: 'beef',
    harness: 'demo',
    session_id: null,
    code: 'DB_UNAVAILABLE',
    message: 'again',
    occurred_at: SEEDED_AT,
    first_occurred_at: SEEDED_AT,
    occurrences: 1,
  };
  const transcriptFile = {
    id: id(114),
    harness: 'demo',
    path: '/demo/transcripts/session-0002.jsonl',
    size_bytes: 10,
    fingerprint: 'f2',
    scanned_at: SEEDED_AT,
  };

  const other = (row: Row, ordinal: number): Row => ({ ...row, id: id(ordinal) });

  return [
    { table: 'workspaces', key: 'name', first: workspace, second: other(workspace, 201) },
    { table: 'projects', key: 'remote_identity', first: project, second: other(project, 202) },
    {
      table: 'worktrees',
      key: '(project_id, path)',
      first: worktree,
      second: other(worktree, 203),
    },
    {
      table: 'sessions',
      key: '(harness, harness_session_id)',
      first: session,
      second: other(session, 204),
    },
    {
      table: 'messages',
      key: '(session_id, harness_message_id)',
      first: message,
      second: { ...other(message, 205), body: 'another body under the same id' },
    },
    {
      table: 'tool_notes',
      key: '(session_id, harness_message_id, ordinal)',
      first: toolNote,
      second: other(toolNote, 207),
    },
    {
      table: 'log_entries',
      key: 'id',
      first: logEntry,
      second: { ...logEntry, text: 'a different sentence' },
    },
    {
      table: 'log_entry_edits',
      key: 'id',
      first: edit,
      second: { ...edit, previous_text: 'something else' },
    },
    {
      table: 'index_configs',
      key: '(kind, model, dimensions, chunk_params), nulls not distinct',
      first: indexConfig,
      second: other(indexConfig, 209),
    },
    {
      table: 'chunks',
      key: '(session_id, index_config_id, from_at, to_at)',
      first: chunk,
      second: { ...other(chunk, 210), body: 'another chunk' },
    },
    {
      table: 'redactions',
      key: 'id',
      first: redaction,
      second: { ...redaction, kind: 'token' },
    },
    {
      table: 'context_injections',
      key: 'id',
      first: injection,
      second: { ...injection, chars: 1 },
    },
    {
      table: 'failures',
      key: '(target_kind, target_id, stage, fingerprint)',
      first: failure,
      second: other(failure, 213),
    },
    {
      table: 'transcript_files',
      key: '(harness, path)',
      first: transcriptFile,
      second: other(transcriptFile, 214),
    },
  ];
}

describe('the idempotency keys (AD-8)', () => {
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

  it('keeps schema_version to one row, forever', () => {
    connection.database.exec('begin');
    try {
      expect(() =>
        insert(connection, 'schema_version', { id: 1, version: 99, applied_at: SEEDED_AT }),
      ).toThrow(/UNIQUE constraint failed/);
      expect(() =>
        insert(connection, 'schema_version', { id: 2, version: 99, applied_at: SEEDED_AT }),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      connection.database.exec('rollback');
    }
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
      name: 'an instant that is not the canonical 24 characters',
      table: 'sessions',
      row: {
        id: id(301),
        harness: 'demo',
        harness_session_id: 'session-0301',
        user_id: ids.user,
        machine: 'demo-machine',
        started_at: '2026-10-14T01:02:03Z',
        ingest_source: 'live',
      },
    },
    {
      name: 'an instant with an offset instead of Z',
      table: 'context_injections',
      row: {
        id: id(302),
        session_id: ids.session,
        attempted_at: '2026-10-14T10:02:03.004+09:00',
        ok: 1,
        code: null,
        chars: 0,
      },
    },
    {
      name: 'a boolean that is neither 0 nor 1',
      table: 'context_injections',
      row: {
        id: id(303),
        session_id: ids.session,
        attempted_at: SEEDED_AT,
        ok: 2,
        code: null,
        chars: 0,
      },
    },
    {
      name: 'a role nobody utters',
      table: 'messages',
      row: {
        id: id(304),
        session_id: ids.session,
        harness_message_id: 'h-role',
        role: 'system',
        body: 'x',
        occurred_at: SEEDED_AT,
      },
    },
    {
      name: 'a rule state on something that is not a rule',
      table: 'log_entries',
      row: {
        id: id(305),
        kind: 'progress',
        session_id: ids.session,
        occurred_at: SEEDED_AT,
        recorded_at: SEEDED_AT,
        text: 'x',
        rule_state: 'on',
      },
    },
    {
      name: 'half a parser cursor on a transcript file',
      table: 'transcript_files',
      row: {
        id: id(306),
        harness: 'demo',
        path: '/demo/transcripts/session-0306.jsonl',
        size_bytes: 10,
        fingerprint: 'f3',
        last_harness_message_id: null,
        cursor_fingerprint: 'f3',
        scanned_at: SEEDED_AT,
      },
    },
    {
      name: 'a redaction range that is not half-open',
      table: 'redactions',
      row: {
        id: id(307),
        message_id: ids.message,
        start: 4,
        end: 4,
        kind: 'api_key',
        content_hash: 'not-a-real-hash',
        occurred_at: SEEDED_AT,
      },
    },
  ])('refuses $name', ({ table, row }) => {
    expect(() => insert(connection, table, row)).toThrow(/CHECK constraint failed/);
  });

  it('refuses a REAL where the column says INTEGER, because the tables are STRICT', () => {
    expect(() =>
      insert(connection, 'messages', {
        id: id(308),
        session_id: ids.session,
        harness_message_id: 'h-real',
        role: 'user',
        body: 'x',
        occurred_at: SEEDED_AT,
        // The boolean column, because `messages` has no other integer left
        // since 0006 took the number away. A `check (x in (0, 1))` would catch
        // it too, so the point of the case is which complaint comes back.
        is_subagent_report: 1.5,
      }),
    ).toThrow(/cannot store REAL value in INTEGER column/);
  });
});

describe('the chunk params of the default index config (AD-15)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = await seeded();
  });

  it('refuses the same values written in another key order', () => {
    expect(() =>
      insert(connection, 'index_configs', {
        id: id(401),
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params:
          '{"overlapMessages":1,"targetChars":1200,"splitMessagesOverChars":2400}',
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('refuses a spelling with whitespace in it, so one value has one text', () => {
    expect(() =>
      insert(connection, 'index_configs', {
        id: id(402),
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params:
          '{"targetChars": 1200, "overlapMessages": 1, "splitMessagesOverChars": 2400}',
      }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('treats a second insert of the default row as the no-op an installer wants', () => {
    const before = count(connection, 'index_configs');
    insert(
      connection,
      'index_configs',
      {
        id: id(403),
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params: DEFAULT_CHUNK_PARAMS,
      },
      'on conflict do nothing',
    );
    expect(count(connection, 'index_configs')).toBe(before);
    expect(() =>
      insert(connection, 'index_configs', {
        id: id(404),
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params: DEFAULT_CHUNK_PARAMS,
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });
});

describe('the keyword search indexes (AD-15)', () => {
  it('find a Korean phrase in all three searched columns, and lose it when the row goes', async () => {
    const connection = await seeded();

    expect(matches(connection, 'chunks_fts', NEEDLE)).toBe(1);
    expect(matches(connection, 'log_entries_fts', NEEDLE)).toBe(1);
    expect(matches(connection, 'tool_notes_fts', NEEDLE)).toBe(0);

    // The tool note's target is a path, so it gets the phrase through the one
    // write it allows: a redaction.
    const written = await withWrite(
      connection,
      async (held) => {
        await sql`update tool_notes set target = ${KOREAN} where id = ${ids.toolNote}`.execute(held);
      },
      { redact: true },
    );
    expect(written.ok).toBe(true);
    expect(matches(connection, 'tool_notes_fts', NEEDLE)).toBe(1);

    // A chunk deleted and a sentence rewritten: both are ordinary writes, and
    // both have to take the old text out of the index with them.
    connection.database.exec(`delete from chunks where id = '${ids.chunk}'`);
    connection.database.exec(
      `update log_entries set "text" = '다른 방향으로 갑니다' where id = '${ids.rule}'`,
    );

    expect(matches(connection, 'chunks_fts', NEEDLE)).toBe(0);
    expect(matches(connection, 'log_entries_fts', NEEDLE)).toBe(0);
    // The trigram tokenizer needs three characters to search on, which is why
    // the needle is a word and not a syllable.
    expect(matches(connection, 'log_entries_fts', '"방향으로"')).toBe(1);
  });
});
