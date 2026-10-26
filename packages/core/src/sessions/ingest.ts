import type { SourceFileReader } from '../ports/source-file.js';
import { brainLocator, contentHashOfBytes, externalLocator } from '../domain/file.js';
import type { FileStore } from '../ports/file-store.js';
import type {
  IngestBatch,
  IngestAttachment,
  IngestMessage,
  IngestToolNote,
  ParsedAttachment,
} from '../domain/ingest-batch.js';
import { normalizeRemoteIdentity, projectIdentityKey } from '../domain/project-identity.js';
import type { ParserCursor, Session, SessionIngestSource, TagSource } from '../domain/session.js';
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
import type { Checkout, InspectResult, RepositoryInspector } from '../ports/repository.js';
import type { Spool } from '../ports/spool.js';
import type {
  AttachmentStore,
  EnsureCheckoutInput,
  IngestCounts,
  SessionStore,
  TranscriptFileStore,
  UserStore,
} from '../ports/store.js';
import type { TranscriptFolder, TranscriptReader } from '../ports/transcript.js';
import {
  spoolSessionIngest,
  type SpoolSessionIngestRead,
} from './spool-ingest.js';

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
  /** Already captured spool outcomes take precedence over a later disk read. */
  attachmentOverrides?: readonly IngestAttachment[];
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
  /**
   * How many lines of the transcript the parser walked past, by reason, or
   * `null` when nothing was parsed at all — which is what the spool path
   * answers, since it never reads the file (`ports/parser.ts`).
   *
   * A transcript is mostly not conversation, so this is the normal shape of a
   * successful ingest and not a complaint. It is reported because it is the
   * only number that says how much of a file was skipped and why: the reserved
   * `unreadable` count is the one that also raises a warning.
   */
  droppedLines: Readonly<Record<string, number>> | null;
}

export type IngestSessionResult =
  | ({ ok: true; warnings: readonly WarningCode[] } & IngestSessionData)
  | {
      ok: false;
      code:
        | 'FILES_UNAVAILABLE'
        | 'USAGE'
        | 'TRANSCRIPT_UNREADABLE'
        | 'USER_MISSING'
        | 'SESSION_NOT_FOUND'
        | 'DB_UNAVAILABLE'
        | 'DB_LOCKED'
        | 'SCHEMA_MISMATCH';
      message: string;
    };

/** Maximum disk fallback read, before any database transaction. */
export const MAX_SOURCE_FILE_BYTES = 32 * 1024 * 1024;

/** Everything the use case is given, all of it a port (AD-1). */
export interface IngestSessionDependencies {
  sources?: SourceFileReader;
  userHome?: string | null;
  store: SessionStore &
    UserStore &
    TranscriptFileStore &
    Pick<AttachmentStore, 'listMessageAttachments' | 'listRedactedContentHashes'>;
  /** Original attachment bytes, written before the database transaction. */
  files: FileStore;
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
 *   ensure (session + optional identity work) → ingest → history
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
 * Initial `inspect` is asked only when `findSession` found nothing and the
 * parse brought a message, which is the one moment a session row can be
 * created. A session that is already there is never inspected — the hook of
 * every later turn would then pay for a git call whose answer is thrown away,
 * and a repository whose remote has since changed would answer differently
 * from the row that is already stored. Unknown answers create identity work
 * atomically with the session; its handler may fill only still-empty tags.
 *
 * Every id and every instant is decided here and handed over: the store mints
 * nothing and reads no clock (AD-8, AD-13), so the same batch spooled and
 * replayed later lands with the values it was first given (AD-9).
 *
 * Bodies and tool targets are stored verbatim. Masking belongs at output
 * boundaries, so a mistaken pattern cannot permanently erase source text
 * during capture (AD-11).
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
    files,
    sources,
    userHome = null,
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
   *
   * `read` is what the transcript read had already found, for every caller
   * after the parse: the file *was* read, so what the parse walked past is
   * reported and a line it could not read still raises its warning. Only the
   * one step in front of the parse leaves it out (`SpoolSessionIngestRead`).
   */
  const spooled = async (
    cause: SpoolCause,
    read: SpoolSessionIngestRead | null = null,
  ): Promise<IngestSessionResult> =>
    spoolOnUnwritable
      ? spoolSessionIngest({ spool, clock, idGen }, { ...input, transcriptPath }, cause, read)
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
  // The one spool in front of the parse, so it reports nothing about the file.
  if (!found.ok) return unwritable(found.code) ? spooled(found.code) : found;
  const stored = found.session;

  const scannedAt = clock.now();
  const read = await transcripts.read(transcriptPath);
  if (!read.ok) return read;

  // A cursor is only worth anything to the parser that made it. A session read
  // under an older parser version is read again from the front, because the
  // rules that decided what a message is have moved: lines the old version
  // dropped are messages now, and starting at its cursor would leave them
  // behind for good. Re-reading inserts nothing that is already stored (AD-8).
  const parsed = parser.parse(read.content, cursorFor(stored, parser.version));
  if (!parsed.ok) return parsed;
  // Only override messages this read can write. Other links keep their own replay/retry.
  const parsedMessageIds = new Set(parsed.messages.map(message => message.harnessMessageId));
  const attachmentOverrides = (options.attachmentOverrides ?? []).filter(a => parsedMessageIds.has(a.harnessMessageId));

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
        scannedAt,
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
    attachmentOverrides.length === 0 && parsed.attachments.length === 0 && parsed.messages.length === 0 && (stored === null || parsed.toolNotes.length === 0);
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

  /**
   * The warnings of this read itself, in front of whatever the store adds.
   *
   * Lines the parser could not read at all are the one thing in `droppedLines`
   * that is a problem rather than the filter working: the rest of the file was
   * collected, and a reader has to be told that part of it was not (NFR-2,
   * story 23). Everything else the parser walked past is reported as a number
   * and raises nothing.
   */
  const readWarnings: readonly WarningCode[] =
    (parsed.droppedLines['unreadable'] ?? 0) > 0 ? ['TRANSCRIPT_LINES_SKIPPED'] : [];
  /** The same two facts for a spool mark written from here on (AD-9). */
  const afterParse: SpoolSessionIngestRead = {
    droppedLines: parsed.droppedLines,
    warnings: readWarnings,
  };

  // A session an older parser version read still goes to the store when the new
  // rules keep nothing new: the empty batch is what moves `parser_version`, and
  // without it the scan would queue that session again on every drain.
  const versionToReport = stored !== null && stored.parserVersion !== parser.version;
  if (nothingToStore && !resetToReport && !versionToReport) {
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
      droppedLines: parsed.droppedLines,
      warnings: readWarnings,
    };
  }

  const attachments: IngestAttachment[] = [...attachmentOverrides];
  const saved = new Map<string, Extract<Awaited<ReturnType<FileStore['put']>>, { ok: true }>>();
  const existing = await existingAttachmentPositions(store, input.session, stored !== null ? parsed.attachments : []);
  // The bytes are resolved first and stored second, so the hashes of a whole
  // turn can be asked about in one read before any blob is written.
  const pending: { attachment: ParsedAttachment; bytes: Uint8Array | null; hash: string | null }[] = [];
  for (const a of parsed.attachments) {
    if (attachmentOverrides.some(saved => saved.harnessMessageId === a.harnessMessageId && saved.ordinal === a.ordinal)) continue;
    // A place that is already filled is final (0008): reading the source again
    // could only leave a blob no row points at.
    if (existing.has(`${a.harnessMessageId}:${String(a.ordinal)}`)) continue;
    let bytes = a.bytes;
    if (bytes === null && a.sourcePath !== null && a.sourceCheck !== null && sources !== undefined) {
      const source = await sources.read(a.sourcePath, MAX_SOURCE_FILE_BYTES);
      if (source.ok && source.bytes.length <= MAX_SOURCE_FILE_BYTES) {
        const check = a.sourceCheck;
        const matches = 'sizeBytes' in check ? source.bytes.length === check.sizeBytes
          : source.bytes.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 1) === check.lineCount;
        if (matches) bytes = source.bytes;
      }
    }
    pending.push({ attachment: a, bytes, hash: bytes === null ? null : contentHashOfBytes(bytes) });
  }
  // The file store is content addressed, so putting the same bytes again would
  // write the blob a masking deleted straight back to the locator whose row
  // says the bytes are gone — and the row would stay marked deleted, so nothing
  // would ever look for the new blob again (story 11's remaining risk). One
  // lock-free read before any put is what stops that. A read that fails stores
  // as before: a collection must not be lost because this question could not be
  // answered, and that is the risk this leaves standing.
  const hashes = [...new Set(pending.flatMap(p => p.hash === null ? [] : [p.hash]))];
  const redacted = new Set<string>();
  if (hashes.length > 0) {
    const read = await store.listRedactedContentHashes(hashes);
    if (read.ok) for (const hash of read.hashes) redacted.add(hash);
  }
  for (const { attachment: a, bytes, hash } of pending) {
    const base = { id: idGen.next(), harnessMessageId: a.harnessMessageId, ordinal: a.ordinal,
      sourceKind: a.sourceKind, sourceRef: a.sourceRef, displayName: a.displayName };
    if (bytes === null || hash === null) {
      attachments.push({ ...base, file: null });
      continue;
    }
    let put = saved.get(hash);
    if (put === undefined) {
      if (redacted.has(hash)) {
        // No `put`, and the rows go in as they always do: the attachment is a
        // fact about the conversation, and it points at the masked file. The
        // locator is the one the store would have answered with — it is the
        // content hash spelled as a path — so the `on conflict do nothing` of
        // the adapter meets the row that is already there (`domain/file.ts`).
        put = { ok: true, contentHash: hash, sizeBytes: bytes.length,
          location: { storeKind: 'local', ownership: 'brain', locator: brainLocator(hash.slice(7), bytes) } };
      } else {
        const result = await files.put(bytes);
        if (!result.ok) return result;
        put = result;
      }
      saved.set(hash, put);
    }
    const locator = a.sourcePath === null || userHome === null ? null : externalLocator(a.sourcePath, userHome);
    attachments.push({ ...base, file: { id: idGen.next(), contentHash: put.contentHash, sizeBytes: put.sizeBytes,
      location: { ...put.location, id: idGen.next() },
      external: locator === null ? null : { id: idGen.next(), storeKind: 'local', ownership: 'external', locator } } });
  }
  afterParse.attachments = attachments;
  const owner = await store.readSelfUser();
  if (!owner.ok) return unwritable(owner.code) ? spooled(owner.code, afterParse) : owner;
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
    // Inspect only for a session
    // `findSession` did not find, using the session start folder, or the first
    // message cwd when the parser has no start folder (AD-12). The process's own cwd is never the evidence —
    // a hook runs wherever the harness happened to leave it.
    const cwd = parsed.startCwd ?? firstCwd(messages);
    const asked = stored === null
      ? await checkoutFor(repositories, idGen, cwd)
      : { checkout: null, tagSource: null, unknown: null };
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
      checkout: asked.checkout,
      tagSource: asked.tagSource,
      firstCwd: cwd,
      identityWork: asked.unknown === null ? null : {
        id: idGen.next(),
        kind: 'session_identity',
        targetKind: 'session',
        targetId: input.session,
        createdAt: ingestedAt,
        nextAttemptAt: ingestedAt,
      },
    });
    if (!ensured.ok) {
      return unwritable(ensured.code) ? spooled(ensured.code, afterParse) : ensured;
    }
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
    attachments,
    toolNotes,
  };

  const ingested = await store.ingest(batch);
  if (!ingested.ok) {
    return unwritable(ingested.code) ? spooled(ingested.code, afterParse) : ingested;
  }
  const alreadyWarned = new Set<string>(ingested.warnings);

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
    droppedLines: parsed.droppedLines,
    // The store's first, then this read's, and neither twice: the store's
    // warnings are about the write that just happened and this one is about the
    // file it came out of (NFR-2).
    warnings: [
      ...ingested.warnings,
      ...readWarnings.filter((code) => !alreadyWarned.has(code)),
    ],
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
export async function locateTranscript(
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
 * A session with neither a start cwd nor a message cwd is not asked about: there is
 * nothing to inspect, and a guess would be a tag that can never be corrected
 * (`firstCwd`). Unknown answers defer the tags through work created atomically
 * with the session. A definite non-repository needs no deferred inspection.
 * Only missing folders are estimated: the first surviving ancestor repository,
 * then immediate sibling checkouts sharing one identity. Estimated worktrees
 * keep the original cwd, while direct inspection keeps the repository top.
 *
 * The identity is the normalized remote when there is one, and the git common
 * directory only when there is not. A common directory is an absolute path, so
 * it starts with `/` and can never collide with a `host/…` identity. It carries
 * no prefix and no machine name: AD-12 says the common directory, and a
 * decoration would be one more thing to migrate away from.
 */
export async function checkoutFor(
  repositories: RepositoryInspector,
  idGen: IdGen,
  cwd: string | null,
): Promise<{ checkout: EnsureCheckoutInput | null; tagSource: TagSource | null; unknown: Extract<InspectResult, { kind: 'unknown' }> | null }> {
  const empty = { checkout: null, tagSource: null, unknown: null };
  if (cwd === null) return empty;
  const original = cwd.replace(/\/+$/, '') || '/';
  const result = await repositories.inspect(original);
  if (result.kind === 'unknown') return { ...empty, unknown: result };
  if (result.kind === 'not_repository') return empty;
  if (result.kind === 'checkout') return { checkout: checkoutInput(result.checkout, idGen), tagSource: 'cwd', unknown: null };
  const parent = (path: string): string | null =>
    path === '/' ? null : path.slice(0, path.lastIndexOf('/')) || '/';
  const immediate = parent(original);
  let up = immediate;
  let immediateMissing = false;
  while (up !== null) {
    const answer = await repositories.inspect(up);
    if (answer.kind === 'unknown') return { ...empty, unknown: answer };
    if (answer.kind === 'checkout') return {
      checkout: { ...checkoutInput(answer.checkout, idGen), worktreePath: original },
      tagSource: 'ancestor', unknown: null,
    };
    if (answer.kind === 'not_repository') break;
    if (up === immediate) immediateMissing = true;
    up = parent(up);
  }
  if (up === null || immediate === null || immediateMissing) return empty;
  const listing = await repositories.listFolders(immediate);
  if (listing.kind === 'unknown') return { ...empty, unknown: listing };
  if (listing.kind === 'missing') return empty;
  const siblings: EnsureCheckoutInput[] = [];
  for (const folder of [...listing.folders].sort()) {
    if (folder === original) continue;
    const answer = await repositories.inspect(folder);
    if (answer.kind === 'unknown') return { ...empty, unknown: answer };
    if (answer.kind === 'checkout') siblings.push(checkoutInput(answer.checkout, idGen));
  }
  const first = siblings[0];
  if (first === undefined || siblings.some((sibling) => sibling.identityKey !== first.identityKey)) return empty;
  return { checkout: { ...first, worktreePath: original }, tagSource: 'sibling', unknown: null };
}

/** Shared by initial capture and deferred identity work to avoid divergent tags. */
export function checkoutInput(checkout: Checkout, idGen: IdGen): EnsureCheckoutInput {
  const remoteIdentity = (checkout.remoteUrl === null
    ? null : normalizeRemoteIdentity(checkout.remoteUrl)) ?? checkout.commonDir;
  return {
    projectId: idGen.next(),
    remoteIdentity,
    identityKey: projectIdentityKey(remoteIdentity),
    worktreeId: idGen.next(),
    worktreePath: checkout.worktreePath,
  };
}

/**
 * The fallback when the parser has no start cwd: the cwd of the first message that
 * carries one, or `null` when no message in the batch does.
 *
 * Not the first message's, because a message can arrive with no folder on it
 * at all — a harness is free to write a line without one, and a parser answers
 * `null` rather than guessing for any line whose folder is not this
 * conversation's. A session whose first message is one of those would otherwise
 * be tagged with nothing. Initial capture and deferred work use this same
 * fallback after the session start folder (AD-12).
 */
export function firstCwd(messages: readonly { cwd: string | null }[]): string | null {
  for (const message of messages) {
    if (message.cwd !== null && message.cwd !== '') return message.cwd;
  }
  return null;
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

/**
 * The attachment places already stored for the messages whose attachments need
 * the source file read again, as `harnessMessageId:ordinal`.
 *
 * Only asked when a disk read is coming: bytes the transcript carries hash to
 * the same blob every time, so putting them twice writes nothing, but a source
 * file may have changed since its place was filled. A read that fails asks
 * nothing of the caller — the write behind it skips filled places anyway.
 */
async function existingAttachmentPositions(
  store: Pick<SessionStore, 'readSession'> & Pick<AttachmentStore, 'listMessageAttachments'>,
  session: SessionToken,
  attachments: readonly ParsedAttachment[],
): Promise<ReadonlySet<string>> {
  const positions = new Set<string>();
  const wanted = new Set(attachments.filter((a) => a.bytes === null).map((a) => a.harnessMessageId));
  if (wanted.size === 0) return positions;
  try {
    const read = await store.readSession(session);
    if (!read.ok) return positions;
    for (const message of read.messages) {
      if (!wanted.has(message.harnessMessageId)) continue;
      const listed = await store.listMessageAttachments(message.id);
      if (!listed.ok) continue;
      for (const row of listed.attachments) positions.add(`${message.harnessMessageId}:${String(row.ordinal)}`);
    }
  } catch {
    // Same as a coded failure: the place check is a saving, not a guard.
  }
  return positions;
}
