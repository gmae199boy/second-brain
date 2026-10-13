import type { IngestBatch } from '../domain/ingest-batch.js';
import type { Message } from '../domain/message.js';
import type {
  Session,
  SessionIngestSource,
  SessionStartSource,
} from '../domain/session.js';
import type { SessionKey, SessionToken } from '../domain/session-token.js';
import type { SchemaVersion } from '../domain/schema-version.js';
import type { ToolNote } from '../domain/tool-note.js';

/**
 * Health of the vector capability, reported with a neutral name: Core never
 * learns which extension provides it. Adapters map their own concept onto this.
 */
export interface StoreVectorHealth {
  /** Version the server offers, or `null` when it offers none. */
  available: string | null;
  /** Version installed in this database, or `null` when it is not installed. */
  installed: string | null;
}

/**
 * Result of a health probe. Expected failures are values, never exceptions
 * (see Conventions: Core returns coded values and reserves throwing for bugs).
 */
export type StoreHealth =
  | {
      ok: true;
      serverVersion: string;
      vector: StoreVectorHealth;
    }
  | {
      ok: false;
      code: 'DB_UNAVAILABLE';
      message: string;
    };

/**
 * The health capability of the persistence port, plus the teardown every store
 * needs. It is a port of its own so an adapter can offer it before it can offer
 * the rest: `createBrain` and `admin.doctor` ask for nothing more (AD-10).
 */
export interface HealthStore {
  /** Probe the store. Never throws: unreachable stores come back as `ok: false`. */
  checkHealth(): Promise<StoreHealth>;
  /** Release every resource the store holds. */
  close(): Promise<void>;
}

/** What `sessions.ensure` needs to create a session row (AD-12). */
export interface EnsureSessionInput {
  /**
   * The id to give a new row. The caller mints it, because ids belong to the
   * side that creates them (AD-8); an existing row keeps the id it already has,
   * so the store never needs an `IdGen`.
   */
  id: string;
  key: SessionKey;
  userId: string;
  machine: string;
  startedAt: Date;
  ingestSource: SessionIngestSource;
  startSource: SessionStartSource | null;
  /** Tags, computed once by the caller from the cwd (AD-12). */
  workspaceId: string | null;
  projectId: string | null;
  worktreeId: string | null;
}

/** Find-or-create, so a second call with another proposed id changes nothing. */
export type EnsureSessionResult =
  | { ok: true; created: boolean; session: Session }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/** How many rows a batch actually added. A replayed batch adds none (AD-8). */
export interface IngestCounts {
  messages: number;
  toolNotes: number;
}

/** Degraded-but-successful ingests carry a code, never silence (Conventions). */
export type StoreWarningCode = 'CURSOR_RESET';

export type IngestResult =
  | {
      ok: true;
      sessionId: string;
      inserted: IngestCounts;
      warnings: readonly StoreWarningCode[];
    }
  | {
      ok: false;
      code: 'SESSION_NOT_FOUND' | 'DB_UNAVAILABLE';
      message: string;
    };

/** Everything a session holds, in `seq` order. */
export interface SessionContents {
  session: Session;
  messages: readonly Message[];
  toolNotes: readonly ToolNote[];
}

export type ReadSessionResult =
  | ({ ok: true } & SessionContents)
  | {
      ok: false;
      code: 'SESSION_NOT_FOUND' | 'DB_UNAVAILABLE';
      message: string;
    };

/**
 * The session capability: the two writes of AD-14 that touch conversation data
 * and the read that widens a result back out. Only `sessions.ensure` creates a
 * session row, and every write is idempotent on the natural keys (AD-8).
 */
export interface SessionStore {
  /** Find-or-create the session row (AD-12). */
  ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult>;
  /** Append a batch and advance the cursor in one transaction (AD-7). */
  ingest(batch: IngestBatch): Promise<IngestResult>;
  /** Read a session by the token that crossed the process boundary (AD-8). */
  readSession(token: SessionToken): Promise<ReadSessionResult>;
}

/**
 * The persistence port: the sum of its capabilities. An adapter grows into it
 * one capability at a time, and the day it implements `SessionStore` it passes
 * the whole `Store` contract (AD-10).
 */
export type Store = HealthStore & SessionStore;

/**
 * Result of reading the single `schema_version` row. `version: null` means the
 * database answered but holds no version yet — an empty database, since the row
 * and its table arrive with the first migration. Unreachable is a value too, so
 * the write guard never has to catch (Conventions).
 */
export type ReadSchemaVersionResult =
  | { ok: true; version: SchemaVersion | null }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The schema-version capability of the persistence port. A capability of its
 * own, not part of `Store`, because two unrelated callers need exactly this and
 * nothing more: the write guard before every `writes` command (AD-20) and the
 * schema check of `admin doctor`. Folding it into `HealthStore` would change
 * the shape of the health probe every adapter already passes (AD-10).
 */
export interface SchemaStore {
  /** Read the stored version. Never throws: an unreachable store is `ok: false`. */
  readSchemaVersion(): Promise<ReadSchemaVersionResult>;
  /** Release every resource the store holds. */
  close(): Promise<void>;
}
