import { expect, it } from 'vitest';
import { conversationChunkHandler, literalLikePattern } from '../src/index.js';
import { memoryStore, sampleSelfUserInput, sampleEnsureSessionInput, sampleIngestBatch, sequenceIdGen } from '../src/testing/index.js';

it('fake가 NUL 검색어를 검색 투영으로 바꾸고 논리 원문을 반환한다', async () => {
  const store = memoryStore(); const batch = sampleIngestBatch(); batch.messages[0]!.body = '앞\0뒤'; batch.messages = [batch.messages[0]!]; batch.toolNotes = []; batch.attachments = [];
  await store.ensureSelfUser(sampleSelfUserInput()); await store.ensureSession(sampleEnsureSessionInput()); await store.ingest(batch);
  const clock = { now: () => batch.tracking.ingestedAt }; const idGen = sequenceIdGen({ timestampMs: clock.now().getTime(), start: 500 });
  const claim = await store.claimWork({ now: clock.now(), claimedBy: 'fake', kinds: ['conversation_chunk'] });
  if (!claim.ok || !claim.item) throw new Error('청구 실패');
  expect(await conversationChunkHandler({ store, clock, idGen })(claim.item)).toEqual({ ok: true });
  const found = await store.searchConversationChunks({ pattern: literalLikePattern('앞\0뒤') });
  expect(found.ok && found.chunks.map(c => c.body)).toEqual(['앞\0뒤']);
});
