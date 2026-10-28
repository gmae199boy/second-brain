import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { Kysely, PostgresDialect, type KyselyPlugin } from 'kysely';
import { createPool, type PgSchema } from '../src/connect.js';
import { postgresWorkStore } from '../src/work.js';
import { afterEach, describe, expect, it } from 'vitest';
import { tickSchedules, failureText, FAILURE_MESSAGE_MAX_BYTES, truncateUtf8, retryFailures } from '@second-brain/core';
import { workStoreContract, scheduleStoreContract, sequenceIdGen } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database, subject, clock } from './fixture.js';

for (const [name, cases] of [['work-store contract', workStoreContract((store, id) => (store as Awaited<ReturnType<typeof subject>>).readWorkItem(id))], ['schedule-store contract', scheduleStoreContract()]] as const) {
  describe(name, () => { for (const test of cases) it(test.name, () => test.run(subject)); });
}
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const now = clock.now();
const next = new Date(now.getTime() + 60_000);
const work = (n = 1) => ({ id: id(n), kind: 'demo_work', targetKind: 'probe', targetId: `target-${n}`, createdAt: now, nextAttemptAt: now });
const schedule = { id: id(100), kind: 'demo_work', targetKind: 'probe', targetId: 'target-1', intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now };
const firing = { scheduleId: schedule.id, expectedNextRunAt: now, nextRunAt: next, now, work: work() };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options = {}) {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl, ...options }); cleanup.push(() => store.close());
  const blocker = new pg.Client({ connectionString: db.url }); await blocker.connect();
  cleanup.push(async () => { await blocker.query('rollback'); await blocker.end(); });
  return { db, store, blocker };
}
async function lock(blocker: pg.Client, table: string, rowId: string) {
  await blocker.query('begin');
  await blocker.query(`select id from brain.${table} where id = $1 for update`, [rowId]);
}

it('preserves an existing cleanup claim through addWork and retryFailures', async () => {
  const { db, store } = await fixture();
  const input = { ...work(), kind: 'table_cleanup', targetKind: 'table', targetId: 'messages' };
  expect(await store.addWork(input)).toMatchObject({ ok: true, created: true });
  expect(await store.recordFailure({ id: id(10), targetKind: 'table', targetId: 'messages', stage: 'table_cleanup',
    fingerprint: 'old', harness: null, sessionId: null, code: 'TABLE_CLEANUP_FAILED', message: 'failed', occurredAt: now }))
    .toMatchObject({ ok: true, outcome: 'recorded' });
  expect(await store.claimWork({ now, kinds: ['table_cleanup'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: input.id } });
  const before = await db.rows('select * from brain.work_items');
  expect(await store.addWork({ ...input, id: id(2) })).toMatchObject({ ok: true, created: false, item: { claimedBy: 'worker' } });
  expect(await db.rows('select * from brain.work_items')).toEqual(before);
  expect(await retryFailures({ store, clock, idGen: sequenceIdGen({ timestampMs: now.getTime(), start: 100 }) }))
    .toMatchObject({ ok: true, added: 0, alreadyOpen: 1, skipped: [] });
  expect(await db.rows('select * from brain.work_items')).toEqual(before);
});

it('settles cleanup failures atomically only when completeWork wins its claim', async () => {
  const { db, store } = await fixture();
  const input = { ...work(), kind: 'table_cleanup', targetKind: 'table', targetId: 'messages' };
  await store.addWork(input);
  for (const [n, targetKind, targetId, stage] of [
    [10, 'table', 'messages', 'table_cleanup'], [11, 'table', 'messages', 'table_cleanup'],
    [12, 'table', 'chunks', 'table_cleanup'], [13, 'table', 'messages', 'other_stage'],
    [14, 'table', 'messages', 'table_cleanup'], [15, 'other', 'messages', 'table_cleanup'],
  ] as const) {
    expect(await store.recordFailure({ id: id(n), targetKind, targetId, stage, fingerprint: `cause-${n}`,
      harness: null, sessionId: null, code: 'error', message: 'failed', occurredAt: now })).toMatchObject({ ok: true });
  }
  await db.query(`update brain.failures set resolved_at='${now.toISOString()}' where id='${id(14)}'`);
  await store.claimWork({ now, kinds: ['table_cleanup'], claimedBy: 'worker' });
  const failures = await db.rows('select * from brain.failures order by id');
  const items = await db.rows('select * from brain.work_items');
  expect(await store.completeWork({ id: input.id, claimedBy: 'stale', now: next })).toEqual({ ok: true, outcome: 'lost' });
  expect(await db.rows('select * from brain.failures order by id')).toEqual(failures);
  expect(await db.rows('select * from brain.work_items')).toEqual(items);
  await db.query(`create function brain.refuse_cleanup_resolution() returns trigger language plpgsql as $$
    begin raise exception 'test resolution refused'; end $$;
    create trigger refuse_cleanup_resolution before update on brain.failures
      for each row execute function brain.refuse_cleanup_resolution()`);
  expect(await store.completeWork({ id: input.id, claimedBy: 'worker', now: next })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.failures order by id')).toEqual(failures);
  expect(await db.rows('select * from brain.work_items')).toEqual(items);
  await db.query('drop trigger refuse_cleanup_resolution on brain.failures');
  expect(await store.completeWork({ id: input.id, claimedBy: 'worker', now: next })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows('select * from brain.failures order by id')).toEqual(failures.map(row =>
    [id(10), id(11)].includes(row.id as string) ? { ...row, resolved_at: next } : row));
  expect(await db.rows('select completed_at, claimed_by from brain.work_items')).toEqual([{ completed_at: next, claimed_by: null }]);
});

it('retries find-or-create when a drain completes the conflicting row before read-back', async () => {
  const { db, store } = await fixture();
  expect((await store.addWork(work())).ok).toBe(true);
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'drain' })).toMatchObject({ ok: true, item: { id: id(1) } });
  let completed = false;
  const inserts = new Set<unknown>();
  // Hold the first conflicting INSERT's result until a separate connection has
  // completed that row. The following SELECT must therefore see no open row.
  const barrier: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'RawNode' && node.sqlFragments.join('').includes('insert into brain.work_items')) inserts.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (inserts.delete(queryId) && !completed) {
        expect(result.rows).toEqual([]);
        expect(await store.completeWork({ id: id(1), claimedBy: 'drain', now })).toEqual({ ok: true, outcome: 'done' });
        completed = true;
      }
      return result;
    },
  };
  const connection = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: db.appUrl }) }), plugins: [barrier] });
  cleanup.push(() => connection.destroy());
  const racing = postgresWorkStore(() => ({ ok: true, connection: { db: connection } }));
  const replacement = { ...work(), id: id(2) };
  expect(await racing.addWork(replacement)).toMatchObject({ ok: true, created: true, item: { id: id(2), targetId: work().targetId } });
  expect(completed).toBe(true);
  expect(await store.addWork({ ...replacement, id: id(3) })).toMatchObject({ ok: true, created: false, item: { id: id(2) } });
  expect(await db.rows('select id, completed_at is not null as completed from brain.work_items order by id')).toEqual([
    { id: id(1), completed: true }, { id: id(2), completed: false },
  ]);
});

it('stores NUL failure sentences with replacement characters when retrying and recording', async () => {
  const { db, store } = await fixture();
  expect((await store.addWork(work())).ok).toBe(true);
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: id(1) } });
  const message = 'failure\u0000sentence';
  const storedMessage = 'failure\ufffdsentence';
  expect(await store.retryWork({ id: id(1), claimedBy: 'worker', nextAttemptAt: now, lastError: message })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows('select last_error from brain.work_items')).toEqual([{ last_error: storedMessage }]);
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { lastError: storedMessage } });
  expect(await store.recordFailure({ id: id(2), targetKind: 'probe', targetId: 'target-1', stage: 'demo_work', fingerprint: 'cause', harness: null, sessionId: null,
    code: 'error', message, occurredAt: now, closeWork: { id: id(1), claimedBy: 'worker', now } })).toEqual({ ok: true, outcome: 'recorded', created: true, failureId: id(2) });
  expect(await db.rows('select last_error, completed_at is not null as completed from brain.work_items')).toEqual([{ last_error: storedMessage, completed: true }]);
  expect(await store.listFailures({})).toMatchObject({ ok: true, failures: [{ message: storedMessage }] });
});
it('caps encoded failure sentences equally in work and failure rows at code point boundaries', async () => {
  const { db, store } = await fixture();
  const message = failureText('TOKEN=secret-value ' + '\u0000😀'.repeat(FAILURE_MESSAGE_MAX_BYTES));
  expect(Buffer.byteLength(message)).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_BYTES);
  expect(message).not.toContain('secret-value');
  const encoded = message.replaceAll('\u0000', '\ufffd');
  expect(Buffer.byteLength(encoded)).toBeGreaterThan(FAILURE_MESSAGE_MAX_BYTES);
  const expected = truncateUtf8(encoded, FAILURE_MESSAGE_MAX_BYTES);
  expect(expected).not.toContain('secret-value');
  expect((await store.addWork(work())).ok).toBe(true);
  expect((await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).ok).toBe(true);
  expect(await store.retryWork({ id: id(1), claimedBy: 'worker', nextAttemptAt: now, lastError: message })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows('select last_error from brain.work_items')).toEqual([{ last_error: expected }]);
  expect((await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).ok).toBe(true);
  expect(await store.recordFailure({ id: id(2), targetKind: 'probe', targetId: 'target-1', stage: 'demo_work', fingerprint: 'cause', harness: null, sessionId: null,
    code: 'error', message, occurredAt: now, closeWork: { id: id(1), claimedBy: 'worker', now } })).toMatchObject({ ok: true, outcome: 'recorded' });
  const rows = await db.rows<{ last_error: string; message: string }>('select w.last_error, f.message from brain.work_items w cross join brain.failures f');
  expect(rows).toEqual([{ last_error: expected, message: expected }]);
  for (const value of Object.values(rows[0]!)) {
    expect(Buffer.byteLength(value)).toBeLessThanOrEqual(FAILURE_MESSAGE_MAX_BYTES);
    expect(Buffer.from(value).toString('utf8')).toBe(value);
  }
});
it('lists failures at equal instants by descending id and applies the limit', async () => {
  const { store } = await fixture();
  for (const n of [1, 2]) expect(await store.recordFailure({ id: id(n), targetKind: 'probe', targetId: `target-${n}`, stage: 'demo_work', fingerprint: 'cause',
    harness: null, sessionId: null, code: 'error', message: 'failed', occurredAt: now })).toMatchObject({ ok: true, outcome: 'recorded', created: true });
  const all = await store.listFailures({});
  expect(all.ok && all.failures.map(row => row.id)).toEqual([id(2), id(1)]);
  const limited = await store.listFailures({ limit: 1 });
  expect(limited.ok && limited.failures.map(row => row.id)).toEqual([id(2)]);
});
it('rolls back closing work when its failure insert is refused, then records once', async () => {
  const { db, store } = await fixture();
  expect((await store.addWork(work())).ok).toBe(true);
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: id(1) } });
  const before = await db.rows('select * from brain.work_items');
  const input = { id: id(2), targetKind: 'probe', targetId: 'target-1', stage: 'demo_work', fingerprint: 'cause', harness: null, sessionId: null,
    code: 'error', message: 'failed', occurredAt: now, closeWork: { id: id(1), claimedBy: 'worker', now } };
  await db.query("create function brain.refuse_failure() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$");
  await db.query('create trigger refuse_failure before insert on brain.failures for each row execute function brain.refuse_failure()');
  expect(await store.recordFailure(input)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.work_items')).toEqual(before);
  expect(await db.rows('select * from brain.failures')).toEqual([]);
  await db.query('drop trigger refuse_failure on brain.failures');
  expect(await store.recordFailure(input)).toEqual({ ok: true, outcome: 'recorded', created: true, failureId: id(2) });
  expect(await store.recordFailure(input)).toEqual({ ok: true, outcome: 'lost' });
  expect(await db.rows('select claimed_by, completed_at is not null as completed, last_error from brain.work_items')).toEqual([{ claimed_by: null, completed: true, last_error: 'failed' }]);
  expect(await db.rows('select id, occurrences from brain.failures')).toEqual([{ id: id(2), occurrences: 1 }]);
});
it('postpones retried work until its next attempt instant', async () => {
  const { store } = await fixture();
  expect((await store.addWork(work())).ok).toBe(true);
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: id(1) } });
  expect(await store.retryWork({ id: id(1), claimedBy: 'worker', nextAttemptAt: next, lastError: 'try later' })).toEqual({ ok: true, outcome: 'done' });
  const before = { now: new Date(next.getTime() - 1), kinds: ['demo_work'] };
  expect(await store.hasDueWork(before)).toEqual({ ok: true, due: false });
  expect(await store.claimWork({ ...before, claimedBy: 'worker' })).toEqual({ ok: true, item: null });
  expect(await store.hasDueWork({ now: next, kinds: ['demo_work'] })).toEqual({ ok: true, due: true });
  expect(await store.claimWork({ now: next, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: id(1), nextAttemptAt: next, attempts: 2 } });
});

it('claimWork skips a row another transaction holds instead of waiting', async () => {
  const { db, store, blocker } = await fixture({ lockTimeoutMs: 40 });
  expect((await store.addWork(work())).ok).toBe(true);
  await lock(blocker, 'work_items', id(1));
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toEqual({ ok: true, item: null });
  expect((await store.addWork(work(2))).ok).toBe(true);
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: id(2) } });
  expect(await db.rows("select attempts, claimed_by from brain.work_items where id = '00000000-0000-7000-8000-000000000001'")).toEqual([{ attempts: 0, claimed_by: null }]);
});
it('returns DB_LOCKED when a work write outlasts lock_timeout, then completes once', async () => {
  const { db, store, blocker } = await fixture({ lockTimeoutMs: 40, queryTimeoutMs: 1000 });
  await store.addWork(work()); await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' });
  const before = await db.rows('select * from brain.work_items');
  await lock(blocker, 'work_items', id(1));
  const input = { id: id(1), claimedBy: 'worker', now };
  expect(await store.completeWork(input)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await db.rows('select * from brain.work_items')).toEqual(before);
  await blocker.query('rollback');
  expect(await store.completeWork(input)).toEqual({ ok: true, outcome: 'done' });
  expect(await store.completeWork(input)).toEqual({ ok: true, outcome: 'lost' });
});
it('returns DB_LOCKED when a firing outlasts lock_timeout, then fires once', async () => {
  const { db, store, blocker } = await fixture({ lockTimeoutMs: 40, queryTimeoutMs: 1000 });
  await store.addSchedule(schedule);
  const before = await db.rows('select * from brain.schedules');
  await lock(blocker, 'schedules', schedule.id);
  expect(await store.fireSchedule(firing)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await db.rows('select * from brain.schedules')).toEqual(before);
  expect(await db.rows('select * from brain.work_items')).toEqual([]);
  await blocker.query('rollback');
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: true, created: true });
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: false });
});
it('rolls back a firing whose work insert is refused, then fires once', async () => {
  const { db, store } = await fixture(); await store.addSchedule(schedule);
  const before = await db.rows('select * from brain.schedules');
  await db.query("create function brain.refuse_work() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$");
  await db.query('create trigger refuse_work before insert on brain.work_items for each row execute function brain.refuse_work()');
  expect(await store.fireSchedule(firing)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.schedules')).toEqual(before);
  expect(await db.rows('select * from brain.work_items')).toEqual([]);
  await db.query('drop trigger refuse_work on brain.work_items');
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: true, created: true });
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: false });
});
it('fires a schedule once when two ticks race for it', async () => {
  const { db, store, blocker } = await fixture({ applicationName: 'schedule-race-a' });
  const other = postgresStore({ databaseUrl: db.appUrl, applicationName: 'schedule-race-b' }); cleanup.push(() => other.close());
  await store.addSchedule(schedule); await lock(blocker, 'schedules', schedule.id);
  const a = tickSchedules({ store, clock, idGen: sequenceIdGen({ timestampMs: now.getTime(), start: 1000 }) });
  const b = tickSchedules({ store: other, clock, idGen: sequenceIdGen({ timestampMs: now.getTime(), start: 2000 }) });
  try {
    await expect.poll(async () => {
      const rows = await db.rows<{ count: number }>("select count(*)::int as count from pg_stat_activity where application_name in ('schedule-race-a','schedule-race-b') and wait_event_type = 'Lock'");
      return rows[0]?.count;
    }, { timeout: 2000, interval: 10 }).toBe(2);
  } finally { await blocker.query('rollback'); }
  const results = await Promise.all([a, b]);
  expect(results).toContainEqual({ ok: true, fired: 1, enqueued: 1 });
  expect(results).toContainEqual({ ok: true, fired: 0, enqueued: 0 });
  expect(await db.rows('select target_id from brain.work_items')).toEqual([{ target_id: 'target-1' }]);
  expect(await store.listDueSchedules({ now: next, limit: 10 })).toMatchObject({ ok: true, schedules: [{ nextRunAt: next, lastRunAt: now }] });
});
it('answers DB_UNAVAILABLE from queue and schedule verbs when the brain schema is missing', async () => {
  const { db, store } = await fixture(); await db.query('drop schema brain cascade');
  const finish = { id: id(1), claimedBy: 'worker', now };
  const results = await Promise.all([
    store.addWork(work()), store.hasDueWork({ now, kinds: ['demo_work'] }),
    store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' }), store.completeWork(finish),
    store.retryWork({ ...finish, nextAttemptAt: now, lastError: 'error' }), store.releaseWork(finish),
    store.recordFailure({ id: id(3), targetKind: 'probe', targetId: 'target', stage: 'demo_work', fingerprint: 'cause', harness: null, sessionId: null, code: 'error', message: 'error', occurredAt: now }),
    store.listFailures({}), store.resolveFailures({ targetKind: 'probe', targetId: 'target', stage: 'demo_work', now }),
    store.listOpenWorkTargets({ kind: 'demo_work' }), store.addSchedule(schedule), store.fireSchedule(firing), store.listDueSchedules({ now, limit: 10 }),
  ]);
  for (const result of results) expect(result).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
});

const DRAIN_BUDGET_MS = 30_000;
const WORKER = fileURLToPath(new URL('./fixtures/drain-worker.mjs', import.meta.url));
function worker(databaseUrl: string, log: string) {
  const child = spawn(process.execPath, [WORKER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const timeout = setTimeout(() => child.kill('SIGKILL'), DRAIN_BUDGET_MS + 10_000);
  let stderr = ''; child.stderr.setEncoding('utf8').on('data', data => { stderr += String(data); });
  let readyResolve!: () => void; let readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let enteredResolve!: () => void; let enteredReject!: (error: Error) => void;
  const entered = new Promise<void>((resolve, reject) => { enteredResolve = resolve; enteredReject = reject; });
  let result: { stopped: string; claimed: number } | undefined;
  lines.on('line', line => { if (line === 'ready') readyResolve(); else if (line === 'entered') enteredResolve(); else { try { result = JSON.parse(line); } catch { child.kill('SIGKILL'); } } });
  const done = new Promise<{ stopped: string; claimed: number }>((resolve, reject) => {
    const fail = (error: Error) => { readyReject(error); enteredReject(error); reject(error); };
    child.on('error', error => { clearTimeout(timeout); fail(error); });
    child.on('close', code => { clearTimeout(timeout); lines.close();
      if (code !== 0 || result === undefined) fail(new Error(`drain worker exited ${String(code)}: ${stderr}`)); else resolve(result);
    });
  });
  void ready.catch(() => {}); void entered.catch(() => {}); void done.catch(() => {});
  child.stdin.on('error', () => {}); child.stdin.write(`${JSON.stringify({ databaseUrl, log, now: now.toISOString(), budgetMs: DRAIN_BUDGET_MS })}\n`);
  return { ready, entered, done, go: () => child.stdin.write('go\n'), release: () => child.stdin.end('continue\n'), stop: async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done.catch(() => {});
  } };
}
it('hands every item to exactly one of two draining processes', async () => {
  const { db, store } = await fixture();
  const folder = await mkdtemp(join(tmpdir(), 'brain-pg-drain-')); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const log = join(folder, 'handled');
  for (let n = 1; n <= 40; n++) expect((await store.addWork(work(n))).ok).toBe(true);
  const children = [worker(db.appUrl, log), worker(db.appUrl, log)];
  cleanup.push(() => Promise.all(children.map(child => child.stop())));
  try {
    await Promise.all(children.map(child => child.ready)); for (const child of children) child.go();
    await Promise.all(children.map(child => child.entered));
    for (const child of children) child.release();
    for (const result of await Promise.all(children.map(child => child.done))) {
      expect(result.stopped).toBe('empty');
      expect(result.claimed).toBeGreaterThan(0);
    }
    const handled = (await readFile(log, 'utf8')).trim().split('\n');
    expect(handled).toHaveLength(40); expect(new Set(handled).size).toBe(40);
    expect(new Set(handled)).toEqual(new Set(Array.from({ length: 40 }, (_, n) => id(n + 1))));
    const rows = await db.rows<{ completed_at: unknown; claimed_by: unknown; attempts: number }>('select completed_at, claimed_by, attempts from brain.work_items');
    expect(rows).toHaveLength(40);
    for (const row of rows) { expect(row.completed_at).not.toBeNull(); expect(row.claimed_by).toBeNull(); expect(row.attempts).toBe(1); }
  } finally { await Promise.all(children.map(child => child.stop())); }
}, DRAIN_BUDGET_MS + 20_000);

it('stale token renewal and finish preserve the item and every attempt row', async () => {
  const { db, store } = await fixture();
  const probe = { ...work(), kind: 'process_probe' };
  await store.addWork(probe);
  const query = { now, claimedBy: id(99), kinds: ['process_probe'] };
  expect(await store.claimSupervisedWork({ ...query, attemptToken: id(201) })).toMatchObject({ ok: true, attemptToken: id(201) });
  const later = new Date(now.getTime() + 600001);
  await store.settleSupervisedAttempt({ id: probe.id, attemptToken: id(201), now: later, outcome: 'died' });
  expect(await store.claimSupervisedWork({ ...query, now: later, attemptToken: id(202) })).toMatchObject({ ok: true, attemptToken: id(202) });
  const snapshot = async () => ({ items: await db.rows('select * from brain.work_items order by id'), attempts: await db.rows('select * from brain.work_attempts order by token') });
  const before = await snapshot();
  expect(await store.renewSupervisedLease({ id: probe.id, attemptToken: id(201), now: later, progressAt: later })).toEqual({ ok: true, outcome: 'lost' });
  expect(await store.finishSupervisedWork({ id: probe.id, attemptToken: id(201), now: later, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'lost' });
  expect(await snapshot()).toEqual(before);
  expect(await store.finishSupervisedWork({ id: probe.id, attemptToken: id(202), now: later, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'done' });
});

describe.each(['finish succeeded', 'finish failed', 'settle died', 'settle cancelled', 'settle unknown'] as const)('cancel races with %s', action => {
  it.each(['cancel', 'terminal'] as const)('serializes separate connections when %s holds the row lock first', async first => {
    const { db, store, blocker } = await fixture();
    const probe = { ...work(), kind: 'process_probe' }; const token = id(201);
    await store.addWork(probe);
    expect(await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token }))
      .toMatchObject({ ok: true, attemptToken: token });

    let release!: () => void; let locked!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const acquired = new Promise<void>(resolve => { locked = resolve; });
    let paused = false; const selects = new Set<unknown>();
    // Pause the first real transaction immediately after SELECT FOR UPDATE.
    const barrier: KyselyPlugin = {
      transformQuery({ node, queryId }) {
        if (!paused && node.kind === 'RawNode' && node.sqlFragments.join('').includes('select * from brain.work_items')
          && node.sqlFragments.join('').includes('for update')) selects.add(queryId);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (selects.delete(queryId) && !paused) { paused = true; locked(); await gate; }
        return result;
      },
    };
    const connection = (name: string, plugins: KyselyPlugin[] = []) => {
      const db = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: fixtureUrl, applicationName: name }) }), plugins });
      cleanup.push(() => db.destroy());
      return postgresWorkStore(() => ({ ok: true, connection: { db } }));
    };
    const fixtureUrl = db.appUrl;
    const leading = connection('brain-cancel-race-first', [barrier]);
    const trailing = connection('brain-cancel-race-second');
    const cancel = (s: typeof leading) => s.requestWorkCancel({ id: probe.id, now: next });
    const terminal = (s: typeof leading) => {
      const input = { id: probe.id, attemptToken: token, now: next };
      if (action === 'finish succeeded' || action === 'finish failed') return s.finishSupervisedWork({
        ...input, outcome: action === 'finish succeeded' ? 'succeeded' : 'failed', nextAttemptAt: next, lastError: '실행 실패',
      });
      return s.settleSupervisedAttempt({ ...input, outcome: action === 'settle died' ? 'died' : action === 'settle cancelled' ? 'cancelled' : 'unknown' });
    };
    const leadingCall = first === 'cancel' ? cancel(leading) : terminal(leading);
    let trailingCall: ReturnType<typeof cancel> | ReturnType<typeof terminal> | undefined;
    try {
      await acquired;
      trailingCall = first === 'cancel' ? terminal(trailing) : cancel(trailing);
      // Observe PostgreSQL's actual lock wait before releasing the barrier;
      // elapsed time alone is not evidence that the calls overlapped.
      await expect.poll(async () => {
        const result = await blocker.query(`select cardinality(pg_blocking_pids(pid)) > 0 as blocked
          from pg_stat_activity where datname = current_database() and application_name = $1`, ['brain-cancel-race-second']);
        return result.rows[0]?.blocked;
      }, { timeout: 2000 }).toBe(true);
      release();
      const [a, b] = await Promise.all([leadingCall, trailingCall]);
      const cancelResult = first === 'cancel' ? a : b;
      const terminalResult = first === 'cancel' ? b : a;
      expect(terminalResult).toEqual({ ok: true, outcome: 'done' });
      expect(cancelResult).toEqual({ ok: true, state: first === 'cancel' || action === 'settle unknown' ? 'requested'
        : action === 'finish succeeded' ? 'already_closed' : 'cancelled' });
      const unknown = action === 'settle unknown';
      expect(await db.rows('select outcome, completed_at, current_attempt_token, claimed_by, attempts from brain.work_items')).toEqual([{
        outcome: unknown ? null : action === 'finish succeeded' ? 'succeeded' : 'cancelled',
        completed_at: unknown ? null : next, current_attempt_token: unknown ? token : null,
        claimed_by: unknown ? id(99) : null, attempts: action === 'settle cancelled' && first === 'terminal' ? 0 : 1,
      }]);
      expect(await db.rows('select token, outcome, finished_at from brain.work_attempts')).toEqual([{
        token, outcome: action === 'finish succeeded' ? 'succeeded' : action === 'finish failed' ? 'failed'
          : unknown ? 'unknown' : action === 'settle died' && first === 'terminal' ? 'died' : 'cancelled', finished_at: next,
      }]);
    } finally { release(); await Promise.allSettled([leadingCall, trailingCall]); }
  });
});

it('persists supervised outcome details, absent usage, and settlement measurements', async () => {
  const { db, store } = await fixture();
  const start = async (n: number) => {
    await store.addWork({ ...work(n), kind: 'process_probe' });
    expect(await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: id(n + 200) })).toMatchObject({ ok: true, item: { id: id(n) } });
    return { id: id(n), attemptToken: id(n + 200), now: next };
  };
  const failed = await start(1);
  expect(await store.finishSupervisedWork({ ...failed, outcome: 'failed', errorCode: 'GARMIN_AUTH', errorRetryable: false, nextAttemptAt: next,
    usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 }, elapsedMs: 123, stderr: 'masked diagnostic' })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows(`select error_code,error_retryable,input_tokens,cached_input_tokens,output_tokens,elapsed_ms,stderr from brain.work_attempts where token=\'${failed.attemptToken}\'`))
    .toEqual([{ error_code: 'GARMIN_AUTH', error_retryable: false, input_tokens: '10', cached_input_tokens: '2', output_tokens: '5', elapsed_ms: '123', stderr: 'masked diagnostic' }]);
  const succeeded = await start(2);
  expect(await store.finishSupervisedWork({ ...succeeded, outcome: 'succeeded', elapsedMs: 10 })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows(`select input_tokens,cached_input_tokens,output_tokens,error_code,error_retryable,stderr from brain.work_attempts where token=\'${succeeded.attemptToken}\'`))
    .toEqual([{ input_tokens: null, cached_input_tokens: null, output_tokens: null, error_code: null, error_retryable: null, stderr: null }]);
  const settled = await start(3);
  expect(await store.settleSupervisedAttempt({ ...settled, outcome: 'cancelled', elapsedMs: 456, stderr: 'settled diagnostic' })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows(`select elapsed_ms,stderr from brain.work_attempts where token=\'${settled.attemptToken}\'`)).toEqual([{ elapsed_ms: '456', stderr: 'settled diagnostic' }]);
});
it('rejects partial or negative usage, negative elapsed time, and errors on successful attempts', async () => {
  const { db, store } = await fixture();
  await store.addWork({ ...work(), kind: 'process_probe' });
  await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: id(201) });
  for (const expression of ["input_tokens=1", "input_tokens=-1,cached_input_tokens=0,output_tokens=0", "elapsed_ms=-1", "outcome='succeeded',error_code='BAD'", "error_code='BAD'", 'error_retryable=false']) {
    await expect(db.query(`update brain.work_attempts set ${expression} where token='${id(201)}'`)).rejects.toMatchObject({ code: '23514' });
  }
});
