import type {
  HealthStore,
  ReadSchemaVersionResult,
  SchemaStore,
  StoreHealth,
} from '@second-brain/core';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { createPool, describe, type CreatePoolOptions } from './connect.js';

/**
 * Options of the store factory; the connection half is shared (AD-3). The
 * per-query budget is part of it, because the caller — not this adapter — knows
 * whether its queries answer at once or legitimately run long.
 */
export type PostgresStoreOptions = CreatePoolOptions;

/** Shape of the version row the health probe reads. */
interface VersionRow {
  server_version: string;
}

interface VectorRow {
  installed: string | null;
  available: string | null;
}

interface SchemaVersionRow {
  version: number;
  applied_at: Date;
}

/**
 * `undefined_table`. An empty database has no `schema_version`, because the
 * table arrives with the first migration, and that is a version of `null`
 * rather than an unreachable database.
 */
const UNDEFINED_TABLE = '42P01';

/**
 * Build a Postgres-backed `HealthStore`. The pool and the Kysely instance are
 * created here, inside the factory, so importing this module connects to
 * nothing (AD-3).
 *
 * It implements the health and schema-version capabilities: the session tables
 * arrive with the first migration, and the day this adapter implements
 * `SessionStore` too the return type widens to `Store` and the session contract
 * runs against it. No stub methods in the meantime (AD-10).
 */
export function postgresStore(options: PostgresStoreOptions): HealthStore & SchemaStore {
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
          source: {
            location: locationOf(options.databaseUrl),
            probes: [
              {
                id: 'vector',
                ok: vectorRow.installed !== null,
                detail: vectorDetail(vectorRow),
              },
            ],
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

    async readSchemaVersion(): Promise<ReadSchemaVersionResult> {
      try {
        const stored = await sql<SchemaVersionRow>`
          select version, applied_at from schema_version
        `.execute(db);

        const row = stored.rows[0];
        if (row === undefined) {
          // The table is there but empty: a migration that created it and died
          // before recording a version. Still "no version yet".
          return { ok: true, version: null };
        }
        return {
          ok: true,
          version: { version: row.version, appliedAt: row.applied_at },
        };
      } catch (error) {
        if (sqlState(error) === UNDEFINED_TABLE) {
          return { ok: true, version: null };
        }
        return { ok: false, code: 'DB_UNAVAILABLE', message: describe(error) };
      }
    },

    async close(): Promise<void> {
      await db.destroy();
    },
  };
}

/**
 * What the vector probe says it found. The wording is the one `admin doctor`
 * has always printed, because the probe now carries the sentence that used to
 * be composed in Core — and the line a person reads must not change just
 * because the shape behind it did.
 */
function vectorDetail(vector: VectorRow): string {
  if (vector.installed !== null) return vector.installed;
  return vector.available !== null
    ? `not installed (available: ${vector.available})`
    : 'not installed (not available on this server)';
}

/**
 * Where this source lives, for a human reading a report: host, port and
 * database. Built by hand from the parsed URL rather than by printing it,
 * because the URL carries the password and `location` is printed.
 */
function locationOf(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    return 'postgres';
  }

  const host = url.port === '' ? url.hostname : `${url.hostname}:${url.port}`;
  const database = url.pathname.replace(/^\//, '');
  if (host === '') return database === '' ? 'postgres' : database;
  return database === '' ? host : `${host}/${database}`;
}

/**
 * The five-character SQLSTATE `pg` puts on a server-side error, or `undefined`
 * when the failure never reached the server. Kysely wraps nothing here, so the
 * code sits on the error itself.
 */
function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code: unknown = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}
