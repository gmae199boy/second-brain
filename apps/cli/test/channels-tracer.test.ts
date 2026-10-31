import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { channelFixture } from './channel-fixture.js';
import { runPgCommand } from './pg-home.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';

it('동시 생산과 인계, drain 격리, HTTP 대기 중 gate와 잠금 및 성공을 관통한다', async () => {
  const f = await channelFixture('hold');
  try {
    const other = (await import('second_brain/postgres')).postgresStore({ databaseUrl: f.db.appUrl });
    let requestId: string;
    try {
      const inserted = await Promise.all([f.store.createChannelRequest(f.input), other.createChannelRequest({ ...f.input, id: f.ids.next() })]);
      expect(inserted.filter(result => result.ok && result.created)).toHaveLength(1);
      const first = inserted[0]!;
      if (!first.ok) throw Error(first.message);
      requestId = first.request.id;
      const handoffs = await Promise.all([f.store.handoffChannelRequest({ requestId, workId: f.ids.next(), now: new Date() }), other.handoffChannelRequest({ requestId, workId: f.ids.next(), now: new Date() })]);
      expect(handoffs[0]).toEqual(handoffs[1]);
      expect(await f.store.handoffChannelRequest({ requestId, workId: f.ids.next(), now: new Date() })).toEqual(handoffs[0]);
    } finally { await other.close(); }
    const drain = await runPgCommand(['queue', 'drain'], { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home });
    expect(drain.code).toBe(0);
    expect(f.requests).toHaveLength(0);
    expect(await f.db.rows("select id from brain.work_items where kind='channel_send'")).toHaveLength(1);
    await f.start();
    await expect.poll(() => f.requests.length, { timeout: 15000 }).toBe(1);
    expect(f.requests[0]!.url).toBe('/bottest-token/sendMessage');
    expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ chat_id: 'test-chat', message_thread_id: '12' });
    expect(f.requests[0]!.body).not.toContain('secret123456');
    expect(f.requests[0]!.body).toContain('[REDACTED:');
    const gates = await f.db.rows<{ work_item_id: string }>('select work_item_id from brain.channel_gates');
    expect(gates).toHaveLength(1);
    expect(await f.store.finishChannelAttempt({ requestId, workItemId: gates[0]!.work_item_id,
      attemptToken: f.ids.next(), now: new Date(), externalMessageId: 'stale' })).toEqual({ ok: true, outcome: 'lost' });
    for (const table of ['channel_requests', 'channel_gates', 'work_items', 'work_attempts']) {
      await f.db.query(`select * from brain.${table} for update nowait`);
    }
    // 감독자의 짧은 갱신은 허용하되 HTTP 응답을 기다리는 동안 오래 열린 트랜잭션은 거부한다.
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await f.db.rows("select pid from pg_stat_activity where datname=current_database() and state='idle in transaction' and clock_timestamp() - xact_start > interval '250 milliseconds'")).toEqual([]);
    const pending = await f.store.readChannelRequest(requestId);
    expect(pending).toMatchObject({ request: { text: f.input.text, status: 'pending' } });
    f.release();
    await expect.poll(async () => (await f.store.readChannelRequest(requestId)), { timeout: 15000 }).toMatchObject({ request: { status: 'sent' } });
    await expect.poll(async () => f.db.rows("select outcome from brain.work_attempts where outcome='succeeded'"), { timeout: 15000 }).toHaveLength(1);
    expect(await f.store.readChannelRequest(requestId)).toMatchObject({
      channel: { id: expect.any(String), kind: 'telegram', botRef: 'test-bot' },
      conversation: { id: f.input.conversationId, externalRef: 'test-chat', threadRef: '12' },
      request: { id: requestId, producer: 'test-producer', producerResultId: f.input.producerResultId, purpose: 'notice', revision: null, text: f.input.text, externalMessageId: '987' },
    });
    expect(await f.store.createChannelRequest({ ...f.input, id: f.ids.next() })).toMatchObject({ ok: true, created: false, request: { id: requestId } });
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(f.requests).toHaveLength(1);
    expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it('message id가 없는 정상 응답을 sent와 null로 보존한다', async () => {
  const f = await channelFixture('null-id');
  try {
    await f.store.createChannelRequest(f.input);
    await f.start();
    await expect.poll(async () => f.store.readChannelRequest(f.input.id), { timeout: 15000 }).toMatchObject({ request: { status: 'sent', externalMessageId: null } });
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it.each(['429', 'disconnect'] as const)('%s 응답을 sent로 추정하지 않는다', async mode => {
  const f = await channelFixture(mode);
  try {
    await f.store.createChannelRequest(f.input);
    await f.start();
    await expect.poll(async () => f.db.rows("select outcome from brain.work_attempts where outcome='failed'"), { timeout: 15000 }).toHaveLength(1);
    expect(f.requests).toHaveLength(1);
    expect(await f.store.readChannelRequest(f.input.id)).toMatchObject({ request: { status: 'pending', externalMessageId: null } });
    expect(await f.db.rows('select * from brain.channel_attempt_results')).toHaveLength(1);
  } finally { await f.close(); }
}, 30000);

it('Telegram 설정이 없으면 첫 시도에서 비재시도 설정 오류를 기록하고 HTTP를 보내지 않는다', async () => {
  const f = await channelFixture();
  try {
    await f.store.createChannelRequest(f.input);
    await f.start(false);
    await expect.poll(async () => f.db.rows("select outcome,error_code,error_retryable from brain.work_attempts where outcome='failed'"), { timeout: 15000 })
      .toMatchObject([{ outcome: 'failed', error_code: 'CHANNEL_CONFIG_INVALID', error_retryable: false }]);
    expect(await f.db.rows('select * from brain.channel_gates')).toHaveLength(1);
    expect(await f.db.rows('select * from brain.channel_attempt_results')).toHaveLength(1);
    expect(f.requests).toEqual([]);
    expect(await f.store.readChannelRequest(f.input.id)).toMatchObject({ request: { status: 'pending' } });
    expect(await f.db.rows("select attempts,outcome from brain.work_items where kind='channel_send'")).toMatchObject([{ attempts: 1, outcome: 'failed' }]);
  } finally { await f.close(); }
}, 30000);

it('잘못된 ABI 환경은 설정 오류와 구분한다', async () => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/workers/channel-send.js', import.meta.url))], { env: {}, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { output += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  expect(code).toBe(2);
  expect(JSON.parse(output)).toEqual({ abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false });
});
