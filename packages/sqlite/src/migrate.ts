import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BUSY_TIMEOUT_MS, formatInstant, type Clock } from '@second-brain/core';
import { sql } from 'kysely';
import { describe, openSqlite, type SqliteConnection } from './connect.js';
import { withWrite } from './write.js';

/**
 * The version this code expects the source to be at: the number of the last
 * migration file this package ships. Runtime commands compare it against the
 * stored version and refuse to write when the two differ (AD-20).
 *
 * The name carries the adapter's prefix because the one writing surface
 * re-exports this package beside `@second-brain/postgres`, which has a
 * `SCHEMA_VERSION` of its own: the two databases are migrated apart and nothing
 * says their numbers move together (AD-22).
 */
export const SQLITE_SCHEMA_VERSION = 2;

/**
 * The migrations this package ships. One level up from this module, which is
 * `src/` when the tests run it and `dist/` when it is installed — `migrations/`
 * sits beside both, and is in the package's `files` so it survives packing.
 */
export const SQLITE_MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL('../migrations/', import.meta.url),
);

/** What `runSqliteMigrations` needs. */
export interface RunSqliteMigrationsOptions {
  /** The database file. Created by this call if it is not there (AD-20). */
  path: string;
  /**
   * Folder of numbered `.sql` files. Defaults to the one this package ships,
   * which is what every caller outside this package's own tests wants; the
   * tests pass folders they wrote, to exercise the runner on schemas small
   * enough to read.
   */
  directory?: string;
  /** Lock budget. A migration may legitimately wait behind another installer. */
  busyTimeoutMs?: number;
  /** Source of `applied_at`. Defaults to the wall clock. */
  clock?: Clock;
}

/**
 * Result of a migration run, the same shape the Postgres runner answers with,
 * so an installer that has to run both reads one result type.
 *
 * The two failures are told apart because they mean different things to the
 * person reading them: `DB_UNAVAILABLE` says the file could not be opened and
 * nothing was attempted; `MIGRATION_FAILED` says it was open and refused a
 * statement, which is a schema problem and names the file.
 */
export type SqliteMigrationResult =
  | {
      ok: true;
      /** Version the database was at before this run. */
      from: number;
      /** Version it is at now. */
      to: number;
      /** File names applied by this run, in order. Empty when it was current. */
      applied: readonly string[];
    }
  | {
      ok: false;
      code: 'DB_UNAVAILABLE';
      message: string;
    }
  | {
      ok: false;
      code: 'MIGRATION_FAILED';
      message: string;
      /** The file whose statements the database refused. */
      file: string;
    };

/** Migrations go forward only, one numbered SQL file at a time (Conventions). */
const MIGRATION_FILE = /^(\d{4})_.+\.sql$/;

interface MigrationFile {
  name: string;
  version: number;
  path: string;
}

/**
 * Bring the database up to the highest version the folder holds. Only
 * `setup run` and `setup upgrade` call this; no runtime command migrates
 * (AD-20), and this is the one place allowed to create the file.
 *
 * Each pending file is applied inside one `withWrite` together with its version
 * bump, so a file either took effect and was recorded or neither. `BEGIN
 * IMMEDIATE` is the lock: two installers that start at the same moment queue up
 * behind each other and each file is applied exactly once — SQLite has one
 * writer per database, so there is nothing for an advisory lock to add.
 */
export async function runSqliteMigrations(
  options: RunSqliteMigrationsOptions,
): Promise<SqliteMigrationResult> {
  const {
    path,
    directory = SQLITE_MIGRATIONS_DIRECTORY,
    busyTimeoutMs = BUSY_TIMEOUT_MS.command,
    clock,
  } = options;
  const files = await readMigrationFiles(directory);

  const opened = openSqlite({ path, busyTimeoutMs, create: true });
  if (!opened.ok) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
  }
  const connection = opened.connection;

  // Which file was in hand when it went wrong. Set before any statement of
  // that file runs, so the failure can name it.
  let attempting: string | undefined;
  try {
    // Write-ahead logging is a property of the file, not of the connection, so
    // it is set once here and every later connection inherits it (AD-7).
    connection.database.exec('pragma journal_mode = WAL');

    let from: number | null = null;
    let current = 0;
    const applied: string[] = [];

    for (const file of files) {
      attempting = file.name;
      const statements = await readFile(file.path, 'utf8');
      const outcome = await withWrite(connection, async (held) => {
        const stored = await readStoredVersion(held);
        if (file.version <= stored) {
          // Someone else got here first, or we did on an earlier run.
          return { stored, took: false };
        }
        // The raw handle, because a migration file holds many statements and a
        // prepared statement holds one.
        connection.database.exec(statements);
        await recordVersion(held, file.version, clock);
        return { stored, took: true };
      });

      if (!outcome.ok) {
        // Another writer held the lock for longer than the budget. Every file
        // before this one is its own committed transaction and stays applied,
        // so the database is at some version between `from` and this file's.
        // The result type has no room for a partial `to` — the two runners
        // share one shape — so the message is where that goes, and it has to
        // say it: a reader told only "the database was busy" would not know
        // the schema had moved.
        const sofar = applied.length === 0 ? '' : ` after applying ${applied.join(', ')}`;
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `${file.name} could not take the write lock${sofar}: ${outcome.message}`,
        };
      }

      // The version read in the first transaction is where this run started.
      from ??= outcome.value.stored;
      current = outcome.value.took ? file.version : outcome.value.stored;
      if (outcome.value.took) {
        applied.push(file.name);
      }
    }

    return { ok: true, from: from ?? current, to: current, applied };
  } catch (error) {
    // The database was open and refused something, as a value (Conventions).
    return {
      ok: false,
      code: 'MIGRATION_FAILED',
      message: describe(error),
      file: attempting ?? '',
    };
  } finally {
    await connection.close().catch(() => {});
  }
}

/**
 * The stored version, or `0` when the table is not there yet — which is what an
 * empty database looks like, since `schema_version` arrives with the first
 * migration.
 */
async function readStoredVersion(held: SqliteConnection['db']): Promise<number> {
  const present = await sql<{ name: string }>`
    select name from sqlite_master where type = 'table' and name = 'schema_version'
  `.execute(held);
  if (present.rows.length === 0) return 0;

  const stored = await sql<{ version: number }>`select version from schema_version`.execute(held);
  return stored.rows[0]?.version ?? 0;
}

/**
 * Record the version this run reached. `applied_at` is canonical UTC text
 * (AD-13); a clock that cannot produce a formattable instant is a bug, so this
 * throws and the run comes back as `MIGRATION_FAILED` naming the file.
 */
async function recordVersion(
  held: SqliteConnection['db'],
  version: number,
  clock: Clock | undefined,
): Promise<void> {
  const now = clock === undefined ? new Date() : clock.now();
  const appliedAt = formatInstant(now);
  if (!appliedAt.ok) {
    throw new Error(`the clock gave an instant that cannot be stored: ${appliedAt.message}`);
  }

  await sql`
    insert into schema_version (id, version, applied_at)
         values (1, ${version}, ${appliedAt.value})
    on conflict (id) do update
           set version = excluded.version,
               applied_at = excluded.applied_at
  `.execute(held);
}

/**
 * The migration files, in order. A folder that is missing, unreadable or holds
 * two files with the same number is a packaging bug, so it throws (Conventions:
 * exceptions are for bugs).
 *
 * The shipped folder is held to `SQLITE_SCHEMA_VERSION` as well: a file that
 * was added without moving the constant, or a folder that arrived without its
 * files, would otherwise report a clean run to the wrong version and every
 * runtime command after it would refuse to write without saying why. A folder a
 * caller named is their own business and is not checked — that is how the
 * runner's own tests reach it.
 */
async function readMigrationFiles(directory: string): Promise<readonly MigrationFile[]> {
  const entries = await readdir(directory);

  const files = entries
    .map((name) => ({ name, match: MIGRATION_FILE.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .map(({ name, match }) => ({
      name,
      version: Number(match[1]),
      path: join(directory, name),
    }))
    .sort((left, right) => left.version - right.version);

  files.forEach((file, index) => {
    const previous = files[index - 1];
    if (previous !== undefined && previous.version === file.version) {
      throw new Error(
        `two migrations share the number ${file.version}: ${previous.name} and ${file.name}`,
      );
    }
  });

  // `resolve`, not `===`: the same folder spelled relatively, or without the
  // trailing slash, is the same folder and has to be held to the same version.
  if (resolve(directory) === resolve(SQLITE_MIGRATIONS_DIRECTORY)) {
    const highest = files.at(-1)?.version ?? 0;
    if (highest !== SQLITE_SCHEMA_VERSION) {
      throw new Error(
        `the migrations folder reaches version ${highest}, not SQLITE_SCHEMA_VERSION ${SQLITE_SCHEMA_VERSION}: ${directory}`,
      );
    }
  }

  return files;
}
