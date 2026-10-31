import { createServer, type ServerResponse } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { postgresStore } from 'second_brain/postgres';
import { pgHome } from './pg-home.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { withoutHarnessFolders } from './environment.js';

/** 각 시험이 소유하는 가짜 서버, 데몬, 데이터베이스와 홈이다. */
export async function channelFixture(mode: 'hold' | 'success' | 'null-id' | 'disconnect' | '429' = 'success') {
  const home = await mkdtemp(join(tmpdir(), 'brain-channel-'));
  const db = await pgHome(home);
  const store = postgresStore({ databaseUrl: db.appUrl });
  const requests: { url: string; body: string }[] = [];
  const waiting: ServerResponse[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => { body += chunk; });
    request.on('end', () => {
      requests.push({ url: request.url ?? '', body });
      if (mode === 'disconnect') { request.socket.destroy(); return; }
      if (mode === '429') { response.writeHead(429).end(); return; }
      if (mode === 'hold') { waiting.push(response); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: mode === 'null-id' ? {} : { message_id: 987 } }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw Error('시험 서버 주소가 없습니다');
  const controller = new AbortController();
  let running: ReturnType<typeof runDaemon> | undefined;
  const ids = uuidV7IdGen();
  const channelId = ids.next();
  const conversationId = ids.next();
  const now = new Date();
  await store.ensureChannel({ id: channelId, kind: 'telegram', botRef: 'test-bot' });
  await store.ensureChannelConversation({ id: conversationId, channelId, externalRef: 'test-chat', threadRef: '12' });
  const input = { id: ids.next(), conversationId, producer: 'test-producer', producerResultId: 'test-result', purpose: 'notice', revision: null, text: 'password: secret123456', createdAt: now };
  return {
    db, store, home, input, requests, ids,
    async start(configured = true) {
      running = runDaemon({ home, env: { ...withoutHarnessFolders(process.env), ...db.env,
        BRAIN_TELEGRAM_BOT_TOKEN: configured ? 'test-token' : '', BRAIN_TELEGRAM_CHAT_ID: configured ? 'test-chat' : '' },
        clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100,
        supervisor: { pollMs: 25, channelTestEndpoint: `http://127.0.0.1:${address.port}` } });
    },
    release() {
      for (const response of waiting.splice(0)) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result: { message_id: 987 } }));
    },
    async close() {
      for (const response of waiting.splice(0)) response.destroy();
      controller.abort();
      await running;
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await store.close();
      await db.drop();
      await rm(home, { recursive: true, force: true });
    },
  };
}
