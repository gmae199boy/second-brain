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
import type { User } from '../domain/user.js';

/**
 * One capability an adapter checked on its own source, under a name Core never
 * interprets. A SQLite source answers for WAL, FTS5 and foreign keys; a
 * Postgres one answers for its vector extension. Core only passes the list on,
 * which is why the probes are a list and not a field per capability: adding a
 * capability to an adapter must not change the shape every adapter implements.
 */
export interface StoreProbe {
  /** Stable, neutral identifier, unique within one health report. */
  id: string;
  ok: boolean;
  /**
   * The probe passed without settling its question, so a report shows it as a
   * `warn` rather than a pass (Conventions). Only an adapter can tell the two
   * apart — a write probe that gave up on somebody else's lock found nothing
   * wrong with the file, and calling that `ok` would hide that it never
   * actually wrote. Meaningful only when `ok` is true, and a probe that sets it
   * must say why in `detail`.
   */
  warn?: boolean;
  /** What was found, or why it failed. Present whenever there is anything to say. */
  detail?: string;
}

/**
 * Where the source lives and what it can do. `location` is for a human reading
 * a doctor report — the file, or the host and database — and never carries a
 * secret, because it is printed.
 */
export interface StoreSourceHealth {
  location: string;
  probes: readonly StoreProbe[];
}

/**
 * Result of a health probe. Expected failures are values, never exceptions
 * (see Conventions: Core returns coded values and reserves throwing for bugs).
 */
export type StoreHealth =
  | {
      ok: true;
      serverVersion: string;
      source: StoreSourceHealth;
    }
  | {
      ok: false;
      code: 'DB_UNAVAILABLE';
      message: string;
    };

/**
 * The health capability of the persistence port, plus the teardown every store
 * needs. It is a port of its own so an adapter can offer it before it can offer
 * the rest: `createBrain` and `doctor.run` ask for nothing more (AD-10).
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

/**
 * Find-or-create, so a second call with another proposed id changes nothing.
 *
 * `DB_LOCKED` is in here because this is a write: SQLite has one writer per
 * database, so a hook that arrives while another one is committing waits out
 * its budget and then says so (AD-7). Epic 2's spool is what turns that into a
 * retry; until then it is a failure the caller reports.
 */
export type EnsureSessionResult =
  | { ok: true; created: boolean; session: Session }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

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
      code: 'SESSION_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED';
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
 * The session row for one key, or `null` for a key no session has. `null` is a
 * value and not a failure: a session nobody has ingested yet is the normal
 * state of a session's first seconds.
 */
export type FindSessionResult =
  | { ok: true; session: Session | null }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The session capability: the two writes of AD-14 that touch conversation data
 * and the reads that widen a result back out. Only `sessions.ensure` creates a
 * session row, and every write is idempotent on the natural keys (AD-8).
 */
export interface SessionStore {
  /** Find-or-create the session row (AD-12). */
  ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult>;
  /**
   * The session row alone, with none of its conversation.
   *
   * It is a verb of its own because `sessions.ingest` needs exactly this and
   * nothing more: the stored cursor, before it reads the transcript, so the
   * parser can start where the last read stopped (AD-4). `readSession` would
   * answer the same question by loading every message and tool note of the
   * session, which is the whole of what the incremental read exists to avoid.
   */
  findSession(key: SessionKey): Promise<FindSessionResult>;
  /**
   * Append a batch and advance the tracking columns in one transaction (AD-7).
   *
   * Three rules about the tracking the batch carries, and every adapter keeps
   * them:
   *
   *   * `startSource` is written only when the batch carries one. A read that
   *     saw no `SessionStart` attachment knows nothing about the start, and a
   *     `null` must not erase what an earlier read did know.
   *   * the cursor only moves forward. It is replaced when the batch reset it,
   *     or when the session has no cursor message stored, or when the new
   *     cursor message is at or after the stored one in `seq` — so two hooks
   *     that overlap, the older one arriving last, cannot wind the session back
   *     to a message the newer one had already passed.
   *   * `cursorReset` surfaces as the `CURSOR_RESET` warning, never silently.
   */
  ingest(batch: IngestBatch): Promise<IngestResult>;
  /** Read a session by the token that crossed the process boundary (AD-8). */
  readSession(token: SessionToken): Promise<ReadSessionResult>;
}

/** What `ensureSelfUser` needs to create the owner's row (AD-12). */
export interface EnsureSelfUserInput {
  /**
   * The id to give a new row. The caller mints it (AD-8); a row that is
   * already there keeps the id it has, which is what makes a brain copied to
   * another machine keep its owner.
   */
  id: string;
  /** The operating system user name. Never used to update an existing row. */
  name: string;
  createdAt: Date;
}

/**
 * Find-or-create the owner. `created` is false for every call after the first,
 * whatever id or name it proposed: the owner is decided once, by the install
 * that made the database (AD-12).
 */
export type EnsureSelfUserResult =
  | { ok: true; created: boolean; user: User }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * The owner, or `null` for a database that has none yet — a version 3 schema
 * whose install step never ran. `null` is a value and not a failure, because
 * the caller's next move is to say `USER_MISSING` and name the command that
 * fixes it, not to catch anything.
 */
export type ReadSelfUserResult =
  | { ok: true; user: User | null }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The identity capability: who this brain belongs to. It is a capability of
 * its own because two unrelated callers need exactly this and nothing more —
 * the installer, which creates the row, and `sessions.ingest`, which reads it
 * to fill `sessions.user_id` (AD-12).
 */
export interface UserStore {
  /** Find-or-create the one `is_self` row. Never creates a second (AD-12). */
  ensureSelfUser(input: EnsureSelfUserInput): Promise<EnsureSelfUserResult>;
  /** The owner, or `null` when the install step has not run here. */
  readSelfUser(): Promise<ReadSelfUserResult>;
}

/**
 * The persistence port: the sum of its capabilities. An adapter grows into it
 * one capability at a time, and the day it implements `SessionStore` it passes
 * the whole `Store` contract (AD-10).
 */
export type Store = HealthStore & SessionStore & UserStore;

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
 * schema check of `doctor run`. Folding it into `HealthStore` would change
 * the shape of the health probe every adapter already passes (AD-10).
 */
export interface SchemaStore {
  /** Read the stored version. Never throws: an unreachable store is `ok: false`. */
  readSchemaVersion(): Promise<ReadSchemaVersionResult>;
  /** Release every resource the store holds. */
  close(): Promise<void>;
}
