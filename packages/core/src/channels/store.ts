/** 발신 요청의 저장 계약이다. 비밀 token은 저장하지 않는다. */
export interface Channel { id: string; kind: string; botRef: string }
export interface ChannelConversation { id: string; channelId: string; externalRef: string; threadRef: string | null }
export interface ChannelRequest { id: string; conversationId: string; producer: string; producerResultId: string; purpose: string; revision: string | null; text: string; createdAt: Date; workItemId: string | null; status: 'pending' | 'sent'; externalMessageId: string | null }
export type ChannelFailure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export type ChannelAttemptResult = { outcome: 'sent'; externalMessageId: string | null } | { outcome: 'definite_failed' | 'unknown'; code: string; retryable: boolean; retryAfterMs?: number };
export interface ChannelStore {
  ensureChannel(input: Channel): Promise<{ ok: true; channel: Channel } | ChannelFailure>;
  ensureChannelConversation(input: ChannelConversation): Promise<{ ok: true; conversation: ChannelConversation } | ChannelFailure>;
  createChannelRequest(input: Omit<ChannelRequest, 'workItemId' | 'status' | 'externalMessageId'>): Promise<{ ok: true; created: boolean; request: ChannelRequest } | ChannelFailure>;
  readChannelRequest(id: string): Promise<{ ok: true; request: ChannelRequest | null; channel: Channel | null; conversation: ChannelConversation | null } | ChannelFailure>;
  handoffChannelRequest(input: { requestId: string; workId: string; now: Date }): Promise<{ ok: true; workItemId: string | null } | ChannelFailure>;
  listUnhandedChannelRequests(): Promise<{ ok: true; requestIds: string[] } | ChannelFailure>;
  gateChannelAttempt(input: { requestId: string; workItemId: string; attemptToken: string; now: Date }): Promise<{ ok: true; outcome: 'won' | 'already' | 'sent' | 'lost' } | ChannelFailure>;
  finishChannelAttempt(input: { requestId: string; workItemId: string; attemptToken: string; now: Date } & ({ result: ChannelAttemptResult } | { externalMessageId: string | null })): Promise<{ ok: true; outcome: 'done' | 'lost' } | ChannelFailure>;
  recoverChannelAttempt(input: { requestId: string; workItemId: string; attemptToken: string; now: Date }): Promise<{ ok: true; outcome: 'lost' } | { ok: true; outcome: 'ready'; result: ChannelAttemptResult | null } | ChannelFailure>;
}
export const CHANNEL_SEND_KIND = 'channel_send';
export const CHANNEL_REQUEST_TARGET = 'channel_request';
