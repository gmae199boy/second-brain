import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresStore } from 'second_brain/postgres';
import { pgHome } from './pg-home.js';
import { runDaemon } from '../src/daemon/run.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { localFileStore } from '../src/runtime/file-store.js';
import { writeConfig } from '../src/config/codec.js';
import { withoutHarnessFolders } from './environment.js';

/** 각 시험이 소유하는 가짜 서버, 데몬, 데이터베이스와 홈이다. */
export async function channelFixture(initialMode: 'hold' | 'success' | 'null-id' | 'disconnect' | '429' | '400' | '500' | 'broken' | 'bad-ok' = 'success') {
  const home = await mkdtemp(join(tmpdir(), 'brain-channel-'));
  const db = await pgHome(home);
  const filesPath = join(home, 'custom-files');
  const configuredFiles = await writeConfig(home, { filesPath });
  if (!configuredFiles.ok) throw Error(configuredFiles.message);
  const files = localFileStore({ root: filesPath });
  const store = postgresStore({ databaseUrl: db.appUrl });
  let mode = initialMode;
  let timeMs = Date.now();
  const barriers: string[] = [];
  const requests: { url: string; body: string; bytes: Buffer; contentType: string }[] = [];
  let disconnectAt: number | undefined;
  const waiting: ServerResponse[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => { chunks.push(chunk); });
    request.on('end', () => {
      const bytes = Buffer.concat(chunks); const body = bytes.toString('utf8');
      if (request.url?.startsWith('/test-barrier/')) { barriers.push(request.url); if (barriers.length === 1) waiting.push(response); else response.end(); return; }
      requests.push({ url: request.url ?? '', body, bytes, contentType: request.headers['content-type'] ?? '' });
      if (disconnectAt === requests.length) { disconnectAt = undefined; request.socket.destroy(); return; }
      if (mode === 'disconnect') { request.socket.destroy(); return; }
      if (mode === '429') { response.writeHead(429).end(JSON.stringify({ parameters: { retry_after: 7 } })); return; }
      if (mode === '400' || mode === '500') { response.writeHead(Number(mode)).end(); return; }
      if (mode === 'broken' || mode === 'bad-ok') { response.writeHead(200).end(mode === 'broken' ? '{' : '{\"ok\":false}'); return; }
      if (mode === 'hold') { waiting.push(response); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: mode === 'null-id' ? {} : request.url?.endsWith('/sendMediaGroup') ? [{ message_id: 987 }, { message_id: 988 }] : { message_id: 987 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('시험 서버 주소가 없습니다');
  let controller = new AbortController();
  let running: ReturnType<typeof runDaemon> | undefined;
  const ids = uuidV7IdGen();
  const channelId = ids.next();
  const conversationId = ids.next();
  const now = new Date(timeMs);
  const producerId = ids.next();
  const sessionId = ids.next();
  await db.query(`insert into brain.sessions (id,harness,harness_session_id,user_id,machine,started_at,ingest_source) select '${sessionId}','test','${sessionId}',id,'test',now(),'import' from brain.users limit 1`);
  await db.query(`insert into brain.messages (id,session_id,harness_message_id,role,body,occurred_at) values ('${producerId}','${sessionId}','test-result','assistant','생산자 결과',now())`);
  await store.ensureChannel({ id: channelId, kind: 'telegram', botRef: 'test-bot' });
  await store.ensureChannelConversation({ id: conversationId, channelId, externalRef: 'test-chat', threadRef: '12' });
  const input = { id: ids.next(), conversationId, producer: 'test-producer', producerResultId: producerId, purpose: 'notice', revision: null, text: 'password: secret123456', createdAt: now };
  return {
    db, store, files, home, input, requests, ids, barriers, endpoint: `http://127.0.0.1:${address.port}`, now: () => new Date(timeMs),
    disconnectOnRequest(number: number) { disconnectAt = number; },
    setMode(value: typeof mode) { mode = value; },
    async offline() { await new Promise<void>(resolve => server.close(() => resolve())); },
    async online() { await new Promise<void>(resolve => server.listen(address.port, '127.0.0.1', resolve)); },
    advance(ms: number) { timeMs += ms; },
    async producer() { const rows = await db.rows(`select * from brain.messages where id='${producerId}'`); return { rows, hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') }; },
    async start(configured = true, barrier?: 'before-finish' | 'after-finish') {
      if (controller.signal.aborted) controller = new AbortController();
      timeMs = Math.max(timeMs, Date.now());
      running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...db.env,
        BRAIN_TELEGRAM_BOT_TOKEN: configured ? 'test-token' : '', BRAIN_TELEGRAM_CHAT_ID: configured ? 'test-chat' : '' },
        clock: { now: () => new Date(timeMs) }, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100,
        supervisor: { pollMs: 25, ...(barrier ? { channelTestBarrier: barrier } : {}), channelTestEndpoint: `http://127.0.0.1:${address.port}` } });
    },
    async stop() { controller.abort(); await running; running = undefined; },
    release() {
      for (const response of waiting.splice(0)) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { message_id: 987 } }));
    },
    async close() {
      for (const response of waiting.splice(0)) response.destroy();
      controller.abort();
      await running;
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await store.close();
      await db.drop();
      await rm(home, { recursive: true, force: true });
    },
  };
}
