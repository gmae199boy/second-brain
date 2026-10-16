import type {
  IngestBatch,
  IngestMessage,
  IngestToolNote,
} from '../domain/ingest-batch.js';
import {
  parseSessionToken,
  type SessionKey,
  type SessionToken,
} from '../domain/session-token.js';
import type { WarningCode } from '../codes.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Parser } from '../ports/parser.js';
import type { IngestCounts, SessionStore, UserStore } from '../ports/store.js';
import type { TranscriptReader } from '../ports/transcript.js';

/**
 * What a caller asks `sessions.ingest` for. Surface neutral: the session is the
 * token that crosses process boundaries (AD-8, AD-28), and the transcript is a
 * path the harness named — Core never goes looking for one.
 */
export interface IngestSessionInput {
  /** `harness:harness_session_id`, as the hook reported it. */
  session: SessionToken;
  /** Where the harness is writing the transcript. Read through the port. */
  transcriptPath: string;
}

/** What one ingest did. A replay reports the same session and inserts nothing. */
export interface IngestSessionData {
  session: SessionToken;
  /** Whether this call is the one that created the session row. */
  created: boolean;
  inserted: IngestCounts;
}

export type IngestSessionResult =
  | ({ ok: true; warnings: readonly WarningCode[] } & IngestSessionData)
  | {
      ok: false;
      code:
        | 'USAGE'
        | 'TRANSCRIPT_UNREADABLE'
        | 'USER_MISSING'
        | 'SESSION_NOT_FOUND'
        | 'DB_UNAVAILABLE'
        | 'DB_LOCKED';
      message: string;
    };

/** Everything the use case is given, all of it a port (AD-1). */
export interface IngestSessionDependencies {
  store: SessionStore & UserStore;
  clock: Clock;
  idGen: IdGen;
  /** Every parser this build can read a transcript with, by harness (AD-4). */
  parsers: readonly Parser[];
  transcripts: TranscriptReader;
  /** The machine this session ran on, recorded once on the row (AD-12). */
  machine: string;
}

/**
 * Read a harness transcript and append whatever is new to the session.
 *
 * The order is the whole of the use case, and it is this order on purpose:
 *
 *   token → parser → read → parse → owner → ensure → ingest
 *
 * Reading and parsing come before anything is written, because they are the
 * slow part and a write transaction that waited on a disk would hold the one
 * SQLite writer for as long as the file takes (AD-7). The session row is
 * created only once there is at least one message to put in it — a transcript
 * with no conversation in it yet is the usual state of a session's first
 * seconds, and a row for it would be a session that never happened.
 *
 * Every id and every instant is decided here and handed over: the store mints
 * nothing and reads no clock (AD-8, AD-13), so the same batch spooled and
 * replayed later lands with the values it was first given (AD-9).
 */
export async function ingestSession(
  dependencies: IngestSessionDependencies,
  input: IngestSessionInput,
): Promise<IngestSessionResult> {
  const { store, clock, idGen, parsers, transcripts, machine } = dependencies;

  const token = parseSessionToken(input.session);
  if (!token.ok) {
    return { ok: false, code: 'USAGE', message: token.message };
  }
  const key: SessionKey = token.key;

  const parser = parsers.find((candidate) => candidate.harness === key.harness);
  if (parser === undefined) {
    const known = parsers.map((candidate) => candidate.harness).join(', ');
    return {
      ok: false,
      code: 'USAGE',
      message:
        known === ''
          ? `this build can read no harness, so it cannot ingest "${key.harness}"`
          : `no parser for harness "${key.harness}". Known harnesses: ${known}.`,
    };
  }

  if (input.transcriptPath === '') {
    return {
      ok: false,
      code: 'USAGE',
      message: 'the hook named no transcript, so there is nothing to read',
    };
  }

  const read = await transcripts.read(input.transcriptPath);
  if (!read.ok) return read;

  const parsed = parser.parse(read.content);
  if (!parsed.ok) return parsed;

  // No conversation yet: no row, nothing inserted, and no failure either. The
  // Stop hook of a turn whose last answer has not been flushed arrives here.
  if (parsed.messages.length === 0) {
    return {
      ok: true,
      session: input.session,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
      warnings: [],
    };
  }

  const owner = await store.readSelfUser();
  if (!owner.ok) return owner;
  if (owner.user === null) {
    return {
      ok: false,
      code: 'USER_MISSING',
      message: 'this database records no owner, so a session has nobody to belong to',
    };
  }

  // One instant for the whole batch, read once (AD-13).
  const ingestedAt = clock.now();
  const messages: IngestMessage[] = parsed.messages.map((message) => ({
    ...message,
    id: idGen.next(),
  }));
  const toolNotes: IngestToolNote[] = parsed.toolNotes.map((note) => ({
    ...note,
    id: idGen.next(),
  }));

  const ensured = await store.ensureSession({
    id: idGen.next(),
    key,
    userId: owner.user.id,
    machine,
    // When the session's first message was uttered. An existing row keeps the
    // `started_at` it already has.
    startedAt: firstOccurredAt(messages),
    ingestSource: 'live',
    // The tags are story 2.8's and `start_source` is story 2.7's: a value
    // invented here would be one they have to migrate away from.
    startSource: null,
    workspaceId: null,
    projectId: null,
    worktreeId: null,
  });
  if (!ensured.ok) return ensured;

  const batch: IngestBatch = {
    key,
    tracking: {
      parserVersion: parsed.parserVersion,
      cursor: parsed.cursor,
      // The cursor is story 2.7's; until then every read starts at the front,
      // which is the normal case and not a reset of anything.
      cursorReset: false,
      endedAt: null,
      ingestedAt,
    },
    messages,
    toolNotes,
  };

  const ingested = await store.ingest(batch);
  if (!ingested.ok) return ingested;

  return {
    ok: true,
    session: input.session,
    created: ensured.created,
    inserted: ingested.inserted,
    warnings: ingested.warnings,
  };
}

/**
 * When the first message of the batch was uttered, which is the session's
 * `started_at` (Boundaries).
 *
 * The *first*, not the earliest: order comes from the position in the
 * transcript and never from a clock (research §4). A harness that wrote two
 * lines out of timestamp order wrote the conversation in the order it
 * happened, and taking the minimum here would start the session at a message
 * that is not its first.
 */
function firstOccurredAt(messages: readonly IngestMessage[]): Date {
  const first = messages[0];
  if (first === undefined) {
    // `ingestSession` returns before this on an empty batch; a caller that got
    // here anyway is a bug, and a bug throws (Conventions).
    throw new TypeError('a session cannot be created from a batch with no messages');
  }
  return first.occurredAt;
}
