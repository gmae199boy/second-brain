import { copyFile, mkdtemp, readdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { postgresStore, runMigrations } from '../src/index.js';
import { clock, database } from './fixture.js';
const databases: TestDatabase[] = []; const folders: string[] = [];
afterEach(async () => { await Promise.all([...databases.splice(0).map(db => db.drop()), ...folders.splice(0).map(f => rm(f, { recursive: true, force: true }))]); });
async function fresh() { const db = await database(false); databases.push(db); return db; }
async function owner(names: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-')); folders.push(directory);
  for (const name of names) await writeFile(join(directory,name), 'select 1;');
  return { owner: 'example', directory };
}
it('records checksums and the injected clock and applies nothing on repeat', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 0, to: 15, applied: ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 15, to: 15, applied: [] });
  expect(await db.rows('select owner,version,length(checksum) as length,applied_at from brain.schema_migrations order by version')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].map(version => ({ owner: 'core', version, length: 64, applied_at: clock.now() })));
});
it('backfills existing v1 work as core and keeps it claimable after upgrading to v2', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v1-')); folders.push(directory);
  await copyFile(new URL('../migrations/0001_initial.sql', import.meta.url), join(directory, '0001_initial.sql'));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] }))
    .toMatchObject({ ok: true, to: 1, applied: ['0001_initial.sql'] });
  const id = '01940000-0000-7000-8000-000000000001';
  await db.query(`insert into brain.work_items (id, kind, target_kind, target_id, created_at, attempts, next_attempt_at)
    values ('${id}', 'upgrade_probe', 'probe', 'existing', '2026-01-01T00:00:00Z', 0, '2026-01-01T00:00:00Z')`);
  expect(await runMigrations({ databaseUrl: db.url, clock }))
    .toMatchObject({ ok: true, from: 1, to: 15, applied: ['0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  expect(await db.rows('select execution_class, current_attempt_token, serialization_key from brain.work_items'))
    .toEqual([{ execution_class: 'core', current_attempt_token: null, serialization_key: null }]);
  const store = postgresStore({ databaseUrl: db.appUrl });
  try {
    expect(await store.claimWork({ now: clock.now(), claimedBy: id, kinds: ['upgrade_probe'] }))
      .toMatchObject({ ok: true, item: { id, executionClass: 'core', currentAttemptToken: null, attempts: 1 } });
  } finally { await store.close(); }
});
it('preserves legacy closed work with a null outcome when upgrading v5 to v6', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v5-')); folders.push(directory);
  for (const file of ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql']) {
    await copyFile(new URL(`../migrations/${file}`, import.meta.url), join(directory, file));
  }
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] }))
    .toMatchObject({ ok: true, to: 5 });
  const id = '01940000-0000-7000-8000-000000000001';
  const completedAt = new Date('2026-01-01T00:05:00Z');
  await db.query(`insert into brain.work_items (id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,execution_class,completed_at,outcome)
    values ('${id}','upgrade_probe','probe','legacy-closed','2026-01-01T00:00:00Z',1,'2026-01-01T00:00:00Z','core','${completedAt.toISOString()}',null)`);
  expect(await runMigrations({ databaseUrl: db.url, clock }))
    .toMatchObject({ ok: true, from: 5, to: 15, applied: ['0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  expect(await db.rows(`select completed_at,outcome from brain.work_items where id='${id}'`))
    .toEqual([{ completed_at: completedAt, outcome: null }]);
});
it('applies each file only once under simultaneous runners', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  const results = await Promise.all([runMigrations(options), runMigrations(options)]);
  expect(results.every(r => r.ok)).toBe(true);
  expect(results.flatMap(r => r.ok ? r.applied : []).length).toBe(15);
});
it('waits more than five seconds for another migration runner', async () => {
  const db = await fresh();
  const blocker = new pg.Client({ connectionString: db.url });
  await blocker.connect();
  let pending: ReturnType<typeof runMigrations> | undefined;
  try {
    await blocker.query('begin');
    await blocker.query('select pg_advisory_xact_lock($1)', [4919270911]);
    pending = runMigrations({ databaseUrl: db.url, clock });
    await setTimeout(6200);
    await blocker.query('commit');
    expect(await pending).toMatchObject({ ok: true, from: 0, to: 15, applied: ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  } finally { await blocker.end(); await pending; }
});
it.each([['0001_a.sql','0001_b.sql'], ['0001_a.sql','0003_c.sql'], ['0002_b.sql']])('rejects duplicate or missing sequence before applying %j', async (...names) => {
  const db = await fresh(); const source = await owner(names);
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [source] })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(await db.rows('select * from brain.schema_migrations')).toEqual([]);
});
it('supports another owner and refuses changed checksums before any pending file', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql']); const options = { databaseUrl: db.url, clock, owners: [source] };
  expect((await runMigrations(options)).ok).toBe(true);
  await writeFile(join(source.directory,'0001_a.sql'),'select 2;');
  await writeFile(join(source.directory,'0002_b.sql'),'create table brain.should_not_exist(id int);');
  expect(await runMigrations(options)).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect((await db.rows("select to_regclass('brain.should_not_exist') as name"))[0]).toEqual({ name: null });
});
it('allows an explicitly supplied core folder to have its own highest version', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql', '0002_b.sql']);
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ ...source, owner: 'core' }] }))
    .toMatchObject({ ok: true, to: 2, applied: ['0001_a.sql', '0002_b.sql'] });
});
it('rejects a gap in an applied owner history', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql','0002_b.sql']); const options = { databaseUrl: db.url, clock, owners: [source] };
  expect((await runMigrations(options)).ok).toBe(true); await db.query("delete from brain.schema_migrations where owner='example' and version=1");
  expect(await runMigrations(options)).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
});
it('rolls back the current file on DDL failure', async () => {
  const db = await fresh(); const source = await owner(['0001_a.sql']);
  await writeFile(join(source.directory,'0001_a.sql'),'create table brain.rolled_back(id int); select missing_column;');
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [source] })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(await db.rows('select * from brain.schema_migrations')).toEqual([]);
  expect((await db.rows("select to_regclass('brain.rolled_back') as name"))[0]).toEqual({ name: null });
});
it('upgrades v2 attempts, closing only noncurrent open history at its latest recorded instant', async () => {
  const db = await fresh(); const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v2-')); folders.push(directory);
  for (const file of ['0001_initial.sql', '0002_supervised_attempts.sql']) await copyFile(new URL(`../migrations/${file}`, import.meta.url), join(directory, file));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 2 });
  const workId = '01940000-0000-7000-8000-000000000001'; const old = '01940000-0000-7000-8000-000000000002'; const current = '01940000-0000-7000-8000-000000000003';
  await db.query(`insert into brain.work_items (id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,execution_class)
    values ('${workId}','process_probe','probe','existing','2026-01-01T00:00:00Z',2,'2026-01-01T00:00:00Z','supervised')`);
  await db.query(`insert into brain.work_attempts (token,work_item_id,started_at,renewed_at,last_progress_at)
    values ('${old}','${workId}','2026-01-01T00:00:00Z','2026-01-01T00:01:00Z','2026-01-01T00:02:00Z'),
    ('${current}','${workId}','2026-01-01T00:03:00Z',null,null)`);
  await db.query(`update brain.work_items set current_attempt_token='${current}',claimed_at='2026-01-01T00:03:00Z',claim_expires_at='2026-01-01T00:13:00Z',claimed_by='prior' where id='${workId}'`);
  const claimColumns = 'current_attempt_token,claimed_at,claim_expires_at,claimed_by,attempts';
  const claimBefore = await db.rows(`select ${claimColumns} from brain.work_items`);
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 2, to: 15, applied: ['0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  expect(await db.rows('select token,outcome,finished_at,incarnation,pid,pgid,os_boot_at,os_started_at from brain.work_attempts order by token')).toEqual([
    { token: old, outcome: 'died', finished_at: new Date('2026-01-01T00:02:00Z'), incarnation: null, pid: null, pgid: null, os_boot_at: null, os_started_at: null },
    { token: current, outcome: null, finished_at: null, incarnation: null, pid: null, pgid: null, os_boot_at: null, os_started_at: null },
  ]);
  expect(await db.rows('select outcome,cancel_requested_at from brain.work_items')).toEqual([{ outcome: null, cancel_requested_at: null }]);
  expect(await db.rows(`select ${claimColumns} from brain.work_items`)).toEqual(claimBefore);
  expect(await db.rows('select serialization_key from brain.work_items')).toEqual([{ serialization_key: null }]);
});

it('backfills v9 extension hold groups and skips groups longer than 200 characters', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v9-')); folders.push(directory);
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => /^000[1-9]_.*\.sql$/.test(file)))
    await copyFile(new URL(`../migrations/${file}`, import.meta.url), join(directory, file));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 9 });
  const cases = [
    { kind: 'testext.daily.more', hold_group: 'extension:testext' },
    { kind: 'core_job', hold_group: null },
    { kind: 'x'.repeat(190) + '.job', hold_group: 'extension:' + 'x'.repeat(190) },
    { kind: 'x'.repeat(191) + '.job', hold_group: null },
  ];
  for (const [index, { kind }] of cases.entries()) {
    const id = `01940000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
    await db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class)
      values ('${id}','${kind}','probe','${index}','2026-10-29T00:00:00Z','2026-10-29T00:00:00Z','core')`);
    await db.query(`insert into brain.schedules(id,kind,target_kind,target_id,local_time,time_zone,next_run_at,created_at)
      values ('${id}','${kind}','probe','${index}','11:00','Asia/Seoul','2026-10-29T02:00:00Z','2026-10-29T00:00:00Z')`);
  }
  expect(await runMigrations({ databaseUrl: db.url, clock }))
    .toMatchObject({ ok: true, from: 9, to: 15, applied: ['0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  for (const table of ['work_items', 'schedules'])
    expect(await db.rows(`select kind,hold_group from brain.${table} order by id`)).toEqual(cases);
});

it('preserves v8 schedules and enforces v9 work dates and schedule deletion rules', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v8-')); folders.push(directory);
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => /^000[1-8]_.*\.sql$/.test(file)))
    await copyFile(new URL(`../migrations/${file}`, import.meta.url), join(directory, file));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 8 });
  const interval = '01940000-0000-7000-8000-000000000001';
  const once = '01940000-0000-7000-8000-000000000002';
  const workId = '01940000-0000-7000-8000-000000000003';
  await db.query(`insert into brain.schedules(id,kind,target_kind,target_id,interval_seconds,next_run_at,last_run_at,created_at) values
    ('${interval}','upgrade_probe','probe','interval',60,'2026-10-29T02:00:00Z','2026-10-29T01:59:00Z','2026-10-01T00:00:00Z'),
    ('${once}','upgrade_probe','probe','once',null,null,'2026-10-28T02:00:00Z','2026-10-01T00:00:00Z')`);
  await db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome,execution_class)
    values ('${workId}','upgrade_probe','probe','once','2026-10-28T02:00:00Z',1,'2026-10-28T02:00:00Z','2026-10-28T02:01:00Z','succeeded','core')`);
  const columns = 'id,kind,target_kind,target_id,interval_seconds,next_run_at,last_run_at,created_at';
  const schedulesBefore = await db.rows(`select ${columns} from brain.schedules order by id`);
  const workColumns = 'id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome';
  const workBefore = await db.rows(`select ${workColumns} from brain.work_items`);
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 8, to: 15, applied: ['0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql'] });
  expect(await db.rows(`select ${columns} from brain.schedules order by id`)).toEqual(schedulesBefore);
  expect(await db.rows(`select ${workColumns} from brain.work_items`)).toEqual(workBefore);
  expect(await db.rows('select local_time,time_zone from brain.schedules')).toEqual([
    { local_time: null, time_zone: null }, { local_time: null, time_zone: null },
  ]);
  expect(await db.rows('select schedule_id,local_date_from,local_date_to,local_time_zone,claimed_date_from,claimed_date_to from brain.work_items'))
    .toEqual([{ schedule_id: null, local_date_from: null, local_date_to: null, local_time_zone: null, claimed_date_from: null, claimed_date_to: null }]);
  for (const [change, constraint] of [
    ["local_date_from='2026-10-01'", 'work_local_dates_shape'],
    ["local_date_to='2026-10-01'", 'work_local_dates_shape'],
    ["local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["local_date_from='2026-10-01',local_date_to='2026-10-02'", 'work_local_dates_shape'],
    ["local_date_from='2026-10-01',local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["local_date_to='2026-10-01',local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["local_date_from='2026-10-02',local_date_to='2026-10-01',local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["claimed_date_from='2026-10-01'", 'work_claimed_dates_shape'],
    ["claimed_date_to='2026-10-01'", 'work_claimed_dates_shape'],
    ["claimed_date_from='2026-10-02',claimed_date_to='2026-10-01'", 'work_claimed_dates_shape'],
  ]) await expect(db.query(`update brain.work_items set ${change} where id='${workId}'`)).rejects.toMatchObject({ code: '23514', constraint });
  await db.query(`update brain.work_items set schedule_id='${once}',local_date_from='2026-10-01',local_date_to='2026-10-02',local_time_zone='Asia/Seoul',
    claimed_date_from='2026-10-01',claimed_date_to='2026-10-02' where id='${workId}'`);
  await db.query(`insert into brain.schedule_successes(schedule_id,local_date,time_zone,work_id,recorded_at)
    values ('${once}','2026-10-01','Asia/Seoul','${workId}','2026-10-28T02:01:00Z')`);
  expect(await db.rows('select work_id from brain.schedule_successes')).toEqual([{ work_id: workId }]);
  await db.query(`delete from brain.schedules where id='${once}'`);
  expect(await db.rows('select schedule_id,local_date_from::text,local_date_to::text,local_time_zone from brain.work_items'))
    .toEqual([{ schedule_id: null, local_date_from: '2026-10-01', local_date_to: '2026-10-02', local_time_zone: 'Asia/Seoul' }]);
  expect(await db.rows(`select ${workColumns} from brain.work_items`)).toEqual(workBefore);
  expect(await db.rows('select * from brain.schedule_successes')).toEqual([]);
  expect(await db.rows(`select ${columns} from brain.schedules`)).toEqual([schedulesBefore[0]]);
});
