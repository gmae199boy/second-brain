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
import { dependencyFailedText, enqueueWorkGraph, tickSchedules, failureText, FAILURE_MESSAGE_MAX_BYTES, truncateUtf8, retryFailures, runSupervisor } from '@second-brain/core';
import { fakeCron, workStoreContract, scheduleStoreContract, sequenceIdGen, manualTime, fakeProcessInspector, fakeProcessLauncher } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database, subject, clock } from './fixture.js';

for (const [name, cases] of [['work-store contract', workStoreContract((store, id) => (store as Awaited<ReturnType<typeof subject>>).readWorkItem(id), async (store, token) => {
  const rows = await (store as Awaited<ReturnType<typeof subject>>).db.rows<{ lastProgressAt: Date | null; renewedAt: Date | null }>(`select last_progress_at as "lastProgressAt", renewed_at as "renewedAt" from brain.work_attempts where token='${token}'`);
  return rows[0] ?? null;
})], ['schedule-store contract', scheduleStoreContract()]] as const) {
  describe(name, () => { for (const test of cases) it(test.name, () => test.run(subject)); });
}
const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const now = clock.now();
const next = new Date(now.getTime() + 60_000);
const work = (n = 1) => ({ id: id(n), kind: 'demo_work', targetKind: 'probe', targetId: `target-${n}`, createdAt: now, nextAttemptAt: now });
const schedule = { id: id(100), kind: 'demo_work', targetKind: 'probe', targetId: 'target-1', triggerKind: 'interval' as const, cronExpr: null, runAt: null, timeZoneSource: null, extension: null, scheduleKey: null, userId: '01940000-0000-7000-8000-00000000000a', enabled: true, removedAt: null, timeZone: null, intervalSeconds: 60, nextRunAt: now, lastRunAt: null, createdAt: now };
const firing = { expectedTriggerKind:'interval' as const,expectedTimeZone:null,expectedCronExpr:null, scheduleId: schedule.id, expectedNextRunAt: now, nextRunAt: next, now, work: work(), occurrences: [{ occurrenceAt: now, status: 'pending' as const }] };
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options = {}) {
  const db = await database(); cleanup.push(() => db.drop());
  const store = postgresStore({ databaseUrl: db.appUrl, ...options }); cleanup.push(() => store.close());
  await store.ensureSelfUser({id:'01940000-0000-7000-8000-00000000000a',name:'synthetic',createdAt:now});
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

it.each(['completeWork', 'finishSupervisedWork'] as const)('%s rolls back completion when scheduled success recording fails', async path => {
  const { db, store } = await fixture(); const token = id(201);
  const kind = path === 'completeWork' ? 'demo_work' : 'process_probe';
  expect(await store.addSchedule({ ...schedule, kind, triggerKind: 'cron', cronExpr: '0 11 * * *', timeZoneSource:'fixed', timeZone: 'Asia/Seoul', intervalSeconds: null }))
    .toMatchObject({ ok: true });
  expect(await store.fireSchedule({scheduleId:schedule.id,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:'0 11 * * *',expectedNextRunAt:now,nextRunAt:next,now,work:{...work(),kind},occurrences:[{occurrenceAt:now,status:'pending'}]})).toMatchObject({ok:true,fired:true});
  const claim = path === 'completeWork'
    ? await store.claimWork({ now, kinds: [kind], claimedBy: 'worker' })
    : await store.claimSupervisedWork({ now, kinds: [kind], claimedBy: 'worker', attemptToken: token });
  expect(claim).toMatchObject({ ok: true, item: { id: id(1) } });
  const before = { items: await db.rows('select * from brain.work_items'), attempts: await db.rows('select * from brain.work_attempts') };
  const finish = () => path === 'completeWork'
    ? store.completeWork({ id: id(1), claimedBy: 'worker', now: next })
    : store.finishSupervisedWork({ id: id(1), attemptToken: token, now: next, outcome: 'succeeded' });
  await db.query(`create function brain.refuse_schedule_success() returns trigger language plpgsql as $$
    begin raise exception 'test success recording refused'; end $$;
    create trigger refuse_schedule_success before update on brain.schedule_occurrences
      for each row execute function brain.refuse_schedule_success()`);
  expect(await finish()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.work_items')).toEqual(before.items);
  expect(await db.rows('select * from brain.work_attempts')).toEqual(before.attempts);
  expect(await db.rows('select status from brain.schedule_occurrences')).toEqual([{status:'claimed'}]);
  await db.query('drop trigger refuse_schedule_success on brain.schedule_occurrences');
  expect(await finish()).toEqual({ ok: true, outcome: 'done' });
  expect(await finish()).toEqual({ ok: true, outcome: 'lost' });
  expect(await db.rows('select completed_at,outcome,claimed_at,claim_expires_at,claimed_by,current_attempt_token from brain.work_items'))
    .toEqual([{ completed_at: next, outcome: 'succeeded', claimed_at: null, claim_expires_at: null, claimed_by: null, current_attempt_token: null }]);
  expect(await db.rows('select status from brain.schedule_occurrences')).toEqual([{status:'done'}]);
  expect(await db.rows('select outcome,finished_at from brain.work_attempts'))
    .toEqual(path === 'completeWork' ? [] : [{ outcome: 'succeeded', finished_at: next }]);
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
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: true, created: true, covered: false });
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
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: true, created: true, covered: false });
  expect(await store.fireSchedule(firing)).toEqual({ ok: true, fired: false });
});
it('fires a schedule once when two ticks race for it', async () => {
  const { db, store, blocker } = await fixture({ applicationName: 'schedule-race-a' });
  const other = postgresStore({ databaseUrl: db.appUrl, applicationName: 'schedule-race-b' }); cleanup.push(() => other.close());
  await store.addSchedule(schedule); await lock(blocker, 'schedules', schedule.id);
  const a = tickSchedules({ cron: fakeCron, store, clock, readTimeZone: async () => ({ ok: true, value: 'Asia/Seoul' }), idGen: sequenceIdGen({ timestampMs: now.getTime(), start: 1000 }) });
  const b = tickSchedules({ cron: fakeCron, store: other, clock, readTimeZone: async () => ({ ok: true, value: 'Asia/Seoul' }), idGen: sequenceIdGen({ timestampMs: now.getTime(), start: 2000 }) });
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
        if (!paused && node.kind === 'RawNode' && node.sqlFragments.join('').includes('from brain.work_items')
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

it('requires an outcome on new closed work without backfilling legacy outcomes', async () => {
  const { db, store } = await fixture(); await store.addWork(work());
  await expect(db.query(`update brain.work_items set completed_at='${now.toISOString()}' where id='${id(1)}'`)).rejects.toMatchObject({ code: '23514' });
  expect(await db.rows('select completed_at, outcome from brain.work_items')).toEqual([{ completed_at: null, outcome: null }]);
  expect(await db.rows("select convalidated from pg_constraint where conname='work_items_closed_outcome' and conrelid='brain.work_items'::regclass")).toEqual([{ convalidated: false }]);
});
it('rolls back supervised failure recording and closure together and retries once', async () => {
  const { db, store } = await fixture(); const token = id(201);
  await store.addWork({ ...work(), kind: 'process_probe' });
  await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token });
  const before = { items: await db.rows('select * from brain.work_items'), attempts: await db.rows('select * from brain.work_attempts') };
  const input = { id: id(1), attemptToken: token, now: next, outcome: 'stalled' as const, lastError: '정체 PROCESS_STALLED',
    failure: { id: id(301), stage: 'process_probe', fingerprint: 'cause', code: 'PROCESS_STALLED', message: '정체 PROCESS_STALLED', occurredAt: next } };
  await db.query("create function brain.refuse_failure() returns trigger language plpgsql as $$ begin raise exception 'refused'; end $$; create trigger refuse_failure before insert on brain.failures for each row execute function brain.refuse_failure()");
  expect(await store.finishSupervisedWork(input)).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select * from brain.work_items')).toEqual(before.items);
  expect(await db.rows('select * from brain.work_attempts')).toEqual(before.attempts);
  expect(await db.rows('select * from brain.failures')).toEqual([]);
  await db.query('drop trigger refuse_failure on brain.failures');
  expect(await store.finishSupervisedWork(input)).toEqual({ ok: true, outcome: 'done' });
  expect(await store.finishSupervisedWork(input)).toEqual({ ok: true, outcome: 'lost' });
  expect(await db.rows('select completed_at,outcome,last_error from brain.work_items')).toEqual([{ completed_at: next, outcome: 'failed', last_error: input.lastError }]);
  expect(await db.rows('select outcome,error_code from brain.work_attempts')).toEqual([{ outcome: 'stalled', error_code: null }]);
  expect(await db.rows('select stage,code,harness,session_id,occurrences from brain.failures')).toEqual([{ stage: 'process_probe', code: 'PROCESS_STALLED', harness: null, session_id: null, occurrences: 1 }]);
});
it('reopens the same supervised failure preserving its first occurrence and id', async () => {
  const { store } = await fixture();
  const later = new Date(next.getTime() + 60_000);
  for (const [n, occurredAt, message] of [[1, now, '첫 실패'], [2, later, '최신 실패']] as const) {
    const token = id(200 + n);
    await store.addWork({ ...work(n), kind: 'process_probe', targetId: 'shared-target', createdAt: occurredAt, nextAttemptAt: occurredAt });
    expect(await store.claimSupervisedWork({ now: occurredAt, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token }))
      .toMatchObject({ ok: true, item: { id: id(n) } });
    expect(await store.finishSupervisedWork({ id: id(n), attemptToken: token, now: occurredAt, outcome: 'failed', errorCode: 'PERMANENT', errorRetryable: false,
      failure: { id: id(300 + n), stage: 'process_probe', fingerprint: 'same-cause', code: 'PERMANENT', message, occurredAt } }))
      .toEqual({ ok: true, outcome: 'done' });
    if (n === 1) {
      expect(await store.resolveFailures({ targetKind: 'probe', targetId: 'shared-target', stage: 'process_probe', now: next }))
        .toEqual({ ok: true, resolved: 1 });
      expect(await store.listFailures({ includeResolved: true })).toMatchObject({ ok: true, failures: [{ id: id(301), resolvedAt: next }] });
    }
  }
  const read = await store.listFailures({ includeResolved: true }); expect(read.ok).toBe(true); if (!read.ok) return;
  expect(read.failures).toHaveLength(1);
  expect(read.failures[0]).toMatchObject({ id: id(301), firstOccurredAt: now, occurrences: 2, occurredAt: later, message: '최신 실패', resolvedAt: null });
});
it('does not record a supervised terminal failure when cancellation won', async () => {
  const { db, store } = await fixture(); const token = id(201);
  await store.addWork({ ...work(), kind: 'process_probe' });
  await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token });
  await store.requestWorkCancel({ id: id(1), now });
  expect(await store.finishSupervisedWork({ id: id(1), attemptToken: token, now: next, outcome: 'failed', lastError: '실패', errorCode: 'PERMANENT', errorRetryable: false,
    failure: { id: id(301), stage: 'process_probe', fingerprint: 'cause', code: 'PERMANENT', message: '실패', occurredAt: next } })).toEqual({ ok: true, outcome: 'done' });
  expect(await db.rows('select outcome from brain.work_items')).toEqual([{ outcome: 'cancelled' }]);
  expect(await db.rows('select * from brain.failures')).toEqual([]);
});
it('distinguishes stalled, died, current unknown and last error while ignoring older and closed attempts', async () => {
  const { db, store } = await fixture();
  for (const [index, outcome] of ['stalled', 'died', 'unknown', 'failed', 'succeeded'].entries()) {
    const n = index + 1, token = id(200 + n);
    await store.addWork({ ...work(n), kind: 'process_probe' });
    await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token });
    if (outcome === 'unknown') await store.settleSupervisedAttempt({ id: id(n), attemptToken: token, now: next, outcome });
    else await store.finishSupervisedWork({ id: id(n), attemptToken: token, now: next, outcome: outcome as 'stalled' | 'died' | 'failed' | 'succeeded', nextAttemptAt: next, lastError: '마지막 오류', ...(outcome === 'failed' ? { errorCode: 'TEMPORARY', errorRetryable: true } : {}) });
  }
  const read = await store.readWorkAttemptHealth(); expect(read.ok).toBe(true); if (!read.ok) return;
  for (const [index, outcome] of (['stalled', 'died', 'unknown', 'failed'] as const).entries()) {
    expect(read.health[outcome]).toMatchObject({ count: 1, latest: { workItemId: id(index + 1), kind: 'process_probe', at: next } });
  }
  expect(read.health.failed.latest).toMatchObject({ errorCode: 'TEMPORARY', errorRetryable: true, lastError: '마지막 오류' });
  // A later current attempt replaces a previous stalled outcome, even before
  // it has produced a terminal outcome of its own.
  await store.claimSupervisedWork({ now: next, claimedBy: id(99), kinds: ['process_probe'], attemptToken: id(601) });
  const changed = await store.readWorkAttemptHealth(); expect(changed.ok && changed.health.stalled.count).toBe(0);
  await db.query('drop table brain.work_attempts cascade');
  expect(await store.readWorkAttemptHealth()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
});
it('keeps last progress unchanged across heartbeat renewals', async () => {
  const { db, store } = await fixture(); const token = id(201);
  await store.addWork({ ...work(), kind: 'process_probe' });
  await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token });
  await store.renewSupervisedLease({ id: id(1), attemptToken: token, now, progressAt: now });
  await store.renewSupervisedLease({ id: id(1), attemptToken: token, now: next, progressAt: null });
  expect(await db.rows('select last_progress_at,renewed_at from brain.work_attempts')).toEqual([{ last_progress_at: now, renewed_at: next }]);
});

it('counts multiple stalled work items and selects the most recently finished one', async () => {
  const { store } = await fixture();
  const later = new Date(next.getTime() + 60_000);
  for (const [n, finishedAt] of [[1, next], [2, later]] as const) {
    const token = id(200 + n);
    await store.addWork({ ...work(n), kind: 'process_probe' });
    expect(await store.claimSupervisedWork({ now, claimedBy: id(99), kinds: ['process_probe'], attemptToken: token }))
      .toMatchObject({ ok: true, item: { id: id(n) } });
    expect(await store.finishSupervisedWork({ id: id(n), attemptToken: token, now: finishedAt, outcome: 'stalled', nextAttemptAt: later }))
      .toEqual({ ok: true, outcome: 'done' });
  }
  const read = await store.readWorkAttemptHealth(); expect(read.ok).toBe(true); if (!read.ok) return;
  expect(read.health.stalled).toMatchObject({ count: 2, latest: { workItemId: id(2), at: later } });
});

it('core drain success and permanent failure persist different PostgreSQL outcomes', async () => {
  const { db, store } = await fixture();
  const { drainQueue } = await import('@second-brain/core');
  const { memorySpool } = await import('@second-brain/core/testing');
  await store.addWork(work(1)); await store.addWork(work(2));
  expect(await drainQueue({ store, clock, spool: memorySpool(), idGen: sequenceIdGen({ timestampMs: now.getTime(), start: 1000 }) }, {
    budgetMs: 1000, handlers: { demo_work: async item => item.targetId === 'target-1' ? { ok: true } : { ok: false, code: 'PERMANENT', retryable: false, message: '처리 실패' } },
  })).toMatchObject({ completed: 1, failed: 1 });
  expect(await db.rows('select outcome,completed_at from brain.work_items order by id')).toEqual([
    { outcome: 'succeeded', completed_at: now }, { outcome: 'failed', completed_at: now },
  ]);
  expect(await db.rows('select code from brain.failures')).toEqual([{ code: 'PERMANENT' }]);
});

it('round trips graph serialization keys and preserves them when nodes merge', async () => {
  const { db, store } = await fixture();
  expect(await store.addWorkGraph({ nodes: [
    { ...work(1), serializationKey: 'original', after: [] }, { ...work(2), after: [0] },
  ] })).toMatchObject({ ok: true, items: [
    { created: true, item: { id: id(1), serializationKey: 'original' } },
    { created: true, item: { id: id(2), serializationKey: null } },
  ] });
  expect(await store.addWorkGraph({ nodes: [
    { ...work(1), id: id(3), serializationKey: 'replacement', after: [] },
    { ...work(2), id: id(4), serializationKey: 'also-replacement', after: [0] },
  ] })).toMatchObject({ ok: true, items: [
    { created: false, item: { id: id(1), serializationKey: 'original' } },
    { created: false, item: { id: id(2), serializationKey: null } },
  ] });
  expect(await db.rows('select id,serialization_key from brain.work_items order by id')).toEqual([
    { id: id(1), serialization_key: 'original' }, { id: id(2), serialization_key: null },
  ]);
});

it('rolls back a graph when the final insert fails after earlier nodes and an edge', async () => {
  const { db, store } = await fixture();
  expect(await store.addWorkGraph({ nodes: [{ ...work(8), after: [] }, { ...work(9), after: [0] }] })).toMatchObject({ ok: true });
  const before = {
    items: await db.rows('select * from brain.work_items order by id'),
    edges: await db.rows('select * from brain.work_dependencies order by work_item_id, prerequisite_id'),
  };
  await db.query(`create function brain.refuse_final_node() returns trigger language plpgsql as $$
    begin
      if new.id = '${id(3)}' then
        if (select count(*) from brain.work_items where id in ('${id(1)}', '${id(2)}')) = 2
          and exists (select 1 from brain.work_dependencies where work_item_id = '${id(2)}' and prerequisite_id = '${id(1)}') then
          raise exception 'refused final node after prefix';
        end if;
        raise exception 'graph prefix missing';
      end if;
      return new;
    end $$;
    create trigger refuse_final_node before insert on brain.work_items for each row execute function brain.refuse_final_node()`);
  expect(await store.addWorkGraph({ nodes: [
    { ...work(1), after: [] }, { ...work(2), after: [0] }, { ...work(3), after: [1] },
  ] })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', message: expect.stringContaining('refused final node after prefix') });
  expect(await db.rows('select * from brain.work_items order by id')).toEqual(before.items);
  expect(await db.rows('select * from brain.work_dependencies order by work_item_id, prerequisite_id')).toEqual(before.edges);
});

it.each([false, true])('rolls back root closure and propagation when a dependent update fails (supervised: %s)', async supervised => {
  const { db, store } = await fixture(); const token = id(201);
  expect(await store.addWorkGraph({ nodes: [
    { ...work(1), kind: supervised ? 'process_probe' : 'demo_work', after: [] },
    { ...work(2), after: [0] }, { ...work(3), after: [1] },
  ] })).toMatchObject({ ok: true });
  if (supervised) expect(await store.claimSupervisedWork({ now, claimedBy: 'worker', kinds: ['process_probe'], attemptToken: token })).toMatchObject({ ok: true, item: { id: id(1) } });
  else expect(await store.claimWork({ now, claimedBy: 'worker', kinds: ['demo_work'] })).toMatchObject({ ok: true, item: { id: id(1) } });
  const before = {
    items: await db.rows('select * from brain.work_items order by id'),
    attempts: await db.rows('select * from brain.work_attempts order by token'),
    failures: await db.rows('select * from brain.failures order by id'),
  };
  await db.query(`create function brain.refuse_dependent() returns trigger language plpgsql as $$
    begin
      if new.id = '${id(3)}' and new.outcome = 'dependency_failed' then
        if (select outcome from brain.work_items where id = '${id(1)}') = 'failed' then
          raise exception 'refused dependent after root closure';
        end if;
        raise exception 'root closure missing';
      end if;
      return new;
    end $$;
    create trigger refuse_dependent before update on brain.work_items for each row execute function brain.refuse_dependent()`);
  const failure = { id: id(301), targetKind: 'probe', targetId: work(1).targetId, stage: supervised ? 'process_probe' : 'demo_work',
    fingerprint: 'cause', harness: null, sessionId: null, code: 'PERMANENT', message: '처리 실패', occurredAt: next };
  const close = () => supervised
    ? store.finishSupervisedWork({ id: id(1), attemptToken: token, now: next, outcome: 'failed', failure })
    : store.recordFailure({ ...failure, closeWork: { id: id(1), claimedBy: 'worker', now: next } });
  expect(await close()).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE', message: expect.stringContaining('refused dependent after root closure') });
  expect(await db.rows('select * from brain.work_items order by id')).toEqual(before.items);
  expect(await db.rows('select * from brain.work_attempts order by token')).toEqual(before.attempts);
  expect(await db.rows('select * from brain.failures order by id')).toEqual(before.failures);
  await db.query('drop trigger refuse_dependent on brain.work_items');
  expect(await close()).toMatchObject({ ok: true });
  expect(await db.rows('select outcome, completed_at from brain.work_items order by id')).toEqual([
    { outcome: 'failed', completed_at: next },
    { outcome: 'dependency_failed', completed_at: next }, { outcome: 'dependency_failed', completed_at: next },
  ]);
  expect(await db.rows('select id from brain.failures')).toEqual([{ id: failure.id }]);
  expect(await db.rows('select outcome, finished_at from brain.work_attempts')).toEqual(supervised ? [{ outcome: 'failed', finished_at: next }] : []);
});

it('rejects self edges and references to missing work', async () => {
  const { db, store } = await fixture(); await store.addWork(work());
  await expect(db.query(`insert into brain.work_dependencies values ('${id(1)}', '${id(1)}')`)).rejects.toThrow();
  await expect(db.query(`insert into brain.work_dependencies values ('${id(1)}', '${id(2)}')`)).rejects.toThrow();
  await expect(db.query(`insert into brain.work_dependencies values ('${id(2)}', '${id(1)}')`)).rejects.toThrow();
});

it('enqueues a graph through core and unlocks the PG dependent only after success', async () => {
  const { store } = await fixture();
  const result = await enqueueWorkGraph({ store, clock, idGen: sequenceIdGen({ timestampMs: now.getTime() }) }, {
    nodes: [{ key: 'b', kind: 'demo_work', targetKind: 'probe', targetId: 'b', after: ['a'] },
      { key: 'a', kind: 'demo_work', targetKind: 'probe', targetId: 'a', after: [] }],
  });
  expect(result.ok).toBe(true); if (!result.ok) return;
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: result.items.a!.id } });
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'other' })).toEqual({ ok: true, item: null });
  await store.completeWork({ id: result.items.a!.id, claimedBy: 'worker', now });
  expect(await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' })).toMatchObject({ ok: true, item: { id: result.items.b!.id } });
});

it('closes a dependent committed while propagation waits for its merged prerequisite lock', async () => {
  const { db, store, blocker } = await fixture({ applicationName: 'brain-dependency-race-close', lockTimeoutMs: 5000 });
  await store.addWorkGraph({ nodes: [{ ...work(1), after: [] }, { ...work(2), after: [0] }, { ...work(4), after: [0] }] });
  await store.requestWorkCancel({ id: id(4), now });
  const closedBefore = await db.rows(`select * from brain.work_items where id = '${id(4)}'`);
  await store.claimWork({ now, kinds: ['demo_work'], claimedBy: 'worker' });

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const selects = new Set<unknown>();
  // Stop the real addWorkGraph transaction after it locks existing B, before
  // inserting C or its edge. The failing transaction must miss C initially.
  const barrier: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'RawNode' && node.sqlFragments.join('').includes('for update')) selects.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (selects.delete(queryId) && !paused) { paused = true; await gate; }
      return result;
    },
  };
  const connection = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({
    databaseUrl: db.appUrl, applicationName: 'brain-dependency-race-graph', lockTimeoutMs: 5000,
  }) }), plugins: [barrier] });
  cleanup.push(() => connection.destroy());
  const graphStore = postgresWorkStore(() => ({ ok: true, connection: { db: connection } }));
  const graph = graphStore.addWorkGraph({ nodes: [{ ...work(2), id: id(20), after: [] }, { ...work(3), after: [0] }] });
  let failing: ReturnType<typeof store.recordFailure> | undefined;
  try {
    await expect.poll(() => paused, { timeout: 2000 }).toBe(true);
    failing = store.recordFailure({ id: id(10), targetKind: 'probe', targetId: work(1).targetId, stage: 'demo_work',
      fingerprint: 'root', harness: null, sessionId: null, code: 'error', message: 'root failure', occurredAt: next,
      closeWork: { id: id(1), claimedBy: 'worker', now: next } });
    await expect.poll(async () => {
      const result = await blocker.query(`select cardinality(pg_blocking_pids(pid)) > 0 as blocked
        from pg_stat_activity where datname = current_database() and application_name = $1
          and query like '%with recursive dependents%'`, ['brain-dependency-race-close']);
      return result.rows[0]?.blocked;
    }, { timeout: 2000 }).toBe(true);
    release();
    expect(await graph).toMatchObject({ ok: true, items: [{ created: false, item: { id: id(2) } }, { created: true, item: { id: id(3) } }] });
    expect(await failing).toMatchObject({ ok: true, outcome: 'recorded' });
    expect(await db.rows(`select id, outcome, completed_at, last_error, claimed_by, claimed_at, claim_expires_at
      from brain.work_items where id in ('${id(1)}', '${id(2)}', '${id(3)}') order by id`)).toEqual([
      { id: id(1), outcome: 'failed', completed_at: next, last_error: 'root failure', claimed_by: null, claimed_at: null, claim_expires_at: null },
      ...[2, 3].map(n => ({ id: id(n), outcome: 'dependency_failed', completed_at: next,
        last_error: dependencyFailedText(id(1), 'failed'), claimed_by: null, claimed_at: null, claim_expires_at: null })),
    ]);
    expect(await db.rows(`select * from brain.work_items where id = '${id(4)}'`)).toEqual(closedBefore);
    expect(await store.hasDueWork({ now: next, kinds: ['demo_work'] })).toEqual({ ok: true, due: false });
  } finally { release(); await Promise.allSettled([graph, failing]); }
});

it.each([
  ['core', 'core'], ['core', 'supervised'], ['supervised', 'core'],
] as const)('claims one serialization key once when two connections race (%s → %s)', async (firstPath, secondPath) => {
  const { db, store } = await fixture();
  const firstKind = firstPath === 'core' ? 'demo_work' : 'process_probe';
  const secondKind = secondPath === 'core' ? 'demo_other' : 'process_probe';
  await store.addWork({ ...work(1), kind: firstKind, serializationKey: 'shared' });
  await store.addWork({ ...work(2), kind: secondKind, serializationKey: 'shared' });
  const selects = new Set<unknown>();
  let raced = false;
  const barrier: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'RawNode' && node.sqlFragments.join('').includes('for update skip locked')) selects.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (selects.delete(queryId) && !raced) {
        raced = true;
        expect(result.rows).toHaveLength(1);
        const query = { now, kinds: [secondKind], claimedBy: 'second' };
        const claimed = secondPath === 'core' ? await store.claimWork(query)
          : await store.claimSupervisedWork({ ...query, attemptToken: id(101) });
        expect(claimed).toMatchObject({ ok: true, item: { id: id(2) } });
      }
      return result;
    },
  };
  const connection = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: db.appUrl }) }), plugins: [barrier] });
  cleanup.push(() => connection.destroy());
  const racing = postgresWorkStore(() => ({ ok: true, connection: { db: connection } }));
  const query = { now, kinds: [firstKind], claimedBy: 'first' };
  const claimed = firstPath === 'core' ? await racing.claimWork(query)
    : await racing.claimSupervisedWork({ ...query, attemptToken: id(102) });
  expect(raced).toBe(true);
  expect(claimed).toMatchObject({ ok: true, item: null });
  expect(await db.rows('select id from brain.work_items where claimed_by is not null')).toEqual([{ id: id(2) }]);
});

// Gates stop after a statement executed, while its transaction still owns locks.
function claimBarrier(matches: (fragments: string) => boolean) {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const queries = new Set<unknown>();
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'RawNode' && matches(node.sqlFragments.join(''))) queries.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (queries.delete(queryId) && !paused) { paused = true; await gate; }
      return result;
    },
  };
  return { plugin, release, paused: () => paused };
}

it.each(['core', 'supervised'] as const)('releases a discarded key before selecting another candidate (%s)', async path => {
  const { db, store, blocker } = await fixture();
  const kind = path === 'core' ? 'demo_work' : 'process_probe';
  await store.addWork({ ...work(1), kind, serializationKey: 'discarded' });
  await store.addWork({ ...work(2), kind: 'demo_other', serializationKey: 'discarded' });
  // A second key proves this is the continuation of the claim loop, not commit.
  await store.addWork({ ...work(3), kind, serializationKey: 'next' });
  const selects = new Set<unknown>();
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let paused = false;
  const plugin: KyselyPlugin = {
    transformQuery({ node, queryId }) {
      if (node.kind === 'RawNode' && node.sqlFragments.join('').includes('for update skip locked')) selects.add(queryId);
      return node;
    },
    async transformResult({ result, queryId }) {
      if (selects.delete(queryId)) {
        if (++count === 1) {
          expect(result.rows).toMatchObject([{ id: id(1) }]);
          expect(await store.claimWork({ now, kinds: ['demo_other'], claimedBy: 'holder' }))
            .toMatchObject({ ok: true, item: { id: id(2) } });
        } else if (count === 2) {
          expect(result.rows).toMatchObject([{ id: id(3) }]);
          paused = true; await gate;
        }
      }
      return result;
    },
  };
  const connection = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: db.appUrl }) }), plugins: [plugin] });
  cleanup.push(() => connection.destroy());
  const racing = postgresWorkStore(() => ({ ok: true, connection: { db: connection } }));
  const query = { now, kinds: [kind], claimedBy: 'racing' };
  const claim = path === 'core' ? racing.claimWork(query) : racing.claimSupervisedWork({ ...query, attemptToken: id(101) });
  try {
    await expect.poll(() => paused, { timeout: 3000 }).toBe(true);
    await blocker.query('begin');
    const acquired = await blocker.query("select pg_try_advisory_xact_lock(hashtextextended('work-key:discarded', 0)) as acquired");
    expect(acquired.rows[0]?.acquired).toBe(true);
    await blocker.query('rollback');
    release();
    expect(await claim).toMatchObject({ ok: true, item: { id: id(3) } });
  } finally { release(); await claim; }
});

it.each([
  ['core', 'core'], ['core', 'supervised'], ['supervised', 'core'], ['supervised', 'supervised'],
] as const)('waits for the key lock before rechecking a concurrent holder (%s → %s)', async (firstPath, secondPath) => {
  const { db, store, blocker } = await fixture();
  const firstKind = firstPath === 'core' ? 'demo_work' : 'process_probe';
  const secondKind = secondPath === 'core' ? 'demo_other' : 'process_probe';
  await store.addWork({ ...work(1), kind: firstKind, serializationKey: 'shared-wait' });
  await store.addWork({ ...work(2), kind: secondKind, serializationKey: 'shared-wait' });
  const firstGate = claimBarrier(text => text.includes('for update skip locked'));
  const secondGate = claimBarrier(text => text.includes('as available'));
  const connection = (name: string, plugin: KyselyPlugin) => {
    const db = new Kysely<PgSchema>({ dialect: new PostgresDialect({ pool: createPool({ databaseUrl: fixtureUrl, applicationName: name }) }), plugins: [plugin] });
    cleanup.push(() => db.destroy());
    return postgresWorkStore(() => ({ ok: true, connection: { db } }));
  };
  const fixtureUrl = db.appUrl;
  const first = connection('brain-key-wait-first', firstGate.plugin);
  const second = connection('brain-key-wait-second', secondGate.plugin);
  const claim = (s: typeof first, path: 'core' | 'supervised', kind: string, token: string) => {
    const query = { now, kinds: [kind], claimedBy: token };
    return path === 'core' ? s.claimWork(query) : s.claimSupervisedWork({ ...query, attemptToken: token });
  };
  const firstCall = claim(first, firstPath, firstKind, id(101));
  let secondCall: ReturnType<typeof claim> | undefined;
  try {
    await expect.poll(firstGate.paused, { timeout: 3000 }).toBe(true);
    secondCall = claim(second, secondPath, secondKind, id(102));
    await expect.poll(secondGate.paused, { timeout: 3000 }).toBe(true);
    // The second transaction passed its re-check but has not committed yet.
    firstGate.release();
    await expect.poll(async () => {
      const result = await blocker.query(`select exists (
        select 1 from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where a.datname = current_database() and a.application_name = 'brain-key-wait-first'
          and l.locktype = 'advisory' and l.granted = false
      ) as waiting`);
      return result.rows[0]?.waiting;
    }, { timeout: 3000 }).toBe(true);
    secondGate.release();
    expect(await secondCall).toMatchObject({ ok: true, item: { id: id(2) } });
    expect(await firstCall).toMatchObject({ ok: true, item: null });
  } finally {
    firstGate.release(); secondGate.release();
    await Promise.allSettled([firstCall, secondCall]);
  }
});

function keyClaimWorker(databaseUrl: string, path: 'core' | 'supervised') {
  const script = fileURLToPath(new URL('./fixtures/key-claim-worker.mjs', import.meta.url));
  const child = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = createInterface({ input: child.stdout });
  const queued: string[] = [];
  let waiting: ((line: string) => void) | undefined;
  let failed: ((error: Error) => void) | undefined;
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', data => { stderr += String(data); });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', code => {
      clearTimeout(timeout); lines.close();
      const error = new Error(`key claim worker exited ${String(code)}: ${stderr}`);
      if (waiting) failed?.(error);
      if (code !== 0) reject(error); else resolve();
    });
  });
  void done.catch(() => {});
  lines.on('line', line => { if (waiting) { const resolve = waiting; waiting = undefined; failed = undefined; resolve(line); } else queued.push(line); });
  const receive = (): Promise<string> => queued.length > 0 ? Promise.resolve(queued.shift()!) : new Promise((resolve, reject) => { waiting = resolve; failed = reject; });
  child.stdin.on('error', () => {});
  child.stdin.write(`${JSON.stringify({ databaseUrl, path, now: now.toISOString() })}\n`);
  return {
    ready: receive(),
    async go(): Promise<{ id: string; key: string }[]> { child.stdin.write('go\n'); return JSON.parse(await receive()); },
    async close() { child.stdin.end(); await done; },
    async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await done.catch(() => {}); },
  };
}
it('two processes never hold one serialization key at once', async () => {
  const { db, store } = await fixture();
  const children = [keyClaimWorker(db.appUrl, 'core'), keyClaimWorker(db.appUrl, 'supervised')];
  cleanup.push(() => Promise.all(children.map(child => child.stop())));
  try {
    expect(await Promise.all(children.map(child => child.ready))).toEqual(['ready', 'ready']);
    for (let round = 0; round < 20; round++) {
      for (const [offset, kind, key] of [
        [1, 'demo_work', `k_${round}`], [2, 'process_probe', `k_${round}`],
        [3, 'demo_other', `x_${round}`], [4, 'process_probe', `y_${round}`],
      ] as const) expect(await store.addWork({ ...work(round * 4 + offset), kind, serializationKey: key })).toMatchObject({ ok: true });
      const claimed = (await Promise.all(children.map(child => child.go()))).flat();
      expect(claimed.filter(item => item.key === `k_${round}`)).toHaveLength(1);
      expect(claimed.filter(item => item.key === `x_${round}`)).toHaveLength(1);
      expect(claimed.filter(item => item.key === `y_${round}`)).toHaveLength(1);
      expect(claimed).toHaveLength(3);
      expect(await db.rows(`select serialization_key from brain.work_items where completed_at is null
        and (current_attempt_token is not null or (claimed_by is not null and claim_expires_at > '${now.toISOString()}'))
        group by serialization_key having count(*) > 1`)).toEqual([]);
    }
    await Promise.all(children.map(child => child.close()));
  } finally { await Promise.all(children.map(child => child.stop())); }
}, 40_000);

it('releasing an unknown attempt token frees its key', async () => {
  const { db, store } = await fixture();
  await store.addWork({ ...work(1), kind: 'process_probe', serializationKey: 'shared' });
  await store.addWork({ ...work(2), serializationKey: 'shared' });
  expect(await store.claimSupervisedWork({ now, kinds: ['process_probe'], claimedBy: 'supervisor', attemptToken: id(101) })).toMatchObject({ ok: true, item: { id: id(1) } });
  await store.settleSupervisedAttempt({ id: id(1), attemptToken: id(101), now, outcome: 'unknown' });
  const afterExpiry = new Date(now.getTime() + 3_600_000);
  expect(await store.claimWork({ now: afterExpiry, kinds: ['demo_work'], claimedBy: 'core' })).toMatchObject({ ok: true, item: null });
  await db.query(`update brain.work_items set current_attempt_token = null where id = '${id(1)}'`);
  expect(await store.claimWork({ now: afterExpiry, kinds: ['demo_work'], claimedBy: 'core' })).toMatchObject({ ok: true, item: { id: id(2) } });
});

it.each(['', 'k'.repeat(201)])('rejects invalid serialization keys (%s)', async serializationKey => {
  const { db, store } = await fixture();
  expect(await store.addWork({ ...work(), serializationKey })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(await db.rows('select id from brain.work_items')).toEqual([]);
});


it('closes a tenth recovered supervised death with one PROCESS_DIED failure', async () => {
  const { db, store } = await fixture();
  await store.addWork({ ...work(), kind: 'process_probe' });
  await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['process_probe'], attemptToken: id(101) });
  await db.query(`update brain.work_items set attempts = 10 where id = '${id(1)}'`);
  const controller = new AbortController(); const time = manualTime(now);
  const running = runSupervisor({ store, schemaVersions: { core: 43 }, ...time,
    inspector: fakeProcessInspector(), launcher: fakeProcessLauncher(),
    idGen: sequenceIdGen({ timestampMs: now.getTime() }), signal: controller.signal, launches: {} });
  try {
    await expect.poll(async () => (await db.rows('select outcome from brain.work_items'))[0]?.outcome).toBe('failed');
    expect(await db.rows('select outcome from brain.work_attempts')).toMatchObject([{ outcome: 'died' }]);
    expect(await db.rows('select completed_at, last_error, current_attempt_token from brain.work_items')).toMatchObject([
      { completed_at: expect.any(Date), last_error: expect.stringContaining('PROCESS_DIED'), current_attempt_token: null },
    ]);
    expect(await db.rows('select code, target_kind, target_id, stage from brain.failures')).toEqual([
      { code: 'PROCESS_DIED', target_kind: 'probe', target_id: 'target-1', stage: 'process_probe' },
    ]);
    expect(await store.claimSupervisedWork({ now, claimedBy: 'next', kinds: ['process_probe'], attemptToken: id(102) })).toMatchObject({ ok: true, item: null });
  } finally { controller.abort(); await running; }
});
