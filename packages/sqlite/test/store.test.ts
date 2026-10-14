import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { schemaStoreContract, storeContract } from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

const MIGRATIONS = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** An empty folder, so nothing in a test reaches a real brain. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-'));
  directories.push(directory);
  return directory;
}

/**
 * A database file with nothing in it, created the way the installer would:
 * a plain path, write-ahead logging on. `openSqlite` cannot do this, which is
 * the point — only the migration runner creates.
 */
async function emptyDatabase(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const database = new DatabaseSync(path);
  database.exec('pragma journal_mode = WAL');
  database.close();
  return path;
}

describe('sqliteStore against a path that holds no file', () => {
  it('answers DB_UNAVAILABLE and creates nothing at all', async () => {
    const directory = await scratch();
    const path = join(directory, 'brain.db');
    const store = sqliteStore({ path });

    try {
      const health = await store.checkHealth();
      expect(health.ok).toBe(false);
      if (health.ok) return;
      expect(health.code).toBe('DB_UNAVAILABLE');
      expect(health.message.length).toBeGreaterThan(0);

      const stored = await store.readSchemaVersion();
      expect(stored).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });

      // Not the database, not its write-ahead log, not its shared-memory file.
      // A probe that creates what it was looking for would report a healthy
      // brain to somebody who has not installed one (AD-20).
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await store.close();
    }
  });

  describe('and the health contract', () => {
    for (const testCase of storeContract()) {
      it(testCase.name, async () => {
        const path = join(await scratch(), 'brain.db');
        await testCase.run(async () => sqliteStore({ path }));
      });
    }
  });

  describe('and the schema contract', () => {
    for (const testCase of schemaStoreContract()) {
      it(testCase.name, async () => {
        const path = join(await scratch(), 'brain.db');
        await testCase.run(async () => sqliteStore({ path }));
      });
    }
  });
});

describe('sqliteStore against an empty database', () => {
  it('reports the SQLite version, where the file is, and every probe', async () => {
    const path = await emptyDatabase();
    const store = sqliteStore({ path });

    try {
      const health = await store.checkHealth();

      expect(health.ok).toBe(true);
      if (!health.ok) return;
      expect(health.serverVersion).toMatch(/^\d+\.\d+/);
      expect(health.source.location).toBe(path);
      expect(health.source.probes.map((probe) => probe.id)).toEqual([
        'wal',
        'fts5-trigram',
        'foreign-keys',
      ]);
      for (const probe of health.source.probes) {
        expect(probe, `probe ${probe.id} failed: ${probe.detail ?? ''}`).toMatchObject({
          ok: true,
        });
      }
    } finally {
      await store.close();
    }
  });

  it('reports no schema version at all before the first migration ran', async () => {
    const store = sqliteStore({ path: await emptyDatabase() });

    try {
      expect(await store.readSchemaVersion()).toEqual({ ok: true, version: null });
    } finally {
      await store.close();
    }
  });

  describe('and the health contract', () => {
    for (const testCase of storeContract()) {
      it(testCase.name, async () => {
        const path = await emptyDatabase();
        await testCase.run(async () => sqliteStore({ path }));
      });
    }
  });

  describe('and the schema contract', () => {
    for (const testCase of schemaStoreContract()) {
      it(testCase.name, async () => {
        const path = await emptyDatabase();
        await testCase.run(async () => sqliteStore({ path }));
      });
    }
  });
});

describe('sqliteStore probing a database that is not in WAL', () => {
  it('fails the wal probe and says what the mode is instead', async () => {
    const path = join(await scratch(), 'brain.db');
    const database = new DatabaseSync(path);
    database.exec('pragma journal_mode = DELETE');
    database.close();

    const store = sqliteStore({ path });
    try {
      const health = await store.checkHealth();

      expect(health.ok).toBe(true);
      if (!health.ok) return;
      const wal = health.source.probes.find((probe) => probe.id === 'wal');
      expect(wal?.ok).toBe(false);
      expect(wal?.detail).toContain('delete');
      // One failed probe is not an unreachable database.
      expect(health.source.probes.filter((probe) => probe.ok)).toHaveLength(2);
    } finally {
      await store.close();
    }
  });
});

describe('sqliteStore against a migrated database', () => {
  it('reads the version the migration recorded', async () => {
    const path = join(await scratch(), 'brain.db');
    const migration = await runSqliteMigrations({ path, directory: MIGRATIONS });
    expect(migration.ok).toBe(true);

    const store = sqliteStore({ path });
    try {
      const stored = await store.readSchemaVersion();

      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.version?.version).toBe(2);
      expect(stored.version?.appliedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(stored.version?.appliedAt.getTime() ?? Number.NaN)).toBe(false);
    } finally {
      await store.close();
    }
  });

  it('refuses to read an applied_at that is not a canonical instant', async () => {
    const path = join(await scratch(), 'brain.db');
    expect((await runSqliteMigrations({ path, directory: MIGRATIONS })).ok).toBe(true);

    // Somebody opened `brain.db` with another tool and wrote a local time.
    const database = new DatabaseSync(path);
    database.exec(`update schema_version set applied_at = '2026-10-14 10:02:03+09:00'`);
    database.close();

    const store = sqliteStore({ path });
    try {
      const stored = await store.readSchemaVersion();

      expect(stored.ok).toBe(false);
      if (stored.ok) return;
      expect(stored.code).toBe('DB_UNAVAILABLE');
      expect(stored.message).toContain('applied_at');
    } finally {
      await store.close();
    }
  });

  describe('and the schema contract', () => {
    for (const testCase of schemaStoreContract()) {
      it(testCase.name, async () => {
        const path = join(await scratch(), 'brain.db');
        expect((await runSqliteMigrations({ path, directory: MIGRATIONS })).ok).toBe(true);
        await testCase.run(async () => sqliteStore({ path }));
      });
    }
  });
});
