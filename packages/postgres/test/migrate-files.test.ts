import { afterEach, expect, it, vi } from 'vitest';
import { createPool } from '../src/connect.js';
import { CORE_SCHEMA_VERSION, runMigrations } from '../src/migrate.js';

const files = vi.hoisted(() => ({ readdir: vi.fn<() => Promise<string[]>>(), readFile: vi.fn() }));
vi.mock('node:fs/promises', () => files);
vi.mock('../src/connect.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/connect.js')>(), createPool: vi.fn(),
}));
afterEach(() => vi.resetAllMocks());

it('rejects a shipped core folder ahead of CORE_SCHEMA_VERSION before connecting', async () => {
  const names = Array.from({ length: CORE_SCHEMA_VERSION + 1 }, (_, i) => `${String(i + 1).padStart(4, '0')}_initial.sql`);
  files.readdir.mockResolvedValue(names);
  files.readFile.mockResolvedValue('select 1;');
  expect(await runMigrations({ databaseUrl: 'invalid and never opened', clock: { now: () => new Date() } }))
    .toMatchObject({ ok: false, code: 'MIGRATION_FAILED', message: expect.stringContaining('CORE_SCHEMA_VERSION') });
  expect(createPool).not.toHaveBeenCalled();
});

it('rejects an empty shipped core folder before connecting', async () => {
  files.readdir.mockResolvedValue([]);
  expect(await runMigrations({ databaseUrl: 'invalid and never opened', clock: { now: () => new Date() } }))
    .toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(createPool).not.toHaveBeenCalled();
});
