import { expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { memoryStore, memorySchemaStore, memorySpool, memoryFileStore, memoryRepositories, memoryTranscriptReader, sequenceIdGen, manualTime } from '../src/testing/index.js';
it('SDK 공개 상태는 민감한 발신 데이터를 내보내지 않고 UUID를 검사한다', async () => {
  const store = memoryStore(); const time = manualTime(new Date('2026-10-31T00:00:00Z')); const ids = sequenceIdGen({ timestampMs: time.clock.now().getTime() });
  const brain = createBrain({ store: { ...store, ...memorySchemaStore({ version: 1 }) }, schemaVersions: { core: 1 }, clock: time.clock, idGen: ids, spool: memorySpool(), files: memoryFileStore(), parsers: [], transcripts: memoryTranscriptReader(), repositories: memoryRepositories(), machine: 'test' });
  const channel = ids.next(), conversation = ids.next(), id = ids.next();
  await store.ensureChannel({ id: channel, kind: 'telegram', botRef: 'secret-bot' });
  await store.ensureChannelConversation({ id: conversation, channelId: channel, externalRef: 'secret-chat', threadRef: 'secret-thread' });
  await store.createChannelRequest({ id, conversationId: conversation, producer: 'secret-producer', producerResultId: 'secret-source', purpose: 'secret-purpose', revision: null, text: 'secret-body', createdAt: time.clock.now() });
  for (const result of [await brain.channels.list(), await brain.channels.status({ id })]) expect(JSON.stringify(result)).not.toContain('secret');
  expect(await brain.channels.status({ id: 'bad' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
  expect(await brain.channels.resend({ id: 'bad' })).toMatchObject({ ok: false, code: 'INVALID_ARGUMENT' });
});
