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
import type { WorkItem } from '../domain/work-item.js';

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

/**
 * The checkout a new session is tagged with, worked out once by the caller from
 * the first message's `cwd` (AD-12).
 *
 * The two ids are *proposals*, in the sense `EnsureSessionInput.id` is: ids
 * belong to the side that creates the row (AD-8), so the caller mints one for
 * the project and one for the worktree before it knows whether either row
 * exists. A store that finds the identity already there keeps the id it has and
 * drops the proposal.
 */
export interface EnsureCheckoutInput {
  /** The id to give the `projects` row, if this call is the one creating it. */
  projectId: string;
  /** `host/owner/repo`, or the git common directory (`normalizeRemoteIdentity`). */
  remoteIdentity: string;
  /** The id to give the `worktrees` row, if this call is the one creating it. */
  worktreeId: string;
  /** The absolute path of the top of the working folder. Key with the project. */
  worktreePath: string;
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
  /**
   * Reserved: slice 1 never groups projects, so this is always `null` and no
   * verb fills it (AD-12).
   */
  workspaceId: string | null;
  /**
   * The project and worktree to tag a *new* session with, or `null` for a
   * session whose cwd said nothing. Computed once by the caller from the first
   * message's cwd, and never again: a session that is already there keeps the
   * tags it was created with, whatever this call carries (AD-12).
   */
  checkout: EnsureCheckoutInput | null;
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
  /**
   * Masking records written with the messages of this batch. Only the records
   * of messages that actually went in are counted, so a replay reports 0 (AD-11).
   */
  redactions: number;
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
  /**
   * Find-or-create the session row, and with it the project and worktree its
   * checkout names (AD-12).
   *
   * Three rules about the tags, and every adapter keeps them:
   *
   *   * the session is looked for first. A key that is already stored comes
   *     back untouched and nothing else is written — not even a project row
   *     for the checkout this call carried, because a row nothing points at is
   *     a row nobody will ever find again.
   *   * otherwise the project is found-or-created on `remoteIdentity` and the
   *     worktree on `(project_id, path)`. An identity or a path that is already
   *     there keeps the id it has, and the proposal is dropped.
   *   * all of it lands in one transaction with the session, so a session is
   *     never tagged with a project that is not in the database and a project
   *     is never created for a session that was not.
   *
   * `removed_at` is not this verb's: a worktree whose folder is gone is marked
   * by drain, and `ensureSession` never changes a project or worktree row.
   */
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
   *
   * And one rule about the masking records a message carries:
   *
   *   * a message's `redactions` go in only when *that* message went in on
   *     *this* call, and in the same transaction as it. A message the session
   *     already holds came back with a fresh set of ids from a fresh parse, and
   *     writing those would record the same masking a second time — or point a
   *     foreign key at a message id no row carries. They are dropped instead,
   *     and `inserted.redactions` counts only what was written (AD-11).
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

/** What `addWork` needs to put one piece of work on the queue (AD-21). */
export interface AddWorkInput {
  /**
   * The id to give a new row. The caller mints it (AD-8); an open row that is
   * already there keeps the id it has, and the proposal is dropped.
   */
  id: string;
  /** What has to be done. A Core constant of the unit that does it. */
  kind: string;
  /** Together with `targetId` and `kind`, the open-row key. */
  targetKind: string;
  targetId: string;
  createdAt: Date;
  /** Not before this instant. A fresh row is usually due at once (AD-13). */
  nextAttemptAt: Date;
}

/**
 * Find-or-create on the open-row key `(kind, target_kind, target_id)`, so a
 * second call changes nothing and `created` says which call was the first.
 *
 * `created: false` is the ordinary answer and not a failure: two hooks that both
 * noticed the same session needs re-ingesting have both done their job, and the
 * queue holds one item (AD-21). A row that was *completed* is not in the key, so
 * the same work asked for again after it finished is a new row — which is what
 * `failures retry` depends on.
 */
export type AddWorkResult =
  | { ok: true; created: boolean; item: WorkItem }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/** What `hasDueWork` and `claimWork` both ask about. */
export interface DueWorkQuery {
  /** The instant "due" is measured against, read once from `Clock` (AD-13). */
  now: Date;
  /**
   * The kinds this build can actually do, which is the kinds it has a handler
   * for. An item of any other kind is left alone rather than claimed or closed:
   * a new build's work must survive an old build's drain (Decision 4,
   * 2026-10-19). An empty list matches nothing.
   */
  kinds: readonly string[];
}

/**
 * Whether anything is due, as a lock-free read.
 *
 * It exists so that a drain with nothing to do never takes the write lock
 * (AD-7): the opportunistic run at the end of every command would otherwise
 * queue behind whatever is writing, for nothing. Only `DB_UNAVAILABLE`, because
 * a read does not wait for the writer.
 */
export type HasDueWorkResult =
  | { ok: true; due: boolean }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export interface ClaimWorkInput extends DueWorkQuery {
  /** The id of this drain run. Every finishing verb is checked against it. */
  claimedBy: string;
}

/**
 * The item this run now holds, or `null` when there was nothing to take.
 *
 * `null` covers both "the queue is empty" and "somebody else got there first",
 * and the two need not be told apart: either way this run has no item, and
 * losing a race is not a failure (AD-21).
 */
export type ClaimWorkResult =
  | { ok: true; item: WorkItem | null }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/** Which claim a finishing verb is speaking for (Design Notes). */
export interface FinishWorkInput {
  id: string;
  /** The `claimedBy` this run claimed with. A row holding another is `lost`. */
  claimedBy: string;
}

export interface CompleteWorkInput extends FinishWorkInput {
  /** When it finished, read once from `Clock` (AD-13). */
  now: Date;
}

export interface RetryWorkInput extends FinishWorkInput {
  /** When the next attempt may start. Decided by the retry policy (AD-21). */
  nextAttemptAt: Date;
  /** Already through `failureText`: masked and inside the byte limit (AD-11). */
  lastError: string;
}

/**
 * What a finishing verb did: changed the row, or found the claim was not ours.
 *
 * `lost` is the compare-and-set saying no. The claim had expired and another
 * worker took the row, so this one's late answer must not overwrite the new
 * worker's state — otherwise "processed exactly once" and "a worker that lost
 * its claim does not raise the count" would both break (Design Notes).
 */
export type WorkFinishOutcome = 'done' | 'lost';

export type FinishWorkResult =
  | { ok: true; outcome: WorkFinishOutcome }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/** What the one failure-recording function writes (AD-21, Table Contract). */
export interface RecordFailureInput {
  /** The id to give a new row. The caller mints it (AD-8). */
  id: string;
  /** The key, together with `targetId`, `stage` and `fingerprint`. */
  targetKind: string;
  targetId: string;
  stage: string;
  fingerprint: string;
  /** Information, both nullable: not every failure is about a session (AD-12). */
  harness: string | null;
  sessionId: string | null;
  code: string;
  /** Already through `failureText`: masked and inside the byte limit (AD-11). */
  message: string;
  occurredAt: Date;
  /**
   * Close this work item in the same transaction as the record (AD-21).
   *
   * The two belong together: an item closed without its record is work that
   * stopped with nothing to show, and a record without the item closed is a
   * problem reported about work that is still being retried. When the claim is
   * not ours the whole call is `lost` and *no* failure row is written either —
   * the new worker owns the outcome of this item now.
   */
  closeWork?: CompleteWorkInput;
}

/**
 * What the record came to.
 *
 * `created` tells a reopened row from a new one: the same cause met a hundred
 * times is one row. The second through hundredth keep the row's id, open it
 * again (`resolved_at` cleared) and replace `occurred_at` and `message` with
 * this occurrence's, so the row says when the cause was last met. When it was
 * first met and how often arrive with migration 0005 (Decision 2, 2026-10-19
 * 사용자, Table Contract).
 */
export type RecordFailureResult =
  | { ok: true; outcome: 'recorded'; created: boolean; failureId: string }
  | { ok: true; outcome: 'lost' }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * The queue capability: the one backlog of AD-21, and the one place a failure is
 * recorded.
 *
 * Six verbs and one shape of promise. Adding is find-or-create on the open-row
 * key. Claiming raises `attempts` inside the same transaction that takes the
 * row, so an item that killed its worker still counted once. Every verb that
 * finishes an item — completing, retrying, releasing, recording — changes the row
 * only when the claim is still ours, and answers `lost` when it is not.
 *
 * `recordFailure` is in here and not in a capability of its own because the two
 * are one transaction: the last attempt of an item writes the record and closes
 * the item together or does neither.
 */
export interface WorkStore {
  /** Put one piece of work on the queue, once (AD-21). */
  addWork(input: AddWorkInput): Promise<AddWorkResult>;
  /** Is anything due? A read, so it never takes the write lock (AD-7). */
  hasDueWork(query: DueWorkQuery): Promise<HasDueWorkResult>;
  /**
   * Take one due item, least attempted first, and raise its `attempts`.
   *
   * One transaction: the row is chosen and marked in the same `BEGIN IMMEDIATE`,
   * because two drains that read first and wrote second would both take the
   * same row. The order is `(attempts, id)`, so one poisonous item cannot starve
   * the backlog behind it, and the index of 0004 is shaped for exactly that
   * query.
   */
  claimWork(input: ClaimWorkInput): Promise<ClaimWorkResult>;
  /** Done: stamp `completed_at` and clear the claim (AD-21). */
  completeWork(input: CompleteWorkInput): Promise<FinishWorkResult>;
  /**
   * Not done, and worth another attempt: move `next_attempt_at`, keep the
   * sentence, clear the claim. `attempts` is left where the claim put it.
   */
  retryWork(input: RetryWorkInput): Promise<FinishWorkResult>;
  /**
   * Hand the item back as though it had never been claimed: `attempts - 1` and
   * the claim cleared, with `next_attempt_at` untouched.
   *
   * It is what happens when the database could not be written to, which is not
   * a failure of the item (AD-21): nothing was tried, so nothing was attempted.
   */
  releaseWork(input: FinishWorkInput): Promise<FinishWorkResult>;
  /**
   * Record one failure, and optionally close the item it was about, in one
   * transaction (AD-21).
   *
   * The same key met again is the same row, open again and carrying the latest
   * instant and sentence, so a recurring problem is one row rather than a
   * hundred (Table Contract).
   */
  recordFailure(input: RecordFailureInput): Promise<RecordFailureResult>;
}

/**
 * The persistence port: the sum of its capabilities. An adapter grows into it
 * one capability at a time, and the day it implements `SessionStore` it passes
 * the whole `Store` contract (AD-10).
 */
export type Store = HealthStore & SessionStore & UserStore & WorkStore;

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
