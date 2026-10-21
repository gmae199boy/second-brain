import {
  formatInstant,
  parseInstant,
  parseSessionToken,
  type EnsureSessionInput,
  type EnsureCheckoutInput,
  type FillSessionTagsInput,
  type FillSessionTagsResult,
  type EnsureSessionResult,
  type FindSessionResult,
  type IngestBatch,
  type IngestResult,
  type Message,
  type ParserCursor,
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
import { ensureWork } from './work.js';
import { withWrite, type WriteResult } from './write.js';

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
  role: string;
  model: string | null;
  body: string;
  occurred_at: string;
  git_branch: string | null;
  /** `integer` with a `check (x in (0, 1))`: SQLite has no boolean (0004). */
  is_subagent_report: number;
}

/**
 * What one `ensureSession` transaction settled: the row and whether this call
 * is the one that made it.
 */
interface EnsuredSession {
  created: boolean;
  row: SessionRow;
}

/**
 * The one reason an `ensureSession` transaction gives up: a proposed id that
 * already belongs to another row, so neither the session nor its tags can be
 * settled.
 *
 * It is thrown and not returned, because `withWrite` commits whatever the
 * callback hands back — and a return here would commit the project and the
 * worktree this transaction had already inserted, leaving rows with no session
 * pointing at them, which is the one thing the port rule forbids. Thrown, the
 * transaction rolls back; the message is caught at the call and becomes the
 * coded value the caller sees (Conventions: expected failures are values).
 */
class UnsettledEnsure extends Error {}

/** The two tags of a settled checkout. */
interface CheckoutTags {
  projectId: string | null;
  worktreeId: string | null;
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
 * Three rules this adapter and Core's fake keep word for word (migration 0006,
 * AD-8):
 *
 *   * **a message has no number.** Its identity is `(session_id,
 *     harness_message_id)`, which is what the harness itself called it, and
 *     that is the one key an insert conflicts on. Nothing here counts
 *     messages, so a compact or a fork that rewrites the front of a transcript
 *     cannot renumber what is already stored.
 *   * **conversation order is `occurred_at`.** A read hands the messages back
 *     by it, so a message the parser only started keeping in a later version
 *     is read where it was uttered rather than at the end. Two messages at the
 *     same instant come back in no defined order. Tool notes follow their
 *     message's instant, then their message, then their own `ordinal`, so one
 *     message's notes stay together even then.
 *   * **the cursor is compared by the same instant.** It moves on a session
 *     whose stored cursor message is not among its rows, or when the batch's
 *     cursor message was uttered at or after the stored one. A batch that read
 *     from the start may also move it back, or clear it, but only while the
 *     session's cursor is still the `cursorBase` that read began from
 *     (`cursorMove`).
 *
 * The instants are the canonical 24-character text of AD-13, so SQLite's
 * string comparison *is* the chronological one and no parsing is needed to
 * sort or to compare.
 */
export function sqliteSessionStore(connect: SqliteConnect): SessionStore {
  return {
    async ensureSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      const startedAt = instant(input.startedAt, 'sessions.started_at');

      const ensure = async (held: Kysely<SqliteSchema>): Promise<EnsuredSession> => {
        // The session first, and a key that is already stored ends the call:
        // the tags are decided once, by whoever created the session, and a
        // project row created for a session nobody creates would be a row
        // nothing ever points at (port contract).
        const stored = await readSessionRow(held, input.key);
        if (stored !== null) return { created: false, row: stored };

        // Find-or-create the checkout in the same transaction as the session,
        // so a session is never tagged with a project that is not there and a
        // project is never left behind by a session that was not created.
        const tags = await ensureCheckout(held, input.checkout);

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
                       ${input.workspaceId}, ${tags.projectId}, ${tags.worktreeId},
                       ${input.ingestSource}, ${input.startSource})
          on conflict do nothing
            returning id
        `.execute(held);
        const row = await readSessionRow(held, input.key);
        if (row === null) {
          // The insert did nothing and the key is still not there: the proposed
          // id already belongs to another session, which is a caller reusing an
          // id it did not mint. Thrown, so the project and the worktree this
          // transaction may have inserted go back with it.
          throw new UnsettledEnsure(
            `${input.key.harness}:${input.key.harnessSessionId} 세션이 ensureSession 뒤에도 없습니다. ${input.id}는 이미 다른 세션의 것입니다`,
          );
        }
        if (inserted.rows.length > 0 && input.identityWork !== null) {
          try {
            await ensureWork(held, input.identityWork);
          } catch (error) {
            throw new UnsettledEnsure(`정체성 일감을 만들 수 없습니다: ${describe(error)}`);
          }
        }
        return { created: inserted.rows.length > 0, row };
      };

      let written: WriteResult<EnsuredSession>;
      try {
        written = await withWrite(opened.connection, ensure);
      } catch (error) {
        // The one failure this transaction gives up on, as a value. Anything
        // else is a bug and goes on throwing (Conventions): a broken foreign
        // key here is a caller that passed an owner it had not read.
        if (error instanceof UnsettledEnsure) {
          return { ok: false, code: 'DB_UNAVAILABLE', message: error.message };
        }
        throw error;
      }
      if (!written.ok) return written;

      const { created, row } = written.value;
      try {
        // Widening the row is one more thing that can fail, and not because of
        // anything the caller did: `toSession` parses the instants it holds, so
        // a `started_at` that is `glob`-shaped but not a date — a row a human
        // edited — would otherwise leave this verb throwing where every caller
        // expects a code (follow-up review #19).
        return { ok: true, created, session: toSession(row) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `세션을 읽을 수 없습니다: ${describe(error)}`,
        };
      }
    },

    async fillSessionTags(input: FillSessionTagsInput): Promise<FillSessionTagsResult> {
      const opened = connect();
      if (!opened.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      try {
        const written = await withWrite(opened.connection, async (held): Promise<FillSessionTagsResult> => {
          const stored = await readSessionRow(held, input.key);
          if (stored === null) {
            return { ok: false, code: 'SESSION_NOT_FOUND', message: '세션을 찾을 수 없습니다' };
          }
          if (stored.project_id !== null || stored.worktree_id !== null) {
            return { ok: true, filled: false, session: toSession(stored) };
          }
          const tags = await ensureCheckout(held, input.checkout);
          await sql`
            update sessions set project_id = ${tags.projectId}, worktree_id = ${tags.worktreeId}
             where id = ${stored.id} and project_id is null and worktree_id is null
          `.execute(held);
          const row = await readSessionRow(held, input.key);
          if (row === null) throw new UnsettledEnsure('꼬리표를 채운 세션을 읽을 수 없습니다');
          return { ok: true, filled: true, session: toSession(row) };
        });
        return written.ok ? written.value : written;
      } catch (error) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: `꼬리표를 채울 수 없습니다: ${describe(error)}` };
      }
    },

    async findSession(key: SessionKey): Promise<FindSessionResult> {
      const opened = connect();
      if (!opened.ok) {
        return { ok: false, code: 'DB_UNAVAILABLE', message: opened.message };
      }

      try {
        const row = await readSessionRow(opened.connection.db, key);
        // One row and none of its conversation: this is what `sessions.ingest`
        // reads the cursor with, before it reads the transcript (AD-4).
        return { ok: true, session: row === null ? null : toSession(row) };
      } catch (error) {
        return {
          ok: false,
          code: 'DB_UNAVAILABLE',
          message: `세션을 찾을 수 없습니다: ${describe(error)}`,
        };
      }
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

        // Read before any insert: which messages this session already holds,
        // so a batch that carries them again writes nothing. It is the whole
        // of what ingest has to know about the stored conversation — there is
        // no counter to continue from (migration 0006).
        const stored = await sql<{ harness_message_id: string }>`
          select harness_message_id from messages where session_id = ${session.id}
        `.execute(held);
        const seen = new Set(stored.rows.map((row) => row.harness_message_id));

        let insertedMessages = 0;
        for (const { message, occurredAt } of pending) {
          if (seen.has(message.harnessMessageId)) continue;
          seen.add(message.harnessMessageId);
          // `cwd` is not among the columns on purpose: the parser reports it so
          // story 2.8 can tag the session with the first message's one, and no
          // message row keeps it (migration 0004).
          const inserted = await sql<{ id: string }>`
            insert into messages (id, session_id, harness_message_id, role, model,
                                  body, occurred_at, git_branch, is_subagent_report)
                 values (${message.id}, ${session.id}, ${message.harnessMessageId},
                         ${message.role}, ${message.model}, ${message.body},
                         ${occurredAt}, ${message.gitBranch},
                         ${message.isSubagentReport ? 1 : 0})
            on conflict (session_id, harness_message_id) do nothing
              returning id
          `.execute(held);
          insertedMessages += inserted.rows.length;
          // No `redactions` row is written here, by anybody: ingest stores the
          // body as it read it, and masking happens on the way out (마스킹 B,
          // AD-11). The only writer of that table is `messages.redact`.
        }

        // Read once, before any insert, the way the messages above are: which
        // calls this session already holds, by the harness's own id for the
        // call and by position. A query per note would be a round trip per
        // call on a transcript that can carry thousands (#20).
        const heldNotes = await sql<{
          harness_message_id: string;
          ordinal: number;
          call_id: string | null;
        }>`
          select harness_message_id, ordinal, call_id
            from tool_notes where session_id = ${session.id}
        `.execute(held);
        /** The call ids this session already has a row for. */
        const heldCalls = new Set(
          heldNotes.rows
            .map((row) => row.call_id)
            .filter((callId): callId is string => callId !== null),
        );
        /** The positions it holds a row with *no* call id at. */
        const heldPlaces = new Set(
          heldNotes.rows
            .filter((row) => row.call_id === null)
            .map((row) => place(row.harness_message_id, row.ordinal)),
        );

        let insertedToolNotes = 0;
        for (const note of batch.toolNotes) {
          // Already here, and the insert is not even attempted: the same call
          // under its own id wherever it sits, or a row an older parser version
          // left with no id at this note's position or at one of the positions
          // that version may have used (`domain/ingest-batch.ts`, #9).
          if (note.callId !== null && heldCalls.has(note.callId)) continue;
          const places = [
            place(note.harnessMessageId, note.ordinal),
            ...note.earlierPositions.map((at) => place(at.harnessMessageId, at.ordinal)),
          ];
          if (places.some((at) => heldPlaces.has(at))) continue;
          // Bare `do nothing`, so *either* key may be the one that stops it:
          // the position, which some other call may already stand at, and the
          // partial unique index on `(session_id, call_id)`. A dropped insert
          // is not counted, because nothing was written.
          const inserted = await sql<{ id: string }>`
            insert into tool_notes (id, session_id, harness_message_id, ordinal, tool,
                                    target, ok, call_id)
                 values (${note.id}, ${session.id}, ${note.harnessMessageId},
                         ${note.ordinal}, ${note.tool}, ${note.target},
                         ${note.ok ? 1 : 0}, ${note.callId})
            on conflict do nothing
              returning id
          `.execute(held);
          insertedToolNotes += inserted.rows.length;
          if (inserted.rows.length > 0) {
            // So that two notes of one batch cannot both land at one position:
            // the rows read above are what was there before this batch.
            if (note.callId !== null) heldCalls.add(note.callId);
            else heldPlaces.add(place(note.harnessMessageId, note.ordinal));
          }
        }

        // The tracking columns land in the same transaction as the rows, so a
        // cursor never claims a message that is not in the database (AD-7).
        await sql`
          update sessions
             set parser_version = ${batch.tracking.parserVersion},
                 ingested_at = ${ingestedAt}
           where id = ${session.id}
        `.execute(held);
        // Only when the batch carries one and the row has none yet: a read that
        // saw no `SessionStart` attachment knows nothing about the start, and
        // writing its `null` would erase what an earlier read did know — while
        // the `and start_source is null` keeps the first answer learned, because
        // a second attachment is a later start and not why the session began
        // (follow-up review #18).
        if (batch.tracking.startSource !== null) {
          await sql`
            update sessions
               set start_source = ${batch.tracking.startSource}
             where id = ${session.id}
               and start_source is null
          `.execute(held);
        }
        const moved = await cursorMove(held, session, batch);
        if (moved.move) {
          // `null` for both halves is the cursor cleared, which is what a reset
          // read that found no message leaves behind: the table's own check
          // wants both halves or neither.
          await sql`
            update sessions
               set last_harness_message_id = ${moved.to?.lastHarnessMessageId ?? null},
                   cursor_fingerprint = ${moved.to?.fingerprint ?? null}
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
          inserted: {
            messages: insertedMessages,
            toolNotes: insertedToolNotes,
          },
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

        // Conversation order, which is when the messages were uttered
        // (migration 0006). `messages_session_occurred_idx` is this `order
        // by`, column for column, so the rows come off the index already
        // sorted. Two messages of one instant come back in whatever order the
        // index holds them, and nothing promises which.
        const messages = await sql<MessageRow>`
          select id, session_id, harness_message_id, role, model, body, occurred_at,
                 git_branch, is_subagent_report
            from messages
           where session_id = ${row.id}
           order by occurred_at
        `.execute(db);
        // Ordered by its message's instant, then by the message, then by the
        // ordinal inside it, so a reader walking the notes walks the
        // conversation. The middle key is what keeps one message's notes
        // together when two messages of the session share an instant —
        // without it the two sets interleave by ordinal. It orders notes and
        // says nothing about which of those two messages is read first, which
        // stays undefined (migration 0006). A note whose message is not stored
        // sorts last rather than disappearing.
        const toolNotes = await sql<ToolNoteRow>`
          select n.id, n.session_id, n.harness_message_id, n.ordinal, n.tool, n.target, n.ok
            from tool_notes n
            left join messages m
              on m.session_id = n.session_id
             and m.harness_message_id = n.harness_message_id
           where n.session_id = ${row.id}
           order by m.occurred_at is null, m.occurred_at, n.harness_message_id, n.ordinal
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

/**
 * Find-or-create the project and the worktree of a checkout, and hand back the
 * two ids the session row will carry (AD-12).
 *
 * `insert … on conflict do nothing` and then a `select`, rather than
 * `returning`: a `returning` says nothing when the conflict clause dropped the
 * row, which is exactly the case that matters — the identity was already there
 * and its own id is the one to use. The proposals are then quietly discarded,
 * which is what makes two worktrees of one clone a single project.
 *
 * It runs inside the caller's write transaction, so the select reads what the
 * insert just did and nothing can slip in between (AD-7). A proposal that
 * cannot be settled throws `UnsettledEnsure`, which rolls the whole
 * transaction back: a project row left behind by a session that was never
 * created is a row nothing will ever point at.
 */
async function ensureCheckout(
  held: Kysely<SqliteSchema>,
  checkout: EnsureCheckoutInput | null,
): Promise<CheckoutTags> {
  if (checkout === null) return { projectId: null, worktreeId: null };

  // Core owns comparison; the display identity stays the first inserted value.
  const identityKey = checkout.identityKey;

  await sql`
    insert into projects (id, remote_identity, identity_key)
         values (${checkout.projectId}, ${checkout.remoteIdentity}, ${identityKey})
    on conflict do nothing
  `.execute(held);
  const projects = await sql<{ id: string }>`
    select id from projects where identity_key = ${identityKey}
  `.execute(held);
  const projectId = projects.rows[0]?.id;
  if (projectId === undefined) {
    // The insert did nothing and the identity is still not there: the proposed
    // id already belongs to another project, which is a caller reusing an id
    // it did not mint.
    throw new UnsettledEnsure(
      `프로젝트 ${checkout.remoteIdentity}가 ensureSession 뒤에도 없습니다. ${checkout.projectId}는 이미 다른 프로젝트의 것입니다`,
    );
  }

  await sql`
    insert into worktrees (id, project_id, path)
         values (${checkout.worktreeId}, ${projectId}, ${checkout.worktreePath})
    on conflict do nothing
  `.execute(held);
  const worktrees = await sql<{ id: string }>`
    select id from worktrees
     where project_id = ${projectId} and path = ${checkout.worktreePath}
  `.execute(held);
  const worktreeId = worktrees.rows[0]?.id;
  if (worktreeId === undefined) {
    throw new UnsettledEnsure(
      `워크트리 ${checkout.worktreePath}가 ensureSession 뒤에도 없습니다. ${checkout.worktreeId}는 이미 다른 워크트리의 것입니다`,
    );
  }

  // `removed_at` is never touched here: a folder that is gone is marked by
  // drain, and this verb only ever adds rows (AD-12).
  return { projectId, worktreeId };
}

/** Whether the stored cursor is replaced, and by what — `null` clears it. */
interface CursorMove {
  move: boolean;
  to: ParserCursor | null;
}

/**
 * Whether this batch's cursor replaces the stored one, and with what (port
 * contract).
 *
 * Two hooks can overlap — one of them reading a longer transcript than the
 * other, and the shorter read committing last. Taking its cursor would point
 * the session at a message the other read had already passed, and the next read
 * would parse a stretch of the transcript it has already stored. So an ordinary
 * batch moves the cursor only forward: a session with no cursor message among
 * its rows, or a cursor message uttered at or after the stored one.
 *
 * That comparison is on `occurred_at` and not on the order the rows went in
 * (migration 0006). Insertion order is what the two overlapping reads disagree
 * about: the shorter read's last message may well be the newest row in the table
 * and is still the earlier moment of the conversation.
 *
 * A batch that reset is the one that may go backwards, and it is taken whole —
 * `null` included, which clears the cursor. The front of that transcript is not
 * what it was, so the file may well be shorter than the stored cursor claims,
 * and a cursor nothing can match again would reset every read from now on
 * (#16). What must not happen is a reset undoing an overlapping read, so it is
 * allowed only while the session's cursor is still the one that read began from
 * (`cursorBase`, #17); a reset that finds the session somewhere else falls back
 * to the forward-only rule.
 *
 * It runs inside the same transaction as the inserts, so a cursor message this
 * batch just stored is already there to be compared. One that is not stored at
 * all leaves the cursor where it was: the instants are canonical text, so a
 * plain `>=` on the strings is the chronological comparison (AD-13).
 */
async function cursorMove(
  held: Kysely<SqliteSchema>,
  session: SessionRow,
  batch: IngestBatch,
): Promise<CursorMove> {
  const cursor = batch.tracking.cursor;
  if (batch.tracking.cursorReset && sameCursor(storedCursor(session), batch.tracking.cursorBase)) {
    return { move: true, to: cursor };
  }

  const stay: CursorMove = { move: false, to: null };
  if (cursor === null) return stay;
  const was = session.last_harness_message_id;
  if (was === null) return { move: true, to: cursor };

  const instants = await sql<{ harness_message_id: string; occurred_at: string }>`
    select harness_message_id, occurred_at
      from messages
     where session_id = ${session.id}
       and harness_message_id in (${was}, ${cursor.lastHarnessMessageId})
  `.execute(held);
  const instantOf = (harnessMessageId: string): string | undefined =>
    instants.rows.find((row) => row.harness_message_id === harnessMessageId)?.occurred_at;

  const storedAt = instantOf(was);
  // The stored cursor names a message this session does not hold: nothing to
  // compare against, so the batch's cursor is the better one.
  if (storedAt === undefined) return { move: true, to: cursor };
  const nextAt = instantOf(cursor.lastHarnessMessageId);
  return nextAt !== undefined && nextAt >= storedAt ? { move: true, to: cursor } : stay;
}

/** The cursor a row holds, in the shape the batch carries its own in. */
function storedCursor(session: SessionRow): ParserCursor | null {
  if (session.last_harness_message_id === null || session.cursor_fingerprint === null) {
    return null;
  }
  return {
    lastHarnessMessageId: session.last_harness_message_id,
    fingerprint: session.cursor_fingerprint,
  };
}

/** Whether two cursors name the same message with the same fingerprint. */
function sameCursor(left: ParserCursor | null, right: ParserCursor | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.lastHarnessMessageId === right.lastHarnessMessageId &&
    left.fingerprint === right.fingerprint
  );
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
    role: row.role === 'assistant' ? 'assistant' : 'user',
    model: row.model,
    body: row.body,
    occurredAt: at(row.occurred_at, 'messages.occurred_at'),
    // As the line carried it, nulls included: nothing normalises a branch
    // (migration 0004).
    gitBranch: row.git_branch,
    isSubagentReport: row.is_subagent_report === 1,
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

/**
 * One tool-note position as a set key. The ordinal may be negative — a call the
 * harness made in front of its message's own line — so the separator is spelled
 * out rather than left to concatenation (`domain/ingest-batch.ts`).
 */
function place(harnessMessageId: string, ordinal: number): string {
  return `${harnessMessageId}#${String(ordinal)}`;
}
