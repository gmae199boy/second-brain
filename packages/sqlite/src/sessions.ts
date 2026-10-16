import {
  formatInstant,
  parseInstant,
  parseSessionToken,
  type EnsureSessionInput,
  type EnsureSessionResult,
  type IngestBatch,
  type IngestResult,
  type Message,
  type ReadSessionResult,
  type Session,
  type SessionIngestSource,
  type SessionKey,
  type SessionStartSource,
  type SessionStore,
  type SessionToken,
  type StoreWarningCode,
  type ToolNote,
} from '@second-brain/core';
import { sql, type Kysely } from 'kysely';
import { describe, type SqliteConnect } from './connect.js';
import type { SqliteSchema } from './driver.js';
import { withWrite } from './write.js';

/** A `sessions` row as SQLite hands it back: text instants, no booleans. */
interface SessionRow {
  id: string;
  harness: string;
  harness_session_id: string;
  user_id: string;
  machine: string;
  started_at: string;
  workspace_id: string | null;
  project_id: string | null;
  worktree_id: string | null;
  ingest_source: string;
  ended_at: string | null;
  last_harness_message_id: string | null;
  cursor_fingerprint: string | null;
  parser_version: string | null;
  ingested_at: string | null;
  start_source: string | null;
  continued_from_session_id: string | null;
}

interface MessageRow {
  id: string;
  session_id: string;
  harness_message_id: string;
  seq: number;
  role: string;
  model: string | null;
  body: string;
  occurred_at: string;
}

interface ToolNoteRow {
  id: string;
  session_id: string;
  harness_message_id: string;
  ordinal: number;
  tool: string;
  target: string;
  ok: number;
}

/**
 * The session capability on the local source: find-or-create, an idempotent
 * batch append, and a read by session token (AD-14).
 *
 * The one thing worth reading twice is where `seq` comes from. It is decided
 * here, inside the `withWrite` transaction, and never by the parser: a compact
 * or a fork rewrites the front of a transcript, so a number worked out from the
 * file would land on a message that already has one (AD-4, AD-8). The batch
 * continues from `max(seq) + 1` in its own order, skipping the messages this
 * session already holds.
 *
 * The inserts conflict on the natural key alone — `(session_id,
 * harness_message_id)` — and never on `(session_id, seq)`. That is deliberate:
 * a `seq` collision means this code numbered two messages the same, which is a
 * bug, and `on conflict (session_id, seq) do nothing` would swallow it. Left
 * out, the unique index raises and the transaction rolls back.
 */
export function sqliteSessionStore(connect: SqliteConnect): SessionStore {
  return {
    async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const startedAt = instant(input.startedAt, 'sessions.started_at');

      const written = await withWrite(opened.connection, async (held) => {
        // `on conflict do nothing` with no target, so both of this table's
        // keys land here: the primary key and `(harness, harness_session_id)`.
        // `returning` is how "did this call create it?" is answered — a row
        // came back or none did — rather than by comparing ids afterwards.
        const inserted = await sql<{ id: string }>`
          insert into sessions (id, harness, harness_session_id, user_id, machine,
                                started_at, workspace_id, project_id, worktree_id,
                                ingest_source, start_source)
               values (${input.id}, ${input.key.harness}, ${input.key.harnessSessionId},
                       ${input.userId}, ${input.machine}, ${startedAt},
                       ${input.workspaceId}, ${input.projectId}, ${input.worktreeId},
                       ${input.ingestSource}, ${input.startSource})
          on conflict do nothing
            returning id
        `.execute(held);
        const row = await readSessionRow(held, input.key);
        return { created: inserted.rows.length > 0, row };
      });
      if (!written.ok) return written;

      const { created, row } = written.value;
      if (row === null) {
        // The insert did nothing and the key is still not there: the proposed
        // id already belongs to another session, which is a caller reusing an
        // id it did not mint.
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `${input.key.harness}:${input.key.harnessSessionId} 세션이 ensureSession 뒤에도 없습니다. ${input.id}는 이미 다른 세션의 것입니다`,
        };
      }
      return { ok: true, created, session: toSession(row) };
    },

    async ingest(batch: IngestBatch): Promise<IngestResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const ingestedAt = instant(batch.tracking.ingestedAt, 'sessions.ingested_at');
      const endedAt =
        batch.tracking.endedAt === null
          ? null
          : instant(batch.tracking.endedAt, 'sessions.ended_at');
      // Outside the transaction: a batch carrying an instant the schema cannot
      // store is a bug, and finding that out before the write lock is taken
      // keeps the bug from being a lock everybody else waits on (AD-7).
      const pending = batch.messages.map((message) => ({
        message,
        occurredAt: instant(message.occurredAt, 'messages.occurred_at'),
      }));

      const written = await withWrite(opened.connection, async (held) => {
        const session = await readSessionRow(held, batch.key);
        if (session === null) return null;

        // Both read before any insert, so the batch is numbered in its own
        // order and a message already stored keeps the number it has.
        const stored = await sql<{ harness_message_id: string }>`
          select harness_message_id from messages where session_id = ${session.id}
        `.execute(held);
        const seen = new Set(stored.rows.map((row) => row.harness_message_id));
        const top = await sql<{ top: number | null }>`
          select max(seq) as top from messages where session_id = ${session.id}
        `.execute(held);
        let nextSeq = (top.rows[0]?.top ?? -1) + 1;

        let insertedMessages = 0;
        for (const { message, occurredAt } of pending) {
          if (seen.has(message.harnessMessageId)) continue;
          seen.add(message.harnessMessageId);
          const inserted = await sql<{ id: string }>`
            insert into messages (id, session_id, harness_message_id, seq, role, model,
                                  body, occurred_at)
                 values (${message.id}, ${session.id}, ${message.harnessMessageId},
                         ${nextSeq}, ${message.role}, ${message.model}, ${message.body},
                         ${occurredAt})
            on conflict (session_id, harness_message_id) do nothing
              returning id
          `.execute(held);
          // By what actually went in, not by one: a row the conflict clause
          // dropped took no number, and advancing past it would leave a hole
          // in a column the contract says runs 0, 1, 2, … with no gaps.
          nextSeq += inserted.rows.length;
          insertedMessages += inserted.rows.length;
        }

        let insertedToolNotes = 0;
        for (const note of batch.toolNotes) {
          const inserted = await sql<{ id: string }>`
            insert into tool_notes (id, session_id, harness_message_id, ordinal, tool,
                                    target, ok)
                 values (${note.id}, ${session.id}, ${note.harnessMessageId},
                         ${note.ordinal}, ${note.tool}, ${note.target},
                         ${note.ok ? 1 : 0})
            on conflict (session_id, harness_message_id, ordinal) do nothing
              returning id
          `.execute(held);
          insertedToolNotes += inserted.rows.length;
        }

        // The tracking columns land in the same transaction as the rows, so a
        // cursor never claims a message that is not in the database (AD-7).
        await sql`
          update sessions
             set parser_version = ${batch.tracking.parserVersion},
                 ingested_at = ${ingestedAt}
           where id = ${session.id}
        `.execute(held);
        const cursor = batch.tracking.cursor;
        if (cursor !== null) {
          await sql`
            update sessions
               set last_harness_message_id = ${cursor.lastHarnessMessageId},
                   cursor_fingerprint = ${cursor.fingerprint}
             where id = ${session.id}
          `.execute(held);
        }
        if (endedAt !== null) {
          // Monotonic: the end of a session only ever moves forward (AD-6).
          await sql`
            update sessions
               set ended_at = ${endedAt}
             where id = ${session.id}
               and (ended_at is null or ended_at < ${endedAt})
          `.execute(held);
        }

        return {
          sessionId: session.id,
          inserted: { messages: insertedMessages, toolNotes: insertedToolNotes },
        };
      });
      if (!written.ok) return written;

      if (written.value === null) {
        return {
          ok: false,
          code: 'SESSION_NOT_FOUND',
          message: `${batch.key.harness}:${batch.key.harnessSessionId} 세션이 없습니다. ensureSession을 먼저 호출하세요 (AD-12).`,
        };
      }

      const warnings: StoreWarningCode[] = batch.tracking.cursorReset ? ['CURSOR_RESET'] : [];
      return { ok: true, ...written.value, warnings };
    },

    async readSession(token: SessionToken): Promise<ReadSessionResult> {
      const parsed = parseSessionToken(token);
      if (!parsed.ok) {
        // A token nothing can name a session with: there is no such session,
        // which is the same answer as one nobody stored.
        return { ok: false, code: 'SESSION_NOT_FOUND', message: parsed.message };
      }

      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const { db } = opened.connection;
      try {
        const row = await readSessionRow(db, parsed.key);
        if (row === null) {
          return { ok: false, code: 'SESSION_NOT_FOUND', message: `${token} 세션이 없습니다` };
        }

        const messages = await sql<MessageRow>`
          select id, session_id, harness_message_id, seq, role, model, body, occurred_at
            from messages
           where session_id = ${row.id}
           order by seq
        `.execute(db);
        // Ordered by the message's own position and then by the ordinal inside
        // it, so a reader walking the notes walks the conversation. A note
        // whose message is not stored sorts last rather than disappearing.
        const toolNotes = await sql<ToolNoteRow>`
          select n.id, n.session_id, n.harness_message_id, n.ordinal, n.tool, n.target, n.ok
            from tool_notes n
            left join messages m
              on m.session_id = n.session_id
             and m.harness_message_id = n.harness_message_id
           where n.session_id = ${row.id}
           order by m.seq is null, m.seq, n.ordinal
        `.execute(db);

        return {
          ok: true,
          session: toSession(row),
          messages: messages.rows.map(toMessage),
          toolNotes: toolNotes.rows.map(toToolNote),
        };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `세션을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },
  };
}

/** The row for one session key, or `null`. The one place the key is spelled. */
async function readSessionRow(
  held: Kysely<SqliteSchema>,
  key: SessionKey,
): Promise<SessionRow | null> {
  const found = await sql<SessionRow>`
    select id, harness, harness_session_id, user_id, machine, started_at,
           workspace_id, project_id, worktree_id, ingest_source, ended_at,
           last_harness_message_id, cursor_fingerprint, parser_version,
           ingested_at, start_source, continued_from_session_id
      from sessions
     where harness = ${key.harness}
       and harness_session_id = ${key.harnessSessionId}
  `.execute(held);
  return found.rows[0] ?? null;
}

/**
 * One instant as the canonical text the schema's `glob` checks demand (AD-13).
 * A value the codec refuses never came from a `Clock` or a parsed timestamp, so
 * it is a bug and throws rather than becoming a coded failure (Conventions).
 */
function instant(value: Date, column: string): string {
  const formatted = formatInstant(value);
  if (!formatted.ok) {
    throw new TypeError(`${column} cannot hold this instant: ${formatted.message}`);
  }
  return formatted.value;
}

/** The other direction. A row holding anything else was not written by us. */
function at(value: string, column: string): Date {
  const parsed = parseInstant(value);
  if (!parsed.ok) {
    throw new Error(`${column}을 읽을 수 없습니다: ${parsed.message}`);
  }
  return parsed.value;
}

function toSession(row: SessionRow): Session {
  return {
    id: row.id,
    harness: row.harness,
    harnessSessionId: row.harness_session_id,
    userId: row.user_id,
    machine: row.machine,
    startedAt: at(row.started_at, 'sessions.started_at'),
    workspaceId: row.workspace_id,
    projectId: row.project_id,
    worktreeId: row.worktree_id,
    // The `check` constraint is what keeps these to the values the domain
    // names, so the cast states what the schema already enforces.
    ingestSource: row.ingest_source as SessionIngestSource,
    endedAt: row.ended_at === null ? null : at(row.ended_at, 'sessions.ended_at'),
    cursor:
      row.last_harness_message_id === null || row.cursor_fingerprint === null
        ? null
        : {
            lastHarnessMessageId: row.last_harness_message_id,
            fingerprint: row.cursor_fingerprint,
          },
    parserVersion: row.parser_version,
    ingestedAt: row.ingested_at === null ? null : at(row.ingested_at, 'sessions.ingested_at'),
    startSource: row.start_source as SessionStartSource | null,
    continuedFromSessionId: row.continued_from_session_id,
  };
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    sessionId: row.session_id,
    harnessMessageId: row.harness_message_id,
    seq: row.seq,
    role: row.role === 'assistant' ? 'assistant' : 'user',
    model: row.model,
    body: row.body,
    occurredAt: at(row.occurred_at, 'messages.occurred_at'),
  };
}

function toToolNote(row: ToolNoteRow): ToolNote {
  return {
    id: row.id,
    sessionId: row.session_id,
    harnessMessageId: row.harness_message_id,
    ordinal: row.ordinal,
    tool: row.tool,
    target: row.target,
    ok: row.ok === 1,
  };
}
