import type { FileLocation } from '../domain/file.js';
/** 발신 요청의 저장 계약이다. 비밀 token은 저장하지 않는다. */
export interface Channel { id: string; kind: string; botRef: string }
export interface ChannelConversation { id: string; userId: string; channelId: string; externalRef: string; threadRef: string | null }
export interface ChannelFile { location: FileLocation; filename: string }
export type ChannelBundleItem = { itemId: string } & (
  { type: 'text'; text: string } | { type: 'album'; photos: ChannelFile[]; caption?: string } | { type: 'document'; document: ChannelFile });
export type ChannelBundle = { summary: string; albums: { photos: ChannelFile[]; caption?: string }[]; document: ChannelFile; version?: 1 }
  | { version: 2; items: ChannelBundleItem[] };
/** v1의 예약 순번을 그대로 보존한다. */
export function channelBundleItems(bundle: ChannelBundle): ChannelBundleItem[] {
  if (bundle.version === 2) return bundle.items;
  return [{ itemId: 'summary', type: 'text', text: bundle.summary },
    ...bundle.albums.map((album, index) => ({ itemId: `album:${index}`, type: 'album' as const, ...album })),
    { itemId: 'document', type: 'document', document: bundle.document }];
}
export interface ChannelItemResult { index: number; result: ChannelAttemptResult }
export interface ChannelRequest { id: string; conversationId: string; producer: string; producerResultId: string; purpose: string; revision: string | null; text: string; bundle?: ChannelBundle; createdAt: Date; workItemId: string | null; status: 'pending' | 'sent'; externalMessageId: string | null }
export type ChannelFailure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export type ChannelAttemptResult = { outcome: 'sent'; externalMessageId: string | null; externalMessageIds?: string[] } | { outcome: 'definite_failed' | 'unknown'; code: string; retryable: boolean; retryAfterMs?: number };
export type ChannelLegacyInput = {
  id: string; conversationId: string; source: string; dataset: string; originalTable: string; originalKey: string; importBatch: string;
  localDate: string; at: Date;
} & ({ type: 'notification'; event: string; detail: string } | { type: 'delivery'; originalId: string; kind: string; event: string | null; ok: boolean; reason: string | null });
export type LegacyOriginalText = string | { type: 'invalid-text'; encoding: string; base64: string };
export type ChannelLegacyRecord = Omit<ChannelLegacyInput, 'localDate' | 'event' | 'detail' | 'originalId' | 'kind' | 'reason' | 'type'> & {
  localDate: LegacyOriginalText; externalMessageId: null; body: null; metadataMissing: true; resendEligible: false;
} & ({ type: 'notification'; event: LegacyOriginalText; detail: LegacyOriginalText } | { type: 'delivery'; originalId: LegacyOriginalText; kind: LegacyOriginalText; event: LegacyOriginalText | null; ok: boolean; reason: LegacyOriginalText | null });
export type ChannelResendCode = 'CHANNEL_REQUEST_NOT_FOUND' | 'CHANNEL_ALREADY_SENT' | 'CHANNEL_LEGACY_NOT_RESENDABLE' | 'CHANNEL_REQUEST_IN_PROGRESS' | 'CHANNEL_NOT_RESENDABLE';
export interface ChannelPublicStatus {
  messengerId?: string | null; channelId?: string | null; topic?: string | null;
  id: string; legacy: boolean; createdAt: Date; delivery: 'unrouted' | 'scheduled' | 'pending' | 'sent' | 'definite_failed' | 'unknown' | 'legacy';
  workState: 'unhanded' | 'waiting' | 'running' | 'closed' | 'legacy'; attempts: number; nextAttemptAt: Date | null;
  unresolvedFailures: number; resendEligible: boolean;
}
export interface ChannelStore {
  channelControl?: import('./control.js').ChannelControlStore;
  listChannelStatuses(): Promise<{ ok: true; requests: ChannelPublicStatus[] } | ChannelFailure>;
  readChannelStatus(id: string): Promise<{ ok: true; request: ChannelPublicStatus | null } | ChannelFailure>;
  resendChannelRequest(input: { requestId: string; workId: string; now: Date }): Promise<{ ok: true; workItemId: string } | ChannelFailure | { ok: false; code: ChannelResendCode; message: string }>;

  insertChannelLegacy(input: ChannelLegacyInput): Promise<{ ok: true; created: boolean; record: ChannelLegacyRecord } | ChannelFailure | { ok: false; code: 'LEGACY_CONFLICT'; message: string }>;
  readChannelLegacy(input: { type: ChannelLegacyInput['type']; dataset: string; originalTable: string; originalKey: string }): Promise<{ ok: true; record: ChannelLegacyRecord | null } | ChannelFailure>;
  ensureChannel(input: Channel): Promise<{ ok: true; channel: Channel } | ChannelFailure>;
  ensureChannelConversation(input: ChannelConversation): Promise<{ ok: true; conversation: ChannelConversation } | ChannelFailure>;
  createChannelRequest(input: Omit<ChannelRequest, 'workItemId' | 'status' | 'externalMessageId'>): Promise<{ ok: true; created: boolean; request: ChannelRequest } | ChannelFailure>;
  readChannelRequest(id: string): Promise<{ ok: true; request: ChannelRequest | null; channel: Channel | null; conversation: ChannelConversation | null } | ChannelFailure>;
  listChannelItemResults(requestId: string): Promise<{ ok: true; items: ChannelItemResult[] } | ChannelFailure>;
  recordChannelItemResult(input: { requestId: string; workItemId: string; attemptToken: string; index: number; result: ChannelAttemptResult; now: Date }): Promise<{ ok: true; outcome: 'done' | 'lost' } | ChannelFailure>;
  handoffChannelRequest(input: { requestId: string; workId: string; now: Date }): Promise<{ ok: true; workItemId: string | null } | ChannelFailure>;
  listUnhandedChannelRequests(now?: Date): Promise<{ ok: true; requestIds: string[] } | ChannelFailure>;
  gateChannelAttempt(input: { requestId: string; workItemId: string; attemptToken: string; now: Date }): Promise<{ ok: true; outcome: 'won' | 'already' | 'sent' | 'lost' } | ChannelFailure>;
  finishChannelAttempt(input: { requestId: string; workItemId: string; attemptToken: string; now: Date } & ({ result: ChannelAttemptResult } | { externalMessageId: string | null })): Promise<{ ok: true; outcome: 'done' | 'lost' } | ChannelFailure>;
  recoverChannelAttempt(input: { requestId: string; workItemId: string; attemptToken: string; now: Date }): Promise<{ ok: true; outcome: 'lost' } | { ok: true; outcome: 'ready'; result: ChannelAttemptResult | null } | ChannelFailure>;
}
export const CHANNEL_SEND_KIND = 'channel_send';
export const CHANNEL_REQUEST_TARGET = 'channel_request';
