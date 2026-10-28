import { afterEach, expect, it, vi } from 'vitest';
import { memorySchemaStore, memoryStore } from 'second_brain/testing';
import type { ReadConfigResult } from '../src/config/codec.js';
const adapterProbeIds = ['adapter-probe'];
const config: ReadConfigResult = { ok: true, warnings: [], config: {
  schemaVersion: 1, storeUrlEnv: 'BRAIN_DATABASE_URL', legacySqlitePath: '/brain/brain.db',
  filesPath: '/brain/files', mirrorPath: '/brain/mirror', updateAuto: true,
} };
afterEach(() => { vi.doUnmock('second_brain/postgres'); vi.resetModules(); });
it.each(['turn', 'command', 'drain'] as const)('passes the %s path and lock budget to PostgreSQL', async path => {
  const store = { ...memoryStore(), ...memorySchemaStore() };
  const postgresStore = vi.fn(() => store);
  vi.doMock('second_brain/postgres', () => ({ postgresStore, EXPECTED_SCHEMA_VERSIONS: { core: 1 }, POSTGRES_DOCTOR_PROBE_IDS: adapterProbeIds }));
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  const opened = await openBrainStore({ home: '/brain', env: { BRAIN_DATABASE_URL: 'postgresql://example/brain' }, config, path, lockTimeoutMs: 2000 });
  expect(opened).toEqual({ store, expected: { core: 1 }, adapterProbeIds });
  expect(postgresStore).toHaveBeenCalledWith({ databaseUrl: 'postgresql://example/brain', path, lockTimeoutMs: 2000 });
});
it.each([undefined, ''])('uses an unreachable URL when the environment value is %s', async value => {
  const postgresStore = vi.fn(() => memoryStore());
  vi.doMock('second_brain/postgres', () => ({ postgresStore, EXPECTED_SCHEMA_VERSIONS: { core: 1 }, POSTGRES_DOCTOR_PROBE_IDS: adapterProbeIds }));
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  await openBrainStore({ home: '/nonexistent-brain', env: { BRAIN_DATABASE_URL: value }, config, path: 'turn' });
  expect(postgresStore).toHaveBeenCalledWith({ databaseUrl: 'postgresql://invalid@127.0.0.1:1/unavailable', path: 'turn' });
});
it('returns all unavailable capabilities without loading PG for an unreadable configuration', async () => {
  const imported = vi.fn(() => { throw new Error('unexpected import'); });
  vi.doMock('second_brain/postgres', imported);
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  const opened = await openBrainStore({ home: '/brain', env: {}, config: { ok: false, code: 'CONFIG_INVALID', message: 'broken' }, path: 'command' });
  for (const result of [await opened.store.checkHealth(), await opened.store.readSchemaVersions(), await opened.store.getSetting({ key: 'timezone' }), await opened.store.setSetting({ key: 'timezone', value: 'Asia/Seoul', updatedAt: new Date() })]) expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(imported).not.toHaveBeenCalled();
});
