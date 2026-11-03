import { extensionPublicProjection } from '../../extensions/public-projection.js';
import { validInstallProgress } from '../../extensions/install-progress.js';
import { conversationFingerprint } from '../../recall/conversation-fingerprint.js';
import { attemptUsage } from '../../queue/list.js';
import type { ChannelStore } from '../../channels/store.js';
import type { SettingsStore, ScheduleSuccess } from '../../ports/store.js';
import { addLocalDays, isLocalTime } from '../../local-time.js';
import { formatInstant } from '../../instant.js';
import type { IngestAttachment } from '../../domain/ingest-batch.js';
import type { MessageAttachment } from '../../ports/store.js';
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
import type { DocumentChunk, DocumentExtraction, DocumentExtractionFailedStage } from '../../domain/document.js';
import { checkExtractionChunkBatch } from '../../files/extraction-chunks.js';
import { FILE_REDACTION_RESOLVES } from '../../files/redact.js';
import type { User } from '../../domain/user.js';
import type { Failure } from '../../domain/failure.js';
import type { TranscriptFile } from '../../domain/transcript-file.js';
import { dependencyFailedText, workHoldGroup, workExecutionClass, workKindPolicy, type WorkAttempt, type WorkItem } from '../../domain/work-item.js';
import type {
  RedactMessageInput,
  RedactMessageResult,
  AppendExtractionChunksInput,
  AppendExtractionChunksResult,
  BeginExtractionInput,
  BeginExtractionResult,
  FinishExtractionInput,
  FinishExtractionResult,
  ListExtractionChunksResult,
  ListExtractionsResult,
  ListFilesAwaitingExtractionResult,
  ListFilesWithStaleExtractionResult,
  ReadFileExtractionStateResult,
  SetFileSourceUnreachableInput,
  SetFileSourceUnreachableResult,
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
  FileLocationRow,
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
  source: { location: 'memory', probes: [{ id: 'pg_trgm', ok: true, detail: 'pg_trgm' }] },
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
   * One row per masking that was written, in the order it went in (AD-11): the
   * spans of `messages.redact` first, then the whole-file records of
   * `files.redact`. Ingest never creates either.
   */
  redactions: readonly Redaction[];
  /** The queue, in the order rows were added (AD-21). */
  workItems: readonly WorkItem[];
  workAttempts: readonly WorkAttempt[];
  scheduleSuccesses: readonly (ScheduleSuccess & { scheduleId: string })[];
  /** One row per `(target, stage, fingerprint)`, in the order first seen. */
  failures: readonly Failure[];
  /** One row per `(harness, path)`, in the order they were first recorded. */
  transcriptFiles: readonly TranscriptFile[];
  closes: number;
}

export interface MemoryStore extends Store, SettingsStore, ChannelStore {
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

/**
 * What a generation closed by a later `beginExtraction` says about itself.
 *
 * The same sentence as the PostgreSQL adapter's, and it names the new begin rather
 * than an expired claim: closing the leftovers is what every begin does, and the
 * usual reason there are leftovers — a claim that ran out — is not the only one.
 */
const STALE_EXTRACTION_ERROR = '새 begin이 열려 있던 이 세대를 닫았습니다';

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

  const installProgress = new Map<string, import('../../extensions/install-progress.js').StoredExtensionInstallProgress>();
  const extensionWorkKinds = new Map<string, readonly string[]>();
  const extensionFollowups = new Map<string, Readonly<Record<string, string>>>();
  const pythonEnvironments = new Map<string, import('../../ports/store.js').ExtensionPythonEnvironment>();
  const extensions = new Map<string, import('../../ports/store.js').ExtensionRecord>();
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
  const validHoldGroup = (group: string | null) => group === null || (group !== '' && [...group].length <= 200);
  const invalidGroup = { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '보류 그룹은 1~200자여야 합니다' };
  const heldGroups = new Map<string, Date>();
  const isHeld = (group: string | null) => group !== null && heldGroups.has(group);
  const schedules = new Map<string, import('../../domain/schedule.js').Schedule>();
  const workItems: WorkItem[] = [];
  const channels = new Map<string, import('../../channels/store.js').Channel>();
  const conversations = new Map<string, import('../../channels/store.js').ChannelConversation>();
  const legacyRecords = new Map<string, import('../../channels/store.js').ChannelLegacyRecord>();
  const channelRequests = new Map<string, import('../../channels/store.js').ChannelRequest>();
  const channelItems = new Map<string, Map<number, import('../../channels/store.js').ChannelAttemptResult>>();
  const channelItemTokens = new Map<string, Map<number, string>>();
  const channelGates = new Map<string, { workItemId: string; attemptToken: string }>();
  const channelAttempts = new Map<string, { requestId: string; result: import('../../channels/store.js').ChannelAttemptResult | null }>();
  const currentChannelAttempt = (workItemId: string, token: string) => workItems.some(w => w.id === workItemId && w.completedAt === null && w.currentAttemptToken === token) && workAttempts.some(a => a.workItemId === workItemId && a.token === token && a.outcome === null);

  const conversationChunks: (import('../../recall/conversation-chunker.js').ConversationChunk & { id: string; sessionId: string })[] = [];
  const conversationConfig = { targetChars: 1200, overlapMessages: 1, splitMessagesOverChars: 2400 };
  let conversationWorkSequence = 0;
  function enqueueConversation(sessionId: string, now: Date) {
    const existing = openWork('conversation_chunk', 'session', sessionId);
    if (existing) { unclaim(existing); existing.attempts = 0; existing.nextAttemptAt = now; }
    else addWork({ id: `conversation-work-${++conversationWorkSequence}`, kind: 'conversation_chunk', targetKind: 'session', targetId: sessionId, createdAt: now, nextAttemptAt: now });
  }
  function conversationMessages(sessionId: string) {
    return [...messages.values()].flat().filter(m => m.sessionId === sessionId).map(m => ({ id: m.id, occurredAt: m.occurredAt, body: m.body }));
  }

  const claimedDates = new Map<string, { from: string; to: string }>();
  const scheduleSuccesses = new Map<string, ScheduleSuccess & { scheduleId: string }>();
  function settleSuccess(item: WorkItem, now: Date) {
    const snapshot = claimedDates.get(item.id);
    const dates = item.scheduledDates;
    if (snapshot && dates?.scheduleId) {
      for (let date = snapshot.from; date <= snapshot.to; date = addLocalDays(date, 1)) {
        const key = `${dates.scheduleId}/${date}`;
        if (!scheduleSuccesses.has(key)) scheduleSuccesses.set(key, { scheduleId: dates.scheduleId, localDate: date,
          timeZone: dates.timeZone, workId: item.id, recordedAt: new Date(now) });
      }
    }
    const widened = item.cancelRequestedAt === null && dates !== null && (!snapshot || dates.from < snapshot.from || dates.to > snapshot.to);
    item.completedAt = widened ? null : now;
    item.outcome = widened ? null : 'succeeded';
    if (widened) item.nextAttemptAt = now;
    claimedDates.delete(item.id);
  }
  const workDependencies: { workItemId: string; prerequisiteId: string }[] = [];
  const workAttempts: WorkAttempt[] = [];
  const failures: Failure[] = [];
  /** Keyed by `(harness, path)`, the idempotency key of the Table Contract. */
  const transcriptFiles = new Map<string, TranscriptFile>();
  const attachmentRows = new Map<string, MessageAttachment[]>();
  const fileRows = new Map<string, NonNullable<MessageAttachment['file']>>();
  /**
   * The `file_locations` rows, which `MessageAttachment.file.locations` cannot
   * hold: that shape is where a file's bytes *are*, and this is the row — the id
   * a piece of work names, and the instant that says the bytes have gone.
   *
   * A list and not a map, because two keys matter: the id the reads ask by and
   * `(fileId, storeKind, locator)`, which decides whether a second ingest of the
   * same place is a new row. It is not — the first id stays, exactly as the
   * `on conflict (file_id, store_kind, locator) do nothing` of the adapter does.
   */
  const fileLocationRows: FileLocationRow[] = [];
  /**
   * `files.redacted_at` by file id, and the whole-file `redactions` records.
   *
   * The records are a list of their own and not in the per-session map above,
   * because a file masking belongs to no session: the same content can hang off
   * messages of five of them (`files/redact.ts`).
   */
  const fileRedactedAt = new Map<string, Date>();
  const fileRedactions: Redaction[] = [];
  /** Whether this file has been masked, which is the column every guard reads. */
  function fileRedacted(fileId: string): boolean {
    return fileRedactedAt.has(fileId);
  }
  function link(rows: readonly IngestAttachment[], held: readonly Message[]): number {
    let linked = 0;
    for (const a of rows) {
      const message = held.find(m => m.harnessMessageId === a.harnessMessageId);
      if (message === undefined) throw new Error('첨부 메시지가 없습니다');
      const existing = attachmentRows.get(message.id) ?? [];
      if (existing.some(row => row.ordinal === a.ordinal)) continue;
      let file: MessageAttachment['file'] = null;
      if (a.file !== null) {
        file = fileRows.get(a.file.contentHash) ?? null;
        if (file === null) {
          file = { id: a.file.id, contentHash: a.file.contentHash, sizeBytes: a.file.sizeBytes, home: null, locations: [] };
          fileRows.set(a.file.contentHash, file);
        }
        for (const location of [a.file.location, a.file.external]) {
          if (location === null || file.locations.some(l => l.storeKind === location.storeKind && l.locator === location.locator)) continue;
          const { storeKind, locator, ownership } = location;
          file.locations = [...file.locations, { storeKind, locator, ownership }].sort((a,b) => a.ownership.localeCompare(b.ownership) || a.locator.localeCompare(b.locator));
          fileLocationRows.push({ id: location.id, fileId: file.id, storeKind, locator, ownership, deletedAt: null });
          if (file.home === null && ownership === 'brain') file.home = { storeKind, locator, ownership };
        }
      }
      existing.push({ id: a.id, ordinal: a.ordinal, sourceKind: a.sourceKind, sourceRef: a.sourceRef, displayName: a.displayName, status: file === null ? 'missing_at_ingest' : 'stored', file });
      attachmentRows.set(message.id, existing);
      linked++;
    }
    return linked;
  }
  const fileNames: import('../../ports/store.js').FileName[] = [];
  /**
   * The extraction rows of AD-24: every generation in the order it was opened,
   * its pieces keyed by the generation, and the two `files` columns this
   * capability writes — the pointer and the unreachable mark.
   *
   * A list for the generations and not a map, for the reason the queue is a
   * list: the key that matters is `(file, attempt)` and the one the reads ask
   * about is the file, so a map keyed on either would lose the other.
   */
  const extractions: DocumentExtraction[] = [];
  const documentChunks = new Map<string, DocumentChunk[]>();
  const currentExtractions = new Map<string, string>();
  const sourceUnreachableAt = new Map<string, Date>();
  let closes = 0;

  /** One `files` row by id. The fake keys them by content hash, as ingest does. */
  function fileById(fileId: string): NonNullable<MessageAttachment['file']> | undefined {
    return [...fileRows.values()].find((file) => file.id === fileId);
  }

  function extractionById(id: string): DocumentExtraction | undefined {
    return extractions.find((extraction) => extraction.id === id);
  }

  /** The generation still running, of which a file has at most one (0004). */
  function openExtraction(fileId: string): DocumentExtraction | undefined {
    return extractions.find(
      (extraction) => extraction.fileId === fileId && extraction.finishedAt === null,
    );
  }

  function chunksOf(extractionId: string): DocumentChunk[] {
    return documentChunks.get(extractionId) ?? [];
  }

  /**
   * How far a generation that a new `beginExtraction` closes had got, guessed
   * from the one thing it can have stored: pieces mean it was indexing them, and
   * no pieces mean it never got that far. No column records the stage in
   * progress and nothing writes `media_type` before the generation is closed, so
   * the guess is two-way — the estimate AD-24 settles for rather than a stage
   * invented out of nothing (Design Notes).
   */
  function staleStage(extraction: DocumentExtraction): DocumentExtractionFailedStage {
    return chunksOf(extraction.id).length > 0 ? 'index' : 'read';
  }

  /** Whether this claim still holds this file's extraction work (port contract). */
  function holdsExtractionClaim(input: BeginExtractionInput): boolean {
    const item = workItems.find((row) => row.id === input.claim.workItemId);
    return (
      item !== undefined &&
      item.completedAt === null &&
      item.targetKind === 'file' &&
      item.targetId === input.fileId &&
      item.claimedBy === input.claim.claimedBy &&
      item.claimExpiresAt !== null &&
      item.claimExpiresAt.getTime() > input.startedAt.getTime()
    );
  }

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
    const holdGroup = workHoldGroup(input.kind, input.holdGroup);
    if (!validHoldGroup(holdGroup)) return invalidGroup;
    const existing = openWork(input.kind, input.targetKind, input.targetId);
    if (existing !== undefined) {
      ensureFollowup(existing);
      if (input.scheduledDates) {
        if (!existing.scheduledDates) existing.scheduledDates = { ...input.scheduledDates };
        else {
          existing.scheduledDates = { ...existing.scheduledDates,
            from: existing.scheduledDates.from < input.scheduledDates.from ? existing.scheduledDates.from : input.scheduledDates.from,
            to: existing.scheduledDates.to > input.scheduledDates.to ? existing.scheduledDates.to : input.scheduledDates.to,
            scheduleId: existing.scheduledDates.scheduleId ?? input.scheduledDates.scheduleId };
        }
      }
      // Find-or-create: an open row for this work keeps everything it has,
      // including its own id and its own `next_attempt_at` (AD-21).
      return { ok: true, created: false, item: structuredClone(existing) };
    }
    const item: WorkItem = {
      id: input.id,
      scheduledDates: input.scheduledDates ? { ...input.scheduledDates } : null,
      kind: input.kind,
      executionClass: [...extensionWorkKinds.values()].some(kinds => kinds.includes(input.kind)) ? 'supervised' : workExecutionClass(input.kind),
      currentAttemptToken: null,
      serializationKey: input.serializationKey ?? null,
      holdGroup,
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
      outcome: null, cancelRequestedAt: null,
    };
    workItems.push(item);
    ensureFollowup(item);
    return { ok: true, created: true, item: structuredClone(item) };
  }

  function ensureFollowup(item: WorkItem): void {
    const followup = [...extensionFollowups.values()].map(mapping => mapping[item.kind]).find(Boolean);
    if (!followup) return;
    const child = addWork({ id: globalThis.crypto.randomUUID(), kind: followup, targetKind: 'extension', targetId: item.id,
      createdAt: item.createdAt, nextAttemptAt: item.nextAttemptAt, holdGroup: item.holdGroup });
    if (child.ok && !workDependencies.some(edge => edge.workItemId === child.item.id && edge.prerequisiteId === item.id))
      workDependencies.push({ workItemId: child.item.id, prerequisiteId: item.id });
  }

  function closeDependents(rootId: string, outcome: 'failed' | 'cancelled' | 'dependency_failed', now: Date) {
    const closed = new Set([rootId]);
    for (;;) {
      const next = workItems.filter(item => item.completedAt === null && workDependencies.some(edge => edge.workItemId === item.id && closed.has(edge.prerequisiteId)));
      if (next.length === 0) return;
      for (const item of next) {
        item.completedAt = now; item.outcome = 'dependency_failed';
        item.lastError = dependencyFailedText(rootId, outcome); unclaim(item); closed.add(item.id);
      }
    }
  }

  function channelStatuses(): import('../../channels/store.js').ChannelPublicStatus[] {
    const current = [...channelRequests.values()].map(request => {
      const work = workItems.find(w => w.id === request.workItemId);
      const attempts = [...channelAttempts.values()].filter(a => a.requestId === request.id);
      const latest = attempts.at(-1)?.result;
      const unresolvedFailures = failures.filter(f => f.targetKind === 'channel_request' && f.targetId === request.id && f.stage === 'channel_send' && f.resolvedAt === null).length;
      return { id: request.id, legacy: false, createdAt: request.createdAt,
        delivery: request.status === 'sent' ? 'sent' as const : latest?.outcome ?? 'pending' as const,
        workState: !work ? 'unhanded' as const : work.completedAt ? 'closed' as const : work.currentAttemptToken ? 'running' as const : 'waiting' as const,
        attempts: attempts.length, nextAttemptAt: work && !work.completedAt ? work.nextAttemptAt : null, unresolvedFailures,
        resendEligible: request.status !== 'sent' && !!work?.completedAt && (unresolvedFailures > 0 || latest?.outcome === 'unknown' || latest?.outcome === 'definite_failed') };
    });
    const legacy: import('../../channels/store.js').ChannelPublicStatus[] = [...legacyRecords.values()].map(r => ({ id: r.id, legacy: true, createdAt: r.at, delivery: 'legacy', workState: 'legacy', attempts: 0, nextAttemptAt: null, unresolvedFailures: 0, resendEligible: false }));
    return structuredClone([...current, ...legacy].sort((a,b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id.localeCompare(b.id)));
  }
  return {
    async listChannelStatuses() { return { ok: true, requests: channelStatuses() }; },
    async readChannelStatus(id) { return { ok: true, request: channelStatuses().find(r => r.id === id) ?? null }; },
    async resendChannelRequest(input) {
      const request = channelRequests.get(input.requestId);
      if (!request) return { ok: false, code: [...legacyRecords.values()].some(r => r.id === input.requestId) ? 'CHANNEL_LEGACY_NOT_RESENDABLE' : 'CHANNEL_REQUEST_NOT_FOUND', message: '요청을 재전송할 수 없습니다' };
      if (request.status === 'sent') return { ok: false, code: 'CHANNEL_ALREADY_SENT', message: '이미 발신했습니다' };
      const status = channelStatuses().find(r => r.id === request.id)!;
      if (status.workState !== 'closed') return { ok: false, code: 'CHANNEL_REQUEST_IN_PROGRESS', message: '요청이 진행 중입니다' };
      if (!status.resendEligible) return { ok: false, code: 'CHANNEL_NOT_RESENDABLE', message: '재전송할 수 없는 요청입니다' };
      const work = addWork({ id: input.workId, kind: 'channel_send', targetKind: 'channel_request', targetId: request.id, createdAt: input.now, nextAttemptAt: input.now });
      if (!work.ok) return work;
      if (!work.created) return { ok: false, code: 'CHANNEL_REQUEST_IN_PROGRESS', message: '요청이 진행 중입니다' };
      request.workItemId = work.item.id;
      return { ok: true, workItemId: work.item.id };
    },
    async insertChannelLegacy(input) {
      const key = JSON.stringify([input.type, input.dataset, input.originalTable, input.originalKey]);
      const existing = legacyRecords.get(key);
      if (existing) {
        const original = (r: import('../../channels/store.js').ChannelLegacyInput | import('../../channels/store.js').ChannelLegacyRecord) => JSON.stringify(r.type === 'notification' ? [r.localDate, r.event, r.detail, r.at.toISOString()] : [r.originalId, r.localDate, r.kind, r.event, r.ok, r.reason, r.at.toISOString()]);
        if (original(existing) !== original(input)) return { ok: false, code: 'LEGACY_CONFLICT', message: 'legacy 원문 충돌' };
        return { ok: true, created: false, record: structuredClone(existing) };
      }
      if (!conversations.has(input.conversationId)) return { ok: false, code: 'DB_UNAVAILABLE', message: '대화가 없습니다' };
      const record = { ...structuredClone(input), externalMessageId: null, body: null, metadataMissing: true as const, resendEligible: false as const };
      legacyRecords.set(key, record);
      return { ok: true, created: true, record: structuredClone(record) };
    },
    async readChannelLegacy(input) {
      const record = legacyRecords.get(JSON.stringify([input.type, input.dataset, input.originalTable, input.originalKey]));
      return { ok: true, record: record ? structuredClone(record) : null };
    },
    async ensureChannel(input) {
      if (!channels.has(input.id)) channels.set(input.id, structuredClone(input));
      return { ok: true, channel: structuredClone(channels.get(input.id)!) };
    },
    async ensureChannelConversation(input) {
      if (!channels.has(input.channelId)) return { ok: false, code: 'DB_UNAVAILABLE', message: '채널이 없습니다' };
      if (!conversations.has(input.id)) conversations.set(input.id, structuredClone(input));
      return { ok: true, conversation: structuredClone(conversations.get(input.id)!) };
    },
    async createChannelRequest(input) {
      const existing = [...channelRequests.values()].find(r => r.producerResultId === input.producerResultId &&
        r.conversationId === input.conversationId && r.purpose === input.purpose && r.revision === input.revision);
      if (existing) return { ok: true, created: false, request: structuredClone(existing) };
      if (!conversations.has(input.conversationId) || channelRequests.has(input.id)) return { ok: false, code: 'DB_UNAVAILABLE', message: '요청을 만들 수 없습니다' };
      const request = { ...structuredClone(input), workItemId: null, status: 'pending' as const, externalMessageId: null };
      channelRequests.set(input.id, request);
      return { ok: true, created: true, request: structuredClone(request) };
    },
    async readChannelRequest(id) {
      const request = channelRequests.get(id);
      const conversation = request && conversations.get(request.conversationId);
      const channel = conversation && channels.get(conversation.channelId);
      return { ok: true, request: request ? structuredClone(request) : null,
        conversation: conversation ? structuredClone(conversation) : null, channel: channel ? structuredClone(channel) : null };
    },
    async listChannelItemResults(requestId) {
      return { ok: true, items: [...(channelItems.get(requestId) ?? new Map()).entries()].map(([index, result]) => ({ index, result: structuredClone(result) })) };
    },
    async recordChannelItemResult(input) {
      const request = channelRequests.get(input.requestId);
      const attempt = channelAttempts.get(input.attemptToken);
      if (!request?.bundle || input.index < 0 || input.index >= request.bundle.albums.length + 2 || request.workItemId !== input.workItemId || attempt?.requestId !== input.requestId || attempt.result !== null || !currentChannelAttempt(input.workItemId, input.attemptToken)) return { ok: true, outcome: 'lost' };
      const items = channelItems.get(input.requestId) ?? new Map();
      if (items.get(input.index)?.outcome === 'sent') return { ok: true, outcome: 'lost' };
      items.set(input.index, structuredClone(input.result)); channelItems.set(input.requestId, items);
      const tokens = channelItemTokens.get(input.requestId) ?? new Map();
      tokens.set(input.index, input.attemptToken); channelItemTokens.set(input.requestId, tokens);
      return { ok: true, outcome: 'done' };
    },
    async listUnhandedChannelRequests() {
      return { ok: true, requestIds: [...channelRequests.values()].filter(r => r.workItemId === null)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id)).map(r => r.id) };
    },
    async handoffChannelRequest(input) {
      const request = channelRequests.get(input.requestId);
      if (!request) return { ok: true, workItemId: null };
      if (!request.workItemId) {
        const work = addWork({ id: input.workId, kind: 'channel_send', targetKind: 'channel_request',
          targetId: request.id, createdAt: input.now, nextAttemptAt: input.now });
        if (!work.ok) return work;
        request.workItemId = work.item.id;
      }
      return { ok: true, workItemId: request.workItemId };
    },
    async gateChannelAttempt(input) {
      const request = channelRequests.get(input.requestId);
      if (request?.workItemId !== input.workItemId || !currentChannelAttempt(input.workItemId, input.attemptToken)) return { ok: true, outcome: 'lost' };
      if (request.status === 'sent') return { ok: true, outcome: 'sent' };
      if (channelAttempts.has(input.attemptToken)) return { ok: true, outcome: 'already' };
      if (!channelGates.has(input.requestId)) channelGates.set(input.requestId, { workItemId: input.workItemId, attemptToken: input.attemptToken });
      channelAttempts.set(input.attemptToken, { requestId: input.requestId, result: null });
      return { ok: true, outcome: 'won' };
    },
    async finishChannelAttempt(input) {
      const request = channelRequests.get(input.requestId);
      const attempt = channelAttempts.get(input.attemptToken);
      if (!request || request.status === 'sent' || request.workItemId !== input.workItemId || attempt?.requestId !== input.requestId || attempt.result !== null || !currentChannelAttempt(input.workItemId, input.attemptToken)) return { ok: true, outcome: 'lost' };
      const result = 'result' in input ? input.result : { outcome: 'sent' as const, externalMessageId: input.externalMessageId };
      attempt.result = result;
      if (result.outcome === 'sent') { request.status = 'sent'; request.externalMessageId = result.externalMessageId; }
      return { ok: true, outcome: 'done' };
    },
    async recoverChannelAttempt(input) {
      const work = workItems.find(w => w.id === input.workItemId && w.kind === 'channel_send' && w.targetId === input.requestId && w.currentAttemptToken === input.attemptToken && w.completedAt === null);
      const owner = workAttempts.find(a => a.token === input.attemptToken && (a.outcome === null || a.outcome === 'unknown'));
      if (!work || !owner) return { ok: true, outcome: 'lost' };
      const attempt = channelAttempts.get(input.attemptToken);
      const request = channelRequests.get(input.requestId);
      const items = channelItems.get(input.requestId);
      if (request?.bundle && request.workItemId === input.workItemId && request.status === 'pending' && attempt?.requestId === input.requestId && attempt.result === null && items) {
        const total = request.bundle.albums.length + 2;
        const complete = Array.from({ length: total }, (_, index) => items.get(index));
        const last = complete.at(-1);
        if (complete.every(result => result?.outcome === 'sent') && last?.outcome === 'sent') {
          attempt.result = structuredClone(last); request.status = 'sent'; request.externalMessageId = last.externalMessageId;
          return { ok: true, outcome: 'ready', result: structuredClone(last) };
        }
        const tokens = channelItemTokens.get(input.requestId);
        const failure = [...items.entries()].sort(([a], [b]) => a - b).find(([index, result]) => tokens?.get(index) === input.attemptToken && result.outcome !== 'sent')?.[1];
        if (failure) { attempt.result = structuredClone(failure); return { ok: true, outcome: 'ready', result: structuredClone(failure) }; }
      }
      if (attempt?.requestId === input.requestId && attempt.result === null) {
        const unknown = { outcome: 'unknown' as const, code: 'INTERRUPTED', retryable: true };
        if (owner.outcome === null) attempt.result = unknown;
        return { ok: true, outcome: 'ready', result: unknown };
      }
      return { ok: true, outcome: 'ready', result: attempt?.requestId === input.requestId ? attempt.result : null };
    },
    ...memorySettingsStore(),
    async readConversationSnapshot(sessionId) {
      if (![...sessions.values()].some(s => s.id === sessionId)) return { ok: true, snapshot: null };
      const rows = conversationMessages(sessionId);
      return { ok: true, snapshot: { config: conversationConfig, messages: rows, fingerprint: conversationFingerprint(conversationConfig, rows) } };
    },
    async commitConversationChunks(input) {
      const item = workItems.find(w => w.id === input.workId && w.kind === 'conversation_chunk' && w.targetKind === 'session' && w.targetId === input.sessionId && w.claimedBy === input.claimedBy && w.completedAt === null && w.claimExpiresAt !== null && w.claimExpiresAt > input.now);
      if (!item || conversationFingerprint(conversationConfig, conversationMessages(input.sessionId)) !== input.fingerprint) return { ok: true, committed: false };
      const old = conversationChunks.filter(c => c.sessionId === input.sessionId);
      const next = input.chunks.map(c => ({ ...c, sessionId: input.sessionId, id: old.find(o => o.fromAt.getTime() === c.fromAt.getTime() && o.toAt.getTime() === c.toAt.getTime() && o.part === c.part && o.body === c.body)?.id ?? c.id }));
      for (let i = conversationChunks.length - 1; i >= 0; i--) if (conversationChunks[i]!.sessionId === input.sessionId) conversationChunks.splice(i, 1);
      conversationChunks.push(...next);
      return { ok: true, committed: true };
    },
    async searchRecall(input) {
      const needle = input.query.replaceAll('\0', '�').toLowerCase();
      const rows: import('../../ports/recall-store.js').RecallRow[] = [];
      for (const [token, session] of sessions) {
        const source = { kind: 'conversation' as const, workspace_id: session.workspaceId, tag_source: session.tagSource, session: token, harness: session.harness, started_at: session.startedAt.toISOString(), project_id: session.projectId, worktree_id: session.worktreeId };
        if (input.kind === 'chunks') for (const chunk of conversationChunks.filter(c => c.sessionId === session.id && c.body.replaceAll('\0', '�').toLowerCase().includes(needle))) rows.push({ ...source, chunk_id: chunk.id, from_at: chunk.fromAt.toISOString(), to_at: chunk.toAt.toISOString(), body: chunk.body });
        if (input.kind === 'tools') for (const note of toolNotes.get(token) ?? []) {
          if (!note.target.replaceAll('\0', '�').toLowerCase().includes(needle)) continue;
          const message = (messages.get(token) ?? []).find(m => m.harnessMessageId === note.harnessMessageId);
          rows.push({ ...source, tool_note_id: note.id, message_id: message?.id ?? null, tool: note.tool, from_at: message?.occurredAt.toISOString() ?? null, to_at: message?.occurredAt.toISOString() ?? null, body: note.target });
        }
      }
      const tier = (row: import('../../ports/recall-store.js').RecallRow) => input.worktree && input.worktree === row.worktree_id ? 0 : input.project && input.project === row.project_id ? 1 : 2;
      const matches = (body: string) => body.replaceAll('\0', '�').toLowerCase().split(needle).length - 1;
      rows.sort((a,b) => tier(a) - tier(b) || matches(b.body) - matches(a.body) || (b.from_at ?? '').localeCompare(a.from_at ?? '') || (a.chunk_id ?? a.tool_note_id ?? '').localeCompare(b.chunk_id ?? b.tool_note_id ?? ''));
      return { ok: true, rows: rows.slice(0, input.limit) };
    },
    async searchConversationChunks({ pattern }) {
      const literal = pattern.slice(1, -1).replaceAll('\0', '�').replace(/\\([\\%_])/g, '$1').toLowerCase();
      return { ok: true, chunks: structuredClone(conversationChunks.filter(c => c.body.replaceAll('\0', '�').toLowerCase().includes(literal))) };
    },
    async listExtensionInventory() { return { ok: true, names: [...new Set([...extensions.keys(), ...installProgress.keys()])].sort() }; },
    async getExtensionPublicStatus(name) {
      const group = `extension:${name}`;
      const held = heldGroups.has(group);
      return { ok: true, status: structuredClone(extensionPublicProjection(name, extensions.get(name) ?? null, installProgress.get(name)?.progress ?? null,
        held ? [...schedules.values()].filter(row => row.holdGroup === group).length : 0,
        held ? workItems.filter(row => row.holdGroup === group && row.completedAt === null).length : 0, pythonEnvironments.get(name) ?? null)) };
    },
    async setExtensionEnabled({ name, enabled, now }) {
      const row = extensions.get(name);
      if (!row) return { ok: true, found: false, changed: false };
      const changed = row.enabled !== enabled;
      if (changed) { row.enabled = enabled; row.enabledChangedAt = new Date(now); }
      const group = `extension:${name}`;
      if (enabled) heldGroups.delete(group); else if (!heldGroups.has(group)) heldGroups.set(group, new Date(now));
      return { ok: true, found: true, changed };
    },
    async getExtensionInstallProgress(name) { return { ok: true, journal: structuredClone(installProgress.get(name) ?? null) }; },
    async writeExtensionInstallProgress({ expectedRevision, progress }) {
      if (!validInstallProgress(progress) || !(expectedRevision === null || (Number.isSafeInteger(expectedRevision) && expectedRevision > 0 && expectedRevision < 2147483647))) return { ok: false, code: 'INVALID_INSTALL_PROGRESS', message: '잘못된 설치 진행 기록입니다' };
      const existing = installProgress.get(progress.name);
      if ((existing?.revision ?? null) !== expectedRevision) return { ok: true, written: false, revision: existing?.revision ?? null };
      const revision = (existing?.revision ?? 0) + 1;
      installProgress.set(progress.name, structuredClone({ revision, progress }));
      return { ok: true, written: true, revision };
    },
    async recordExtensionPythonEnvironment({ name, ...environment }) { pythonEnvironments.set(name, structuredClone(environment)); return { ok: true }; },
    async getExtensionPythonEnvironment(name) { return { ok: true, environment: structuredClone(pythonEnvironments.get(name) ?? null) }; },
    async recordExtensionInstall({ name, version, now, workKinds, workFollowups }) {
      extensionWorkKinds.set(name, workKinds ?? []);
      extensionFollowups.set(name, workFollowups ?? {});
      for (const item of [...workItems]) if (item.completedAt === null && (workKinds ?? []).includes(item.kind)) ensureFollowup(item);
      const existing = extensions.get(name);
      if (existing) existing.version = version;
      else extensions.set(name, { name, version, installedAt: new Date(now), enabled: true, enabledChangedAt: new Date(now), connectionStatus: null, connectionCheckedAt: null, connectionCode: null, connectionMessage: null });
      return { ok: true };
    },
    async recordExtensionConnection({ name, status, code, message, checkedAt }) {
      const row = extensions.get(name);
      if (!row) return { ok: false, code: 'DB_UNAVAILABLE', message: '설치 기록이 없습니다' };
      Object.assign(row, { connectionStatus: status, connectionCode: code, connectionMessage: message, connectionCheckedAt: new Date(checkedAt) });
      return { ok: true };
    },
    async enqueueExtensionWork({ name, version, work }) {
      const row = extensions.get(name);
      if (!row) return { ok: true, state: 'missing' };
      if (row.version !== version) return { ok: true, state: 'changed' };
      if (!row.enabled) return { ok: true, state: 'disabled' };
      if (!extensionWorkKinds.get(name)?.includes(work.kind)) return { ok: true, state: 'changed' };
      const predecessors = Object.entries(extensionFollowups.get(name) ?? {}).filter(([, next]) => next === work.kind).map(([kind]) => kind);
      const candidates = workItems.filter(item => predecessors.includes(item.kind) && item.targetKind === work.targetKind && item.targetId === work.targetId && (item.completedAt === null || item.outcome === 'succeeded'))
        .sort((a,b) => Number(a.completedAt !== null) - Number(b.completedAt !== null) || b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
      if (predecessors.length && !candidates.length) return { ok: true, state: 'changed' };
      const parent = candidates[0];
      const result = addWork(parent ? { ...work, targetId: parent.id } : work);
      if (result.ok && parent && !workDependencies.some(edge => edge.workItemId === result.item.id && edge.prerequisiteId === parent.id)) workDependencies.push({ workItemId: result.item.id, prerequisiteId: parent.id });
      return result.ok ? { ok: true, state: 'queued', workId: result.item.id, created: result.created } : result;
    },
    async getExtension(name) { return { ok: true, extension: structuredClone(extensions.get(name) ?? null) }; },
    async listExtensions() { return { ok: true, extensions: structuredClone([...extensions.values()].sort((a, b) => a.name < b.name ? -1 : 1)) }; },
    async holdWorkGroup({ group, now }) {
      if (!validHoldGroup(group)) return invalidGroup;
      const held = !heldGroups.has(group);
      if (held) heldGroups.set(group, new Date(now));
      return { ok: true, held };
    },
    async releaseWorkGroup({ group }) {
      const extension = group.startsWith('extension:') ? extensions.get(group.slice('extension:'.length)) : undefined;
      return { ok: true, released: extension?.enabled === false ? false : heldGroups.delete(group) };
    },
    async listSchedules({ limit }) {
      const rows = [...schedules.values()].sort((a,b) => a.createdAt.getTime()-b.createdAt.getTime() || a.id.localeCompare(b.id));
      return { ok: true, schedules: structuredClone(rows.slice(0, limit).map(row => ({ ...row, held: isHeld(row.holdGroup) }))), hasMore: rows.length > limit };
    },
    async removeSchedule({ id }) {
      const removed = schedules.delete(id);
      for (const item of workItems) if (item.scheduledDates?.scheduleId === id) item.scheduledDates.scheduleId = null;
      for (const [key, row] of scheduleSuccesses) if (row.scheduleId === id) scheduleSuccesses.delete(key);
      return { ok: true, removed };
    },
    async getWork(id) {
      const item = workItems.find(value => value.id === id);
      const latestAttempt = workAttempts.filter(a => a.workItemId === id).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.token.localeCompare(a.token))[0] ?? null;
      return { ok: true, entry: item ? structuredClone({ item, latestAttempt }) : null };
    },
    async listWork({ includeClosed, kind, limit }) {
      const rows = workItems.filter(i => (includeClosed || i.completedAt === null) && (kind === undefined || i.kind === kind))
        .sort((a,b) => b.createdAt.getTime()-a.createdAt.getTime() || b.id.localeCompare(a.id));
      return { ok: true, entries: structuredClone(rows.slice(0, limit).map(item => ({ item, held: isHeld(item.holdGroup), currentAttempt: workAttempts.find(a => a.workItemId === item.id && a.token === item.currentAttemptToken) ?? null, latestAttempt: workAttempts.filter(a => a.workItemId === item.id)
        .sort((a,b) => b.startedAt.getTime()-a.startedAt.getTime() || b.token.localeCompare(a.token))[0] ?? null }))), hasMore: rows.length > limit };
    },
    async readModelWorkUsage({ kinds }) {
      const rows = workAttempts.filter(a => workItems.some(i => i.id === a.workItemId && kinds.includes(i.kind)))
        .sort((a,b) => b.startedAt.getTime()-a.startedAt.getTime() || b.token.localeCompare(a.token));
      const latest = rows[0];
      return { ok: true, usage: { inputTokens: rows.reduce((n,a) => n+(a.inputTokens ?? 0),0),
        cachedInputTokens: rows.reduce((n,a) => n+(a.cachedInputTokens ?? 0),0), outputTokens: rows.reduce((n,a) => n+(a.outputTokens ?? 0),0),
        elapsedMs: rows.reduce((n,a) => n+(a.elapsedMs ?? 0),0), latest: latest ? { workItemId: latest.workItemId,
          kind: workItems.find(i => i.id === latest.workItemId)!.kind, at: new Date(latest.startedAt), elapsedMs: latest.elapsedMs, usage: attemptUsage(latest) } : null } };
    },
    async findDailySchedule(input) { const schedule = [...schedules.values()].find(s => s.localTime !== null && s.kind === input.kind && s.targetKind === input.targetKind && s.targetId === input.targetId); return { ok: true, schedule: schedule ? cloneSchedule(schedule) : null }; },
    async readSchedule({ id }) { return { ok: true, schedule: schedules.has(id) ? cloneSchedule(schedules.get(id)!) : null }; },
    async listDailySchedules({ limit }) {
      return { ok: true, schedules: [...schedules.values()].filter(row => row.localTime !== null).sort((a, b) => a.id < b.id ? -1 : 1).slice(0, limit).map(cloneSchedule) };
    },
    async rezoneSchedule(input) {
      const row = schedules.get(input.id);
      if (!row || row.nextRunAt?.getTime() !== input.expectedNextRunAt.getTime() || row.timeZone !== input.expectedTimeZone) return { ok: true, updated: false };
      row.timeZone = input.timeZone; row.nextRunAt = new Date(input.nextRunAt);
      return { ok: true, updated: true };
    },
    async listScheduleSuccesses({ scheduleId }) {
      return { ok: true, successes: [...scheduleSuccesses.values()].filter(row => row.scheduleId === scheduleId)
        .sort((a, b) => a.localDate.localeCompare(b.localDate)).map(({ scheduleId: _, ...row }) => ({ ...row, recordedAt: new Date(row.recordedAt) })) };
    },
    async addSchedule(input) {
      const holdGroup = workHoldGroup(input.kind, input.holdGroup);
      if (!validHoldGroup(holdGroup)) return invalidGroup;
      if (input.localTime !== null && [...schedules.values()].some(row => row.localTime !== null && row.kind === input.kind && row.targetKind === input.targetKind && row.targetId === input.targetId))
        return { ok: false, code: 'SCHEDULE_CONFLICT', message: '같은 대상의 매일 예약이 있습니다' };
      if ((input.localTime === null) !== (input.timeZone === null) || (input.localTime !== null && (!isLocalTime(input.localTime) || input.intervalSeconds !== null || input.nextRunAt === null)))
        return { ok: false, code: 'DB_UNAVAILABLE', message: '잘못된 예약입니다' };
      if (schedules.has(input.id) || (input.intervalSeconds !== null &&
        (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0 || input.nextRunAt === null)) ||
        [input.createdAt, input.nextRunAt, input.lastRunAt].some(at => at !== null && !formatInstant(at).ok))
        return { ok: false, code: 'DB_UNAVAILABLE', message: '잘못된 예약입니다' };
      const normalized = { ...input, holdGroup };
      schedules.set(input.id, cloneSchedule(normalized));
      return { ok: true, schedule: cloneSchedule(normalized) };
    },
    async listDueSchedules({ now, limit }) {
      return { ok: true, schedules: [...schedules.values()]
        .filter(row => !isHeld(row.holdGroup) && row.nextRunAt !== null && row.nextRunAt <= now)
        .sort((a, b) => a.nextRunAt!.getTime() - b.nextRunAt!.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit).map(row => cloneSchedule(row)) };
    },
    async fireSchedule(input) {
      const row = schedules.get(input.scheduleId);
      if (!row || isHeld(row.holdGroup) || row.nextRunAt?.getTime() !== input.expectedNextRunAt.getTime() ||
        row.timeZone !== (input.localDates?.timeZone ?? null)) return { ok: true, fired: false };
      if ((row.intervalSeconds !== null && input.nextRunAt === null) ||
        [input.now, input.nextRunAt, input.work.createdAt, input.work.nextAttemptAt].some(at => at !== null && !formatInstant(at).ok))
        return { ok: false, code: 'DB_UNAVAILABLE', message: '잘못된 예약 발화입니다' };
      let workInput = { ...input.work, holdGroup: row.holdGroup };
      if (input.localDates) {
        const missing: string[] = [];
        for (let date = input.localDates.from; date <= input.localDates.to; date = addLocalDays(date, 1))
          if (!scheduleSuccesses.has(`${row.id}/${date}`)) missing.push(date);
        if (!missing.length) {
          row.lastRunAt = new Date(input.now); row.nextRunAt = input.nextRunAt === null ? null : new Date(input.nextRunAt);
          return { ok: true, fired: true, created: false, covered: true };
        }
        workInput = { ...workInput, scheduledDates: { scheduleId: row.id, from: missing[0]!, to: missing[missing.length - 1]!, timeZone: input.localDates.timeZone } };
      }
      const work = addWork(workInput);
      if (!work.ok) return work;
      row.lastRunAt = new Date(input.now);
      row.nextRunAt = input.nextRunAt === null ? null : new Date(input.nextRunAt);
      return { ok: true, fired: true, created: work.created, covered: false };
    },
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

      if (input.identityWork !== null) {
        const work = addWork(input.identityWork);
        if (!work.ok) return work;
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
        firstCwd: input.firstCwd,
        tagSource: input.tagSource,
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
        let chunksRemoved = 0;
        if (plan.redactions.length) {
          for (let i = conversationChunks.length - 1; i >= 0; i--) { const c = conversationChunks[i]!; if (c.sessionId === message.sessionId && c.fromAt <= message.occurredAt && c.toAt >= message.occurredAt) conversationChunks.splice(i, 1), chunksRemoved++; }
          enqueueConversation(message.sessionId, plan.redactions[0]!.occurredAt);
        }
        const unredactedAttachments = (attachmentRows.get(message.id) ?? [])
          .filter((row) => row.status === 'stored' && row.file !== null && !fileRedacted(row.file.id)).length;
        return { ok: true, sessionId: message.sessionId, bodySpans: plan.bodySpans,
          toolNoteSpans: plan.toolNoteSpans, toolNotesChanged: plan.toolNotes.length, chunksRemoved,
          unredactedAttachments };
      }
      return { ok: false, code: 'MESSAGE_NOT_FOUND', message: '지정한 메시지가 없습니다' };
    },

    async fillSessionTags(input: FillSessionTagsInput): Promise<FillSessionTagsResult> {
      const session = sessions.get(formatSessionToken(input.key));
      if (session === undefined) {
        return { ok: false, code: 'SESSION_NOT_FOUND', message: '세션을 찾을 수 없습니다' };
      }
      session.firstCwd ??= input.firstCwd;
      if (input.checkout === null || session.projectId !== null || session.worktreeId !== null) {
        return { ok: true, filled: false, session: { ...session } };
      }
      Object.assign(session, checkoutTags(input.checkout), { tagSource: input.tagSource });
      return { ok: true, filled: true, session: { ...session } };
    },

    async listStaleSessions(query) {
      return { ok: true, sessions: [...sessions.values()]
        .filter((session) => session.harness === query.harness && session.parserVersion !== query.parserVersion)
        .map((session) => ({ harnessSessionId: session.harnessSessionId })) };
    },
    async listIdentityCandidates() {
      return { ok: true, sessions: [...sessions.values()].filter((session) =>
        session.projectId === null && session.firstCwd === null &&
        !workItems.some((item) => item.kind === 'session_identity' && item.targetKind === 'session' &&
          item.targetId === formatSessionToken(session))).map((session) => ({ ...session })) };
    },
    async countUntaggedSessions() {
      return { ok: true, count: [...sessions.values()].filter((session) => session.projectId === null).length };
    },
    async findSession(key: SessionKey): Promise<FindSessionResult> {
      const existing = sessions.get(formatSessionToken(key));
      // A key no session has is `null` and not a failure: that is the state of
      // every session before its first ingest.
      return { ok: true, session: existing === undefined ? null : { ...existing } };
    },

    async listMissingFileNames({ limit }) {
      const names: import('../../ports/store.js').MissingFileName[] = [];
      const add = (fileId: string, nameSource: 'attachment_name' | 'location_path', text: string) => {
        if (![...fileNames, ...names].some(n => n.fileId === fileId && n.nameSource === nameSource && n.text === text)) names.push({ fileId, nameSource, text });
      };
      // A masked file never gets a name back (0008's triggers, said here as the
      // candidate never being offered).
      for (const rows of attachmentRows.values()) for (const a of rows) {
        if (a.file === null || fileRedacted(a.file.id)) continue;
        if (a.displayName !== null) add(a.file.id, 'attachment_name', a.displayName);
      }
      for (const file of fileRows.values()) {
        if (fileRedacted(file.id)) continue;
        for (const l of file.locations) {
          if (l.storeKind === 'local' && l.ownership === 'external') add(file.id, 'location_path', l.locator);
        }
      }
      return { ok: true, names: names.slice(0, limit) };
    },
    async writeFileNames({ names }) {
      let inserted = 0;
      for (const name of names) {
        // Skipped and not refused, exactly as the adapter's `insert … select …
        // where redacted_at is null` writes no row and counts none.
        if (fileRedacted(name.fileId)) continue;
        if (fileNames.some(n => n.fileId === name.fileId && n.nameSource === name.nameSource && n.text === name.text)) continue;
        fileNames.push({ ...name });
        inserted++;
      }
      return { ok: true, inserted };
    },
    async listFileNames(fileId) {
      return { ok: true, names: fileNames.filter(n => n.fileId === fileId).map(n => ({ ...n })) };
    },
    async readFileLocation(id) {
      const row = fileLocationRows.find(l => l.id === id);
      if (row === undefined) return { ok: false, code: 'FILE_LOCATION_NOT_FOUND', message: '파일 위치가 없습니다' };
      return { ok: true, location: { ...row } };
    },
    async listFileLocations(fileId) {
      // Code-unit order and not `localeCompare`, because `order by ownership,
      // locator` on a `text` column is BINARY in SQLite: a locale that sorts
      // `~/Project/b` before `~/project/a` would make the fake and the adapter
      // answer differently, and the contract case pins exactly that pair.
      const by = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      return { ok: true, locations: fileLocationRows.filter(l => l.fileId === fileId)
        .sort((a,b) => by(a.ownership, b.ownership) || by(a.locator, b.locator))
        .map(l => ({ ...l })) };
    },
    async markFileLocationDeleted({ id, deletedAt }) {
      const row = fileLocationRows.find(l => l.id === id);
      if (row === undefined) return { ok: false, code: 'FILE_LOCATION_NOT_FOUND', message: '파일 위치가 없습니다' };
      // The one-way fill of 0002: the first call writes it and every later one
      // hands back what the row already says.
      if (row.deletedAt !== null) return { ok: true, deletedAt: row.deletedAt, marked: false };
      row.deletedAt = deletedAt;
      return { ok: true, deletedAt, marked: true };
    },
    async readFileSharing(ref) {
      const file = 'fileId' in ref
        ? fileById(ref.fileId)
        : fileRows.get(ref.contentHash);
      if (file === undefined) return { ok: false, code: 'FILE_NOT_FOUND', message: '지정한 파일이 없습니다' };
      // Distinct messages: the same file twice on one message is one
      // conversation that loses it.
      const messages = [...attachmentRows.entries()]
        .filter(([, rows]) => rows.some((row) => row.file?.id === file.id)).length;
      return { ok: true, file: { id: file.id, contentHash: file.contentHash,
        redactedAt: fileRedactedAt.get(file.id) ?? null }, messages };
    },
    async listRedactedContentHashes(hashes) {
      const wanted = new Set(hashes);
      return { ok: true, hashes: [...fileRows.values()]
        .filter((file) => wanted.has(file.contentHash) && fileRedacted(file.id))
        .map((file) => file.contentHash) };
    },
    async redactFile(input) {
      const file = fileById(input.fileId);
      if (file === undefined) return { ok: false, code: 'FILE_NOT_FOUND', message: '지정한 파일이 없습니다' };
      const redactedAt = fileRedactedAt.get(file.id) ?? null;
      const plan = input.plan({
        file: { id: file.id, contentHash: file.contentHash, redactedAt },
        locations: fileLocationRows.filter((row) => row.fileId === file.id).map((row) => ({ ...row })),
      });
      const record = redactedAt === null ? plan.redaction : null;
      let extractionsRemoved = 0;
      let chunksRemoved = 0;
      let namesRemoved = 0;
      let failuresResolved = 0;
      if (record !== null) {
        fileRedactedAt.set(file.id, record.occurredAt);
        currentExtractions.delete(file.id);
        // The closed generations go with their pieces; the open one keeps its
        // row and loses its pieces, so its worker's own `finishExtraction`
        // closes it `redacted` (port contract).
        for (const extraction of extractions.filter((row) => row.fileId === file.id)) {
          chunksRemoved += chunksOf(extraction.id).length;
          documentChunks.set(extraction.id, []);
          if (extraction.finishedAt !== null) {
            documentChunks.delete(extraction.id);
            extractions.splice(extractions.indexOf(extraction), 1);
            extractionsRemoved += 1;
          }
        }
        for (const name of fileNames.filter((row) => row.fileId === file.id)) {
          fileNames.splice(fileNames.indexOf(name), 1);
          namesRemoved += 1;
        }
        fileRedactions.push({ ...record });
        for (const failure of failures) {
          if (failure.targetKind !== FILE_REDACTION_RESOLVES.targetKind) continue;
          if (failure.targetId !== file.id || failure.stage !== FILE_REDACTION_RESOLVES.stage) continue;
          if (failure.resolvedAt !== null) continue;
          failure.resolvedAt = record.occurredAt;
          failuresResolved += 1;
        }
      }
      for (const work of plan.work) addWork(work);
      const messages = [...attachmentRows.entries()]
        .filter(([, rows]) => rows.some((row) => row.file?.id === file.id)).length;
      return {
        ok: true,
        fileId: file.id,
        contentHash: file.contentHash,
        messages,
        alreadyRedacted: redactedAt !== null,
        extractionsRemoved,
        chunksRemoved,
        namesRemoved,
        // This fake holds no `file_metadata`, so there is never a row to take.
        metadataRemoved: 0,
        blobDeletesQueued: plan.work.length,
        failuresResolved,
      };
    },
    async listMessageAttachments(messageId) {
      return { ok: true, attachments: (attachmentRows.get(messageId) ?? []).slice().sort((a,b) => a.ordinal - b.ordinal).map(a => ({ ...a, file: a.file === null ? null : { ...a.file, locations: a.file.locations.map(l => ({ ...l })), home: a.file.home === null ? null : { ...a.file.home } } })) };
    },
    async linkAttachments(input) {
      const token = formatSessionToken(input.key);
      if (!sessions.has(token)) return { ok: false, code: 'SESSION_NOT_FOUND', message: '세션이 없습니다' };
      const held = messages.get(token) ?? [];
      if (input.attachments.some(a => !held.some(m => m.harnessMessageId === a.harnessMessageId))) return { ok: false, code: 'MESSAGE_NOT_FOUND', message: '메시지가 없습니다' };
      return { ok: true, linked: link(input.attachments, held) };
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

      link(batch.attachments, storedMessages);

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
      // (the PostgreSQL baseline). `sort` is stable, which is this fake's answer to two
      // messages of one instant: it keeps the order they went in, and promises
      // nothing about it — a case that depended on it would be a case the
      // PostgreSQL store is free to fail.
      storedMessages.sort(
        (left, right) => left.occurredAt.getTime() - right.occurredAt.getTime(),
      );
      messages.set(token, storedMessages);
      if (insertedMessages > 0) enqueueConversation(session.id, batch.tracking.ingestedAt);
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

    async beginExtraction(input: BeginExtractionInput): Promise<BeginExtractionResult> {
      if (fileById(input.fileId) === undefined) {
        return { ok: false, code: 'FILE_NOT_FOUND', message: '파일이 없습니다' };
      }
      // A masked file never gets another generation, which is half of why
      // `attempt` cannot go backwards (port contract).
      if (fileRedacted(input.fileId)) {
        return { ok: false, code: 'FILE_REDACTED', message: '가린 파일은 다시 읽지 않습니다' };
      }
      if (!holdsExtractionClaim(input)) {
        return { ok: false, code: 'CLAIM_LOST', message: '추출 청구가 더 이상 이 호출자의 것이 아닙니다' };
      }

      // A file has one open generation at a time, so any generation still open
      // here is closed before the new one opens (AD-24). Usually it belongs to a
      // claim that expired; a caller beginning twice under its own live claim
      // gets the same treatment, which is why the sentence names the new begin
      // and not the expiry.
      let closedStale: DocumentExtraction | null = null;
      const stale = openExtraction(input.fileId);
      if (stale !== undefined) {
        stale.status = 'failed';
        stale.finishedAt = input.startedAt;
        stale.error = STALE_EXTRACTION_ERROR;
        // Read before the pieces go, because the pieces are what it is read from.
        stale.failedStage = staleStage(stale);
        documentChunks.set(stale.id, []);
        closedStale = { ...stale };
      }

      const attempt =
        Math.max(
          0,
          ...extractions
            .filter((extraction) => extraction.fileId === input.fileId)
            .map((extraction) => extraction.attempt),
        ) + 1;
      const extraction: DocumentExtraction = {
        id: input.id,
        fileId: input.fileId,
        extractorVersion: input.extractorVersion,
        attempt,
        mediaType: null,
        status: null,
        startedAt: input.startedAt,
        finishedAt: null,
        error: null,
        failedStage: null,
        indexConfigId: null,
      };
      extractions.push(extraction);
      documentChunks.set(extraction.id, []);
      return { ok: true, extraction: { ...extraction }, closedStale };
    },

    async appendExtractionChunks(
      input: AppendExtractionChunksInput,
    ): Promise<AppendExtractionChunksResult> {
      const extraction = extractionById(input.extractionId);
      if (extraction === undefined) {
        return { ok: false, code: 'EXTRACTION_NOT_FOUND', message: '추출 세대가 없습니다' };
      }
      if (extraction.finishedAt !== null) {
        return { ok: false, code: 'EXTRACTION_CLOSED', message: '추출 세대가 이미 닫혔습니다' };
      }
      if (fileRedacted(extraction.fileId)) {
        return { ok: false, code: 'FILE_REDACTED', message: '가린 파일의 조각은 쓰지 않습니다' };
      }
      const held = chunksOf(input.extractionId);
      const checked = checkExtractionChunkBatch(input.chunks, {
        ordinals: new Set(held.map((chunk) => chunk.ordinal)),
        ids: new Set(held.map((chunk) => chunk.id)),
      });
      if (!checked.ok) return checked;
      // `document_chunks.id` is unique across every generation, so an id that
      // belongs to another one is the caller reusing an id, which a real adapter
      // throws on. The fake throws too rather than keeping two rows with one id.
      for (const chunk of checked.chunks) {
        for (const [otherId, rows] of documentChunks) {
          if (otherId === input.extractionId) continue;
          if (rows.some((row) => row.id === chunk.id)) {
            throw new Error(`조각 id가 다른 세대에 이미 있습니다: ${chunk.id}`);
          }
        }
      }
      documentChunks.set(input.extractionId, [
        ...held,
        ...checked.chunks.map((chunk) => ({
          id: chunk.id,
          extractionId: input.extractionId,
          ordinal: chunk.ordinal,
          page: chunk.page,
          body: chunk.body,
          chunkLocator: chunk.locator,
        })),
      ]);
      return { ok: true, appended: checked.chunks.length };
    },

    async finishExtraction(input: FinishExtractionInput): Promise<FinishExtractionResult> {
      const extraction = extractionById(input.extractionId);
      if (extraction === undefined) {
        return { ok: false, code: 'EXTRACTION_NOT_FOUND', message: '추출 세대가 없습니다' };
      }
      if (extraction.finishedAt !== null) {
        // A late answer from an attempt whose claim is long gone. Nothing moves.
        return { ok: false, code: 'EXTRACTION_CLOSED', message: '추출 세대가 이미 닫혔습니다' };
      }

      const { outcome } = input;
      const pointer = currentExtractions.get(extraction.fileId) ?? null;
      const currentAttempt = pointer === null ? 0 : (extractionById(pointer)?.attempt ?? 0);
      const redacted = fileRedacted(extraction.fileId);
      // The pointer may only move forward, and never onto a reading of a file
      // somebody masked while it ran (AD-24).
      const replaces = outcome.status === 'ok' && !redacted && extraction.attempt > currentAttempt;

      extraction.finishedAt = input.finishedAt;
      // A successful reading of a file that was masked while it ran is a
      // reading whose text may not be kept, and `redacted` says so.
      extraction.status = outcome.status === 'ok' && redacted ? 'redacted' : outcome.status;
      extraction.mediaType = outcome.mediaType;
      extraction.error = outcome.status === 'ok' ? null : outcome.error;
      extraction.failedStage = outcome.status === 'failed' ? outcome.failedStage : null;
      // Only on the reading that took over: a generation whose pieces are about
      // to be deleted has no chunking generation left to name.
      extraction.indexConfigId =
        outcome.status === 'ok' && replaces ? outcome.indexConfigId : null;

      if (replaces) {
        // Closed, then the pointer, then the older generations: the order the
        // triggers of 0008 can see (port contract).
        currentExtractions.set(extraction.fileId, extraction.id);
        const older = extractions.filter(
          (row) =>
            row.fileId === extraction.fileId && row.id !== extraction.id && row.finishedAt !== null,
        );
        for (const row of older) {
          documentChunks.delete(row.id);
          extractions.splice(extractions.indexOf(row), 1);
        }
      } else {
        // A reading that did not take over leaves no text behind, whatever it
        // had written before it stopped.
        documentChunks.set(extraction.id, []);
      }
      return { ok: true, extraction: { ...extraction }, current: replaces };
    },

    async setFileSourceUnreachable(
      input: SetFileSourceUnreachableInput,
    ): Promise<SetFileSourceUnreachableResult> {
      if (fileById(input.fileId) === undefined) {
        return { ok: false, code: 'FILE_NOT_FOUND', message: '파일이 없습니다' };
      }
      if (input.unreachableAt === null) sourceUnreachableAt.delete(input.fileId);
      else sourceUnreachableAt.set(input.fileId, input.unreachableAt);
      return { ok: true };
    },

    async readFileExtractionState(fileId: string): Promise<ReadFileExtractionStateResult> {
      const file = fileById(fileId);
      if (file === undefined) {
        return { ok: false, code: 'FILE_NOT_FOUND', message: '파일이 없습니다' };
      }
      const open = openExtraction(fileId);
      return {
        ok: true,
        fileId,
        contentHash: file.contentHash,
        sizeBytes: file.sizeBytes,
        home: file.home === null ? null : { ...file.home },
        redactedAt: fileRedactedAt.get(fileId) ?? null,
        sourceUnreachableAt: sourceUnreachableAt.get(fileId) ?? null,
        currentExtractionId: currentExtractions.get(fileId) ?? null,
        openExtraction: open === undefined ? null : { ...open },
        lastAttempt: Math.max(
          0,
          ...extractions
            .filter((extraction) => extraction.fileId === fileId)
            .map((extraction) => extraction.attempt),
        ),
      };
    },

    async listFilesAwaitingExtraction({
      limit,
    }: {
      limit: number;
    }): Promise<ListFilesAwaitingExtractionResult> {
      // Bytes to read, in reach, not masked, and no generation of any outcome:
      // the queue's input of `files/extract-work.ts`.
      const fileIds = [...fileRows.values()]
        .filter(
          (file) =>
            file.home !== null &&
            !fileRedacted(file.id) &&
            !sourceUnreachableAt.has(file.id) &&
            !extractions.some((extraction) => extraction.fileId === file.id),
        )
        .map((file) => file.id)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, limit);
      return { ok: true, fileIds };
    },

    async listFilesWithStaleExtraction({
      extractorVersion,
      limit,
    }: {
      extractorVersion: string;
      limit: number;
    }): Promise<ListFilesWithStaleExtractionResult> {
      // The pointer names a successful reading of some other version, and no
      // generation of the asked-for version exists at all — the second half is
      // what keeps a re-reading that failed from being queued every drain
      // (port contract).
      const behind = [...fileRows.values()].filter((file) => {
        const pointer = currentExtractions.get(file.id);
        if (pointer === undefined) return false;
        const current = extractions.find((extraction) => extraction.id === pointer);
        if (current === undefined || current.status !== 'ok') return false;
        if (current.extractorVersion === extractorVersion) return false;
        return !extractions.some(
          (extraction) =>
            extraction.fileId === file.id && extraction.extractorVersion === extractorVersion,
        );
      });
      const fileIds = behind
        .filter((file) => file.home !== null && !fileRedacted(file.id) && !sourceUnreachableAt.has(file.id))
        .map((file) => file.id)
        .sort((left, right) => left.localeCompare(right))
        .slice(0, limit);
      return {
        ok: true,
        fileIds,
        redacted: behind.filter((file) => fileRedacted(file.id)).length,
        // The masked ones are counted above and not again here, which is the
        // adapter's `redacted_at is null and source_unreachable_at is not null`.
        sourceUnreachable: behind.filter(
          (file) => !fileRedacted(file.id) && sourceUnreachableAt.has(file.id),
        ).length,
      };
    },

    async listExtractions(fileId: string): Promise<ListExtractionsResult> {
      return {
        ok: true,
        extractions: extractions
          .filter((extraction) => extraction.fileId === fileId)
          .sort((left, right) => left.attempt - right.attempt)
          .map((extraction) => ({ ...extraction })),
      };
    },

    async listExtractionChunks(extractionId: string): Promise<ListExtractionChunksResult> {
      return {
        ok: true,
        chunks: [...chunksOf(extractionId)]
          .sort((left, right) => left.ordinal - right.ordinal)
          .map((chunk) => ({ ...chunk })),
      };
    },

    async addWork(input: AddWorkInput): Promise<AddWorkResult> {
      return addWork(input);
    },

    async addWorkGraph({ nodes }) {
      if (nodes.some(node => !validHoldGroup(workHoldGroup(node.kind, node.holdGroup)))) return invalidGroup;
      const items: { created: boolean; item: WorkItem }[] = [];
      for (const node of nodes) {
        const result = addWork(node);
        if (!result.ok) return result;
        if (result.created) for (const index of new Set(node.after))
          workDependencies.push({ workItemId: result.item.id, prerequisiteId: items[index]!.item.id });
        items.push(result);
      }
      return { ok: true, items };
    },

    async hasDueWork(query: DueWorkQuery): Promise<HasDueWorkResult> {
      return { ok: true, due: candidates(workItems.filter(i => !isHeld(i.holdGroup)), query, workDependencies, 'core', workItems).length > 0 };
    },

    async claimWork(input: ClaimWorkInput): Promise<ClaimWorkResult> {
      const [next] = candidates(workItems.filter(i => !isHeld(i.holdGroup)), input, workDependencies, 'core', workItems);
      if (next === undefined) return { ok: true, item: null };

      // The attempt is raised by the claim and not by the outcome, so an item
      // that kills the worker holding it still counted once (Decision 1).
      next.attempts += 1;
      next.claimedAt = input.now;
      next.claimExpiresAt = new Date(input.now.getTime() + workKindPolicy(next.kind).claimForMs);
      next.claimedBy = input.claimedBy;
      if (next.scheduledDates) claimedDates.set(next.id, { from: next.scheduledDates.from, to: next.scheduledDates.to });
      return { ok: true, item: structuredClone(next) };
    },

    async readWorkAttemptHealth() {
      const health: import('../../ports/store.js').ReadWorkAttemptHealthResult & { ok: true } = { ok: true, health: {
        stalled: { count: 0, latest: null }, died: { count: 0, latest: null }, unknown: { count: 0, latest: null }, failed: { count: 0, latest: null },
      } };
      for (const item of workItems.filter(i => i.completedAt === null)) {
        const attempt = workAttempts.filter(a => a.workItemId === item.id).sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime() || b.token.localeCompare(a.token))[0];
        if (!attempt || !['stalled', 'died', 'unknown', 'failed'].includes(attempt.outcome ?? '')) continue;
        if (attempt.outcome === 'unknown' && item.currentAttemptToken !== attempt.token) continue;
        const group = health.health[attempt.outcome as import('../../ports/store.js').WorkAttemptHealthKind];
        const at = attempt.finishedAt ?? attempt.startedAt;
        group.count++;
        if (!group.latest || at > group.latest.at || (at.getTime() === group.latest.at.getTime() && item.id > group.latest.workItemId))
          group.latest = { workItemId: item.id, kind: item.kind, at, errorCode: attempt.errorCode, errorRetryable: attempt.errorRetryable, lastError: item.lastError };
      }
      return health;
    },
    async requestWorkCancel(input) {
      const item = workItems.find(i => i.id === input.id);
      if (!item) return { ok: true, state: 'not_found' };
      if (item.completedAt !== null) return { ok: true, state: 'already_closed' };
      item.cancelRequestedAt ??= input.now;
      if (item.currentAttemptToken !== null) return { ok: true, state: 'requested' };
      item.completedAt = input.now; item.outcome = 'cancelled'; unclaim(item);
      closeDependents(item.id, 'cancelled', input.now);
      return { ok: true, state: 'cancelled' };
    },
    async recordSupervisedProcess(input) {
      const item = workItems.find(i => i.id === input.id && i.currentAttemptToken === input.attemptToken);
      if (!item) return { ok: true, outcome: 'lost' };
      const attempt = workAttempts.find(a => a.token === input.attemptToken)!;
      if (attempt.outcome !== null) return { ok: true, outcome: 'lost' };
      Object.assign(attempt, { pid: input.pid, pgid: input.pgid, osBootAt: input.osBootAt, osStartedAt: input.osStartedAt });
      return { ok: true, outcome: 'done' };
    },
    async listOpenSupervisedAttempts() {
      return { ok: true, attempts: workAttempts.flatMap(a => {
        const item = workItems.find(i => i.currentAttemptToken === a.token);
        return !item || (a.outcome !== null && !(item.kind === 'channel_send' && a.outcome === 'unknown')) ? [] : [{ token: a.token, workItemId: item.id, kind: item.kind, attempts: item.attempts, targetKind: item.targetKind, targetId: item.targetId,
          incarnation: a.incarnation, pid: a.pid, pgid: a.pgid, osBootAt: a.osBootAt, osStartedAt: a.osStartedAt,
          held: isHeld(item.holdGroup), cancelRequested: item.cancelRequestedAt !== null }];
      }) };
    },
    async settleSupervisedAttempt(input) {
      const item = workItems.find(i => i.id === input.id && i.currentAttemptToken === input.attemptToken);
      if (!item) return { ok: true, outcome: 'lost' };
      const attempt = workAttempts.find(a => a.token === input.attemptToken)!;
      if (attempt.outcome !== null && !(input.confirmedDead && item.kind === 'channel_send' && attempt.outcome === 'unknown')) return { ok: true, outcome: 'lost' };
      if (attempt.outcome === 'unknown') { const saved = channelAttempts.get(input.attemptToken); if (saved?.result === null) saved.result = { outcome: 'unknown', code: 'INTERRUPTED', retryable: true }; }
      attempt.outcome = input.outcome === 'unknown' ? 'unknown' : item.cancelRequestedAt !== null ? 'cancelled' : input.outcome;
      attempt.finishedAt = input.now;
      attempt.elapsedMs = input.elapsedMs ?? null; attempt.stderr = input.stderr ?? null;
      if (input.outcome === 'unknown') return { ok: true, outcome: 'done' };
      if (item.cancelRequestedAt !== null) { item.completedAt = input.now; item.outcome = 'cancelled'; }
      else if (input.outcome === 'died') item.nextAttemptAt = input.now;
      else item.attempts = Math.max(0, item.attempts - 1);
      if (item.outcome === 'cancelled') closeDependents(item.id, item.outcome, input.now);
      item.currentAttemptToken = null; unclaim(item);
      return { ok: true, outcome: 'done' };
    },
    async claimSupervisedWork(input) {
      const [item] = candidates(workItems.filter(i => i.currentAttemptToken === null && i.cancelRequestedAt === null && !isHeld(i.holdGroup)), input, workDependencies, 'supervised', workItems);
      if (!item) return { ok: true, item: null, attemptToken: null };
      if (workAttempts.some((a) => a.token === input.attemptToken)) return { ok: false, code: 'DB_UNAVAILABLE', message: '이미 쓰인 시도 토큰입니다' };
      item.attempts += 1;
      item.claimedAt = input.now;
      item.claimExpiresAt = new Date(input.now.getTime() + workKindPolicy(item.kind).claimForMs);
      item.claimedBy = input.claimedBy;
      item.currentAttemptToken = input.attemptToken;
      if (item.scheduledDates) claimedDates.set(item.id, { from: item.scheduledDates.from, to: item.scheduledDates.to });
      workAttempts.push({ errorCode: null, errorRetryable: null, inputTokens: null, cachedInputTokens: null, outputTokens: null, elapsedMs: null, stderr: null, incarnation: input.claimedBy, pid: null, pgid: null, osBootAt: null, osStartedAt: null, token: input.attemptToken, workItemId: item.id, startedAt: input.now, lastProgressAt: null, renewedAt: null, finishedAt: null, outcome: null });
      return { ok: true, item: structuredClone(item), attemptToken: input.attemptToken };
    },
    async renewSupervisedLease(input) {
      const item = workItems.find((i) => i.id === input.id && i.currentAttemptToken === input.attemptToken);
      if (!item) return { ok: true, outcome: 'lost' };
      const attempt = workAttempts.find((a) => a.token === input.attemptToken)!;
      if (attempt.outcome !== null) return { ok: true, outcome: 'lost' };
      item.claimExpiresAt = new Date(input.now.getTime() + workKindPolicy(item.kind).claimForMs);
      if (input.progressAt !== null) attempt.lastProgressAt = input.progressAt;
      attempt.renewedAt = input.now;
      return { ok: true, outcome: 'done' };
    },
    async finishSupervisedWork(input) {
      const item = workItems.find((i) => i.id === input.id && i.currentAttemptToken === input.attemptToken);
      if (!item) return { ok: true, outcome: 'lost' };
      const attempt = workAttempts.find((a) => a.token === input.attemptToken)!;
      if (attempt.outcome !== null && !(input.confirmedDead && item.kind === 'channel_send' && attempt.outcome === 'unknown')) return { ok: true, outcome: 'lost' };
      if (attempt.outcome === 'unknown') { const saved = channelAttempts.get(input.attemptToken); if (saved?.result === null) saved.result = { outcome: 'unknown', code: 'INTERRUPTED', retryable: true }; }
      // Record before changing either row: a refused failure write leaves the
      // attempt and claim available for the supervisor's pending settlement.
      if (input.outcome !== 'succeeded' && item.cancelRequestedAt === null && input.failure !== undefined) {
        const recorded = await this.recordFailure({ ...input.failure, targetKind: item.targetKind, targetId: item.targetId, harness: null, sessionId: null });
        if (!recorded.ok) return recorded;
      }
      attempt.finishedAt = input.now;
      attempt.outcome = input.outcome;
      attempt.resultSummary = input.resultSummary ?? null;
      attempt.elapsedMs = input.elapsedMs ?? null; attempt.stderr = input.stderr ?? null;
      attempt.errorCode = input.errorCode ?? null; attempt.errorRetryable = input.errorRetryable ?? null;
      attempt.inputTokens = input.usage?.inputTokens ?? null; attempt.cachedInputTokens = input.usage?.cachedInputTokens ?? null; attempt.outputTokens = input.usage?.outputTokens ?? null;
      if (input.outcome === 'succeeded') { settleSuccess(item, input.now); if (item.kind === 'channel_send') for (const failure of failures) if (failure.targetKind === item.targetKind && failure.targetId === item.targetId && failure.stage === item.kind && failure.resolvedAt === null) failure.resolvedAt = input.now; }
      else if (item.cancelRequestedAt !== null) { item.completedAt = input.now; item.outcome = 'cancelled'; }
      else if (input.failure !== undefined) { item.completedAt = input.now; item.outcome = 'failed'; }
      if (input.outcome !== 'succeeded') {
        item.nextAttemptAt = input.nextAttemptAt ?? input.now;
        item.lastError = input.lastError ?? input.failure?.message ?? null;
      }
      if (item.outcome === 'cancelled' || item.outcome === 'failed') closeDependents(item.id, item.outcome, input.now);
      item.currentAttemptToken = null;
      unclaim(item);
      return { ok: true, outcome: 'done' };
    },

    async completeWork(input: CompleteWorkInput): Promise<FinishWorkResult> {
      const item = claimed(input);
      if (item === null) return { ok: true, outcome: 'lost' };
      settleSuccess(item, input.now);
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
          item.completedAt = input.closeWork.now; item.outcome = 'failed';
          item.lastError = input.message;
          closeDependents(item.id, 'failed', input.closeWork.now);
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

      // A smaller size is an older read finishing late, unless this read began
      // strictly later than the stored one or reset: then the file really is
      // shorter (port contract, P19). The cursor moves with the size.
      if (!input.reset && input.sizeBytes < existing.sizeBytes && input.scannedAt.getTime() <= existing.scannedAt.getTime()) {
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
        redactions: [...[...redactions.values()].flat(), ...fileRedactions],
        scheduleSuccesses: structuredClone([...scheduleSuccesses.values()]),
        workAttempts: workAttempts.map((attempt) => ({ ...attempt })),
        workItems: workItems.map((item) => structuredClone(item)),
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
function candidates(items: readonly WorkItem[], query: DueWorkQuery, dependencies: readonly { workItemId: string; prerequisiteId: string }[], executionClass = 'core', allItems = items): WorkItem[] {
  const kinds = new Set(query.kinds);
  return items
    .filter(
      (item) =>
        dependencies.filter(edge => edge.workItemId === item.id).every(edge => allItems.some(p => p.id === edge.prerequisiteId && p.completedAt !== null && p.outcome === 'succeeded')) &&
        (item.serializationKey === null || !allItems.some(holder => holder.id !== item.id &&
          holder.serializationKey === item.serializationKey && holder.completedAt === null &&
          (holder.currentAttemptToken !== null || (holder.claimedBy !== null && holder.claimExpiresAt !== null && holder.claimExpiresAt > query.now)))) &&
        item.executionClass === executionClass &&
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

function cloneSchedule(row: import('../../domain/schedule.js').Schedule): import('../../domain/schedule.js').Schedule {
  return { ...row, createdAt: new Date(row.createdAt), nextRunAt: row.nextRunAt === null ? null : new Date(row.nextRunAt),
    lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt) };
}

/** Independent fake: settings remain a separate Store capability. */
export function memorySettingsStore(): import('../../ports/store.js').SettingsStore {
  const settings = new Map<string, import('../../ports/store.js').SettingRecord>();
  return {
    async getSettings({ keys }) { return { ok: true, settings: keys.flatMap(key => { const row = settings.get(key); return row ? [{ ...row, updatedAt: new Date(row.updatedAt.getTime()) }] : []; }) }; },
    async getSetting({ key }) { return { ok: true, setting: settings.has(key) ? { ...settings.get(key)!, updatedAt: new Date(settings.get(key)!.updatedAt.getTime()) } : null }; },
    async setSetting(input) { settings.set(input.key, { ...input, updatedAt: new Date(input.updatedAt.getTime()) }); return { ok: true }; },
  };
}
