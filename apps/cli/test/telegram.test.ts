import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { telegramSender } from '../src/adapters/telegram.js';
import { resolveTelegramConfig } from '../src/config/codec.js';

describe('Telegram 전송', () => {
  it('고정 HTTPS 주소에 메시지를 보내고 응답의 식별자를 보존한다', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: { message_id: 42 } })));
    const result = await telegramSender('token', { fetch: send }).sendMessage({ chatId: 'chat', threadId: '12', text: 'hello' });
    expect(result).toEqual({ ok: true, messageId: '42' });
    expect(send).toHaveBeenCalledWith('https://api.telegram.org/bottoken/sendMessage', expect.objectContaining({ method: 'POST', redirect: 'error', body: JSON.stringify({ chat_id: 'chat', text: 'hello', message_thread_id: '12' }) }));
  });
  it('응답에 식별자가 없으면 null로 성공하고 실패를 성공으로 추정하지 않는다', async () => {
    const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response('{"ok":true,"result":{}}')).mockResolvedValueOnce(new Response('', { status: 429 }));
    const sender = telegramSender('token', { fetch: send, endpoint: 'http://test' });
    expect(await sender.sendMessage({ chatId: 'chat', threadId: null, text: 'hello' })).toEqual({ ok: true, messageId: null });
    expect(await sender.sendMessage({ chatId: 'chat', threadId: null, text: 'hello' })).toMatchObject({ ok: false, retryable: true });
  });
  it('환경 설정이 없으면 비밀을 추측하지 않는다', async () => {
    expect(await resolveTelegramConfig('/tmp/brain-no-such-home-for-config', {})).toBeNull();
    expect(await resolveTelegramConfig('/tmp/brain-no-such-home-for-config', { BRAIN_TELEGRAM_BOT_TOKEN: 'token', BRAIN_TELEGRAM_CHAT_ID: 'chat' })).toEqual({ token: 'token', chatId: 'chat' });
  });
});

it('redirect가 다른 서버로 token 경로를 전달하지 않는다', async () => {
  let forwarded = 0;
  const destination = createServer((_request, response) => { forwarded++; response.end(); });
  await new Promise<void>(resolve => destination.listen(0, '127.0.0.1', resolve));
  const address = destination.address();
  if (!address || typeof address === 'string') throw Error('시험 주소 없음');
  const redirect = createServer((_request, response) => response.writeHead(302, { location: `http://127.0.0.1:${address.port}/stolen` }).end());
  await new Promise<void>(resolve => redirect.listen(0, '127.0.0.1', resolve));
  const origin = redirect.address();
  if (!origin || typeof origin === 'string') throw Error('시험 주소 없음');
  try {
    const result = await telegramSender('secret', { endpoint: `http://127.0.0.1:${origin.port}` }).sendMessage({ chatId: 'chat', threadId: null, text: 'text' });
    expect(result).toMatchObject({ ok: false, retryable: true });
    expect(forwarded).toBe(0);
  } finally {
    redirect.closeAllConnections(); destination.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => redirect.close(() => resolve())), new Promise<void>(resolve => destination.close(() => resolve()))]);
  }
});

it('오류를 보수적으로 분류하고 재시도 하한을 추출한다', async () => {
  const send = vi.fn<typeof fetch>()
    .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }))
    .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }))
    .mockResolvedValueOnce(new Response('broken'))
    .mockResolvedValueOnce(new Response('{"ok":false}'))
    .mockResolvedValueOnce(new Response('{"parameters":{"retry_after":7}}', { status: 429 }))
    .mockResolvedValueOnce(new Response('', { status: 503 }))
    .mockResolvedValueOnce(new Response('', { status: 400 }));
  const sender = telegramSender('secret', { fetch: send });
  const input = { chatId: 'chat', threadId: null, text: 'text' };
  expect(await sender.sendMessage(input)).toMatchObject({ outcome: 'definite_failed', code: 'network_before_send', retryable: true });
  expect(await sender.sendMessage(input)).toMatchObject({ outcome: 'unknown', code: 'network_unknown', retryable: true });
  for (let i = 0; i < 2; i++) expect(await sender.sendMessage(input)).toMatchObject({ outcome: 'unknown', retryable: true });
  expect(await sender.sendMessage(input)).toMatchObject({ outcome: 'definite_failed', retryable: true, retryAfterMs: 7000 });
  expect(await sender.sendMessage(input)).toMatchObject({ outcome: 'definite_failed', code: 'http_5xx', retryable: true });
  expect(await sender.sendMessage(input)).toMatchObject({ outcome: 'definite_failed', code: 'http_4xx', retryable: false });
  expect(await sender.sendMessage({ ...input, text: '😀'.repeat(2049) })).toMatchObject({ outcome: 'definite_failed', code: 'too_large', retryable: false });
  expect(send).toHaveBeenCalledTimes(7);
});
