import { spawn } from 'node:child_process';
import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { BUSY_TIMEOUT_MS } from '@second-brain/core';
import { schemaStoreContract, storeContract } from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

const MIGRATIONS = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));
const LOCK_HOLDER = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));

/**
 * A second **process** holding the database-wide write lock. It has to be
 * another process: `node:sqlite` is synchronous, so two connections in this one
 * would wait on a lock nothing can release.
 */
async function holdLock(path: string, holdMs: number): Promise<{ done: Promise<void> }> {
  const child = spawn(process.execPath, [LOCK_HOLDER, path, String(holdMs)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });

  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('the lock holder never took the lock')),
      10_000,
    );
    child.stdout.once('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  return { done };
}

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
        'writable',
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
      expect(health.source.probes.filter((probe) => probe.ok)).toHaveLength(3);
    } finally {
      await store.close();
    }
  });
});

describe('sqliteStore probing a database file nobody may write', () => {
  it('fails the writable probe, passes the others, and leaves no table behind', async () => {
    const path = await emptyDatabase();
    // The file alone, not the folder: this is the case `pragma journal_mode`
    // cannot see, because SQLite only refuses at the first page it touches.
    await chmod(path, 0o444);

    const store = sqliteStore({ path });
    try {
      const health = await store.checkHealth();

      expect(health.ok).toBe(true);
      if (!health.ok) return;
      const writable = health.source.probes.find((probe) => probe.id === 'writable');
      expect(writable?.ok).toBe(false);
      expect(writable?.detail ?? '').not.toBe('');
      // The failure is about writing, so nothing else may be dragged down with
      // it: reading the file still works.
      expect(health.source.probes.filter((probe) => !probe.ok)).toHaveLength(1);
    } finally {
      await store.close();
      // Restored before the folder is removed, and before the table is looked
      // for: a 0444 database is one `rm -r` cannot always take away. The
      // sidecars too — SQLite gave them the database's own mode.
      for (const suffix of ['', '-wal', '-shm']) {
        await chmod(`${path}${suffix}`, 0o600).catch(() => {});
      }
    }

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const tables = database
        .prepare(`select name from sqlite_master where name = 'brain_probe_writable'`)
        .all();
      expect(tables).toEqual([]);
    } finally {
      database.close();
    }
  });

  it('passes the writable probe against a file it may write, and still makes no table', async () => {
    const path = await emptyDatabase();
    const store = sqliteStore({ path });
    try {
      const health = await store.checkHealth();

      expect(health.ok).toBe(true);
      if (!health.ok) return;
      expect(health.source.probes.find((probe) => probe.id === 'writable')).toMatchObject({
        ok: true,
      });
    } finally {
      await store.close();
    }

    const database = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        database
          .prepare(`select name from sqlite_master where name = 'brain_probe_writable'`)
          .all(),
      ).toEqual([]);
    } finally {
      database.close();
    }
  });
});

describe('sqliteStore probing a database another process is writing to', () => {
  it('answers the writable probe ok, promptly, rather than waiting for the lock', async () => {
    const path = join(await scratch(), 'brain.db');
    expect((await runSqliteMigrations({ path, directory: MIGRATIONS })).ok).toBe(true);
    const holder = await holdLock(path, 2000);

    try {
      // The command budget, which is what a real `admin doctor` runs with: the
      // probe must not spend it waiting for somebody else's write.
      const store = sqliteStore({ path, busyTimeoutMs: BUSY_TIMEOUT_MS.command });
      try {
        const startedAt = Date.now();
        const health = await store.checkHealth();
        const waited = Date.now() - startedAt;
        console.log(`[measured] hold 2000ms, command budget -> checkHealth in ${waited}ms`);

        expect(health.ok).toBe(true);
        if (!health.ok) return;
        const writable = health.source.probes.find((probe) => probe.id === 'writable');
        // A brain in use is not a brain that cannot be written to.
        expect(writable?.ok).toBe(true);
        expect(writable?.detail).toContain('write lock');
        // It did not wait for the holder, and it did not wait for its budget.
        expect(waited).toBeLessThan(1000);
      } finally {
        await store.close();
      }
    } finally {
      await holder.done;
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
