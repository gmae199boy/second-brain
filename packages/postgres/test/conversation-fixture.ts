import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memorySpool, sampleEnsureSessionInput, sampleIngestBatch, sampleSelfUserInput, sequenceIdGen } from '@second-brain/core/testing';
import { conversationChunkHandler, CONVERSATION_CHUNK_KIND, drainQueue } from '@second-brain/core';
import { postgresStore } from '../src/index.js';
import { clock, database } from './fixture.js';

export async function conversationFixture(body: string) {
  const home = await mkdtemp(join(tmpdir(), 'brain-conversation-'));
  const db = await database().catch(async error => { await rm(home, { recursive: true, force: true }); throw error; });
  let store: ReturnType<typeof postgresStore> | undefined;
  try {
  store = postgresStore({ databaseUrl: db.appUrl });
  const activeStore = store;
  const ids = sequenceIdGen({ timestampMs: clock.now().getTime(), start: 500 });
  const user = await store.ensureSelfUser(sampleSelfUserInput()); if (!user.ok) throw new Error(user.message);
  const session = await store.ensureSession(sampleEnsureSessionInput()); if (!session.ok) throw new Error(session.message);
  const batch = sampleIngestBatch(); batch.messages[0]!.body = body; batch.messages = [batch.messages[0]!]; batch.toolNotes = [batch.toolNotes[0]!]; batch.toolNotes[0]!.harnessMessageId = batch.messages[0]!.harnessMessageId; batch.toolNotes[0]!.target = '합성 도구 메모'; batch.attachments = [];
  const ingest = await store.ingest(batch);
  if (!ingest.ok) throw new Error(ingest.message);
  const drain = () => drainQueue({ store: activeStore, clock, idGen: ids, spool: memorySpool() }, { budgetMs: 1000, handlers: { [CONVERSATION_CHUNK_KIND]: conversationChunkHandler({ store: activeStore, clock, idGen: ids }) } });
  return { db, store: activeStore, home, batch, ids, drain, sessionId: sampleEnsureSessionInput().id, async close() { try { await activeStore.close(); } finally { try { await db.drop(); } finally { await rm(home, { recursive: true, force: true }); } } } };
  } catch (error) { try { await store?.close(); } finally { try { await db.drop(); } finally { await rm(home, { recursive: true, force: true }); } } throw error; }
}
