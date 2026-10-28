import { createConnection, createServer, type Socket } from 'node:net';
import { expect, it } from 'vitest';
import type { IngestAttachment } from '@second-brain/core';
import { sampleEnsureSessionInput, sampleSelfUserInput, sampleIngestBatch, sampleWorkInput, sampleSessionKey } from '@second-brain/core/testing';
import { postgresStore, type PostgresStore } from '../src/index.js';
import { database, clock } from './fixture.js';

/** Forward PG frames until the server confirms COMMIT, then discard that reply. */
async function loseCommitReply(databaseUrl: string) {
  const target = new URL(databaseUrl);
  const sockets = new Set<Socket>();
  let dropped = false;
  const server = createServer(client => {
    const upstream = createConnection({ host: target.hostname, port: Number(target.port) });
    sockets.add(client); sockets.add(upstream);
    let startup = true, armed = false;
    let incoming = Buffer.alloc(0), outgoing = Buffer.alloc(0);
    client.on('data', chunk => {
      incoming = Buffer.concat([incoming, chunk]);
      while (incoming.length >= (startup ? 4 : 5)) {
        const size = incoming.readInt32BE(startup ? 0 : 1) + (startup ? 0 : 1);
        if (incoming.length < size) break;
        const frame = incoming.subarray(0, size); incoming = incoming.subarray(size);
        if (startup) startup = false;
        else if (frame[0] === 81 || frame[0] === 80) {
          const text = frame.subarray(5).toString('utf8');
          if (/(^|\0)commit(?:;)?\0/i.test(text)) armed = true;
        }
        upstream.write(frame);
      }
    });
    upstream.on('data', chunk => {
      outgoing = Buffer.concat([outgoing, chunk]);
      while (outgoing.length >= 5) {
        const size = outgoing.readInt32BE(1) + 1;
        if (outgoing.length < size) break;
        const frame = outgoing.subarray(0, size); outgoing = outgoing.subarray(size);
        if (armed && frame[0] === 67 && frame.subarray(5).toString('utf8') === 'COMMIT\0') {
          dropped = true; client.destroy(); upstream.destroy(); return;
        }
        client.write(frame);
      }
    });
    client.on('error', () => upstream.destroy()); upstream.on('error', () => client.destroy());
    client.on('close', () => { sockets.delete(client); upstream.destroy(); });
    upstream.on('close', () => { sockets.delete(upstream); client.destroy(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no proxy port');
  const url = new URL(databaseUrl); url.hostname = '127.0.0.1'; url.port = String(address.port);
  return { url: url.toString(), dropped: () => dropped, async close() {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
const batch = sampleIngestBatch();
const attachment: IngestAttachment = {
  id: '01940000-0000-7000-8000-000000000881', harnessMessageId: batch.messages[0]!.harnessMessageId,
  ordinal: 0, sourceKind: 'file', sourceRef: 'fixture.txt', displayName: 'fixture.txt',
  file: { id: '01940000-0000-7000-8000-000000000882', contentHash: 'sha256:' + 'c'.repeat(64), sizeBytes: 1,
    location: { id: '01940000-0000-7000-8000-000000000883', storeKind: 'local', ownership: 'brain', locator: 'cc/cc/fixture.txt' },
    external: null },
};
const writes = {
  ingest: (store: PostgresStore) => store.ingest({ ...batch, attachments: [attachment] }),
  addWork: (store: PostgresStore) => store.addWork(sampleWorkInput()),
  linkAttachments: (store: PostgresStore) => store.linkAttachments({ key: sampleSessionKey, attachments: [attachment], linkedAt: clock.now() }),
};

it.each(['ingest', 'addWork', 'linkAttachments'] as const)('replays %s after the commit reply is lost and ends with the rows of one write', async verb => {
  const control = await database(), interrupted = await database();
  const stores: PostgresStore[] = [];
  const proxy = await loseCommitReply(interrupted.appUrl);
  const open = (url: string) => { const s = postgresStore({ databaseUrl: url }); stores.push(s); return s; };
  try {
    for (const db of [control, interrupted]) {
      const store = open(db.appUrl);
      expect((await store.ensureSelfUser(sampleSelfUserInput())).ok).toBe(true);
      expect((await store.ensureSession(sampleEnsureSessionInput())).ok).toBe(true);
      if (verb === 'linkAttachments') expect((await store.ingest(batch)).ok).toBe(true);
      await store.close();
    }
    expect((await writes[verb](open(control.appUrl))).ok).toBe(true);
    expect(await writes[verb](open(proxy.url))).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(proxy.dropped()).toBe(true);
    expect((await writes[verb](open(interrupted.appUrl))).ok).toBe(true);
    const tables = await control.rows<{ tablename: string }>("select tablename from pg_tables where schemaname='brain' order by tablename");
    for (const { tablename } of tables) {
      const query = `select count(*)::int as n from brain."${tablename}"`;
      expect(await interrupted.rows(query), tablename).toEqual(await control.rows(query));
    }
  } finally {
    await Promise.all(stores.map(s => s.close()));
    await proxy.close(); await interrupted.drop(); await control.drop();
  }
});
