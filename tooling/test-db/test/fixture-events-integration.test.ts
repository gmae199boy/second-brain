import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import pg from 'pg';
import { createIsolatedTestDatabase, createTestDatabase } from '../src/index.js';

it('records owned isolated and shared database readiness and drop phases without connection strings', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'fixture-events-')), log = join(dir, 'events.jsonl');
  const previousUrl = process.env.BRAIN_TEST_DATABASE_URL, previousLog = process.env.BRAIN_TEST_METRICS_LOG;
  process.env.BRAIN_TEST_METRICS_LOG = log;
  process.env.BRAIN_TEST_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/postgres';
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined, shared: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    isolated = await createIsolatedTestDatabase();
    process.env.BRAIN_TEST_DATABASE_URL = isolated.url;
    shared = await createTestDatabase();
    await shared.drop(); shared = undefined;
    await isolated.drop(); isolated = undefined;
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { backend: string; phase: string; outcome: string; elapsedMs: number });
    for (const [backend, phase] of [['isolated', 'container-create'], ['isolated', 'container-start'], ['isolated', 'sql-ready'], ['isolated', 'database-create'], ['isolated', 'database-drop'], ['isolated', 'container-drop'], ['shared', 'sql-ready'], ['shared', 'database-create'], ['shared', 'database-drop']]) {
      expect(events.some(event => event.backend === backend && event.phase === phase && event.outcome === 'ok' && event.elapsedMs >= 0)).toBe(true);
    }
    expect(JSON.stringify(events)).not.toMatch(/postgres:\/\/|brain-fixture-test|select /i);
  } finally {
    try { await shared?.drop(); } finally { try { await isolated?.drop(); } finally {
      if (previousUrl === undefined) delete process.env.BRAIN_TEST_DATABASE_URL; else process.env.BRAIN_TEST_DATABASE_URL = previousUrl;
      if (previousLog === undefined) delete process.env.BRAIN_TEST_METRICS_LOG; else process.env.BRAIN_TEST_METRICS_LOG = previousLog;
      await rm(dir, { recursive: true, force: true });
    } }
  }
}, 60000);
it('uses one fixture identity for validated shared slot boundary, create and drop', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { randomBytes } = await import('node:crypto');
  const { createCluster, removeOwnedCluster } = await import('../src/slots/cluster.js');
  const { acquireTestDatabase } = await import('../src/index.js');
  const dir = await mkdtemp(join(tmpdir(), 'shared-slot-events-')), log = join(dir, 'events.jsonl'), leasePath = join(dir, 'lease.json');
  const oldLog = process.env.BRAIN_TEST_METRICS_LOG, oldLease = process.env.BRAIN_TEST_SLOT_LEASE;
  const runId = randomBytes(12).toString('hex'), fileId = randomBytes(10).toString('hex');
  process.env.BRAIN_TEST_METRICS_LOG = log;
  let cluster: Awaited<ReturnType<typeof createCluster>> | undefined, db: Awaited<ReturnType<typeof acquireTestDatabase>> | undefined;
  try {
    cluster = await createCluster(runId, 'slot', '0');
    await writeFile(log, '');
    await writeFile(leasePath, JSON.stringify({ runId, slotId: 'slot', fileId, containerId: cluster.id, port: cluster.port, url: cluster.url }));
    process.env.BRAIN_TEST_SLOT_LEASE = leasePath;
    db = await acquireTestDatabase(); await db.drop(); db = undefined;
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { phase: string; fixtureId: string });
    expect(events.filter(event => event.phase === 'sql-ready').length).toBeGreaterThanOrEqual(2);
    expect(events.some(event => event.phase === 'database-create')).toBe(true); expect(events.some(event => event.phase === 'database-drop')).toBe(true);
    expect(new Set(events.map(event => event.fixtureId)).size).toBe(1);
  } finally {
    try { await db?.drop(); } finally { try { if (cluster) await removeOwnedCluster(cluster); } finally {
      if (oldLease === undefined) delete process.env.BRAIN_TEST_SLOT_LEASE; else process.env.BRAIN_TEST_SLOT_LEASE = oldLease;
      if (oldLog === undefined) delete process.env.BRAIN_TEST_METRICS_LOG; else process.env.BRAIN_TEST_METRICS_LOG = oldLog;
      await rm(dir, { recursive: true, force: true });
    } }
  }
}, 90000);

it('records shared usage only for a shared backend, never for an isolated fixture', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'backend-marker-')), marker = join(dir, 'shared-db.jsonl');
  const previousDir = process.env.BRAIN_TEST_FILE_DIR, previousUrl = process.env.BRAIN_TEST_DATABASE_URL;
  process.env.BRAIN_TEST_FILE_DIR = dir;
  process.env.BRAIN_TEST_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/postgres';
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  let shared: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    isolated = await createIsolatedTestDatabase();
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    process.env.BRAIN_TEST_DATABASE_URL = isolated.url;
    shared = await createTestDatabase();
    const acquired = JSON.parse((await readFile(marker, 'utf8')).trim());
    expect(acquired).toMatchObject({ state: 'acquired', fixtureId: expect.stringMatching(/^[a-f0-9]{24}$/) });
    const name = new URL(shared.url).pathname.slice(1);
    const otherDir = await mkdtemp(join(tmpdir(), 'other-marker-'));
    try {
      process.env.BRAIN_TEST_FILE_DIR = otherDir;
      await shared.drop();
      await shared.drop();
      const rows = (await readFile(marker, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      expect(rows).toEqual([acquired, { state: 'released', fixtureId: acquired.fixtureId }]);
      expect(await isolated.rows(`select datname from pg_database where datname = '${name}'`)).toEqual([]);
      await expect(readFile(join(otherDir, 'shared-db.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
      shared = undefined;
    } finally { process.env.BRAIN_TEST_FILE_DIR = dir; await rm(otherDir, { recursive: true, force: true }); }
    await isolated.drop(); isolated = undefined;
  } finally {
    try { await shared?.drop(); } finally { try { await isolated?.drop(); } finally {
      if (previousDir === undefined) delete process.env.BRAIN_TEST_FILE_DIR; else process.env.BRAIN_TEST_FILE_DIR = previousDir;
      if (previousUrl === undefined) delete process.env.BRAIN_TEST_DATABASE_URL; else process.env.BRAIN_TEST_DATABASE_URL = previousUrl;
      await rm(dir, { recursive: true, force: true });
    } }
  }
}, 90000);

it('keeps an acquisition active when the release journal cannot be written', async () => {
  const { rename } = await import('node:fs/promises');
  const dir = await mkdtemp(join(tmpdir(), 'release-failure-')), moved = `${dir}-moved`;
  const previousDir = process.env.BRAIN_TEST_FILE_DIR, previousUrl = process.env.BRAIN_TEST_DATABASE_URL;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  try {
    process.env.BRAIN_TEST_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/postgres';
    isolated = await createIsolatedTestDatabase();
    process.env.BRAIN_TEST_FILE_DIR = dir; process.env.BRAIN_TEST_DATABASE_URL = isolated.url;
    const shared = await createTestDatabase();
    await rename(dir, moved);
    await expect(shared.drop()).rejects.toThrow();
    await expect(shared.drop()).rejects.toThrow();
    const rows = (await readFile(join(moved, 'shared-db.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(rows).toHaveLength(1); expect(rows[0].state).toBe('acquired');
    expect(await isolated.rows(`select datname from pg_database where datname = '${new URL(shared.url).pathname.slice(1)}'`)).toEqual([]);
  } finally {
    if (previousDir === undefined) delete process.env.BRAIN_TEST_FILE_DIR; else process.env.BRAIN_TEST_FILE_DIR = previousDir;
    if (previousUrl === undefined) delete process.env.BRAIN_TEST_DATABASE_URL; else process.env.BRAIN_TEST_DATABASE_URL = previousUrl;
    try { await isolated?.drop(); } finally { await rm(dir, { recursive: true, force: true }); await rm(moved, { recursive: true, force: true }); }
  }
}, 90000);

it('does not release a shared lease when the admin connection fails to close', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'close-failure-'));
  const previousDir = process.env.BRAIN_TEST_FILE_DIR, previousUrl = process.env.BRAIN_TEST_DATABASE_URL;
  let isolated: Awaited<ReturnType<typeof createIsolatedTestDatabase>> | undefined;
  let shared: Awaited<ReturnType<typeof createTestDatabase>> | undefined;
  try {
    process.env.BRAIN_TEST_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/postgres';
    isolated = await createIsolatedTestDatabase();
    process.env.BRAIN_TEST_FILE_DIR = dir; process.env.BRAIN_TEST_DATABASE_URL = isolated.url;
    shared = await createTestDatabase();
    const originalEnd = pg.Client.prototype.end;
    const spy = vi.spyOn(pg.Client.prototype, 'end').mockImplementationOnce(async function (this: pg.Client) {
      await (originalEnd as (this: pg.Client) => Promise<void>).call(this);
      throw new Error('injected close failure');
    });
    try { await expect(shared.drop()).rejects.toThrow('injected close failure'); } finally { spy.mockRestore(); }
    const marker = join(dir, 'shared-db.jsonl');
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(1);
    await shared.drop(); shared = undefined;
    expect((await readFile(marker, 'utf8')).trim().split('\n')).toHaveLength(2);
  } finally {
    try { await shared?.drop(); } finally { try { await isolated?.drop(); } finally {
      if (previousDir === undefined) delete process.env.BRAIN_TEST_FILE_DIR; else process.env.BRAIN_TEST_FILE_DIR = previousDir;
      if (previousUrl === undefined) delete process.env.BRAIN_TEST_DATABASE_URL; else process.env.BRAIN_TEST_DATABASE_URL = previousUrl;
      await rm(dir, { recursive: true, force: true });
    } }
  }
}, 90000);
