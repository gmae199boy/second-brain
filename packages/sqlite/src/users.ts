import {
  formatInstant,
  parseInstant,
  type EnsureSelfUserInput,
  type EnsureSelfUserResult,
  type ReadSelfUserResult,
  type User,
  type UserStore,
} from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { describe, type SqliteConnect } from './connect.js';
import type { SqliteSchema } from './driver.js';
import { withWrite } from './write.js';

/** The `users` row, as SQLite hands it back: no booleans, no instants (AD-13). */
interface UserRow {
  id: string;
  name: string;
  is_self: number;
  created_at: string;
}

/**
 * The identity capability on the local source: who this brain belongs to
 * (AD-12).
 *
 * There is at most one owner, and the database is what enforces it — the
 * partial unique index of migration 0003, not the code here. That matters
 * because two installs could run at once: the second one's insert is refused by
 * the index rather than by a check that read the table a moment earlier.
 */
export function sqliteUserStore(connect: SqliteConnect): UserStore {
  return {
    async ensureSelfUser(input: EnsureSelfUserInput): Promise<EnsureSelfUserResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const createdAt = formatInstant(input.createdAt);
      if (!createdAt.ok) {
        // A caller that handed over an instant the schema cannot store is a
        // bug, not a database problem (Conventions).
        throw new TypeError(`a user cannot be created at ${createdAt.message}`);
      }

      // One transaction: the insert and the read back have to see the same
      // database, or a second installer could land between them and this one
      // would report a row it did not write as its own.
      //
      // The whole of it is guarded, because a database older than version 3
      // has no `users` table and this is called by the installer right after
      // the migrations: a refusal there is the schema's answer, not a crash.
      let written;
      try {
        written = await withWrite(opened.connection, async (held) => {
          // `on conflict do nothing` with no target, so the partial index on
          // `is_self` and the primary key both land here. `returning` is how
          // "did this call create it?" is answered: a row came back or none
          // did.
          const inserted = await sql<{ id: string }>`
            insert into users (id, name, is_self, created_at)
                 values (${input.id}, ${input.name}, 1, ${createdAt.value})
            on conflict do nothing
              returning id
          `.execute(held);
          const user = await readSelf(held);
          return { created: inserted.rows.length > 0, user };
        });
      } catch (error) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
      }
      if (!written.ok) return written;

      const { created, user } = written.value;
      if (user === null) {
        // The insert did nothing and there is still no owner: the only way
        // there is a primary-key row with the proposed id that is not the self
        // row, which is a caller reusing an id it did not mint.
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `the owner could not be created and none is recorded: ${input.id} is already a user that is not the owner`,
        };
      }
      return { ok: true, created, user };
    },

    async readSelfUser(): Promise<ReadSelfUserResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }
      try {
        return { ok: true, user: await readSelf(opened.connection.db) };
      } catch (error) {
        // A database with no `users` table at all — version 2 or earlier — is
        // unreachable for this question rather than an owner-less one: saying
        // `null` would send the caller to `brain setup run` for a schema
        // problem the write guard reports better (AD-20).
        return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
      }
    },
  };
}

/** The one `is_self` row, or `null`. Shared by the write and the read path. */
async function readSelf(held: Kysely<SqliteSchema>): Promise<User | null> {
  const found = await sql<UserRow>`
    select id, name, is_self, created_at from users where is_self = 1
  `.execute(held);
  const row = found.rows[0];
  if (row === undefined) return null;
  return toUser(row);
}

/** One row as the domain type. An instant the codec refuses is a broken row. */
export function toUser(row: UserRow): User {
  const createdAt = parseInstant(row.created_at);
  if (!createdAt.ok) {
    throw new Error(`users.created_at is unreadable: ${createdAt.message}`);
  }
  return {
    id: row.id,
    name: row.name,
    isSelf: row.is_self === 1,
    createdAt: createdAt.value,
  };
}
