import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ConversationIndexStore } from '../ports/conversation-index-store.js';
import type { WorkHandler } from '../queue/drain.js';
import { chunkConversation } from './conversation-chunker.js';

export const CONVERSATION_CHUNK_KIND = 'conversation_chunk';
export function conversationChunkHandler(deps: { store: ConversationIndexStore; clock: Clock; idGen: IdGen }): WorkHandler {
  return async item => {
    const read = await deps.store.readConversationSnapshot(item.targetId);
    if (!read.ok) return read;
    if (!read.snapshot) return { ok: true };
    const chunks = chunkConversation(read.snapshot.messages, read.snapshot.config).map(chunk => ({ ...chunk, id: deps.idGen.next() }));
    const result = await deps.store.commitConversationChunks({ sessionId: item.targetId, workId: item.id, claimedBy: item.claimedBy!, now: deps.clock.now(), fingerprint: read.snapshot.fingerprint, chunks });
    if (!result.ok) return result;
    return result.committed ? { ok: true } : { ok: false, code: 'CONVERSATION_STALE', message: '대화 입력이나 일감 청구가 바뀌었습니다', retryable: true };
  };
}
