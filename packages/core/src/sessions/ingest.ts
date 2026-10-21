import type {
  IngestBatch,
  IngestMessage,
  IngestToolNote,
} from '../domain/ingest-batch.js';
import { normalizeRemoteIdentity } from '../domain/project-identity.js';
import type { ParserCursor, Session, SessionIngestSource } from '../domain/session.js';
import {
  parseSessionToken,
  type SessionKey,
  type SessionToken,
} from '../domain/session-token.js';
import type { SpoolCause } from '../domain/spool-record.js';
import { ERROR_CODES, type WarningCode } from '../codes.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Parser } from '../ports/parser.js';
import type { RepositoryInspector } from '../ports/repository.js';
import type { Spool } from '../ports/spool.js';
import type {
  EnsureCheckoutInput,
  IngestCounts,
  SessionStore,
  TranscriptFileStore,
  UserStore,
} from '../ports/store.js';
import type { TranscriptFolder, TranscriptReader } from '../ports/transcript.js';
import { spoolSessionIngest } from './spool-ingest.js';

/**
 * What a caller asks `sessions.ingest` for. Surface neutral: the session is the
 * token that crosses process boundaries (AD-8, AD-28).
 */
export interface IngestSessionInput {
  /** `harness:harness_session_id`, as the hook reported it. */
  session: SessionToken;
  /**
   * Where the harness is writing the transcript, when the caller knows.
   *
   * Left out — or empty, which is what a hook payload with no path comes to —
   * the file is looked up in that harness's folder by session id
   * (`transcriptFolders`). That is what lets a session be collected from the
   * token alone: the drain's scan and `brain sessions ingest` with a payload
   * that carried only `session_id` both arrive here with no path.
   */
  transcriptPath?: string;
  /**
   * Whether this is a session being collected as it happens or one being read
   * off the disk afterwards. Defaults to `live`.
   *
   * It is used only when the session row is created, and never again: a session
   * first seen by a folder scan was imported however many live turns follow
   * (Table Contract, `sessions.ingest_source`).
   */
  source?: SessionIngestSource;
}

/** What the caller of one ingest decides, beyond the input itself. */
export interface IngestSessionOptions {
  /**
   * Whether a database that will not take a write goes to the spool (AD-9).
   *
   * True for a hook, which is the whole reason the spool exists: a turn whose
   * conversation could not be stored must still be a turn that worked. False
   * for the drain, which is *already* the deferred path — a mark written there
   * would be a second copy of work the queue is holding, and the honest answer
   * is the code, so that the item is handed back with its attempt intact
   * (AD-21).
   */
  spoolOnUnwritable?: boolean;
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
  store: SessionStore & UserStore & TranscriptFileStore;
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
   * The transcript folders this build may look in, by harness (AD-4).
   *
   * Empty is a working build and not a broken one: it is what a brain whose
   * capture switch is off has, and then an ingest that was given no path has
   * nowhere to look and says so. The hook path, which carries a path, does not
   * depend on this list at all (Boundaries).
   */
  transcriptFolders?: readonly TranscriptFolder[];
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
 *   token → parser → locate → findSession → read → parse → owner → inspect →
 *   ensure → ingest → history
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
 * happened. Two kinds of batch with no messages still go to the store, and
 * neither creates anything: one of tool notes alone, whose notes belong to
 * messages the session already holds, and one of a read that found the front of
 * the transcript rewritten, which carries the `CURSOR_RESET` warning and the
 * cursor to clear (#16).
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
  options: IngestSessionOptions = {},
): Promise<IngestSessionResult> {
  const {
    store,
    spool,
    clock,
    idGen,
    parsers,
    transcripts,
    transcriptFolders = [],
    repositories,
    machine,
  } = dependencies;
  const { spoolOnUnwritable = true } = options;

  /**
   * Where the transcript is. The caller's, when it gave one; otherwise the
   * folder listing's answer, worked out below once the harness is known. The
   * spool mark carries whatever this ends up being, so a replay of it does not
   * have to look the file up a second time.
   */
  let transcriptPath = input.transcriptPath ?? '';

  /**
   * The one way out when the database will not take a write (AD-9) — or, for a
   * caller that is itself the deferred path, the code and nothing else.
   */
  const spooled = async (cause: SpoolCause): Promise<IngestSessionResult> =>
    spoolOnUnwritable
      ? spoolSessionIngest({ spool, clock, idGen }, { ...input, transcriptPath }, cause)
      : { ok: false, code: cause, message: ERROR_CODES[cause].meaning };

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

  // No path, so the file has to be found: the folder of this harness, by the
  // session id the token carries. A build with no folder for it says so under
  // the same code as a file that cannot be read, because from here the two are
  // the same answer — there is nothing to ingest (`ports/transcript.ts`).
  if (transcriptPath === '') {
    const located = await locateTranscript(transcriptFolders, key);
    if (!located.ok) return located;
    transcriptPath = located.path;
  }

  // The stored cursor, before the file is read: it is what lets the parse start
  // where the last one stopped (AD-4). A session nobody has ingested yet comes
  // back as `null`, which is a value and not a failure.
  const found = await store.findSession(key);
  if (!found.ok) return unwritable(found.code) ? spooled(found.code) : found;
  const stored = found.session;

  const read = await transcripts.read(transcriptPath);
  if (!read.ok) return read;

  // A cursor is only worth anything to the parser that made it. A session read
  // under an older parser version is read again from the front, because the
  // rules that decided what a message is have moved: lines the old version
  // dropped are messages now, and starting at its cursor would leave them
  // behind for good. Re-reading inserts nothing that is already stored (AD-8).
  const parsed = parser.parse(read.content, cursorFor(stored, parser.version));
  if (!parsed.ok) return parsed;

  /**
   * What this read saw, written to `transcript_files` so the next folder scan
   * knows this file has been read this far (Decision 2, 2026-10-19).
   *
   * Its failure is deliberately dropped. The history is a shortcut and not a
   * fact anything depends on: a scan that does not find it reads the file again
   * and inserts nothing, because an ingest is idempotent (AD-8). Failing the
   * ingest over it would turn a successful collection into a failed turn for
   * the sake of an optimisation.
   */
  const recordHistory = async (): Promise<void> => {
    try {
      await store.recordTranscriptFile({
        id: idGen.next(),
        harness: key.harness,
        path: transcriptPath,
        sizeBytes: read.sizeBytes,
        fingerprint: read.fingerprint,
        cursor: parsed.cursor,
        scannedAt: clock.now(),
        reset: parsed.cursorReset,
      });
    } catch {
      // Dropped, like the coded failure above it: an adapter that throws where
      // the port says it answers is a bug, and the honest thing is still to
      // report the collection that *did* happen rather than to lose a stored
      // turn over a shortcut (follow-up review #19).
    }
  };

  /**
   * Nothing to put anywhere: no row and nothing to insert. The Stop hook of a
   * turn whose last answer has not been flushed arrives here, and so does every
   * hook of a session's first seconds.
   */
  const nothingToStore =
    parsed.messages.length === 0 && (stored === null || parsed.toolNotes.length === 0);
  /**
   * The read found the front of the transcript changed, and there is a stored
   * session to tell about it. That is reported even when the read then found no
   * message at all — a transcript rewritten down to nothing — because the
   * session's cursor describes a file that no longer exists: left there, every
   * later read starts at the front and the warning is never raised (#16). The
   * empty batch below is what carries both to the store: the warning, and the
   * cursor to clear.
   */
  const resetToReport = parsed.cursorReset && stored !== null;

  if (nothingToStore && !resetToReport) {
    // The history is still written — the file *was* read this far, and a scan
    // that read it again every drain for a session with no conversation yet
    // would be the one case where nothing ever settles.
    await recordHistory();
    return {
      ok: true,
      session: input.session,
      spooled: false,
      created: false,
      inserted: { messages: 0, toolNotes: 0 },
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

  // Nothing is masked here. The body and the target go to the store exactly as
  // the parser read them, because a stored message is never rewritten: a
  // pattern that masked one word too many on the way in would have deleted
  // something nobody could get back. Secrets are masked where text leaves
  // Brain instead, in Core's output codecs (마스킹 B, AD-11), and the ids are
  // all this step adds (AD-8).
  const messages: IngestMessage[] = parsed.messages.map((message) => ({
    ...message,
    id: idGen.next(),
  }));
  const toolNotes: IngestToolNote[] = parsed.toolNotes.map((note) => ({
    ...note,
    id: idGen.next(),
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
      // Only ever read when this call creates the row: a session first seen by
      // a folder scan stays an import however many live turns follow it (Table
      // Contract).
      ingestSource: input.source ?? 'live',
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
      // Where the session stood when this read began, as `findSession` found
      // it: the raw stored cursor, whatever parser version left it. It is what
      // lets the store tell a reset that is still current from one whose read
      // has been overtaken (`domain/ingest-batch.ts`, #17).
      cursorBase: stored?.cursor ?? null,
      startSource: parsed.startSource,
      endedAt: null,
      ingestedAt,
    },
    messages,
    toolNotes,
  };

  const ingested = await store.ingest(batch);
  if (!ingested.ok) return unwritable(ingested.code) ? spooled(ingested.code) : ingested;

  // After the batch is in and not before: the history says "this file has been
  // read this far", and a row written before the rows it describes would, for
  // the width of one failed insert, tell the next scan to skip a file whose
  // conversation never landed.
  await recordHistory();

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
 * The transcript of one session, found in the folder of its harness.
 *
 * Three ways to come back with nothing, and all three are the same answer to
 * the caller: this build has no folder for that harness — which is what the
 * capture switch being off looks like (Boundaries) — the folder could not be
 * listed, or it holds no file for that session id. There is nothing to ingest
 * in any of them and nothing anybody can do from here, which is exactly what
 * `TRANSCRIPT_UNREADABLE` says (`ports/transcript.ts`).
 *
 * The reason is still in the sentence, because the three have different fixes:
 * turn capture on, repair the folder, or accept that the harness has deleted
 * the file.
 */
async function locateTranscript(
  folders: readonly TranscriptFolder[],
  key: SessionKey,
): Promise<{ ok: true; path: string } | { ok: false; code: 'TRANSCRIPT_UNREADABLE'; message: string }> {
  const unreadable = (
    message: string,
  ): { ok: false; code: 'TRANSCRIPT_UNREADABLE'; message: string } => ({
    ok: false,
    code: 'TRANSCRIPT_UNREADABLE',
    message: `트랜스크립트를 찾을 수 없습니다: ${message}`,
  });

  const folder = folders.find((candidate) => candidate.harness === key.harness);
  if (folder === undefined) {
    return unreadable(
      `이 빌드는 "${key.harness}" 하네스의 트랜스크립트 폴더를 보지 않습니다. 수집이 꺼져 있거나 그 하네스를 모릅니다`,
    );
  }

  const listed = await folder.list();
  if (!listed.ok) {
    return unreadable(`"${key.harness}" 폴더를 읽을 수 없습니다: ${listed.message}`);
  }

  const file = listed.files.find(
    (candidate) => candidate.harnessSessionId === key.harnessSessionId,
  );
  if (file === undefined) {
    return unreadable(`"${key.harness}" 폴더에 그 세션의 파일이 없습니다`);
  }
  return { ok: true, path: file.path };
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
