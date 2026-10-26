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
import { workKindPolicy, type WorkItem } from '../../domain/work-item.js';
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
   * One row per masking that was written, in the order it went in (AD-11): the
   * spans of `messages.redact` first, then the whole-file records of
   * `files.redact`. Ingest never creates either.
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

/**
 * What a generation closed by a later `beginExtraction` says about itself.
 *
 * The same sentence as the SQLite adapter's, and it names the new begin rather
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
        const unredactedAttachments = (attachmentRows.get(message.id) ?? [])
          .filter((row) => row.status === 'stored' && row.file !== null && !fileRedacted(row.file.id)).length;
        return { ok: true, sessionId: message.sessionId, bodySpans: plan.bodySpans,
          toolNoteSpans: plan.toolNoteSpans, toolNotesChanged: plan.toolNotes.length, chunksRemoved: 0,
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
