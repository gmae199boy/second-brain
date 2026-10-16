import type { IngestBatch } from '../../domain/ingest-batch.js';
import type { Message } from '../../domain/message.js';
import type { Session } from '../../domain/session.js';
import {
  formatSessionToken,
  type SessionToken,
} from '../../domain/session-token.js';
import type { ToolNote } from '../../domain/tool-note.js';
import type { User } from '../../domain/user.js';
import type {
  EnsureSelfUserInput,
  EnsureSelfUserResult,
  EnsureSessionInput,
  EnsureSessionResult,
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
        return { ok: true, created: false, session: { ...existing } };
      }

      const session: Session = {
        id: input.id,
        harness: input.key.harness,
        harnessSessionId: input.key.harnessSessionId,
        userId: input.userId,
        machine: input.machine,
        startedAt: input.startedAt,
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        worktreeId: input.worktreeId,
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
        cursor: batch.tracking.cursor ?? session.cursor,
        parserVersion: batch.tracking.parserVersion,
        endedAt: batch.tracking.endedAt ?? session.endedAt,
        ingestedAt: batch.tracking.ingestedAt,
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
        sessions: [...sessions.values()],
        messages: [...messages.values()].flat(),
        toolNotes: [...toolNotes.values()].flat(),
        closes,
      };
    },
  };
}
