import type { SendMessagePort } from 'second_brain';

/** 운영 주소는 고정하고 시험에서만 명시적으로 전송 함수를 주입한다. */
export function telegramSender(token: string, options: { fetch?: typeof fetch; endpoint?: string } = {}): SendMessagePort {
  const endpoint = options.endpoint ?? 'https://api.telegram.org';
  const send = options.fetch ?? fetch;
  async function request(method: string, body: string | FormData, headers?: Record<string, string>): ReturnType<NonNullable<SendMessagePort['sendMediaGroup']>> {
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
      if (response.status >= 400 && response.status < 500) return { ok: false, outcome: 'definite_failed', code: 'http_4xx', retryable: false };
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
      if (input.text.length > 4096) return { ok: false, outcome: 'definite_failed', code: 'too_large', retryable: false };
      return request('sendMessage', JSON.stringify({ chat_id: input.chatId, text: input.text, ...(input.threadId === null ? {} : { message_thread_id: input.threadId }) }), { 'content-type': 'application/json' });
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
