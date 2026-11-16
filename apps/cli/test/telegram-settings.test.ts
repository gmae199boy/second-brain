import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { memorySettingsStore, memorySchemaStore } from 'second_brain/testing';
import { createExtensionSnapshot } from 'second_brain';
import { resolveTelegramConfig } from '../src/config/codec.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { pgRunner, runPgCommand } from './pg-home.js';
import { channelFixture } from './channel-fixture.js';
import { HOME_ENV } from '../src/config/paths.js';
import { withoutHarnessFolders } from './environment.js';

const token = '123456789:' + 'A'.repeat(35);
const chatId = '-1001234567890';
const userId = '01940000-0000-7000-8000-00000000000a';
const clock = { now: () => new Date('2026-11-10T00:00:00Z') };

it('DB는 키별 환경 fallback보다 우선하며 읽기 오류는 숨기지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-tg-config-'));
  const store = { ...memorySettingsStore(), ...memorySchemaStore({ version: 1 }), async readSelfUser() { return { ok: true as const, user: { id: userId, name: 'synthetic', isSelf: true, createdAt: clock.now() } }; } };
  const deps = { store, schemaVersions: { core: 1 }, clock };
  const env = { BRAIN_TELEGRAM_BOT_TOKEN: 'legacy-token', BRAIN_TELEGRAM_CHAT_ID: 'legacy-chat' };
  try {
    await writeFile(join(home, '.env'), 'BRAIN_TELEGRAM_BOT_TOKEN=file-token\nBRAIN_TELEGRAM_CHAT_ID=file-chat\n');
    expect(await resolveTelegramConfig(home, {}, deps)).toEqual({ token: 'file-token', chatId: 'file-chat' });
    expect(await resolveTelegramConfig(home, env, deps)).toEqual({ token: 'legacy-token', chatId: 'legacy-chat' });
    await store.setSetting({ userId, key: 'telegram.bot_token', value: token, updatedAt: clock.now() });
    expect(await resolveTelegramConfig(home, env, deps)).toEqual({ token, chatId: 'legacy-chat' });
    await store.setSetting({ userId, key: 'telegram.chat_id', value: chatId, updatedAt: clock.now() });
    await rm(join(home, '.env'));
    expect(await resolveTelegramConfig(home, env, deps)).toEqual({ token, chatId });
    await store.setSetting({ userId, key: 'telegram.bot_token', value: '', updatedAt: clock.now() });
    expect(await resolveTelegramConfig(home, env, deps)).toEqual({ token: 'legacy-token', chatId });
    const broken = { ...deps, store: { ...store, getSettings: vi.fn(async () => ({ ok: false as const, code: 'DB_UNAVAILABLE' as const, message: 'private detail' })) } };
    await expect(resolveTelegramConfig(home, env, broken)).rejects.toThrow('Telegram DB 설정을 읽을 수 없습니다');
    expect(await resolveTelegramConfig(home, {})).toBeNull();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it('config stdin·마스킹과 무발신 채널 등록의 멱등성을 검증한다', async () => {
  const f = await channelFixture();
  const env = { ...withoutHarnessFolders(process.env), ...f.db.env, [HOME_ENV]: f.home };
  const cli = (...args: string[]) => runPgCommand(args, env);
  try {
    expect(JSON.parse((await cli('channels', 'add', 'telegram', '--json')).stdout)).toMatchObject({ ok: false, error: { code: 'CONFIG_INVALID' } });
    for (const json of [false, true]) {
      let stdout = '', stderr = '';
      const code = await dispatch(commands, ['config', 'set', 'telegram.bot_token', '-', ...(json ? ['--json'] : [])], {
        env, clock, runner: pgRunner, stdin: async () => token + '\n', stdout: line => { stdout += line; }, stderr: line => { stderr += line; },
      });
      expect(code).toBe(0); expect(stdout + stderr).not.toContain(token);
      if (json) expect(JSON.parse(stdout).data).toMatchObject({ key: 'telegram.bot_token', configured: true });
      const get = await cli('config', 'get', 'telegram.bot_token', ...(json ? ['--json'] : []));
      expect(get.code).toBe(0); expect(get.stdout + get.stderr).not.toContain(token);
      if (json) expect(JSON.parse(get.stdout).data).not.toHaveProperty('value');
    }
    expect((await cli('config', 'set', 'telegram.chat_id', chatId)).code).toBe(0);
    const beforeWork = await f.db.rows('select id from brain.work_items');
    const first = JSON.parse((await cli('channels', 'add', 'telegram', '--json')).stdout);
    const second = JSON.parse((await cli('channels', 'add', 'telegram', '--json')).stdout);
    expect(first).toMatchObject({ ok: true, data: { conversationId: expect.any(String) } });
    expect(second.data).toEqual(first.data);
    expect((await cli('channels', 'add', 'telegram')).stdout.trim()).toBe(first.data.conversationId);
    expect(await f.db.rows(`select external_ref, user_id from brain.channel_conversations where id='${first.data.conversationId}'`)).toEqual([{ external_ref: chatId, user_id: userId }]);
    expect(await f.db.rows(`select id from brain.channels where bot_ref='telegram'`)).toHaveLength(1);
    expect(await f.db.rows(`select id from brain.channel_conversations where external_ref='${chatId}'`)).toHaveLength(1);
    expect(await f.db.rows('select id from brain.channel_requests')).toEqual([]);
    expect(await f.db.rows('select id from brain.work_items')).toEqual(beforeWork);
    const doctor = await cli('doctor', 'run', '--json');
    expect(doctor.stdout + doctor.stderr).not.toContain(token);
    expect(f.requests).toEqual([]);
    const cleared = JSON.parse((await cli('config', 'set', 'telegram.bot_token', '', '--json')).stdout);
    expect(cleared.data).toMatchObject({ configured: false });
    const snapshot = createExtensionSnapshot({ extension: 'probe', userId, stage: 'work', declarations: [], settings: { 'telegram.bot_token': token }, secrets: {} });
    expect(snapshot.ok).toBe(true); expect(JSON.stringify(snapshot)).not.toContain(token);
  } finally { await f.close(); }
});

it('감독자는 DB 자격 증명을 기존 worker 환경 계약으로 전달하고 로그에 남기지 않는다', async () => {
  const f = await channelFixture();
  try {
    await f.store.setSetting({ userId, key: 'telegram.bot_token', value: token, updatedAt: clock.now() });
    await f.store.setSetting({ userId, key: 'telegram.chat_id', value: chatId, updatedAt: clock.now() });
    await f.db.query(`update brain.channel_conversations set external_ref='${chatId}'`);
    await f.store.createChannelRequest(f.input);
    await f.start(true);
    await expect.poll(() => f.store.readChannelStatus(f.input.id), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent' } });
    expect(f.requests[0]?.url).toContain(`/bot${token}/sendMessage`);
    expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ chat_id: chatId });
    await f.stop();
    const log = await readFile(join(f.home, 'log', 'daemon.log'), 'utf8');
    expect(log).not.toContain(token);
  } finally { await f.close(); }
}, 30000);


it.each(['telegram.bot_token', 'telegram.chat_id'] as const)('%s 조회 실패는 비밀 없는 재시도 결과로 남고 같은 감독자가 회복한다', async key => {
  const f = await channelFixture();
  try {
    await f.store.setSetting({ userId, key: 'telegram.bot_token', value: token, updatedAt: clock.now() });
    await f.store.setSetting({ userId, key: 'telegram.chat_id', value: chatId, updatedAt: clock.now() });
    await f.db.query(`update brain.channel_conversations set external_ref='${chatId}'`);
    await f.store.createChannelRequest(f.input);
    f.setTelegramSettingsFailure(key);
    await f.start(true);
    await expect.poll(() => f.db.rows('select outcome,error_code,retryable from brain.channel_attempt_results'), { timeout: 15000 })
      .toMatchObject([{ outcome: 'definite_failed', error_code: 'CHANNEL_CONFIG_LOOKUP_FAILED', retryable: true }]);
    expect(f.requests).toHaveLength(0);
    await expect.poll(() => f.db.rows<{ attempts: number; outcome: string | null; current_attempt_token: string | null }>("select attempts,outcome,current_attempt_token from brain.work_items where kind='channel_send'"), { timeout: 15000 })
      .toMatchObject([{ attempts: 1, outcome: null, current_attempt_token: null }]);
    f.setTelegramSettingsFailure(false);
    f.advance(3_600_000);
    await expect.poll(() => f.store.readChannelStatus(f.input.id), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent' } });
    expect(f.requests).toHaveLength(1);
    expect(f.requests[0]?.url).toContain(`/bot${token}/sendMessage`);
    await f.stop();
    const evidence = JSON.stringify(await f.db.rows('select * from brain.channel_attempt_results')) + await readFile(join(f.home, 'log', 'daemon.log'), 'utf8');
    expect(evidence).not.toContain(token);
    expect(evidence).not.toContain('synthetic-private-detail');
  } finally { await f.close(); }
}, 30000);

it('설정이 실제로 없으면 영구 실패하고 HTTP 요청을 보내지 않는다', async () => {
  const f = await channelFixture();
  try {
    await f.store.createChannelRequest(f.input);
    await f.start(false);
    await expect.poll(() => f.db.rows('select outcome,error_code,retryable from brain.channel_attempt_results'), { timeout: 15000 })
      .toMatchObject([{ outcome: 'definite_failed', error_code: 'CHANNEL_CONFIG_INVALID', retryable: false }]);
    expect(f.requests).toHaveLength(0);
    await expect.poll(() => f.db.rows("select outcome from brain.work_items where kind='channel_send'"), { timeout: 15000 }).toMatchObject([{ outcome: 'failed' }]);
  } finally { await f.close(); }
}, 30000);


it('잘못된 DB 설정은 원인을 보존하고 영구 실패한다', async () => {
  const f = await channelFixture();
  try {
    await f.store.setSetting({ userId, key: 'telegram.bot_token', value: 'bad-secret-format', updatedAt: clock.now() });
    await f.store.createChannelRequest(f.input); await f.start(true);
    await expect.poll(() => f.db.rows('select outcome,error_code,retryable from brain.channel_attempt_results'), { timeout: 15000 })
      .toMatchObject([{ outcome: 'definite_failed', error_code: 'CHANNEL_CONFIG_INVALID', retryable: false }]);
    await expect.poll(() => f.db.rows("select outcome from brain.work_items where kind='channel_send'"), { timeout: 15000 }).toMatchObject([{ outcome: 'failed' }]);
    expect(f.requests).toHaveLength(0); await f.stop();
    expect(await readFile(join(f.home, 'log', 'daemon.log'), 'utf8')).not.toContain('bad-secret-format');
  } finally { await f.close(); }
}, 30000);

it.each(['legacy-token', 'messenger-token', 'messenger-missing'] as const)('전역 조회 장애 중 %s 자격 증명 우선순위', async scenario => {
  const f = await channelFixture();
  try {
    const [channel] = await f.db.rows<{ channel_id: string }>(`select channel_id from brain.channel_conversations where id='${f.input.conversationId}'`);
    if (scenario !== 'legacy-token') await f.db.query(`update brain.channels set bot_ref='messenger:${channel!.channel_id}' where id='${channel!.channel_id}'`);
    if (scenario !== 'messenger-missing') {
      const configured = await f.store.channelControl!.configureMessenger({ messengerId: channel!.channel_id, kind: 'telegram', token: 'separate-token' });
      expect(configured.ok).toBe(true);
    }
    f.setTelegramSettingsFailure(true); await f.store.createChannelRequest(f.input); await f.start(true);
    if (scenario === 'messenger-missing') {
      await expect.poll(() => f.db.rows('select error_code,retryable from brain.channel_attempt_results'), { timeout: 15000 }).toMatchObject([{ error_code: 'CHANNEL_CONFIG_INVALID', retryable: false }]);
      expect(f.requests).toHaveLength(0);
    } else {
      await expect.poll(() => f.store.readChannelStatus(f.input.id), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent' } });
      expect(f.requests).toHaveLength(1); expect(f.requests[0]?.url).toContain('/botseparate-token/sendMessage');
    }
  } finally { await f.close(); }
}, 30000);

it('같은 감독자는 성공 후 새 요청의 설정 장애를 다시 조회한다', async () => {
  const f = await channelFixture();
  try {
    await f.store.createChannelRequest(f.input); await f.start(true);
    await expect.poll(() => f.store.readChannelStatus(f.input.id), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent' } });
    f.setTelegramSettingsFailure(true);
    const second = { ...f.input, id: f.ids.next(), purpose: 'second' };
    await f.store.createChannelRequest(second);
    await expect.poll(() => f.db.rows(`select error_code,retryable from brain.channel_attempt_results where request_id='${second.id}'`), { timeout: 15000 }).toMatchObject([{ error_code: 'CHANNEL_CONFIG_LOOKUP_FAILED', retryable: true }]);
    expect(f.requests).toHaveLength(1);
    await expect.poll(() => f.db.rows(`select current_attempt_token from brain.work_items where target_id='${second.id}'`), { timeout: 15000 }).toMatchObject([{ current_attempt_token: null }]);
    f.setTelegramSettingsFailure(false); f.advance(3_600_000);
    await expect.poll(() => f.store.readChannelStatus(second.id), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent' } });
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);
