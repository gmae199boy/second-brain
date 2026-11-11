import type { SendMessagePort } from 'second_brain';
import { telegramMarkup } from './telegram-markup.js';

/** 운영 주소는 고정하고 시험에서만 명시적으로 전송 함수를 주입한다. */
export function telegramSender(token: string, options: { fetch?: typeof fetch; endpoint?: string } = {}): SendMessagePort {
  const endpoint = options.endpoint ?? 'https://api.telegram.org';
  const send = options.fetch ?? fetch;
  async function request(method: string, body: string | FormData, headers?: Record<string, string>, html = false): ReturnType<NonNullable<SendMessagePort['sendMediaGroup']>> {
      let response: Response;
      try {
        response = await send(`${endpoint}/bot${token}/${method}`, { method: 'POST', redirect: 'error', ...(headers ? { headers } : {}), body });
      } catch (error) {
        const cause = error instanceof Error ? error.cause : null;
        const code = cause && typeof cause === 'object' && 'code' in cause ? cause.code : null;
        if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN')
          return { ok: false, outcome: 'definite_failed', code: 'network_before_send', retryable: true };
        return { ok: false, outcome: 'unknown', code: 'network_unknown', retryable: true };
      }
      if (response.status === 429) {
        let retryAfterMs: number | undefined;
        try {
          const body: unknown = await response.json();
          if (body && typeof body === 'object' && 'parameters' in body && body.parameters && typeof body.parameters === 'object' && 'retry_after' in body.parameters) {
            const seconds = body.parameters.retry_after;
            if (typeof seconds === 'number' && Number.isSafeInteger(seconds) && seconds >= 0 && seconds <= 2_147_483_647) retryAfterMs = seconds * 1000;
          }
        } catch { /* 응답 본문이 없어도 429 자체는 재시도한다. */ }
        return { ok: false, outcome: 'definite_failed', code: 'http_429', retryable: true, ...(retryAfterMs === undefined ? {} : { retryAfterMs }) };
      }
      if (response.status >= 500) return { ok: false, outcome: 'definite_failed', code: 'http_5xx', retryable: true };
      if (response.status >= 400 && response.status < 500) {
        if (html && response.status === 400) {
          try {
            const rejected: unknown = await response.json();
            if (rejected && typeof rejected === 'object' && 'ok' in rejected && rejected.ok === false &&
                'description' in rejected && typeof rejected.description === 'string' && /can't parse entities|cannot parse entities|unsupported start tag/i.test(rejected.description))
              return { ok: false, outcome: 'definite_failed', code: 'html_parse_rejected', retryable: false };
          } catch { /* 확정된 parse 거부만 재전송한다. */ }
        }
        return { ok: false, outcome: 'definite_failed', code: 'http_4xx', retryable: false };
      }
      if (!response.ok) return { ok: false, outcome: 'unknown', code: 'http_unknown', retryable: true };
      try {
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) return { ok: false, outcome: 'unknown', code: 'invalid_response', retryable: true };
        const result = 'result' in body && body.result && typeof body.result === 'object' ? body.result : null;
        const id = (value: unknown): string | null => { if (!value || typeof value !== 'object' || !('message_id' in value)) return null; const v = value.message_id; return typeof v === 'string' || typeof v === 'number' ? String(v) : null; };
        if (Array.isArray(result)) { const messageIds = result.map(id).filter((v): v is string => v !== null); return { ok: true, messageId: messageIds[0] ?? null, messageIds }; }
        return { ok: true, messageId: id(result) };
      } catch { return { ok: false, outcome: 'unknown', code: 'invalid_response', retryable: true }; }
  }
  function form(address: { chatId: string; threadId: string | null }): FormData {
    const data = new FormData(); data.set('chat_id', address.chatId);
    if (address.threadId !== null) data.set('message_thread_id', address.threadId);
    return data;
  }
  function attach(data: FormData, name: string, file: { bytes: Uint8Array; filename: string }): void {
    data.set(name, new Blob([Uint8Array.from(file.bytes)]), file.filename);
  }
  return {
    async sendMessage(input) {
      const markup = telegramMarkup(input.text);
      const text = markup?.html ?? markup?.plain ?? input.text;
      if (text.length > 4096) return { ok: false, outcome: 'definite_failed', code: 'too_large', retryable: false };
      const payload = (value: string, html: boolean) => JSON.stringify({ chat_id: input.chatId, text: value,
        ...(html ? { parse_mode: 'HTML' } : {}), ...(input.threadId === null ? {} : { message_thread_id: input.threadId }) });
      const html = markup?.html !== undefined;
      const result = await request('sendMessage', payload(text, html), { 'content-type': 'application/json' }, html);
      // 같은 attempt에서 확정된 HTML parse 거부만 평문으로 재시도한다.
      if (html && !result.ok && result.outcome === 'definite_failed' && result.code === 'html_parse_rejected')
        return request('sendMessage', payload(markup!.plain, false), { 'content-type': 'application/json' });
      return result;
    },
    async sendPhoto(input) {
      const data = form(input); attach(data, 'photo', input.photo); if (input.caption !== undefined) data.set('caption', input.caption);
      return request('sendPhoto', data);
    },
    async sendMediaGroup(input) {
      const data = form(input);
      const media = input.photos.map((photo, index) => { const name = `photo${index}`; attach(data, name, photo); return { type: 'photo', media: `attach://${name}`, ...(index === 0 && input.caption !== undefined ? { caption: input.caption } : {}) }; });
      data.set('media', JSON.stringify(media)); return request('sendMediaGroup', data);
    },
    async sendDocument(input) {
      const data = form(input); attach(data, 'document', input.document); return request('sendDocument', data);
    },
  };
}
