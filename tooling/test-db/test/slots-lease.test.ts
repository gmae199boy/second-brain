import { expect, it } from 'vitest';
import { acquireSlotDatabase, validateSlotLease, type SlotLease } from '../src/slots/lease.js';
import { fixtureRunLabels, type TestDatabase } from '../src/index.js';
const id = 'f'.repeat(64);
const lease: SlotLease = { runId: 'run', slotId: 'slot', fileId: 'file', containerId: id, port: 32768, url: 'postgres://postgres:password@127.0.0.1:32768/postgres' };
const docker = async () => ({ stdout: JSON.stringify({ Id: id, Config: { Labels: { 'brain.test-run': 'run', 'brain.test-slot': 'slot' } }, NetworkSettings: { Ports: { '5432/tcp': [{ HostIp: '127.0.0.1', HostPort: '32768' }] } } }) });
const db = (): TestDatabase => ({ url: 'db', appUrl: 'app', maintenanceUrl: 'maintenance', async query() {}, async rows() { return []; }, async drop() {} });
it('rejects malformed lease fields, unsafe ports, URLs and ownership', async () => {
  for (const value of [{ ...lease, port: 54329 }, { ...lease, port: 54320 }, { ...lease, containerId: 'short' }, { ...lease, url: 'postgres://u:p@localhost:32768/postgres' }, { ...lease, fileId: '' }]) {
    await expect(validateSlotLease('x', { read: async () => JSON.stringify(value), docker })).rejects.toThrow();
  }
  await expect(validateSlotLease('x', { read: async () => JSON.stringify(lease), docker: async () => ({ stdout: '{}' }) })).rejects.toThrow();
});
it('falls back while occupied and returns lease after successful drop', async () => {
  let isolated = 0, created = 0;
  const deps = { read: async () => JSON.stringify(lease), docker, boundary: async () => ({ clean: true }), create: async () => { created++; return db(); }, isolated: async () => { isolated++; return db(); } };
  const first = await acquireSlotDatabase('x', deps);
  expect(first.fixtureDatabaseDropped).toBe(false); expect(first.fixtureContainerRemoved).toBeUndefined();
  await acquireSlotDatabase('x', deps); expect(isolated).toBe(1);
  await first.drop(); expect(first.fixtureDatabaseDropped).toBe(true); expect(first.fixtureContainerRemoved).toBeUndefined();
  const second = await acquireSlotDatabase('x', deps); expect(created).toBe(2); await second.drop();
});
it('falls back on an unclean boundary and labels isolated fixtures only when supplied', async () => {
  let isolated = 0;
  const deps = { read: async () => JSON.stringify(lease), docker, boundary: async () => ({ clean: false }), create: async () => db(), isolated: async () => { isolated++; return db(); } };
  await acquireSlotDatabase('x', deps); expect(isolated).toBe(1);
  expect(fixtureRunLabels({})).toEqual([]);
  expect(fixtureRunLabels({ BRAIN_TEST_RUN_ID: 'r', BRAIN_TEST_SLOT_ID: 's', BRAIN_TEST_FILE_ID: 'f' })).toEqual(['--label', 'brain.test-run=r', '--label', 'brain.test-slot=s', '--label', 'brain.test-file=f']);
});

it('retains the lease when database drop fails', async () => {
  let fallback = 0, attempts = 0;
  const item = db(); item.drop = async () => { if (++attempts === 1) throw new Error('drop failed'); };
  const deps = { read: async () => JSON.stringify(lease), docker, boundary: async () => ({ clean: true }), create: async () => item, isolated: async () => { fallback++; return db(); } };
  const first = await acquireSlotDatabase('x', deps);
  await expect(first.drop()).rejects.toThrow('drop failed'); expect(first.fixtureDatabaseDropped).toBe(false);
  await acquireSlotDatabase('x', deps); expect(fallback).toBe(1);
  await first.drop(); expect(first.fixtureDatabaseDropped).toBe(true);
});
