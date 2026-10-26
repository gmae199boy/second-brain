import { brainLocator, contentHashOfBytes } from '../../domain/file.js';
import type { IngestAttachment } from '../../domain/ingest-batch.js';
import { DOCUMENT_CHUNK_INDEX_CONFIG_ID } from '../../domain/index-config.js';
import { DOCUMENT_EXTRACT_KIND } from '../../files/extract-work.js';
import { planFileRedaction } from '../../files/redact.js';
import type {
  AttachmentStore,
  ExtractionClaim,
  ExtractionStore,
  SessionStore,
  UserStore,
  WorkStore,
} from '../../ports/store.js';
import { assertEqual, assertNotOk, assertOk, assertTrue, fail } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { fixedClock } from '../fakes/clock.js';
import { sequenceIdGen } from '../fakes/id-gen.js';
import {
  sampleEnsureSessionInput,
  sampleIngestBatch,
  sampleSelfUserInput,
} from '../fixtures.js';

/**
 * Masking one whole file, as cases every adapter must pass (AD-11, AD-23).
 *
 * The subject reaches past `AttachmentStore` because a masking is about rows
 * four other capabilities own: the `files` row an attachment creates, the
 * extraction generation it takes the text out of, the `work_items` row it puts
 * the blob deletion on, and the message whose own masking has to report the
 * attachment it left behind. All of them are made here through the verbs that
 * really make them, never reached around (Code Map).
 *
 * The plan the cases hand the store is Core's own `planFileRedaction`, so what
 * they hold an adapter to is what the verb will really ask of it.
 */
export type FileRedactionSubject = AttachmentStore &
  ExtractionStore &
  SessionStore &
  UserStore &
  WorkStore;

const T0 = new Date('2026-03-04T05:06:07.000Z');

/** `T0` plus that many milliseconds, so a case reads as a sequence of moments. */
function at(offsetMs: number): Date {
  return new Date(T0.getTime() + offsetMs);
}

/** The bytes of the file most of these cases mask. */
const SHARED_BYTES = Uint8Array.of(11, 12, 13);
/** A second content, so a case can see the other file left alone. */
const OTHER_BYTES = Uint8Array.of(21, 22);

interface Attached {
  /** The shared file: attached to two messages, with a Brain and an external place. */
  shared: { fileId: string; contentHash: string; brainLocationId: string; externalLocationId: string };
  /** A second file on the first message alone. */
  other: { fileId: string; contentHash: string };
  /** The two messages that carry the shared file, and nothing else about them. */
  messageIds: readonly string[];
}

/**
 * One shared file on two messages, one other file on the first, and one place
 * that was already missing — the shape every case below needs.
 *
 * It is made by ingesting attachments, because that is the only thing that
 * makes a `files` row: a fixture that inserted one would be proving something
 * about itself (Code Map).
 */
async function attached(
  store: FileRedactionSubject,
  ids: { next(): string },
): Promise<Attached> {
  assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
  assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
  const batch = sampleIngestBatch();
  const first = batch.messages[0];
  const second = batch.messages[1];
  if (first === undefined || second === undefined) fail('표본 묶음에 메시지가 둘 없습니다');

  const sharedHash = contentHashOfBytes(SHARED_BYTES);
  const otherHash = contentHashOfBytes(OTHER_BYTES);
  const sharedFileId = ids.next();
  const brainLocationId = ids.next();
  const externalLocationId = ids.next();
  const otherFileId = ids.next();
  const sharedFile = {
    id: sharedFileId,
    contentHash: sharedHash,
    sizeBytes: SHARED_BYTES.length,
    location: {
      id: brainLocationId,
      storeKind: 'local' as const,
      ownership: 'brain' as const,
      locator: brainLocator(sharedHash.slice(7), SHARED_BYTES),
    },
  };
  const attachments: IngestAttachment[] = [
    {
      id: ids.next(), harnessMessageId: first.harnessMessageId, ordinal: 0,
      sourceKind: 'file', sourceRef: '~/project/shared.txt', displayName: 'shared.txt',
      file: {
        ...sharedFile,
        external: {
          id: externalLocationId, storeKind: 'local', ownership: 'external',
          locator: '~/project/shared.txt',
        },
      },
    },
    {
      // The same content on another message: one `files` row, one blob, and two
      // conversations that lose it when it is masked.
      id: ids.next(), harnessMessageId: second.harnessMessageId, ordinal: 0,
      sourceKind: 'file', sourceRef: '~/project/shared.txt', displayName: 'shared.txt',
      file: { ...sharedFile, external: null },
    },
    {
      id: ids.next(), harnessMessageId: first.harnessMessageId, ordinal: 1,
      sourceKind: 'file', sourceRef: '~/project/other.txt', displayName: 'other.txt',
      file: {
        id: otherFileId, contentHash: otherHash, sizeBytes: OTHER_BYTES.length,
        location: {
          id: ids.next(), storeKind: 'local', ownership: 'brain',
          locator: brainLocator(otherHash.slice(7), OTHER_BYTES),
        },
        external: null,
      },
    },
    {
      // An attachment whose bytes were already gone when it was collected: it
      // has no file, so no masking of a message ever counts it.
      id: ids.next(), harnessMessageId: first.harnessMessageId, ordinal: 2,
      sourceKind: 'file', sourceRef: '~/project/gone.txt', displayName: 'gone.txt',
      file: null,
    },
    {
      // The shared content a second time on the *first* message, which is what
      // makes the sharing count a count of messages and not of attachment
      // rows: without this a store that dropped the `distinct` would pass.
      id: ids.next(), harnessMessageId: first.harnessMessageId, ordinal: 3,
      sourceKind: 'file', sourceRef: '~/project/shared.txt', displayName: 'shared.txt',
      file: { ...sharedFile, external: null },
    },
  ];
  assertOk(await store.ingest({ ...batch, attachments }), '첨부 수집');

  const rows = await store.listMessageAttachments(first.id);
  assertOk(rows, '첨부 읽기');
  const shared = rows.attachments.find((row) => row.ordinal === 0)?.file ?? null;
  const other = rows.attachments.find((row) => row.ordinal === 1)?.file ?? null;
  if (shared === null || other === null) fail('첨부가 파일 행을 만들지 않았습니다');
  const places = await store.listFileLocations(shared.id);
  assertOk(places, '위치 목록');
  const brain = places.locations.find((row) => row.ownership === 'brain');
  const external = places.locations.find((row) => row.ownership === 'external');
  if (brain === undefined || external === undefined) fail('위치 두 개가 필요합니다');
  return {
    shared: {
      fileId: shared.id, contentHash: shared.contentHash,
      brainLocationId: brain.id, externalLocationId: external.id,
    },
    other: { fileId: other.id, contentHash: other.contentHash },
    messageIds: [first.id, second.id],
  };
}

/** The plan every case masks with: Core's own, on a fixed clock (`files/redact.ts`). */
function planWith(ids: { next(): string }, now: Date) {
  return (current: Parameters<typeof planFileRedaction>[0]) =>
    planFileRedaction(current, { clock: fixedClock(now), idGen: ids });
}

/** Take the extraction claim on one file, as a drain run does (AD-21, AD-24). */
async function takeClaim(
  store: FileRedactionSubject,
  input: { fileId: string; workItemId: string; now: Date; claimedBy: string },
): Promise<ExtractionClaim> {
  assertOk(
    await store.addWork({
      id: input.workItemId, kind: DOCUMENT_EXTRACT_KIND, targetKind: 'file',
      targetId: input.fileId, createdAt: input.now, nextAttemptAt: input.now,
    }),
    '추출 일감',
  );
  const claimed = await store.claimWork({
    now: input.now, kinds: [DOCUMENT_EXTRACT_KIND], claimedBy: input.claimedBy,
  });
  assertOk(claimed, '추출 청구');
  if (claimed.item === null) fail('청구할 추출 일감이 없습니다');
  return { workItemId: claimed.item.id, claimedBy: input.claimedBy };
}

/** A masking of nothing: what a case hands `redactMessage` to read one count. */
const NO_SPANS = (current: { message: { body: string } }) => ({
  body: current.message.body,
  toolNotes: [],
  redactions: [],
  bodySpans: 0,
  toolNoteSpans: 0,
});

/** Every `blob_delete` target now open, which is what the drain would delete. */
async function blobDeleteTargets(store: FileRedactionSubject): Promise<readonly string[]> {
  const open = await store.listOpenWorkTargets({ kind: 'blob_delete' });
  assertOk(open, '블롭 삭제 일감');
  return open.targets
    .filter((target) => target.targetKind === 'file_location')
    .map((target) => target.targetId)
    .sort();
}

export function fileRedactionContract(): ContractCase<FileRedactionSubject>[] {
  return [
    contractCase('파일은 id와 내용 해시로 읽히고 공유 메시지 수를 센다', async (make) =>
      withSubject(make, async (store) => {
        const ids = sequenceIdGen({ start: 4000, timestampMs: 1770000000000 });
        const rows = await attached(store, ids);

        const byId = await store.readFileSharing({ fileId: rows.shared.fileId });
        assertOk(byId, 'id로 읽기');
        assertEqual(byId.file.id, rows.shared.fileId, '파일 id');
        assertEqual(byId.file.contentHash, rows.shared.contentHash, '내용 해시');
        assertEqual(byId.file.redactedAt, null, '아직 가리지 않음');
        // Three attachment rows point at it and two messages carry them: the
        // count is of messages.
        assertEqual(byId.messages, 2, '공유 메시지 수');

        // The same answer by content, which is the name a person can work out
        // from the original bytes (`files/redact.ts`).
        const byHash = await store.readFileSharing({ contentHash: rows.shared.contentHash });
        assertOk(byHash, '해시로 읽기');
        assertEqual(byHash.file.id, rows.shared.fileId, '해시가 같은 행');
        assertEqual(byHash.messages, 2, '해시로도 같은 수');

        const single = await store.readFileSharing({ fileId: rows.other.fileId });
        assertOk(single, '다른 파일');
        assertEqual(single.messages, 1, '한 메시지만 쓰는 파일');

        const absentId = await store.readFileSharing({ fileId: '01940000-0000-7000-8000-0000000000ff' });
        assertNotOk(absentId, '없는 id');
        assertEqual(absentId.code, 'FILE_NOT_FOUND', '없는 id의 코드');
        const absentHash = await store.readFileSharing({ contentHash: `sha256:${'0'.repeat(64)}` });
        assertNotOk(absentHash, '없는 해시');
        assertEqual(absentHash.code, 'FILE_NOT_FOUND', '없는 해시의 코드');

        // The collection path's read: nothing is masked yet, and no hashes is
        // an empty answer that opens nothing.
        assertEqual(await store.listRedactedContentHashes([]), { ok: true, hashes: [] }, '빈 입력');
        assertEqual(
          await store.listRedactedContentHashes([rows.shared.contentHash, rows.other.contentHash]),
          { ok: true, hashes: [] },
          '가린 해시 없음',
        );

        const masked = await store.redactFile({
          fileId: rows.shared.fileId, plan: planWith(ids, at(10)),
        });
        assertOk(masked, '가리기');
        assertEqual(
          await store.listRedactedContentHashes([rows.shared.contentHash, rows.other.contentHash]),
          { ok: true, hashes: [rows.shared.contentHash] },
          '가린 해시만',
        );
        const after = await store.readFileSharing({ contentHash: rows.shared.contentHash });
        assertOk(after, '가린 뒤 읽기');
        assertEqual(after.file.redactedAt, at(10), '가린 시각');
        assertEqual(after.messages, 2, '첨부 행은 그대로 가리킨다');
      }),
    ),

    contractCase('가리기는 조각·세대·이름을 지우고 Brain 위치만 일감으로 넣는다', async (make) =>
      withSubject(make, async (store) => {
        const ids = sequenceIdGen({ start: 5000, timestampMs: 1770000000000 });
        const rows = await attached(store, ids);

        // A name index entry, through the verb that really fills it.
        const candidates = await store.listMissingFileNames({ limit: 500 });
        assertOk(candidates, '이름 후보');
        const names = candidates.names.map((name) => ({ ...name, id: ids.next() }));
        const sharedNames = names.filter((name) => name.fileId === rows.shared.fileId);
        assertTrue(sharedNames.length > 0, '가릴 파일의 이름 후보');
        assertOk(await store.writeFileNames({ names }), '이름 쓰기');

        // And one successful reading, so there is text to take away.
        const claim = await takeClaim(store, {
          fileId: rows.shared.fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
        });
        const begun = await store.beginExtraction({
          id: ids.next(), fileId: rows.shared.fileId, extractorVersion: 'text-1',
          startedAt: at(1), claim,
        });
        assertOk(begun, '세대 열기');
        assertOk(
          await store.appendExtractionChunks({
            extractionId: begun.extraction.id,
            chunks: [{ id: ids.next(), ordinal: 0, body: '첫 조각', page: null,
              chunkLocator: { type: 'text', start: 0, end: 3 } }],
          }),
          '조각 쓰기',
        );
        const finished = await store.finishExtraction({
          extractionId: begun.extraction.id, finishedAt: at(2),
          outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID },
        });
        assertOk(finished, '세대 닫기');
        assertEqual(finished.current, true, '포인터가 이 세대를 가리킨다');

        const masked = await store.redactFile({
          fileId: rows.shared.fileId, plan: planWith(ids, at(10)),
        });
        assertOk(masked, '가리기');
        assertEqual(masked.fileId, rows.shared.fileId, '가린 파일');
        assertEqual(masked.contentHash, rows.shared.contentHash, '가린 내용');
        assertEqual(masked.messages, 2, '공유 메시지 수');
        assertEqual(masked.alreadyRedacted, false, '첫 가리기');
        assertEqual(masked.extractionsRemoved, 1, '지운 세대');
        assertEqual(masked.chunksRemoved, 1, '지운 조각');
        assertEqual(masked.namesRemoved, sharedNames.length, '지운 이름');
        assertEqual(masked.blobDeletesQueued, 1, '넣은 블롭 일감');

        assertEqual(await store.listExtractions(rows.shared.fileId), { ok: true, extractions: [] }, '세대 없음');
        assertEqual(await store.listExtractionChunks(begun.extraction.id), { ok: true, chunks: [] }, '조각 없음');
        assertEqual(await store.listFileNames(rows.shared.fileId), { ok: true, names: [] }, '이름 없음');
        const state = await store.readFileExtractionState(rows.shared.fileId);
        assertOk(state, '가린 뒤 상태');
        assertEqual(state.redactedAt, at(10), '가린 시각');
        assertEqual(state.currentExtractionId, null, '포인터 비었음');
        assertEqual(state.openExtraction, null, '열린 세대 없음');

        // The places are records of where the bytes were, and a masking deletes
        // none of them: only Brain's own copy is queued to be emptied.
        const places = await store.listFileLocations(rows.shared.fileId);
        assertOk(places, '위치 목록');
        assertEqual(places.locations.map((row) => row.id).sort(),
          [rows.shared.brainLocationId, rows.shared.externalLocationId].sort(), '위치 행 그대로');
        assertEqual(places.locations.map((row) => row.deletedAt), [null, null], '아직 안 지움');
        assertEqual(await blobDeleteTargets(store), [rows.shared.brainLocationId], 'Brain 위치만');

        // Nothing derived comes back: the name index refuses and the queueing
        // reads leave the file out.
        assertEqual(await store.writeFileNames({ names: sharedNames }), { ok: true, inserted: 0 }, '이름은 다시 안 생긴다');
        assertEqual(await store.listFileNames(rows.shared.fileId), { ok: true, names: [] }, '여전히 이름 없음');
        const awaiting = await store.listFilesAwaitingExtraction({ limit: 500 });
        assertOk(awaiting, '추출 대기 목록');
        assertTrue(!awaiting.fileIds.includes(rows.shared.fileId), '가린 파일은 대기하지 않는다');
        assertTrue(awaiting.fileIds.includes(rows.other.fileId), '다른 파일은 그대로 대기한다');
        const stale = await store.listFilesWithStaleExtraction({ extractorVersion: 'text-2', limit: 500 });
        assertOk(stale, '뒤처진 목록');
        assertTrue(!stale.fileIds.includes(rows.shared.fileId), '가린 파일은 다시 읽지 않는다');

        // The second call is the repair path: nothing is taken away twice, and
        // the Brain copy that is still on the disk is asked for again.
        const again = await store.redactFile({
          fileId: rows.shared.fileId, plan: planWith(ids, at(20)),
        });
        assertOk(again, '다시 가리기');
        assertEqual(again.alreadyRedacted, true, '이미 가림');
        assertEqual(
          [again.extractionsRemoved, again.chunksRemoved, again.namesRemoved,
            again.metadataRemoved, again.failuresResolved],
          [0, 0, 0, 0, 0],
          '두 번째는 아무것도 지우지 않는다',
        );
        assertEqual(again.blobDeletesQueued, 1, '남은 Brain 사본만 일감');
        const unchanged = await store.readFileExtractionState(rows.shared.fileId);
        assertOk(unchanged, '두 번째 뒤 상태');
        assertEqual(unchanged.redactedAt, at(10), '가린 시각은 첫 값');

        // Once the bytes really are gone there is nothing left to ask for.
        assertOk(
          await store.markFileLocationDeleted({ id: rows.shared.brainLocationId, deletedAt: at(30) }),
          '블롭 삭제 표시',
        );
        const third = await store.redactFile({
          fileId: rows.shared.fileId, plan: planWith(ids, at(40)),
        });
        assertOk(third, '세 번째 가리기');
        assertEqual(third.blobDeletesQueued, 0, '지운 위치는 일감이 아니다');

        const absent = await store.redactFile({
          fileId: '01940000-0000-7000-8000-0000000000ff',
          plan: () => fail('없는 파일에 계획을 물어서는 안 됩니다'),
        });
        assertNotOk(absent, '없는 파일 가리기');
        assertEqual(absent.code, 'FILE_NOT_FOUND', '없는 파일의 코드');
      }),
    ),

    contractCase('진행 중인 세대는 조각만 잃고 그 일꾼이 스스로 redacted로 닫는다', async (make) =>
      withSubject(make, async (store) => {
        const ids = sequenceIdGen({ start: 6000, timestampMs: 1770000000000 });
        const rows = await attached(store, ids);
        const claim = await takeClaim(store, {
          fileId: rows.shared.fileId, workItemId: ids.next(), now: T0, claimedBy: 'drain-a',
        });
        const begun = await store.beginExtraction({
          id: ids.next(), fileId: rows.shared.fileId, extractorVersion: 'text-1',
          startedAt: at(1), claim,
        });
        assertOk(begun, '세대 열기');
        assertOk(
          await store.appendExtractionChunks({
            extractionId: begun.extraction.id,
            chunks: [{ id: ids.next(), ordinal: 0, body: '진행 중 조각', page: null,
              chunkLocator: { type: 'text', start: 0, end: 6 } }],
          }),
          '조각 쓰기',
        );

        const masked = await store.redactFile({
          fileId: rows.shared.fileId, plan: planWith(ids, at(10)),
        });
        assertOk(masked, '가리기');
        assertEqual(masked.chunksRemoved, 1, '열린 세대의 조각도 지운다');
        assertEqual(masked.extractionsRemoved, 0, '열린 세대의 행은 남는다');

        // The row is still there, which is what lets the worker's own two calls
        // close it the way the port says (port contract).
        const open = await store.listExtractions(rows.shared.fileId);
        assertOk(open, '세대 목록');
        assertEqual(open.extractions.map((row) => row.id), [begun.extraction.id], '열린 세대 하나');
        assertEqual(open.extractions[0]?.finishedAt, null, '아직 열려 있다');
        assertEqual(await store.listExtractionChunks(begun.extraction.id), { ok: true, chunks: [] }, '조각 없음');

        const appended = await store.appendExtractionChunks({
          extractionId: begun.extraction.id,
          chunks: [{ id: ids.next(), ordinal: 1, body: '늦은 조각', page: null,
            chunkLocator: { type: 'text', start: 100, end: 103 } }],
        });
        assertNotOk(appended, '가린 파일에 조각 쓰기');
        assertEqual(appended.code, 'FILE_REDACTED', '조각 거부 코드');

        const finished = await store.finishExtraction({
          extractionId: begun.extraction.id, finishedAt: at(20),
          outcome: { status: 'ok', mediaType: 'text/plain', indexConfigId: DOCUMENT_CHUNK_INDEX_CONFIG_ID },
        });
        assertOk(finished, '세대 닫기');
        assertEqual(finished.extraction.status, 'redacted', '가린 파일의 성공은 redacted');
        assertEqual(finished.current, false, '포인터는 움직이지 않는다');
        assertEqual(await store.listExtractionChunks(begun.extraction.id), { ok: true, chunks: [] }, '닫은 뒤에도 조각 없음');
        const state = await store.readFileExtractionState(rows.shared.fileId);
        assertOk(state, '닫은 뒤 상태');
        assertEqual(state.currentExtractionId, null, '포인터 비었음');

        // And no new generation is ever opened for it, whatever the claim says:
        // the file is checked before the claim is.
        const reopened = await store.beginExtraction({
          id: ids.next(), fileId: rows.shared.fileId, extractorVersion: 'text-1',
          startedAt: at(30), claim,
        });
        assertNotOk(reopened, '가린 파일 다시 열기');
        assertEqual(reopened.code, 'FILE_REDACTED', '다시 열기 거부 코드');
      }),
    ),

    contractCase('메시지 가리기는 가리지 않은 첨부를 세고 파일을 가리면 0이 된다', async (make) =>
      withSubject(make, async (store) => {
        const ids = sequenceIdGen({ start: 7000, timestampMs: 1770000000000 });
        const rows = await attached(store, ids);
        const first = rows.messageIds[0];
        const second = rows.messageIds[1];
        if (first === undefined || second === undefined) fail('메시지가 둘 필요합니다');

        // Three stored attachment rows — the shared file twice and the other
        // once — and one that was already missing. The missing one is never
        // counted, because there is nothing left to mask; the repeated one is,
        // because this count is of attachment rows that still carry content.
        const before = await store.redactMessage({ messageId: first, plan: NO_SPANS });
        assertOk(before, '메시지 가리기');
        assertEqual(before.unredactedAttachments, 3, '가리지 않은 첨부');
        const sibling = await store.redactMessage({ messageId: second, plan: NO_SPANS });
        assertOk(sibling, '다른 메시지 가리기');
        assertEqual(sibling.unredactedAttachments, 1, '공유 첨부 하나');

        assertOk(
          await store.redactFile({ fileId: rows.shared.fileId, plan: planWith(ids, at(10)) }),
          '공유 파일 가리기',
        );
        const afterShared = await store.redactMessage({ messageId: first, plan: NO_SPANS });
        assertOk(afterShared, '공유 파일 가린 뒤');
        assertEqual(afterShared.unredactedAttachments, 1, '남은 첨부 하나');
        const afterSibling = await store.redactMessage({ messageId: second, plan: NO_SPANS });
        assertOk(afterSibling, '다른 메시지 다시');
        assertEqual(afterSibling.unredactedAttachments, 0, '공유만 있던 메시지는 0');

        assertOk(
          await store.redactFile({ fileId: rows.other.fileId, plan: planWith(ids, at(20)) }),
          '다른 파일 가리기',
        );
        const done = await store.redactMessage({ messageId: first, plan: NO_SPANS });
        assertOk(done, '둘 다 가린 뒤');
        assertEqual(done.unredactedAttachments, 0, '경고할 첨부 없음');
      }),
    ),
  ];
}
