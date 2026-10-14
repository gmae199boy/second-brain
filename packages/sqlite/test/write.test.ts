import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'kysely';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite, type SqliteConnection } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { withWrite } from '../src/write.js';

const MIGRATIONS = fileURLToPath(new URL('./fixtures/migrations/', import.meta.url));
const LOCK_HOLDER = fileURLToPath(new URL('./fixtures/lock-holder.mjs', import.meta.url));

const directories: string[] = [];
const connections: SqliteConnection[] = [];

afterEach(async () => {
  await Promise.all(connections.splice(0).map((connection) => connection.close()));
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A migrated database, so there is a `notes` table to write to. */
async function migratedPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-write-'));
  directories.push(directory);
  const path = join(directory, 'brain.db');
  const migration = await runSqliteMigrations({ path, directory: MIGRATIONS });
  expect(migration.ok).toBe(true);
  return path;
}

interface Opened {
  connection: SqliteConnection;
  /** Every statement the driver prepared, in order. */
  seen: string[];
}

function open(path: string, busyTimeoutMs = 3000): Opened {
  const seen: string[] = [];
  const opened = openSqlite({
    path,
    busyTimeoutMs,
    onQuery: (statement) => seen.push(statement),
  });
  if (!opened.ok) throw new Error(`could not open ${path}: ${opened.message}`);
  connections.push(opened.connection);
  return { connection: opened.connection, seen };
}

async function noteIds(connection: SqliteConnection): Promise<string[]> {
  const rows = await sql<{ id: string }>`select id from notes order by id`.execute(connection.db);
  return rows.rows.map((row) => row.id);
}

describe('withWrite', () => {
  it('opens the transaction with begin immediate and commits', async () => {
    const path = await migratedPath();
    const { connection, seen } = open(path);
    seen.length = 0;

    const result = await withWrite(connection, async (held) => {
      await sql`insert into notes (id, body) values ('a', 'one')`.execute(held);
      return 'written';
    });

    expect(result).toEqual({ ok: true, value: 'written' });
    // The whole point of not using Kysely's own `db.transaction()`: its SQLite
    // driver issues a bare `begin`, which is DEFERRED (AD-7).
    expect(seen[0]).toBe('begin immediate');
    expect(seen.at(-1)).toBe('commit');
    expect(await noteIds(connection)).toEqual(['a']);
  });

  it('rolls the transaction back and rethrows when the work throws', async () => {
    const path = await migratedPath();
    const { connection, seen } = open(path);

    const boom = new Error('boom');
    await expect(
      withWrite(connection, async (held) => {
        await sql`insert into notes (id, body) values ('b', 'two')`.execute(held);
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(seen).toContain('rollback');
    expect(seen).not.toContain('commit');
    expect(await noteIds(connection)).toEqual([]);
  });

  it('throws, after rolling back, when the database refuses a statement', async () => {
    const path = await migratedPath();
    const { connection } = open(path);

    // A constraint violation is the work's problem, not a lock: it throws, and
    // the transaction is gone.
    await withWrite(connection, async (held) => {
      await sql`insert into notes (id, body) values ('c', 'three')`.execute(held);
    });
    await expect(
      withWrite(connection, async (held) => {
        await sql`insert into notes (id, body) values ('c', 'again')`.execute(held);
      }),
    ).rejects.toThrow(/unique/i);

    expect(await noteIds(connection)).toEqual(['c']);
  });
});

describe('withWrite while another process holds the write lock', () => {
  it('answers DB_LOCKED after about the busy timeout when the hold outlasts it', async () => {
    const path = await migratedPath();
    const holder = await holdLock(path, 2000);

    try {
      const { connection } = open(path, 500);
      const startedAt = Date.now();
      const result = await withWrite(connection, async (held) => {
        await sql`insert into notes (id, body) values ('late', 'late')`.execute(held);
      });
      const waited = Date.now() - startedAt;
      // Measured, not assumed: this is the number AD-7's budgets are chosen
      // against, and the only way to know it is to run two processes.
      console.log(`[measured] hold 2000ms, busy timeout 500ms -> DB_LOCKED after ${waited}ms`);

      expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED' });
      if (result.ok) return;
      expect(result.message.length).toBeGreaterThan(0);
      // It waited for its budget, and not for the holder.
      expect(waited).toBeGreaterThanOrEqual(400);
      expect(waited).toBeLessThan(1800);
    } finally {
      await holder.done;
    }
  });

  it('waits and then succeeds when the hold is shorter than the busy timeout', async () => {
    const path = await migratedPath();
    const holder = await holdLock(path, 400);

    try {
      const { connection } = open(path, 5000);
      const startedAt = Date.now();
      const result = await withWrite(connection, async (held) => {
        await sql`insert into notes (id, body) values ('after', 'after')`.execute(held);
      });
      const waited = Date.now() - startedAt;
      console.log(`[measured] hold 400ms, busy timeout 5000ms -> committed after ${waited}ms`);

      expect(result.ok).toBe(true);
      expect(waited).toBeGreaterThanOrEqual(200);
      expect(waited).toBeLessThan(5000);
      // Both writes are there: the holder's and this one's.
      expect(await noteIds(connection)).toEqual(['after', 'held']);
    } finally {
      await holder.done;
    }
  });
});

describe('the redaction marker', () => {
  /**
   * The shape AD-11 needs: a trigger that refuses an update unless the marker
   * is up, and a marker only `withWrite` may raise.
   */
  async function guarded(): Promise<SqliteConnection> {
    const { connection } = open(await migratedPath());
    connection.database.exec(`
      insert into notes (id, body) values ('m1', 'original');
      create trigger notes_immutable before update on notes
      begin
        select case when brain_redact_allowed() = 1 then null
                    else raise(abort, 'immutable') end;
      end;
    `);
    return connection;
  }

  async function rename(connection: SqliteConnection, redact: boolean): Promise<unknown> {
    return withWrite(
      connection,
      async (held) => {
        await sql`update notes set body = 'redacted' where id = 'm1'`.execute(held);
      },
      { redact },
    );
  }

  async function body(connection: SqliteConnection): Promise<string | undefined> {
    const rows = await sql<{ body: string }>`
      select body from notes where id = 'm1'
    `.execute(connection.db);
    return rows.rows[0]?.body;
  }

  it('refuses an ordinary write, passes a marked one, and refuses again after', async () => {
    const connection = await guarded();

    await expect(rename(connection, false)).rejects.toThrow(/immutable/);
    expect(await body(connection)).toBe('original');

    expect(await rename(connection, true)).toMatchObject({ ok: true });
    expect(await body(connection)).toBe('redacted');

    // The marker is a variable in this process, not a property of the
    // transaction, so the only thing keeping the original text safe is that
    // `withWrite` always puts it down again (NFR-1).
    expect(connection.isRedactAllowed()).toBe(false);
    await expect(rename(connection, false)).rejects.toThrow(/immutable/);
    expect(await body(connection)).toBe('redacted');
  });

  it('puts the marker down after a marked write that rolled back', async () => {
    const connection = await guarded();

    const boom = new Error('boom');
    await expect(
      withWrite(
        connection,
        async (held) => {
          await sql`update notes set body = 'redacted' where id = 'm1'`.execute(held);
          throw boom;
        },
        { redact: true },
      ),
    ).rejects.toBe(boom);

    expect(connection.isRedactAllowed()).toBe(false);
    expect(await body(connection)).toBe('original');
    await expect(rename(connection, false)).rejects.toThrow(/immutable/);
  });
});

/**
 * Start the holder and wait until it says it has the lock. Another process,
 * because `node:sqlite` is synchronous: a second connection in this process
 * would block the event loop the first one needs in order to let go.
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
    const timer = setTimeout(() => reject(new Error('the lock holder never took the lock')), 10_000);
    child.stdout.once('data', (chunk: Buffer) => {
      if (chunk.toString().includes('held')) {
        clearTimeout(timer);
        resolve();
      }
    });
  });

  return { done };
}
