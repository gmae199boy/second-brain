import type { ChannelStore } from './store.js';
import { maskOutputText } from '../output/mask.js';

/** 전송 어댑터는 외부 응답에 있는 식별자만 돌려준다. */
export interface SendMessagePort {
  sendMessage(input: { chatId: string; threadId: string | null; text: string }): Promise<{ ok: true; messageId: string | null } | { ok: false }>;
}

/** gate를 확정한 뒤 네트워크를 호출하고 현재 시도의 결과를 저장한다. */
export async function sendChannelRequest(input: {
  store: ChannelStore;
  sender: SendMessagePort;
  requestId: string;
  workItemId: string;
  attemptToken: string;
  now: () => Date;
}): Promise<{ ok: true } | { ok: false; code: string }> {
  const read = await input.store.readChannelRequest(input.requestId);
  if (!read.ok || !read.request || !read.channel || !read.conversation) return { ok: false, code: 'CHANNEL_REQUEST_UNAVAILABLE' };
  const gate = await input.store.gateChannelAttempt({ ...input, now: input.now() });
  if (!gate.ok || gate.outcome !== 'won') return { ok: false, code: 'CHANNEL_GATE_REFUSED' };
  const sent = await input.sender.sendMessage({ chatId: read.conversation.externalRef, threadId: read.conversation.threadRef, text: encodeChannelText(read.request.text) });
  if (!sent.ok) return { ok: false, code: 'CHANNEL_SEND_FAILED' };
  const finished = await input.store.finishChannelAttempt({ ...input, now: input.now(), externalMessageId: sent.messageId });
  return finished.ok && finished.outcome === 'done' ? { ok: true } : { ok: false, code: 'CHANNEL_RESULT_REFUSED' };
}

/** 등록된 채널 출력 경계에서 원문을 가린다. */
export function encodeChannelText(text: string): string { return maskOutputText(text); }
