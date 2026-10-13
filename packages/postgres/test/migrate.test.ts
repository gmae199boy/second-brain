import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { SCHEMA_VERSION, runMigrations } from '../src/migrate.js';

/**
 * The Table Contract minus `embeddings`, which arrives the day embedding is
 * switched on (AD-15). A migration that adds or drops a table has to say so
 * here.
 */
const EXPECTED_TABLES = [
  'chunks',
  'context_injections',
  'failures',
  'index_configs',
  'log_entries',
  'log_entry_edits',
  'messages',
  'projects',
  'redactions',
  'schema_version',
  'sessions',
  'tool_notes',
  'transcript_files',
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
  other: id(99),
};

const seededAt = new Date('2026-02-03T04:05:06.000Z');

// A neutral stand-in for a secret, so the fixture carries no real one
// (Conventions: public repository hygiene).
const SECRET = 'sk-0123456789';
const MESSAGE_BODY = `the key is ${SECRET} and that is all`;
const SECRET_START = MESSAGE_BODY.indexOf(SECRET);
const SECRET_END = SECRET_START + SECRET.length;
const SECRET_SHA256 = createHash('sha256').update(SECRET, 'utf8').digest('hex');

const CHUNK_PARAMS = JSON.stringify({
  targetChars: 1200,
  overlapMessages: 1,
  splitMessagesOverChars: 2400,
});

/** A TCP port nothing listens on, so connecting is refused immediately. */
async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const databases: TestDatabase[] = [];

afterAll(async () => {
  await Promise.all(databases.map(async (database) => database.drop()));
});

/**
 * An empty database with no `vector` extension installed, because the first
 * migration must not need one (AD-15).
 */
async function emptyDatabase(): Promise<string> {
  const database = await createTestDatabase({ installVector: false });
  databases.push(database);
  return database.url;
}

/** An empty database, migrated and seeded with one row per table. */
async function seededDatabase(): Promise<string> {
  const url = await emptyDatabase();
  const applied = await runMigrations({ databaseUrl: url });
  expect(applied.ok).toBe(true);
  await withClient(url, seed);
  return url;
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Quote every identifier, because `end`, `start` and `text` are column names. */
function quote(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

async function insert(
  client: pg.Client,
  table: string,
  row: Readonly<Record<string, unknown>>,
): Promise<void> {
  const columns = Object.keys(row);
  const placeholders = columns.map((_, index) => `$${index + 1}`);
  await client.query(
    `insert into ${quote(table)} (${columns.map(quote).join(', ')})
          values (${placeholders.join(', ')})`,
    Object.values(row),
  );
}

/**
 * One row per table, in dependency order. `redactions` is left to the tests
 * that write it, through the function or directly as store-time masking does
 * (Table Contract).
 */
async function seed(client: pg.Client): Promise<void> {
  await insert(client, 'workspaces', { id: ids.workspace, name: 'demo-workspace' });
  await insert(client, 'projects', {
    id: ids.project,
    remote_identity: 'example.com/demo/repo',
    workspace_id: ids.workspace,
  });
  await insert(client, 'worktrees', {
    id: ids.worktree,
    project_id: ids.project,
    path: '/demo/repo',
    removed_at: null,
  });
  await insert(client, 'sessions', {
    id: ids.session,
    harness: 'demo',
    harness_session_id: 'session-0001',
    user_id: 'owner',
    machine: 'demo-machine',
    started_at: seededAt,
    workspace_id: ids.workspace,
    project_id: ids.project,
    worktree_id: ids.worktree,
    ingest_source: 'live',
    start_source: 'startup',
  });
  await insert(client, 'messages', {
    id: ids.message,
    session_id: ids.session,
    harness_message_id: 'h-1',
    seq: 0,
    role: 'user',
    model: null,
    body: MESSAGE_BODY,
    occurred_at: seededAt,
  });
  await insert(client, 'tool_notes', {
    id: ids.toolNote,
    session_id: ids.session,
    harness_message_id: 'h-1',
    ordinal: 0,
    tool: 'read',
    target: '/demo/repo/readme.md',
    ok: true,
  });
  await insert(client, 'log_entries', {
    id: ids.rule,
    kind: 'rule',
    session_id: ids.session,
    occurred_at: seededAt,
    recorded_at: seededAt,
    author_model: null,
    text: 'always write down what was decided',
    rule_state: 'on',
    apply_project_id: ids.project,
    supersedes_id: null,
    anchor_seq: 0,
    joined_upto_seq: 0,
  });
  await insert(client, 'log_entry_edits', {
    id: ids.edit,
    log_entry_id: ids.rule,
    previous_text: 'write down what was decided',
    edited_at: seededAt,
  });
  await insert(client, 'index_configs', {
    id: ids.indexConfig,
    kind: 'chunk',
    model: null,
    dimensions: null,
    chunk_params: CHUNK_PARAMS,
  });
  await insert(client, 'chunks', {
    id: ids.chunk,
    session_id: ids.session,
    index_config_id: ids.indexConfig,
    seq_from: 0,
    seq_to: 0,
    body: MESSAGE_BODY,
  });
  await insert(client, 'context_injections', {
    id: ids.injection,
    session_id: ids.session,
    attempted_at: seededAt,
    ok: true,
    code: null,
    chars: 420,
  });
  await insert(client, 'failures', {
    id: ids.failure,
    harness: 'demo',
    harness_session_id: 'session-0001',
    stage: 'ingest',
    fingerprint: 'c0ffee',
    session_id: ids.session,
    code: 'DB_UNAVAILABLE',
    message: 'the database was not there',
    occurred_at: seededAt,
    resolved_at: null,
  });
  await insert(client, 'transcript_files', {
    id: ids.transcriptFile,
    harness: 'demo',
    path: '/demo/transcripts/session-0001.jsonl',
    size_bytes: 1024,
    fingerprint: 'f1',
    last_harness_message_id: 'h-1',
    cursor_fingerprint: 'f1',
    scanned_at: seededAt,
  });
}

async function tableNames(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    const rows = await client.query<{ table_name: string }>(
      `select table_name
         from information_schema.tables
        where table_schema = 'public' and table_type = 'BASE TABLE'
        order by table_name`,
    );
    return rows.rows.map((row) => row.table_name);
  });
}

/** Every column of every table, so "the schema did not change" is checkable. */
async function schemaShape(url: string): Promise<string[]> {
  return withClient(url, async (client) => {
    const rows = await client.query<{ shape: string }>(
      `select table_name || '.' || column_name || ' ' || data_type
              || ' ' || is_nullable as shape
         from information_schema.columns
        where table_schema = 'public'
        order by table_name, column_name`,
    );
    return rows.rows.map((row) => row.shape);
  });
}

/** The migration file names, in order, read the way `runMigrations` reads them. */
function migrationFileNames(): string[] {
  const directory = fileURLToPath(new URL('../migrations/', import.meta.url));
  return readdirSync(directory)
    .filter((name) => /^\d{4}_.+\.sql$/.test(name))
    .sort();
}

describe('the migration files', () => {
  it('are numbered, and SCHEMA_VERSION is the last number', () => {
    const names = migrationFileNames();
    expect(names).toEqual(['0001_initial.sql']);
    const numbers = names.map((name) => Number(name.slice(0, 4)));
    expect(Math.max(...numbers)).toBe(SCHEMA_VERSION);
  });
});

describe('runMigrations on an empty database', () => {
  it('creates the Table Contract minus embeddings', async () => {
    const url = await emptyDatabase();

    const result = await runMigrations({ databaseUrl: url });

    expect(result).toEqual({
      ok: true,
      from: 0,
      to: SCHEMA_VERSION,
      applied: migrationFileNames(),
    });
    const tables = await tableNames(url);
    expect(tables).toEqual(EXPECTED_TABLES);
    expect(tables).toHaveLength(15);
    expect(tables).not.toContain('embeddings');
  });

  it('records the version in a single row', async () => {
    const url = await emptyDatabase();

    await runMigrations({ databaseUrl: url });

    const rows = await withClient(url, async (client) =>
      client.query<{ version: number }>('select version from schema_version'),
    );
    expect(rows.rows).toEqual([{ version: SCHEMA_VERSION }]);
  });

  it('is a no-op the second time, and leaves the schema alone', async () => {
    const url = await emptyDatabase();
    await runMigrations({ databaseUrl: url });
    const before = await schemaShape(url);

    const again = await runMigrations({ databaseUrl: url });

    expect(again).toEqual({ ok: true, from: SCHEMA_VERSION, to: SCHEMA_VERSION, applied: [] });
    expect(await schemaShape(url)).toEqual(before);
  });

  it('applies every file exactly once when two runs start together', async () => {
    const url = await emptyDatabase();

    const [left, right] = await Promise.all([
      runMigrations({ databaseUrl: url }),
      runMigrations({ databaseUrl: url }),
    ]);

    expect(left?.ok).toBe(true);
    expect(right?.ok).toBe(true);
    if (left === undefined || right === undefined || !left.ok || !right.ok) return;
    // Which run took which file is up to the lock, so compare the union.
    expect([...left.applied, ...right.applied].sort()).toEqual(migrationFileNames());
    expect(left.to).toBe(SCHEMA_VERSION);
    expect(right.to).toBe(SCHEMA_VERSION);
    const rows = await withClient(url, async (client) =>
      client.query('select version from schema_version'),
    );
    expect(rows.rowCount).toBe(1);
  });
});

describe('runMigrations against a closed port', () => {
  it('returns DB_UNAVAILABLE as a value, within the connect timeout', async () => {
    const port = await closedPort();

    const startedAt = Date.now();
    const result = await runMigrations({
      databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    });
    const elapsed = Date.now() - startedAt;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DB_UNAVAILABLE');
    expect(result.message.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe('runMigrations against a database that refuses a statement', () => {
  it('says MIGRATION_FAILED and names the file, not DB_UNAVAILABLE', async () => {
    const url = await emptyDatabase();
    // A table the first migration also creates: the server is right there and
    // answering, and the failure is the schema's, not the connection's.
    await withClient(url, async (client) => {
      await client.query('create table workspaces (id uuid primary key)');
    });

    const result = await runMigrations({ databaseUrl: url });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MIGRATION_FAILED');
    expect(result.message).toContain('workspaces');
    if (result.code !== 'MIGRATION_FAILED') return;
    expect(result.file).toBe('0001_initial.sql');
  });

  it('records no version, so a later run still sees an unmigrated database', async () => {
    const url = await emptyDatabase();
    await withClient(url, async (client) => {
      await client.query('create table messages (id uuid primary key)');
    });

    await runMigrations({ databaseUrl: url });

    const stored = await withClient(url, async (client) =>
      client.query<{ relation: string | null }>(
        `select to_regclass('public.schema_version')::text as relation`,
      ),
    );
    expect(stored.rows[0]?.relation).toBeNull();
  });
});

describe('the immutability triggers (AD-11)', () => {
  let url: string;

  beforeAll(async () => {
    url = await seededDatabase();
  });

  // `truncate messages` on its own never reaches the trigger, because Postgres
  // refuses it earlier over the `redactions` foreign key; the forms that do get
  // past that check meet the trigger, and both are covered.
  it.each([
    { statement: `update messages set body = 'rewritten'`, table: 'messages' },
    { statement: `update messages set occurred_at = now()`, table: 'messages' },
    { statement: `delete from messages`, table: 'messages' },
    { statement: `truncate messages cascade`, table: 'messages' },
    { statement: `truncate messages, redactions`, table: 'messages' },
    { statement: `update tool_notes set target = 'elsewhere'`, table: 'tool_notes' },
    { statement: `delete from tool_notes`, table: 'tool_notes' },
    { statement: `truncate tool_notes`, table: 'tool_notes' },
  ])('refuses `$statement`', async ({ statement, table }) => {
    await withClient(url, async (client) => {
      await expect(client.query(statement)).rejects.toThrow(
        new RegExp(`${table}[\\s\\S]*immutable`),
      );
    });
  });

  it('refuses a bare truncate of messages as well', async () => {
    await withClient(url, async (client) => {
      await expect(client.query('truncate messages')).rejects.toThrow();
    });
  });

  it('leaves the rows exactly as they were', async () => {
    await withClient(url, async (client) => {
      const message = await client.query<{ body: string; occurred_at: Date }>(
        'select body, occurred_at from messages where id = $1',
        [ids.message],
      );
      expect(message.rows).toEqual([{ body: MESSAGE_BODY, occurred_at: seededAt }]);
      const toolNote = await client.query<{ target: string }>(
        'select target from tool_notes where id = $1',
        [ids.toolNote],
      );
      expect(toolNote.rows).toEqual([{ target: '/demo/repo/readme.md' }]);
    });
  });

  it('refuses a body update whose marker names another message', async () => {
    await withClient(url, async (client) => {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['brain.redacting', ids.other]);
      await expect(
        client.query('update messages set body = $1 where id = $2', ['rewritten', ids.message]),
      ).rejects.toThrow(/messages is immutable/);
      await client.query('rollback');
    });
  });

  it('refuses a redacting update that touches any column but body', async () => {
    await withClient(url, async (client) => {
      await client.query('begin');
      await client.query('select set_config($1, $2, true)', ['brain.redacting', ids.message]);
      await expect(
        client.query('update messages set body = $1, role = $2 where id = $3', [
          'rewritten',
          'assistant',
          ids.message,
        ]),
      ).rejects.toThrow(/body and nothing else/);
      await client.query('rollback');
    });
  });
});

describe('brain_redact_message (AD-11)', () => {
  it('masks the span, keeps only its hash, and stores the removed text nowhere', async () => {
    const url = await seededDatabase();

    await withClient(url, async (client) => {
      await client.query('select brain_redact_message($1, $2, $3, $4, $5, $6)', [
        ids.redaction,
        ids.message,
        SECRET_START,
        SECRET_END,
        'api_key',
        seededAt,
      ]);

      const message = await client.query<{ body: string }>(
        'select body from messages where id = $1',
        [ids.message],
      );
      expect(message.rows[0]?.body).toBe('the key is [REDACTED:api_key] and that is all');

      const redactions = await client.query(
        `select id, message_id, start, "end", kind, content_hash, occurred_at from redactions`,
      );
      expect(redactions.rows).toEqual([
        {
          id: ids.redaction,
          message_id: ids.message,
          start: SECRET_START,
          end: SECRET_END,
          kind: 'api_key',
          content_hash: SECRET_SHA256,
          occurred_at: seededAt,
        },
      ]);

      // The acceptance criterion: dump both tables whole and the removed text
      // is not in them.
      const dump = await client.query<{ dump: string }>(
        `select coalesce((select string_agg(m::text, ' | ') from messages m), '')
             || coalesce((select string_agg(r::text, ' | ') from redactions r), '') as dump`,
      );
      expect(dump.rows[0]?.dump).toContain('[REDACTED:api_key]');
      expect(dump.rows[0]?.dump).not.toContain(SECRET);
    });
  });

  it('accepts a second redaction of the same message', async () => {
    const url = await seededDatabase();

    await withClient(url, async (client) => {
      await client.query('select brain_redact_message($1, $2, $3, $4, $5, $6)', [
        ids.redaction,
        ids.message,
        SECRET_START,
        SECRET_END,
        'api_key',
        seededAt,
      ]);
      await client.query('select brain_redact_message($1, $2, $3, $4, $5, $6)', [
        ids.other,
        ids.message,
        0,
        3,
        'other',
        seededAt,
      ]);

      const message = await client.query<{ body: string }>(
        'select body from messages where id = $1',
        [ids.message],
      );
      expect(message.rows[0]?.body).toBe(
        '[REDACTED:other] key is [REDACTED:api_key] and that is all',
      );
      const count = await client.query<{ rows: string }>('select count(*) as rows from redactions');
      expect(count.rows[0]?.rows).toBe('2');
    });
  });

  describe('and a call it cannot honour', () => {
    let url: string;

    beforeAll(async () => {
      url = await seededDatabase();
    });

    it.each([
      { name: 'a range that runs past the body', target: () => ids.message, range: [0, 9999] },
      { name: 'an empty range', target: () => ids.message, range: [5, 5] },
      { name: 'a reversed range', target: () => ids.message, range: [9, 4] },
      { name: 'a negative start', target: () => ids.message, range: [-1, 4] },
      { name: 'a message that is not there', target: () => ids.other, range: [0, 4] },
    ])('rolls back on $name', async ({ target, range }) => {
      await withClient(url, async (client) => {
        await expect(
          client.query('select brain_redact_message($1, $2, $3, $4, $5, $6)', [
            ids.redaction,
            target(),
            range[0],
            range[1],
            'api_key',
            seededAt,
          ]),
        ).rejects.toThrow();

        const message = await client.query<{ body: string }>(
          'select body from messages where id = $1',
          [ids.message],
        );
        expect(message.rows[0]?.body).toBe(MESSAGE_BODY);
        const count = await client.query<{ rows: string }>(
          'select count(*) as rows from redactions',
        );
        expect(count.rows[0]?.rows).toBe('0');
      });
    });
  });
});

/**
 * Every idempotency key of the Table Contract, as data (AD-8). Each case
 * inserts its own pair inside a transaction that is rolled back, so the cases
 * stay independent of each other and of the seeded rows.
 */
interface DuplicateKeyCase {
  table: string;
  key: string;
  first: Readonly<Record<string, unknown>>;
  /** Same key, different row: the insert must be refused. */
  second: Readonly<Record<string, unknown>>;
}

function duplicateKeyCases(): DuplicateKeyCase[] {
  const workspace = { id: id(101), name: 'second-workspace' };
  const project = { id: id(102), remote_identity: 'example.com/demo/other', workspace_id: null };
  const worktree = { id: id(103), project_id: ids.project, path: '/demo/other' };
  const session = {
    id: id(104),
    harness: 'demo',
    harness_session_id: 'session-0002',
    user_id: 'owner',
    machine: 'demo-machine',
    started_at: seededAt,
    ingest_source: 'live',
    start_source: null,
  };
  const message = {
    id: id(105),
    session_id: ids.session,
    harness_message_id: 'h-2',
    seq: 1,
    role: 'assistant',
    body: 'a second message',
    occurred_at: seededAt,
  };
  const toolNote = {
    id: id(106),
    session_id: ids.session,
    harness_message_id: 'h-2',
    ordinal: 0,
    tool: 'read',
    target: '/demo/repo/other.md',
    ok: true,
  };
  const logEntry = {
    id: id(107),
    kind: 'progress',
    session_id: ids.session,
    occurred_at: seededAt,
    recorded_at: seededAt,
    text: 'got the migration in',
  };
  const edit = {
    id: id(108),
    log_entry_id: ids.rule,
    previous_text: 'an earlier sentence',
    edited_at: seededAt,
  };
  // Different params from the seeded config, so the pair is the only clash;
  // `model` and `dimensions` stay null, which is what `nulls not distinct` is
  // there for.
  const indexConfig = {
    id: id(109),
    kind: 'chunk',
    model: null,
    dimensions: null,
    chunk_params: JSON.stringify({
      targetChars: 900,
      overlapMessages: 1,
      splitMessagesOverChars: 2400,
    }),
  };
  const chunk = {
    id: id(110),
    session_id: ids.session,
    index_config_id: ids.indexConfig,
    seq_from: 1,
    seq_to: 2,
    body: 'a chunk',
  };
  const redaction = {
    id: id(111),
    message_id: ids.message,
    start: 0,
    end: 3,
    kind: 'api_key',
    content_hash: SECRET_SHA256,
    occurred_at: seededAt,
  };
  const injection = {
    id: id(112),
    session_id: ids.session,
    attempted_at: seededAt,
    ok: false,
    code: 'DB_UNAVAILABLE',
    chars: 0,
  };
  const failure = {
    id: id(113),
    harness: 'demo',
    harness_session_id: 'session-0002',
    stage: 'ingest',
    fingerprint: 'beef',
    session_id: null,
    code: 'DB_UNAVAILABLE',
    message: 'again',
    occurred_at: seededAt,
  };
  const transcriptFile = {
    id: id(114),
    harness: 'demo',
    path: '/demo/transcripts/session-0002.jsonl',
    size_bytes: 10,
    fingerprint: 'f2',
    scanned_at: seededAt,
  };

  const other = (row: Readonly<Record<string, unknown>>, ordinal: number) => ({
    ...row,
    id: id(ordinal),
  });

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
      second: { ...other(message, 205), seq: 2 },
    },
    {
      table: 'messages',
      key: '(session_id, seq)',
      first: message,
      second: { ...other(message, 206), harness_message_id: 'h-3' },
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
      key: '(session_id, index_config_id, seq_from, seq_to)',
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
      key: '(harness, harness_session_id, stage, fingerprint)',
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
  let url: string;

  beforeAll(async () => {
    url = await seededDatabase();
  });

  it.each(duplicateKeyCases())('$table is unique on $key', async ({ table, first, second }) => {
    await withClient(url, async (client) => {
      await client.query('begin');
      try {
        await insert(client, table, first);
        await expect(insert(client, table, second)).rejects.toMatchObject({ code: '23505' });
      } finally {
        await client.query('rollback');
      }
    });
  });

  it('schema_version holds one row and no other', async () => {
    await withClient(url, async (client) => {
      await client.query('begin');
      try {
        await expect(
          insert(client, 'schema_version', { id: true, version: 99, applied_at: seededAt }),
        ).rejects.toMatchObject({ code: '23505' });
      } finally {
        await client.query('rollback');
      }

      await client.query('begin');
      try {
        await expect(
          insert(client, 'schema_version', { id: false, version: 99, applied_at: seededAt }),
        ).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.query('rollback');
      }
    });
  });
});

describe('the CHECK constraints', () => {
  let url: string;

  beforeAll(async () => {
    url = await seededDatabase();
  });

  it.each([
    {
      name: 'a role nobody utters',
      table: 'messages',
      row: {
        id: id(301),
        session_id: ids.session,
        harness_message_id: 'h-role',
        seq: 31,
        role: 'system',
        body: 'x',
        occurred_at: seededAt,
      },
    },
    {
      name: 'a log kind that is not one of the four',
      table: 'log_entries',
      row: {
        id: id(302),
        kind: 'note',
        session_id: ids.session,
        occurred_at: seededAt,
        recorded_at: seededAt,
        text: 'x',
      },
    },
    {
      name: 'a rule state on something that is not a rule',
      table: 'log_entries',
      row: {
        id: id(303),
        kind: 'progress',
        session_id: ids.session,
        occurred_at: seededAt,
        recorded_at: seededAt,
        text: 'x',
        rule_state: 'on',
      },
    },
    {
      name: 'a rule without a state',
      table: 'log_entries',
      row: {
        id: id(304),
        kind: 'rule',
        session_id: ids.session,
        occurred_at: seededAt,
        recorded_at: seededAt,
        text: 'x',
        rule_state: null,
      },
    },
    {
      name: 'an ingest source from nowhere',
      table: 'sessions',
      row: {
        id: id(305),
        harness: 'demo',
        harness_session_id: 'session-0305',
        user_id: 'owner',
        machine: 'demo-machine',
        started_at: seededAt,
        ingest_source: 'guess',
      },
    },
    {
      name: 'a start source from nowhere',
      table: 'sessions',
      row: {
        id: id(306),
        harness: 'demo',
        harness_session_id: 'session-0306',
        user_id: 'owner',
        machine: 'demo-machine',
        started_at: seededAt,
        ingest_source: 'live',
        start_source: 'maybe',
      },
    },
    {
      name: 'half a parser cursor on a session',
      table: 'sessions',
      row: {
        id: id(309),
        harness: 'demo',
        harness_session_id: 'session-0309',
        user_id: 'owner',
        machine: 'demo-machine',
        started_at: seededAt,
        ingest_source: 'live',
        last_harness_message_id: 'h-1',
        cursor_fingerprint: null,
      },
    },
    {
      name: 'half a parser cursor on a transcript file',
      table: 'transcript_files',
      row: {
        id: id(310),
        harness: 'demo',
        path: '/demo/transcripts/session-0310.jsonl',
        size_bytes: 10,
        fingerprint: 'f3',
        last_harness_message_id: null,
        cursor_fingerprint: 'f3',
        scanned_at: seededAt,
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
        content_hash: SECRET_SHA256,
        occurred_at: seededAt,
      },
    },
    {
      name: 'a redaction range that starts below zero',
      table: 'redactions',
      row: {
        id: id(308),
        message_id: ids.message,
        start: -1,
        end: 4,
        kind: 'api_key',
        content_hash: SECRET_SHA256,
        occurred_at: seededAt,
      },
    },
  ])('refuses $name', async ({ table, row }) => {
    await withClient(url, async (client) => {
      await client.query('begin');
      try {
        await expect(insert(client, table, row)).rejects.toMatchObject({ code: '23514' });
      } finally {
        await client.query('rollback');
      }
    });
  });
});

describe('the keyword search indexes (AD-15)', () => {
  it('cover the three searched columns with trigram indexes', async () => {
    const url = await emptyDatabase();
    await runMigrations({ databaseUrl: url });

    const indexes = await withClient(url, async (client) => {
      const rows = await client.query<{ tablename: string; indexdef: string }>(
        `select tablename, indexdef
           from pg_indexes
          where schemaname = 'public' and indexdef like '%gin_trgm_ops%'
          order by tablename`,
      );
      return rows.rows;
    });

    expect(indexes.map((index) => index.tablename)).toEqual([
      'chunks',
      'log_entries',
      'tool_notes',
    ]);
    expect(indexes[0]?.indexdef).toContain('body');
    expect(indexes[1]?.indexdef).toContain('text');
    expect(indexes[2]?.indexdef).toContain('target');
  });
});
