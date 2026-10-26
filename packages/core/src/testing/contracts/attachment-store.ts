import type { IngestAttachment } from '../../domain/ingest-batch.js';
import { brainLocator, contentHashOfBytes } from '../../domain/file.js';
import type { AttachmentStore, SessionStore, UserStore } from '../../ports/store.js';
import { assertEqual, assertNotOk, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput, sampleSessionKey } from '../fixtures.js';
import { sequenceIdGen } from '../fakes/id-gen.js';
export type AttachmentStoreSubject = AttachmentStore & SessionStore & UserStore;
export function attachmentStoreContract(): ContractCase<AttachmentStoreSubject>[] {
  return [contractCase('빠진 원본과 external 위치와 파생 이름은 멱등으로 보존한다', async make => withSubject(make, async store => {
    const batch = sampleIngestBatch();
    const ids = sequenceIdGen({ start: 2000, timestampMs: 1760000000000 });
    assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
    assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
    const bytes = Uint8Array.of(1, 2, 3);
    const hash = contentHashOfBytes(bytes);
    const base = { harnessMessageId: batch.messages[0]!.harnessMessageId, sourceKind: 'file', sourceRef: 'attachment-row', displayName: 'note.md' };
    const attachments: IngestAttachment[] = [
      { ...base, id: ids.next(), ordinal: 0, file: null },
      { ...base, id: ids.next(), ordinal: 1, file: { id: ids.next(), contentHash: hash, sizeBytes: 3,
        location: { id: ids.next(), storeKind: 'local', ownership: 'brain', locator: brainLocator(hash.slice(7), bytes) },
        external: { id: ids.next(), storeKind: 'local', ownership: 'external', locator: '~/project/note.md' } } },
    ];
    assertOk(await store.ingest({ ...batch, attachments }), '수집');
    const rows = await store.listMessageAttachments(batch.messages[0]!.id);
    assertOk(rows, '읽기');
    assertEqual(rows.attachments[0]?.status, 'missing_at_ingest', '빠진 원본');
    assertEqual(rows.attachments[0]?.file, null, '파일 행 없음');
    const file = rows.attachments[1]?.file;
    assertTrue(file !== null && file !== undefined, '저장한 원본');
    if (file === null || file === undefined) return;
    assertEqual(file.locations.map(l => l.ownership), ['brain', 'external'], '위치 순서');
    assertEqual(file.home?.ownership, 'brain', '원본은 home이 아님');
    const candidates = await store.listMissingFileNames({ limit: 500 });
    assertOk(candidates, '이름 후보');
    assertEqual(candidates.names.length, 2, '이름과 원래 경로');
    const names = candidates.names.map(n => ({ ...n, id: ids.next() }));
    assertEqual(await store.writeFileNames({ names }), { ok: true, inserted: 2 }, '이름 쓰기');
    assertEqual(await store.writeFileNames({ names }), { ok: true, inserted: 0 }, '이름 멱등');
    assertEqual(await store.listMissingFileNames({ limit: 500 }), { ok: true, names: [] }, '남은 이름 없음');
    const read = await store.listFileNames(file.id);
    assertOk(read, '이름 읽기');
    assertEqual(read.names.length, 2, '이름 행');
    assertEqual(await store.linkAttachments({ key: sampleSessionKey, attachments: [{ ...attachments[1]!, ordinal: 0 }], linkedAt: batch.tracking.ingestedAt }), { ok: true, linked: 0 }, '빠진 원본 상태 불변');
  })), contractCase('첨부 연결은 기존 메시지에도 붙고 내용과 자리는 중복되지 않는다', async make => withSubject(make, async store => {
    assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
    assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
    const batch = sampleIngestBatch();
    const ids = sequenceIdGen({ start: 1000, timestampMs: 1760000000000 });
    const bytes = Uint8Array.of(1,2,3);
    const hash = contentHashOfBytes(bytes);
    const attachments: IngestAttachment[] = batch.messages.slice(0,2).map(m => ({
      id: ids.next(), harnessMessageId: m.harnessMessageId, ordinal: 0, sourceKind: 'image', sourceRef: '1', displayName: null,
      file: { external: null, id: ids.next(), contentHash: hash, sizeBytes: bytes.length, location: { id: ids.next(), storeKind: 'local', ownership: 'brain', locator: brainLocator(hash.slice(7), bytes) } },
    }));
    assertOk(await store.ingest(batch), '메시지 먼저');
    const extra = { ...attachments[0]!, id: ids.next(), ordinal: 2 };
    assertOk(await store.linkAttachments({ key: sampleSessionKey, attachments: [extra], linkedAt: batch.tracking.ingestedAt }), '뒷자리 먼저');
    const input = { key: sampleSessionKey, attachments, linkedAt: batch.tracking.ingestedAt };
    assertEqual(await store.linkAttachments(input), { ok: true, linked: 2 }, '기존 메시지 연결');
    assertEqual(await store.linkAttachments(input), { ok: true, linked: 0 }, '재연결');
    assertOk(await store.ingest({ ...batch, attachments }), '첨부 포함 재수집');
    const rows = await Promise.all(batch.messages.slice(0,2).map(m => store.listMessageAttachments(m.id)));
    for (const row of rows) {
      assertOk(row, '첨부 읽기');
      assertTrue(row.attachments.length >= 1, '첨부 자리');
      assertEqual(row.attachments[0]?.file?.contentHash, hash, '내용 해시');
      assertEqual(row.attachments[0]?.status, 'stored', '저장 상태');
    }
    const first = rows[0]!; const second = rows[1]!;
    assertOk(first, '첫 첨부'); assertOk(second, '둘째 첨부');
    assertEqual(first.attachments.map(a => a.ordinal), [0,2], '자리 순서');
    assertEqual(first.attachments[0]?.file?.id, second.attachments[0]?.file?.id, '동일 파일 행');
    const collision = { ...attachments[0]!, sourceRef: 'changed', file: { ...attachments[0]!.file!, contentHash: contentHashOfBytes(Uint8Array.of(4)) } };
    assertEqual(await store.linkAttachments({ ...input, attachments: [collision] }), { ok: true, linked: 0 }, '기존 자리 보존');
    const original = await store.listMessageAttachments(batch.messages[0]!.id);
    assertOk(original, '원래 자리'); assertEqual(original.attachments[0]?.sourceRef, '1', '출처 불변');
  })), contractCase('빠진 메시지가 하나라도 있으면 연결을 전혀 쓰지 않는다', async make => withSubject(make, async store => {
    const batch = sampleIngestBatch();
    const ids = sequenceIdGen({ start: 1000, timestampMs: 1760000000000 });
    const hash = contentHashOfBytes(Uint8Array.of(1));
    const a: IngestAttachment = { id: ids.next(), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: 0, sourceKind: 'image', sourceRef: null, displayName: null, file: { external: null, id: ids.next(), contentHash: hash, sizeBytes: 1, location: { id: ids.next(), storeKind: 'local', ownership: 'brain', locator: brainLocator(hash.slice(7), Uint8Array.of(1)) } } };
    const input = { key: sampleSessionKey, attachments: [a], linkedAt: batch.tracking.ingestedAt };
    const absent = await store.linkAttachments(input);
    assertTrue(!absent.ok && absent.code === 'SESSION_NOT_FOUND', '없는 세션');
    assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
    assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
    assertOk(await store.ingest(batch), '메시지');
    const result = await store.linkAttachments({ ...input, attachments: [a, { ...a, id: ids.next(), harnessMessageId: 'missing' }] });
    assertTrue(!result.ok && result.code === 'MESSAGE_NOT_FOUND', '없는 메시지');
    assertEqual(await store.listMessageAttachments(batch.messages[0]!.id), { ok: true, attachments: [] }, '부분 쓰기 없음');
    assertOk(await store.ingest({ ...batch, attachments: [a] }), '메시지와 같은 트랜잭션');
    const linked = await store.listMessageAttachments(batch.messages[0]!.id); assertOk(linked, '읽기');
    assertEqual(linked.attachments.length, 1, '첨부 저장');
  })), contractCase('위치 행은 id로 읽히고 삭제 표시는 한 번만 채워진다', async make => withSubject(make, async store => {
    const batch = sampleIngestBatch();
    const ids = sequenceIdGen({ start: 3000, timestampMs: 1760000000000 });
    assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
    assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
    const bytes = Uint8Array.of(7, 8, 9);
    const hash = contentHashOfBytes(bytes);
    const brainId = ids.next();
    const externalId = ids.next();
    const upperId = ids.next();
    const fileId = ids.next();
    const file = { id: fileId, contentHash: hash, sizeBytes: bytes.length };
    const brain = { id: brainId, storeKind: 'local' as const, ownership: 'brain' as const, locator: brainLocator(hash.slice(7), bytes) };
    const base = { harnessMessageId: batch.messages[0]!.harnessMessageId, sourceKind: 'file', sourceRef: 'location-row', displayName: 'note.md' };
    // Two originals of the same content, under names that differ only in case:
    // `order by locator` is BINARY on a `text` column, so `~/Project/b` comes
    // before `~/project/a` and a locale-aware sort would answer the other way.
    const attachments: IngestAttachment[] = [
      { ...base, id: ids.next(), ordinal: 0,
        file: { ...file, location: brain, external: { id: externalId, storeKind: 'local', ownership: 'external', locator: '~/project/a' } } },
      { ...base, id: ids.next(), ordinal: 1,
        file: { ...file, location: brain, external: { id: upperId, storeKind: 'local', ownership: 'external', locator: '~/Project/b' } } },
    ];
    assertOk(await store.ingest({ ...batch, attachments }), '수집');

    // The ids the ingest was given, in `ownership` then `locator` order: Brain's
    // own copy first, which is the only one a deletion may ever touch.
    const listed = await store.listFileLocations(fileId);
    assertOk(listed, '위치 목록');
    assertEqual(listed.locations.map(l => l.id), [brainId, upperId, externalId], '위치 id와 순서');
    assertEqual(listed.locations.map(l => l.ownership), ['brain', 'external', 'external'], '소유');
    assertEqual(listed.locations.slice(1).map(l => l.locator), ['~/Project/b', '~/project/a'], '대소문자 섞인 순서');
    assertEqual(listed.locations.map(l => l.deletedAt), [null, null, null], '아직 안 지움');
    assertEqual(listed.locations.map(l => l.fileId), [fileId, fileId, fileId], '같은 파일');
    assertEqual(await store.listFileLocations('no-such-file'), { ok: true, locations: [] }, '없는 파일은 빈 목록');

    const read = await store.readFileLocation(brainId);
    assertOk(read, '위치 읽기');
    assertEqual(read.location, listed.locations[0], '목록과 같은 행');

    const first = new Date('2026-03-04T05:06:07.000Z');
    assertEqual(await store.markFileLocationDeleted({ id: brainId, deletedAt: first }), { ok: true, deletedAt: first, marked: true }, '첫 표시');
    // The one-way fill of 0002: a second call is an ordinary answer and leaves
    // the first instant exactly where it was.
    assertEqual(await store.markFileLocationDeleted({ id: brainId, deletedAt: new Date('2026-03-05T05:06:07.000Z') }), { ok: true, deletedAt: first, marked: false }, '두 번째 표시');
    const again = await store.readFileLocation(brainId);
    assertOk(again, '표시 뒤 읽기');
    assertEqual(again.location.deletedAt, first, '첫 값 유지');
    const sibling = await store.readFileLocation(externalId);
    assertOk(sibling, '다른 위치 읽기');
    assertEqual(sibling.location.deletedAt, null, '옆 위치는 그대로');

    // Rows of `file_locations` are never deleted, so an id nothing answers to
    // was never a place: both verbs say so rather than inventing one.
    const absent = await store.readFileLocation('no-such-location');
    assertNotOk(absent, '없는 위치 읽기');
    assertEqual(absent.code, 'FILE_LOCATION_NOT_FOUND', '읽기 코드');
    const marked = await store.markFileLocationDeleted({ id: 'no-such-location', deletedAt: first });
    assertNotOk(marked, '없는 위치 표시');
    assertEqual(marked.code, 'FILE_LOCATION_NOT_FOUND', '표시 코드');
  }))];
}
