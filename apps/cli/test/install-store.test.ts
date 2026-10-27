import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { SQLITE_SCHEMA_VERSION } from 'second_brain';
import { isUuidV7 } from 'second_brain/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config/codec.js';
import { runtimeChecks } from '../src/doctor/checks.js';
import {
  doctorAt,
  prepareFilesRoot,
  prepareSelfUser,
  prepareStore,
  storeFileExists,
} from '../src/install/store.js';
import { writeShim } from '../src/install/shim.js';
import { tempHomes } from './temp-home.js';

/** The built entry point, which is the one a shim the installer wrote names. */
const distBin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

/** Every check `doctorAt` reports on a finished install, in order. */
const ALL_CHECKS = [
  'db',
  'writable',
  'wal',
  'fts5-trigram',
  'foreign-keys',
  'schema-version',
  'failures',
  'untagged',
  'transcripts',
  'config',
  'shim',
  'node-path',
  'node-version',
  'plugin',
      'last-hook',
  'spool',
  'daemon',
];

/**
 * The installer's filesystem half, against the real filesystem: the modes the
 * database file and the file store's root have to end up at, and that a second
 * run applies nothing. Nothing here is mocked — the modes are the point, and a
 * fake filesystem would prove nothing about them.
 */

const temporary = tempHomes();

async function scratch(): Promise<string> {
  const directory = await temporary.create('brain-install-store-');
  return directory;
}

/** The permission bits of one path, as the three octal digits people read. */
async function mode(path: string): Promise<string> {
  return ((await stat(path)).mode & 0o777).toString(8);
}

afterEach(() => temporary.cleanup());

beforeAll(() => {
  if (!existsSync(distBin)) {
    throw new Error(`${distBin} does not exist. Run \`pnpm build\` before these tests.`);
  }
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

  it('refuses a file that is not a database, leaving its mode and bytes alone', async () => {
    const directory = await scratch();
    const path = join(directory, 'brain.db');
    await writeFile(path, 'this is not a SQLite database\n', 'utf8');
    await chmod(path, 0o644);

    const result = await prepareStore(path);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The header is read before the `open` and the `chmod`, so one mistyped
    // `--store-path` cannot change the mode of somebody else's file or leave a
    // write-ahead log beside it (F4).
    expect(result.code).toBe('DB_UNAVAILABLE');
    expect(result.message.split('\n')).toHaveLength(1);
    expect(await mode(path)).toBe('644');
    expect(await readFile(path, 'utf8')).toBe('this is not a SQLite database\n');
    expect(await readdir(directory)).toEqual(['brain.db']);
  });

  it('takes a file of zero bytes for a new database and migrates it', async () => {
    const path = join(await scratch(), 'brain.db');
    // What an interrupted run leaves behind: `open(path, 'a')` made the file
    // and the migrations had not started. It has no header yet and it is ours.
    await writeFile(path, '', 'utf8');

    const result = await prepareStore(path);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.to).toBe(SQLITE_SCHEMA_VERSION);
    expect(await mode(path)).toBe('600');
  });

  it('refuses a file it cannot read, rather than tightening and migrating it', async () => {
    const path = join(await scratch(), 'brain.db');
    await writeFile(path, 'not a database\n', 'utf8');
    // Ours, and write-only: the header cannot be read, so whether this is a
    // database is unknown — and a `chmod` to 0600 followed by a migration
    // would be this code changing a file it never managed to look at.
    await chmod(path, 0o200);

    const result = await prepareStore(path);

    expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await mode(path)).toBe('200');
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it('refuses a file whose first bytes are too few to be a header', async () => {
    const path = join(await scratch(), 'brain.db');
    await writeFile(path, 'short', 'utf8');

    const result = await prepareStore(path);

    expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    expect(await readFile(path, 'utf8')).toBe('short');
  });
});

describe('storeFileExists', () => {
  it('tells a database that is there from one that is not, and from a folder', async () => {
    const directory = await scratch();
    const path = join(directory, 'brain.db');

    expect(await storeFileExists(path)).toBe(false);
    expect((await prepareStore(path)).ok).toBe(true);
    expect(await storeFileExists(path)).toBe(true);
    // A folder is not a file to migrate, so the screen that asks must not say
    // it will migrate one.
    expect(await storeFileExists(directory)).toBe(false);
  });
});

describe('prepareSelfUser', () => {
  /** Every `users` row of a database, as SQLite holds them. */
  function users(path: string): Record<string, unknown>[] {
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      return database.prepare('select id, name, is_self from users').all() as Record<
        string,
        unknown
      >[];
    } finally {
      database.close();
    }
  }

  it('records one owner, with a UUIDv7 and the account it ran as', async () => {
    const path = join(await scratch(), 'brain.db');
    expect((await prepareStore(path)).ok).toBe(true);

    const result = await prepareSelfUser(path);

    expect(result).toMatchObject({ ok: true, created: true });
    const rows = users(path);
    expect(rows).toHaveLength(1);
    expect(isUuidV7(String(rows[0]?.id))).toBe(true);
    expect(rows[0]?.is_self).toBe(1);
    if (!result.ok) return;
    expect(rows[0]?.name).toBe(result.name);
    expect(result.name).not.toBe('');
  });

  it('keeps the first owner on a second run, id and all', async () => {
    const path = join(await scratch(), 'brain.db');
    expect((await prepareStore(path)).ok).toBe(true);
    expect((await prepareSelfUser(path)).ok).toBe(true);
    const before = users(path);

    const again = await prepareSelfUser(path);

    // This is the row a database copied from another machine arrives with:
    // the owner is decided once, by the install that made it (AD-12).
    expect(again).toMatchObject({ ok: true, created: false });
    expect(users(path)).toEqual(before);
  });

  it('says why rather than throwing when there is no database to record it in', async () => {
    const result = await prepareSelfUser(join(await scratch(), 'brain.db'));

    expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
    if (result.ok) return;
    expect(result.message).not.toBe('');
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
  it('reports installed checks and warns before daemon registration', async () => {
    const home = await scratch();
    const path = join(home, 'brain.db');
    await prepareStore(path);
    await writeConfig(home, {});
    // The built entry point, because these tests import `src/`, where
    // `cliEntryPath()` would name a file that is not there.
    await writeShim(home, { bin: distBin });

    const report = await doctorAt(home, path);

    expect(report.checks.map((check) => check.id)).toEqual(ALL_CHECKS);
    // Transcript folders are not enabled here, and daemon registration follows doctor.
    const failed = report.checks.filter(
      (check) => check.status !== 'ok' && check.id !== 'transcripts' && check.id !== 'daemon',
    );
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(report.checks.find((check) => check.id === 'daemon')).toMatchObject({ status: 'warn' });
    expect(report.checks.find((check) => check.id === 'transcripts')?.status).toBe('skip');
  });

  it('reports db as DB_UNAVAILABLE, and creates nothing, when the file is not there', async () => {
    const directory = await scratch();
    const path = join(directory, 'brain.db');

    const report = await doctorAt(directory, path);

    // Nothing was probed, so no probe is reported; the schema version is a
    // `skip` that names why, and the machine checks still ran.
    expect(report.checks[0]).toMatchObject({ id: 'db', status: 'fail', code: 'DB_UNAVAILABLE' });
    expect(report.checks[1]).toEqual({
      id: 'schema-version',
      status: 'skip',
      detail: '앞선 점검 실패: db',
    });
    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'schema-version',
      'failures',
      'untagged',
      'transcripts',
      'config',
      'shim',
      'node-path',
      'node-version',
      'plugin',
      'last-hook',
      'spool',
      'daemon',
    ]);
    // The counts are the report's own, so they cannot disagree with it.
    expect(report.summary.failed).toBe(
      report.checks.filter((check) => check.status === 'fail').length,
    );
    expect(report.summary.skipped).toBe(
      report.checks.filter((check) => check.status === 'skip').length,
    );
    // Not the database, not its log, not its shared memory, and not a
    // configuration folder either: a probe that made what it was looking for
    // would report a brain nobody installed.
    expect(await readdir(directory)).toEqual([]);
  });

  it('takes its machine checks from the registry, not from a second list', async () => {
    // One list, two callers (story 8): the installer's last step and
    // `brain doctor run` have to agree on what was checked, or an install
    // that ends green is no promise about the command that follows it. The
    // dispatcher's end of this is asserted the same way in `doctor-run`.
    const registered = runtimeChecks({ home: '/nowhere' }).map((source) => source.id);
    expect(registered).toEqual([
      'config',
      'shim',
      'node-path',
      'node-version',
      'plugin',
      'last-hook',
      'spool',
      'daemon',
    ]);

    const home = await scratch();
    const report = await doctorAt(home, join(home, 'brain.db'));

    expect(report.checks.slice(-registered.length).map((check) => check.id)).toEqual(registered);
  });
});
