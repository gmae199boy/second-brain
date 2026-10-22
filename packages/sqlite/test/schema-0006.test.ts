import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import {
  SQLITE_MIGRATIONS_DIRECTORY,
  SQLITE_SCHEMA_VERSION,
  runSqliteMigrations,
} from '../src/migrate.js';

/**
 * The sixth migration: the message number goes away, the log–message link goes
 * with it, and a chunk's range becomes the instants of its first and last
 * message (AD-4, AD-8, AD-14, AD-15, Table Contract).
 *
 * Three things are held here. That the upgrade carries every row of a version 5
 * database across — `messages` and `chunks` are both a `drop` and a copy, and
 * `messages` is the table two others point at. That a chunk keeps the
 * `search_rowid` its FTS index finds it by, so a search that worked before the
 * upgrade still finds the same row afterwards. And that the keys, checks and
 * triggers the rebuild had to write again refuse exactly what they refused
 * before, minus the one key that is gone: two messages of one session may now
 * share an instant, because nothing says which of them is read first.
 */

/** Caller-minted ids, in the UUIDv7 shape every row carries (AD-8). */
function id(ordinal: number): string {
  return `01970000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
}

const ids = {
  user: id(1),
  session: id(2),
  otherSession: id(3),
  project: id(4),
  /** The three messages of the session, numbered against their instants. */
  messageFirst: id(10),
  messageMiddle: id(11),
  messageLast: id(12),
  toolNote: id(20),
  redaction: id(21),
  attachment: id(22),
  logEntry: id(23),
  chunk: id(24),
  chunkReversed: id(25),
};

/** The row migration 0001 writes for itself (AD-15). */
const DEFAULT_INDEX_CONFIG = '019a0000-0000-7000-8000-000000000001';

const SEEDED_AT = '2026-02-03T04:05:06.000Z';
/**
 * The three instants of the conversation. The `seq` the seed gives them runs
 * the other way on purpose: the middle message of the conversation was
 * collected last and took the highest number, which is the state this
 * migration exists because of.
 */
const FIRST_AT = '2026-02-03T04:05:07.000Z';
const MIDDLE_AT = '2026-02-03T04:05:08.000Z';
const LAST_AT = '2026-02-03T04:05:09.000Z';

/**
 * Korean, because `chunks_fts` uses the trigram tokenizer for languages that
 * put no spaces between words (AD-15); an English sentence would be found by
 * any tokenizer at all.
 */
const CHUNK_BODY = '어제 결정한 저장소 방향';
const NEEDLE = '"저장소"';

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-0006-'));
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

/** Quote every identifier, because `end`, `start` and `text` are column names. */
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

function all(connection: SqliteConnection, query: string): unknown[] {
  return connection.database.prepare(query).all();
}

/** How many rows of an FTS index the needle finds. */
function matches(connection: SqliteConnection, index: string, needle: string): number {
  const row = connection.database
    .prepare(`select count(*) as n from ${index} where ${index} match ?`)
    .get(needle);
  return Number(row?.n ?? -1);
}

/**
 * A file that stopped at version 5, the way an install from before this story
 * did: only the first five migration files, copied into a folder of this test's
 * own. A folder the caller names is not held to `SQLITE_SCHEMA_VERSION`, which
 * is how the tests reach it.
 */
async function versionFivePath(): Promise<string> {
  const directory = await scratch();
  for (const name of [
    '0001_initial.sql',
    '0002_files_and_work.sql',
    '0003_users.sql',
    '0004_capture_columns.sql',
    '0005_identity_and_records.sql',
  ]) {
    await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
  }
  const path = join(await scratch(), 'brain.db');
  expect(await runSqliteMigrations({ path, directory })).toEqual({
    ok: true,
    from: 0,
    to: 5,
    applied: [
      '0001_initial.sql',
      '0002_files_and_work.sql',
      '0003_users.sql',
      '0004_capture_columns.sql',
      '0005_identity_and_records.sql',
    ],
  });
  return path;
}

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  expect(await runSqliteMigrations({ path })).toMatchObject({ ok: true, to: 7 });
  return path;
}

/**
 * One row in every table 0006 touches or points at, written against the version
 * 5 schema: the shape the upgrade has to carry across.
 */
function seedVersionFive(connection: SqliteConnection): void {
  insert(connection, 'users', {
    id: ids.user,
    name: 'brain-owner',
    is_self: 1,
    created_at: SEEDED_AT,
  });
  insert(connection, 'projects', {
    id: ids.project,
    remote_identity: 'example.com/demo/repo',
    identity_key: 'example.com/demo/repo',
  });
  for (const [sessionId, harnessSessionId] of [
    [ids.session, 'session-0001'],
    [ids.otherSession, 'session-0002'],
  ] as const) {
    insert(connection, 'sessions', {
      id: sessionId,
      harness: 'demo',
      harness_session_id: harnessSessionId,
      user_id: ids.user,
      machine: 'demo-machine',
      started_at: SEEDED_AT,
      ingest_source: 'live',
    });
  }
  // `seq` 0, 2, 1 against instants that run the other way round for the last
  // two: the numbers and the conversation disagree, so a copy that quietly
  // sorted or renumbered by either could not come out right.
  insert(connection, 'messages', {
    id: ids.messageFirst,
    session_id: ids.session,
    harness_message_id: 'h-1',
    seq: 0,
    role: 'user',
    model: null,
    body: '먼저 한 말',
    occurred_at: FIRST_AT,
    git_branch: 'main',
    is_subagent_report: 0,
  });
  insert(connection, 'messages', {
    id: ids.messageMiddle,
    session_id: ids.session,
    harness_message_id: 'h-2',
    seq: 2,
    role: 'assistant',
    model: 'demo-model',
    body: 'the message a later batch carried',
    occurred_at: MIDDLE_AT,
    git_branch: 'topic/notes',
    is_subagent_report: 1,
  });
  insert(connection, 'messages', {
    id: ids.messageLast,
    session_id: ids.session,
    harness_message_id: 'h-3',
    seq: 1,
    role: 'user',
    model: null,
    body: '마지막 말',
    occurred_at: LAST_AT,
    git_branch: null,
    is_subagent_report: 0,
  });
  insert(connection, 'tool_notes', {
    id: ids.toolNote,
    session_id: ids.session,
    harness_message_id: 'h-2',
    ordinal: 0,
    tool: 'Read',
    target: '/demo/repo/notes.md',
    ok: 1,
  });
  // The two tables that point at `messages (id)`, which is what makes the
  // rebuild need `defer_foreign_keys`.
  insert(connection, 'redactions', {
    id: ids.redaction,
    message_id: ids.messageFirst,
    file_id: null,
    tool_note_id: null,
    start: 0,
    end: 2,
    kind: 'api_key',
    content_hash: 'not-a-real-hash',
    occurred_at: SEEDED_AT,
    pattern_version: '2',
  });
  insert(connection, 'message_attachments', {
    id: ids.attachment,
    message_id: ids.messageFirst,
    ordinal: 0,
    source_kind: 'demo/paste',
  });
  insert(connection, 'log_entries', {
    id: ids.logEntry,
    kind: 'progress',
    session_id: ids.session,
    occurred_at: SEEDED_AT,
    recorded_at: SEEDED_AT,
    author_model: null,
    text: '초안을 읽었습니다',
    apply_project_id: ids.project,
    anchor_seq: 0,
    joined_upto_seq: 2,
  });
  // A chunk over `seq` 0 to 2, which is the whole conversation: the two
  // instants it becomes are the first and the last message's, and the `seq`
  // numbers are not where they are in the file.
  insert(connection, 'chunks', {
    id: ids.chunk,
    session_id: ids.session,
    index_config_id: DEFAULT_INDEX_CONFIG,
    seq_from: 0,
    seq_to: 2,
    body: CHUNK_BODY,
  });
  // And one whose numbers run against its instants: `seq` 1 was uttered at
  // 04:05:09 and `seq` 2 at 04:05:08, so copying `seq_from`'s instant into
  // `from_at` would hand `chunks_range_check` a range that ends before it
  // starts and refuse the whole upgrade.
  insert(connection, 'chunks', {
    id: ids.chunkReversed,
    session_id: ids.session,
    index_config_id: DEFAULT_INDEX_CONFIG,
    seq_from: 1,
    seq_to: 2,
    body: 'the stretch whose numbers run backwards',
  });
}

describe('the upgrade from version 5 to version 6', () => {
  let connection: SqliteConnection;
  /** The anchor `chunks_fts` found the chunk by before the upgrade. */
  let searchRowidBefore: unknown;

  beforeAll(async () => {
    const path = await versionFivePath();
    const before = open(path);
    seedVersionFive(before);
    expect(matches(before, 'chunks_fts', NEEDLE)).toBe(1);
    searchRowidBefore = all(before, 'select search_rowid from chunks');
    await before.close();
    connections.splice(connections.indexOf(before), 1);

    expect(await runSqliteMigrations({ path })).toEqual({
      ok: true,
      from: 5,
      to: 7,
      applied: ['0006_drop_message_seq.sql', '0007_session_tag_source.sql'],
    });

    connection = open(path);
  });

  it('leaves every row where it was, under its own id', () => {
    for (const table of [
      'users',
      'projects',
      'tool_notes',
      'redactions',
      'message_attachments',
      'log_entries',
    ]) {
      expect(connection.database.prepare(`select count(*) as n from ${table}`).get()?.n).toBe(1);
    }
    expect(connection.database.prepare('select count(*) as n from messages').get()?.n).toBe(3);
    expect(connection.database.prepare('select count(*) as n from sessions').get()?.n).toBe(2);
    expect(connection.database.prepare('select count(*) as n from chunks').get()?.n).toBe(2);
    // The one thing the deferred foreign key has to come out of this with.
    expect(all(connection, 'pragma foreign_key_check')).toEqual([]);
  });

  it('carries every message across with no number, in the order it was uttered', () => {
    expect(
      all(
        connection,
        `select id, harness_message_id, role, model, body, occurred_at, git_branch,
                is_subagent_report
           from messages order by occurred_at`,
      ),
    ).toEqual([
      {
        id: ids.messageFirst,
        harness_message_id: 'h-1',
        role: 'user',
        model: null,
        body: '먼저 한 말',
        occurred_at: FIRST_AT,
        git_branch: 'main',
        is_subagent_report: 0,
      },
      {
        id: ids.messageMiddle,
        harness_message_id: 'h-2',
        role: 'assistant',
        model: 'demo-model',
        body: 'the message a later batch carried',
        occurred_at: MIDDLE_AT,
        git_branch: 'topic/notes',
        is_subagent_report: 1,
      },
      {
        id: ids.messageLast,
        harness_message_id: 'h-3',
        role: 'user',
        model: null,
        body: '마지막 말',
        occurred_at: LAST_AT,
        git_branch: null,
        is_subagent_report: 0,
      },
    ]);
  });

  it('has no message number and no log–message link left to read', () => {
    expect(
      all(connection, `select name from pragma_table_info('messages') where name = 'seq'`),
    ).toEqual([]);
    expect(
      all(
        connection,
        `select name from pragma_table_info('log_entries')
          where name in ('anchor_seq', 'joined_upto_seq')`,
      ),
    ).toEqual([]);
    // Everything else about the log line is untouched, the FTS anchor
    // included: the two columns are dropped in place and no row is rewritten.
    expect(
      all(connection, 'select search_rowid, id, "text", apply_project_id from log_entries'),
    ).toEqual([
      {
        search_rowid: 1,
        id: ids.logEntry,
        text: '초안을 읽었습니다',
        apply_project_id: ids.project,
      },
    ]);
    expect(matches(connection, 'log_entries_fts', '"초안을"')).toBe(1);
  });

  it('turns the chunk range into the instants of its first and last message', () => {
    expect(
      all(
        connection,
        `select id, session_id, index_config_id, from_at, to_at, body
           from chunks order by from_at`,
      ),
    ).toEqual([
      {
        id: ids.chunk,
        session_id: ids.session,
        index_config_id: DEFAULT_INDEX_CONFIG,
        // `seq` 0 and `seq` 2, which are the first and the middle instants --
        // and not the two ends of the conversation, because the numbers and
        // the instants disagree in this seed.
        from_at: FIRST_AT,
        to_at: MIDDLE_AT,
        body: CHUNK_BODY,
      },
      {
        // The row whose numbers run backwards: `seq_from` 1 is the later
        // instant, so the pair comes out as the stretch it describes rather
        // than as a range that ends before it starts. The upgrade carried it
        // instead of being refused over it.
        id: ids.chunkReversed,
        session_id: ids.session,
        index_config_id: DEFAULT_INDEX_CONFIG,
        from_at: MIDDLE_AT,
        to_at: LAST_AT,
        body: 'the stretch whose numbers run backwards',
      },
    ]);
  });

  it('keeps the anchor the chunk index finds it by, so the same search still works', () => {
    // `drop table` fires no delete trigger, so `chunks_fts` was never told the
    // rows went away: it still holds the terms under the old `search_rowid`.
    // Carrying that number across is what keeps the index pointing at the row
    // it was built from rather than at another one.
    expect(all(connection, 'select search_rowid from chunks')).toEqual(searchRowidBefore);
    expect(matches(connection, 'chunks_fts', NEEDLE)).toBe(1);
  });

  it('applies nothing the second time', async () => {
    const path = await migratedPath();
    expect(await runSqliteMigrations({ path })).toEqual({ ok: true, from: 7, to: 7, applied: [] });
  });

  it('reaches exactly the version the folder holds', async () => {
    const numbered = (await readdir(SQLITE_MIGRATIONS_DIRECTORY))
      .map((name) => /^(\d{4})_.+\.sql$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]));
    expect(Math.max(...numbered)).toBe(7);
    expect(SQLITE_SCHEMA_VERSION).toBe(7);
  });
});

describe('the rebuilt messages table of 0006 (AD-8, AD-11)', () => {
  let connection: SqliteConnection;

  const message = {
    id: ids.messageFirst,
    session_id: ids.session,
    harness_message_id: 'h-1',
    role: 'user',
    model: null,
    body: 'the body a redaction may rewrite',
    occurred_at: FIRST_AT,
    git_branch: 'main',
    is_subagent_report: 0,
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
    insert(connection, 'messages', message);
  });

  it('refuses an update and a delete with the wording of 0001', () => {
    // No redact marker is raised here -- `brain_redact_allowed()` is not even
    // registered on this connection -- so both are refused, and the sentence
    // is the one every earlier migration raised: a caller matching on it is
    // matching on the rule and not on a migration.
    expect(() => connection.database.exec(`update messages set body = 'rewritten'`)).toThrow(
      /messages is immutable: an update is refused/,
    );
    expect(() => connection.database.exec('delete from messages')).toThrow(
      /messages is immutable: delete is refused/,
    );
    expect(all(connection, 'select body from messages')).toEqual([{ body: message.body }]);
  });

  it('is keyed on the harness id alone, and lets two messages share an instant', () => {
    expect(() =>
      insert(connection, 'messages', {
        ...message,
        id: id(101),
        body: 'another body under the same harness id',
      }),
    ).toThrow(/UNIQUE constraint failed/);
    // The key that is gone: `(session_id, seq)` said two messages of one
    // session could not be in the same place, and nothing says that now --
    // the order of two messages at one instant is simply not defined
    // (migration 0006).
    insert(connection, 'messages', {
      ...message,
      id: id(102),
      harness_message_id: 'h-9',
      body: 'a second message at the same instant',
    });
    expect(
      connection.database
        .prepare('select count(*) as n from messages where occurred_at = ?')
        .get(FIRST_AT)?.n,
    ).toBe(2);
  });

  it('still refuses a role nobody utters and an instant that is not canonical', () => {
    for (const row of [
      { ...message, id: id(103), harness_message_id: 'h-role', role: 'system' },
      {
        ...message,
        id: id(104),
        harness_message_id: 'h-instant',
        occurred_at: '2026-02-03T04:05:07Z',
      },
      { ...message, id: id(105), harness_message_id: 'h-mark', is_subagent_report: 2 },
    ]) {
      expect(() => insert(connection, 'messages', row)).toThrow(/CHECK constraint failed/);
    }
  });

  it('indexes the session and the instant, which is what a read is ordered by', () => {
    const plan = all(
      connection,
      `explain query plan
         select id from messages where session_id = '${ids.session}' order by occurred_at`,
    ) as { detail: string }[];
    // No temporary B-tree for the sort: the index is the `order by`, column
    // for column, so the rows come off it already in conversation order.
    expect(plan.map((step) => step.detail).join('\n')).toContain(
      'messages_session_occurred_idx',
    );
    expect(plan.map((step) => step.detail).join('\n')).not.toContain('TEMP B-TREE');
  });
});

describe('the chunk range of 0006 (AD-15)', () => {
  let connection: SqliteConnection;

  const chunk = {
    id: ids.chunk,
    session_id: ids.session,
    index_config_id: DEFAULT_INDEX_CONFIG,
    from_at: FIRST_AT,
    to_at: LAST_AT,
    body: CHUNK_BODY,
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
    insert(connection, 'chunks', chunk);
  });

  it('is keyed on the session, the config and the two instants', () => {
    expect(() =>
      insert(connection, 'chunks', { ...chunk, id: id(201), body: 'another chunk' }),
    ).toThrow(/UNIQUE constraint failed/);
    // A different stretch of the same session under the same config is its own
    // row: only the exact pair of instants is taken.
    insert(connection, 'chunks', {
      ...chunk,
      id: id(202),
      to_at: MIDDLE_AT,
      body: 'the shorter stretch',
    });
    expect(connection.database.prepare('select count(*) as n from chunks').get()?.n).toBe(2);
  });

  it('refuses a stretch that ends before it starts, and lets one message be a chunk', () => {
    expect(() =>
      insert(connection, 'chunks', {
        ...chunk,
        id: id(203),
        from_at: LAST_AT,
        to_at: FIRST_AT,
      }),
    ).toThrow(/CHECK constraint failed/);
    // Equal is allowed: a chunk may be a single message.
    insert(connection, 'chunks', {
      ...chunk,
      id: id(204),
      from_at: LAST_AT,
      to_at: LAST_AT,
      body: 'one message on its own',
    });
  });

  it('refuses an instant that is not the canonical 24 characters', () => {
    for (const row of [
      { ...chunk, id: id(205), from_at: '2026-02-03T04:05:07Z' },
      { ...chunk, id: id(206), to_at: '2026-02-03T13:05:09.000+09:00' },
    ]) {
      expect(() => insert(connection, 'chunks', row)).toThrow(/CHECK constraint failed/);
    }
  });

  it('mirrors a chunk body into the index on insert, update and delete', () => {
    // The three FTS triggers went with the dropped table and had to be written
    // again (AD-15). A missing insert trigger leaves a chunk nothing can find;
    // a missing delete trigger leaves searches answering with a row that is
    // gone, which for a masked body is the one thing AD-11 promises it is not.
    const before = matches(connection, 'chunks_fts', NEEDLE);
    insert(connection, 'chunks', {
      ...chunk,
      id: id(301),
      from_at: MIDDLE_AT,
      to_at: MIDDLE_AT,
      body: CHUNK_BODY,
    });
    expect(matches(connection, 'chunks_fts', NEEDLE)).toBe(before + 1);

    connection.database
      .prepare('update chunks set body = ? where id = ?')
      .run('수정한 문장', id(301));
    expect(matches(connection, 'chunks_fts', NEEDLE)).toBe(before);
    expect(matches(connection, 'chunks_fts', '"수정한"')).toBe(1);

    connection.database.prepare('delete from chunks where id = ?').run(id(301));
    expect(matches(connection, 'chunks_fts', '"수정한"')).toBe(0);
    expect(matches(connection, 'chunks_fts', NEEDLE)).toBe(before);
  });
});
