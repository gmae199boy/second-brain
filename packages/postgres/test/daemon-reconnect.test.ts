import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConnection, createServer, type Socket } from 'node:net';
import type { FSWatcher, WatchListener } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { sampleSelfUserInput } from '@second-brain/core/testing';
import { dispatch } from '../../../apps/cli/dist/dispatch.js';
import { commands } from '../../../apps/cli/dist/commands/index.js';
import * as configCodec from '../../../apps/cli/dist/config/codec.js';
import { runDaemon } from '../../../apps/cli/dist/daemon/run.js';
import { uuidV7IdGen } from '../../../apps/cli/dist/runtime/id-gen.js';
import type { CommandRunner } from '../../../apps/cli/src/runtime/command-runner.js';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';
import { closedPort } from './closed-port.js';

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.restoreAllMocks(); });
const clock = { now: () => new Date() };
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(ready: () => Promise<boolean> | boolean) {
  const until = Date.now() + 10_000;
  while (!await ready()) { if (Date.now() > until) throw new Error('복구를 기다리다 시간이 지났습니다'); await delay(10); }
}
async function world(url: string) {
  const home = await mkdtemp(join(tmpdir(), 'brain-pg-reconnect-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, 'postgres')); await mkdir(join(home, 'claude'));
  await writeFile(join(home, 'config.toml'), 'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
  await writeFile(join(home, 'postgres', 'compose.yaml'), '# runner fixture\n');
  const env = { ...process.env, SECOND_BRAIN_HOME: home, BRAIN_DATABASE_URL: url,
    CLAUDE_CONFIG_DIR: join(home, 'claude'), CODEX_HOME: join(home, 'codex'), GEMINI_CLI_HOME: join(home, 'gemini') };
  const calls: number[] = [];
  const runner: CommandRunner = async () => { calls.push(Date.now()); return { ok: true, stdout: '', stderr: '' }; };
  async function command(args: string[], commandRunner = runner) {
    let stdout = ''; let stderr = '';
    const exit = await dispatch(commands, [...args, '--json'], { env, clock, runner: commandRunner,
      stdin: async () => JSON.stringify({ session_id: 'pg-daemon', transcript_path: fileURLToPath(new URL('../../claude-code/test/fixtures/two-turns.jsonl', import.meta.url)), hook_event_name: 'Stop' }),
      stdout: (s: string) => { stdout += s; }, stderr: (s: string) => { stderr += s; } });
    if (!stdout) throw new Error(stderr);
    return { exit, envelope: JSON.parse(stdout) };
  }
  return { home, env, calls, runner, command };
}
it('restarts the stopped database with backoff, ignores wake-ups, and drains the spool into PG once it is back', async () => {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl });
  try { expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true); } finally { await store.close(); }
  const port = await closedPort();
  const target = new URL(db.appUrl); const forwarded = new URL(db.appUrl); forwarded.hostname = '127.0.0.1'; forwarded.port = String(port);
  const kit = await world(forwarded.href);
  const hook = await kit.command(['sessions', 'ingest', 'claude-code']);
  expect(hook.envelope).toMatchObject({ ok: true, data: { spooled: true } }); expect(kit.calls).toHaveLength(0);
  const sockets = new Set<Socket>();
  const server = createServer(incoming => {
    const outgoing = createConnection({ host: target.hostname, port: Number(target.port || 5432) });
    for (const socket of [incoming, outgoing]) { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => { incoming.destroy(); outgoing.destroy(); }); }
    incoming.pipe(outgoing).pipe(incoming);
  });
  cleanup.push(async () => { for (const socket of sockets) socket.destroy(); if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())); });
  let listener: WatchListener<string> | undefined;
  const rounds = vi.spyOn(configCodec, 'readConfig');
  const controller = new AbortController();
  const finished = runDaemon({ home: kit.home, env: kit.env, clock, idGen: uuidV7IdGen(), signal: controller.signal,
    drainPauseMs: 1000, drainBudgetMs: 100, reconnectBackoffMs: { initial: 100, max: 200 }, watchBatchMs: 2,
    watch: (_folder: string, _options: { recursive: true }, onEvent: WatchListener<string>) => { listener = onEvent; return { on() { return this; }, close() {} } as unknown as FSWatcher; },
    runner: async request => {
      expect(request.command).toBe('docker'); expect(request.args.slice(-2)).toEqual(['up', '-d']);
      const result = await kit.runner(request);
      if (kit.calls.length === 3) await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
      return result;
    } });
  cleanup.push(async () => { controller.abort(); await finished; });
  const timer = setInterval(() => { listener?.('change', 'transcript.jsonl'); }, 5);
  cleanup.push(async () => clearInterval(timer));
  await waitFor(async () => (await db.rows("select id from brain.sessions where harness_session_id='pg-daemon'")).length === 1);
  expect(kit.calls).toHaveLength(3);
  expect(kit.calls[1]! - kit.calls[0]!).toBeGreaterThanOrEqual(100);
  expect(kit.calls[2]! - kit.calls[1]!).toBeGreaterThanOrEqual(200);
  expect(rounds.mock.calls.length - 1).toBeGreaterThan(kit.calls.length);
  await waitFor(async () => (await readdir(join(kit.home, 'spool'))).filter(n => n.endsWith('.jsonl') || n.endsWith('.claiming')).length === 0);
  await delay(400); expect(kit.calls).toHaveLength(3);
  controller.abort(); expect(await finished).toEqual({ ok: true });
  const log = await readFile(join(kit.home, 'log', 'daemon.log'), 'utf8');
  expect(log.match(/컨테이너를 다시 띄웁니다/g)).toHaveLength(1);
  expect(log.match(/데이터베이스에 다시 닿았습니다/g)).toHaveLength(1);
});
it('never starts the container from the hook or a command', async () => {
  const kit = await world(`postgresql://unused@127.0.0.1:${await closedPort()}/brain`);
  expect((await kit.command(['sessions', 'ingest', 'claude-code'])).envelope).toMatchObject({ ok: true, data: { spooled: true } });
  expect((await kit.command(['queue', 'drain'])).envelope).toMatchObject({ ok: false, error: { code: 'DB_UNAVAILABLE' } });
  expect(kit.calls).toHaveLength(0);
});
