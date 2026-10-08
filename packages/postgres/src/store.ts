import type { Store, StoreHealth } from '@second-brain/core';
import { Kysely, PostgresDialect, sql } from 'kysely';
import pg from 'pg';

export interface PostgresStoreOptions {
  /** Postgres connection URL. Read by the caller, never by this module. */
  databaseUrl: string;
  /** Budget for both connecting and each probe query before giving up. */
  connectTimeoutMs?: number;
}

/** Shape of the version row the health probe reads. */
interface VersionRow {
  server_version: string;
}

interface VectorRow {
  installed: string | null;
  available: string | null;
}

/**
 * Build a Postgres-backed `Store`. The pool and the Kysely instance are created
 * here, inside the factory, so importing this module connects to nothing (AD-3).
 */
export function postgresStore(options: PostgresStoreOptions): Store {
  const { databaseUrl, connectTimeoutMs = 5000 } = options;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
    // A listener that accepts but never answers must not outlast the budget.
    query_timeout: connectTimeoutMs,
    max: 1,
  });
  // An idle client that dies must not take the process down with it.
  pool.on('error', () => {});

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

/**
 * Describe a failure in one non-empty line. Node's multi-address connect fails
 * with an `AggregateError` whose own message is empty, so fall back through the
 * inner errors, then the code, then the name.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [
    error.message,
    ...(error instanceof AggregateError ? error.errors.map(innerMessage) : []),
    typeof code === 'string' ? code : '',
    error.name,
  ];
  return candidates.find((candidate) => candidate !== '') ?? 'unknown error';
}

function innerMessage(inner: unknown): string {
  return inner instanceof Error ? inner.message : String(inner);
}
