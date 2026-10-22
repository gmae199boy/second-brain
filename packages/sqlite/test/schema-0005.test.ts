import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';
import { findSqliteProjectKeyCollisions } from '../src/project-keys.js';
import { withWrite } from '../src/write.js';

/**
 * The fifth migration: the record of a masked tool note target, the call id a
 * note is keyed on, the stage a failed reading has to name, the comparison key
 * that decides whether two checkouts are one project, and the two columns that
 * say when a failure started and how often it has happened (AD-11, AD-12,
 * AD-21, AD-24).
 *
 * Three things are held here. That the upgrade carries every row of a version 4
 * database across — three of the tables are a `drop` and a copy. That the new
 * keys, checks and triggers refuse what they say they refuse, since nothing
 * writes most of these columns yet and the schema is the whole of the promise
 * until the stories that use them arrive. And that the one destructive step
 * this migration can need — folding two projects that only differ by case —
 * happens only when it is asked for, happens inside the migration's own
 * transaction, and moves every reference before it deletes a row.
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
  otherSession: id(3),
  message: id(4),
  redaction: id(5),
  failure: id(6),
  toolNote: id(7),
  file: id(10),
  extractionOld: id(11),
  extractionLive: id(12),
  work: id(13),
  logEntry: id(14),
  // The two projects that only differ by the case of their remote, and a third
  // on a host that compares with case.
  projectUpper: id(20),
  projectLower: id(21),
  projectOther: id(22),
  /** `/demo/repo` under both of the two, so a merge has one path to fold. */
  worktreeUpperShared: id(30),
  worktreeLowerShared: id(31),
  /** A path only the losing project has, so a merge has one to move. */
  worktreeLowerOwn: id(32),
  worktreeOther: id(33),
};

const SEEDED_AT = '2026-02-03T04:05:06.000Z';
const LATER = '2026-02-03T04:05:07.000Z';
const LATEST = '2026-02-03T04:05:08.000Z';

const EXTRACTOR = 'doc/1+demo-0.0.0';

/** The remote of the project a merge keeps, and of the one it folds into it. */
const REMOTE_UPPER = 'github.com/Owner/Repo';
const REMOTE_LOWER = 'github.com/owner/repo';
/** GitLab compares with case, so this one is its own key, spelling and all. */
const REMOTE_OTHER = 'gitlab.com/A/B';

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterAll(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-0005-'));
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

function all(connection: SqliteConnection, query: string): unknown[] {
  return connection.database.prepare(query).all();
}

/**
 * A file that stopped at version 4, the way an install from before this story
 * did: only the first four migration files, copied into a folder of this
 * test's own. A folder the caller names is not held to
 * `SQLITE_SCHEMA_VERSION`, which is how the tests reach it.
 */
async function versionFourPath(): Promise<string> {
  const directory = await scratch();
  for (const name of [
    '0001_initial.sql',
    '0002_files_and_work.sql',
    '0003_users.sql',
    '0004_capture_columns.sql',
  ]) {
    await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
  }
  const path = join(await scratch(), 'brain.db');
  expect(await runSqliteMigrations({ path, directory })).toEqual({
    ok: true,
    from: 0,
    to: 4,
    applied: [
      '0001_initial.sql',
      '0002_files_and_work.sql',
      '0003_users.sql',
      '0004_capture_columns.sql',
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

/** The owner and one session, which nearly every other row needs (AD-12). */
function seedSession(connection: SqliteConnection): void {
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
}

/**
 * One row in every table 0005 touches, written against the version 4 schema:
 * the shape the upgrade has to carry across. Two projects differing only in
 * case are deliberately *not* here — they are the one state the upgrade refuses
 * without consent, and they get their own describe block.
 */
function seedVersionFour(connection: SqliteConnection): void {
  seedSession(connection);
  insert(connection, 'projects', { id: ids.projectUpper, remote_identity: REMOTE_UPPER });
  insert(connection, 'projects', { id: ids.projectOther, remote_identity: REMOTE_OTHER });
  // A local checkout with no remote at all: the identity is the path, and the
  // key has to leave it exactly as it is.
  insert(connection, 'projects', { id: id(23), remote_identity: '/demo/no-remote' });
  insert(connection, 'worktrees', {
    id: ids.worktreeUpperShared,
    project_id: ids.projectUpper,
    path: '/demo/repo',
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
  insert(connection, 'tool_notes', {
    id: ids.toolNote,
    session_id: ids.session,
    harness_message_id: 'h-1',
    ordinal: 0,
    tool: 'Read',
    target: '/demo/repo/notes.md',
    ok: 1,
  });
  insert(connection, 'redactions', {
    id: ids.redaction,
    message_id: ids.message,
    file_id: null,
    start: 4,
    end: 9,
    kind: 'api_key',
    content_hash: 'not-a-real-hash',
    occurred_at: SEEDED_AT,
    pattern_version: 'secrets/2',
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
  });
  insert(connection, 'files', {
    id: ids.file,
    content_hash: hash(1),
    size_bytes: 2048,
    first_seen_at: SEEDED_AT,
  });
  // A reading that failed before anything recorded a stage: the one row 0005's
  // triggers have to keep editable.
  insert(connection, 'document_extractions', {
    id: ids.extractionOld,
    file_id: ids.file,
    extractor_version: EXTRACTOR,
    attempt: 1,
    status: 'failed',
    started_at: SEEDED_AT,
    finished_at: LATER,
    error: 'it stopped somewhere',
    failed_stage: null,
  });
  insert(connection, 'log_entries', {
    id: ids.logEntry,
    kind: 'progress',
    session_id: ids.session,
    occurred_at: SEEDED_AT,
    recorded_at: SEEDED_AT,
    text: '초안을 읽었습니다',
    apply_project_id: ids.projectUpper,
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

describe('the upgrade from version 4 to version 6', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    const path = await versionFourPath();
    const before = open(path);
    seedVersionFour(before);
    await before.close();
    connections.splice(connections.indexOf(before), 1);

    expect(await runSqliteMigrations({ path })).toEqual({
      ok: true,
      from: 4,
      to: 7,
      applied: ['0005_identity_and_records.sql', '0006_drop_message_seq.sql', '0007_session_tag_source.sql'],
    });

    connection = open(path);
  });

  it('leaves every row where it was, under its own id', () => {
    for (const table of [
      'users',
      'sessions',
      'messages',
      'tool_notes',
      'redactions',
      'failures',
      'files',
      'document_extractions',
      'log_entries',
      'work_items',
      'worktrees',
    ]) {
      expect(connection.database.prepare(`select count(*) as n from ${table}`).get()?.n).toBe(1);
    }
    expect(connection.database.prepare('select count(*) as n from projects').get()?.n).toBe(3);
    expect(all(connection, 'pragma foreign_key_check')).toEqual([]);
  });

  it('folds the key of a case-insensitive host and leaves every other value alone', () => {
    expect(all(connection, 'select id, remote_identity, identity_key from projects order by id'))
      .toEqual([
        {
          id: ids.projectUpper,
          remote_identity: REMOTE_UPPER,
          identity_key: REMOTE_LOWER,
        },
        // GitLab compares with case, so the key is the remote, spelling and all.
        { id: ids.projectOther, remote_identity: REMOTE_OTHER, identity_key: REMOTE_OTHER },
        { id: id(23), remote_identity: '/demo/no-remote', identity_key: '/demo/no-remote' },
      ]);
  });

  it('gives the failure a first instant and a count of one', () => {
    expect(
      all(connection, 'select occurred_at, first_occurred_at, occurrences from failures'),
    ).toEqual([
      // "First" and "last" are the same occurrence for a row written before
      // this file: it is the only instant the row carries.
      { occurred_at: SEEDED_AT, first_occurred_at: SEEDED_AT, occurrences: 1 },
    ]);
  });

  it('carries the masked span over with no tool note behind it', () => {
    expect(all(connection, 'select * from redactions')).toEqual([
      {
        id: ids.redaction,
        message_id: ids.message,
        file_id: null,
        start: 4,
        end: 9,
        kind: 'api_key',
        content_hash: 'not-a-real-hash',
        occurred_at: SEEDED_AT,
        pattern_version: 'secrets/2',
        tool_note_id: null,
      },
    ]);
  });

  it('leaves the call id of a note nobody has re-read empty', () => {
    expect(all(connection, 'select call_id from tool_notes')).toEqual([{ call_id: null }]);
  });

  it('still lets the other columns of an old stageless failed reading be rewritten', () => {
    // Nothing is taken away, so the trigger has nothing to refuse: a row that
    // failed before anything recorded a stage must not become unusable.
    connection.database.exec(
      `update document_extractions set error = '다시 적습니다' where id = '${ids.extractionOld}'`,
    );
    expect(all(connection, 'select error, failed_stage from document_extractions')).toEqual([
      { error: '다시 적습니다', failed_stage: null },
    ]);
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
  });
});

describe('the redaction targets of 0005 (AD-11, AD-23)', () => {
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
    pattern_version: 'secrets/2',
    tool_note_id: null,
  };

  beforeAll(async () => {
    connection = open(await migratedPath());
    seedSession(connection);
    insert(connection, 'messages', {
      id: ids.message,
      session_id: ids.session,
      harness_message_id: 'h-1',
      role: 'user',
      body: 'the key is somewhere in here',
      occurred_at: SEEDED_AT,
    });
    insert(connection, 'tool_notes', {
      id: ids.toolNote,
      session_id: ids.session,
      harness_message_id: 'h-1',
      ordinal: 0,
      tool: 'Bash',
      target: 'curl -H "x-api-key: sk-demo"',
      ok: 1,
    });
    insert(connection, 'files', {
      id: ids.file,
      content_hash: hash(1),
      size_bytes: 2048,
      first_seen_at: SEEDED_AT,
    });
    insert(connection, 'redactions', messageRedaction);
  });

  it('takes a tool note redaction with a range over its target', () => {
    insert(connection, 'redactions', {
      ...messageRedaction,
      id: id(302),
      message_id: null,
      tool_note_id: ids.toolNote,
      start: 18,
      end: 25,
    });
    expect(
      connection.database
        .prepare('select tool_note_id, start, "end" from redactions where id = ?')
        .get(id(302)),
    ).toEqual({ tool_note_id: ids.toolNote, start: 18, end: 25 });
  });

  it('still takes a file redaction, which has no range because the whole content goes', () => {
    insert(connection, 'redactions', {
      ...messageRedaction,
      id: id(303),
      message_id: null,
      file_id: ids.file,
      start: null,
      end: null,
    });
    expect(
      connection.database
        .prepare('select file_id, start, "end" from redactions where id = ?')
        .get(id(303)),
    ).toEqual({ file_id: ids.file, start: null, end: null });
  });

  it.each([
    {
      name: 'a redaction of a message and a tool note at once',
      row: { id: id(311), tool_note_id: ids.toolNote },
    },
    {
      name: 'a redaction of all three at once',
      row: { id: id(312), file_id: ids.file, tool_note_id: ids.toolNote, start: null, end: null },
    },
    {
      name: 'a redaction of nothing at all',
      row: { id: id(313), message_id: null },
    },
    {
      name: 'a tool note redaction with no range',
      row: { id: id(314), message_id: null, tool_note_id: ids.toolNote, start: null, end: null },
    },
    {
      name: 'a tool note range that is not half-open',
      row: { id: id(315), message_id: null, tool_note_id: ids.toolNote, start: 4, end: 4 },
    },
  ])('refuses $name', ({ row }) => {
    expect(() => insert(connection, 'redactions', { ...messageRedaction, ...row })).toThrow(
      /CHECK constraint failed/,
    );
  });

  it.each([
    `update redactions set tool_note_id = null`,
    `update redactions set kind = 'token'`,
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
                                          content_hash, occurred_at, pattern_version,
                                          tool_note_id)
                       values (${id(316)}, null, null, 2, 9, 'api_key',
                               'not-a-real-hash', ${SEEDED_AT}, 'secrets/2',
                               ${ids.toolNote})`.execute(held);
        return 'checked';
      },
      { redact: true },
    );
    expect(marked).toEqual({ ok: true, value: 'checked' });
  });
});

describe('the call id of 0005 (parser v4)', () => {
  let connection: SqliteConnection;

  const note = {
    id: id(401),
    session_id: ids.session,
    harness_message_id: 'h-1',
    ordinal: 0,
    tool: 'Read',
    target: '/demo/repo/notes.md',
    ok: 1,
    call_id: 'call-aaaa',
  };

  beforeAll(async () => {
    connection = open(await migratedPath());
    seedSession(connection);
    insert(connection, 'sessions', {
      id: ids.otherSession,
      harness: 'demo',
      harness_session_id: 'session-0002',
      user_id: ids.user,
      machine: 'demo-machine',
      started_at: SEEDED_AT,
      ingest_source: 'live',
    });
    insert(connection, 'tool_notes', note);
  });

  it('refuses a second note with the same call id in the same session', () => {
    expect(() =>
      insert(connection, 'tool_notes', { ...note, id: id(402), ordinal: 1 }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('allows the same call id in another session, and any number with none at all', () => {
    // A call id is unique to the harness run that minted it, so two runs are
    // free to spell one the same way.
    insert(connection, 'tool_notes', {
      ...note,
      id: id(403),
      session_id: ids.otherSession,
    });
    insert(connection, 'tool_notes', { ...note, id: id(404), ordinal: 1, call_id: null });
    insert(connection, 'tool_notes', { ...note, id: id(405), ordinal: 2, call_id: null });
    expect(
      connection.database.prepare('select count(*) as n from tool_notes').get()?.n,
    ).toBe(4);
  });

  it('refuses an update of the call id, marker or no marker', async () => {
    expect(() => connection.database.exec(`update tool_notes set call_id = 'call-bbbb'`)).toThrow(
      /tool_notes[\s\S]*immutable/,
    );

    const marked = await withWrite(
      connection,
      async (held) => {
        await expect(
          sql`update tool_notes set call_id = 'call-bbbb' where id = ${note.id}`.execute(held),
        ).rejects.toThrow(/tool_notes[\s\S]*immutable/);
        // The target alone is still what a masking may change (AD-11).
        await sql`update tool_notes set target = '[REDACTED:api_key]' where id = ${note.id}`.execute(
          held,
        );
        return 'checked';
      },
      { redact: true },
    );
    expect(marked).toEqual({ ok: true, value: 'checked' });
    expect(
      connection.database.prepare('select target, call_id from tool_notes where id = ?').get(note.id),
    ).toEqual({ target: '[REDACTED:api_key]', call_id: 'call-aaaa' });
  });
});

describe('the failed stage of 0005 (AD-24)', () => {
  let connection: SqliteConnection;

  const reading = {
    id: id(501),
    file_id: ids.file,
    extractor_version: EXTRACTOR,
    attempt: 1,
    status: null as string | null,
    started_at: SEEDED_AT,
    finished_at: null as string | null,
    failed_stage: null as string | null,
  };

  beforeAll(async () => {
    connection = open(await migratedPath());
    insert(connection, 'files', {
      id: ids.file,
      content_hash: hash(1),
      size_bytes: 2048,
      first_seen_at: SEEDED_AT,
    });
  });

  it('refuses a failed reading inserted with no stage', () => {
    expect(() =>
      insert(connection, 'document_extractions', {
        ...reading,
        id: id(502),
        attempt: 9,
        status: 'failed',
        finished_at: LATER,
      }),
    ).toThrow(/failed_stage is required/);
  });

  it('refuses an update that turns a reading failed with no stage, and one that clears it', () => {
    insert(connection, 'document_extractions', reading);
    expect(() =>
      connection.database.exec(
        `update document_extractions set status = 'failed', finished_at = '${LATER}'
           where id = '${reading.id}'`,
      ),
    ).toThrow(/failed_stage is required/);

    // Named, it goes in — and then it cannot be taken away again.
    connection.database.exec(
      `update document_extractions set status = 'failed', finished_at = '${LATER}',
              failed_stage = 'extract' where id = '${reading.id}'`,
    );
    expect(() =>
      connection.database.exec(
        `update document_extractions set failed_stage = null where id = '${reading.id}'`,
      ),
    ).toThrow(/failed_stage is required/);

    expect(
      connection.database
        .prepare('select status, failed_stage from document_extractions where id = ?')
        .get(reading.id),
    ).toEqual({ status: 'failed', failed_stage: 'extract' });
  });

  it('leaves a reading that did not fail alone, whatever is written to it', () => {
    insert(connection, 'document_extractions', {
      ...reading,
      id: id(503),
      attempt: 2,
      status: 'unsupported',
      finished_at: LATER,
    });
    connection.database.exec(
      `update document_extractions set error = '지원하지 않습니다' where id = '${id(503)}'`,
    );
    expect(
      connection.database
        .prepare('select status, error, failed_stage from document_extractions where id = ?')
        .get(id(503)),
    ).toEqual({ status: 'unsupported', error: '지원하지 않습니다', failed_stage: null });
  });
});

describe('the project comparison key of 0005 (AD-12)', () => {
  let connection: SqliteConnection;

  beforeAll(async () => {
    connection = open(await migratedPath());
    insert(connection, 'projects', {
      id: ids.projectLower,
      remote_identity: REMOTE_LOWER,
      identity_key: REMOTE_LOWER,
    });
  });

  it('refuses a second project whose remote only differs by case', () => {
    expect(() =>
      insert(connection, 'projects', {
        id: ids.projectUpper,
        remote_identity: REMOTE_UPPER,
        identity_key: REMOTE_LOWER,
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('refuses a project with no key at all', () => {
    expect(() =>
      insert(connection, 'projects', { id: id(601), remote_identity: 'example.com/a/b' }),
    ).toThrow(/NOT NULL constraint failed/);
  });

  it('takes two hosts that compare with case as two projects', () => {
    insert(connection, 'projects', {
      id: ids.projectOther,
      remote_identity: REMOTE_OTHER,
      identity_key: REMOTE_OTHER,
    });
    insert(connection, 'projects', {
      id: id(602),
      remote_identity: 'gitlab.com/a/b',
      identity_key: 'gitlab.com/a/b',
    });
    expect(
      connection.database.prepare('select count(*) as n from projects').get()?.n,
    ).toBe(3);
  });
});

describe('the failure counters of 0005 (AD-21)', () => {
  let connection: SqliteConnection;

  const failure = {
    id: id(701),
    target_kind: 'session',
    target_id: 'demo:session-0001',
    stage: 'ingest',
    fingerprint: 'c0ffee',
    harness: 'demo',
    session_id: null,
    code: 'DB_UNAVAILABLE',
    message: 'the database was not there',
    occurred_at: SEEDED_AT,
    first_occurred_at: SEEDED_AT,
    occurrences: 1,
  };

  beforeAll(async () => {
    connection = open(await migratedPath());
    insert(connection, 'failures', failure);
  });

  it.each([
    { name: 'a row with no first instant', row: { id: id(702), first_occurred_at: null } },
    { name: 'a row with no count', row: { id: id(703), occurrences: null } },
  ])('refuses $name', ({ row }) => {
    expect(() => insert(connection, 'failures', { ...failure, ...row, fingerprint: 'beef' })).toThrow(
      /NOT NULL constraint failed/,
    );
  });

  it.each([
    { name: 'a count below one', row: { id: id(704), occurrences: 0 } },
    {
      name: 'a first instant that is not canonical',
      row: { id: id(705), first_occurred_at: '2026-02-03 04:05:06' },
    },
  ])('refuses $name', ({ row }) => {
    expect(() => insert(connection, 'failures', { ...failure, ...row, fingerprint: 'beef' })).toThrow(
      /CHECK constraint failed/,
    );
  });
});

/**
 * The projects that only differ by case, which is the one state 0005 cannot
 * take on its own.
 *
 * Both halves are held here: that the migration refuses rather than guesses,
 * and that the merge it is asked for moves every reference before it deletes a
 * row. The second is what makes the question worth asking — a person agreeing
 * to it is agreeing to lose a row, not a session.
 */
describe('a version 4 database whose projects collide', () => {
  async function collided(): Promise<string> {
    const path = await versionFourPath();
    const before = open(path);
    seedSession(before);
    insert(before, 'sessions', {
      id: ids.otherSession,
      harness: 'demo',
      harness_session_id: 'session-0002',
      user_id: ids.user,
      machine: 'demo-machine',
      started_at: SEEDED_AT,
      ingest_source: 'live',
    });
    insert(before, 'sessions', {
      id: id(50),
      harness: 'demo',
      harness_session_id: 'session-0003',
      user_id: ids.user,
      machine: 'demo-machine',
      started_at: SEEDED_AT,
      ingest_source: 'live',
    });
    // The older id is the one a merge keeps, whichever spelling it carries.
    insert(before, 'projects', { id: ids.projectUpper, remote_identity: REMOTE_UPPER });
    insert(before, 'projects', { id: ids.projectLower, remote_identity: REMOTE_LOWER });
    insert(before, 'projects', { id: ids.projectOther, remote_identity: REMOTE_OTHER });
    // The same folder under both: one checkout seen twice. The winner's side
    // still has it, so the merged row keeps a null `removed_at`.
    insert(before, 'worktrees', {
      id: ids.worktreeUpperShared,
      project_id: ids.projectUpper,
      path: '/demo/repo',
      removed_at: null,
    });
    insert(before, 'worktrees', {
      id: ids.worktreeLowerShared,
      project_id: ids.projectLower,
      path: '/demo/repo',
      removed_at: LATEST,
    });
    insert(before, 'worktrees', {
      id: ids.worktreeLowerOwn,
      project_id: ids.projectLower,
      path: '/demo/repo-review',
      removed_at: null,
    });
    insert(before, 'sessions', {
      id: id(51),
      harness: 'demo',
      harness_session_id: 'session-0004',
      user_id: ids.user,
      machine: 'demo-machine',
      started_at: SEEDED_AT,
      ingest_source: 'live',
    });
    // One session per project, plus one on the folder only the loser has.
    before.database.exec(
      `update sessions set project_id = '${ids.projectUpper}',
              worktree_id = '${ids.worktreeUpperShared}' where id = '${ids.session}'`,
    );
    before.database.exec(
      `update sessions set project_id = '${ids.projectLower}',
              worktree_id = '${ids.worktreeLowerShared}' where id = '${ids.otherSession}'`,
    );
    before.database.exec(
      `update sessions set project_id = '${ids.projectLower}',
              worktree_id = '${ids.worktreeLowerOwn}' where id = '${id(50)}'`,
    );
    insert(before, 'log_entries', {
      id: ids.logEntry,
      kind: 'progress',
      session_id: ids.otherSession,
      occurred_at: SEEDED_AT,
      recorded_at: SEEDED_AT,
      text: '규칙을 이 프로젝트에 적용했습니다',
      apply_project_id: ids.projectLower,
    });
    await before.close();
    connections.splice(connections.indexOf(before), 1);
    return path;
  }

  it('refuses 0005 and stays at version 4 when nobody asked for a merge', async () => {
    const path = await collided();

    expect(await runSqliteMigrations({ path })).toEqual({
      ok: false,
      code: 'MIGRATION_FAILED',
      message: expect.stringContaining('UNIQUE constraint failed: projects.identity_key'),
      file: '0005_identity_and_records.sql',
    });

    const after = open(path);
    expect(all(after, 'select version from schema_version')).toEqual([{ version: 4 }]);
    // The transaction rolled back whole: the table is still 0004's.
    expect(after.database.prepare('select count(*) as n from projects').get()?.n).toBe(3);
    expect(() => after.database.prepare('select identity_key from projects').all()).toThrow(
      /identity_key/,
    );
  });

  it('shows the group, with each remote and how many sessions it carries', async () => {
    const path = await collided();

    expect(await findSqliteProjectKeyCollisions(path)).toEqual({
      ok: true,
      groups: [
        {
          identityKey: REMOTE_LOWER,
          projects: [
            { id: ids.projectUpper, remoteIdentity: REMOTE_UPPER, sessions: 1 },
            { id: ids.projectLower, remoteIdentity: REMOTE_LOWER, sessions: 2 },
          ],
        },
      ],
    });
  });

  it('folds the group into the oldest project when it is asked to, keeping every session', async () => {
    const path = await collided();

    expect(await runSqliteMigrations({ path, mergeProjectKeyCollisions: true })).toEqual({
      ok: true,
      from: 4,
      to: 7,
      applied: ['0005_identity_and_records.sql', '0006_drop_message_seq.sql', '0007_session_tag_source.sql'],
    });

    const after = open(path);
    // One project for the key, and the host that compares with case untouched.
    expect(all(after, 'select id, remote_identity, identity_key from projects order by id')).toEqual([
      { id: ids.projectUpper, remote_identity: REMOTE_UPPER, identity_key: REMOTE_LOWER },
      { id: ids.projectOther, remote_identity: REMOTE_OTHER, identity_key: REMOTE_OTHER },
    ]);
    // The shared folder is one row now, under the winner, and `removed_at` is
    // null because one of the two still had it.
    expect(all(after, 'select id, project_id, path, removed_at from worktrees order by path')).toEqual(
      [
        {
          id: ids.worktreeUpperShared,
          project_id: ids.projectUpper,
          path: '/demo/repo',
          removed_at: null,
        },
        {
          id: ids.worktreeLowerOwn,
          project_id: ids.projectUpper,
          path: '/demo/repo-review',
          removed_at: null,
        },
      ],
    );
    // Every session is still here, and every one of them points at the winner.
    expect(
      all(after, 'select id, project_id, worktree_id from sessions order by harness_session_id'),
    ).toEqual([
      {
        id: ids.session,
        project_id: ids.projectUpper,
        worktree_id: ids.worktreeUpperShared,
      },
      {
        id: ids.otherSession,
        project_id: ids.projectUpper,
        worktree_id: ids.worktreeUpperShared,
      },
      { id: id(50), project_id: ids.projectUpper, worktree_id: ids.worktreeLowerOwn },
      // The fourth session was never tagged, and a merge does not tag it.
      { id: id(51), project_id: null, worktree_id: null },
    ]);
    expect(all(after, 'select apply_project_id from log_entries')).toEqual([
      { apply_project_id: ids.projectUpper },
    ]);
    expect(all(after, 'pragma foreign_key_check')).toEqual([]);
  });

  it('answers with no group once the key is enforced', async () => {
    const path = await collided();
    expect(await runSqliteMigrations({ path, mergeProjectKeyCollisions: true })).toMatchObject({
      ok: true,
      to: 7,
    });

    // The key is `unique` from here on, so a colliding pair cannot be in it.
    expect(await findSqliteProjectKeyCollisions(path)).toEqual({ ok: true, groups: [] });
  });

  /**
   * The one case that ties the two spellings of the comparison key together.
   *
   * The expression lives twice — in `0005_identity_and_records.sql`, which
   * cannot import a constant, and in `project-keys.ts`, which the finder and
   * the merge both read. If they ever disagree, one of two things happens and
   * this case sees both: the finder shows a group 0005 would have let through
   * (so the merge deletes a row for nothing), or 0005 refuses a pair the finder
   * never showed (so an install that was told yes still fails).
   */
  it('shows exactly the groups 0005 refuses, across hosts that fold and hosts that do not', async () => {
    const remotes = [
      'github.com/Owner/Repo',
      'github.com/owner/repo',
      'GitHub.com/Owner/Repo',
      'bitbucket.org/Team/Thing',
      'bitbucket.org/team/thing',
      'gitlab.com/A/B',
      'gitlab.com/a/b',
      'example.com/Mixed/Case',
      '/demo/no-remote',
      '/demo/No-Remote',
    ];
    const path = await versionFourPath();
    const before = open(path);
    remotes.forEach((remote, index) => {
      insert(before, 'projects', { id: id(800 + index), remote_identity: remote });
    });
    await before.close();
    connections.splice(connections.indexOf(before), 1);

    const found = await findSqliteProjectKeyCollisions(path);
    expect(found).toMatchObject({ ok: true });
    if (!found.ok) return;
    // GitHub folds its three into one and Bitbucket its two; GitLab, the
    // unknown host and the two local paths keep every spelling they have.
    expect(found.groups.map((group) => group.projects.map((project) => project.remoteIdentity)))
      .toEqual([
        ['bitbucket.org/Team/Thing', 'bitbucket.org/team/thing'],
        ['github.com/Owner/Repo', 'github.com/owner/repo', 'GitHub.com/Owner/Repo'],
      ]);

    // Without the merge, 0005 is refused: the groups above are exactly the
    // pairs the `unique` cannot take.
    expect(await runSqliteMigrations({ path })).toMatchObject({
      ok: false,
      code: 'MIGRATION_FAILED',
      file: '0005_identity_and_records.sql',
    });

    // With it, every group collapses to one row and nothing else moves.
    expect(await runSqliteMigrations({ path, mergeProjectKeyCollisions: true })).toMatchObject({
      ok: true,
      to: 7,
    });
    // The survivors, each with the key the *migration file* computed for it.
    // A count would not do: if the file's `case` folded fewer hosts than
    // `PROJECT_IDENTITY_KEY_SQL` does, the finder would have merged the group
    // anyway and the counts would still come out right — the stored key is the
    // only place that divergence shows.
    const after = open(path);
    expect(all(after, 'select id, remote_identity, identity_key from projects order by id')).toEqual(
      [
        // The GitHub group, folded onto the oldest id and its own remote.
        {
          id: id(800),
          remote_identity: 'github.com/Owner/Repo',
          identity_key: 'github.com/owner/repo',
        },
        {
          id: id(803),
          remote_identity: 'bitbucket.org/Team/Thing',
          identity_key: 'bitbucket.org/team/thing',
        },
        // Every other host and both local paths keep their spelling as the key.
        { id: id(805), remote_identity: 'gitlab.com/A/B', identity_key: 'gitlab.com/A/B' },
        { id: id(806), remote_identity: 'gitlab.com/a/b', identity_key: 'gitlab.com/a/b' },
        {
          id: id(807),
          remote_identity: 'example.com/Mixed/Case',
          identity_key: 'example.com/Mixed/Case',
        },
        { id: id(808), remote_identity: '/demo/no-remote', identity_key: '/demo/no-remote' },
        { id: id(809), remote_identity: '/demo/No-Remote', identity_key: '/demo/No-Remote' },
      ],
    );
  });

  it('answers with no group for a path that holds nothing, and creates nothing there', async () => {
    const directory = await scratch();
    const path = join(directory, 'brain.db');

    expect(await findSqliteProjectKeyCollisions(path)).toEqual({ ok: true, groups: [] });
    expect(await readdir(directory)).toEqual([]);
  });
});
