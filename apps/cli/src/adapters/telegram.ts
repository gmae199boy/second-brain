import type { SendMessagePort } from 'second_brain';

/** 운영 주소는 고정하고 시험에서만 명시적으로 전송 함수를 주입한다. */
export function telegramSender(token: string, options: { fetch?: typeof fetch; endpoint?: string } = {}): SendMessagePort {
  const endpoint = options.endpoint ?? 'https://api.telegram.org';
  const send = options.fetch ?? fetch;
  return {
    async sendMessage(input) {
      try {
        const response = await send(`${endpoint}/bot${token}/sendMessage`, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ chat_id: input.chatId, text: input.text,
            ...(input.threadId === null ? {} : { message_thread_id: input.threadId }) }),
        });
        if (!response.ok) return { ok: false };
        const body: unknown = await response.json();
        if (!body || typeof body !== 'object' || !('ok' in body) || body.ok !== true) return { ok: false };
        const result = 'result' in body && body.result && typeof body.result === 'object' ? body.result : null;
        const messageId = result && 'message_id' in result ? result.message_id : null;
        return { ok: true, messageId: typeof messageId === 'string' || typeof messageId === 'number' ? String(messageId) : null };
      } catch {
        return { ok: false };
      }
    },
  };
}
