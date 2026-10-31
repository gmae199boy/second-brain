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
  expect(await run()).toEqual({ ok: false, code: 'CHANNEL_GATE_REFUSED' });
  expect(calls).toHaveLength(1);
});
