import { sql, type Kysely } from 'kysely';
import {
  describe,
  isBusy,
  setRedactAllowed,
  type SqliteConnection,
} from './connect.js';
import type { SqliteSchema } from './driver.js';

/**
 * What a write may answer with. A lock it could not take is a value, because
 * the caller's next move is to spool the write rather than to crash (AD-9).
 * Anything else that goes wrong inside the transaction is a bug and throws,
 * after the rollback.
 */
export type WriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: 'DB_LOCKED'; message: string };

export interface WriteOptions {
  /**
   * Raise the redaction marker for the length of this transaction, so the
   * triggers of AD-11 let an update through. It comes down again whether the
   * transaction committed or rolled back.
   */
  redact?: boolean;
}

/**
 * The one way anything is written (AD-7).
 *
 * Kysely's own `db.transaction()` cannot be used here: its SQLite driver opens
 * with a bare `begin`, which is DEFERRED, and a DEFERRED transaction that only
 * discovers it needs the write lock at its first write fails with `SQLITE_BUSY`
 * at once — `busy_timeout` does not retry a failed lock promotion. `BEGIN
 * IMMEDIATE` takes the lock up front, which is the thing `busy_timeout` waits
 * for. So the statements are issued by hand, on one connection held for the
 * whole transaction.
 *
 * The driver is synchronous, so the wait for the lock blocks this process
 * entirely. That is why the budget is a Core constant chosen per calling path
 * (`BUSY_TIMEOUT_MS`) rather than one number for the adapter.
 *
 * `work` must send every statement through the `held` handle it is given, and
 * never through `connection.db`. Kysely serialises `connection()` on a single
 * mutex, which this transaction is holding for as long as `work` runs: a query
 * on `connection.db` from inside `work` queues behind a connection that only
 * becomes free once `work` returns, so it waits on itself and hangs for good —
 * no timeout, no error, no `DB_LOCKED`. The same applies to a second
 * `withWrite` started before the first one resolves.
 */
export async function withWrite<T>(
  connection: SqliteConnection,
  work: (db: Kysely<SqliteSchema>) => Promise<T>,
  options: WriteOptions = {},
): Promise<WriteResult<T>> {
  const redact = options.redact === true;

  return connection.db.connection().execute(async (held) => {
    try {
      await sql`begin immediate`.execute(held);
    } catch (error) {
      // Any of the busy codes, not just the bare 5: `node:sqlite` reports
      // extended result codes, so `SQLITE_BUSY_SNAPSHOT` and friends arrive
      // with the primary code in the low byte (see `isBusy`).
      if (isBusy(error)) {
        // Nothing was opened, so there is nothing to roll back.
        return { ok: false, code: 'DB_LOCKED', message: `쓰기 잠금을 얻지 못했습니다: ${describe(error)}` };
      }
      throw error;
    }

    if (redact) setRedactAllowed(connection, true);
    try {
      if (redact) await sql`pragma secure_delete = on`.execute(held);
      const value = await work(held);
      await sql`commit`.execute(held);
      return { ok: true, value };
    } catch (error) {
      // Best effort: the original failure is the interesting one.
      await sql`rollback`.execute(held).catch(() => {});
      throw error;
    } finally {
      // Never conditional on the outcome. A marker left raised would let every
      // later update in this process past the triggers of AD-11, which are the
      // only defence the original text has (NFR-1).
      if (redact) {
        setRedactAllowed(connection, false);
        await sql`pragma secure_delete = off`.execute(held);
      }
    }
  });
}
