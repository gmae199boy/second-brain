import type { SendMessagePort } from 'second_brain';

/** 운영 주소는 고정하고 시험에서만 명시적으로 전송 함수를 주입한다. */
export function telegramSender(token: string, options: { fetch?: typeof fetch; endpoint?: string } = {}): SendMessagePort {
  const endpoint = options.endpoint ?? 'https://api.telegram.org';
  const send = options.fetch ?? fetch;
  return {
    async sendMessage(input) {
      if (input.text.length > 4096) return { ok: false, outcome: 'definite_failed', code: 'too_large', retryable: false };
      let response: Response;
      try {
        response = await send(`${endpoint}/bot${token}/sendMessage`, {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: input.chatId, text: input.text,
            ...(input.threadId === null ? {} : { message_thread_id: input.threadId }) }),
        });
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
        const messageId = result && 'message_id' in result ? result.message_id : null;
        return { ok: true, messageId: typeof messageId === 'string' || typeof messageId === 'number' ? String(messageId) : null };
      } catch { return { ok: false, outcome: 'unknown', code: 'invalid_response', retryable: true }; }
    },
  };
}
