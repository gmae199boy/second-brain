import type { ChunkParams } from '../domain/index-config.js';
import type { ConversationChunk, ConversationMessage } from '../recall/conversation-chunker.js';

type Failure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export interface ConversationSnapshot { config: ChunkParams; messages: ConversationMessage[]; fingerprint: string }
export interface ConversationIndexStore {
  readConversationSnapshot(sessionId: string): Promise<{ ok: true; snapshot: ConversationSnapshot | null } | Failure>;
  commitConversationChunks(input: { sessionId: string; workId: string; claimedBy: string; now: Date; fingerprint: string; chunks: (ConversationChunk & { id: string })[] }): Promise<{ ok: true; committed: boolean } | Failure>;
  searchConversationChunks(input: { pattern: string }): Promise<{ ok: true; chunks: (ConversationChunk & { id: string; sessionId: string })[] } | Failure>;
}
