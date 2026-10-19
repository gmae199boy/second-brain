import type {
  IngestBatch,
  IngestMessage,
  IngestRedaction,
  IngestToolNote,
} from '../domain/ingest-batch.js';
import { normalizeRemoteIdentity } from '../domain/project-identity.js';
import { SECRET_PATTERN_VERSION, maskSecrets } from '../domain/secret-patterns.js';
import type { ParserCursor, Session } from '../domain/session.js';
import {
  parseSessionToken,
  type SessionKey,
  type SessionToken,
} from '../domain/session-token.js';
import type { SpoolCause } from '../domain/spool-record.js';
import type { WarningCode } from '../codes.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Parser } from '../ports/parser.js';
import type { RepositoryInspector } from '../ports/repository.js';
import type { Spool } from '../ports/spool.js';
import type {
  EnsureCheckoutInput,
  IngestCounts,
  SessionStore,
  UserStore,
} from '../ports/store.js';
import type { TranscriptReader } from '../ports/transcript.js';
import { spoolSessionIngest } from './spool-ingest.js';

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
  /**
   * The database could not take this, so a mark went to the spool instead and
   * a later drain will ingest the session again (AD-9). Nothing was created
   * and nothing was inserted when this is true — the counts below say what
   * reached the database, and this says where the write went.
   */
  spooled: boolean;
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
        | 'DB_LOCKED'
        | 'SCHEMA_MISMATCH';
      message: string;
    };

/** Everything the use case is given, all of it a port (AD-1). */
export interface IngestSessionDependencies {
  store: SessionStore & UserStore;
  /**
   * Where a turn goes when the database will not take it (AD-9). It is a
   * dependency of the ingest and not of its caller because the lock that stops
   * a write is discovered in the middle of the use case, and the only honest
   * answer from there is the spool rather than a failure the hook would drop.
   */
  spool: Spool;
  clock: Clock;
  idGen: IdGen;
  /** Every parser this build can read a transcript with, by harness (AD-4). */
  parsers: readonly Parser[];
  transcripts: TranscriptReader;
  /**
   * Asking git what a working folder is, for the tags of a session this call
   * is about to create (AD-12). Core has no git of its own (AD-1).
   */
  repositories: RepositoryInspector;
  /** The machine this session ran on, recorded once on the row (AD-12). */
  machine: string;
}

/**
 * Read a harness transcript and append whatever is new to the session.
 *
 * The order is the whole of the use case, and it is this order on purpose:
 *
 *   token → parser → findSession → read → parse → owner → inspect → ensure → ingest
 *
 * Reading and parsing come before anything is written, because they are the
 * slow part and a write transaction that waited on a disk would hold the one
 * SQLite writer for as long as the file takes (AD-7). `findSession` comes
 * before the read because what it brings back is the cursor the parse needs:
 * the message the last read stopped at, so this one can start there instead of
 * at the front of a transcript that only grows (AD-4). It is a read of one row
 * and takes no lock.
 *
 * The session row is created only once there is at least one message to put in
 * it — a transcript with no conversation in it yet is the usual state of a
 * session's first seconds, and a row for it would be a session that never
 * happened. A batch of tool notes with no messages is the one case that still
 * goes in: the session is already there, so there is nothing to create, and the
 * notes belong to messages it already holds.
 *
 * `inspect` sits where it does because the tags are decided once and never
 * again (AD-12): it is asked only when `findSession` found nothing and the
 * parse brought a message, which is the one moment a session row can be
 * created. A session that is already there is never inspected — the hook of
 * every later turn would then pay for a git call whose answer is thrown away,
 * and a repository whose remote has since changed would answer differently
 * from the row that is already stored.
 *
 * Every id and every instant is decided here and handed over: the store mints
 * nothing and reads no clock (AD-8, AD-13), so the same batch spooled and
 * replayed later lands with the values it was first given (AD-9).
 *
 * Masking belongs to the same step. The bodies and the tool note targets go
 * through Core's versioned pattern list as the batch is assembled, before the
 * batch object exists — so a secret is gone by the time anything can hold on to
 * it, and a record of what went is attached to the message it came out of
 * (AD-11).
 *
 * Every store step can answer "the database will not take this" — the file is
 * not there, or another process held the one SQLite writer for longer than this
 * path's budget — and every one of them then goes to the same place: a mark in
 * the spool and a success carrying `SPOOLED` (AD-9). The first such answer ends
 * the call, so a hook spends its three-second budget once and not four times
 * (Boundaries). Nothing else is spooled: a transcript that cannot be read, a
 * database with no owner and a call that named no session are all things no
 * amount of waiting fixes.
 */
export async function ingestSession(
  dependencies: IngestSessionDependencies,
  input: IngestSessionInput,
): Promise<IngestSessionResult> {
  const { store, spool, clock, idGen, parsers, transcripts, repositories, machine } =
    dependencies;

  /** The one way out when the database will not take a write (AD-9). */
  const spooled = async (cause: SpoolCause): Promise<IngestSessionResult> =>
    spoolSessionIngest({ spool, clock, idGen }, input, cause);

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
          ? `이 빌드는 어떤 하네스도 읽지 못하므로 "${key.harness}"를 수집할 수 없습니다`
          : `"${key.harness}" 하네스를 읽을 파서가 없습니다. 아는 하네스: ${known}.`,
    };
  }

  if (input.transcriptPath === '') {
    return {
      ok: false,
      code: 'USAGE',
      message: 'hook이 트랜스크립트를 알려 주지 않아 읽을 것이 없습니다',
    };
  }

  // The stored cursor, before the file is read: it is what lets the parse start
  // where the last one stopped (AD-4). A session nobody has ingested yet comes
  // back as `null`, which is a value and not a failure.
  const found = await store.findSession(key);
  if (!found.ok) return unwritable(found.code) ? spooled(found.code) : found;
  const stored = found.session;

  const read = await transcripts.read(input.transcriptPath);
  if (!read.ok) return read;

  // A cursor is only worth anything to the parser that made it. A session read
  // under an older parser version is read again from the front, because the
  // rules that decided what a message is have moved: lines the old version
  // dropped are messages now, and starting at its cursor would leave them
  // behind for good. Re-reading inserts nothing that is already stored (AD-8).
  const parsed = parser.parse(read.content, cursorFor(stored, parser.version));
  if (!parsed.ok) return parsed;

  // Nothing to put anywhere: no row, nothing inserted, and no failure either.
  // The Stop hook of a turn whose last answer has not been flushed arrives
  // here, and so does every hook of a session's first seconds.
  if (parsed.messages.length === 0 && (stored === null || parsed.toolNotes.length === 0)) {
    return {
      ok: true,
      session: input.session,
      spooled: false,
      created: false,
      inserted: { messages: 0, toolNotes: 0, redactions: 0 },
      warnings: [],
    };
  }

  const owner = await store.readSelfUser();
  if (!owner.ok) return unwritable(owner.code) ? spooled(owner.code) : owner;
  if (owner.user === null) {
    return {
      ok: false,
      code: 'USER_MISSING',
      message: '이 데이터베이스에 주인이 기록되어 있지 않아 세션이 속할 사람이 없습니다',
    };
  }

  // One instant for the whole batch, read once (AD-13).
  const ingestedAt = clock.now();

  // Masking happens here, where the batch is built, and not where it is stored.
  // Everything after this line — the store, a spool file, a log, an error
  // message — only ever sees a body that has already been through the pattern
  // list, so a secret pasted into a conversation has no second place to leak
  // from (AD-11). `cwd` is untouched by it, so the tags below read the folder
  // the line actually carried.
  const messages: IngestMessage[] = parsed.messages.map((message) => {
    const masked = maskSecrets(message.body, 'body');
    const id = idGen.next();
    const redactions: IngestRedaction[] = masked.spans.map((span) => ({
      id: idGen.next(),
      start: span.start,
      end: span.end,
      kind: span.kind,
      // The hash of what went, never the text: that is the whole point (AD-11).
      contentHash: span.removed,
      patternVersion: SECRET_PATTERN_VERSION,
      occurredAt: ingestedAt,
    }));
    return { ...message, id, body: masked.text, redactions };
  });
  // The target is masked too, and leaves no record: a `redactions` row is a
  // span over a body, and 0004 has no column that could name a tool note
  // (Decision 2026-10-18).
  const toolNotes: IngestToolNote[] = parsed.toolNotes.map((note) => ({
    ...note,
    id: idGen.next(),
    target: maskSecrets(note.target, 'tool_target').text,
  }));

  // A batch with no messages is one of tool notes alone, and only for a session
  // that is already there — so there is nothing to create and no `started_at`
  // to propose. Everything else goes through find-or-create (AD-12).
  let created = false;
  if (messages.length > 0) {
    // The tags, and the one place they are ever worked out: only for a session
    // `findSession` did not find, and only from the first message's `cwd`
    // (AD-12). The process's own cwd is never the evidence — a hook runs
    // wherever the harness happened to leave it.
    const checkout =
      stored === null
        ? await checkoutFor(repositories, idGen, messages[0]?.cwd ?? null)
        : null;
    const ensured = await store.ensureSession({
      id: idGen.next(),
      key,
      userId: owner.user.id,
      machine,
      // When the session's first message was uttered. An existing row keeps the
      // `started_at` it already has.
      startedAt: firstOccurredAt(messages),
      ingestSource: 'live',
      // Why the harness started this session, when the transcript said so. An
      // existing row takes it from the batch instead, which is what lets a
      // session created by an earlier read still learn its start source.
      startSource: parsed.startSource,
      // Slice 1 never groups projects, so nothing fills this (AD-12).
      workspaceId: null,
      checkout,
    });
    if (!ensured.ok) return unwritable(ensured.code) ? spooled(ensured.code) : ensured;
    created = ensured.created;
  }

  const batch: IngestBatch = {
    key,
    tracking: {
      parserVersion: parsed.parserVersion,
      cursor: parsed.cursor,
      cursorReset: parsed.cursorReset,
      startSource: parsed.startSource,
      endedAt: null,
      ingestedAt,
    },
    messages,
    toolNotes,
  };

  const ingested = await store.ingest(batch);
  if (!ingested.ok) return unwritable(ingested.code) ? spooled(ingested.code) : ingested;

  return {
    ok: true,
    session: input.session,
    spooled: false,
    created,
    inserted: ingested.inserted,
    warnings: ingested.warnings,
  };
}

/**
 * Whether a store's failure means "the database will not take a write", which
 * is the one class of failure that goes to the spool rather than back to the
 * caller (AD-9, AD-21).
 *
 * The parameter is a `string` because the four store steps each have a narrower
 * code union of their own and a predicate has to be assignable to what it
 * narrows; the union it narrows *to* is what keeps the call sites honest.
 */
function unwritable(code: string): code is 'DB_UNAVAILABLE' | 'DB_LOCKED' {
  return code === 'DB_UNAVAILABLE' || code === 'DB_LOCKED';
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
/**
 * The cursor to hand the parser: the stored one, but only when this parser is
 * the one that left it.
 *
 * A session read by an older version of the parser has a cursor whose meaning
 * has changed — what counts as a message, and so where the read may begin, is
 * the version's own rule. Handing it over would pin the session to the old
 * reading for ever; `null` reads the transcript again from the front, which is
 * idempotent and picks up everything the new rules keep (AD-4).
 */
function cursorFor(
  stored: Session | null,
  parserVersion: string,
): ParserCursor | null {
  if (stored === null || stored.parserVersion !== parserVersion) return null;
  return stored.cursor;
}

/**
 * The project and worktree a cwd belongs to, with an id minted for each in case
 * this call is the one that creates the row (AD-8, AD-12).
 *
 * A line that carried no `cwd` is not asked about at all: there is nothing to
 * inspect, and a guess would be a tag that can never be corrected. A folder git
 * cannot answer for comes back as `null`, and the session is ingested with no
 * tags rather than refused — capture comes before the tags, and a machine with
 * no git must not be a machine that stores no sessions (Decision 2026-10-18).
 *
 * The identity is the normalized remote when there is one, and the git common
 * directory only when there is not. A common directory is an absolute path, so
 * it starts with `/` and can never collide with a `host/…` identity. It carries
 * no prefix and no machine name: AD-12 says the common directory, and a
 * decoration would be one more thing to migrate away from.
 */
async function checkoutFor(
  repositories: RepositoryInspector,
  idGen: IdGen,
  cwd: string | null,
): Promise<EnsureCheckoutInput | null> {
  if (cwd === null) return null;
  const checkout = await repositories.inspect(cwd);
  if (checkout === null) return null;

  // A remote nothing can be named from is a remote this repository does not
  // have: the fallback is the same as for a repository with no remote at all.
  const fromRemote =
    checkout.remoteUrl === null ? null : normalizeRemoteIdentity(checkout.remoteUrl);
  return {
    projectId: idGen.next(),
    remoteIdentity: fromRemote ?? checkout.commonDir,
    worktreeId: idGen.next(),
    worktreePath: checkout.worktreePath,
  };
}

function firstOccurredAt(messages: readonly IngestMessage[]): Date {
  const first = messages[0];
  if (first === undefined) {
    // `ingestSession` returns before this on an empty batch; a caller that got
    // here anyway is a bug, and a bug throws (Conventions).
    throw new TypeError('a session cannot be created from a batch with no messages');
  }
  return first.occurredAt;
}
