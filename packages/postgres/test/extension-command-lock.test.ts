import { createServer, connect, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import { withExtensionInstallLock } from '../src/extension-install-lock.js';

it.each(['acquire', 'unlock'] as const)('bounds stalled command-lock %s and closes its owned socket', async phase => {
  const source = new URL(process.env['BRAIN_TEST_DATABASE_URL']!);
  const targetHost = source.hostname, targetPort = Number(source.port || 5432);
  const sockets = new Set<Socket>(); let querySeen!: () => void, socketClosed!: () => void;
  const seen = new Promise<void>(resolve => { querySeen = resolve; });
  const closed = new Promise<void>(resolve => { socketClosed = resolve; });
  const proxy = createServer(client => {
    sockets.add(client); const upstream = connect(targetPort, targetHost); sockets.add(upstream);
    let text = '', block = false;
    client.on('data', data => { text = (text + data.toString('utf8')).slice(-8192); if (text.includes(phase === 'acquire' ? 'pg_try_advisory_lock' : 'pg_advisory_unlock')) { block = true; querySeen(); } upstream.write(data); });
    upstream.on('data', data => { if (!block) client.write(data); });
    client.on('close', () => { sockets.delete(client); upstream.destroy(); socketClosed(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
    client.on('error', () => {}); upstream.on('error', () => {});
  });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const address = proxy.address(); if (!address || typeof address === 'string') throw new Error('missing proxy port');
  source.hostname = '127.0.0.1'; source.port = String(address.port);
  const controller = new AbortController(); let ran = false;
  const pending = withExtensionInstallLock(source.toString(), 'testext', async () => { ran = true; return true; }, controller.signal, { queryTimeoutMs: 100 });
  const observed = pending.then(() => 'success', () => 'failure');
  try {
    expect(await Promise.race([seen.then(() => 'seen'), new Promise(resolve => setTimeout(() => resolve('late'), 5000))])).toBe('seen');
    if (phase === 'acquire') controller.abort();
    expect(await Promise.race([observed, new Promise(resolve => setTimeout(() => resolve('late'), 5000))])).toBe('failure');
    expect(ran).toBe(phase === 'unlock');
    expect(await Promise.race([closed.then(() => 'closed'), new Promise(resolve => setTimeout(() => resolve('late'), 3000))])).toBe('closed');
  } finally { controller.abort(); for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => proxy.close(() => resolve())); await observed; }
}, 15000);
