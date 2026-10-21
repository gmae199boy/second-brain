import type { Failure } from '../domain/failure.js';
import type { IngestBatch } from '../domain/ingest-batch.js';
import type { Message } from '../domain/message.js';
import type {
  ParserCursor,
  Session,
  SessionIngestSource,
  SessionStartSource,
} from '../domain/session.js';
import type { TranscriptFile } from '../domain/transcript-file.js';
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
 * the `cwd` of the first message that carries one (AD-12).
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
  /** Comparison key supplied by Core projectIdentityKey. */
  identityKey: string;
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
   * session whose cwd said nothing. Computed once by the caller from the cwd
   * of the first message that carries one, since a line may carry none.
   * A session already there ignores this input. Deferred identity work can
   * fill its tags separately only while both remain null (AD-12).
   */
  checkout: EnsureCheckoutInput | null;
  /** Opened atomically only by the call creating the session. */
  identityWork: AddWorkInput | null;
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

/**
 * Everything a session holds. The messages are in conversation order, which is
 * `occurredAt` ascending; two messages at the same instant come back in no
 * defined order (AD-8, migration 0006). A tool note follows its message's
 * instant, then its message, then its own `ordinal` — so one message's notes
 * stay together even when two messages share an instant — and a note whose
 * message is not stored comes last rather than disappearing.
 */
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

export interface FillSessionTagsInput {
  key: SessionKey;
  checkout: EnsureCheckoutInput;
}

export type FillSessionTagsResult =
  | { ok: true; filled: boolean; session: Session }
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * The session capability: the two writes of AD-14 that touch conversation data
 * and the reads that widen a result back out. Only `sessions.ensure` creates a
 * session row, and every write is idempotent on the natural keys (AD-8).
 */
export interface SessionStore {
  /** Fill only when both tags are null; never creates rows for an already tagged session. */
  fillSessionTags(input: FillSessionTagsInput): Promise<FillSessionTagsResult>;
  /**
   * Find-or-create the session row, and with it the project and worktree its
   * checkout names (AD-12).
   *
   * Existing sessions are untouched and create no checkout or work rows.
   * New sessions find projects by the caller's identityKey and worktrees by
   * (project, path), keeping the first display identity. The session, checkout
   * and optional identityWork are committed together.
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
   *   * `startSource` is written only when the batch carries one **and** the
   *     session has none yet. A read that saw no `SessionStart` attachment
   *     knows nothing about the start, and a `null` must not erase what an
   *     earlier read did know; the first answer a read did find is the one that
   *     says why the session began, so a later batch never overwrites it.
   *   * the cursor moves forward, and backwards only for the read that still
   *     stands where it started. A batch that did not reset replaces the cursor
   *     when the session has no cursor message stored or when the new cursor
   *     message was uttered at or after the stored one — so two hooks that
   *     overlap, the older one arriving last, cannot wind the session back to a
   *     message the newer one had already passed. A batch that *did* reset read
   *     a transcript whose front had changed, so its cursor is the only one that
   *     still describes the file and may well point further back: it is taken
   *     whole — `null` included, which clears the cursor — but only while the
   *     session's cursor is still the `cursorBase` that read began from. A reset
   *     batch that finds the session somewhere else is an overlapping read
   *     whose answer is already stale, and it falls back to the forward-only
   *     rule (Design Notes, story 21).
   *   * `cursorReset` surfaces as the `CURSOR_RESET` warning, never silently —
   *     including for a batch that carries no message at all, which is what a
   *     transcript rewritten down to nothing looks like.
   *
   * And one rule about the text itself:
   *
   *   * the body and the tool note target go in as the batch carries them,
   *     character for character. Ingest writes no `redactions` row at all:
   *     secrets are masked where text leaves Brain, in Core's output codecs
   *     (`output/codecs.ts`), and the only thing that ever rewrites a stored
   *     body is `messages.redact` (마스킹 B, AD-11).
   */
  ingest(batch: IngestBatch): Promise<IngestResult>;
  /**
   * Read a session by the token that crossed the process boundary (AD-8).
   *
   * What comes back is the stored text, unmasked — the store never masks
   * anything (마스킹 B). Whoever answers somebody with this result runs
   * `sessionForOutput` over it first (`output/mask.ts`): the tool note target
   * carries the shell `NAME=value` rule and the truncated tail, and a codec
   * walking the finished answer can no longer tell which string came from that
   * column. The codec then masks every string of what is left (AD-11).
   */
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
 * this occurrence's, so the row says when the cause was last met. Since 0005
 * they also raise `occurrences` by one and leave `firstOccurredAt` where the
 * first record put it, so the row says when it started as well (Decision 2,
 * 2026-10-19 사용자, Table Contract).
 */
export type RecordFailureResult =
  | { ok: true; outcome: 'recorded'; created: boolean; failureId: string }
  | { ok: true; outcome: 'lost' }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/** What has to be done something to: the target half of the queue key (AD-21). */
export interface WorkTarget {
  targetKind: string;
  targetId: string;
}

/**
 * The targets of every open item of one kind, as a lock-free read.
 *
 * It exists for the transcript scan, which has to leave alone the sessions
 * somebody has already queued: a scan that enqueued them again would add
 * nothing — `addWork` is find-or-create — but it would take the write lock to
 * find that out, every drain, for every session waiting in the backlog (Design
 * Notes). Only `DB_UNAVAILABLE`, because a read does not wait for the writer.
 */
export type ListOpenWorkTargetsResult =
  | { ok: true; targets: readonly WorkTarget[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/** Which failures to read back. Every field narrows; all of them are optional. */
export interface ListFailuresQuery {
  /** Only this kind of target — `session` for a collection failure (AD-12). */
  targetKind?: string;
  /** Only this step: for a work item, the kind of work. */
  stage?: string;
  /**
   * Include the rows somebody has already fixed. Left out, only the unresolved
   * ones: a record with `resolved_at` set is history, and the question `brain
   * failures list` answers is "what is still wrong" (Boundaries).
   */
  includeResolved?: boolean;
  /** At most this many rows. Left out, the store answers with every match. */
  limit?: number;
}

/**
 * The failures one query names, newest first (`occurred_at desc, id desc`).
 *
 * Newest first because the instant on the row is when the cause was last met
 * (Table Contract), and the id breaks the tie: two rows recorded in the same
 * millisecond would otherwise come back in whatever order the storage felt
 * like, and a list that reorders itself between two calls cannot be paged.
 */
export type ListFailuresResult =
  | { ok: true; failures: readonly Failure[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/** Which failures one piece of work that finally went through has settled. */
export interface ResolveFailuresInput {
  targetKind: string;
  targetId: string;
  stage: string;
  /** When it was fixed, read once from `Clock` (AD-13). */
  now: Date;
}

/**
 * How many rows were closed. Zero is the ordinary answer and not a failure: a
 * piece of work that succeeded on its first attempt never recorded anything,
 * and the handler calls this either way rather than asking first.
 */
export type ResolveFailuresResult =
  | { ok: true; resolved: number }
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
  /** The targets of the open items of one kind. A read (AD-7). */
  listOpenWorkTargets(query: { kind: string }): Promise<ListOpenWorkTargetsResult>;
  /** The recorded failures, newest first. A read (AD-7). */
  listFailures(query: ListFailuresQuery): Promise<ListFailuresResult>;
  /**
   * Close the open failures of one target and stage, because the work finally
   * went through (Table Contract).
   *
   * Only the open ones: a row somebody already resolved keeps the instant it
   * was resolved at, so a second success does not rewrite history.
   */
  resolveFailures(input: ResolveFailuresInput): Promise<ResolveFailuresResult>;
}

/** Which harness's transcript history to read. */
export interface ListTranscriptFilesQuery {
  harness: string;
}

export type ListTranscriptFilesResult =
  | { ok: true; files: readonly TranscriptFile[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/** What one successful read of a transcript leaves behind (Table Contract). */
export interface RecordTranscriptFileInput {
  /**
   * The id to give a new row. The caller mints it (AD-8); a row that is already
   * there keeps the id it has, and the proposal is dropped.
   */
  id: string;
  /** Key together with `path`. */
  harness: string;
  path: string;
  /** How many bytes this read saw, and the fingerprint of exactly those bytes. */
  sizeBytes: number;
  fingerprint: string;
  /** How far the file has been read, from the parse (AD-4). */
  cursor: ParserCursor | null;
  scannedAt: Date;
  /**
   * This parse read the file from the front because the cursor was lost — a
   * compact, a fork, a transcript rewritten underneath us (`cursorReset`).
   *
   * It is the one case in which the size may go backwards: a compacted
   * transcript is genuinely smaller than it was, and a store that kept the old
   * number would call that file "unchanged" for ever (Boundaries).
   */
  reset: boolean;
}

export type RecordTranscriptFileResult =
  | { ok: true; file: TranscriptFile }
  | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * The transcript-history capability: what has already been read out of which
 * file, so the drain's folder scan opens only what changed (AD-7, AD-21).
 *
 * It is a capability of its own because two unrelated callers need exactly
 * these two verbs: the scan, which compares a folder listing against the rows,
 * and `sessions.ingest`, which records what it read. The second of those is why
 * every successful ingest writes here and not only the scan — a hook that
 * ingests a live session every turn has to move the history forward too, or the
 * next scan would read the whole file again as "grown" (Decision 2, 2026-10-19).
 */
export interface TranscriptFileStore {
  /** The history of one harness's files. A read, so it takes no lock (AD-7). */
  listTranscriptFiles(query: ListTranscriptFilesQuery): Promise<ListTranscriptFilesResult>;
  /**
   * Record what a read saw, as find-or-create on `(harness, path)`.
   *
   * Two rules, and every adapter keeps them:
   *
   *   * the size only moves forward. A smaller size is dropped and the stored
   *     row is handed back unchanged, because two reads of a growing file can
   *     finish out of order and the older one must not wind the history back.
   *   * unless `reset`, which is the one case where a smaller file is the truth.
   *
   * The cursor moves with the size: they are one fact about one read, and a
   * cursor from a read whose size was dropped would point into bytes the row
   * does not claim to have seen.
   */
  recordTranscriptFile(input: RecordTranscriptFileInput): Promise<RecordTranscriptFileResult>;
}

/**
 * The persistence port: the sum of its capabilities. An adapter grows into it
 * one capability at a time, and the day it implements `SessionStore` it passes
 * the whole `Store` contract (AD-10).
 */
export type Store = HealthStore &
  SessionStore &
  UserStore &
  WorkStore &
  TranscriptFileStore;

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
