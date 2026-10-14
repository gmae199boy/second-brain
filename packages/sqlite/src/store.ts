import {
  BUSY_TIMEOUT_MS,
  parseInstant,
  type HealthStore,
  type ReadSchemaVersionResult,
  type SchemaStore,
  type StoreHealth,
  type StoreProbe,
} from '@second-brain/core';
import { sql } from 'kysely';
import { describe, isBusy, openSqlite, type SqliteConnection } from './connect.js';

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
 * Build a SQLite-backed `HealthStore` and `SchemaStore` over one file.
 *
 * The file is opened on the first call, not on import and not in this factory,
 * so importing the bundle touches no disk (AD-3). A file that is not there is
 * `DB_UNAVAILABLE` every time it is asked, and never becomes one by being
 * asked.
 *
 * It implements the health and schema-version capabilities only; `SessionStore`
 * arrives with the tables, in epic 2, and the return type widens then (AD-10).
 */
export function sqliteStore(options: SqliteStoreOptions): HealthStore & SchemaStore {
  const { path, busyTimeoutMs = BUSY_TIMEOUT_MS.command } = options;

  let connection: SqliteConnection | undefined;

  /**
   * The open connection, or the reason there is none. The failure is not
   * cached: a brain installed between two calls must be found by the second.
   */
  function connect():
    | { ok: true; connection: SqliteConnection }
    | { ok: false; code: 'DB_UNAVAILABLE'; message: string } {
    if (connection !== undefined) return { ok: true, connection };
    const opened = openSqlite({ path, busyTimeoutMs });
    if (!opened.ok) return opened;
    connection = opened.connection;
    return { ok: true, connection };
  }

  return {
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
            message: 'the database answered the health probe with no rows',
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
        return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
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
        return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
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
          message: `schema_version.applied_at is unreadable: ${appliedAt.message}`,
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
 * a busy answer is an `ok` that says the question was not settled.
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
      return { ok: true, detail: 'the file took a write and gave it back' };
    } catch (error) {
      if (isBusy(error)) {
        // Only a brain in use holds this lock, and holding it says nothing
        // about whether this process may write. Reporting `fail` here would
        // make a busy brain look like a broken one.
        return {
          ok: true,
          detail: 'another process holds the write lock, so writability was not tested',
        };
      }
      return { ok: false, detail: describe(error) };
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
      : { ok: false, detail: `journal_mode is ${mode}, not wal` };
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
        ? { ok: true, detail: 'fts5 with the trigram tokenizer' }
        : { ok: false, detail: 'an fts5 trigram index matched nothing it had just indexed' };
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
      ? { ok: true, detail: 'enforced on this connection' }
      : { ok: false, detail: 'not enforced on this connection' };
  });
}

/** Run one probe. A probe that throws is a failed probe, never a failed report. */
async function probe(
  id: string,
  run: () => Promise<{ ok: boolean; detail: string }>,
): Promise<StoreProbe> {
  try {
    const { ok, detail } = await run();
    return { id, ok, detail };
  } catch (error) {
    return { id, ok: false, detail: describe(error) };
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
