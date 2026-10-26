import type { IngestAttachment } from '../../domain/ingest-batch.js';
import { brainLocator, contentHashOfBytes, type FileLocation } from '../../domain/file.js';
import { DOCUMENT_CHUNK_BATCH_MAX } from '../../domain/document.js';
import { DOCUMENT_CHUNK_INDEX_CONFIG_ID } from '../../domain/index-config.js';
import { workKindPolicy } from '../../domain/work-item.js';
import { DOCUMENT_EXTRACT_KIND } from '../../files/extract-work.js';
import type {
  AttachmentStore,
  ExtractionChunkInput,
  ExtractionClaim,
  ExtractionOutcome,
  ExtractionStore,
  SessionStore,
  UserStore,
  WorkStore,
} from '../../ports/store.js';
import { assertEqual, assertNonEmptyString, assertNotOk, assertOk, assertTrue, fail } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import {
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
} from '../fixtures.js';
import { sequenceIdGen } from '../fakes/id-gen.js';

/**
 * The extraction capability of AD-24, as cases every adapter must pass.
 *
 * The subject is more than `ExtractionStore` because an extraction is about two
 * rows this capability does not create: the `files` row, which arrives with an
 * attachment, and the `work_items` claim, which `beginExtraction` checks. Both
 * are made here through the verbs that really make them — a case that reached
 * around them would be proving something about a fixture (Code Map).
 *
 * Nothing in here asks about a redacted file: only an adapter with the column
 * can be held to `FILE_REDACTED`, and the in-memory fake has no file redaction
 * (port contract). The adapters test it beside their own schema.
 */
export type ExtractionStoreSubject = ExtractionStore &
  AttachmentStore &
  SessionStore &
  UserStore &
  WorkStore;

/**
 * The kind the extraction claim is taken under — the handler's own name, now
 * that there is a handler (`files/extract-work.ts`).
 *
 * What these cases need of it is what every kind without a policy entry gets: an
 * open row keyed on one file, and that kind's claim window (`workKindPolicy`).
 */
const EXTRACT_KIND = DOCUMENT_EXTRACT_KIND;

/** The claim window of that kind, which is how a case makes a claim expire. */
const CLAIM_FOR_MS = workKindPolicy(EXTRACT_KIND).claimForMs;

const T0 = new Date('2026-03-04T05:06:07.000Z');

/** `T0` plus that many milliseconds, so a case reads as a sequence of moments. */
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** The bytes the one stored file of most of these cases is made of. */
const STORED_BYTES = Uint8Array.of(7, 8, 9);

/** One stored file, as the columns an extraction worker reads before it reads. */
interface StoredFile {
  fileId: string;
  bytes: Uint8Array;
  contentHash: string;
  /** Brain's own copy, which is where `readFileExtractionState.home` points. */
  home: FileLocation;
}

/**
 * One stored file per byte string, made the way a real one is: a session, a
 * message, and one attachment each whose bytes Brain kept.
 *
 * They go in as one ingest and on one message, because what the cases need is
 * several `files` rows and the attachment path is the only thing that makes
 * them. The order of the answer is the order of the input, so a caller can tell
 * its own files apart — and the ids rise with the sequence, which is also the
 * order `listFilesAwaitingExtraction` promises.
 */
async function storedFiles(
  store: ExtractionStoreSubject,
  ids: { next(): string },
  byteStrings: readonly Uint8Array[],
): Promise<readonly StoredFile[]> {
  assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
  assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
  const batch = sampleIngestBatch();
  const message = batch.messages[0];
  if (message === undefined) fail('표본 묶음에 메시지가 없습니다');
  const attachments: IngestAttachment[] = byteStrings.map((bytes, ordinal) => {
    const hash = contentHashOfBytes(bytes);
    return {
      id: ids.next(),
      harnessMessageId: message.harnessMessageId,
      ordinal,
      sourceKind: 'file',
      sourceRef: `~/notes/report-${String(ordinal)}.md`,
      displayName: `report-${String(ordinal)}.md`,
      file: {
        id: ids.next(),
        contentHash: hash,
        sizeBytes: bytes.length,
        location: {
          id: ids.next(),
          storeKind: 'local' as const,
          ownership: 'brain' as const,
          locator: brainLocator(hash.slice(7), bytes),
        },
        external: null,
      },
    };
  });
  assertOk(await store.ingest({ ...batch, attachments }), '첨부 수집');
  const rows = await store.listMessageAttachments(message.id);
  assertOk(rows, '첨부 읽기');
  return byteStrings.map((bytes, ordinal) => {
    const file = rows.attachments.find((row) => row.ordinal === ordinal)?.file ?? null;
    if (file === null) fail(`${String(ordinal)}번째 첨부가 파일 행을 만들지 않았습니다`);
    if (file.home === null) fail(`${String(ordinal)}번째 첨부에 brain 위치가 없습니다`);
    return { fileId: file.id, bytes, contentHash: file.contentHash, home: file.home };
  });
}

/**
 * The id of one stored file, which is the whole of what most of these cases
 * need of it.
 */
async function storedFile(
  store: ExtractionStoreSubject,
  ids: { next(): string },
): Promise<string> {
  const [file] = await storedFiles(store, ids, [STORED_BYTES]);
  if (file === undefined) fail('파일이 만들어지지 않았습니다');
  return file.fileId;
}

/**
 * Take the extraction claim on one file, as a drain run does: find-or-create the
 * open row and claim it. A second call with another `claimedBy` takes the same
 * row over, which is how a case makes the first claim expire.
 */
async function takeClaim(
  store: ExtractionStoreSubject,
  input: { fileId: string; workItemId: string; now: Date; claimedBy: string },
): Promise<ExtractionClaim> {
  assertOk(
    await store.addWork({
      id: input.workItemId,
      kind: EXTRACT_KIND,
      targetKind: 'file',
      targetId: input.fileId,
      createdAt: input.now,
      nextAttemptAt: input.now,
    }),
    '추출 일감',
  );
  const claimed = await store.claimWork({
    now: input.now,
    kinds: [EXTRACT_KIND],
    claimedBy: input.claimedBy,
  });
  assertOk(claimed, '추출 청구');
  if (claimed.item === null) fail('청구할 추출 일감이 없습니다');
  return { workItemId: claimed.item.id, claimedBy: input.claimedBy };
}

/** One piece of text at a character range, the shape a plain document produces. */
function textChunk(
  ids: { next(): string },
  ordinal: number,
  body = `조각 ${String(ordinal)}`,
): ExtractionChunkInput {
  return {
    id: ids.next(),
    ordinal,
    body,
    chunkLocator: { type: 'text', start: ordinal * 100, end: ordinal * 100 + 10 },
    page: null,
  };
}

export function extractionStoreContract(): ContractCase<ExtractionStoreSubject>[] {
  return [
    contractCase(
      '첫 세대는 attempt 1로 열리고 살아 있는 청구만 열 수 있다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3000, timestampMs: 1770000000000 });
          const fileId = await storedFile(store, ids);
          const claim = await takeClaim(store, {
            fileId,
            workItemId: ids.next(),
            now: T0,
            claimedBy: 'drain-a',
          });

          const begun = await store.beginExtraction({
            id: ids.next(),
            fileId,
            extractorVersion: 'text-1',
            startedAt: at(1),
            claim,
          });
          assertOk(begun, '첫 세대');
          assertEqual(begun.extraction.attempt, 1, '첫 attempt');
          assertEqual(begun.extraction.status, null, '열린 세대의 상태');
          assertEqual(begun.extraction.finishedAt, null, '열린 세대의 끝');
          assertEqual(begun.closedStale, null, '닫은 옛 세대 없음');

          const state = await store.readFileExtractionState(fileId);
          assertOk(state, '파일 상태');
          assertEqual(state.currentExtractionId, null, '아직 포인터 없음');
          assertEqual(state.lastAttempt, 1, '마지막 attempt');
          assertEqual(state.openExtraction?.id, begun.extraction.id, '열린 세대');
          assertEqual(state.sourceUnreachableAt, null, '원본은 닿는다');
          assertEqual(state.redactedAt, null, '가리지 않은 파일');

          // A claim nobody holds, and a claim held by somebody else, are the
          // same answer: this caller may not open a reading of this file.
          const unclaimed = await store.beginExtraction({
            id: ids.next(),
            fileId,
            extractorVersion: 'text-1',
            startedAt: at(2),
            claim: { workItemId: claim.workItemId, claimedBy: 'drain-b' },
          });
          assertNotOk(unclaimed, '남의 청구');
          assertEqual(unclaimed.code, 'CLAIM_LOST', '남의 청구 코드');

          // And a claim whose work item is finished is no claim either: the row
          // is out of the open-row key, so the next piece of extraction work for
          // this file will be a new row somebody else claims (AD-21).
          assertEqual(
            await store.completeWork({ id: claim.workItemId, claimedBy: claim.claimedBy, now: at(3) }),
            { ok: true, outcome: 'done' },
            '청구 닫기',
          );
          const closedClaim = await store.beginExtraction({
            id: ids.next(),
            fileId,
            extractorVersion: 'text-1',
            startedAt: at(4),
            claim,
          });
          assertNotOk(closedClaim, '닫힌 일감의 청구');
          assertEqual(closedClaim.code, 'CLAIM_LOST', '닫힌 일감 코드');

          assertEqual(
            await store.listExtractions(fileId),
            { ok: true, extractions: [begun.extraction] },
            '거부된 begin은 아무것도 더하지 않는다',
          );
        }),
    ),

    contractCase(
      '성공만 포인터를 옮기고 지워진 세대 뒤에도 attempt는 줄지 않는다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3100, timestampMs: 1770000000000 });
          const fileId = await storedFile(store, ids);
          const claim = await takeClaim(store, {
            fileId,
            workItemId: ids.next(),
            now: T0,
            claimedBy: 'drain-a',
          });

          const first = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-1', startedAt: at(1), claim,
          });
          assertOk(first, '세대 1');
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: first.extraction.id,
              chunks: [textChunk(ids, 0, '첫 세대 본문'), textChunk(ids, 1)],
            }),
            { ok: true, appended: 2 },
            '세대 1 조각',
          );
          const closedFirst = await store.finishExtraction({
            extractionId: first.extraction.id,
            finishedAt: at(2),
            outcome: {
              status: 'ok',
              mediaType: 'text/markdown',
              indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID,
            },
          });
          assertOk(closedFirst, '세대 1 닫기');
          assertEqual(closedFirst.current, true, '세대 1이 현재');
          assertEqual(closedFirst.extraction.status, 'ok', '세대 1 상태');
          assertEqual(closedFirst.extraction.failedStage, null, '성공에는 단계가 없다');
          assertEqual(
            closedFirst.extraction.indexConfigId,
            DOCUMENT_CHUNK_INDEX_CONFIG_ID,
            '세대 1의 조각 설정',
          );

          // The pieces come back in ordinal order with the position decoded.
          const held = await store.listExtractionChunks(first.extraction.id);
          assertOk(held, '세대 1 조각 읽기');
          assertEqual(held.chunks.map((chunk) => chunk.ordinal), [0, 1], '조각 순서');
          assertEqual(held.chunks[0]?.body, '첫 세대 본문', '조각 본문');
          assertEqual(held.chunks[0]?.chunkLocator, { type: 'text', start: 0, end: 10 }, '조각 위치');
          assertEqual(held.chunks[0]?.page, null, 'text 조각의 page');

          // A second reading takes over, and the first one's row and pieces go.
          const second = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-2', startedAt: at(3), claim,
          });
          assertOk(second, '세대 2');
          assertEqual(second.extraction.attempt, 2, '두 번째 attempt');
          assertEqual(second.closedStale, null, '닫을 옛 세대 없음');
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: second.extraction.id,
              chunks: [textChunk(ids, 0, '둘째 세대 본문')],
            }),
            { ok: true, appended: 1 },
            '세대 2 조각',
          );
          const closedSecond = await store.finishExtraction({
            extractionId: second.extraction.id,
            finishedAt: at(4),
            outcome: { status: 'ok', mediaType: 'text/markdown', indexConfigId: null },
          });
          assertOk(closedSecond, '세대 2 닫기');
          assertEqual(closedSecond.current, true, '세대 2가 현재');
          const afterSecond = await store.listExtractions(fileId);
          assertOk(afterSecond, '세대 목록');
          assertEqual(
            afterSecond.extractions.map((extraction) => extraction.attempt),
            [2],
            '옛 세대 행이 지워졌다',
          );
          assertEqual(await store.listExtractionChunks(first.extraction.id), { ok: true, chunks: [] }, '옛 조각이 지워졌다');
          const state = await store.readFileExtractionState(fileId);
          assertOk(state, '파일 상태');
          assertEqual(state.currentExtractionId, second.extraction.id, '포인터는 세대 2');
          assertEqual(state.lastAttempt, 2, '세대 2가 마지막');

          // The counter does not fall back into the gap the deletion left.
          const third = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-2', startedAt: at(5), claim,
          });
          assertOk(third, '세대 3');
          assertEqual(third.extraction.attempt, 3, '지운 뒤에도 단조');
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: third.extraction.id,
              chunks: [textChunk(ids, 0, '실패할 본문')],
            }),
            { ok: true, appended: 1 },
            '세대 3 조각',
          );
          const failed = await store.finishExtraction({
            extractionId: third.extraction.id,
            finishedAt: at(6),
            outcome: {
              status: 'failed',
              failedStage: 'chunk',
              error: '조각을 자르다 멈췄습니다',
              mediaType: 'text/markdown',
            },
          });
          assertOk(failed, '세대 3 닫기');
          assertEqual(failed.current, false, '실패는 현재가 아니다');
          assertEqual(failed.extraction.status, 'failed', '세대 3 상태');
          assertEqual(failed.extraction.failedStage, 'chunk', '세대 3 단계');
          assertEqual(await store.listExtractionChunks(third.extraction.id), { ok: true, chunks: [] }, '실패한 조각은 남지 않는다');
          const afterFailure = await store.readFileExtractionState(fileId);
          assertOk(afterFailure, '실패 뒤 상태');
          assertEqual(afterFailure.currentExtractionId, second.extraction.id, '포인터는 그대로');
          assertEqual(afterFailure.openExtraction, null, '열린 세대 없음');
          assertEqual(afterFailure.lastAttempt, 3, '실패 세대도 attempt를 쓴다');
          const kept = await store.listExtractionChunks(second.extraction.id);
          assertOk(kept, '현재 조각');
          assertEqual(kept.chunks.map((chunk) => chunk.body), ['둘째 세대 본문'], '현재 세대의 본문은 남는다');

          // The next success clears the failed row along with the replaced one:
          // what a success deletes is every other closed generation of the file,
          // and the failure's stage was only ever on show until then.
          const fourth = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-3', startedAt: at(7), claim,
          });
          assertOk(fourth, '세대 4');
          assertEqual(fourth.extraction.attempt, 4, '네 번째 attempt');
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: fourth.extraction.id,
              chunks: [textChunk(ids, 0, '넷째 세대 본문')],
            }),
            { ok: true, appended: 1 },
            '세대 4 조각',
          );
          const closedFourth = await store.finishExtraction({
            extractionId: fourth.extraction.id,
            finishedAt: at(8),
            outcome: { status: 'ok', mediaType: 'text/markdown', indexConfigId: null },
          });
          assertOk(closedFourth, '세대 4 닫기');
          assertEqual(closedFourth.current, true, '세대 4가 현재');
          const afterFourth = await store.listExtractions(fileId);
          assertOk(afterFourth, '세대 4 뒤 목록');
          assertEqual(
            afterFourth.extractions.map((extraction) => extraction.attempt),
            [4],
            '실패 세대 행까지 지워졌다',
          );
          const fifth = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-3', startedAt: at(9), claim,
          });
          assertOk(fifth, '세대 5');
          assertEqual(fifth.extraction.attempt, 5, '지운 뒤에도 여전히 단조');
        }),
    ),

    contractCase(
      '만료된 청구의 열린 세대는 다음 청구의 begin이 닫고 늦은 쓰기는 거부된다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3200, timestampMs: 1770000000000 });
          const fileId = await storedFile(store, ids);
          const claimA = await takeClaim(store, {
            fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
          });
          const stale = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-1', startedAt: at(1), claim: claimA,
          });
          assertOk(stale, '버려질 세대');
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: stale.extraction.id,
              chunks: [textChunk(ids, 0, '버려질 본문')],
            }),
            { ok: true, appended: 1 },
            '버려질 조각',
          );

          // The claim window passes and the next drain run takes the row over.
          const later = at(CLAIM_FOR_MS);
          const claimB = await takeClaim(store, {
            fileId, workItemId: claimA.workItemId, now: later, claimedBy: 'drain-b',
          });
          assertEqual(claimB.workItemId, claimA.workItemId, '같은 열린 행');
          const recovered = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-1', startedAt: later, claim: claimB,
          });
          assertOk(recovered, '회수한 세대');
          assertEqual(recovered.extraction.attempt, stale.extraction.attempt + 1, '회수 attempt');
          assertEqual(recovered.closedStale?.id, stale.extraction.id, '닫은 옛 세대');
          assertEqual(recovered.closedStale?.status, 'failed', '옛 세대는 실패로 닫힌다');
          assertEqual(recovered.closedStale?.failedStage, 'index', '조각까지 갔던 단계');
          assertEqual(recovered.closedStale?.finishedAt, later, '옛 세대가 닫힌 시각');
          assertNonEmptyString(recovered.closedStale?.error, '옛 세대의 사연');
          assertEqual(
            await store.listExtractionChunks(stale.extraction.id),
            { ok: true, chunks: [] },
            '옛 세대의 조각은 지워진다',
          );
          const state = await store.readFileExtractionState(fileId);
          assertOk(state, '회수 뒤 상태');
          assertEqual(state.openExtraction?.id, recovered.extraction.id, '열린 세대는 하나');
          assertEqual(state.currentExtractionId, null, '성공이 없으니 포인터도 없다');

          // The worker that lost its claim changes nothing, by any verb.
          const lost = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-1', startedAt: at(CLAIM_FOR_MS + 1), claim: claimA,
          });
          assertNotOk(lost, '잃은 청구');
          assertEqual(lost.code, 'CLAIM_LOST', '잃은 청구 코드');
          const lateChunk = await store.appendExtractionChunks({
            extractionId: stale.extraction.id,
            chunks: [textChunk(ids, 7, '늦은 본문')],
          });
          assertNotOk(lateChunk, '닫힌 세대에 쓰기');
          assertEqual(lateChunk.code, 'EXTRACTION_CLOSED', '늦은 조각 코드');
          const lateFinish = await store.finishExtraction({
            extractionId: stale.extraction.id,
            finishedAt: at(CLAIM_FOR_MS + 2),
            outcome: { status: 'ok', mediaType: 'text/markdown', indexConfigId: null },
          });
          assertNotOk(lateFinish, '닫힌 세대 닫기');
          assertEqual(lateFinish.code, 'EXTRACTION_CLOSED', '늦은 ok 코드');
          const unchanged = await store.readFileExtractionState(fileId);
          assertOk(unchanged, '늦은 시도 뒤 상태');
          assertEqual(unchanged.currentExtractionId, null, '포인터 불변');
          assertEqual(unchanged.lastAttempt, recovered.extraction.attempt, 'attempt 불변');
          assertEqual(
            await store.listExtractionChunks(stale.extraction.id),
            { ok: true, chunks: [] },
            '조각 불변',
          );

          // The new worker's reading then succeeds and takes the pointer.
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: recovered.extraction.id,
              chunks: [textChunk(ids, 0, '회수한 본문')],
            }),
            { ok: true, appended: 1 },
            '회수한 조각',
          );
          const closedRecovered = await store.finishExtraction({
            extractionId: recovered.extraction.id,
            finishedAt: at(CLAIM_FOR_MS + 3),
            outcome: { status: 'ok', mediaType: 'text/markdown', indexConfigId: null },
          });
          assertOk(closedRecovered, '회수한 세대 닫기');
          assertEqual(closedRecovered.current, true, '회수한 세대가 현재');

          // And the lost worker's late answers still change nothing. The code is
          // `EXTRACTION_NOT_FOUND` rather than `EXTRACTION_CLOSED` now, because
          // the success swept its generation's row away with the other closed
          // ones — either way the new current generation is untouched.
          const sweptChunk = await store.appendExtractionChunks({
            extractionId: stale.extraction.id,
            chunks: [textChunk(ids, 8, '더 늦은 본문')],
          });
          assertNotOk(sweptChunk, '지워진 세대에 쓰기');
          assertEqual(sweptChunk.code, 'EXTRACTION_NOT_FOUND', '지워진 세대 조각 코드');
          const sweptFinish = await store.finishExtraction({
            extractionId: stale.extraction.id,
            finishedAt: at(CLAIM_FOR_MS + 4),
            outcome: { status: 'ok', mediaType: 'text/markdown', indexConfigId: null },
          });
          assertNotOk(sweptFinish, '지워진 세대 닫기');
          assertEqual(sweptFinish.code, 'EXTRACTION_NOT_FOUND', '지워진 세대 닫기 코드');
          const afterLate = await store.readFileExtractionState(fileId);
          assertOk(afterLate, '늦은 시도 뒤 포인터');
          assertEqual(
            afterLate.currentExtractionId,
            recovered.extraction.id,
            '포인터는 여전히 새 일꾼의 세대',
          );
          const survived = await store.listExtractionChunks(recovered.extraction.id);
          assertOk(survived, '현재 조각');
          assertEqual(survived.chunks.map((chunk) => chunk.body), ['회수한 본문'], '현재 본문 불변');

          // A generation closed by the next begin before it wrote anything says
          // `read`: the pieces are the only thing the stage can be read from.
          const empty = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-2', startedAt: at(CLAIM_FOR_MS + 5), claim: claimB,
          });
          assertOk(empty, '아무것도 쓰지 않은 세대');
          const muchLater = at(2 * CLAIM_FOR_MS);
          const claimC = await takeClaim(store, {
            fileId, workItemId: claimB.workItemId, now: muchLater, claimedBy: 'drain-c',
          });
          const afterEmpty = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-2', startedAt: muchLater, claim: claimC,
          });
          assertOk(afterEmpty, '빈 세대를 닫은 begin');
          assertEqual(afterEmpty.closedStale?.id, empty.extraction.id, '닫은 빈 세대');
          assertEqual(afterEmpty.closedStale?.failedStage, 'read', '조각이 없던 단계');
          const afterEmptyState = await store.readFileExtractionState(fileId);
          assertOk(afterEmptyState, '빈 세대 뒤 상태');
          assertEqual(
            afterEmptyState.currentExtractionId,
            recovered.extraction.id,
            '빈 세대를 닫아도 포인터는 그대로',
          );
        }),
    ),

    contractCase(
      '조각 배치는 크기와 위치가 모두 맞아야 한 줄이라도 들어간다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3300, timestampMs: 1770000000000 });
          const fileId = await storedFile(store, ids);
          const claim = await takeClaim(store, {
            fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
          });
          const begun = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'pdf-1', startedAt: at(1), claim,
          });
          assertOk(begun, '세대');
          const extractionId = begun.extraction.id;
          const refuse = async (
            chunks: readonly ExtractionChunkInput[],
            code: 'CHUNK_INVALID' | 'CHUNK_BATCH_TOO_LARGE',
            what: string,
          ): Promise<void> => {
            const result = await store.appendExtractionChunks({ extractionId, chunks });
            assertNotOk(result, what);
            assertEqual(result.code, code, `${what} 코드`);
          };

          // The `page` copy is the locator's own, compared with `===`.
          await refuse(
            [{ id: ids.next(), ordinal: 0, body: 'pdf', chunkLocator: { type: 'pdf', page: 4 }, page: 5 }],
            'CHUNK_INVALID',
            '어긋난 pdf page',
          );
          await refuse(
            [{ id: ids.next(), ordinal: 0, body: 'text', chunkLocator: { type: 'text', start: 0, end: 4 }, page: 4 }],
            'CHUNK_INVALID',
            'text에 붙은 page',
          );
          // A caller that never read the column is refused rather than
          // corrected, so the absence has to be `null` and not a missing key.
          const noPage = { id: ids.next(), ordinal: 0, body: 'text', chunkLocator: { type: 'text' as const, start: 0, end: 4 } };
          await refuse([noPage as unknown as ExtractionChunkInput], 'CHUNK_INVALID', '빠진 page');
          await refuse(
            [{ id: ids.next(), ordinal: 0, body: 'text', chunkLocator: { type: 'text', start: 9, end: 4 }, page: null }],
            'CHUNK_INVALID',
            '거꾸로 된 범위',
          );
          await refuse(
            [textChunk(ids, 0), textChunk(ids, 0)],
            'CHUNK_INVALID',
            '배치 안에서 겹친 ordinal',
          );
          // `document_chunks.id` is unique, so a repeated id is as refusable as a
          // repeated ordinal — and refused here rather than left to a real
          // adapter's unique index, which would throw where the fake would not.
          const repeated = textChunk(ids, 0);
          await refuse(
            [repeated, { ...repeated, ordinal: 1 }],
            'CHUNK_INVALID',
            '배치 안에서 겹친 id',
          );
          await refuse([{ ...textChunk(ids, 0), ordinal: -1 }], 'CHUNK_INVALID', '음수 ordinal');
          await refuse([{ ...textChunk(ids, 0), ordinal: 1.5 }], 'CHUNK_INVALID', '정수가 아닌 ordinal');
          await refuse([], 'CHUNK_BATCH_TOO_LARGE', '빈 배치');
          await refuse(
            Array.from({ length: DOCUMENT_CHUNK_BATCH_MAX + 1 }, (_unused, index) => textChunk(ids, index)),
            'CHUNK_BATCH_TOO_LARGE',
            '상한을 넘은 배치',
          );
          assertEqual(
            await store.listExtractionChunks(extractionId),
            { ok: true, chunks: [] },
            '거부된 배치는 한 줄도 쓰지 않는다',
          );

          // The good shapes, including the bound itself.
          const pdf: ExtractionChunkInput = {
            id: ids.next(),
            ordinal: 0,
            body: 'pdf 본문',
            chunkLocator: { type: 'pdf', page: 4, bbox: [0, 0, 1, 1] },
            page: 4,
          };
          assertEqual(
            await store.appendExtractionChunks({ extractionId, chunks: [pdf, textChunk(ids, 1)] }),
            { ok: true, appended: 2 },
            '맞는 배치',
          );
          const stored = await store.listExtractionChunks(extractionId);
          assertOk(stored, '조각 읽기');
          assertEqual(stored.chunks[0]?.page, 4, 'pdf 조각의 page 사본');
          assertEqual(
            stored.chunks[0]?.chunkLocator,
            { type: 'pdf', page: 4, bbox: [0, 0, 1, 1] },
            'pdf 조각의 위치',
          );

          // An ordinal the generation already holds is the same mistake as one
          // the batch repeats, an id it already holds likewise, and one bad piece
          // refuses its whole batch.
          await refuse([textChunk(ids, 1)], 'CHUNK_INVALID', '이미 있는 ordinal');
          await refuse([{ ...pdf, ordinal: 2 }], 'CHUNK_INVALID', '이미 있는 id');
          await refuse(
            [textChunk(ids, 2), { ...textChunk(ids, 3), ordinal: -5 }],
            'CHUNK_INVALID',
            '배치 안의 한 조각만 무효',
          );
          assertEqual(
            await store.listExtractionChunks(extractionId),
            { ok: true, chunks: stored.chunks },
            '부분 쓰기 없음',
          );

          const full = Array.from({ length: DOCUMENT_CHUNK_BATCH_MAX }, (_unused, index) =>
            textChunk(ids, index + 100),
          );
          assertEqual(
            await store.appendExtractionChunks({ extractionId, chunks: full }),
            { ok: true, appended: DOCUMENT_CHUNK_BATCH_MAX },
            '상한만큼의 배치',
          );
          const all = await store.listExtractionChunks(extractionId);
          assertOk(all, '전체 조각');
          assertEqual(all.chunks.length, DOCUMENT_CHUNK_BATCH_MAX + 2, '쌓인 조각 수');
          assertTrue(
            all.chunks.every((chunk, index) => index === 0 || chunk.ordinal > (all.chunks[index - 1]?.ordinal ?? -1)),
            '조각은 ordinal 순서로 돌아온다',
          );
        }),
    ),

    contractCase(
      '영구 실패는 포인터를 건드리지 않고 원본 접근 불가 표시는 그 칸만 쓴다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3400, timestampMs: 1770000000000 });
          const fileId = await storedFile(store, ids);
          const claim = await takeClaim(store, {
            fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
          });

          const good = await store.beginExtraction({
            id: ids.next(), fileId, extractorVersion: 'text-1', startedAt: at(1), claim,
          });
          assertOk(good, '성공할 세대');
          assertEqual(
            await store.appendExtractionChunks({
              extractionId: good.extraction.id,
              chunks: [textChunk(ids, 0, '남을 본문')],
            }),
            { ok: true, appended: 1 },
            '남을 조각',
          );
          assertOk(
            await store.finishExtraction({
              extractionId: good.extraction.id,
              finishedAt: at(2),
              outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: null },
            }),
            '성공 닫기',
          );

          for (const [index, status] of (['unsupported', 'too_large'] as const).entries()) {
            const attempt = await store.beginExtraction({
              id: ids.next(), fileId, extractorVersion: 'text-1', startedAt: at(10 + index * 2), claim,
            });
            assertOk(attempt, `${status} 세대`);
            assertEqual(
              await store.appendExtractionChunks({
                extractionId: attempt.extraction.id,
                chunks: [textChunk(ids, 0, '지워질 본문')],
              }),
              { ok: true, appended: 1 },
              `${status} 조각`,
            );
            const closed = await store.finishExtraction({
              extractionId: attempt.extraction.id,
              finishedAt: at(11 + index * 2),
              outcome: { status, error: '이 형식은 읽지 않습니다', mediaType: null },
            });
            assertOk(closed, `${status} 닫기`);
            assertEqual(closed.current, false, `${status}는 현재가 아니다`);
            assertEqual(closed.extraction.status, status, `${status} 상태`);
            assertEqual(closed.extraction.failedStage, null, `${status}에는 단계가 없다`);
            assertEqual(
              await store.listExtractionChunks(attempt.extraction.id),
              { ok: true, chunks: [] },
              `${status} 조각은 남지 않는다`,
            );
            const state = await store.readFileExtractionState(fileId);
            assertOk(state, `${status} 뒤 상태`);
            assertEqual(state.currentExtractionId, good.extraction.id, `${status} 뒤에도 포인터는 그대로`);
          }
          const survivors = await store.listExtractionChunks(good.extraction.id);
          assertOk(survivors, '현재 조각');
          assertEqual(survivors.chunks.map((chunk) => chunk.body), ['남을 본문'], '현재 본문은 남는다');

          const marked = at(100);
          assertEqual(await store.setFileSourceUnreachable({ fileId, unreachableAt: marked }), { ok: true }, '원본 표시');
          const afterMark = await store.readFileExtractionState(fileId);
          assertOk(afterMark, '표시 뒤 상태');
          assertEqual(afterMark.sourceUnreachableAt, marked, '표시한 시각');
          assertEqual(afterMark.currentExtractionId, good.extraction.id, '표시는 포인터를 건드리지 않는다');
          assertEqual(
            await store.listExtractionChunks(good.extraction.id),
            { ok: true, chunks: survivors.chunks },
            '표시는 조각을 건드리지 않는다',
          );
          assertEqual(await store.setFileSourceUnreachable({ fileId, unreachableAt: null }), { ok: true }, '표시 해제');
          const cleared = await store.readFileExtractionState(fileId);
          assertOk(cleared, '해제 뒤 상태');
          assertEqual(cleared.sourceUnreachableAt, null, '해제된 시각');
          assertEqual(cleared.currentExtractionId, good.extraction.id, '해제도 포인터를 건드리지 않는다');
        }),
    ),

    contractCase(
      '모르는 파일과 모르는 세대는 거부하고 빈 목록은 실패가 아니다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3500, timestampMs: 1770000000000 });
          const fileId = await storedFile(store, ids);
          const claim = await takeClaim(store, {
            fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
          });
          const unknownFileId = '01980000-0000-7000-8000-0000000000ff';
          const unknownExtractionId = '01980000-0000-7000-8000-0000000000fe';

          const begun = await store.beginExtraction({
            id: ids.next(), fileId: unknownFileId, extractorVersion: 'text-1', startedAt: at(1), claim,
          });
          assertNotOk(begun, '모르는 파일에 begin');
          assertEqual(begun.code, 'FILE_NOT_FOUND', '모르는 파일 코드');
          const read = await store.readFileExtractionState(unknownFileId);
          assertNotOk(read, '모르는 파일 상태');
          assertEqual(read.code, 'FILE_NOT_FOUND', '모르는 파일 상태 코드');
          const marked = await store.setFileSourceUnreachable({ fileId: unknownFileId, unreachableAt: at(2) });
          assertNotOk(marked, '모르는 파일 표시');
          assertEqual(marked.code, 'FILE_NOT_FOUND', '모르는 파일 표시 코드');

          const appended = await store.appendExtractionChunks({
            extractionId: unknownExtractionId,
            chunks: [textChunk(ids, 0)],
          });
          assertNotOk(appended, '모르는 세대에 조각');
          assertEqual(appended.code, 'EXTRACTION_NOT_FOUND', '모르는 세대 코드');
          const finished = await store.finishExtraction({
            extractionId: unknownExtractionId,
            finishedAt: at(3),
            outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: null },
          });
          assertNotOk(finished, '모르는 세대 닫기');
          assertEqual(finished.code, 'EXTRACTION_NOT_FOUND', '모르는 세대 닫기 코드');

          // A read with nothing to show is a value: a file nobody has read yet
          // is the ordinary state of every file's first seconds.
          assertEqual(await store.listExtractions(unknownFileId), { ok: true, extractions: [] }, '모르는 파일의 세대 목록');
          assertEqual(await store.listExtractionChunks(unknownExtractionId), { ok: true, chunks: [] }, '모르는 세대의 조각 목록');
          assertEqual(await store.listExtractions(fileId), { ok: true, extractions: [] }, '아직 읽지 않은 파일');
        }),
    ),

    contractCase(
      '파일의 추출 상태는 해시·크기·brain 위치를 함께 낸다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3600, timestampMs: 1770000000000 });
          const [file] = await storedFiles(store, ids, [STORED_BYTES]);
          if (file === undefined) fail('파일이 만들어지지 않았습니다');

          // The three columns a worker needs before it reads anything: which
          // bytes these are meant to be, how many of them there are, and where
          // Brain's own copy is. One read, because a worker that asked twice
          // could be told about a file that changed in between (port contract).
          const state = await store.readFileExtractionState(file.fileId);
          assertOk(state, '파일 상태');
          assertEqual(state.contentHash, file.contentHash, '수집 때의 해시');
          assertEqual(state.sizeBytes, file.bytes.length, '수집 때의 크기');
          assertEqual(state.home, file.home, 'brain 위치');
        }),
    ),

    contractCase(
      '추출을 기다리는 목록은 세대가 없고 닿을 수 있는 파일만 낸다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3700, timestampMs: 1770000000000 });
          const stored = await storedFiles(store, ids, [STORED_BYTES, Uint8Array.of(1, 2, 3)]);
          const [first, second] = stored;
          if (first === undefined || second === undefined) fail('파일이 둘 만들어지지 않았습니다');
          const awaiting = async (limit = 10): Promise<readonly string[]> => {
            const read = await store.listFilesAwaitingExtraction({ limit });
            assertOk(read, '기다리는 파일');
            return read.fileIds;
          };

          // Both files, `id` ascending, and the bound is a bound.
          assertEqual(await awaiting(), [first.fileId, second.fileId], '아직 아무도 읽지 않았다');
          assertEqual(await awaiting(1), [first.fileId], '상한만큼만');

          // An open generation is a generation: the file is out of the list from
          // the moment a reading starts, which is what keeps the next drain from
          // queueing the same file again (`files/extract-work.ts`).
          const claim = await takeClaim(store, {
            fileId: first.fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
          });
          const begun = await store.beginExtraction({
            id: ids.next(), fileId: first.fileId, extractorVersion: 'text-1', startedAt: at(1), claim,
          });
          assertOk(begun, '세대');
          assertEqual(await awaiting(), [second.fileId], '읽기 시작한 파일은 빠진다');

          // And a closed one is too, whatever it answered: a file whose only
          // reading says `unsupported` has been read, and asking again would be
          // the same work every drain for ever (Design Notes).
          assertOk(
            await store.finishExtraction({
              extractionId: begun.extraction.id,
              finishedAt: at(2),
              outcome: { status: 'unsupported', error: '읽지 않는 형식입니다', mediaType: null },
            }),
            'unsupported 닫기',
          );
          assertEqual(await awaiting(), [second.fileId], '읽기를 마친 파일도 빠진다');

          // A file whose original went out of reach is left out as well, and
          // comes back the moment the mark is cleared: the mark is a state of
          // the bytes and says nothing about the content (AD-24).
          assertEqual(
            await store.setFileSourceUnreachable({ fileId: second.fileId, unreachableAt: at(3) }),
            { ok: true },
            '원본 표시',
          );
          assertEqual(await awaiting(), [], '닿을 수 없는 파일은 빠진다');
          assertEqual(
            await store.setFileSourceUnreachable({ fileId: second.fileId, unreachableAt: null }),
            { ok: true },
            '표시 해제',
          );
          assertEqual(await awaiting(), [second.fileId], '다시 닿으면 돌아온다');
        }),
    ),

    contractCase(
      '뒤처진 목록은 옛 버전으로 성공한 파일만 내고 닿을 수 없는 것은 센다',
      async (make) =>
        withSubject(make, async (store) => {
          const ids = sequenceIdGen({ start: 3800, timestampMs: 1770000000000 });
          const stored = await storedFiles(store, ids, [
            Uint8Array.of(1, 1, 1),
            Uint8Array.of(2, 2, 2),
            Uint8Array.of(3, 3, 3),
            Uint8Array.of(4, 4, 4),
            Uint8Array.of(5, 5, 5),
          ]);
          const [first, second, retried, unreadable, current] = stored;
          if (
            first === undefined ||
            second === undefined ||
            retried === undefined ||
            unreadable === undefined ||
            current === undefined
          ) {
            fail('파일이 다섯 만들어지지 않았습니다');
          }

          // One claim per file, kept so a second reading of the same file can
          // use it: the claim is the worker's, and a file gets another
          // generation without getting another queue row.
          const claims = new Map<string, ExtractionClaim>();
          const reading = async (
            fileId: string,
            extractorVersion: string,
            outcome: ExtractionOutcome,
          ): Promise<void> => {
            let claim = claims.get(fileId);
            if (claim === undefined) {
              claim = await takeClaim(store, {
                fileId,
                workItemId: ids.next(),
                now: T0,
                claimedBy: `drain-${String(claims.size)}`,
              });
              claims.set(fileId, claim);
            }
            const begun = await store.beginExtraction({
              id: ids.next(),
              fileId,
              extractorVersion,
              startedAt: at(1),
              claim,
            });
            assertOk(begun, '세대');
            assertOk(
              await store.finishExtraction({
                extractionId: begun.extraction.id,
                finishedAt: at(2),
                outcome,
              }),
              '세대 닫기',
            );
          };
          const ok: ExtractionOutcome = {
            status: 'ok',
            mediaType: 'text/plain',
            indexConfigId: null,
          };

          // Two files whose current reading an older generation of extractors
          // made, which is the whole of what this list is for.
          await reading(first.fileId, 'text-1', ok);
          await reading(second.fileId, 'text-1', ok);
          // A third that was already asked once and could not be read: the
          // generation of the asked-for version is there, and that is what
          // keeps it out — otherwise every drain would queue it again.
          await reading(retried.fileId, 'text-1', ok);
          await reading(retried.fileId, 'text-2', {
            status: 'failed',
            failedStage: 'extract',
            error: '다시 읽기가 실패했습니다',
            mediaType: null,
          });
          // A fourth whose only reading answered `unsupported`: no pointer, so
          // nothing to be behind. A newer extractor reaching it is another
          // story's (Design Notes).
          await reading(unreadable.fileId, 'text-1', {
            status: 'unsupported',
            error: '읽을 추출기가 없습니다',
            mediaType: null,
          });
          // And a fifth this build already read, which is the ordinary state.
          await reading(current.fileId, 'text-2', ok);

          const behind = async (limit = 10) => {
            const read = await store.listFilesWithStaleExtraction({
              extractorVersion: 'text-2',
              limit,
            });
            assertOk(read, '뒤처진 파일');
            return read;
          };

          const all = await behind();
          assertEqual(all.fileIds, [first.fileId, second.fileId], '옛 버전으로 성공한 파일만');
          assertEqual(all.redacted, 0, '가린 파일은 없다');
          assertEqual(all.sourceUnreachable, 0, '닿을 수 없는 파일은 없다');
          assertEqual((await behind(1)).fileIds, [first.fileId], '상한만큼만');

          // A file whose original went out of reach is left out of the ids and
          // counted instead, and the count is the whole count rather than the
          // part `limit` would have shown: it answers what this drain is *not*
          // doing, which a bound must not change (port contract).
          assertEqual(
            await store.setFileSourceUnreachable({ fileId: second.fileId, unreachableAt: at(3) }),
            { ok: true },
            '원본 표시',
          );
          const marked = await behind();
          assertEqual(marked.fileIds, [first.fileId], '닿을 수 없는 파일은 빠진다');
          assertEqual(marked.sourceUnreachable, 1, '닿을 수 없는 파일 수');
          assertEqual(marked.redacted, 0, '가리기는 어댑터의 몫');
          assertEqual((await behind(1)).sourceUnreachable, 1, '상한과 무관한 전체 수');

          assertEqual(
            await store.setFileSourceUnreachable({ fileId: second.fileId, unreachableAt: null }),
            { ok: true },
            '표시 해제',
          );
          assertEqual(
            (await behind()).fileIds,
            [first.fileId, second.fileId],
            '다시 닿으면 돌아온다',
          );
        }),
    ),
  ];
}
