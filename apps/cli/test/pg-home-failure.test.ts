import { stat } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { pgDatabaseUrl, pgHome } from './pg-home.js';
import { tempHomes } from './temp-home.js';

vi.mock('second_brain/postgres', () => ({
  prepareDatabase: async () => ({ ok: false, message: 'synthetic preparation failure' }),
  runMigrations: async () => { throw new Error('must not migrate'); },
  postgresStore: () => { throw new Error('must not open store'); },
}));
it('preserves a database and home when setup cleanup fails, then drops them on retry', async () => {
  const homes = tempHomes(), home = await homes.create('setup-drop-failed-'); let drops = 0;
  const db: TestDatabase = { url: 'postgres://synthetic@127.0.0.1/test', appUrl: 'synthetic', maintenanceUrl: 'synthetic', async query() {}, async rows() { return []; }, async drop() { if (++drops === 1) throw new Error('synthetic drop failure'); } };
  try {
    await expect(pgHome(home, false, async () => db)).rejects.toThrow('database setup and cleanup failed');
    expect(drops).toBe(1);
    expect(pgDatabaseUrl(home)).toBe(db.url); await expect(stat(home)).resolves.toBeDefined();
    await homes.cleanup(); expect(drops).toBe(2); await expect(stat(home)).rejects.toThrow();
    expect(pgDatabaseUrl(home)).toContain('unavailable');
  } finally { await homes.cleanup(); }
});
