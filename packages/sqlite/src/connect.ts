import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import type { Kysely } from 'kysely';
import { createKysely, type DriverOptions, type SqliteSchema } from './driver.js';

/**
 * How this adapter is told to reach the source. One function opens every
 * connection, so the pragmas and the redaction marker are set in exactly one
 * place: a second way in would be a connection with foreign keys off or no
 * busy timeout, and nothing would say so.
 */
export interface OpenSqliteOptions extends DriverOptions {
  /** Path of the database file. */
  path: string;
  /**
   * How long a statement waits for the write lock before giving up, in
   * milliseconds — SQLite's `busy_timeout`, which `node:sqlite` spells
   * `timeout`. Core owns the budgets: see `BUSY_TIMEOUT_MS` (AD-7).
   */
  busyTimeoutMs: number;
  /**
   * Create the file when it is not there. Off by default, and on for the
   * migration runner alone: a runtime command that silently creates an empty
   * database would report a healthy brain with nothing in it (AD-10, AD-20).
   */
  create?: boolean;
}

/**
 * An open connection: the Kysely instance every query goes through and the raw
 * handle for the few things SQL cannot express (pragmas, multi-statement
 * migration files).
 */
export interface SqliteConnection {
  /**
   * Queries, and the single-connection write path behind `withWrite` (AD-7).
   *
   * Do not use it **inside** a `withWrite` callback. Kysely serialises
   * `connection()` on one mutex, and `withWrite` is holding it: a query sent
   * through this field from inside the callback waits for a connection that
   * will not be released until the callback returns, so it waits for itself and
   * never finishes — no timeout, no error. The callback is handed its own
   * `held` handle, and that is the only one that may be used in there.
   */
  readonly db: Kysely<SqliteSchema>;
  /** The driver handle. Used for pragmas and for whole migration files. */
  readonly database: DatabaseSync;
  /** Where the file is, for a report a human reads. */
  readonly path: string;
  /** Whether the redaction marker is up. For the write path and its tests. */
  isRedactAllowed(): boolean;
  /** Release the handle. */
  close(): Promise<void>;
}

/**
 * The marker setters, kept beside the connections rather than on them. The
 * marker is the only thing standing between a redaction and every other update
 * (AD-11, NFR-1), so "only `withWrite` raises it" has to be structure and not
 * advice: there is no setter on `SqliteConnection`, and this module's entry
 * point does not export `setRedactAllowed`, so nothing outside this package —
 * including everything reached through `second_brain` — can reach it.
 */
const markers = new WeakMap<SqliteConnection, (allowed: boolean) => void>();

/**
 * Raise or lower the redaction marker that the `brain_redact_allowed()` SQL
 * function reports. `withWrite` is the one caller, and only inside a
 * `try/finally`: the marker is a variable in this process, not a property of
 * the transaction, so one left raised would let every later update through.
 */
export function setRedactAllowed(connection: SqliteConnection, allowed: boolean): void {
  const set = markers.get(connection);
  if (set === undefined) {
    // A connection this module did not open, which is a bug in the caller.
    throw new Error('this connection was not opened by openSqlite');
  }
  set(allowed);
}

/**
 * Reaching the open connection, or the reason there is none. It is a function
 * and not the connection itself because the file is opened on the first call
 * that needs it: the capability modules are handed this rather than a handle,
 * so importing the bundle still touches no disk (AD-3). The failure is not
 * cached either: a brain installed between two calls must be found by the
 * second.
 */
export type SqliteConnect = () =>
  | { ok: true; connection: SqliteConnection }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export type OpenSqliteResult =
  | { ok: true; connection: SqliteConnection }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * Open the source. A missing file is `DB_UNAVAILABLE` and leaves the directory
 * as it was — no `brain.db`, no `-wal`, no `-shm` — because the runtime opens
 * the URL form with `?mode=rw`, which SQLite refuses rather than creates. Only
 * the migration runner passes `create`.
 *
 * Expected failures are values (Conventions): a hook that runs on every turn
 * cannot be the thing that throws because the brain is not installed yet.
 */
export function openSqlite(options: OpenSqliteOptions): OpenSqliteResult {
  const { path, busyTimeoutMs, create = false, onQuery } = options;

  let database: DatabaseSync;
  try {
    // `?mode=rw` only has meaning in the URL form, and a plain path is what
    // creates. The two spellings are the whole difference between the runtime
    // and the installer.
    const target = create ? path : new URL(`${pathToFileURL(path).href}?mode=rw`);
    database = new DatabaseSync(target, { timeout: busyTimeoutMs });
  } catch (error) {
    return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
  }

  let redactAllowed = false;
  try {
    // Foreign keys are per connection and `node:sqlite` happens to default them
    // on; setting them anyway means the guarantee is ours and not a default's.
    // Recursive triggers are off by default and the redaction triggers of AD-11
    // need them.
    database.exec('pragma foreign_keys = ON');
    database.exec('pragma recursive_triggers = ON');
    // The marker AD-11's triggers consult. It reads a variable in this process,
    // which is why `withWrite` owns raising and lowering it.
    database.function('brain_redact_allowed', () => (redactAllowed ? 1 : 0));
  } catch (error) {
    database.close();
    return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
  }

  const db = createKysely(database, { onQuery });

  const connection: SqliteConnection = {
    db,
    database,
    path,
    isRedactAllowed(): boolean {
      return redactAllowed;
    },
    async close(): Promise<void> {
      // Destroying the Kysely instance closes the adapted database with it.
      await db.destroy();
    },
  };
  markers.set(connection, (allowed) => {
    redactAllowed = allowed;
  });

  return { ok: true, connection };
}

/**
 * The numeric SQLite result code `node:sqlite` puts on an error, or `undefined`
 * when the failure never reached SQLite.
 *
 * It is the **extended** result code, which is the primary code in its low byte
 * and a reason in the rest: a primary-key violation arrives as 1555
 * (`SQLITE_CONSTRAINT_PRIMARYKEY`) and not as 19, and a busy database can
 * arrive as 261, 517 or 773 as easily as 5. So a caller comparing against a
 * primary code has to mask with `& 0xff`; equality against the bare constant
 * silently misses every extended form.
 */
export function sqliteErrcode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const errcode: unknown = (error as { errcode?: unknown }).errcode;
  return typeof errcode === 'number' ? errcode : undefined;
}

/**
 * `SQLITE_BUSY`: somebody else holds the write lock and the wait ran out. A
 * primary code, so it is compared against the low byte of an extended one —
 * `SQLITE_BUSY_RECOVERY` (261), `_SNAPSHOT` (517) and `_TIMEOUT` (773) all
 * carry it there.
 */
export const SQLITE_BUSY = 5;

/** Whether this failure is SQLite saying the database is busy, in any of its forms. */
export function isBusy(error: unknown): boolean {
  const errcode = sqliteErrcode(error);
  return errcode !== undefined && (errcode & 0xff) === SQLITE_BUSY;
}

/**
 * Describe a failure in one non-empty line, so a coded value always carries
 * something a human can read (Conventions: no silent failure).
 */
export function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [error.message, typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? 'unknown error';
}
