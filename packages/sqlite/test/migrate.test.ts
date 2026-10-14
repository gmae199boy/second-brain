import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { fixedClock } from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

const MIGRATIONS = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));
const BROKEN = fileURLToPath(new URL('./fixtures/broken/', import.meta.url));

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-migrate-'));
  directories.push(directory);
  return directory;
}

/** Table names in the file, so a rollback can be checked from outside. */
function tables(path: string): string[] {
  const database = new DatabaseSync(path);
  try {
    return database
      .prepare(`select name from sqlite_master where type = 'table' order by name`)
      .all()
      .map((row) => String(row.name));
  } finally {
    database.close();
  }
}

describe('runSqliteMigrations on a folder that is not there yet', () => {
  it('creates the file, turns on write-ahead logging and applies every file in order', async () => {
    const path = join(await scratch(), 'brain.db');
    expect(existsSync(path)).toBe(false);

    const result = await runSqliteMigrations({ path, directory: MIGRATIONS });

    expect(result).toEqual({
      ok: true,
      from: 0,
      to: 2,
      applied: ['0001_initial.sql', '0002_tags.sql'],
    });
    expect(existsSync(path)).toBe(true);
    expect(tables(path)).toEqual(['notes', 'schema_version', 'tags']);

    // Write-ahead logging is a property of the file, so a store that opens it
    // afterwards finds it already on (AD-7).
    const store = sqliteStore({ path });
    try {
      const health = await store.checkHealth();
      expect(health.ok).toBe(true);
      if (!health.ok) return;
      expect(health.source.probes.find((probe) => probe.id === 'wal')).toMatchObject({ ok: true });
    } finally {
      await store.close();
    }
  });

  it('applies nothing the second time', async () => {
    const path = join(await scratch(), 'brain.db');
    expect((await runSqliteMigrations({ path, directory: MIGRATIONS })).ok).toBe(true);

    const again = await runSqliteMigrations({ path, directory: MIGRATIONS });

    expect(again).toEqual({ ok: true, from: 2, to: 2, applied: [] });
  });

  it('records applied_at as canonical UTC text from the clock it was given', async () => {
    const path = join(await scratch(), 'brain.db');
    const instant = new Date('2026-10-14T01:02:03.004Z');

    expect(
      (await runSqliteMigrations({ path, directory: MIGRATIONS, clock: fixedClock(instant) })).ok,
    ).toBe(true);

    const database = new DatabaseSync(path);
    try {
      const row = database.prepare('select version, applied_at from schema_version').get();
      expect(row?.version).toBe(2);
      // Text, in the one spelling the codec accepts (AD-13).
      expect(row?.applied_at).toBe('2026-10-14T01:02:03.004Z');
    } finally {
      database.close();
    }
  });
});

describe('runSqliteMigrations on a file whose statements are refused', () => {
  it('names the file, rolls it back whole and leaves the version where it was', async () => {
    const path = join(await scratch(), 'brain.db');

    const result = await runSqliteMigrations({ path, directory: BROKEN });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('MIGRATION_FAILED');
    if (result.code !== 'MIGRATION_FAILED') return;
    expect(result.file).toBe('0002_half.sql');
    expect(result.message.length).toBeGreaterThan(0);

    // The first file took effect; the second left nothing behind, not even the
    // table its first statement created.
    expect(tables(path)).toEqual(['notes', 'schema_version']);

    const store = sqliteStore({ path });
    try {
      const stored = await store.readSchemaVersion();
      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.version?.version).toBe(1);
    } finally {
      await store.close();
    }
  });
});

describe('runSqliteMigrations on a folder it cannot use', () => {
  it('throws for a folder that is not there, because that is a packaging bug', async () => {
    const path = join(await scratch(), 'brain.db');

    await expect(
      runSqliteMigrations({ path, directory: join(await scratch(), 'nowhere') }),
    ).rejects.toThrow();
    // It failed before opening anything, so no half-made database is left.
    expect(existsSync(path)).toBe(false);
  });

  it('reports a run with no files as reaching version 0', async () => {
    const directory = await scratch();
    const path = join(await scratch(), 'brain.db');
    expect(await readdir(directory)).toEqual([]);

    // The check against a `SCHEMA_VERSION` arrives with the first real
    // migration in story 11; until then an empty folder is simply empty.
    expect(await runSqliteMigrations({ path, directory })).toEqual({
      ok: true,
      from: 0,
      to: 0,
      applied: [],
    });
    expect(existsSync(path)).toBe(true);
  });
});
