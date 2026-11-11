import { driveSourceUrl } from '../../recall/documents.js';
import { isExternalLocator } from '../../domain/file.js';
import { extensionPublicProjection } from '../../extensions/public-projection.js';
import { validInstallProgress } from '../../extensions/install-progress.js';
import { conversationFingerprint } from '../../recall/conversation-fingerprint.js';
import { attemptUsage } from '../../queue/list.js';
import type { ChannelStore } from '../../channels/store.js';
import type { DriveRetentionSettingsStore } from '../../ports/store.js';
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
  /** Synthetic external source records; array may be updated by the fixture. */
  sourceEntries?: readonly import('../../ports/source-store.js').SourceEntry[];
  /** Connect the source fake's completion fence when composing the queue and source stores. */
  sourceSyncCanComplete?: (sourceId:string)=>boolean;
  /** Synthetic successful report requests for document recall contracts. */
  reportRequests?: readonly { fileId: string; source: string; reportDate: string | null; createdAt: string; id: string }[];
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
  scheduleOccurrences: readonly import('../../domain/schedule.js').ScheduleOccurrence[];
  /** One row per `(target, stage, fingerprint)`, in the order first seen. */
  failures: readonly Failure[];
  /** One row per `(harness, path)`, in the order they were first recorded. */
  transcriptFiles: readonly TranscriptFile[];
  closes: number;
}

export interface MemoryStore extends Store, DriveRetentionSettingsStore, ChannelStore {
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
  const extensionWorkInputs = new Map<string, unknown>();
  const extensionWorkKinds = new Map<string, readonly string[]>();
  const extensionMissedPolicies = new Map<string, Readonly<Record<string, 'latest' | 'coalesce' | 'skip'>>>();
  const extensionFollowups = new Map<string, Readonly<Record<string, string>>>();
  const pythonEnvironments = new Map<string, import('../../ports/store.js').ExtensionPythonEnvironment>();
  const extensions = new Map<string, import('../../ports/store.js').ExtensionRecord>();
  const users = new Map<string, User>();
  const settingStore = memorySettingsStore({selfUserId:()=>[...users.values()].find(user=>user.isSelf)?.id??null});
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
  const quiescedExtensions = new Map<string, string>();
  const isQuiesced = (kind: string) => kind.includes('.') && quiescedExtensions.has(kind.split('.')[0]!);
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

  const occurrences = new Map<string, import('../../domain/schedule.js').ScheduleOccurrence>();
  const localOccurrenceDate=(d:Date,zone:string)=>new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'}).format(d);
  function occurrenceReady(row: import('../../domain/schedule.js').ScheduleOccurrence, item: WorkItem): boolean {
    const schedule=schedules.get(row.scheduleId);
    if (!schedule?.afterSchedule) return true;
    if (!row.timeZone || [...occurrences.values()].some(newer=>newer.scheduleId===row.scheduleId && newer.workId===row.workId && (newer.status==='pending'||newer.status==='claimed') && newer.occurrenceAt>row.occurrenceAt)) return false;
    return [...occurrences.values()].some(prior=>{
      const parent=schedules.get(prior.scheduleId), work=workItems.find(w=>w.id===prior.workId);
      return parent?.extension===schedule.extension && parent?.scheduleKey===schedule.afterSchedule && parent?.userId===row.userId && prior.userId===row.userId && prior.status==='done' && prior.timeZone===row.timeZone && localOccurrenceDate(prior.occurrenceAt,row.timeZone!)===localOccurrenceDate(row.occurrenceAt,row.timeZone!) && work?.targetKind===item.targetKind && work?.targetId===item.targetId;
    });
  }
  function scheduledReady(item:WorkItem):boolean {
    const active=[...occurrences.values()].filter(o=>o.workId===item.id && (o.status==='pending'||o.status==='claimed'));
    return active.length===0 || active.some(o=>occurrenceReady(o,item));
  }
  function transition(item: WorkItem, target: 'pending' | 'failed') {
    for (const row of occurrences.values()) if (row.workId === item.id && (row.status === 'claimed' || (target === 'failed' && row.status === 'pending'))) row.status = target;
    item.scheduledOccurrences = null;
  }
  const SCHEDULE_CLAIM_BATCH=1000;
  function claimOccurrences(item: WorkItem) {
    const groups: NonNullable<WorkItem['scheduledOccurrences']> = [];
    for (const row of occurrences.values()) if (row.workId===item.id && row.status==='claimed') row.status='pending';
    for(const row of occurrences.values()) if(row.workId===item.id && row.status==='pending' && (schedules.get(row.scheduleId)?.afterSchedule || extensionMissedPolicies.get(item.kind.split('.')[0] ?? '')?.[item.kind]==='latest') && [...occurrences.values()].some(newer=>newer.scheduleId===row.scheduleId && newer.workId===row.workId && newer.status==='pending' && newer.occurrenceAt>row.occurrenceAt)) row.status='skipped';
    const gated=[...occurrences.values()].some(row=>row.workId===item.id && row.status==='pending' && (schedules.get(row.scheduleId)?.afterSchedule || extensionMissedPolicies.get(item.kind.split('.')[0] ?? '')?.[item.kind]==='latest'));
    const rows=[...occurrences.values()].filter(row=>row.workId===item.id && row.status==='pending' && occurrenceReady(row,item)).sort((a,b)=>a.occurrenceAt.getTime()-b.occurrenceAt.getTime()||a.scheduleId.localeCompare(b.scheduleId)).slice(0,gated ? 1 : SCHEDULE_CLAIM_BATCH).sort((a,b)=>a.scheduleId.localeCompare(b.scheduleId)||(a.timeZone ?? '').localeCompare(b.timeZone ?? '')||a.occurrenceAt.getTime()-b.occurrenceAt.getTime());
    for (const row of rows) { row.status='claimed'; let group=groups.at(-1); if (!group || group.scheduleId!==row.scheduleId || group.timeZone!==row.timeZone) { group={scheduleId:row.scheduleId,timeZone:row.timeZone,occurrences:[]}; groups.push(group); } group.occurrences.push(new Date(row.occurrenceAt)); }
    item.scheduledOccurrences=groups.length?groups:null;
  }
  function settleSuccess(item: WorkItem, now: Date) {
    for (const row of occurrences.values()) if (row.workId===item.id && row.status==='claimed') { row.status='done'; row.recordedAt=new Date(now); }
    for(const pendingRow of occurrences.values()) if(pendingRow.workId===item.id && pendingRow.status==='pending' && pendingRow.timeZone && schedules.get(pendingRow.scheduleId)?.afterSchedule && [...occurrences.values()].some(done=>done.workId===item.id && done.scheduleId===pendingRow.scheduleId && done.userId===pendingRow.userId && done.status==='done' && done.timeZone===pendingRow.timeZone && localOccurrenceDate(done.occurrenceAt,done.timeZone!)===localOccurrenceDate(pendingRow.occurrenceAt,pendingRow.timeZone!))) {pendingRow.status='skipped';pendingRow.recordedAt=new Date(now);}
    const pending=item.cancelRequestedAt===null && [...occurrences.values()].some(row=>row.workId===item.id && row.status==='pending');
    item.completedAt=pending?null:now; item.outcome=pending?null:'succeeded'; if(pending)item.nextAttemptAt=now; else transition(item,'failed'); item.scheduledOccurrences=null;
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
  const carryChecks = new Set<string>();
  const carryWorkVersions = new Map<string, {version:string;pinned:boolean}>();
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
      item.kind === 'document_extract' &&
      item.targetKind === 'file' &&
      item.targetId === input.fileId &&
      item.claimedBy === input.claim.claimedBy &&
      (input.claim.claimedAt === undefined || item.claimedAt?.getTime() === input.claim.claimedAt.getTime()) &&
      (input.claim.attempts === undefined || item.attempts === input.claim.attempts) &&
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
      // Find-or-create: an open row for this work keeps everything it has,
      // including its own id and its own `next_attempt_at` (AD-21).
      return { ok: true, created: false, item: structuredClone(existing) };
    }
    const item: WorkItem = {
      id: input.id,
      scheduledOccurrences: null,
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
        transition(item, 'failed'); item.completedAt = now; item.outcome = 'dependency_failed';
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
    ...settingStore,
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
    async searchDocuments(input) {
      const rows: import('../../ports/document-recall-store.js').DocumentSearchRow[] = [];
      const binary = (a: string, b: string) => { const x = Array.from(a), y = Array.from(b); for (let i=0; i<Math.min(x.length,y.length); i++) { const delta = x[i]!.codePointAt(0)! - y[i]!.codePointAt(0)!; if (delta) return delta; } return x.length-y.length; };
      const entries = (options.sourceEntries ?? []).filter(e => driveSourceUrl(e.remoteId)!==null && (e.fileId===null || (fileById(e.fileId)!==undefined && !fileRedacted(e.fileId))));
      const matches = (text: string) => text.toLowerCase().includes(input.query.toLowerCase());
      const sourceOrigin = (entry: typeof entries[number]): import('../../ports/document-recall-store.js').DocumentSearchOrigin => ({kind:'drive',source_file_id:entry.id,source_remote_id:entry.remoteId,display_name:entry.name,source_path:entry.path,index_status:entry.indexStatus,source_unreachable:entry.unreachable,current_version:entry.remoteVersion,completed_version:entry.completedVersion,stale:entry.fileId!==null&&entry.completedVersion!==entry.remoteVersion});
      const ids = new Set([...Array.from(fileRows.values(), f => f.id), ...entries.flatMap(e => e.fileId ? [e.fileId] : [])]);
      for (const id of ids) {
        if (fileRedacted(id)) continue;
        const related=entries.filter(e=>e.fileId===id).sort((a,b)=>binary(a.id,b.id));
        const request=(options.reportRequests ?? []).filter(r=>r.fileId===id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id))[0];
        const names=fileNames.filter(n=>n.fileId===id&&(n.nameSource==='attachment_name'||fileLocationRows.some(l=>l.fileId===id&&l.storeKind==='local'&&l.ownership==='external'&&l.deletedAt===null&&l.locator===n.text&&isExternalLocator(l.locator)))).sort((a,b)=>binary(a.nameSource,b.nameSource)||binary(a.text,b.text));
        const attached=[...attachmentRows.values()].some(rows=>rows.some(a=>a.file?.id===id));
        if(!request&&!attached&&!names.length&&!related.length)continue;
        const name=names[0]?.text ?? (request ? `report:${id}` : related[0]?.name ?? id);
        const aliases=[...new Set(names.map(n=>n.text))].sort(binary);
        const localOrigins: import('../../ports/document-recall-store.js').DocumentSearchOrigin[]=fileLocationRows.filter(l=>l.fileId===id&&l.deletedAt===null).sort((a,b)=>binary(a.id,b.id)).map(l=>({kind:'location',location_id:l.id,store_kind:l.storeKind,locator:l.locator,ownership:l.ownership,display_name:name,source_unreachable:false}));
        const internal_origins=[...localOrigins,...related.map(sourceOrigin)];
        const first=related[0];
        const rawDate=request?.reportDate; const date=rawDate&&/^\d{4}-\d{2}-\d{2}$/.test(rawDate)?new Date(`${rawDate}T00:00:00Z`):null;
        const latest=extractions.filter(e=>e.fileId===id).sort((a,b)=>b.attempt-a.attempt)[0];
        const extraction=currentExtractions.get(id);
        const base={kind:'document' as const,report_provenance:!!request,file_id:id,display_name:name,report_date:date&&Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===rawDate?rawDate!:null,source:request?.source??(attached||names.length?'attachment':'drive'),source_unreachable:(localOrigins.length>0||related.some(e=>!e.unreachable))?false:(sourceUnreachableAt.has(id)||related.length>0),names:aliases,internal_origins,file_status:extractionById(extraction ?? '')?.status??latest?.status??'pending' as const,...(first?{source_file_id:first.id,source_path:first.path,source_remote_id:first.remoteId,index_status:first.indexStatus,current_version:first.remoteVersion,completed_version:first.completedVersion,stale:first.completedVersion!==first.remoteVersion}:{})};
        let bodyHit=false;
        if(extraction&&extractionById(extraction)?.status==='ok') {
          const groups=new Map<string,typeof documentChunks extends Map<string,infer P> ? P : never>();
          for(const piece of chunksOf(extraction)) if(piece.chunkLocator&&matches(piece.body)) { const key=JSON.stringify(piece.chunkLocator);const group=groups.get(key)??[];group.push(piece);groups.set(key,group); }
          for(const [locator,pieces] of groups) {
            bodyHit=true;pieces.sort((a,b)=>a.ordinal-b.ordinal);
            const score=(value:string)=>value.toLowerCase().split(input.query.toLowerCase()).length-1;
            const representative=[...pieces].sort((a,b)=>score(b.body)-score(a.body)||a.ordinal-b.ordinal)[0]!;
            rows.push({...base,extraction_id:extraction,chunk_locator:locator,ordinal:pieces[0]!.ordinal,ordinals:pieces.map(p=>p.ordinal),body:representative.body});
          }
        }
        if(!bodyHit&&(names.some(n=>matches(n.text))||related.some(e=>matches(e.name)||matches(e.path)))) rows.push({...base,extraction_id:null,chunk_locator:null,ordinal:null,body:''});
      }
      for(const entry of entries.filter(e=>e.fileId===null)) if(matches(entry.name)||matches(entry.path)) rows.push({kind:'document',file_id:null,display_name:entry.name,report_date:null,source:'drive',source_unreachable:entry.unreachable,source_file_id:entry.id,source_path:entry.path,source_remote_id:entry.remoteId,index_status:entry.indexStatus,current_version:entry.remoteVersion,completed_version:entry.completedVersion,stale:false,internal_origins:[sourceOrigin(entry)],extraction_id:null,chunk_locator:null,ordinal:null,body:''});
      const count = (body: string) => body.toLowerCase().split(input.query.toLowerCase()).length - 1;
      rows.sort((a,b) => count(b.body)-count(a.body) || (b.report_date ?? '').localeCompare(a.report_date ?? '') || binary(a.file_id ?? '￿',b.file_id ?? '￿') || binary(a.source_file_id ?? '',b.source_file_id ?? '') || (a.ordinal ?? 999999)-(b.ordinal ?? 999999));
      const selected = rows.slice(0,input.limit);
      const contexts = [...new Set(selected.flatMap(r => r.extraction_id === null ? [] : [r.extraction_id]))].map(extraction_id => ({ extraction_id, pieces: chunksOf(extraction_id).filter(p => p.chunkLocator !== null).map(p => ({ ordinal:p.ordinal, chunk_locator:JSON.stringify(p.chunkLocator), body:p.body })) }));
      return { ok:true, rows: selected, contexts };
    },
    async readSourceDocument(id) {
      const e=(options.sourceEntries ?? []).find(row=>row.id===id);
      if(!e || (e.fileId!==null && fileRedacted(e.fileId)))return {ok:true,source:null};
      return {ok:true,source:{source_file_id:e.id,file_id:e.fileId,display_name:e.name,source_path:e.path,source_remote_id:e.remoteId,source:'drive',index_status:e.indexStatus,source_unreachable:e.unreachable,current_version:e.remoteVersion,completed_version:e.completedVersion,stale:e.fileId!==null&&e.completedVersion!==e.remoteVersion}};
    },
    async readDocument(fileId) {
      const file = fileById(fileId); if (!file) return { ok:true, snapshot:null };
      const extraction = currentExtractions.get(fileId) ?? null;
      const latest = extractions.filter(e => e.fileId === fileId).sort((a,b) => b.attempt-a.attempt)[0];
      return { ok:true, snapshot: { redacted:fileRedacted(fileId), source_unreachable:sourceUnreachableAt.has(fileId), extraction_id:extraction, status: extraction ? extractionById(extraction)?.status ?? null : latest ? latest.status ?? 'pending' : null,
        pieces: fileRedacted(fileId) || !extraction ? [] : chunksOf(extraction).filter(p => p.chunkLocator !== null).map(p => ({ ordinal:p.ordinal, chunk_locator:JSON.stringify(p.chunkLocator), body:p.body })) } };
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
    async beginExtensionQuiesce({name,owner}) {
      const current = quiescedExtensions.get(name);
      if (current !== undefined && current !== owner) return { ok: true, acquired: false };
      quiescedExtensions.set(name, owner); return { ok: true, acquired: true };
    },
    async readExtensionQuiesce(name) {
      return { ok: true, owner: quiescedExtensions.get(name) ?? null, running: workItems.filter(item => item.kind.startsWith(`${name}.`) && item.completedAt === null && (item.currentAttemptToken !== null || item.claimedBy !== null)).length };
    },
    async endExtensionQuiesce({name,owner}) {
      if (quiescedExtensions.get(name) !== owner) return { ok: true, released: false };
      quiescedExtensions.delete(name); return { ok: true, released: true };
    },
    async listExtensionInventory() { return { ok: true, names: [...new Set([...extensions.keys(), ...installProgress.keys(), ...quiescedExtensions.keys()])].sort() }; },
    async getExtensionPublicStatus(name) {
      const group = `extension:${name}`;
      const held = heldGroups.has(group);
      return { ok: true, status: structuredClone(extensionPublicProjection(name, extensions.get(name) ?? null, installProgress.get(name)?.progress ?? null,
        held ? [...schedules.values()].filter(row => row.holdGroup === group).length : 0,
        held ? workItems.filter(row => row.holdGroup === group && row.completedAt === null).length : 0, pythonEnvironments.get(name) ?? null, quiescedExtensions.has(name))) };
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
    async recordExtensionInstall({ name, version, now, packageIdentity, workKinds, workFollowups, missedPolicies }) {
      extensionMissedPolicies.set(name, { ...missedPolicies });
      extensionWorkKinds.set(name, workKinds ?? []);
      extensionFollowups.set(name, workFollowups ?? {});
      for (const item of [...workItems]) if (item.completedAt === null && (workKinds ?? []).includes(item.kind)) ensureFollowup(item);
      const existing = extensions.get(name);
      if (existing) { existing.version = version; existing.packageDigest = packageIdentity?.digest ?? null; existing.pluginVersion = packageIdentity?.pluginVersion ?? null; }
      else extensions.set(name, { name, version, packageDigest: packageIdentity?.digest ?? null, pluginVersion: packageIdentity?.pluginVersion ?? null, installedAt: new Date(now), enabled: true, enabledChangedAt: new Date(now), connectionStatus: null, connectionCheckedAt: null, connectionCode: null, connectionMessage: null });
      return { ok: true };
    },
    async recordExtensionConnection({ name, status, code, message, checkedAt }) {
      const row = extensions.get(name);
      if (!row) return { ok: false, code: 'DB_UNAVAILABLE', message: '설치 기록이 없습니다' };
      Object.assign(row, { connectionStatus: status, connectionCode: code, connectionMessage: message, connectionCheckedAt: new Date(checkedAt) });
      return { ok: true };
    },
    async enqueueExtensionWork({ name, version, input, work }) {
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
      if (result.ok && input !== undefined) {
        if (result.created) extensionWorkInputs.set(result.item.id, structuredClone(input));
        else if (JSON.stringify(extensionWorkInputs.get(result.item.id)) !== JSON.stringify(input)) return { ok: true, state: 'changed' };
      }
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
      const rows = [...schedules.values()].filter(row=>row.removedAt===null).sort((a,b) => a.createdAt.getTime()-b.createdAt.getTime() || a.id.localeCompare(b.id));
      return { ok: true, schedules: structuredClone(rows.slice(0, limit).map(row => ({ ...row, held: isHeld(row.holdGroup) }))), hasMore: rows.length > limit };
    },
    async removeSchedule({ id, now }) {
      const row=schedules.get(id); if (!row || row.removedAt) return {ok:true,removed:false,marked:false};
      if (row.scheduleKey !== null) { row.removedAt=new Date(now); row.enabled=false; }
      else { schedules.delete(id); for(const [key,value] of occurrences) if(value.scheduleId===id) occurrences.delete(key); }
      return {ok:true,removed:true,marked:row.scheduleKey !== null};
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
    async findScheduleByKey({extension,scheduleKey,userId}) { const row=[...schedules.values()].find(s=>s.extension===extension && s.scheduleKey===scheduleKey && s.userId===userId); return {ok:true,schedule:row?cloneSchedule(row):null}; },
    async readSchedule({id}) { const row=schedules.get(id); return {ok:true,schedule:row && !row.removedAt?cloneSchedule(row):null}; },
    async listUserZoneSchedules({limit}) {return {ok:true,schedules:[...schedules.values()].filter(s=>s.enabled && !s.removedAt && s.timeZoneSource==='user' && s.nextRunAt).sort((a,b)=>a.id.localeCompare(b.id)).slice(0,limit).map(cloneSchedule)};},
    async updateSchedule({id,expected,schedule}) {const row=schedules.get(id); if(!row || row.removedAt || row.nextRunAt?.getTime()!==expected.nextRunAt?.getTime() || row.triggerKind!==expected.triggerKind || row.cronExpr!==expected.cronExpr || row.runAt?.getTime()!==expected.runAt?.getTime() || row.timeZone!==expected.timeZone || row.timeZoneSource!==expected.timeZoneSource || row.intervalSeconds!==expected.intervalSeconds || row.enabled!==expected.enabled || row.triggerUpdatedAt?.getTime()!==expected.triggerUpdatedAt?.getTime())return {ok:true,updated:false}; Object.assign(row,{triggerKind:schedule.triggerKind,cronExpr:schedule.cronExpr,runAt:schedule.runAt,timeZone:schedule.timeZone,timeZoneSource:schedule.timeZoneSource,intervalSeconds:schedule.intervalSeconds,enabled:schedule.enabled,nextRunAt:schedule.nextRunAt,triggerUpdatedAt:schedule.triggerUpdatedAt});return {ok:true,updated:true};},
    async rezoneSchedule(input) {const row=schedules.get(input.id);if(!row || row.removedAt || row.timeZoneSource!=='user' || row.nextRunAt?.getTime()!==input.expectedNextRunAt.getTime() || row.timeZone!==input.expectedTimeZone || row.triggerKind!=='cron' || row.cronExpr!==input.expectedCronExpr || row.triggerUpdatedAt?.getTime()!==input.expectedTriggerUpdatedAt?.getTime())return {ok:true,updated:false};row.timeZone=input.timeZone;row.nextRunAt=new Date(input.nextRunAt);return {ok:true,updated:true};},
    async listOccurrences({scheduleId}) {return {ok:true,occurrences:structuredClone([...occurrences.values()].filter(x=>x.scheduleId===scheduleId).sort((a,b)=>a.occurrenceAt.getTime()-b.occurrenceAt.getTime()))};},
    async disableMissingSchedules({extension,userId,keys}) {const disabled:string[]=[]; for(const row of schedules.values()) if(row.extension===extension && row.userId===userId && row.scheduleKey!==null && !row.removedAt && !keys.includes(row.scheduleKey)){row.enabled=false;disabled.push(row.scheduleKey);} return {ok:true,keys:disabled.sort()};},
    async addSchedule(input) {
      const holdGroup=workHoldGroup(input.kind,input.holdGroup);if(!validHoldGroup(holdGroup))return invalidGroup;
      const validShape = input.triggerKind==='cron' ? input.cronExpr!==null && input.timeZone!==null && input.timeZoneSource!==null && input.runAt===null && input.intervalSeconds===null : input.triggerKind==='once' ? input.runAt!==null && input.cronExpr===null && input.timeZone===null && input.timeZoneSource===null && input.intervalSeconds===null : input.triggerKind==='interval' && input.intervalSeconds!==null && Number.isInteger(input.intervalSeconds) && input.intervalSeconds>0 && input.nextRunAt!==null && input.cronExpr===null && input.runAt===null && input.timeZone===null && input.timeZoneSource===null;
      if(!validShape || !users.has(input.userId) || [input.createdAt,input.nextRunAt,input.lastRunAt,input.runAt,input.removedAt].some(value=>value!==null && !formatInstant(value).ok)) return {ok:false,code:'DB_UNAVAILABLE',message:'잘못된 예약입니다'};
      if(schedules.has(input.id) || (input.scheduleKey!==null && [...schedules.values()].some(s=>s.extension===input.extension && s.scheduleKey===input.scheduleKey && s.userId===input.userId)))return {ok:false,code:'SCHEDULE_CONFLICT',message:'이미 예약이 있습니다'};
      const row={...input,holdGroup,triggerUpdatedAt:input.triggerUpdatedAt ?? null}; schedules.set(row.id,cloneSchedule(row));return {ok:true,schedule:cloneSchedule(row)};
    },
    async readMissedPolicy({kind}) { const ext=kind.split('.')[0] ?? ''; return {ok:true,policy:extensionMissedPolicies.get(ext)?.[kind] ?? 'latest'}; },
    async listDueSchedules({now,limit}) {return {ok:true,schedules:[...schedules.values()].filter(s=>s.enabled && !s.removedAt && !isHeld(s.holdGroup) && !isQuiesced(s.kind) && !(s.extension && quiescedExtensions.has(s.extension)) && s.nextRunAt!==null && s.nextRunAt<=now).sort((a,b)=>a.nextRunAt!.getTime()-b.nextRunAt!.getTime()||a.id.localeCompare(b.id)).slice(0,limit).map(cloneSchedule)};},
    async fireSchedule(input) {
      if ([input.now, input.expectedNextRunAt, input.nextRunAt, input.work.createdAt, input.work.nextAttemptAt, ...input.occurrences.map(item => item.occurrenceAt)].some(value => value !== null && !formatInstant(value).ok)) return {ok:false,code:'DB_UNAVAILABLE',message:'잘못된 예약 발화 시각입니다'};
      const row=schedules.get(input.scheduleId);if(!row || !row.enabled || row.removedAt || isHeld(row.holdGroup) || isQuiesced(row.kind) || (row.extension !== null && quiescedExtensions.has(row.extension)) || row.nextRunAt?.getTime()!==input.expectedNextRunAt.getTime() || row.triggerKind!==input.expectedTriggerKind || row.timeZone!==input.expectedTimeZone || row.cronExpr!==input.expectedCronExpr)return {ok:true,fired:false};
      let targetId=row.targetId;
      if(row.targetSetting) {
        const found=await settingStore.getExactSetting({key:row.targetSetting,userId:row.userId});
        const value=found?.value;
        if(typeof value!=='string' || !value.trim() || value.length>1024 || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return {ok:true,fired:false};
        targetId=value;
      }
      const fresh=input.occurrences.filter(x=>!occurrences.has(`${row.id}/${x.occurrenceAt.toISOString()}`)).map(entry=>{
        const covered=row.afterSchedule && row.timeZone && entry.status==='pending' && [...occurrences.values()].some(done=>{const old=workItems.find(w=>w.id===done.workId);return done.scheduleId===row.id && done.userId===row.userId && done.status==='done' && done.timeZone===row.timeZone && localOccurrenceDate(done.occurrenceAt,row.timeZone!)===localOccurrenceDate(entry.occurrenceAt,row.timeZone!) && old?.targetKind===input.work.targetKind && old?.targetId===targetId;});
        return covered ? {...entry,status:'skipped' as const} : entry;
      });
      const pending=fresh.filter(x=>x.status==='pending');let workId:string|null=null;let created=false;
      if(pending.length){const work=addWork({...input.work,targetId,holdGroup:row.holdGroup});if(!work.ok)return work;workId=work.item.id;created=work.created;}
      for(const item of fresh)occurrences.set(`${row.id}/${item.occurrenceAt.toISOString()}`,{scheduleId:row.id,occurrenceAt:new Date(item.occurrenceAt),status:item.status,timeZone:row.timeZone,workId:item.status==='pending'?workId:null,userId:row.userId,recordedAt:new Date(input.now)});
      if((row.afterSchedule || extensionMissedPolicies.get(row.kind.split('.')[0] ?? '')?.[row.kind]==='latest') && workId){
        const pendingRows=[...occurrences.values()].filter(o=>o.scheduleId===row.id && o.workId===workId && o.status==='pending');
        const latest=Math.max(...pendingRows.map(o=>o.occurrenceAt.getTime()));
        for(const pendingRow of pendingRows) if(pendingRow.occurrenceAt.getTime()<latest){pendingRow.status='skipped';pendingRow.recordedAt=new Date(input.now);}
      }
      row.lastRunAt=new Date(input.now);row.nextRunAt=input.nextRunAt?new Date(input.nextRunAt):null;
      return {ok:true,fired:true,created,covered:!pending.length};
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

      const version = carryWorkVersions.get(input.claim.workItemId);
      if(version?.pinned && (input.claim.claimedAt===undefined || input.claim.attempts===undefined))return {ok:false,code:'CLAIM_LOST',message:'Carry 청구에는 완전한 청구 식별자가 필요합니다'};
      carryWorkVersions.set(input.claim.workItemId, {version:input.extractorVersion,pinned:version?.pinned ?? false});

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

    async listUnsupportedCarry({extractorVersion,limit,after}) {
      const ids=[...fileRows.values()].filter(f=>f.home!==null&&!fileRedacted(f.id)&&!sourceUnreachableAt.has(f.id)&&!currentExtractions.has(f.id)&&(!after||f.id>after)&&!carryChecks.has(`${f.id}:${extractorVersion}`)&&extractions.some(e=>e.fileId===f.id&&e.status==='unsupported'&&e.extractorVersion!==extractorVersion)&&!extractions.some(e=>e.fileId===f.id&&e.extractorVersion===extractorVersion)).map(f=>f.id).sort().slice(0,limit);
      return {ok:true,fileIds:ids};
    },
    async commitUnsupportedCarry(input) {
      const f=fileById(input.fileId),key=`${input.fileId}:${input.extractorVersion}`;
      if(!f||!f.home||fileRedacted(f.id)||sourceUnreachableAt.has(f.id)||currentExtractions.has(f.id)||f.contentHash!==input.contentHash||f.home.storeKind!==input.home.storeKind||f.home.locator!==input.home.locator||f.home.ownership!==input.home.ownership||carryChecks.has(key)||!extractions.some(e=>e.fileId===f.id&&e.status==='unsupported'&&e.extractorVersion!==input.extractorVersion)||extractions.some(e=>e.fileId===f.id&&e.extractorVersion===input.extractorVersion))return {ok:true,committed:false,created:false};
      let created=false;if(input.supported){const result=addWork({id:input.workId,kind:'document_extract',targetKind:'file',targetId:input.fileId,createdAt:input.now,nextAttemptAt:input.now});if(!result.ok)return {ok:false,code:'DB_UNAVAILABLE',message:'일감 생성 실패'};if(!result.created){if(carryWorkVersions.get(result.item.id)?.version!==input.extractorVersion)return {ok:true,committed:false,created:false};carryWorkVersions.set(result.item.id,{version:input.extractorVersion,pinned:true});}else{carryWorkVersions.set(result.item.id,{version:input.extractorVersion,pinned:true});created=true;}}
      carryChecks.add(key);return {ok:true,committed:true,created};
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
      return { ok: true, due: candidates(workItems.filter(i => !isHeld(i.holdGroup) && !isQuiesced(i.kind) && scheduledReady(i)), query, workDependencies, 'core', workItems).length > 0 };
    },

    async claimWork(input: ClaimWorkInput): Promise<ClaimWorkResult> {
      const [next] = candidates(workItems.filter(i => !isHeld(i.holdGroup) && !isQuiesced(i.kind) && scheduledReady(i)), input, workDependencies, 'core', workItems);
      if (next === undefined) return { ok: true, item: null };

      // The attempt is raised by the claim and not by the outcome, so an item
      // that kills the worker holding it still counted once (Decision 1).
      next.attempts += 1;
      next.claimedAt = input.now;
      next.claimExpiresAt = new Date(input.now.getTime() + workKindPolicy(next.kind).claimForMs);
      next.claimedBy = input.claimedBy;
      claimOccurrences(next);
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
      transition(item, 'failed'); item.completedAt = input.now; item.outcome = 'cancelled'; unclaim(item);
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
      transition(item, item.outcome === 'cancelled' ? 'failed' : 'pending'); item.currentAttemptToken = null; unclaim(item);
      return { ok: true, outcome: 'done' };
    },
    async claimSupervisedWork(input) {
      const [item] = candidates(workItems.filter(i => i.currentAttemptToken === null && i.cancelRequestedAt === null && !isHeld(i.holdGroup) && !isQuiesced(i.kind) && scheduledReady(i)), input, workDependencies, 'supervised', workItems);
      if (!item) return { ok: true, item: null, attemptToken: null };
      if (workAttempts.some((a) => a.token === input.attemptToken)) return { ok: false, code: 'DB_UNAVAILABLE', message: '이미 쓰인 시도 토큰입니다' };
      item.attempts += 1;
      item.claimedAt = input.now;
      item.claimExpiresAt = new Date(input.now.getTime() + workKindPolicy(item.kind).claimForMs);
      item.claimedBy = input.claimedBy;
      item.currentAttemptToken = input.attemptToken;
      claimOccurrences(item);
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
        transition(item, input.failure !== undefined || item.cancelRequestedAt !== null ? 'failed' : 'pending');
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
      if(item.kind==='source_sync' && item.targetKind==='source' && options.sourceSyncCanComplete && !options.sourceSyncCanComplete(item.targetId)) return {ok:true,outcome:'lost'};
      settleSuccess(item, input.now);
      unclaim(item);
      return { ok: true, outcome: 'done' };
    },

    async retryWork(input: RetryWorkInput): Promise<FinishWorkResult> {
      const item = claimed(input);
      if (item === null) return { ok: true, outcome: 'lost' };
      transition(item, 'pending');
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
      transition(item, 'pending');
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
          transition(item, 'failed');
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
        scheduleOccurrences: structuredClone([...occurrences.values()]),
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
  return { ...row, triggerUpdatedAt: row.triggerUpdatedAt === null ? null : new Date(row.triggerUpdatedAt), runAt: row.runAt === null ? null : new Date(row.runAt), removedAt: row.removedAt === null ? null : new Date(row.removedAt), createdAt: new Date(row.createdAt), nextRunAt: row.nextRunAt === null ? null : new Date(row.nextRunAt),
    lastRunAt: row.lastRunAt === null ? null : new Date(row.lastRunAt) };
}

/** Independent fake: settings remain a separate Store capability. */
export function memorySettingsStore(options:{selfUserId?:string|(()=>string|null);applyRetention?:(days:number)=>Promise<{ok:true}|import('../../ports/store.js').SettingsStoreFailure>}={}): import('../../ports/store.js').DriveRetentionSettingsStore & {getExactSetting(input:{userId:string;key:string}):Promise<import('../../ports/store.js').SettingRecord | undefined>} {
  const settings = new Map<string, import('../../ports/store.js').SettingRecord>();
  const keyOf = (userId: string | null, key: string) => JSON.stringify([userId, key]);
  const read = (userId: string | null, key: string) => settings.get(keyOf(userId, key)) ?? settings.get(keyOf(null, key));
  let tail:Promise<void>=Promise.resolve();
  const serialized=async<T>(fn:()=>Promise<T>):Promise<T>=>{let release!:()=>void;const prior=tail;tail=new Promise<void>(resolve=>{release=resolve;});await prior;try{return await fn();}finally{release();}};
  const refresh=async()=>{const self=typeof options.selfUserId==='function'?options.selfUserId():options.selfUserId??null;const raw=read(self,'drive.keep_local_days')?.value??'30';if(!/^(0|[1-9][0-9]*)$/.test(raw)||Number(raw)>100_000_000)return {ok:false as const,code:'DB_UNAVAILABLE' as const,message:'보관 기간이 유효하지 않습니다'};return options.applyRetention?options.applyRetention(Number(raw)):{ok:true as const};};
  const write=async(input:import('../../ports/store.js').SettingRecord & {userId:string|null},insertOnly:boolean)=>{
    const key=keyOf(input.userId,input.key),row={key:input.key,value:input.value,updatedAt:new Date(input.updatedAt)};
    if(input.key!=='drive.keep_local_days'){if(!insertOnly||!settings.has(key))settings.set(key,row);return {ok:true as const};}
    return serialized(async()=>{if(!/^(0|[1-9][0-9]*)$/.test(input.value)||Number(input.value)>100_000_000)return {ok:false as const,code:'DB_UNAVAILABLE' as const,message:'보관 기간이 유효하지 않습니다'};const prior=settings.get(key);if(!insertOnly||!prior)settings.set(key,row);try{const result=await refresh();if(!result.ok){if(prior)settings.set(key,prior);else settings.delete(key);}return result;}catch(error){if(prior)settings.set(key,prior);else settings.delete(key);throw error;}});
  };
  return {
    async getExactSetting({userId,key}) { return settings.get(keyOf(userId,key)); },
    async getSettings({ keys, userId }) { return { ok: true, settings: [...new Set(keys)].flatMap(key => { const row = read(userId, key); return row ? [{ ...row, updatedAt: new Date(row.updatedAt) }] : []; }) }; },
    async getSetting({ key, userId }) { const row = read(userId, key); return { ok: true, setting: row ? { ...row, updatedAt: new Date(row.updatedAt) } : null }; },
    setSetting: input=>write(input,false),
    insertSetting: input=>write(input,true),
    refreshDriveRetention:()=>serialized(refresh),
  };
}
