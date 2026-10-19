import type { IngestBatch } from '../../domain/ingest-batch.js';
import type { Message } from '../../domain/message.js';
import type { Project } from '../../domain/project.js';
import type { Redaction } from '../../domain/redaction.js';
import type { Session } from '../../domain/session.js';
import type { Worktree } from '../../domain/worktree.js';
import {
  formatSessionToken,
  type SessionKey,
  type SessionToken,
} from '../../domain/session-token.js';
import type { ToolNote } from '../../domain/tool-note.js';
import type { User } from '../../domain/user.js';
import type { Failure } from '../../domain/failure.js';
import type { TranscriptFile } from '../../domain/transcript-file.js';
import { workKindPolicy, type WorkItem } from '../../domain/work-item.js';
import type {
  AddWorkInput,
  AddWorkResult,
  ClaimWorkInput,
  ClaimWorkResult,
  CompleteWorkInput,
  DueWorkQuery,
  EnsureSelfUserInput,
  EnsureSelfUserResult,
  EnsureSessionInput,
  EnsureSessionResult,
  FindSessionResult,
  FinishWorkInput,
  FinishWorkResult,
  HasDueWorkResult,
  IngestResult,
  ListFailuresQuery,
  ListFailuresResult,
  ListOpenWorkTargetsResult,
  ListTranscriptFilesQuery,
  ListTranscriptFilesResult,
  ReadSelfUserResult,
  ReadSessionResult,
  RecordFailureInput,
  RecordFailureResult,
  RecordTranscriptFileInput,
  RecordTranscriptFileResult,
  ResolveFailuresInput,
  ResolveFailuresResult,
  RetryWorkInput,
  Store,
  StoreHealth,
  StoreWarningCode,
} from '../../ports/store.js';

const DEFAULT_HEALTH: StoreHealth = {
  ok: true,
  serverVersion: '18.1',
  source: { location: 'memory', probes: [{ id: 'vector', ok: true, detail: '0.8.7' }] },
};

export interface MemoryStoreOptions {
  /** What `checkHealth` answers. Defaults to a healthy store. */
  health?: StoreHealth;
}

/** What the store holds, for the owning test. Contract cases never use it. */
export interface MemoryStoreSnapshot {
  users: readonly User[];
  /** One row per remote identity, in the order they were first seen (AD-12). */
  projects: readonly Project[];
  /** One row per `(project, path)`, in the order they were first seen. */
  worktrees: readonly Worktree[];
  sessions: readonly Session[];
  messages: readonly Message[];
  toolNotes: readonly ToolNote[];
  /** One row per masked span that was written, in the order it went in (AD-11). */
  redactions: readonly Redaction[];
  /** The queue, in the order rows were added (AD-21). */
  workItems: readonly WorkItem[];
  /** One row per `(target, stage, fingerprint)`, in the order first seen. */
  failures: readonly Failure[];
  /** One row per `(harness, path)`, in the order they were first recorded. */
  transcriptFiles: readonly TranscriptFile[];
  closes: number;
}

export interface MemoryStore extends Store {
  snapshot(): MemoryStoreSnapshot;
}

/**
 * The in-memory `Store`: the reference every real adapter is measured against.
 * It keeps rows in maps keyed by the natural idempotency keys of the Table
 * Contract, so a replayed batch adds nothing (AD-8).
 *
 * It mints nothing and reads no clock: every id and every instant arrives in
 * the input, exactly as a real adapter's does (AD-8, AD-13). The one thing it
 * decides for itself is `seq`, and it decides it the way the contract requires
 * — `max(seq) + 1` for the session, in batch order, skipping the messages it
 * already holds — so a transcript whose front was rewritten leaves the numbers
 * that are already stored alone (AD-4).
 */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const { health = DEFAULT_HEALTH } = options;

  const users = new Map<string, User>();
  // Keyed by the idempotency keys of the Table Contract: a project by its
  // remote identity, a worktree by its project and path.
  const projects = new Map<string, Project>();
  const worktrees = new Map<string, Worktree>();
  const sessions = new Map<SessionToken, Session>();
  const messages = new Map<SessionToken, Message[]>();
  const toolNotes = new Map<SessionToken, ToolNote[]>();
  /** Keyed by the session, like the rows above; the records are append only. */
  const redactions = new Map<SessionToken, Redaction[]>();
  /**
   * The queue and the record, as lists rather than maps: the keys of both are
   * partial — the open-row key of `work_items` covers only the rows still to be
   * done — and a map keyed on a partial key would lose the completed rows the
   * contract asks about.
   */
  const workItems: WorkItem[] = [];
  const failures: Failure[] = [];
  /** Keyed by `(harness, path)`, the idempotency key of the Table Contract. */
  const transcriptFiles = new Map<string, TranscriptFile>();
  let closes = 0;

  /** The open row for one piece of work, or undefined (`work_items_open_key_idx`). */
  function openWork(kind: string, targetKind: string, targetId: string): WorkItem | undefined {
    return workItems.find(
      (item) =>
        item.completedAt === null &&
        item.kind === kind &&
        item.targetKind === targetKind &&
        item.targetId === targetId,
    );
  }

  /**
   * The row this claim may change, or `null` for a claim that is not ours.
   *
   * This is the compare-and-set of the Design Notes: `id` *and* `claimedBy`, so
   * a worker whose claim expired and was taken by another cannot overwrite the
   * new worker's state.
   */
  function claimed(input: FinishWorkInput): WorkItem | null {
    return (
      workItems.find((item) => item.id === input.id && item.claimedBy === input.claimedBy) ?? null
    );
  }

  /** The claim columns, cleared. They are one fact, so they go together. */
  function unclaim(item: WorkItem): void {
    item.claimedAt = null;
    item.claimExpiresAt = null;
    item.claimedBy = null;
  }

  /** The one `isSelf` row, or undefined. A map, so a snapshot can show two. */
  function self(): User | undefined {
    return [...users.values()].find((user) => user.isSelf);
  }

  return {
    async checkHealth(): Promise<StoreHealth> {
      return health;
    },

    async close(): Promise<void> {
      closes += 1;
    },

    async ensureSelfUser(input: EnsureSelfUserInput): Promise<EnsureSelfUserResult> {
      const existing = self();
      if (existing !== undefined) {
        return { ok: true, created: false, user: { ...existing } };
      }
      const user: User = {
        id: input.id,
        name: input.name,
        isSelf: true,
        createdAt: input.createdAt,
      };
      users.set(user.id, user);
      return { ok: true, created: true, user: { ...user } };
    },

    async readSelfUser(): Promise<ReadSelfUserResult> {
      const existing = self();
      return { ok: true, user: existing === undefined ? null : { ...existing } };
    },

    async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
      const token = formatSessionToken(input.key);
      const existing = sessions.get(token);
      if (existing !== undefined) {
        // The session comes first, and a key that is already stored ends the
        // call: a project row created for a session nobody creates would be a
        // row nothing ever points at (port contract).
        return { ok: true, created: false, session: { ...existing } };
      }

      // Find-or-create, in the order the real adapter does it and inside the
      // same step as the session: the identity, then the path under it.
      let projectId: string | null = null;
      let worktreeId: string | null = null;
      if (input.checkout !== null) {
        const { remoteIdentity, worktreePath } = input.checkout;
        const project = projects.get(remoteIdentity) ?? {
          id: input.checkout.projectId,
          remoteIdentity,
          workspaceId: null,
        };
        projects.set(remoteIdentity, project);
        projectId = project.id;

        const path = worktreeKey(project.id, worktreePath);
        const worktree = worktrees.get(path) ?? {
          id: input.checkout.worktreeId,
          projectId: project.id,
          path: worktreePath,
          removedAt: null,
        };
        worktrees.set(path, worktree);
        worktreeId = worktree.id;
      }

      const session: Session = {
        id: input.id,
        harness: input.key.harness,
        harnessSessionId: input.key.harnessSessionId,
        userId: input.userId,
        machine: input.machine,
        startedAt: input.startedAt,
        workspaceId: input.workspaceId,
        // The ids that were actually attached, which are the stored ones
        // wherever the identity or the path was already there.
        projectId,
        worktreeId,
        ingestSource: input.ingestSource,
        endedAt: null,
        cursor: null,
        parserVersion: null,
        ingestedAt: null,
        startSource: input.startSource,
        continuedFromSessionId: null,
      };
      sessions.set(token, session);
      messages.set(token, []);
      toolNotes.set(token, []);
      redactions.set(token, []);
      return { ok: true, created: true, session: { ...session } };
    },

    async findSession(key: SessionKey): Promise<FindSessionResult> {
      const existing = sessions.get(formatSessionToken(key));
      // A key no session has is `null` and not a failure: that is the state of
      // every session before its first ingest.
      return { ok: true, session: existing === undefined ? null : { ...existing } };
    },

    async ingest(batch: IngestBatch): Promise<IngestResult> {
      const token = formatSessionToken(batch.key);
      const session = sessions.get(token);
      if (session === undefined) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `no session for ${token}. Call ensureSession first (AD-12).`,
        };
      }

      const storedMessages = messages.get(token) ?? [];
      const storedToolNotes = toolNotes.get(token) ?? [];
      const storedRedactions = redactions.get(token) ?? [];
      let insertedMessages = 0;
      let insertedToolNotes = 0;
      let insertedRedactions = 0;

      // Where this session's numbering carries on from. Read once, before any
      // insert, so the batch is numbered in its own order (AD-8).
      let nextSeq = storedMessages.reduce((highest, stored) => {
        return stored.seq >= highest ? stored.seq + 1 : highest;
      }, 0);
      const storedIds = new Set(storedMessages.map((stored) => stored.harnessMessageId));

      for (const parsed of batch.messages) {
        // Only the harness message id decides a duplicate: `seq` is this
        // store's own, so nothing about it can make a message a replay.
        if (storedIds.has(parsed.harnessMessageId)) continue;
        storedIds.add(parsed.harnessMessageId);
        storedMessages.push({
          id: parsed.id,
          sessionId: session.id,
          harnessMessageId: parsed.harnessMessageId,
          seq: nextSeq,
          role: parsed.role,
          model: parsed.model,
          body: parsed.body,
          occurredAt: parsed.occurredAt,
          gitBranch: parsed.gitBranch,
          isSubagentReport: parsed.isSubagentReport,
          // `cwd` is deliberately not here: the parser reports it and story 2.8
          // tags the session with the first message's one, but no message row
          // keeps it (migration 0004).
        });
        nextSeq += 1;
        insertedMessages += 1;

        // The masking records of the messages that actually went in, and only
        // those: a message the session already held came back with a fresh set
        // of record ids, and keeping them would record the same masking twice
        // or leave a record pointing at a message id no row carries (port
        // contract, AD-11).
        for (const redaction of parsed.redactions) {
          storedRedactions.push({
            id: redaction.id,
            messageId: parsed.id,
            start: redaction.start,
            end: redaction.end,
            kind: redaction.kind,
            contentHash: redaction.contentHash,
            occurredAt: redaction.occurredAt,
            patternVersion: redaction.patternVersion,
          });
          insertedRedactions += 1;
        }
      }

      for (const parsed of batch.toolNotes) {
        const duplicate = storedToolNotes.some(
          (stored) =>
            stored.harnessMessageId === parsed.harnessMessageId &&
            stored.ordinal === parsed.ordinal,
        );
        if (duplicate) continue;
        storedToolNotes.push({
          id: parsed.id,
          sessionId: session.id,
          harnessMessageId: parsed.harnessMessageId,
          ordinal: parsed.ordinal,
          tool: parsed.tool,
          target: parsed.target,
          ok: parsed.ok,
        });
        insertedToolNotes += 1;
      }

      storedMessages.sort((left, right) => left.seq - right.seq);
      messages.set(token, storedMessages);
      toolNotes.set(token, storedToolNotes);
      redactions.set(token, storedRedactions);

      // The cursor, the parser version and the end only move forward, and they
      // land in the same step as the rows (AD-7).
      sessions.set(token, {
        ...session,
        cursor: nextCursor(session, batch, storedMessages),
        parserVersion: batch.tracking.parserVersion,
        endedAt: batch.tracking.endedAt ?? session.endedAt,
        ingestedAt: batch.tracking.ingestedAt,
        // Only when the batch carries one: a read that saw no `SessionStart`
        // attachment knows nothing about the start, and its `null` must not
        // erase what an earlier read did know (port contract).
        startSource: batch.tracking.startSource ?? session.startSource,
      });

      const warnings: StoreWarningCode[] = batch.tracking.cursorReset
        ? ['CURSOR_RESET']
        : [];
      return {
        ok: true,
        sessionId: session.id,
        inserted: {
          messages: insertedMessages,
          toolNotes: insertedToolNotes,
          redactions: insertedRedactions,
        },
        warnings,
      };
    },

    async readSession(token: SessionToken): Promise<ReadSessionResult> {
      const session = sessions.get(token);
      if (session === undefined) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `no session for ${token}`,
        };
      }
      const sessionToolNotes = [...(toolNotes.get(token) ?? [])];
      const seqOf = new Map(
        (messages.get(token) ?? []).map((message) => [message.harnessMessageId, message.seq]),
      );
      sessionToolNotes.sort((left, right) => {
        const bySeq =
          (seqOf.get(left.harnessMessageId) ?? Number.MAX_SAFE_INTEGER) -
          (seqOf.get(right.harnessMessageId) ?? Number.MAX_SAFE_INTEGER);
        return bySeq === 0 ? left.ordinal - right.ordinal : bySeq;
      });
      return {
        ok: true,
        session: { ...session },
        messages: [...(messages.get(token) ?? [])],
        toolNotes: sessionToolNotes,
      };
    },

    async addWork(input: AddWorkInput): Promise<AddWorkResult> {
      const existing = openWork(input.kind, input.targetKind, input.targetId);
      if (existing !== undefined) {
        // Find-or-create: an open row for this work keeps everything it has,
        // including its own id and its own `next_attempt_at` (AD-21).
        return { ok: true, created: false, item: { ...existing } };
      }
      const item: WorkItem = {
        id: input.id,
        kind: input.kind,
        targetKind: input.targetKind,
        targetId: input.targetId,
        createdAt: input.createdAt,
        attempts: 0,
        nextAttemptAt: input.nextAttemptAt,
        claimedAt: null,
        claimExpiresAt: null,
        claimedBy: null,
        lastError: null,
        completedAt: null,
      };
      workItems.push(item);
      return { ok: true, created: true, item: { ...item } };
    },

    async hasDueWork(query: DueWorkQuery): Promise<HasDueWorkResult> {
      return { ok: true, due: candidates(workItems, query).length > 0 };
    },

    async claimWork(input: ClaimWorkInput): Promise<ClaimWorkResult> {
      const [next] = candidates(workItems, input);
      if (next === undefined) return { ok: true, item: null };

      // The attempt is raised by the claim and not by the outcome, so an item
      // that kills the worker holding it still counted once (Decision 1).
      next.attempts += 1;
      next.claimedAt = input.now;
      next.claimExpiresAt = new Date(input.now.getTime() + workKindPolicy(next.kind).claimForMs);
      next.claimedBy = input.claimedBy;
      return { ok: true, item: { ...next } };
    },

    async completeWork(input: CompleteWorkInput): Promise<FinishWorkResult> {
      const item = claimed(input);
      if (item === null) return { ok: true, outcome: 'lost' };
      item.completedAt = input.now;
      unclaim(item);
      return { ok: true, outcome: 'done' };
    },

    async retryWork(input: RetryWorkInput): Promise<FinishWorkResult> {
      const item = claimed(input);
      if (item === null) return { ok: true, outcome: 'lost' };
      item.nextAttemptAt = input.nextAttemptAt;
      item.lastError = input.lastError;
      unclaim(item);
      return { ok: true, outcome: 'done' };
    },

    async releaseWork(input: FinishWorkInput): Promise<FinishWorkResult> {
      const item = claimed(input);
      if (item === null) return { ok: true, outcome: 'lost' };
      // The attempt goes back too: nothing was tried, so nothing was attempted
      // (AD-21). `next_attempt_at` is deliberately left alone.
      item.attempts = Math.max(0, item.attempts - 1);
      unclaim(item);
      return { ok: true, outcome: 'done' };
    },

    async recordFailure(input: RecordFailureInput): Promise<RecordFailureResult> {
      // The claim is checked before anything is written: when it is not ours,
      // no failure row goes in either, because the new worker owns the outcome
      // of this item now (port contract).
      if (input.closeWork !== undefined && claimed(input.closeWork) === null) {
        return { ok: true, outcome: 'lost' };
      }

      const existing = failures.find(
        (failure) =>
          failure.targetKind === input.targetKind &&
          failure.targetId === input.targetId &&
          failure.stage === input.stage &&
          failure.fingerprint === input.fingerprint,
      );
      let failureId: string;
      let created: boolean;
      if (existing === undefined) {
        failures.push({
          id: input.id,
          targetKind: input.targetKind,
          targetId: input.targetId,
          stage: input.stage,
          fingerprint: input.fingerprint,
          harness: input.harness,
          sessionId: input.sessionId,
          code: input.code,
          message: input.message,
          occurredAt: input.occurredAt,
          resolvedAt: null,
        });
        failureId = input.id;
        created = true;
      } else {
        // Reopened, with the latest instant and sentence: the id stays the
        // first one's (Decision 2, 2026-10-19 사용자, Table Contract).
        existing.occurredAt = input.occurredAt;
        existing.message = input.message;
        existing.resolvedAt = null;
        failureId = existing.id;
        created = false;
      }

      if (input.closeWork !== undefined) {
        const item = claimed(input.closeWork);
        if (item !== null) {
          item.completedAt = input.closeWork.now;
          item.lastError = input.message;
          unclaim(item);
        }
      }
      return { ok: true, outcome: 'recorded', created, failureId };
    },

    async listOpenWorkTargets(query: { kind: string }): Promise<ListOpenWorkTargetsResult> {
      const targets = workItems
        .filter((item) => item.completedAt === null && item.kind === query.kind)
        .map((item) => ({ targetKind: item.targetKind, targetId: item.targetId }));
      return { ok: true, targets };
    },

    async listFailures(query: ListFailuresQuery): Promise<ListFailuresResult> {
      const matched = failures
        .filter((failure) => query.targetKind === undefined || failure.targetKind === query.targetKind)
        .filter((failure) => query.stage === undefined || failure.stage === query.stage)
        .filter((failure) => query.includeResolved === true || failure.resolvedAt === null)
        // Newest first, the id breaking the tie: two rows recorded in the same
        // millisecond must come back in one order, or a page would reshuffle
        // itself between two calls (port contract).
        .sort((left, right) => {
          const byInstant = right.occurredAt.getTime() - left.occurredAt.getTime();
          return byInstant === 0 ? right.id.localeCompare(left.id) : byInstant;
        })
        .map((failure) => ({ ...failure }));
      return {
        ok: true,
        failures: query.limit === undefined ? matched : matched.slice(0, query.limit),
      };
    },

    async resolveFailures(input: ResolveFailuresInput): Promise<ResolveFailuresResult> {
      let resolved = 0;
      for (const failure of failures) {
        if (
          failure.targetKind !== input.targetKind ||
          failure.targetId !== input.targetId ||
          failure.stage !== input.stage ||
          // Only the open ones: a row somebody already resolved keeps the
          // instant it was resolved at (port contract).
          failure.resolvedAt !== null
        ) {
          continue;
        }
        failure.resolvedAt = input.now;
        resolved += 1;
      }
      return { ok: true, resolved };
    },

    async listTranscriptFiles(
      query: ListTranscriptFilesQuery,
    ): Promise<ListTranscriptFilesResult> {
      const files = [...transcriptFiles.values()]
        .filter((file) => file.harness === query.harness)
        .map((file) => ({ ...file }));
      return { ok: true, files };
    },

    async recordTranscriptFile(
      input: RecordTranscriptFileInput,
    ): Promise<RecordTranscriptFileResult> {
      const key = transcriptKey(input.harness, input.path);
      const existing = transcriptFiles.get(key);
      if (existing === undefined) {
        const file: TranscriptFile = {
          id: input.id,
          harness: input.harness,
          path: input.path,
          sizeBytes: input.sizeBytes,
          fingerprint: input.fingerprint,
          cursor: input.cursor,
          scannedAt: input.scannedAt,
        };
        transcriptFiles.set(key, file);
        return { ok: true, file: { ...file } };
      }

      // The size only moves forward, and the cursor moves with it: two reads of
      // a growing file can finish out of order, and the older one must not wind
      // the history back. A reset is the one case where a smaller file is the
      // truth — a compacted transcript really is shorter (port contract).
      if (!input.reset && input.sizeBytes < existing.sizeBytes) {
        return { ok: true, file: { ...existing } };
      }
      existing.sizeBytes = input.sizeBytes;
      existing.fingerprint = input.fingerprint;
      existing.cursor = input.cursor;
      existing.scannedAt = input.scannedAt;
      return { ok: true, file: { ...existing } };
    },

    snapshot(): MemoryStoreSnapshot {
      return {
        users: [...users.values()],
        projects: [...projects.values()],
        worktrees: [...worktrees.values()],
        sessions: [...sessions.values()],
        messages: [...messages.values()].flat(),
        toolNotes: [...toolNotes.values()].flat(),
        redactions: [...redactions.values()].flat(),
        workItems: workItems.map((item) => ({ ...item })),
        failures: failures.map((failure) => ({ ...failure })),
        transcriptFiles: [...transcriptFiles.values()].map((file) => ({ ...file })),
        closes,
      };
    },
  };
}

/**
 * The due, unclaimed, handled items in the order a claim takes them: least
 * attempted first, oldest id breaking the tie (AD-21).
 *
 * The four conditions are the claim query's own, column for column. A live
 * claim hides the row; an expired one does not, which is what lets a drain take
 * over from a worker that was killed. A kind nobody handles is left alone rather
 * than claimed or closed (Decision 4, 2026-10-19).
 */
function candidates(items: readonly WorkItem[], query: DueWorkQuery): WorkItem[] {
  const kinds = new Set(query.kinds);
  return items
    .filter(
      (item) =>
        item.completedAt === null &&
        item.nextAttemptAt.getTime() <= query.now.getTime() &&
        (item.claimExpiresAt === null || item.claimExpiresAt.getTime() <= query.now.getTime()) &&
        kinds.has(item.kind),
    )
    .sort((left, right) =>
      left.attempts === right.attempts
        ? left.id.localeCompare(right.id)
        : left.attempts - right.attempts,
    );
}

/**
 * One worktree's key. A newline, because a path may hold anything else a
 * separator could be made of.
 */
function worktreeKey(projectId: string, path: string): string {
  return `${projectId}\n${path}`;
}

/** One transcript file's key, for the same reason and the same way. */
function transcriptKey(harness: string, path: string): string {
  return `${harness}\n${path}`;
}

/**
 * Where the session's cursor stands after this batch: the batch's own, unless
 * that would wind the session back (port contract).
 *
 * Two hooks can overlap — one reading a longer transcript than the other, and
 * the older one committing last. Taking the newer cursor every time would then
 * point the session at a message the other read had already passed, and the
 * next read would parse a stretch of transcript it has already stored. So the
 * cursor is replaced only when the batch reset it, when the session has no
 * cursor message among its rows, or when the batch's cursor message is at or
 * after the stored one.
 */
function nextCursor(
  session: Session,
  batch: IngestBatch,
  stored: readonly Message[],
): Session['cursor'] {
  const cursor = batch.tracking.cursor;
  if (cursor === null) return session.cursor;
  if (batch.tracking.cursorReset || session.cursor === null) return cursor;

  const seqOf = (harnessMessageId: string): number | undefined =>
    stored.find((message) => message.harnessMessageId === harnessMessageId)?.seq;
  const was = seqOf(session.cursor.lastHarnessMessageId);
  if (was === undefined) return cursor;
  const now = seqOf(cursor.lastHarnessMessageId);
  return now !== undefined && now >= was ? cursor : session.cursor;
}
