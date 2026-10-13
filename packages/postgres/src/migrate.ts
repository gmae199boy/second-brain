import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import { createPool, describe, type ConnectionOptions } from './connect.js';

/**
 * The version this code expects the database to be at: the number of the last
 * migration file. Runtime commands compare it against the stored version and
 * refuse to write when the two differ (AD-20, story 4).
 */
export const SCHEMA_VERSION = 1;

/** What `runMigrations` needs: a connection, nothing else (AD-10, AD-18). */
export type RunMigrationsOptions = ConnectionOptions;

/**
 * Result of a migration run. An unreachable database is a value, not an
 * exception (Conventions), so an installer can report it rather than crash.
 *
 * The two failures are told apart because they mean different things to the
 * person reading them: `DB_UNAVAILABLE` says the database was not there, and
 * nothing was attempted; `MIGRATION_FAILED` says it was there, answered, and
 * refused a statement — which is a schema problem, not a connection one, and
 * naming it `DB_UNAVAILABLE` sends the reader to restart a database that is
 * already running.
 */
export type MigrationResult =
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
      /** The file whose statements the server refused. */
      file: string;
    };

/** Migrations go forward only, one numbered SQL file at a time (Conventions). */
const MIGRATION_FILE = /^(\d{4})_.+\.sql$/;

/**
 * Resolved against this module rather than the working directory, because
 * `brain` runs from wherever the harness happens to be. `src/` and `dist/` both
 * sit one level under the package root, so the same relative path works for the
 * built and the unbuilt module.
 */
const MIGRATIONS_URL = new URL('../migrations/', import.meta.url);

/**
 * Advisory lock key held for each file's transaction, so two installers that
 * start at the same moment apply every file exactly once (AD-7). Any stable
 * number does; this one is arbitrary.
 */
const MIGRATION_LOCK_KEY = 4_919_270_911;

interface MigrationFile {
  name: string;
  version: number;
  path: string;
}

/**
 * Bring the database up to `SCHEMA_VERSION`. Only `setup run` and
 * `setup upgrade` call this; no runtime command migrates (AD-20).
 *
 * Each pending file is applied in its own transaction, under the advisory lock,
 * together with the version bump — so a file either took effect and was
 * recorded, or neither. Reading the folder and connecting both happen inside
 * this call (AD-3).
 *
 * Connecting is its own step with its own code: everything from the first
 * statement on is the schema's business, so it comes back as
 * `MIGRATION_FAILED`, named after the file the server refused.
 */
export async function runMigrations(options: RunMigrationsOptions): Promise<MigrationResult> {
  const files = await readMigrationFiles();

  // Only connecting is on a budget: a run may legitimately wait on the lock
  // behind another installer, or spend a while in one long statement.
  const pool = createPool({ ...options, queryTimeoutMs: 0 });
  try {
    let client: PoolClient;
    try {
      client = await pool.connect();
    } catch (error) {
      // Nothing was attempted, so this is the connection's failure alone.
      return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
    }

    // Which file was in hand when it went wrong. Set before any statement of
    // that file runs, so the failure can name it.
    let attempting: string | undefined;
    try {
      let from: number | null = null;
      let current = 0;
      const applied: string[] = [];

      for (const file of files) {
        attempting = file.name;
        const statements = await readFile(file.path, 'utf8');
        const outcome = await inTransaction(client, async () => {
          await client.query('select pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY]);
          const stored = await readSchemaVersion(client);
          if (file.version <= stored) {
            // Someone else got here first, or we did on an earlier run.
            return { stored, took: false };
          }
          await client.query(statements);
          await client.query(
            `insert into schema_version (id, version, applied_at)
                  values (true, $1, now())
             on conflict (id) do update
                    set version = excluded.version,
                        applied_at = excluded.applied_at`,
            [file.version],
          );
          return { stored, took: true };
        });

        // The version read in the first transaction is where this run started.
        from ??= outcome.stored;
        current = outcome.took ? file.version : outcome.stored;
        if (outcome.took) {
          applied.push(file.name);
        }
      }

      return { ok: true, from: from ?? current, to: current, applied };
    } catch (error) {
      // The database answered and refused something, as a value (Conventions).
      return {
        ok: false,
        code: 'MIGRATION_FAILED',
        message: describe(error),
        file: attempting ?? '',
      };
    } finally {
      client.release();
    }
  } finally {
    // Shutting the pool down is best effort; the verdict is already decided.
    await pool.end().catch(() => {});
  }
}

/** Run `work` between `begin` and `commit`, rolling back if it throws. */
async function inTransaction<T>(client: PoolClient, work: () => Promise<T>): Promise<T> {
  await client.query('begin');
  try {
    const result = await work();
    await client.query('commit');
    return result;
  } catch (error) {
    // The rollback is best effort: the original failure is what matters.
    await client.query('rollback').catch(() => {});
    throw error;
  }
}

/**
 * The stored version, or `0` when the table is not there yet — which is what an
 * empty database looks like, since `schema_version` arrives with the first
 * migration.
 */
async function readSchemaVersion(client: PoolClient): Promise<number> {
  const present = await client.query<{ relation: string | null }>(
    `select to_regclass('public.schema_version')::text as relation`,
  );
  if (present.rows[0]?.relation == null) {
    return 0;
  }
  const stored = await client.query<{ version: number }>('select version from schema_version');
  return stored.rows[0]?.version ?? 0;
}

/**
 * The migration files, in order. A folder that is missing, unreadable, holds
 * two files with the same number, or does not reach `SCHEMA_VERSION` is a
 * packaging bug, so it throws (Conventions: exceptions are for bugs). Without
 * that last check an empty folder would report a successful run to version 0.
 */
async function readMigrationFiles(): Promise<readonly MigrationFile[]> {
  const directory = fileURLToPath(MIGRATIONS_URL);
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

  const highest = files.at(-1)?.version ?? 0;
  if (highest !== SCHEMA_VERSION) {
    throw new Error(
      `the migrations folder reaches version ${highest}, not SCHEMA_VERSION ${SCHEMA_VERSION}: ${directory}`,
    );
  }

  return files;
}
