import { afterEach, expect, it, vi } from 'vitest';
import { BUSY_TIMEOUT_MS, SQLITE_SCHEMA_VERSION } from 'second_brain';
import { memorySchemaStore, memoryStore } from 'second_brain/testing';
import type { ReadConfigResult } from '../src/config/codec.js';

const config = (pg = false): ReadConfigResult => ({ ok: true, warnings: [], config: {
  schemaVersion: 1, storePath: '/brain/brain.db', filesPath: '/brain/files', mirrorPath: '/brain/mirror', updateAuto: true,
  ...(pg ? { storeUrlEnv: 'CUSTOM_DATABASE_URL' } : {}),
} });
afterEach(() => { vi.doUnmock('second_brain/postgres'); vi.resetModules(); });

it.each(['turn', 'command', 'drain'] as const)('opens SQLite with its %s lock budget without importing PostgreSQL', async path => {
  const imported = vi.fn(() => { throw new Error('PostgreSQL must not load in a SQLite home'); });
  vi.doMock('second_brain/postgres', imported);
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  const store = { ...memoryStore(), ...memorySchemaStore() };
  const createSqliteStore = vi.fn(() => store);
  const opened = await openBrainStore({ home: '/brain', env: {}, config: config(), path, createSqliteStore });
  expect(opened).toEqual({ kind: 'sqlite', store, expected: { core: SQLITE_SCHEMA_VERSION } });
  expect(createSqliteStore).toHaveBeenCalledWith({ path: '/brain/brain.db', busyTimeoutMs: BUSY_TIMEOUT_MS[path] });
  expect(imported).not.toHaveBeenCalled();
});

it.each(['turn', 'command', 'drain'] as const)('selects PostgreSQL and passes the %s path to its connection factory', async path => {
  const store = { ...memoryStore(), ...memorySchemaStore() };
  const postgresStore = vi.fn(() => store);
  vi.doMock('second_brain/postgres', () => ({ postgresStore, EXPECTED_SCHEMA_VERSIONS: { core: 1 } }));
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  const createSqliteStore = vi.fn(() => store);
  const opened = await openBrainStore({ home: '/brain', env: { CUSTOM_DATABASE_URL: 'postgresql://example/brain' }, config: config(true), path, lockTimeoutMs: 2000, createSqliteStore });
  expect(opened).toEqual({ kind: 'postgres', store, expected: { core: 1 } });
  expect(postgresStore).toHaveBeenCalledWith({ databaseUrl: 'postgresql://example/brain', path, lockTimeoutMs: 2000 });
  expect(createSqliteStore).not.toHaveBeenCalled();
});

it.each([undefined, ''])('uses an unreachable URL when the configured environment value is %s', async value => {
  const store = { ...memoryStore(), ...memorySchemaStore() };
  const postgresStore = vi.fn(() => store);
  vi.doMock('second_brain/postgres', () => ({ postgresStore, EXPECTED_SCHEMA_VERSIONS: { core: 1 } }));
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  await openBrainStore({ home: '/nonexistent-brain', env: { CUSTOM_DATABASE_URL: value, PGHOST: 'unexpected' }, config: config(true), path: 'turn', createSqliteStore: () => store });
  expect(postgresStore).toHaveBeenCalledWith({ databaseUrl: 'postgresql://invalid@127.0.0.1:1/unavailable', path: 'turn' });
});

it('uses the explicit SQLite drain lock budget and diagnostic failed-config store', async () => {
  const { openBrainStore } = await import('../src/runtime/brain-store.js');
  const store = { ...memoryStore(), ...memorySchemaStore() };
  const createSqliteStore = vi.fn(() => store);
  await openBrainStore({ home: '/brain', env: {}, config: config(), path: 'drain', lockTimeoutMs: 2000, createSqliteStore });
  expect(createSqliteStore).toHaveBeenCalledWith({ path: '/brain/brain.db', busyTimeoutMs: 2000 });
  createSqliteStore.mockClear();
  const failed = await openBrainStore({ home: '/brain', env: {}, config: { ok: false, code: 'CONFIG_MISSING', message: 'missing' }, path: 'command', createSqliteStore });
  expect(await failed.store.readSchemaVersions()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(createSqliteStore).not.toHaveBeenCalled();
});
