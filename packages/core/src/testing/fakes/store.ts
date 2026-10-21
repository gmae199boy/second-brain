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
  RedactMessageInput,
  RedactMessageResult,
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
  EnsureCheckoutInput,
  FillSessionTagsInput,
  FillSessionTagsResult,
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
  /**
   * One row per masked span that was written, in the order it went in (AD-11).
   *
   * Written only by messages.redact; ingest never creates these records.
   */
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
 * A stored tool note plus the harness's own id for the call, which the row
 * carries (`tool_notes.call_id`, migration 0005) and no reader asks for.
 *
 * It is kept here and stripped on the way out because it is not what a note
 * *says* — it is how the store recognises the same call when a later parser
 * version puts it at another position (`domain/ingest-batch.ts`, story 23).
 */
interface StoredToolNote extends ToolNote {
  callId: string | null;
}

/** Whether two notes name the same place in the conversation. */
function samePlace(
  left: { harnessMessageId: string; ordinal: number },
  right: { harnessMessageId: string; ordinal: number },
): boolean {
  return (
    left.harnessMessageId === right.harnessMessageId && left.ordinal === right.ordinal
  );
}

/** A stored note as a reader sees it: the call id is the store's own business. */
function plainToolNote(note: StoredToolNote): ToolNote {
  const { callId: _callId, ...rest } = note;
  return rest;
}

/**
 * The in-memory `Store`: the reference every real adapter is measured against.
 * It keeps rows in maps keyed by the natural idempotency keys of the Table
 * Contract, so a replayed batch adds nothing (AD-8).
 *
 * It mints nothing, reads no clock and decides nothing of its own: every id and
 * every instant arrives in the input, exactly as a real adapter's does (AD-8,
 * AD-13). A message carries no number, so there is nothing left to assign —
 * `(session, harness message id)` is its identity and `occurredAt` is the order
 * it is read back in (migration 0006).
 */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const { health = DEFAULT_HEALTH } = options;

  const users = new Map<string, User>();
  // Keyed by the idempotency keys of the Table Contract: a project by its
  // comparison key, a worktree by its project and path.
  const projects = new Map<string, Project>();
  const worktrees = new Map<string, Worktree>();
  const sessions = new Map<SessionToken, Session>();
  const messages = new Map<SessionToken, Message[]>();
  const toolNotes = new Map<SessionToken, StoredToolNote[]>();
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

  function checkoutTags(checkout: EnsureCheckoutInput | null) {
    let projectId: string | null = null;
    let worktreeId: string | null = null;
    if (checkout !== null) {
      const { remoteIdentity, identityKey, worktreePath } = checkout;
      const project = projects.get(identityKey) ?? {
        id: checkout.projectId,
        remoteIdentity,
        workspaceId: null,
      };
      projects.set(identityKey, project);
      projectId = project.id;

      const path = worktreeKey(project.id, worktreePath);
      const worktree = worktrees.get(path) ?? {
        id: checkout.worktreeId,
        projectId: project.id,
        path: worktreePath,
        removedAt: null,
      };
      worktrees.set(path, worktree);
      worktreeId = worktree.id;
    }

    return { projectId, worktreeId };
  }

  function addWork(input: AddWorkInput): AddWorkResult {
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

      const { projectId, worktreeId } = checkoutTags(input.checkout);

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
      if (input.identityWork !== null) addWork(input.identityWork);
      sessions.set(token, session);
      messages.set(token, []);
      toolNotes.set(token, []);
      redactions.set(token, []);
      return { ok: true, created: true, session: { ...session } };
    },

    async redactMessage(input: RedactMessageInput): Promise<RedactMessageResult> {
      for (const [token, rows] of messages) {
        const message = rows.find((row) => row.id === input.messageId);
        if (message === undefined) continue;
        const notes = toolNotes.get(token) ?? [];
        const plan = input.plan({ message: { ...message }, toolNotes: notes
          .filter((note) => note.harnessMessageId === message.harnessMessageId).map((note) => ({ ...note })) });
        if ('refused' in plan) return { ok: false, code: plan.refused, message: '가릴 글자를 찾지 못했습니다' };
        // Prepare the whole replacement before publishing it, including ids.
        const records = [...(redactions.get(token) ?? []), ...plan.redactions];
        if (new Set(records.map((record) => record.id)).size !== records.length) throw new Error('가리기 기록 id가 중복됩니다');
        const changed = new Map(plan.toolNotes.map((note) => [note.id, note.target]));
        messages.set(token, rows.map((row) => row.id === message.id ? { ...row, body: plan.body } : row));
        toolNotes.set(token, notes.map((note) => ({ ...note, target: changed.get(note.id) ?? note.target })));
        redactions.set(token, records);
        return { ok: true, sessionId: message.sessionId, bodySpans: plan.bodySpans,
          toolNoteSpans: plan.toolNoteSpans, toolNotesChanged: plan.toolNotes.length, chunksRemoved: 0 };
      }
      return { ok: false, code: 'MESSAGE_NOT_FOUND', message: '지정한 메시지가 없습니다' };
    },

    async fillSessionTags(input: FillSessionTagsInput): Promise<FillSessionTagsResult> {
      const session = sessions.get(formatSessionToken(input.key));
      if (session === undefined) {
        return { ok: false, code: 'SESSION_NOT_FOUND', message: '세션을 찾을 수 없습니다' };
      }
      if (session.projectId !== null || session.worktreeId !== null) {
        return { ok: true, filled: false, session: { ...session } };
      }
      Object.assign(session, checkoutTags(input.checkout));
      return { ok: true, filled: true, session: { ...session } };
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
      let insertedMessages = 0;
      let insertedToolNotes = 0;

      // Read once, before any insert: which messages are already here. It is
      // all ingest needs to know about them, because nothing is numbered
      // (migration 0006).
      const storedIds = new Set(storedMessages.map((stored) => stored.harnessMessageId));

      for (const parsed of batch.messages) {
        // The harness message id is the whole of what makes a message a
        // replay: there is nothing else about it that this store decides.
        if (storedIds.has(parsed.harnessMessageId)) continue;
        storedIds.add(parsed.harnessMessageId);
        storedMessages.push({
          id: parsed.id,
          sessionId: session.id,
          harnessMessageId: parsed.harnessMessageId,
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
        insertedMessages += 1;
        // No masking record is kept, because ingest does no masking: the body
        // is stored as the batch carried it and the output codecs mask it on
        // the way out (마스킹 B, AD-11).
      }

      for (const parsed of batch.toolNotes) {
        // Three ways this session already holds this call, and the first two
        // are what keep a parser version bump from storing it twice (2.7
        // follow-up review #9):
        //
        //   * a row with the same call id, wherever it sits;
        //   * a row with *no* call id at this note's own position — written by
        //     a version that named its calls nothing;
        //   * a row with no call id at one of the positions an older version
        //     may have put this same call under (`earlierPositions`).
        //
        // Nothing is guessed from a similar tool or target: that could swallow
        // a different call, and a note cannot be taken back (AD-11).
        const held =
          (parsed.callId !== null &&
            storedToolNotes.some((stored) => stored.callId === parsed.callId)) ||
          storedToolNotes.some(
            (stored) =>
              stored.callId === null &&
              (samePlace(stored, parsed) ||
                parsed.earlierPositions.some((earlier) => samePlace(stored, earlier))),
          );
        if (held) continue;
        // The position is a key of its own, and a row already standing there is
        // some other call: the insert is dropped rather than counted, the way a
        // real adapter's `on conflict do nothing` drops it.
        if (storedToolNotes.some((stored) => samePlace(stored, parsed))) continue;
        storedToolNotes.push({
          id: parsed.id,
          sessionId: session.id,
          harnessMessageId: parsed.harnessMessageId,
          ordinal: parsed.ordinal,
          tool: parsed.tool,
          target: parsed.target,
          ok: parsed.ok,
          callId: parsed.callId,
        });
        insertedToolNotes += 1;
      }

      // Conversation order, held on the stored list so every `readSession`
      // hands it back the way a real adapter's `order by occurred_at` does
      // (migration 0006). `sort` is stable, which is this fake's answer to two
      // messages of one instant: it keeps the order they went in, and promises
      // nothing about it — a case that depended on it would be a case the
      // SQLite store is free to fail.
      storedMessages.sort(
        (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
      );
      messages.set(token, storedMessages);
      toolNotes.set(token, storedToolNotes);

      // The cursor, the parser version and the end only move forward, and they
      // land in the same step as the rows (AD-7).
      sessions.set(token, {
        ...session,
        cursor: nextCursor(session, batch, storedMessages),
        parserVersion: batch.tracking.parserVersion,
        endedAt: batch.tracking.endedAt ?? session.endedAt,
        ingestedAt: batch.tracking.ingestedAt,
        // Only when the batch carries one and the session has none yet: a read
        // that saw no `SessionStart` attachment knows nothing about the start,
        // and its `null` must not erase what an earlier read did know — while a
        // value that disagrees with the stored one is a later attachment, which
        // is not why the session began (port contract).
        startSource: session.startSource ?? batch.tracking.startSource,
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
      // Its message's instant, then its message, then its own ordinal. The
      // middle key is what keeps one message's notes together when two
      // messages of the session share an instant; it orders notes and says
      // nothing about which of those messages is read first. A note whose
      // message is not stored sorts last rather than disappearing, which is
      // what the adapters' `left join` does (port contract, migration 0006).
      const instantOf = new Map(
        (messages.get(token) ?? []).map((message) => [
          message.harnessMessageId,
          message.occurredAt.getTime(),
        ]),
      );
      sessionToolNotes.sort((left, right) => {
        const byInstant =
          (instantOf.get(left.harnessMessageId) ?? Number.MAX_SAFE_INTEGER) -
          (instantOf.get(right.harnessMessageId) ?? Number.MAX_SAFE_INTEGER);
        if (byInstant !== 0) return byInstant;
        if (left.harnessMessageId !== right.harnessMessageId) {
          return left.harnessMessageId < right.harnessMessageId ? -1 : 1;
        }
        return left.ordinal - right.ordinal;
      });
      return {
        ok: true,
        session: { ...session },
        messages: [...(messages.get(token) ?? [])],
        toolNotes: sessionToolNotes.map(plainToolNote),
      };
    },

    async addWork(input: AddWorkInput): Promise<AddWorkResult> {
      return addWork(input);
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
          // The first occurrence is this one, and it has been met once (0005).
          firstOccurredAt: input.occurredAt,
          occurrences: 1,
        });
        failureId = input.id;
        created = true;
      } else {
        // Reopened, with the latest instant and sentence: the id stays the
        // first one's (Decision 2, 2026-10-19 사용자, Table Contract).
        // `firstOccurredAt` is deliberately untouched — it is the one thing the
        // row knows that this occurrence cannot say (0005).
        existing.occurredAt = input.occurredAt;
        existing.message = input.message;
        existing.resolvedAt = null;
        existing.occurrences += 1;
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
        toolNotes: [...toolNotes.values()].flat().map(plainToolNote),
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
 * next read would parse a stretch of transcript it has already stored. So an
 * ordinary batch replaces the cursor only when the session has no cursor
 * message among its rows or when the batch's cursor message was uttered at or
 * after the stored one.
 *
 * That comparison is on `occurredAt` and not on the order the rows went in
 * (migration 0006): insertion order is exactly what the two overlapping reads
 * disagree about, and the shorter read's last message can be the newest row and
 * still the earlier moment.
 *
 * A batch that reset is the exception, and it is taken whole — `null` included,
 * which clears the cursor. The front of that transcript changed, so the read
 * before it describes a file that no longer exists and a cursor pointing into
 * it would reset every read from now on (#16). Moving backwards is right there;
 * what is not right is doing it over an overlapping read's work, so it is
 * allowed only while the session's cursor is still the one that read began from
 * (`cursorBase`, #17).
 */
function nextCursor(
  session: Session,
  batch: IngestBatch,
  stored: readonly Message[],
): Session['cursor'] {
  if (batch.tracking.cursorReset && sameCursor(session.cursor, batch.tracking.cursorBase)) {
    return batch.tracking.cursor;
  }

  const cursor = batch.tracking.cursor;
  if (cursor === null) return session.cursor;
  if (session.cursor === null) return cursor;

  const instantOf = (harnessMessageId: string): number | undefined =>
    stored
      .find((message) => message.harnessMessageId === harnessMessageId)
      ?.occurredAt.getTime();
  const was = instantOf(session.cursor.lastHarnessMessageId);
  if (was === undefined) return cursor;
  const now = instantOf(cursor.lastHarnessMessageId);
  return now !== undefined && now >= was ? cursor : session.cursor;
}

/** Whether two cursors name the same message with the same fingerprint. */
function sameCursor(left: Session['cursor'], right: Session['cursor']): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.lastHarnessMessageId === right.lastHarnessMessageId &&
    left.fingerprint === right.fingerprint
  );
}
