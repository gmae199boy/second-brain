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

it('명시된 중립 마크업만 HTML로 바꾸며 특수문자를 escape한다', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
  await telegramSender('fake', { fetch: send }).sendMessage({ chatId: 'chat', threadId: '2', text: '[brain-markup-v1]\n# 제목 <>&\n\n**회복**\n- <script>&' });
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ chat_id: 'chat', message_thread_id: '2',
    text: '<b>제목 &lt;&gt;&amp;</b>\n\n<b>회복</b>\n• &lt;script&gt;&amp;', parse_mode: 'HTML' });
});

it('접두어 없는 기존 생산자의 마크업과 HTML 문자는 평문으로 보낸다', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
  const text = '# 제목 **강조** <>&';
  await telegramSender('fake', { fetch: send }).sendMessage({ chatId: 'chat', threadId: null, text });
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body))).toEqual({ chat_id: 'chat', text });
});

it('HTML 길이 상한·잘못된 강조는 평문으로 내리고 UTF-16 경계를 지킨다', async () => {
  for (const body of ['# ' + '&'.repeat(1000), '**닫히지 않은 강조']) {
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
    await telegramSender('fake', { fetch: send }).sendMessage({ chatId: 'chat', threadId: null, text: '[brain-markup-v1]\n' + body });
    const payload = JSON.parse(String(send.mock.calls[0]![1]!.body));
    expect(payload.parse_mode).toBeUndefined();
    expect(payload.text.length).toBeLessThanOrEqual(4096);
    expect(payload.text.isWellFormed()).toBe(true);
    expect(payload.text).not.toContain('[brain-markup-v1]');
  }
});

it('확정 HTML parse 거부만 같은 시도에서 평문으로 다시 보낸다', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 }))
    .mockResolvedValueOnce(new Response('{"ok":true,"result":{"message_id":5}}'));
  expect(await telegramSender('fake', { fetch: send }).sendMessage({ chatId: 'chat', threadId: null, text: '[brain-markup-v1]\n# 제목' })).toMatchObject({ ok: true, messageId: '5' });
  expect(send).toHaveBeenCalledTimes(2);
  expect(JSON.parse(String(send.mock.calls[1]![1]!.body))).toEqual({ chat_id: 'chat', text: '제목' });
});

it('HTML 전송 결과가 불명확하거나 일반 400이면 재전송하지 않는다', async () => {
  for (const failure of [new TypeError('unknown'), new Response('', { status: 400 }), new Response('{"ok":false}'), new Response('', { status: 503 })]) {
    const send = vi.fn<typeof fetch>();
    if (failure instanceof Error) send.mockRejectedValueOnce(failure);
    else send.mockResolvedValueOnce(failure);
    expect(await telegramSender('fake', { fetch: send }).sendMessage({ chatId: 'chat', threadId: null, text: '[brain-markup-v1]\n# 제목' })).toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(1);
  }
});


it('텍스트와 caption의 UTF-16 경계를 자르지 않고 정확히 적용한다', async () => {
  const send = vi.fn<typeof fetch>().mockImplementation(async () => new Response('{"ok":true}'));
  const sender = telegramSender('fake', { fetch: send });
  const address = { chatId: 'chat', threadId: null };
  const text = '😀'.repeat(2048);
  expect(await sender.sendMessage({ ...address, text: '[brain-markup-v1]\n' + text })).toMatchObject({ ok: true });
  expect(JSON.parse(String(send.mock.calls[0]![1]!.body)).text).toBe(text);
  expect(await sender.sendMessage({ ...address, text: '[brain-markup-v1]\n' + text + '한' })).toMatchObject({ code: 'too_large' });
  const photo = { bytes: new Uint8Array([1]), filename: 'synthetic.png' };
  expect(await sender.sendPhoto!({ ...address, photo, caption: '😀'.repeat(512) })).toMatchObject({ ok: true });
  expect(await sender.sendPhoto!({ ...address, photo, caption: '😀'.repeat(512) + '한' })).toMatchObject({ code: 'too_large' });
  expect(await sender.sendMediaGroup!({ ...address, photos: [photo, photo], caption: '가'.repeat(1024) })).toMatchObject({ ok: true });
  for (const photos of [[photo], Array.from({ length: 11 }, () => photo)])
    expect(await sender.sendMediaGroup!({ ...address, photos })).toMatchObject({ code: 'too_large' });
  expect(await sender.sendMediaGroup!({ ...address, photos: [photo, photo], caption: '가'.repeat(1025) })).toMatchObject({ code: 'too_large' });
  expect(send).toHaveBeenCalledTimes(3);
});
