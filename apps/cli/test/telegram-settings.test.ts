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
    await f.start(false);
    await expect.poll(() => f.store.readChannelStatus(f.input.id), { timeout: 15000 }).toMatchObject({ request: { delivery: 'sent' } });
    expect(f.requests[0]?.url).toContain(`/bot${token}/sendMessage`);
    expect(JSON.parse(f.requests[0]!.body)).toMatchObject({ chat_id: chatId });
    await f.stop();
    const log = await readFile(join(f.home, 'log', 'daemon.log'), 'utf8');
    expect(log).not.toContain(token);
  } finally { await f.close(); }
}, 30000);
