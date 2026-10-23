import {
  BUSY_TIMEOUT_MS,
  parseInstant,
  type ReadSchemaVersionResult,
  type SchemaStore,
  type Store,
  type StoreHealth,
  type StoreProbe,
} from '@second-brain/core';
import { sql } from 'kysely';
import {
  describe,
  isBusy,
  openSqlite,
  type SqliteConnect,
  type SqliteConnection,
} from './connect.js';
import { sqliteAttachmentStore } from './attachments.js';
import { sqliteSessionStore } from './sessions.js';
import { sqliteTranscriptFileStore } from './transcript-files.js';
import { sqliteUserStore } from './users.js';
import { sqliteWorkStore } from './work.js';

export interface SqliteStoreOptions {
  /** Path of the database file. It is never created from here (AD-20). */
  path: string;
  /** Busy-timeout budget for this caller. Defaults to the command budget. */
  busyTimeoutMs?: number;
}

interface VersionRow {
  version: string;
}

interface JournalModeRow {
  journal_mode: string;
}

interface ForeignKeysRow {
  foreign_keys: number;
}

interface MatchRow {
  matched: number;
}

interface SchemaVersionRow {
  version: number;
  applied_at: string;
}

/**
 * Build a SQLite-backed `Store` and `SchemaStore` over one file.
 *
 * The file is opened on the first call, not on import and not in this factory,
 * so importing the bundle touches no disk (AD-3). A file that is not there is
 * `DB_UNAVAILABLE` every time it is asked, and never becomes one by being
 * asked.
 *
 * It implements every capability of `Store` -- health, sessions, identity --
 * plus the schema version, so the whole `Store` contract applies to it
 * (AD-10).
 */
export function sqliteStore(options: SqliteStoreOptions): Store & SchemaStore {
  const { path, busyTimeoutMs = BUSY_TIMEOUT_MS.command } = options;

  let connection: SqliteConnection | undefined;

  /**
   * The open connection, or the reason there is none. The failure is not
   * cached: a brain installed between two calls must be found by the second.
   */
  const connect: SqliteConnect = () => {
    if (connection !== undefined) return { ok: true, connection };
    const opened = openSqlite({ path, busyTimeoutMs });
    if (!opened.ok) return opened;
    connection = opened.connection;
    return { ok: true, connection };
  };

  return {
    ...sqliteSessionStore(connect),
    ...sqliteAttachmentStore(connect),
    ...sqliteUserStore(connect),
    ...sqliteWorkStore(connect),
    ...sqliteTranscriptFileStore(connect),

    async checkHealth(): Promise<StoreHealth> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      try {
        const version = await sql<VersionRow>`select sqlite_version() as version`.execute(
          opened.connection.db,
        );
        const serverVersion = version.rows[0]?.version;
        if (serverVersion === undefined) {
          return {
            ok: false,
            code: 'DB_UNAVAILABLE',
            message: '데이터베이스가 상태 탐침에 아무 행도 돌려주지 않았습니다',
          };
        }

        return {
          ok: true,
          serverVersion,
          source: {
            location: path,
            probes: [
              await writableProbe(opened.connection, busyTimeoutMs),
              await walProbe(opened.connection),
              await trigramProbe(opened.connection),
              await foreignKeyProbe(opened.connection),
            ],
          },
        };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `데이터베이스 상태를 확인할 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async readSchemaVersion(): Promise<ReadSchemaVersionResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      let rows: readonly SchemaVersionRow[];
      try {
        const stored = await sql<SchemaVersionRow>`
          select version, applied_at from schema_version
        `.execute(opened.connection.db);
        rows = stored.rows;
      } catch (error) {
        if (isMissingTable(error)) {
          // An empty database: the table arrives with the first migration.
          return { ok: true, version: null };
        }
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `스키마 버전을 읽을 수 없습니다: ${describe(error)}`,
        };
      }

      const row = rows[0];
      if (row === undefined) {
        // The table is there but empty: a migration that created it and died
        // before recording a version. Still "no version yet".
        return { ok: true, version: null };
      }

      // Instants are text here (AD-13), and only the canonical spelling counts:
      // a row holding anything else was not written by this code, so the
      // database is not one we can read, rather than one that says nothing.
      const appliedAt = parseInstant(row.applied_at);
      if (!appliedAt.ok) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `schema_version.applied_at을 읽을 수 없습니다: ${appliedAt.message}`,
        };
      }

      return { ok: true, version: { version: row.version, appliedAt: appliedAt.value } };
    },

    async close(): Promise<void> {
      const open = connection;
      connection = undefined;
      await open?.close();
    },
  };
}

/**
 * Whether this process could actually write, which opening the file does not
 * say. Measured on Node 24.16.0: a database file at mode 0444 opens under
 * `?mode=rw` without complaint, answers `pragma journal_mode`, answers a
 * `select`, and even takes `begin immediate` — the refusal
 * (`SQLITE_READONLY`) arrives at the first statement that touches a page. A
 * read-only *folder* fails earlier, at `journal_mode`, which is why the `wal`
 * probe catches that case and not this one.
 *
 * So the probe writes, and takes the write back: `begin immediate` for the
 * write lock, a `create table` to make SQLite touch a page, `rollback` to leave
 * nothing behind. A read stays a read — there is no `brain_probe_writable`
 * table afterwards, whichever way the probe went.
 *
 * It waits for nobody: `busy_timeout` goes to 0 for the probe and back to the
 * caller's budget afterwards. A question about permissions must not sit on the
 * command's whole lock budget because a hook happens to be writing, and a
 * database somebody else is writing to is not one to report as unwritable — so
 * a busy answer is an `ok` that warns, which doctor shows as `warn`: the probe
 * found nothing wrong and settled nothing either.
 *
 * Note for whoever reads a failure here: SQLite leaves `-wal` and `-shm` beside
 * the database at the database file's own mode, so a file that was once 0444
 * can keep failing this probe after its own mode is fixed, until the sidecars
 * are fixed too.
 */
async function writableProbe(
  connection: SqliteConnection,
  busyTimeoutMs: number,
): Promise<StoreProbe> {
  return probe('writable', async () => {
    // The driver handle, not Kysely: transaction control belongs to one
    // connection, and this is the one every query here goes through anyway.
    const { database } = connection;
    try {
      database.exec('pragma busy_timeout = 0');
      database.exec('begin immediate');
      database.exec('create table main.brain_probe_writable(x)');
      return { ok: true, detail: '파일이 쓰기를 받아들이고 되돌렸습니다' };
    } catch (error) {
      if (isBusy(error)) {
        // Only a brain in use holds this lock, and holding it says nothing
        // about whether this process may write. Reporting `fail` here would
        // make a busy brain look like a broken one — and a plain `ok` would
        // claim a write that never happened, so it warns.
        return {
          ok: true,
          warn: true,
          detail: '다른 프로세스가 쓰기 잠금을 들고 있어 쓰기 가능 여부를 확인하지 못했습니다',
        };
      }
      return { ok: false, detail: `쓰기를 시험할 수 없습니다: ${describe(error)}` };
    } finally {
      // Undoes the table whether or not it was made; with no transaction open
      // there is nothing to undo and SQLite says so, which is not a failure.
      try {
        database.exec('rollback');
      } catch {
        // No transaction to roll back: `begin immediate` is what failed.
      }
      try {
        database.exec(`pragma busy_timeout = ${String(busyTimeoutMs)}`);
      } catch {
        // The budget of AD-7 could not be put back. Every later statement on
        // this connection would say so for itself, and the probe's own answer
        // is already decided.
      }
    }
  });
}

/**
 * Write-ahead logging, which is what lets a reader and the writer share the
 * file (AD-7). A database that is not in WAL would serialise every read behind
 * every write, so this is a capability and not a preference.
 */
async function walProbe(connection: SqliteConnection): Promise<StoreProbe> {
  return probe('wal', async () => {
    const result = await sql<JournalModeRow>`pragma journal_mode`.execute(connection.db);
    const mode = result.rows[0]?.journal_mode ?? 'unknown';
    return mode.toLowerCase() === 'wal'
      ? { ok: true, detail: mode }
      : { ok: false, detail: `journal_mode가 wal이 아니라 ${mode}입니다` };
  });
}

/**
 * The keyword index of AD-15 needs FTS5 with the `trigram` tokenizer. Both
 * depend on how the SQLite bundled with this Node was compiled, and the version
 * number does not say — so the probe builds a table and searches it rather than
 * comparing versions. A temp table, so a read stays a read.
 */
async function trigramProbe(connection: SqliteConnection): Promise<StoreProbe> {
  return probe('fts5-trigram', async () => {
    try {
      await sql`
        create virtual table temp.brain_probe_fts using fts5(body, tokenize='trigram')
      `.execute(connection.db);
      await sql`insert into temp.brain_probe_fts(body) values ('probe')`.execute(connection.db);
      // The needle is bound, not spliced, because that is how search will send
      // it and a probe that proves the easier thing proves nothing.
      const matched = await sql<MatchRow>`
        select count(*) as matched
          from temp.brain_probe_fts
         where brain_probe_fts match ${'"rob"'}
      `.execute(connection.db);
      return matched.rows[0]?.matched === 1
        ? { ok: true, detail: 'trigram 토크나이저가 있는 fts5' }
        : { ok: false, detail: '방금 색인한 것을 fts5 trigram 색인이 하나도 찾지 못했습니다' };
    } finally {
      await sql`drop table if exists temp.brain_probe_fts`
        .execute(connection.db)
        .catch(() => {});
    }
  });
}

/**
 * Foreign keys are a per-connection setting in SQLite, so this reports what
 * this connection enforces and nothing about what another tool would. The
 * migrations rely on it (AD-10).
 */
async function foreignKeyProbe(connection: SqliteConnection): Promise<StoreProbe> {
  return probe('foreign-keys', async () => {
    const result = await sql<ForeignKeysRow>`pragma foreign_keys`.execute(connection.db);
    return result.rows[0]?.foreign_keys === 1
      ? { ok: true, detail: '이 연결에서 적용됩니다' }
      : { ok: false, detail: '이 연결에서 적용되지 않습니다' };
  });
}

/** Run one probe. A probe that throws is a failed probe, never a failed report. */
async function probe(
  id: string,
  run: () => Promise<{ ok: boolean; warn?: boolean; detail: string }>,
): Promise<StoreProbe> {
  try {
    const { ok, warn, detail } = await run();
    // `warn` is left out rather than set to false, so a report carries the key
    // only where a probe meant something by it.
    return warn === true ? { id, ok, warn, detail } : { id, ok, detail };
  } catch (error) {
    return { id, ok: false, detail: `탐침이 실패했습니다: ${describe(error)}` };
  }
}

/**
 * Whether the database refused a query because the table is not there. SQLite
 * reports it as a plain `SQLITE_ERROR`, so the message is the only thing that
 * tells it apart from the other ways a statement can be rejected.
 */
function isMissingTable(error: unknown): boolean {
  return error instanceof Error && /no such table/i.test(error.message);
}
