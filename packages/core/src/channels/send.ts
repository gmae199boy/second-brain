import type { ChannelAttemptResult, ChannelStore } from './store.js';
import type { FileStore } from '../ports/file-store.js';
import { maskOutputText } from '../output/mask.js';

/** 전송 어댑터는 외부 응답에 있는 식별자만 돌려준다. */
export interface SendMessagePort {
  sendPhoto?(input: { chatId: string; threadId: string | null; photo: { bytes: Uint8Array; filename: string }; caption?: string }): Promise<SendResult>;
  sendMediaGroup?(input: { chatId: string; threadId: string | null; photos: { bytes: Uint8Array; filename: string }[]; caption?: string }): Promise<SendResult>;
  sendDocument?(input: { chatId: string; threadId: string | null; document: { bytes: Uint8Array; filename: string } }): Promise<SendResult>;
  sendMessage(input: { chatId: string; threadId: string | null; text: string }): Promise<{ ok: true; messageId: string | null } | ({ ok: false } & Partial<Extract<ChannelAttemptResult, { outcome: 'unknown' | 'definite_failed' }>>)>;
}

type SendResult = { ok: true; messageId: string | null; messageIds?: string[] } | ({ ok: false } & Partial<Extract<ChannelAttemptResult, { outcome: 'unknown' | 'definite_failed' }>>);

/** gate를 확정한 뒤 네트워크를 호출하고 현재 시도의 결과를 저장한다. */
export async function sendChannelRequest(input: {
  store: ChannelStore;
  sender: SendMessagePort;
  files?: Pick<FileStore, 'get'>;
  requestId: string;
  workItemId: string;
  attemptToken: string;
  now: () => Date;
  beforeFinish?: () => Promise<void>;
}): Promise<{ ok: true } | { ok: false; code: string; retryable?: boolean; retryAfterMs?: number }> {
  const read = await input.store.readChannelRequest(input.requestId);
  if (!read.ok || !read.request || !read.channel || !read.conversation) return { ok: false, code: 'CHANNEL_REQUEST_UNAVAILABLE' };
  const gate = await input.store.gateChannelAttempt({ ...input, now: input.now() });
  if (gate.ok && gate.outcome === 'sent') return { ok: true };
  if (!gate.ok || gate.outcome !== 'won') return { ok: false, code: 'CHANNEL_GATE_REFUSED' };
  const bundle = read.request.bundle;
  const prior = bundle ? await input.store.listChannelItemResults(input.requestId) : null;
  if (prior && !prior.ok) return { ok: false, code: 'CHANNEL_RESULT_UNAVAILABLE' };
  const total = bundle ? bundle.albums.length + 2 : 1;
  let result: ChannelAttemptResult = { outcome: 'sent', externalMessageId: null };
  for (let index = 0; index < total; index++) {
    const saved = prior?.ok ? prior.items.find(item => item.index === index && item.result.outcome === 'sent') : undefined;
    if (saved) { result = saved.result; continue; }
    const address = { chatId: read.conversation.externalRef, threadId: read.conversation.threadRef };
    let sent: SendResult;
    const tooLarge = (): SendResult => ({ ok: false, outcome: 'definite_failed', code: 'too_large', retryable: false });
    if (!bundle || index === 0) {
      const original = bundle ? bundle.summary : read.request.text;
      const text = encodeChannelText(original);
      sent = original.length > 4096 ? tooLarge() : await input.sender.sendMessage({ ...address, text });
    } else {
      const album = bundle.albums[index - 1];
      const entries = album ? album.photos : [bundle.document];
      if (album && (entries.length === 0 || entries.length > 10 || (album.caption?.length ?? 0) > 4096)) sent = tooLarge();
      else if (!input.files) sent = { ok: false, outcome: 'definite_failed', code: 'FILES_UNAVAILABLE', retryable: false };
      else {
        const loaded = await Promise.all(entries.map(async file => ({ file, data: await input.files!.get(file.location) })));
        const failure = loaded.find(x => !x.data.ok);
        if (failure && !failure.data.ok) sent = { ok: false, outcome: 'definite_failed', code: failure.data.code, retryable: failure.data.code === 'FILES_UNAVAILABLE' };
        else if (loaded.some(x => x.data.ok && x.data.bytes.length > (album ? 10 : 50) * 1024 * 1024)) sent = tooLarge();
        else {
          const files = loaded.map(x => ({ filename: x.file.filename, bytes: x.data.ok ? x.data.bytes : new Uint8Array() }));
          const caption = album?.caption === undefined ? undefined : encodeChannelText(album.caption);
          if (album && files.length === 1 && input.sender.sendPhoto) sent = await input.sender.sendPhoto({ ...address, photo: files[0]!, caption });
          else if (album && input.sender.sendMediaGroup) sent = await input.sender.sendMediaGroup({ ...address, photos: files, caption });
          else if (!album && input.sender.sendDocument) sent = await input.sender.sendDocument({ ...address, document: files[0]! });
          else sent = { ok: false, outcome: 'definite_failed', code: 'CHANNEL_CONFIG_INVALID', retryable: false };
        }
      }
    }
    result = sent.ok ? { outcome: 'sent', externalMessageId: sent.messageId, ...(sent.messageIds ? { externalMessageIds: sent.messageIds } : {}) } :
      { outcome: sent.outcome ?? 'unknown', code: sent.code ?? 'CHANNEL_SEND_FAILED', retryable: sent.retryable ?? true, ...(sent.retryAfterMs === undefined ? {} : { retryAfterMs: sent.retryAfterMs }) };
    if (bundle) {
      const recorded = await input.store.recordChannelItemResult({ ...input, index, now: input.now(), result });
      if (!recorded.ok || recorded.outcome !== 'done') return { ok: false, code: 'CHANNEL_RESULT_REFUSED' };
    }
    if (result.outcome !== 'sent') break;
  }
  await input.beforeFinish?.();
  const finished = await input.store.finishChannelAttempt({ ...input, now: input.now(), result });
  if (!finished.ok || finished.outcome !== 'done') return { ok: false, code: 'CHANNEL_RESULT_REFUSED' };
  return result.outcome === 'sent' ? { ok: true } : { ok: false, code: result.code, retryable: result.retryable, ...(result.retryAfterMs === undefined ? {} : { retryAfterMs: result.retryAfterMs }) };
}

/** 등록된 채널 출력 경계에서 원문을 가린다. */
export function encodeChannelText(text: string): string { return maskOutputText(text); }
