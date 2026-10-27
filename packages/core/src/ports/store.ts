import type { IngestAttachment } from '../domain/ingest-batch.js';
import type { ChunkLocator } from '../domain/chunk-locator.js';
import type {
  DocumentChunk,
  DocumentExtraction,
  DocumentExtractionFailedStage,
} from '../domain/document.js';
import type { FileLocation } from '../domain/file.js';
import type { RedactionCurrent, RedactionPlan, RedactionRefusal } from '../domain/redact-plan.js';
import type { Redaction } from '../domain/redaction.js';
import type { Failure } from '../domain/failure.js';
import type { IngestBatch } from '../domain/ingest-batch.js';
import type { Message } from '../domain/message.js';
import type {
  TagSource,
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
 * the session start folder, falling back to the first message cwd (AD-12).
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
   * at session start, falling back to the first message that carries one.
   * A session already there ignores this input. Deferred identity work can
   * fill its tags separately only while both remain null (AD-12).
   */
  checkout: EnsureCheckoutInput | null;
  /** First transcript cwd; written once, including when no tag can be assigned. */
  firstCwd: string | null;
  tagSource: TagSource | null;
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
  checkout: EnsureCheckoutInput | null;
  /** First transcript cwd; written once, including when no tag can be assigned. */
  firstCwd: string | null;
  tagSource: TagSource | null;
}

export type FillSessionTagsResult =
  | { ok: true; filled: boolean; session: Session }
  | { ok: false; code: 'SESSION_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * The session capability: the two writes of AD-14 that touch conversation data
 * and the reads that widen a result back out. Only `sessions.ensure` creates a
 * session row, and every write is idempotent on the natural keys (AD-8).
 */
export interface RedactMessageInput {
  messageId: string;
  /** Synchronous pure callback, run on current text inside the write transaction. */
  plan(current: RedactionCurrent): RedactionPlan | RedactionRefusal;
}
export type RedactMessageResult =
  | {
      ok: true;
      sessionId: string;
      bodySpans: number;
      toolNoteSpans: number;
      toolNotesChanged: number;
      chunksRemoved: number;
      /**
       * How many attachments of this message are stored files nobody has
       * masked: `status = 'stored'` and the file's `redacted_at` still null,
       * counted in the same transaction as the masking.
       *
       * It is counted here and not by the caller because it is one answer about
       * one instant: a count read afterwards could be about a file somebody
       * masked in between. Above zero, the caller says
       * `ATTACHMENT_NOT_REDACTED` — taking a secret out of a message says
       * nothing about the bytes that message carried (마스킹 B).
       */
      unredactedAttachments: number;
    }
  | { ok: false; code: 'REDACT_TEXT_NOT_FOUND' | 'MESSAGE_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

export type ListIdentityCandidatesResult =
  | { ok: true; sessions: readonly Session[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };
export type CountUntaggedSessionsResult =
  | { ok: true; count: number }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export interface ListStaleSessionsQuery {
  harness: string;
  parserVersion: string;
}
export type ListStaleSessionsResult =
  | { ok: true; sessions: readonly { harnessSessionId: string }[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export interface SessionStore {
  /**
   * The sessions of one harness whose `parser_version` is null or not the given
   * one: what the folder scan queues to be read again however unchanged their
   * files are (AD-4). A read, so it takes no lock (AD-7).
   */
  listStaleSessions(query: ListStaleSessionsQuery): Promise<ListStaleSessionsResult>;
  /** Read without a write lock; excludes any prior identity work, even closed. */
  listIdentityCandidates(): Promise<ListIdentityCandidatesResult>;
  countUntaggedSessions(): Promise<CountUntaggedSessionsResult>;
  redactMessage(input: RedactMessageInput): Promise<RedactMessageResult>;
  /** Fill firstCwd only from null; fill tags and their source together only from null. */
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
  /**
   * When the read of the transcript began — not when it was recorded. It is
   * what tells a later read of a shrunk file from an older read finishing late.
   */
  scannedAt: Date;
  /**
   * This parse read the file from the front because the cursor was lost — a
   * compact, a fork, a transcript rewritten underneath us (`cursorReset`).
   *
   * A smaller size is then taken whenever the read began: a compacted
   * transcript is genuinely smaller than it was.
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
   * A smaller size is taken only when `reset`, or when `scannedAt` is strictly
   * later than the stored one. A smaller read that began earlier or at the same
   * instant is an older read finishing late, and the stored row is handed back
   * unchanged; a smaller read that began later is a file that really shrank,
   * and keeping the old size would queue it on every scan (P19).
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
  ScheduleStore &
  TranscriptFileStore & AttachmentStore & ExtractionStore;

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

export interface MessageAttachment {
  id: string;
  ordinal: number;
  sourceKind: string;
  sourceRef: string | null;
  displayName: string | null;
  status: 'stored' | 'missing_at_ingest' | null;
  file: { id: string; contentHash: string; sizeBytes: number; home: FileLocation | null; locations: readonly FileLocation[] } | null;
}
export interface LinkAttachmentsInput { key: SessionKey; attachments: readonly IngestAttachment[]; linkedAt: Date }
export type LinkAttachmentsResult = { ok: true; linked: number } | { ok: false; code: 'SESSION_NOT_FOUND' | 'MESSAGE_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export type ListMessageAttachmentsResult = { ok: true; attachments: readonly MessageAttachment[] } | { ok: false; code: 'DB_UNAVAILABLE'; message: string };
export interface MissingFileName {
  fileId: string;
  nameSource: 'attachment_name' | 'location_path';
  text: string;
}
export interface FileName extends MissingFileName { id: string }
export type ListMissingFileNamesResult = { ok: true; names: readonly MissingFileName[] } | { ok: false; code: 'DB_UNAVAILABLE'; message: string };
export type ListFileNamesResult = { ok: true; names: readonly FileName[] } | { ok: false; code: 'DB_UNAVAILABLE'; message: string };
export type WriteFileNamesResult = { ok: true; inserted: number } | { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * One `file_locations` row as a place in its own right, with the id (AD-23).
 *
 * `MessageAttachment.file.locations` says where a file's bytes are, which is
 * what a reader of a conversation wants. This is the row: the id, because a
 * piece of work about one place has to name it, and `deletedAt`, because a
 * place whose bytes are gone is still a record that they were once there.
 */
export interface FileLocationRow {
  id: string;
  fileId: string;
  storeKind: 'local' | 'drive';
  locator: string;
  ownership: 'brain' | 'external';
  /** When the bytes at this place were deleted, filled in once (0002). */
  deletedAt: Date | null;
}

/**
 * One place by its id, as a lock-free read.
 *
 * `FILE_LOCATION_NOT_FOUND` and not `null`, because `file_locations` rows are
 * never deleted (0002): an id nothing answers to is a caller that made one up,
 * and the handler records that rather than treating it as ordinary.
 */
export type ReadFileLocationResult =
  | { ok: true; location: FileLocationRow }
  | { ok: false; code: 'FILE_LOCATION_NOT_FOUND' | 'DB_UNAVAILABLE'; message: string };

/**
 * Every place one file's bytes are or were, by `ownership` then `locator` —
 * Brain's own copy first, which is the one that may be deleted.
 *
 * A file nothing knows about answers with an empty list rather than a code: the
 * question is "where is this", and "nowhere" is an answer to it.
 */
export type ListFileLocationsResult =
  | { ok: true; locations: readonly FileLocationRow[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export interface MarkFileLocationDeletedInput {
  id: string;
  /** When the bytes went, read once from `Clock` (AD-13). */
  deletedAt: Date;
}

/**
 * The instant the row now carries, and whether this call is the one that put it
 * there.
 *
 * It is a one-way fill, as the trigger of 0002 has it: the first call writes the
 * instant and answers `marked: true`, and every later one leaves it alone and
 * hands back the stored value with `marked: false`. Overwriting it would let a
 * second piece of work claim a deletion the first one did, and the record of
 * when the bytes actually went is the only thing an orphan sweep can go by.
 *
 * `ownership` is deliberately not looked at: refusing a user's own file is the
 * handler's decision and not the store's, so the store stays a store.
 */
export type MarkFileLocationDeletedResult =
  | { ok: true; deletedAt: Date; marked: boolean }
  | {
      ok: false;
      code: 'FILE_LOCATION_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED';
      message: string;
    };

/**
 * Which file a caller means: the row id, or the content hash a person can work
 * out from the original bytes with `shasum -a 256` (`files.redact`).
 *
 * Two spellings because masking a file is by content: the hash is the honest
 * name for it, and the id is what a row of a report carries.
 */
export type FileRef = { fileId: string } | { contentHash: string };

/**
 * One file and how many messages share it, as a lock-free read.
 *
 * It is one read and not two because it answers one question — "what would
 * masking this file take away from whom" — and a confirmation message built
 * from two reads could name a count that was already stale.
 */
export type ReadFileSharingResult =
  | {
      ok: true;
      file: { id: string; contentHash: string; redactedAt: Date | null };
      /** Distinct `message_attachments.message_id` rows pointing at this file. */
      messages: number;
    }
  | { ok: false; code: 'FILE_NOT_FOUND' | 'DB_UNAVAILABLE'; message: string };

/**
 * Which of the given content hashes belong to a file somebody has masked, as a
 * lock-free read.
 *
 * It exists for the collection path: the file store is content addressed, so
 * the same bytes collected again would write the blob a masking deleted back to
 * the very locator whose row says the bytes are gone (`sessions/ingest.ts`). An
 * empty list of hashes is an empty answer and opens nothing.
 */
export type ListRedactedContentHashesResult =
  | { ok: true; hashes: readonly string[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/** What one file's masking is planned against, inside the write transaction. */
export interface RedactFileCurrent {
  file: { id: string; contentHash: string; redactedAt: Date | null };
  /** Every place this file's bytes are or were, as the rows say (AD-23). */
  locations: readonly FileLocationRow[];
}

/**
 * What a masking of one file comes to: the record to write, or `null` for a
 * file that is already masked, and the work to open.
 *
 * The work is opened either way. A file that was masked and still has a Brain
 * copy on the disk — an item that was never worked, a deletion that failed — is
 * repaired by asking again, and `addWork` is find-or-create on the open-row key
 * so asking twice costs one row (AD-21).
 */
export interface RedactFilePlan {
  redaction: Redaction | null;
  work: readonly AddWorkInput[];
}

export interface RedactFileInput {
  fileId: string;
  /** Synchronous pure callback, run inside the write transaction. */
  plan(current: RedactFileCurrent): RedactFilePlan;
}

/**
 * What one file's masking removed, and what it left to do.
 *
 * `alreadyRedacted` is the ordinary second answer and not a failure: the file's
 * text was taken away by the first call, and this one has done the only thing
 * left — put whatever Brain copies are still on the disk back on the queue.
 * Every count is then zero.
 */
export type RedactFileResult =
  | {
      ok: true;
      fileId: string;
      contentHash: string;
      /** How many messages shared this file's content (`readFileSharing`). */
      messages: number;
      alreadyRedacted: boolean;
      /** Closed extraction generations removed. An open one keeps its row. */
      extractionsRemoved: number;
      chunksRemoved: number;
      namesRemoved: number;
      metadataRemoved: number;
      /** `blob_delete` items this call put on the queue, Brain's copies only. */
      blobDeletesQueued: number;
      /** Open `document_extract` failure rows this masking settled. */
      failuresResolved: number;
    }
  | { ok: false; code: 'FILE_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

export interface AttachmentStore {
  listMissingFileNames(input: { limit: number }): Promise<ListMissingFileNamesResult>;
  writeFileNames(input: { names: readonly FileName[] }): Promise<WriteFileNamesResult>;
  listFileNames(fileId: string): Promise<ListFileNamesResult>;
  linkAttachments(input: LinkAttachmentsInput): Promise<LinkAttachmentsResult>;
  listMessageAttachments(messageId: string): Promise<ListMessageAttachmentsResult>;
  /** One place by its id. A read, so it takes no lock (AD-7). */
  readFileLocation(id: string): Promise<ReadFileLocationResult>;
  /** Every place one file's bytes are or were. Also a read (AD-7). */
  listFileLocations(fileId: string): Promise<ListFileLocationsResult>;
  /** Record that the bytes at one place are gone, once (`files/blob-delete-work.ts`). */
  markFileLocationDeleted(
    input: MarkFileLocationDeletedInput,
  ): Promise<MarkFileLocationDeletedResult>;
  /** One file and how many messages share it. A read, so it takes no lock (AD-7). */
  readFileSharing(ref: FileRef): Promise<ReadFileSharingResult>;
  /** Which of these content hashes belong to a masked file. Also a read (AD-7). */
  listRedactedContentHashes(
    hashes: readonly string[],
  ): Promise<ListRedactedContentHashesResult>;
  /**
   * Mask one file: take away Brain's stored copy, its extracted text, its names
   * and its metadata, record that it happened, and queue the deletion of the
   * bytes (`files/redact.ts`, AD-11, AD-23).
   *
   * One transaction. Two things about the order inside it are contract, and
   * both are referential and not trigger-driven: the file's pointer is cleared
   * with the mask, before the generation rows it may name are deleted, and a
   * generation's pieces go before the generation itself. (The chunk-delete rule
   * of 0008 does *not* decide any of it — it exempts a masking outright.)
   *
   * An open generation keeps its row and loses its pieces — the worker holding
   * it is told `FILE_REDACTED` and its own `finishExtraction` closes it
   * `redacted`, where deleting the row would make that worker record a failure
   * about a generation nobody has.
   *
   * The bytes themselves are never deleted in here: a filesystem call under the
   * write lock is the thing AD-7 exists to prevent, so what goes in is a
   * `blob_delete` item and the drain does the deleting (AD-23).
   */
  redactFile(input: RedactFileInput): Promise<RedactFileResult>;
}

/**
 * Which claim a reading of a file is opened under (AD-21, AD-24).
 *
 * It is checked by `beginExtraction` and by nothing else. The open-row key of
 * `work_items` is `(kind, target)`, so one file has at most one extraction claim
 * at a time: the caller holding it is the only live reader of that file, and any
 * open generation it finds belongs to a claim that has expired. A late write
 * from that expired worker is stopped by the generation being closed
 * (`EXTRACTION_CLOSED`) rather than by a second claim check (Design Notes).
 */
export interface ExtractionClaim {
  /** The `work_items` row this reading is being done for. */
  workItemId: string;
  /** The `claimedBy` of the drain run that holds it. */
  claimedBy: string;
}

/** What opening one reading of one file needs (AD-24). */
export interface BeginExtractionInput {
  /** The id to give the new `document_extractions` row. The caller mints it (AD-8). */
  id: string;
  fileId: string;
  extractorVersion: string;
  /** When this reading began, read once from `Clock` (AD-13). */
  startedAt: Date;
  claim: ExtractionClaim;
}

/**
 * The generation this call opened, and the one it had to close first.
 *
 * `closedStale` is the open generation of an expired claim, closed `failed` in
 * the same transaction with its pieces removed — the "next claim closes it" rule
 * of AD-24. It is `null` on the ordinary call, which is most of them.
 */
export type BeginExtractionResult =
  | { ok: true; extraction: DocumentExtraction; closedStale: DocumentExtraction | null }
  | {
      ok: false;
      code: 'FILE_NOT_FOUND' | 'FILE_REDACTED' | 'CLAIM_LOST' | 'DB_UNAVAILABLE' | 'DB_LOCKED';
      message: string;
    };

/** One piece of a reading, as its writer hands it over (AD-24). */
export interface ExtractionChunkInput {
  /** UUIDv7 minted by the caller (AD-8). */
  id: string;
  /** Key together with the generation; a non-negative safe integer. */
  ordinal: number;
  body: string;
  chunkLocator: ChunkLocator;
  /**
   * The `page` copy of the locator: a PDF's page and `null` for every other
   * kind. It is carried rather than derived so that a caller which read the
   * column wrong is refused instead of corrected — `chunkPageMatches` compares
   * with `===`, which makes a missing field a different answer from `null`.
   */
  page: number | null;
}

export interface AppendExtractionChunksInput {
  extractionId: string;
  /** One batch, one transaction: `1..DOCUMENT_CHUNK_BATCH_MAX` pieces. */
  chunks: readonly ExtractionChunkInput[];
}

/**
 * How many pieces went in, or why none did.
 *
 * Every refusal leaves the batch entirely unwritten, including `CHUNK_INVALID`:
 * a generation holding the first half of a batch would be a reading nobody can
 * tell from a complete one.
 */
export type AppendExtractionChunksResult =
  | { ok: true; appended: number }
  | {
      ok: false;
      code:
        | 'EXTRACTION_NOT_FOUND'
        | 'EXTRACTION_CLOSED'
        | 'FILE_REDACTED'
        | 'CHUNK_BATCH_TOO_LARGE'
        | 'CHUNK_INVALID'
        | 'DB_UNAVAILABLE'
        | 'DB_LOCKED';
      message: string;
    };

/**
 * How a reading ended, as the closing call carries it.
 *
 * `ok` is the only outcome that knows what the bytes were, which is why its
 * `mediaType` is not nullable: a reading that produced text read the file. The
 * other three may have stopped before they found out.
 */
export type ExtractionOutcome =
  | { status: 'ok'; mediaType: string; indexConfigId: string | null }
  | {
      status: 'failed';
      failedStage: DocumentExtractionFailedStage;
      error: string;
      mediaType: string | null;
    }
  | { status: 'unsupported' | 'too_large'; error: string; mediaType: string | null };

export interface FinishExtractionInput {
  extractionId: string;
  /** When it stopped, read once from `Clock` (AD-13). */
  finishedAt: Date;
  outcome: ExtractionOutcome;
}

/**
 * The closed generation, and whether the file's pointer now names it.
 *
 * `current: false` is the ordinary answer for every outcome but a successful
 * reading that was also the newest attempt: a failure leaves the pointer where
 * it was, so search keeps answering from the last generation that worked
 * (AD-24).
 *
 * `extraction.status` is how a caller tells the two `current: false` successes
 * apart. A reading that succeeded but was overtaken by a newer attempt is closed
 * `ok`; a reading of a file somebody redacted while it ran is closed `redacted`,
 * because its text may not be kept and the pointer may not name it. Every
 * adapter answers that way, the in-memory fake included (`redactFile`).
 */
export type FinishExtractionResult =
  | { ok: true; extraction: DocumentExtraction; current: boolean }
  | {
      ok: false;
      code: 'EXTRACTION_NOT_FOUND' | 'EXTRACTION_CLOSED' | 'DB_UNAVAILABLE' | 'DB_LOCKED';
      message: string;
    };

export interface SetFileSourceUnreachableInput {
  fileId: string;
  /** When the bytes went out of reach, or `null` to clear the mark. */
  unreachableAt: Date | null;
}

export type SetFileSourceUnreachableResult =
  | { ok: true }
  | { ok: false; code: 'FILE_NOT_FOUND' | 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };

/**
 * Everything the extraction worker needs to know about one file before it reads
 * it, as one lock-free read.
 *
 * `lastAttempt` is the highest `attempt` the file has, and `0` for a file no
 * reading has touched — so the next generation is always `lastAttempt + 1`,
 * with nothing to reconcile (migration 0004).
 */
export interface FileExtractionState {
  fileId: string;
  /**
   * The hash the ingest recorded of these bytes, so the worker can tell the
   * file it is about from whatever is at the location now (AD-23).
   */
  contentHash: string;
  /** How many bytes the ingest saw, which is what the size bound is read from. */
  sizeBytes: number;
  /**
   * Where Brain's own copy is, or `null` for a file it never kept — an
   * attachment that was already missing when it was collected, or one whose
   * only location belongs to somebody else. A reading needs bytes, so a `null`
   * here is a file whose original cannot be reached.
   */
  home: FileLocation | null;
  redactedAt: Date | null;
  sourceUnreachableAt: Date | null;
  currentExtractionId: string | null;
  /** The generation still running, or `null`. At most one per file (0004). */
  openExtraction: DocumentExtraction | null;
  lastAttempt: number;
}

export type ReadFileExtractionStateResult =
  | ({ ok: true } & FileExtractionState)
  | { ok: false; code: 'FILE_NOT_FOUND' | 'DB_UNAVAILABLE'; message: string };

/**
 * The files nothing has read yet, oldest id first — the queue's input, not its
 * state.
 *
 * "Nothing has read yet" is `document_extractions` holding no row for the file
 * at all, which is a stronger question than "no successful reading": a file
 * whose only generation is `unsupported` or `too_large` has been read, and
 * answered, so queueing it again would be the same work for ever. The row of a
 * failed reading is swept away by the next success (AD-24), and until then it is
 * what keeps a file whose bytes are gone out of this list.
 */
export type ListFilesAwaitingExtractionResult =
  | { ok: true; fileIds: readonly string[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The files a newer extractor would read differently, oldest id first, and the
 * ones that are behind and cannot be read at all.
 *
 * "Behind" is two questions and not one. The generation the file's pointer
 * names has to be a successful reading — `unsupported` and `too_large` are
 * answers a version bump does not change, and a `failed` current pointer does
 * not exist — stamped with some other version than the one asked about. And the
 * file must have *no* generation of the asked-for version at all, whatever it
 * says: a re-reading that failed permanently would otherwise be queued again on
 * every drain for ever, and asking once more is `failures retry`'s to do.
 *
 * `fileIds` is the part of that set a reading could actually be opened for, so
 * a redacted file, a file whose original is out of reach and a file Brain kept
 * no copy of are left out here rather than by the caller — the same division
 * `listFilesAwaitingExtraction` makes. The two counts are what the caller
 * reports instead: how many files are behind and redacted, and how many are
 * behind, not redacted, and out of reach. Both are the whole count and not the
 * part `limit` would have shown, because they answer "what is this drain not
 * doing", which a bound must not change (AD-24).
 */
export type ListFilesWithStaleExtractionResult =
  | {
      ok: true;
      fileIds: readonly string[];
      redacted: number;
      sourceUnreachable: number;
    }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export type ListExtractionsResult =
  | { ok: true; extractions: readonly DocumentExtraction[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

export type ListExtractionChunksResult =
  | { ok: true; chunks: readonly DocumentChunk[] }
  | { ok: false; code: 'DB_UNAVAILABLE'; message: string };

/**
 * The extraction capability: opening a reading of a file, writing its pieces,
 * closing it, and moving the file's pointer (AD-24).
 *
 * Four writes and three reads. Each write is one `BEGIN IMMEDIATE`, and the
 * batch bound on `appendExtractionChunks` is what keeps any of them short
 * (AD-7). Nothing in here mints an id or reads a clock: both arrive in the
 * input, as they do everywhere else in this port (AD-8, AD-13).
 *
 * The order the writes touch rows in is part of the contract, because the
 * triggers of 0008 can see it: a successful replacement closes the generation,
 * *then* moves the pointer, *then* removes the older generations' pieces —
 * removing them first would be a delete from a generation that is still current,
 * which `document_chunks_delete_rule` refuses. A reading that did not succeed
 * closes and then removes its own pieces, for the same reason. Removing text by
 * raising the redaction marker is not this capability's business and never
 * happens here (AD-11).
 */
export interface ExtractionStore {
  /**
   * Open a reading of one file, closing the leftovers of an expired claim first.
   *
   * The whole call is one transaction, and the claim is checked inside it: a
   * caller whose claim is gone changes nothing and is told `CLAIM_LOST`. A file
   * that has been redacted never gets a new generation (`FILE_REDACTED`), which
   * is half of why `attempt` cannot go backwards — the other half is that the
   * only generations this capability ever deletes have a lower `attempt` than
   * the new current one.
   */
  beginExtraction(input: BeginExtractionInput): Promise<BeginExtractionResult>;
  /**
   * Append one bounded batch of pieces in one transaction.
   *
   * A locator the codec refuses, a `page` that does not go with it, an `ordinal`
   * that is not a non-negative safe integer, and an `ordinal` or an `id` this
   * generation already holds or the batch repeats are all `CHUNK_INVALID`, and
   * none of them writes a row. The id is in that list because
   * `document_chunks.id` is unique across every generation, and a store that
   * left it to the database would throw where another would quietly store a
   * second row with the same id. The canonical text of the locator is what is
   * stored, so there is one spelling of one position (`chunk-locator.ts`).
   */
  appendExtractionChunks(
    input: AppendExtractionChunksInput,
  ): Promise<AppendExtractionChunksResult>;
  /**
   * Close one reading, and move the file's pointer when it earned it.
   *
   * A generation that is already closed is `EXTRACTION_CLOSED` and changes
   * nothing: that is an attempt whose claim expired long ago answering late, and
   * its answer must not overwrite the newer reading's (AD-24).
   *
   * An `ok` on a file that was redacted while the reading ran is closed with
   * status `redacted` and `current: false`: the pieces go, the pointer stays.
   */
  finishExtraction(input: FinishExtractionInput): Promise<FinishExtractionResult>;
  /**
   * Mark or unmark a file whose bytes cannot be reached. Touches that column and
   * nothing else: the pieces already extracted keep answering searches (AD-24).
   */
  setFileSourceUnreachable(
    input: SetFileSourceUnreachableInput,
  ): Promise<SetFileSourceUnreachableResult>;
  /** One file's extraction state. A read, so it takes no lock (AD-7). */
  readFileExtractionState(fileId: string): Promise<ReadFileExtractionStateResult>;
  /**
   * The files that have bytes to read and no generation yet, `id` ascending and
   * at most `limit` of them. A read, so it takes no lock (AD-7).
   *
   * A redacted file and a file whose original is out of reach are left out
   * here rather than by the caller: both are states the database carries, and a
   * drain that queued them would open a reading that `beginExtraction` refuses
   * or a handler closes without doing anything.
   */
  listFilesAwaitingExtraction(input: {
    limit: number;
  }): Promise<ListFilesAwaitingExtractionResult>;
  /**
   * The files whose current successful reading was made by another generation of
   * extractors than `extractorVersion`, `id` ascending and at most `limit` of
   * them, with the ones that are behind and unreadable counted instead
   * (`ListFilesWithStaleExtractionResult`). A read, so it takes no lock (AD-7).
   */
  listFilesWithStaleExtraction(input: {
    extractorVersion: string;
    limit: number;
  }): Promise<ListFilesWithStaleExtractionResult>;
  /** Every generation of one file, `attempt` ascending. A read (AD-7). */
  listExtractions(fileId: string): Promise<ListExtractionsResult>;
  /**
   * One generation's pieces, `ordinal` ascending, with the locator decoded. A
   * row written before migration 0004 carries `null`, which says "unknown".
   */
  listExtractionChunks(extractionId: string): Promise<ListExtractionChunksResult>;
}

/** Schedule persistence; recurrence rules belong to Core's tick. */
export interface ScheduleStore {
  addSchedule(input: AddScheduleInput): Promise<AddScheduleResult>;
  listDueSchedules(query: { now: Date; limit: number }): Promise<ListDueSchedulesResult>;
  fireSchedule(input: FireScheduleInput): Promise<FireScheduleResult>;
}
export type AddScheduleInput = import('../domain/schedule.js').Schedule;
export type ScheduleStoreFailure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export type AddScheduleResult = { ok: true; schedule: import('../domain/schedule.js').Schedule } | ScheduleStoreFailure;
export type ListDueSchedulesResult = { ok: true; schedules: readonly import('../domain/schedule.js').Schedule[] } | ScheduleStoreFailure;
export interface FireScheduleInput {
  scheduleId: string;
  expectedNextRunAt: Date;
  nextRunAt: Date | null;
  work: AddWorkInput;
  now: Date;
}
export type FireScheduleResult = { ok: true; fired: true; created: boolean } | { ok: true; fired: false } | ScheduleStoreFailure;
