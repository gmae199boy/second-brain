import type { IngestBatch } from '../../domain/ingest-batch.js';
import type { Message } from '../../domain/message.js';
import type { Session } from '../../domain/session.js';
import {
  formatSessionToken,
  type SessionToken,
} from '../../domain/session-token.js';
import type { ToolNote } from '../../domain/tool-note.js';
import type { Clock } from '../../ports/clock.js';
import type { IdGen } from '../../ports/id-gen.js';
import type {
  EnsureSessionInput,
  EnsureSessionResult,
  IngestResult,
  ReadSessionResult,
  Store,
  StoreHealth,
  StoreWarningCode,
} from '../../ports/store.js';
import { sequenceIdGen } from './id-gen.js';
import { fixedClock } from './clock.js';

const DEFAULT_HEALTH: StoreHealth = {
  ok: true,
  serverVersion: '18.1',
  source: { location: 'memory', probes: [{ id: 'vector', ok: true, detail: '0.8.7' }] },
};

/** 2026-01-01T00:00:00Z, so the default ids and timestamps are reproducible. */
const DEFAULT_INSTANT = new Date('2026-01-01T00:00:00.000Z');

export interface MemoryStoreOptions {
  /** What `checkHealth` answers. Defaults to a healthy store. */
  health?: StoreHealth;
  /** Ids for the rows this store creates. Defaults to a deterministic sequence. */
  idGen?: IdGen;
  /** Source of `ingestedAt`. Defaults to a fixed instant. */
  clock?: Clock;
}

/** What the store holds, for the owning test. Contract cases never use it. */
export interface MemoryStoreSnapshot {
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
 */
export function memoryStore(options: MemoryStoreOptions = {}): MemoryStore {
  const {
    health = DEFAULT_HEALTH,
    idGen = sequenceIdGen({ timestampMs: DEFAULT_INSTANT.getTime() }),
    clock = fixedClock(DEFAULT_INSTANT),
  } = options;

  const sessions = new Map<SessionToken, Session>();
  const messages = new Map<SessionToken, Message[]>();
  const toolNotes = new Map<SessionToken, ToolNote[]>();
  let closes = 0;

  return {
    async checkHealth(): Promise<StoreHealth> {
      return health;
    },

    async close(): Promise<void> {
      closes += 1;
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

      for (const parsed of batch.messages) {
        const duplicate = storedMessages.some(
          (stored) =>
            stored.harnessMessageId === parsed.harnessMessageId || stored.seq === parsed.seq,
        );
        if (duplicate) continue;
        storedMessages.push({
          id: idGen.next(),
          sessionId: session.id,
          harnessMessageId: parsed.harnessMessageId,
          seq: parsed.seq,
          role: parsed.role,
          model: parsed.model,
          body: parsed.body,
          occurredAt: parsed.occurredAt,
        });
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
          id: idGen.next(),
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
        ingestedAt: clock.now(),
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
      return {
        ok: true,
        session: { ...session },
        messages: [...(messages.get(token) ?? [])],
        toolNotes: [...(toolNotes.get(token) ?? [])],
      };
    },

    snapshot(): MemoryStoreSnapshot {
      return {
        sessions: [...sessions.values()],
        messages: [...messages.values()].flat(),
        toolNotes: [...toolNotes.values()].flat(),
        closes,
      };
    },
  };
}
