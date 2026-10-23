import type { IngestAttachment } from '../../domain/ingest-batch.js';
import { brainLocator, contentHashOfBytes } from '../../domain/file.js';
import type { AttachmentStore, SessionStore, UserStore } from '../../ports/store.js';
import { assertEqual, assertOk, assertTrue } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput, sampleSessionKey } from '../fixtures.js';
import { sequenceIdGen } from '../fakes/id-gen.js';
export type AttachmentStoreSubject = AttachmentStore & SessionStore & UserStore;
export function attachmentStoreContract(): ContractCase<AttachmentStoreSubject>[] {
  return [contractCase('첨부 연결은 기존 메시지에도 붙고 내용과 자리는 중복되지 않는다', async make => withSubject(make, async store => {
    assertOk(await store.ensureSelfUser(sampleSelfUserInput()), '주인');
    assertOk(await store.ensureSession(sampleEnsureSessionInput()), '세션');
    const batch = sampleIngestBatch();
    const ids = sequenceIdGen({ start: 1000, timestampMs: 1760000000000 });
    const bytes = Uint8Array.of(1,2,3);
    const hash = contentHashOfBytes(bytes);
    const attachments: IngestAttachment[] = batch.messages.slice(0,2).map(m => ({
      id: ids.next(), harnessMessageId: m.harnessMessageId, ordinal: 0, sourceKind: 'image', sourceRef: '1', displayName: null,
      file: { id: ids.next(), contentHash: hash, sizeBytes: bytes.length, location: { id: ids.next(), storeKind: 'local', ownership: 'brain', locator: brainLocator(hash.slice(7), bytes) } },
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
    const collision = { ...attachments[0]!, sourceRef: 'changed', file: { ...attachments[0]!.file, contentHash: contentHashOfBytes(Uint8Array.of(4)) } };
    assertEqual(await store.linkAttachments({ ...input, attachments: [collision] }), { ok: true, linked: 0 }, '기존 자리 보존');
    const original = await store.listMessageAttachments(batch.messages[0]!.id);
    assertOk(original, '원래 자리'); assertEqual(original.attachments[0]?.sourceRef, '1', '출처 불변');
  })), contractCase('빠진 메시지가 하나라도 있으면 연결을 전혀 쓰지 않는다', async make => withSubject(make, async store => {
    const batch = sampleIngestBatch();
    const ids = sequenceIdGen({ start: 1000, timestampMs: 1760000000000 });
    const hash = contentHashOfBytes(Uint8Array.of(1));
    const a: IngestAttachment = { id: ids.next(), harnessMessageId: batch.messages[0]!.harnessMessageId, ordinal: 0, sourceKind: 'image', sourceRef: null, displayName: null, file: { id: ids.next(), contentHash: hash, sizeBytes: 1, location: { id: ids.next(), storeKind: 'local', ownership: 'brain', locator: brainLocator(hash.slice(7), Uint8Array.of(1)) } } };
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
  }))];
}
