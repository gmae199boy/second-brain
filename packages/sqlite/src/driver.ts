import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import {
  Kysely,
  SqliteDialect,
  type SqliteDatabase,
  type SqliteStatement,
} from 'kysely';

/**
 * Kysely 0.29.6 ships no `node:sqlite` dialect, and the two third-party ones
 * are a single pre-0.1 release and a package pinned to Kysely 0.28. What it
 * does ship is a dialect written against a small subset of `better-sqlite3`,
 * and `node:sqlite` differs from that subset in exactly two places: it has no
 * `reader` flag, and it takes bound parameters spread rather than as an array.
 * So the adapter is this file, and the dependency stays at `kysely` alone
 * (AD-1).
 */

/** The schedule row type; other adapter tables are queried with raw SQL. */
export interface SqliteSchema {
  schedules: import('./schedules.js').ScheduleRow;
}

export interface DriverOptions {
  /**
   * Called with every statement, in the order the driver prepares them. For
   * tests that have to see which statement opened a transaction — `AD-7` turns
   * on the first statement of a write being `begin immediate`, and a claim
   * nobody can check is not a guarantee.
   */
  onQuery?: (sql: string) => void;
}

/**
 * Wrap an open `DatabaseSync` as the shape Kysely's SQLite dialect expects.
 *
 * `reader` decides whether the dialect reads rows back or reports affected
 * counts, and a prepared statement knows: a statement that returns a result set
 * names its columns, and one that does not names none.
 */
export function adaptDatabase(
  database: DatabaseSync,
  options: DriverOptions = {},
): SqliteDatabase {
  return {
    close() {
      database.close();
    },
    prepare(sql: string): SqliteStatement {
      options.onQuery?.(sql);
      const statement = database.prepare(sql);
      return {
        get reader(): boolean {
          return statement.columns().length > 0;
        },
        all(parameters: ReadonlyArray<unknown>): unknown[] {
          return statement.all(...bind(parameters)) as unknown[];
        },
        run(parameters: ReadonlyArray<unknown>) {
          const { changes, lastInsertRowid } = statement.run(...bind(parameters));
          return { changes, lastInsertRowid };
        },
        iterate(parameters: ReadonlyArray<unknown>): IterableIterator<unknown> {
          return statement.iterate(...bind(parameters)) as IterableIterator<unknown>;
        },
      };
    },
  };
}

/** Build the Kysely instance over an adapted database. */
export function createKysely(
  database: DatabaseSync,
  options: DriverOptions = {},
): Kysely<SqliteSchema> {
  return new Kysely<SqliteSchema>({
    dialect: new SqliteDialect({ database: adaptDatabase(database, options) }),
  });
}

/**
 * `node:sqlite` binds `null`, numbers, bigints, strings and byte arrays, and
 * throws on anything else — a `Date`, for one, which is why instants cross this
 * boundary as canonical text (AD-13). The cast says only that Kysely's
 * `unknown` parameters reach the driver untouched; the driver is what rejects a
 * value it cannot bind, with a message naming it.
 */
function bind(parameters: ReadonlyArray<unknown>): SQLInputValue[] {
  return parameters as SQLInputValue[];
}
