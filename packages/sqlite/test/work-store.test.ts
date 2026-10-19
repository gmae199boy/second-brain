import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUSY_TIMEOUT_MS,
  DRAIN_BUDGET_MS,
  drainQueue,
  failureFingerprint,
} from '@second-brain/core';
import { memorySpool, workStoreContract } from '@second-brain/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { openSqlite } from '../src/connect.js';
import { runSqliteMigrations } from '../src/migrate.js';
import { sqliteStore } from '../src/store.js';
import { claimCandidateQuery } from '../src/work.js';

/**
 * The queue capability against the file this package writes: the contract, the
 * plan the claim index of 0004 was shaped for, the column values a contract
 * cannot see, and two real processes draining the same database at once.
 */

const WORKER = fileURLToPath(new URL('./fixtures/drain-worker.mjs', import.meta.url));
const LOCK_HOLDER = fileURLToPath(new URL('./fixtures/schema-lock-holder.mjs', import.meta.url));

const NOW = new Date('2026-02-03T04:05:06.000Z');
const KIND = 'demo_work';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-sqlite-work-'));
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

/** Every row of `work_items` or `failures`, read without writing. */
function rows(path: string, table: 'work_items' | 'failures'): Record<string, unknown>[] {
  const opened = openSqlite({ path, busyTimeoutMs: 3000 });
  if (!opened.ok) throw new Error(opened.message);
  try {
    return opened.connection.database
      .prepare(`select * from ${table} order by id`)
      .all() as Record<string, unknown>[];
  } finally {
    void opened.connection.close();
  }
}

describe('the queue contract against the SQLite store', () => {
  for (const testCase of workStoreContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => sqliteStore({ path: await migratedPath() }));
    });
  }
});

describe('the claim query of the SQLite adapter', () => {
  it('is answered from the claim index, in its order, with no temporary sort', async () => {
    const path = await migratedPath();
    const opened = openSqlite({ path, busyTimeoutMs: 3000 });
    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    try {
      // The query the adapter actually sends, compiled rather than copied: a
      // condition added to the builder has to go on being answered from the
      // index, and a test holding its own SQL would go on proving the old plan
      // was fine (Boundaries).
      const compiled = claimCandidateQuery({ now: NOW, kinds: [KIND, 'other_work'] }).compile(
        opened.connection.db,
      );
      const plan = opened.connection.database
        .prepare(`explain query plan ${compiled.sql}`)
        .all(...(compiled.parameters as string[]))
        .map((row) => String(row.detail))
        .join('\n');

      expect(plan).toContain('work_items_due_idx');
      // The point of the column order: the index is already in `(attempts, id)`
      // order, so the planner has nothing left to sort (0004).
      expect(plan).not.toContain('TEMP B-TREE');
    } finally {
      await opened.connection.close();
    }
  });

  it('matches nothing when this build can do no kinds of work', async () => {
    const store = sqliteStore({ path: await migratedPath() });
    try {
      expect(await store.addWork(work())).toMatchObject({ ok: true, created: true });
      // `in ()` is legal SQLite and matches nothing, which is the right answer
      // for a build with no handlers (Decision 4, 2026-10-19).
      expect(await store.hasDueWork({ now: NOW, kinds: [] })).toEqual({ ok: true, due: false });
      expect(await store.claimWork({ now: NOW, claimedBy: 'drain', kinds: [] })).toEqual({
        ok: true,
        item: null,
      });
    } finally {
      await store.close();
    }
  });
});

/** One piece of work, as the adapter is asked for it. */
function work(overrides: Record<string, unknown> = {}) {
  return {
    id: '01940000-0000-7000-8000-000000000010',
    kind: KIND,
    targetKind: 'session',
    targetId: 'demo:session-0001',
    createdAt: NOW,
    nextAttemptAt: NOW,
    ...overrides,
  };
}

describe('the columns the SQLite queue writes', () => {
  it('writes the claim as three columns and clears all three on completion', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      const added = await store.addWork(work());
      expect(added.ok).toBe(true);
      if (!added.ok) return;

      const claim = await store.claimWork({ now: NOW, claimedBy: 'drain-1', kinds: [KIND] });
      expect(claim).toMatchObject({ ok: true });
      if (!claim.ok || claim.item === null) throw new Error('nothing was claimed');

      // Text, in the one canonical spelling, and the three claim columns set
      // together: they are one fact, and the table's check says so (0002).
      expect(rows(path, 'work_items')[0]).toEqual({
        id: added.item.id,
        kind: KIND,
        target_kind: 'session',
        target_id: 'demo:session-0001',
        created_at: '2026-02-03T04:05:06.000Z',
        attempts: 1,
        next_attempt_at: '2026-02-03T04:05:06.000Z',
        claimed_at: '2026-02-03T04:05:06.000Z',
        // Ten minutes, the default policy's claim window (AD-21).
        claim_expires_at: '2026-02-03T04:15:06.000Z',
        claimed_by: 'drain-1',
        last_error: null,
        completed_at: null,
      });

      const done = await store.completeWork({ id: added.item.id, claimedBy: 'drain-1', now: NOW });
      expect(done).toEqual({ ok: true, outcome: 'done' });
      expect(rows(path, 'work_items')[0]).toMatchObject({
        completed_at: '2026-02-03T04:05:06.000Z',
        claimed_at: null,
        claim_expires_at: null,
        claimed_by: null,
      });
    } finally {
      await store.close();
    }
  });

  it('keeps one failure row, reopening it with the latest instant and sentence, and closes the item with it', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      const added = await store.addWork(work());
      if (!added.ok) throw new Error('addWork failed');
      const claim = await store.claimWork({ now: NOW, claimedBy: 'drain-1', kinds: [KIND] });
      if (!claim.ok || claim.item === null) throw new Error('nothing was claimed');

      const fingerprint = failureFingerprint({
        stage: KIND,
        input: 'session:demo:session-0001',
        code: 'DEMO_FAILED',
      });
      const recorded = await store.recordFailure({
        id: '01940000-0000-7000-8000-000000000020',
        targetKind: 'session',
        targetId: 'demo:session-0001',
        stage: KIND,
        fingerprint,
        harness: null,
        sessionId: null,
        code: 'DEMO_FAILED',
        message: '열 번 모두 실패했습니다',
        occurredAt: NOW,
        closeWork: { id: added.item.id, claimedBy: 'drain-1', now: NOW },
      });
      expect(recorded).toMatchObject({ ok: true, outcome: 'recorded', created: true });

      expect(rows(path, 'failures')).toEqual([
        {
          id: '01940000-0000-7000-8000-000000000020',
          target_kind: 'session',
          target_id: 'demo:session-0001',
          stage: KIND,
          fingerprint,
          harness: null,
          session_id: null,
          code: 'DEMO_FAILED',
          message: '열 번 모두 실패했습니다',
          occurred_at: '2026-02-03T04:05:06.000Z',
          resolved_at: null,
        },
      ]);
      // The item is closed in the same transaction, with the sentence on it.
      expect(rows(path, 'work_items')[0]).toMatchObject({
        completed_at: '2026-02-03T04:05:06.000Z',
        last_error: '열 번 모두 실패했습니다',
        claimed_by: null,
      });

      // Resolved, then met again: the same row keeps its id, is open again, and
      // carries the latest instant and sentence (Decision 2, 2026-10-19 사용자).
      // The information columns stay what the first record said.
      const opened = openSqlite({ path, busyTimeoutMs: 3000 });
      if (!opened.ok) throw new Error(opened.message);
      opened.connection.database.exec(
        "update failures set resolved_at = '2026-02-03T05:00:00.000Z'",
      );
      await opened.connection.close();

      const again = await store.recordFailure({
        id: '01940000-0000-7000-8000-000000000021',
        targetKind: 'session',
        targetId: 'demo:session-0001',
        stage: KIND,
        fingerprint,
        harness: 'demo',
        sessionId: null,
        code: 'DEMO_FAILED',
        message: '다른 문장',
        occurredAt: new Date('2026-02-03T06:00:00.000Z'),
      });
      expect(again).toMatchObject({
        ok: true,
        outcome: 'recorded',
        created: false,
        failureId: '01940000-0000-7000-8000-000000000020',
      });
      expect(rows(path, 'failures')[0]).toMatchObject({
        id: '01940000-0000-7000-8000-000000000020',
        message: '다른 문장',
        occurred_at: '2026-02-03T06:00:00.000Z',
        harness: null,
        resolved_at: null,
      });
    } finally {
      await store.close();
    }
  });
});

describe('the same cause, again and again', () => {
  it('is one failures row after a hundred records, and another cause is another row', async () => {
    const path = await migratedPath();
    const store = sqliteStore({ path });
    try {
      const input = 'session:demo:session-0001';
      const one = (n: number, code: string) => ({
        id: `01940000-0000-7000-8000-${String(n).padStart(12, '0')}`,
        targetKind: 'session',
        targetId: 'demo:session-0001',
        stage: KIND,
        fingerprint: failureFingerprint({ stage: KIND, input, code }),
        harness: null,
        sessionId: null,
        code,
        message: `${String(n)}번째 실패`,
        occurredAt: new Date(NOW.getTime() + n * 1000),
      });

      for (let n = 1; n <= 100; n += 1) {
        const recorded = await store.recordFailure(one(n, 'DEMO_FAILED'));
        expect(recorded).toMatchObject({ ok: true, outcome: 'recorded', created: n === 1 });
      }
      expect(rows(path, 'failures')).toHaveLength(1);

      const other = await store.recordFailure(one(101, 'OTHER_FAILED'));
      expect(other).toMatchObject({ ok: true, outcome: 'recorded', created: true });
      expect(rows(path, 'failures').map((row) => row['code']).sort()).toEqual([
        'DEMO_FAILED',
        'OTHER_FAILED',
      ]);
    } finally {
      await store.close();
    }
  });
});

/**
 * The "할 일 없음" row of the matrix, against a real lock: an empty queue while
 * another process holds the write lock.
 *
 * It is the whole reason `hasDueWork` exists apart from `claimWork` (AD-7). The
 * opportunistic drain runs at the end of every command, and a drain with nothing
 * to do that queued behind whatever is writing would cost every command the
 * holder's whole write.
 */
describe('a drain over an empty queue while another process is writing', () => {
  it('answers empty at once instead of waiting for the write lock', async () => {
    const path = await migratedPath();
    const holder = await holdLock(path, 3000);

    try {
      // The command budget, which is what a real `brain queue drain` runs with:
      // the lock-free read must not spend it waiting for somebody else.
      const store = sqliteStore({ path, busyTimeoutMs: BUSY_TIMEOUT_MS.command });
      try {
        const startedAt = Date.now();
        const report = await drainQueue(
          { store, spool: memorySpool(), clock: { now: () => new Date() }, idGen: idGenOf('d') },
          { budgetMs: DRAIN_BUDGET_MS.command, handlers: { [KIND]: async () => ({ ok: true }) } },
        );
        const waited = Date.now() - startedAt;
        console.log(`[measured] hold 3000ms, command budget -> drainQueue in ${waited}ms`);

        expect(report).toMatchObject({ claimed: 0, stopped: 'empty' });
        // It did not wait for the holder, and it did not wait for its budget.
        expect(waited).toBeLessThan(1000);

        // And the same of the read on its own, which is what the loop calls
        // before it ever asks for the write lock.
        const due = await store.hasDueWork({ now: new Date(), kinds: [KIND] });
        expect(due).toEqual({ ok: true, due: false });
      } finally {
        await store.close();
      }
    } finally {
      await holder.done;
    }
  }, 30_000);
});

/** A sequence of ids, since the drain mints one `claimedBy` per run. */
function idGenOf(prefix: string) {
  let serial = 0;
  return { next: () => `${prefix}-${String((serial += 1))}` };
}

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

/**
 * Two drains, two processes, one database and twenty items. The claim has to be
 * a transaction for this to come out right: two workers that read first and
 * wrote second would both take the same row.
 *
 * It has to be real processes. `node:sqlite` is synchronous, so two connections
 * in this one would wait on a lock nothing can release.
 */
describe('two processes draining the same queue', () => {
  it('hands every item to exactly one worker, and completes all of them', async () => {
    const path = await migratedPath();
    const log = join(await scratch(), 'handled.log');

    const store = sqliteStore({ path });
    try {
      for (let index = 0; index < 20; index += 1) {
        const added = await store.addWork(
          work({
            id: `01940000-0000-7000-8000-0000000001${index.toString(16).padStart(2, '0')}`,
            targetId: `demo:session-${String(index).padStart(4, '0')}`,
          }),
        );
        expect(added.ok, JSON.stringify(added)).toBe(true);
      }
    } finally {
      await store.close();
    }

    const workers = [drain(path, log), drain(path, log)];
    const reports = await Promise.all(workers);
    for (const report of reports) {
      expect(report.code, report.stderr).toBe(0);
    }

    const handled = (await readFile(log, 'utf8')).trimEnd().split('\n').filter(Boolean);
    // Exactly once each: twenty lines, twenty distinct ids.
    expect(handled).toHaveLength(20);
    expect(new Set(handled).size).toBe(20);
    // And every row is closed, with no claim left on any of them.
    const stored = rows(path, 'work_items');
    expect(stored).toHaveLength(20);
    expect(stored.every((row) => row.completed_at !== null)).toBe(true);
    expect(stored.every((row) => row.claimed_by === null)).toBe(true);
  }, 60_000);
});

interface WorkerRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** One drain in a process of its own, over the built `dist`. */
function drain(path: string, log: string): Promise<WorkerRun> {
  const child = spawn(process.execPath, [WORKER, path, log], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}
