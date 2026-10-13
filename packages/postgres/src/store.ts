import type { HealthStore, StoreHealth } from '@second-brain/core';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool, describe, type ConnectionOptions } from './connect.js';

/** Options of the store factory; the connection half is shared (AD-3). */
export type PostgresStoreOptions = ConnectionOptions;

/** Shape of the version row the health probe reads. */
interface VersionRow {
  server_version: string;
}

interface VectorRow {
  installed: string | null;
  available: string | null;
}

/**
 * Build a Postgres-backed `HealthStore`. The pool and the Kysely instance are
 * created here, inside the factory, so importing this module connects to
 * nothing (AD-3).
 *
 * It implements the health capability alone: the session tables arrive with the
 * first migration, and the day this adapter implements `SessionStore` too the
 * return type widens to `Store` and the session contract runs against it. No
 * stub methods in the meantime (AD-10).
 */
export function postgresStore(options: PostgresStoreOptions): HealthStore {
  const pool = createPool(options);

  const db = new Kysely<Record<string, never>>({
    dialect: new PostgresDialect({ pool }),
  });

  return {
    async checkHealth(): Promise<StoreHealth> {
      try {
        const version = await sql<VersionRow>`
          select current_setting('server_version') as server_version
        `.execute(db);
        const vector = await sql<VectorRow>`
          select (select extversion
                    from pg_extension
                   where extname = 'vector') as installed,
                 (select default_version
                    from pg_available_extensions
                   where name = 'vector') as available
        `.execute(db);

        const versionRow = version.rows[0];
        const vectorRow = vector.rows[0];
        if (versionRow === undefined || vectorRow === undefined) {
          return {
            ok: false,
            code: 'DB_UNAVAILABLE',
            message: 'the server answered the health probe with no rows',
          };
        }

        return {
          ok: true,
          serverVersion: versionRow.server_version,
          vector: {
            available: vectorRow.available,
            installed: vectorRow.installed,
          },
        };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: describe(error),
        };
      }
    },

    async close(): Promise<void> {
      await db.destroy();
    },
  };
}
