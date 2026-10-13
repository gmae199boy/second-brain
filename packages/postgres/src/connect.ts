import pg from 'pg';
import type { Pool } from 'pg';

/** How this adapter is told to reach Postgres. Read by the caller, never here. */
export interface ConnectionOptions {
  /** Postgres connection URL. */
  databaseUrl: string;
  /**
   * Budget for connecting, and for each query unless the caller sets
   * `queryTimeoutMs`, before giving up.
   */
  connectTimeoutMs?: number;
}

/** Default budget for a connect, and for a query when nothing overrides it. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** `createPool` input: a connection plus how long one query may take. */
export interface CreatePoolOptions extends ConnectionOptions {
  /**
   * Per-query budget. Defaults to `connectTimeoutMs`; `0` means no limit, for
   * callers whose queries may legitimately block (a migration waiting on the
   * advisory lock) or run long (a statement that builds an index).
   */
  queryTimeoutMs?: number;
}

/**
 * Build the pool every entry point of this adapter uses. Pools are created
 * inside the calling function, so importing a module connects to nothing
 * (AD-3), and a listener that accepts but never answers must not outlast the
 * budget — hence `query_timeout` as well as `connectionTimeoutMillis`.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const {
    databaseUrl,
    connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    queryTimeoutMs = connectTimeoutMs,
  } = options;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
    query_timeout: queryTimeoutMs,
    max: 1,
  });
  // An idle client that dies must not take the process down with it.
  pool.on('error', () => {});
  return pool;
}

/**
 * Describe a failure in one non-empty line, so a `DB_UNAVAILABLE` value always
 * carries something a human can read (Conventions: no silent failure). Node's
 * multi-address connect fails with an `AggregateError` whose own message is
 * empty, so fall back through the inner errors, then the code, then the name.
 */
export function describe(error: unknown): string {
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
