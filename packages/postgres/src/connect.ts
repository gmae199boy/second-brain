import { CONNECT_TIMEOUT_MS, BUSY_TIMEOUT_MS, type BusyTimeoutPath } from '@second-brain/core';
import pg from 'pg';
import type { Pool } from 'pg';

/** How this adapter is told to reach Postgres. Read by the caller, never here. */
export interface ConnectionOptions {
  /** Postgres connection URL. */
  databaseUrl: string;
  /**
   * Budget for connecting; also the default lock wait budget. Statement and
   * client query deadlines follow it with grace periods.
   */
  connectTimeoutMs?: number;
}

/** Default budget for connecting and waiting on a database lock. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;

/** `createPool` input: a connection plus how long one query may take. */
export interface CreatePoolOptions extends ConnectionOptions {
  path?: BusyTimeoutPath;
  /**
   * Server statement budget, extended past lockTimeoutMs when necessary.
   * The client deadline adds a grace period for the server error to arrive.
   * Defaults to one second past `connectTimeoutMs`; `0` means no limit, for
   * callers whose queries may legitimately block (a migration waiting on the
   * advisory lock) or run long (a statement that builds an index).
   */
  queryTimeoutMs?: number;
  lockTimeoutMs?: number;
  applicationName?: string;
}

/**
 * Build the pool every entry point of this adapter uses. Pools are created
 * inside the calling function, so importing a module connects to nothing
 * (AD-3), and a listener that accepts but never answers must not outlast the
 * budget — hence `query_timeout` as well as `connectionTimeoutMillis`.
 */
export function createPool(options: CreatePoolOptions): Pool {
  const budget = options.path === undefined ? undefined : BUSY_TIMEOUT_MS[options.path];
  const databaseUrl = options.databaseUrl;
  const connectTimeoutMs = options.connectTimeoutMs ?? (options.path === undefined ? undefined : CONNECT_TIMEOUT_MS[options.path]) ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const lockTimeoutMs = options.lockTimeoutMs ?? budget ?? connectTimeoutMs;
  const queryTimeoutMs = options.queryTimeoutMs ?? (budget === undefined ? lockTimeoutMs + 1000 : budget + 1000);
  const applicationName = options.applicationName ?? (options.path === undefined ? 'second-brain' : {
    turn: 'second-brain-hook', command: 'second-brain-command', drain: 'second-brain-drain',
  }[options.path]);

  // Let PostgreSQL report 55P03 before statement cancellation, and let either
  // server error arrive before the client abandons the response. Zero retains
  // the migration runner's unlimited statement/client deadline.
  const statementTimeoutMs = queryTimeoutMs === 0 ? 0 : Math.max(queryTimeoutMs, lockTimeoutMs + 1000);
  const clientTimeoutMs = statementTimeoutMs === 0 ? 0 : statementTimeoutMs + 1000;

  const pool = new pg.Pool({
    connectionString: databaseUrl,
    connectionTimeoutMillis: connectTimeoutMs,
    query_timeout: clientTimeoutMs,
    max: 1,
    options: `-c lock_timeout=${lockTimeoutMs} -c statement_timeout=${statementTimeoutMs} -c timezone=UTC`,
    application_name: applicationName,
    types: { getTypeParser(oid, format) {
      // Port timestamps are canonical strings; never mutate pg's process globals.
      if (oid === 1184 && format !== 'binary') return (value: string) => new Date(value).toISOString();
      if (oid === 20 && format !== 'binary') return Number;
      return pg.types.getTypeParser(oid, format);
    } },
  });
  // An idle client that dies must not take the process down with it.
  pool.on('error', () => {});
  // A checked-out client can emit a second socket error after its query rejects.
  // Query failures still propagate to databaseFailure; the event must not crash a hook.
  pool.on('connect', client => { client.on('error', () => {}); });
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

/** Raw SQL only; no adapter-owned model is exposed across the port. */
export type PgSchema = Record<string, never>;
export interface PgConnection { db: import('kysely').Kysely<PgSchema> }
export type PgConnect = () => { ok: true; connection: PgConnection } | { ok: false; message: string };

export function databaseFailure(error: unknown): { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string } {
  const code = (error as { code?: string } | null)?.code;
  return { ok: false, code: code === '55P03' || code === '40P01' ? 'DB_LOCKED' : 'DB_UNAVAILABLE', message: describe(error) };
}
