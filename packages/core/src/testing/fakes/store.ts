import type { IngestBatch } from '../../domain/ingest-batch.js';
import type { Message } from '../../domain/message.js';
import type { Project } from '../../domain/project.js';
import type { Session } from '../../domain/session.js';
import type { Worktree } from '../../domain/worktree.js';
import {
  formatSessionToken,
  type SessionKey,
  type SessionToken,
} from '../../domain/session-token.js';
import type { ToolNote } from '../../domain/tool-note.js';
import type { User } from '../../domain/user.js';
import type {
  EnsureSelfUserInput,
  EnsureSelfUserResult,
  EnsureSessionInput,
  EnsureSessionResult,
  FindSessionResult,
  IngestResult,
  ReadSelfUserResult,
  ReadSessionResult,
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
  let closes = 0;

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
      let insertedMessages = 0;
      let insertedToolNotes = 0;

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
        inserted: { messages: insertedMessages, toolNotes: insertedToolNotes },
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

    snapshot(): MemoryStoreSnapshot {
      return {
        users: [...users.values()],
        projects: [...projects.values()],
        worktrees: [...worktrees.values()],
        sessions: [...sessions.values()],
        messages: [...messages.values()].flat(),
        toolNotes: [...toolNotes.values()].flat(),
        closes,
      };
    },
  };
}

/**
 * One worktree's key. A newline, because a path may hold anything else a
 * separator could be made of.
 */
function worktreeKey(projectId: string, path: string): string {
  return `${projectId}\n${path}`;
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
