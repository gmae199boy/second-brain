import { expect, it } from 'vitest';
import { sendChannelRequest } from '../src/channels/send.js';
import { memoryStore } from '../src/testing/index.js';

it('gate 확정 후 가린 본문을 보내고 원문은 보존한다', async () => {
  const store = memoryStore();
  const now = new Date('2026-10-31T00:00:00Z');
  await store.ensureChannel({ id: 'channel', kind: 'telegram', botRef: 'bot' });
  await store.ensureChannelConversation({ id: 'conversation', channelId: 'channel', externalRef: 'chat', threadRef: 'thread' });
  const text = 'password: secret123456';
  await store.createChannelRequest({ id: 'request', conversationId: 'conversation', producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text, createdAt: now });
  await store.handoffChannelRequest({ requestId: 'request', workId: 'work', now });
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'token' });
  const calls: string[] = [];
  const run = () => sendChannelRequest({ store, requestId: 'request', workItemId: 'work', attemptToken: 'token', now: () => now,
    sender: { async sendMessage(input) { calls.push(input.text); return { ok: true, messageId: null }; } } });
  expect(await run()).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]).not.toContain('secret123456');
  expect((await store.readChannelRequest('request'))).toMatchObject({ request: { text, status: 'sent', externalMessageId: null } });
  expect(await run()).toEqual({ ok: true });
  expect(calls).toHaveLength(1);
});

it('부분 성공을 저장하고 새 시도에서 남은 항목부터 순서대로 보낸다', async () => {
  const store = memoryStore(), now = new Date('2026-10-31T00:00:00Z');
  await store.ensureChannel({ id: 'channel', kind: 'telegram', botRef: 'bot' });
  await store.ensureChannelConversation({ id: 'conversation', channelId: 'channel', externalRef: 'chat', threadRef: null });
  const file = { location: { storeKind: 'local' as const, locator: 'file', ownership: 'brain' as const }, filename: 'file' };
  const bundle = { summary: 'password: secret123456', albums: [{ photos: [file], caption: 'password: secret123456' }, { photos: [file, file] }], document: file };
  await store.createChannelRequest({ id: 'request', conversationId: 'conversation', producer: 'test', producerResultId: 'bundle', purpose: 'report', revision: null, text: '원문', bundle, createdAt: now });
  await store.handoffChannelRequest({ requestId: 'request', workId: 'work', now });
  const calls: string[] = []; let fail = true;
  const sender = {
    async sendMessage(input: { text: string }) { expect(input.text).not.toContain('secret123456'); calls.push('summary'); return { ok: true as const, messageId: '1' }; },
    async sendPhoto(input: { caption?: string }) { expect(input.caption).not.toContain('secret123456'); calls.push('photo'); return { ok: true as const, messageId: '2' }; },
    async sendMediaGroup() { calls.push('album'); if (fail) { fail = false; return { ok: false as const, outcome: 'unknown' as const, code: 'network', retryable: true }; } return { ok: true as const, messageId: '3', messageIds: ['3', '4'] }; },
    async sendDocument() { calls.push('document'); return { ok: true as const, messageId: '5' }; },
  };
  const files = { async get() { return { ok: true as const, bytes: new Uint8Array([1, 2]) }; } };
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'first' });
  const run = (attemptToken: string) => sendChannelRequest({ store, sender, files, requestId: 'request', workItemId: 'work', attemptToken, now: () => now });
  expect(await run('first')).toMatchObject({ ok: false, code: 'network' });
  await store.finishSupervisedWork({ id: 'work', attemptToken: 'first', now, outcome: 'failed', nextAttemptAt: now });
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'second' });
  expect(await run('second')).toEqual({ ok: true });
  expect(calls).toEqual(['summary', 'photo', 'album', 'album', 'document']);
  expect(await store.listChannelItemResults('request')).toMatchObject({ items: [{ index: 0, result: { externalMessageId: '1' } }, { index: 1, result: { externalMessageId: '2' } }, { index: 2, result: { externalMessageIds: ['3', '4'] } }, { index: 3, result: { externalMessageId: '5' } }] });
  expect(await store.readChannelRequest('request')).toMatchObject({ request: { bundle, status: 'sent' } });
});

it('파일 저장소 일시 장애 뒤 이미 보낸 요약을 건너뛰고 복구한다', async () => {
  const store = memoryStore(), now = new Date();
  await store.ensureChannel({ id: 'c', kind: 'telegram', botRef: 'bot' }); await store.ensureChannelConversation({ id: 'v', channelId: 'c', externalRef: 'chat', threadRef: null });
  const doc = { location: { storeKind: 'local' as const, ownership: 'brain' as const, locator: 'file' }, filename: 'file' };
  await store.createChannelRequest({ id: 'r', conversationId: 'v', producer: 'p', producerResultId: 'r', purpose: 'report', revision: null, text: '', bundle: { summary: 'summary', albums: [], document: doc }, createdAt: now });
  await store.handoffChannelRequest({ requestId: 'r', workId: 'w', now });
  const calls: string[] = []; let unavailable = true;
  const files = { async get() { return unavailable ? { ok: false as const, code: 'FILES_UNAVAILABLE' as const, message: 'unavailable' } : { ok: true as const, bytes: new Uint8Array([1]) }; } };
  const sender = { async sendMessage() { calls.push('summary'); return { ok: true as const, messageId: '1' }; }, async sendDocument() { calls.push('document'); return { ok: true as const, messageId: '2' }; } };
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'a' });
  const run = (attemptToken: string) => sendChannelRequest({ store, sender, files, requestId: 'r', workItemId: 'w', attemptToken, now: () => now });
  expect(await run('a')).toMatchObject({ ok: false, code: 'FILES_UNAVAILABLE', retryable: true });
  await store.finishSupervisedWork({ id: 'w', attemptToken: 'a', now, outcome: 'failed', nextAttemptAt: now }); unavailable = false;
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'b' });
  expect(await run('b')).toEqual({ ok: true }); expect(calls).toEqual(['summary', 'document']);
});

it('모든 항목 저장 후 finish 전 중단된 요청은 재시도에서 마지막 외부 ID를 복원한다', async () => {
  const store = memoryStore(), now = new Date();
  await store.ensureChannel({ id: 'c', kind: 'telegram', botRef: 'bot' }); await store.ensureChannelConversation({ id: 'v', channelId: 'c', externalRef: 'chat', threadRef: null });
  const doc = { location: { storeKind: 'local' as const, ownership: 'brain' as const, locator: 'file' }, filename: 'file' };
  await store.createChannelRequest({ id: 'r', conversationId: 'v', producer: 'p', producerResultId: 'r', purpose: 'report', revision: null, text: '', bundle: { summary: 'summary', albums: [], document: doc }, createdAt: now });
  await store.handoffChannelRequest({ requestId: 'r', workId: 'w', now });
  const calls: string[] = []; const sender = { async sendMessage() { calls.push('summary'); return { ok: true as const, messageId: '1' }; }, async sendDocument() { calls.push('document'); return { ok: true as const, messageId: 'last' }; } };
  const files = { async get() { return { ok: true as const, bytes: new Uint8Array([1]) }; } };
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'a' });
  const args = { store, sender, files, requestId: 'r', workItemId: 'w', now: () => now };
  await expect(sendChannelRequest({ ...args, attemptToken: 'a', beforeFinish: async () => { throw Error('crash'); } })).rejects.toThrow('crash');
  await store.finishSupervisedWork({ id: 'w', attemptToken: 'a', now, outcome: 'failed', nextAttemptAt: now });
  await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: 'b' });
  expect(await sendChannelRequest({ ...args, attemptToken: 'b' })).toEqual({ ok: true });
  expect(calls).toEqual(['summary', 'document']); expect(await store.readChannelRequest('r')).toMatchObject({ request: { status: 'sent', externalMessageId: 'last' } });
});
