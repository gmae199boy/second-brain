import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { userStoreContract } from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/connect.js';
import { SQLITE_MIGRATIONS_DIRECTORY, runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';

/**
 * The identity capability against the file this package writes: the contract,
 * and the two things only a real database can be held to — that the schema is
 * what refuses a second owner, and that a database too old to have the table
 * says so rather than claiming there is no owner.
 */

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-users-'));
  directories.push(directory);
  return directory;
}

/** A fresh file brought up to the version this package ships. */
async function migratedPath(): Promise<string> {
  const path = join(await scratch(), 'brain.db');
  const migrated = await runSqliteMigrations({ path });
  expect(migrated.ok).toBe(true);
  return path;
}

/**
 * A file that stopped at version 2, the way an install from before this story
 * did: only the first two migration files, copied into a folder of this test's
 * own. A folder the caller names is not held to `SQLITE_SCHEMA_VERSION`, which
 * is how the tests reach it.
 */
async function versionTwoPath(): Promise<string> {
  const directory = await scratch();
  for (const name of ['0001_initial.sql', '0002_files_and_work.sql']) {
    await copyFile(join(SQLITE_MIGRATIONS_DIRECTORY, name), join(directory, name));
  }
  const path = join(await scratch(), 'brain.db');
  expect(await runSqliteMigrations({ path, directory })).toEqual({
    ok: true,
    from: 0,
    to: 2,
    applied: ['0001_initial.sql', '0002_files_and_work.sql'],
  });
  return path;
}

const OWNER = {
  id: '01940000-0000-7000-8000-00000000000a',
  name: 'brain-owner',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
};

describe('the identity contract against the SQLite store', () => {
  for (const testCase of userStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => sqliteStore({ path: await migratedPath() }));
    });
  }
});

describe('the SQLite identity store', () => {
  it('stores the owner as the one is_self row, with the instant it was given', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(OWNER)).ok).toBe(true);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // Text, in the one spelling the codec produces, and 1 rather than true:
      // SQLite has neither type (AD-13).
      expect(opened.connection.database.prepare('select * from users').all()).toEqual([
        {
          id: OWNER.id,
          name: OWNER.name,
          is_self: 1,
          created_at: '2026-01-01T00:00:00.000Z',
        },
      ]);
    } finally {
      await opened.connection.close();
    }
  });

  it('is the database, not this code, that refuses a second owner', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      expect((await store.ensureSelfUser(OWNER)).ok).toBe(true);
    } finally {
      await store.close();
    }

    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // A plain insert, going round `ensureSelfUser` on purpose: what is being
      // checked is the partial unique index of migration 0003, because a rule
      // only this code remembers is a rule the next caller can forget (AD-12).
      expect(() =>
        opened.connection.database
          .prepare(
            `insert into users (id, name, is_self, created_at)
                  values (?, ?, 1, '2026-01-01T00:00:00.000Z')`,
          )
          .run('01940000-0000-7000-8000-00000000000b', 'somebody-else'),
      ).toThrow(/UNIQUE/i);

      // Somebody who is not the owner is allowed in, which is why the index is
      // partial: epic 5's import brings other people's rows.
      opened.connection.database
        .prepare(
          `insert into users (id, name, is_self, created_at)
                values (?, ?, 0, '2026-01-01T00:00:00.000Z')`,
        )
        .run('01940000-0000-7000-8000-00000000000c', 'somebody-else');
      expect(
        opened.connection.database.prepare('select count(*) as n from users').get()?.n,
      ).toBe(2);
    } finally {
      await opened.connection.close();
    }
  });

  it('upgrades a version 2 database to the current one, keeping its rows and adding the key', async () => {
    const path = await versionTwoPath();

    const before = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(before.ok).toBe(true);
    if (!before.ok) return;
    const configs = before.connection.database
      .prepare('select id, kind from index_configs order by id')
      .all();
    await before.connection.close();

    expect(await runSqliteMigrations({ path })).toEqual({
      ok: true,
      from: 2,
      to: 6,
      applied: [
        '0003_users.sql',
        '0004_capture_columns.sql',
        '0005_identity_and_records.sql',
        '0006_drop_message_seq.sql',
      ],
    });

    const after = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    try {
      // The rows the earlier migrations wrote are untouched: 0003 rebuilds
      // `sessions` and nothing else.
      expect(
        after.connection.database.prepare('select id, kind from index_configs order by id').all(),
      ).toEqual(configs);
      expect(after.connection.database.prepare('select count(*) as n from users').get()?.n).toBe(
        0,
      );
      // The point of the whole migration: the column now points somewhere.
      expect(
        after.connection.database
          .prepare(`select "table", "from", "to" from pragma_foreign_key_list('sessions')`)
          .all(),
      ).toEqual(
        expect.arrayContaining([{ table: 'users', from: 'user_id', to: 'id' }]),
      );
      expect(after.connection.database.prepare('pragma foreign_key_check').all()).toEqual([]);
    } finally {
      await after.connection.close();
    }

    // And an owner can be recorded against it, which is what the install step
    // does next.
    const store = sqliteStore({ path });
    try {
      expect(await store.ensureSelfUser(OWNER)).toMatchObject({ ok: true, created: true });
    } finally {
      await store.close();
    }
  });

  it('reports a database too old to have the table as unreachable, not owner-less', async () => {
    // A real version 2 database: the file is there, it opens, and the query is
    // what it refuses. An owner-less database sends the caller to `brain setup
    // run`; a database at the wrong version is the write guard's to report
    // (AD-20), so answering `null` here would hide the second behind the first.
    const store = sqliteStore({ path: await versionTwoPath() });
    try {
      const read = await store.readSelfUser();
      expect(read).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
      if (read.ok) return;
      expect(read.message).toMatch(/users/);

      // The write, for the same reason: it is the schema that refuses it, not
      // this code throwing out of `withWrite`.
      expect(await store.ensureSelfUser(OWNER)).toMatchObject({
        ok: false,
        code: 'DB_UNAVAILABLE',
      });
    } finally {
      await store.close();
    }
  });
});
