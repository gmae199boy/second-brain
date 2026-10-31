import { expect, it } from 'vitest';
import { channelFixture } from './channel-fixture.js';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';

it.each(['unknown', 'definite_failed'] as const)('CLI가 닫힌 %s 요청을 재개하고 감독자가 성공을 정산한다', async outcome => {
  const f = await channelFixture();
  const cli = async (...args: string[]) => runPgCommand(args, { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home });
  try {
    const file = await f.files.put(Buffer.from('document')); if (!file.ok) throw Error(file.message);
    await f.store.createChannelRequest({ ...f.input, bundle: { summary: 'secret summary', albums: [], document: { location: file.location, filename: 'secret.txt' } } });
    const workId = f.ids.next(); await f.store.handoffChannelRequest({ requestId: f.input.id, workId, now: f.now() });
    const token = f.ids.next(), now = f.now(); await f.store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'test', attemptToken: token });
    const attempt = { requestId: f.input.id, workItemId: workId, attemptToken: token, now };
    await f.store.gateChannelAttempt(attempt);
    await f.store.recordChannelItemResult({ ...attempt, index: 0, result: { outcome: 'sent', externalMessageId: 'private-id' } });
    await f.store.finishChannelAttempt({ ...attempt, result: { outcome, code: 'secret-error', retryable: false } });
    await f.store.finishSupervisedWork({ id: workId, attemptToken: token, now, outcome: 'failed', failure: { id: f.ids.next(), stage: 'channel_send', fingerprint: 'one', code: 'FAIL', message: 'secret-error', occurredAt: now } });
    const before = await cli('channels', 'status', f.input.id, '--json'); expect(JSON.parse(before.stdout)).toMatchObject({ ok: true, data: { delivery: outcome, unresolvedFailures: 1, resendEligible: true } });
    expect(before.stdout).not.toMatch(/secret|private-id|test-chat/);
    const reopened = await cli('channels', 'resend', f.input.id, '--json'); expect(JSON.parse(reopened.stdout)).toMatchObject({ ok: true });
    const duplicate = await cli('channels', 'resend', f.input.id, '--json'); expect(JSON.parse(duplicate.stdout)).toMatchObject({ ok: false, error: { code: 'CHANNEL_REQUEST_IN_PROGRESS' } });
    await f.start();
    await expect.poll(async () => (await f.store.readChannelStatus(f.input.id)), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent', unresolvedFailures: 0 } });
    expect(f.requests.map(r => r.url.split('/').pop())).toEqual(['sendDocument']);
    expect(await f.db.rows('select outcome from brain.channel_attempt_results order by sequence')).toEqual([{ outcome }, { outcome: 'sent' }]);
    expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1);
    const sent = await cli('channels', 'resend', f.input.id, '--json'); expect(JSON.parse(sent.stdout)).toMatchObject({ ok: false, error: { code: 'CHANNEL_ALREADY_SENT' } });
    const invalid = await cli('channels', 'status', 'invalid', '--json'); expect(JSON.parse(invalid.stdout)).toMatchObject({ ok: false, error: { code: 'INVALID_ARGUMENT' } });
  } finally { await f.close(); }
}, 30000);

it('CLI는 미인계·대기·실행·legacy·없는 요청을 거부하고 공개 목록과 텍스트를 마스킹한다', async () => {
  const f = await channelFixture();
  const cli = async (...args: string[]) => runPgCommand(args, { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home });
  try {
    await f.store.createChannelRequest(f.input);
    const resend = async (id: string) => JSON.parse((await cli('channels', 'resend', id, '--json')).stdout);
    expect(await resend(f.input.id)).toMatchObject({ ok: false, error: { code: 'CHANNEL_REQUEST_IN_PROGRESS' } });
    const workId = f.ids.next(); await f.store.handoffChannelRequest({ requestId: f.input.id, workId, now: f.now() });
    expect(await resend(f.input.id)).toMatchObject({ ok: false, error: { code: 'CHANNEL_REQUEST_IN_PROGRESS' } });
    const token = f.ids.next(); await f.store.claimSupervisedWork({ now: f.now(), kinds: ['channel_send'], claimedBy: 'test', attemptToken: token });
    expect(await resend(f.input.id)).toMatchObject({ ok: false, error: { code: 'CHANNEL_REQUEST_IN_PROGRESS' } });
    await f.store.finishSupervisedWork({ id: workId, attemptToken: token, now: f.now(), outcome: 'failed', nextAttemptAt: new Date(f.now().getTime() + 10000) });
    expect(await resend(f.input.id)).toMatchObject({ ok: false, error: { code: 'CHANNEL_REQUEST_IN_PROGRESS' } });
    const common = { conversationId: f.input.conversationId, source: 'secret-source', dataset: 'dataset', importBatch: 'batch', localDate: '2026-10-31', at: f.now() };
    const notification = f.ids.next(), delivery = f.ids.next();
    await f.store.insertChannelLegacy({ ...common, type: 'notification', id: notification, originalTable: 'notifications', originalKey: '1', event: 'secret-event', detail: 'secret-detail' });
    await f.store.insertChannelLegacy({ ...common, type: 'delivery', id: delivery, originalTable: 'deliveries', originalKey: '1', originalId: 'secret-id', kind: 'notice', event: null, ok: false, reason: 'secret-reason' });
    for (const id of [notification, delivery]) { expect(await resend(id)).toMatchObject({ ok: false, error: { code: 'CHANNEL_LEGACY_NOT_RESENDABLE' } }); expect(JSON.parse((await cli('channels', 'status', id, '--json')).stdout)).toMatchObject({ data: { legacy: true, resendEligible: false } }); }
    expect(await resend(f.ids.next())).toMatchObject({ ok: false, error: { code: 'CHANNEL_REQUEST_NOT_FOUND' } });
    for (const args of [['channels', 'list'], ['channels', 'status', f.input.id]]) {
      const text = await cli(...args); expect(text.stdout).toContain(new Date(f.now().getTime() + 10000).toISOString());
      expect(text.stdout).toContain('다음 시도');
    }
    const legacyText = await cli('channels', 'status', notification); expect(legacyText.stdout).toContain('다음 시도 예정 없음');
    for (const args of [['channels','list','--json'], ['channels','list'], ['channels','status', f.input.id]]) {
      const result = await cli(...args); expect(result.code).toBe(0); expect(result.stdout).not.toMatch(/secret|test-chat|test-bot/);
    }
    expect(f.requests).toHaveLength(0);
  } finally { await f.close(); }
}, 30000);
