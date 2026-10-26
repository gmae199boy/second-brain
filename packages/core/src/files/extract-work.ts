import {
  DOCUMENT_CHUNK_PARAMS,
  DOCUMENT_EXTRACT_MAX_BYTES,
} from '../domain/document.js';
import { contentHashOfBytes } from '../domain/file.js';
import { DOCUMENT_CHUNK_INDEX_CONFIG_ID } from '../domain/index-config.js';
import type { Clock } from '../ports/clock.js';
import type { FileStore } from '../ports/file-store.js';
import type { IdGen } from '../ports/id-gen.js';
import type {
  ExtractionChunkInput,
  ExtractionOutcome,
  ExtractionStore,
  WorkStore,
} from '../ports/store.js';
import type { WorkHandler, WorkHandlerFailure } from '../queue/drain.js';
import {
  DOCUMENT_EXTRACTORS,
  DOCUMENT_EXTRACTOR_VERSION,
  type DocumentExtractor,
} from './extractors.js';
import { writeExtractionChunks } from './extraction-chunks.js';

/**
 * The second kind of work Core owns: read one stored file and cut it into
 * pieces (AD-21, AD-24).
 *
 * The shape of it is one sentence long. The step before the queue loop finds
 * the files nothing has read and puts one item on the queue per file; the
 * handler reads the bytes *outside* any database transaction, decides what they
 * are from the content, cuts them with the registered extractor and writes the
 * pieces through the generation store. Nothing in here opens a transaction and
 * nothing in here holds one while it reads a blob, which is the whole reason the
 * two halves are separate (AD-7).
 *
 * What a reading leaves behind is as much a part of the contract as what it
 * produces, because the queue's input is "a file with no generation at all": a
 * path that closed the item without leaving a generation row would be a file the
 * next drain queues again, for ever. So every path that closes the item either
 * leaves a row or is one of the three states that take the file out of the list
 * on their own — redacted, out of reach, or gone.
 */

/** The kind, as `work_items.kind` spells it. Target: `file` and `files.id`. */
export const DOCUMENT_EXTRACT_KIND = 'document_extract';

/**
 * The codes this handler names itself, and deliberately not rows of the code
 * table (`codes.ts`).
 *
 * A code in that table is something a command tells a person to do about it.
 * These three are the classification of one failed reading, stored in
 * `failures.code` and read by whoever looks at `brain failures list`: the
 * original cannot be reached any more, the bytes are not the bytes that were
 * collected, or the extractor could not read them. None of the three is a
 * refusal of a command, so none of them belongs in the guide (Boundaries).
 */
export const FILE_SOURCE_UNREACHABLE = 'FILE_SOURCE_UNREACHABLE';
export const FILE_CONTENT_MISMATCH = 'FILE_CONTENT_MISMATCH';
export const EXTRACTION_FAILED = 'EXTRACTION_FAILED';

/** What the queueing step needs: two reads, the open items, and the queue. */
export interface EnqueueDocumentExtractionsDependencies {
  store: Pick<
    ExtractionStore,
    'listFilesAwaitingExtraction' | 'listFilesWithStaleExtraction'
  > &
    Pick<WorkStore, 'listOpenWorkTargets' | 'addWork'>;
  clock: Clock;
  idGen: IdGen;
}

export interface EnqueueDocumentExtractionsOptions {
  /**
   * The drain run's shared deadline, as a millisecond instant. Every `addWork`
   * is a write transaction, so the loop asks before each one — the same thing
   * the identity step and the folder scan do with the same number (AD-7).
   */
  deadline: number;
  /**
   * Which generation of extractors counts as current, for the second read.
   * Defaults to this build's, and is an option for the same reason the
   * handler's is: a test that wants to be a different build.
   */
  extractorVersion?: string;
}

/**
 * The files this step met and left alone, which is the one thing about it a
 * person has to be told.
 *
 * Everything else it does is queue rows, and the loop's own counters say
 * whether anything happened. A file that is behind and cannot be read is
 * different: nothing will ever queue it, so a drain that said nothing would
 * leave the person with an attachment that is quietly never re-read (AD-24).
 *
 * Both are whole counts and not what `limit` showed, and both are zero when the
 * read behind them failed — a read that could not be answered knows nothing
 * about what it would have skipped.
 */
export interface EnqueueDocumentExtractionsReport {
  /** Files that are behind and redacted, so there are no bytes to read again. */
  redacted: number;
  /** Files that are behind and whose original cannot be reached any more. */
  sourceUnreachable: number;
}

/**
 * How many files *each* of the two reads may answer with. The same bound the
 * name filling uses (`files/file-names.ts`): a backlog of ten thousand
 * attachments is not read into memory to queue the first few.
 *
 * It is per read and not per run, so one run may hold a thousand ids and try a
 * thousand `addWork` calls. That is deliberate: it is a bound on the read and
 * not on the budget — a thousand write transactions would be far past two
 * seconds — so what keeps an opportunistic run short is the deadline the loop
 * checks before each write, not this.
 */
const ENQUEUE_LIMIT = 500;

/**
 * Put one `document_extract` item on the queue per file nothing has read yet,
 * and per file a newer generation of extractors would read differently.
 *
 * This is what "an attachment that was stored gets extracted" means, and it is
 * a step of the drain rather than part of the ingest transaction: the same place
 * the derived names are filled, and the only place that also catches the files
 * collected before this story existed (Design Notes). A hook never drains
 * (AD-6), so either way the reading happens on the next drain.
 *
 * The second read is the re-reading path, and it is the same step and not a new
 * command on purpose: raising `DOCUMENT_EXTRACTOR_VERSION` is how a build says
 * the stored readings are not the ones it would make, and nobody should have to
 * remember to ask. It is one go per file and not a loop — the store only
 * answers files with no generation of this version at all — so a re-reading
 * that fails permanently is `failures retry`'s from then on (Design Notes).
 *
 * The new files come first because they have no text at all, where a file that
 * is behind has the last reading that worked: in a run that runs out of
 * budget, the file with nothing is the one worth the write.
 *
 * Nothing in here fails the run. A read that could not be answered and a queue
 * that would not take a row are both "there is nothing to queue right now", and
 * the next drain asks again — exactly how `fillFileNames` treats the same two
 * cases. Running out of time is a third one: the files left over are still the
 * files that are waiting or behind, so the next drain's own reads find them.
 */
export async function enqueueDocumentExtractions(
  { store, clock, idGen }: EnqueueDocumentExtractionsDependencies,
  {
    deadline,
    extractorVersion = DOCUMENT_EXTRACTOR_VERSION,
  }: EnqueueDocumentExtractionsOptions,
): Promise<EnqueueDocumentExtractionsReport> {
  const nothing: EnqueueDocumentExtractionsReport = { redacted: 0, sourceUnreachable: 0 };

  const awaiting = await store.listFilesAwaitingExtraction({ limit: ENQUEUE_LIMIT });
  const behind = await store.listFilesWithStaleExtraction({
    extractorVersion,
    limit: ENQUEUE_LIMIT,
  });
  // Both reads are lock-free, so a failed one costs the run nothing but its own
  // half of the work: a database that could not answer the second question is
  // still allowed to queue the files the first one found.
  const skipped: EnqueueDocumentExtractionsReport = behind.ok
    ? { redacted: behind.redacted, sourceUnreachable: behind.sourceUnreachable }
    : nothing;
  const queueable = [
    ...(awaiting.ok ? awaiting.fileIds : []),
    ...(behind.ok ? behind.fileIds : []),
  ];
  if (queueable.length === 0) return skipped;

  // The open-row key of `work_items` would have collapsed a duplicate anyway,
  // at the cost of a write lock for each one. This is the lock-free read that
  // spends none (AD-7, AD-21).
  const open = await store.listOpenWorkTargets({ kind: DOCUMENT_EXTRACT_KIND });
  if (!open.ok) return skipped;
  const held = new Set(
    open.targets.filter((target) => target.targetKind === 'file').map((target) => target.targetId),
  );

  for (const fileId of queueable) {
    // Before each write and not after it, so a run whose budget is gone takes
    // no further lock: the queue row is cheap and the write transaction is not.
    if (clock.now().getTime() >= deadline) break;
    if (held.has(fileId)) continue;
    // The two reads answer disjoint questions — no generation at all against a
    // current successful one — but the set is what this loop goes by, so a file
    // it queued is a file it does not queue twice.
    held.add(fileId);
    const now = clock.now();
    const added = await store.addWork({
      id: idGen.next(),
      kind: DOCUMENT_EXTRACT_KIND,
      targetKind: 'file',
      targetId: fileId,
      createdAt: now,
      nextAttemptAt: now,
    });
    // A database that will not take this row will not take the next one either.
    if (!added.ok) break;
  }

  return skipped;
}

export interface DocumentExtractWorkDependencies {
  store: Pick<
    ExtractionStore,
    | 'readFileExtractionState'
    | 'beginExtraction'
    | 'appendExtractionChunks'
    | 'finishExtraction'
    | 'setFileSourceUnreachable'
  > &
    Pick<WorkStore, 'resolveFailures'>;
  /** Brain's copy of the bytes. Read outside every transaction (AD-7). */
  files: Pick<FileStore, 'get'>;
  clock: Clock;
  /** The generation's id and every piece's. Minted here, never by the database. */
  idGen: IdGen;
  /** The registry to try, for a test that wants an extractor of its own. */
  extractors?: readonly DocumentExtractor[];
  /** The version to stamp the reading with. Defaults to this build's. */
  extractorVersion?: string;
}

/**
 * The handler for one `document_extract` item.
 *
 * The order of the steps is the contract, and each one is there because the
 * step after it would otherwise be wrong:
 *
 *   1. read the file's state. A file that is gone, redacted or out of reach is
 *      answered without opening a generation at all — there is nothing to read
 *      and nothing a retry would change, and the row that keeps it out of the
 *      queue's input is already there (`files.redacted_at`,
 *      `files.source_unreachable_at`).
 *   2. open the generation, which is also what takes the leftovers of an
 *      expired claim away (AD-24).
 *   3. check the size *before* the bytes, so an enormous file costs one read of
 *      one column rather than eight mebibytes of memory.
 *   4. check the hash, so a reading is about the bytes that were collected.
 *   5. let the registry decide the format from the content, extract, write the
 *      pieces in bounded batches, and close.
 *
 * What the drain then does with the answer is `queue/drain.ts`'s: a temporary
 * read failure says `retryable: true` and backs off, a permanent one says
 * `false` and is recorded on the spot, and a database that would not take a
 * write hands its own code back so the item is released with its attempt
 * returned (AD-21).
 */
export function documentExtractHandler(
  dependencies: DocumentExtractWorkDependencies,
): WorkHandler {
  const {
    store,
    files,
    clock,
    idGen,
    extractors = DOCUMENT_EXTRACTORS,
    extractorVersion = DOCUMENT_EXTRACTOR_VERSION,
  } = dependencies;

  return async (item) => {
    const fileId = item.targetId;

    const state = await store.readFileExtractionState(fileId);
    if (!state.ok) {
      // A file that is not there is work about something that no longer exists,
      // which is done rather than failed. A read the database could not answer
      // is handed back under its own code.
      if (state.code === 'FILE_NOT_FOUND') return { ok: true };
      return { ok: false, code: state.code, message: state.message };
    }
    // Deliberately without `resolveFailures`: a file whose original went out of
    // reach has a recorded failure that is still true, and a reading that did
    // not happen is no reason to call it resolved.
    if (state.redactedAt !== null || state.sourceUnreachableAt !== null) return { ok: true };

    if (item.claimedBy === null) {
      // Unreachable from the drain, which only hands over items it claimed. The
      // claim is what `beginExtraction` is measured against, so an item without
      // one is treated as an item whose claim is already somebody else's.
      return { ok: false, code: 'CLAIM_LOST', message: '청구 없이 추출 일감이 왔습니다' };
    }

    const begun = await store.beginExtraction({
      id: idGen.next(),
      fileId,
      extractorVersion,
      startedAt: clock.now(),
      claim: { workItemId: item.id, claimedBy: item.claimedBy },
    });
    if (!begun.ok) {
      // The two states that take the file out of the queue's input are answered
      // the way step 1 answers them: the row is there, so the next drain will
      // not meet this file again.
      if (begun.code === 'FILE_NOT_FOUND' || begun.code === 'FILE_REDACTED') return { ok: true };
      return { ok: false, code: begun.code, message: begun.message };
    }
    const extractionId = begun.extraction.id;

    /** Close the generation, and say so only when the close itself failed. */
    const close = async (outcome: ExtractionOutcome): Promise<WorkHandlerFailure | null> => {
      const closed = await store.finishExtraction({
        extractionId,
        finishedAt: clock.now(),
        outcome,
      });
      return closed.ok ? null : { ok: false, code: closed.code, message: closed.message };
    };

    /** A reading that ended without text, which is the end of this item. */
    const settled = async (outcome: ExtractionOutcome): Promise<{ ok: true } | WorkHandlerFailure> => {
      const refused = await close(outcome);
      if (refused !== null) return refused;
      await resolve(store, clock, fileId);
      return { ok: true };
    };

    /** A reading that failed, with the sentence going into `failures` as well. */
    const stopped = async (
      failed: { failedStage: 'read' | 'extract' | 'index'; mediaType: string | null },
      failure: Omit<WorkHandlerFailure, 'ok'>,
    ): Promise<WorkHandlerFailure> => {
      const refused = await close({
        status: 'failed',
        failedStage: failed.failedStage,
        error: failure.message,
        mediaType: failed.mediaType,
      });
      return refused ?? { ok: false, ...failure };
    };

    if (state.sizeBytes > DOCUMENT_EXTRACT_MAX_BYTES) {
      return settled({
        status: 'too_large',
        error: `${String(state.sizeBytes)}바이트는 추출 상한 ${String(DOCUMENT_EXTRACT_MAX_BYTES)}바이트를 넘습니다`,
        mediaType: null,
      });
    }

    if (state.home === null) {
      return unreachable(
        { store, clock, fileId },
        await stopped(
          { failedStage: 'read', mediaType: null },
          { code: FILE_SOURCE_UNREACHABLE, message: '이 파일의 원본 위치가 없습니다', retryable: false },
        ),
      );
    }

    const got = await files.get(state.home);
    if (!got.ok) {
      // A store that is there but cannot answer right now is somebody else's
      // hiccup: the item waits and tries again, and the record appears only if
      // ten attempts all find it that way (AD-21).
      if (got.code === 'FILES_UNAVAILABLE') {
        return stopped(
          { failedStage: 'read', mediaType: null },
          { code: got.code, message: got.message, retryable: true },
        );
      }
      // Bytes that are not there and a location this build may not read are the
      // same answer: the original cannot be reached. The mark is what keeps the
      // next drain from queueing it, and the pieces of the last reading that
      // worked are left exactly where they are (AD-24).
      return unreachable(
        { store, clock, fileId },
        await stopped(
          { failedStage: 'read', mediaType: null },
          { code: FILE_SOURCE_UNREACHABLE, message: got.message, retryable: false },
        ),
      );
    }

    const bytes = got.bytes;
    if (contentHashOfBytes(bytes) !== state.contentHash) {
      // The location holds something else than what was collected. Another
      // attempt would read the same wrong bytes, so it is recorded at once.
      return stopped(
        { failedStage: 'read', mediaType: null },
        {
          code: FILE_CONTENT_MISMATCH,
          message: '저장된 바이트의 해시가 수집 때와 다릅니다',
          retryable: false,
        },
      );
    }

    const detected = detect(extractors, bytes);
    if (detected === null) {
      // No failure row: most of what gets attached in this build is an image,
      // and a record per image would leave doctor's `failures` check at `warn`
      // for ever. The generation says `unsupported`, which is the honest answer
      // and the thing that keeps the file off the queue (Design Notes).
      return settled({
        status: 'unsupported',
        error: '이 내용을 읽을 추출기가 없습니다',
        mediaType: null,
      });
    }

    const extracted = await detected.extractor.extract(
      bytes,
      detected.mediaType,
      DOCUMENT_CHUNK_PARAMS,
    );
    if (!extracted.ok) {
      return stopped(
        { failedStage: 'extract', mediaType: detected.mediaType },
        {
          code: EXTRACTION_FAILED,
          message: `${detected.extractor.name} 추출기가 읽지 못했습니다: ${extracted.message}`,
          retryable: false,
        },
      );
    }

    const chunks: ExtractionChunkInput[] = extracted.pieces.map((piece, ordinal) => ({
      id: idGen.next(),
      ordinal,
      body: piece.body,
      chunkLocator: piece.chunkLocator,
      page: piece.page,
    }));
    if (chunks.length > 0) {
      const written = await writeExtractionChunks({ store, extractionId, chunks });
      if (!written.ok) {
        // Somebody redacted the file while this reading ran. Closing it `ok` is
        // what lets the store answer `redacted` and take the text away itself;
        // the item is done, because a redacted file never gets another reading
        // (AD-11, AD-24).
        if (written.code === 'FILE_REDACTED') {
          const refused = await close({
            status: 'ok',
            mediaType: detected.mediaType,
            indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID,
          });
          return refused ?? { ok: true };
        }
        // A database that would not take the batch is handed back under its own
        // code, with the generation left open: the next `beginExtraction`
        // closes it, which is the one thing that is allowed to (AD-24).
        if (written.code === 'DB_UNAVAILABLE' || written.code === 'DB_LOCKED') {
          return { ok: false, code: written.code, message: written.message };
        }
        if (written.code === 'EXTRACTION_CLOSED' || written.code === 'EXTRACTION_NOT_FOUND') {
          return { ok: false, code: written.code, message: written.message };
        }
        return stopped(
          { failedStage: 'index', mediaType: detected.mediaType },
          { code: written.code, message: written.message },
        );
      }
    }

    const refused = await close({
      status: 'ok',
      mediaType: detected.mediaType,
      indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID,
    });
    if (refused !== null) return refused;
    await resolve(store, clock, fileId);
    return { ok: true };
  };
}

/** The first extractor that recognises these bytes, and what it called them. */
function detect(
  extractors: readonly DocumentExtractor[],
  bytes: Uint8Array,
): { extractor: DocumentExtractor; mediaType: string } | null {
  for (const extractor of extractors) {
    const mediaType = extractor.detect(bytes);
    if (mediaType !== null) return { extractor, mediaType };
  }
  return null;
}

/**
 * Raise the mark that says this file's original cannot be reached, and hand the
 * failure on unchanged.
 *
 * The mark is what takes the file out of the queue's input; the failure is what
 * the person sees. A mark the database refused is dropped on purpose — the
 * failure being recorded is the interesting one, and the next drain meets the
 * file again and marks it then.
 */
async function unreachable(
  context: {
    store: Pick<ExtractionStore, 'setFileSourceUnreachable'>;
    clock: Clock;
    fileId: string;
  },
  failure: WorkHandlerFailure,
): Promise<WorkHandlerFailure> {
  await context.store.setFileSourceUnreachable({
    fileId: context.fileId,
    unreachableAt: context.clock.now(),
  });
  return failure;
}

/**
 * Close whatever this file's extraction failures were, because a reading
 * finally produced an answer.
 *
 * Dropped if it does not work, exactly as the session handler drops it: the
 * reading succeeded, and a bookkeeping row that could not be closed must not
 * turn it into work that is done again. The next success or `failures retry`
 * closes it.
 */
async function resolve(
  store: Pick<WorkStore, 'resolveFailures'>,
  clock: Clock,
  fileId: string,
): Promise<void> {
  try {
    await store.resolveFailures({
      targetKind: 'file',
      targetId: fileId,
      stage: DOCUMENT_EXTRACT_KIND,
      now: clock.now(),
    });
  } catch {
    // As above.
  }
}
