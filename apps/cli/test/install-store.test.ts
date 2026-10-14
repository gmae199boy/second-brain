import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLITE_SCHEMA_VERSION } from 'second_brain';
import { afterEach, describe, expect, it } from 'vitest';
import { doctorAt, prepareFilesRoot, prepareStore } from '../src/install/store.js';

/**
 * The installer's filesystem half, against the real filesystem: the modes the
 * database file and the file store's root have to end up at, and that a second
 * run applies nothing. Nothing here is mocked — the modes are the point, and a
 * fake filesystem would prove nothing about them.
 */

const directories: string[] = [];

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-install-store-'));
  directories.push(directory);
  return directory;
}

/** The permission bits of one path, as the three octal digits people read. */
async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('prepareStore', () => {
  it('creates the file at 0600 and migrates it to the version this build ships', async () => {
    const path = join(await scratch(), 'brain.db');

    const result = await prepareStore(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.from).toBe(0);
    expect(result.to).toBe(SQLITE_SCHEMA_VERSION);
    expect(result.applied.length).toBeGreaterThan(0);
    expect(await mode(path)).toBe('600');
  });

  it('creates a parent folder that is not there at 0700', async () => {
    const path = join(await scratch(), 'nested', 'deeper', 'brain.db');

    const result = await prepareStore(path);

    expect(result.ok).toBe(true);
    expect(await mode(join(path, '..'))).toBe('700');
    expect(await mode(path)).toBe('600');
  });

  it('applies nothing the second time, and leaves the file where it is', async () => {
    const path = join(await scratch(), 'brain.db');
    const first = await prepareStore(path);
    expect(first.ok).toBe(true);

    const again = await prepareStore(path);

    expect(again).toMatchObject({
      ok: true,
      from: SQLITE_SCHEMA_VERSION,
      to: SQLITE_SCHEMA_VERSION,
      applied: [],
    });
    expect(await mode(path)).toBe('600');
  });

  it('tightens a database an earlier run left readable, rather than leaving it', async () => {
    const path = join(await scratch(), 'brain.db');
    await prepareStore(path);
    await chmod(path, 0o644);

    await prepareStore(path);

    expect(await mode(path)).toBe('600');
  });

  it('leaves every write-ahead sidecar at 0600 while a writer holds the file', async () => {
    const path = join(await scratch(), 'brain.db');
    await prepareStore(path);

    // A reader that starts a transaction keeps `-wal` and `-shm` on disk, which
    // is the state a hook writing on a turn leaves behind. SQLite's unix VFS
    // gives them the database file's mode, and this is where that is checked.
    const holder = new DatabaseSync(path);
    try {
      holder.exec('pragma journal_mode = WAL');
      holder.exec('begin immediate');
      holder.exec('commit');
      const sidecars = (await readdir(join(path, '..'))).filter((entry) =>
        entry.startsWith('brain.db-'),
      );
      expect(sidecars.length).toBeGreaterThan(0);
      for (const sidecar of sidecars) {
        expect(await mode(join(path, '..', sidecar))).toBe('600');
      }
    } finally {
      holder.close();
    }
  });

  it('answers DB_UNAVAILABLE rather than throwing when the path is a folder', async () => {
    const path = join(await scratch(), 'brain.db');
    await mkdir(path);

    const result = await prepareStore(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DB_UNAVAILABLE');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('answers MIGRATION_FAILED with one line when the file is not a database', async () => {
    const path = join(await scratch(), 'brain.db');
    await writeFile(path, 'this is not a SQLite database\n', 'utf8');

    const result = await prepareStore(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Open succeeds — SQLite only reads the header when a statement runs — so
    // the refusal comes from the runner, before the first migration file: the
    // file it names is empty because no file was in hand yet.
    expect(result.code).toBe('MIGRATION_FAILED');
    if (result.code !== 'MIGRATION_FAILED') return;
    expect(result.file).toBe('');
    expect(result.message.split('\n')).toHaveLength(1);
  });
});

describe('prepareFilesRoot', () => {
  it('creates the root at 0700 and says it made it', async () => {
    const path = join(await scratch(), 'files');

    const result = await prepareFilesRoot(path);

    expect(result).toEqual({ ok: true, path, created: true });
    expect(await mode(path)).toBe('700');
  });

  it('answers FILES_UNAVAILABLE rather than throwing when a file is in the way', async () => {
    // `--store-path <home>/files` on an earlier run leaves exactly this.
    const path = join(await scratch(), 'files');
    await writeFile(path, '', 'utf8');

    const result = await prepareFilesRoot(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('FILES_UNAVAILABLE');
    expect(result.message.length).toBeGreaterThan(0);
  });

  it('creates every folder on the way, and writes nothing into it (epic 2)', async () => {
    const path = join(await scratch(), 'nested', 'files');

    const result = await prepareFilesRoot(path);

    expect(result).toMatchObject({ ok: true, created: true });
    expect(await mode(path)).toBe('700');
    expect(await readdir(path)).toEqual([]);
  });

  it('says it created nothing the second time, and tightens a loose folder', async () => {
    const path = join(await scratch(), 'files');
    await prepareFilesRoot(path);
    await chmod(path, 0o755);

    const again = await prepareFilesRoot(path);

    expect(again).toEqual({ ok: true, path, created: false });
    expect(await mode(path)).toBe('700');
  });
});

describe('doctorAt', () => {
  it('reports every check as ok against a file the installer just prepared', async () => {
    const path = join(await scratch(), 'brain.db');
    await prepareStore(path);

    const report = await doctorAt(path);

    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'wal',
      'fts5-trigram',
      'foreign-keys',
    ]);
    expect(report.checks.every((check) => check.status === 'ok')).toBe(true);
  });

  it('reports db as DB_UNAVAILABLE, and creates nothing, when the file is not there', async () => {
    const directory = await scratch();
    const path = join(directory, 'brain.db');

    const report = await doctorAt(path);

    expect(report.checks).toHaveLength(1);
    expect(report.checks[0]).toMatchObject({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' });
    // Not the database, not its log, not its shared memory: a probe that made
    // what it was looking for would report a brain nobody installed.
    expect(await readdir(directory)).toEqual([]);
  });
});
