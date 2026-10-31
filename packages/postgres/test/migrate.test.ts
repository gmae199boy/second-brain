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
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 0, to: 27, applied: ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 27, to: 27, applied: [] });
  expect(await db.rows('select owner,version,length(checksum) as length,applied_at from brain.schema_migrations order by version')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27].map(version => ({ owner: 'core', version, length: 64, applied_at: clock.now() })));
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
    .toMatchObject({ ok: true, from: 1, to: 27, applied: ['0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
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
    .toMatchObject({ ok: true, from: 5, to: 27, applied: ['0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
  expect(await db.rows(`select completed_at,outcome from brain.work_items where id='${id}'`))
    .toEqual([{ completed_at: completedAt, outcome: null }]);
});
it('applies each file only once under simultaneous runners', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  const results = await Promise.all([runMigrations(options), runMigrations(options)]);
  expect(results.every(r => r.ok)).toBe(true);
  expect(results.flatMap(r => r.ok ? r.applied : []).length).toBe(27);
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
    expect(await pending).toMatchObject({ ok: true, from: 0, to: 27, applied: ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
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
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 2, to: 27, applied: ['0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
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
    .toMatchObject({ ok: true, from: 9, to: 27, applied: ['0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
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
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 8, to: 27, applied: ['0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
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
it('v17 채널 성공과 미확정 gate를 보존하며 시도 이력을 확장한다', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v17-')); folders.push(directory);
  const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name < '0018');
  for (const name of names) await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 17 });
  const store = postgresStore({ databaseUrl: db.appUrl }); const now = clock.now();
  const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  try {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    for (const n of [3, 4]) {
      await db.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at) values ('${id(n)}','${id(2)}','test','${n}','notice','보존','${now.toISOString()}')`);
      await store.handoffChannelRequest({ requestId: id(n), workId: id(n + 10), now });
      await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: id(n + 20) });
      await db.query(`insert into brain.channel_gates values ('${id(n)}','${id(n + 10)}','${id(n + 20)}',now())`);
      if (n === 3) {
        await db.query(`insert into brain.channel_attempt_results values ('${id(n)}','${id(n + 10)}','${id(n + 20)}','42',now())`);
        await db.query(`update brain.channel_requests set status='sent', external_message_id='42' where id='${id(n)}'`);
      }
    }
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 17, to: 27 });
    expect(await db.rows('select request_id,outcome,external_message_id from brain.channel_attempt_results order by request_id')).toEqual([
      { request_id: id(3), outcome: 'sent', external_message_id: '42' },
      { request_id: id(4), outcome: 'unknown', external_message_id: null },
    ]);
    expect(await db.rows('select body,status from brain.channel_requests order by id')).toEqual([{ body: '보존', status: 'sent' }, { body: '보존', status: 'pending' }]);
    expect(await db.rows('select request_id from brain.channel_gates order by request_id')).toEqual([{ request_id: id(3) }, { request_id: id(4) }]);
  } finally { await store.close(); }
});

it('v18 요청과 결과를 그대로 보존한다', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v18-')); folders.push(directory);
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name < '0019')) await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 18 });
  await db.query(`insert into brain.channels values ('00000000-0000-7000-8000-000000000001','telegram','bot');
    insert into brain.channel_conversations values ('00000000-0000-7000-8000-000000000002','00000000-0000-7000-8000-000000000001','chat',null);
    insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,external_message_id) values ('00000000-0000-7000-8000-000000000003','00000000-0000-7000-8000-000000000002','core','result','notice','보존',now(),'sent','42')`);
  const before = await db.rows('select id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,external_message_id from brain.channel_requests');
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 18, to: 27 });
  expect(await db.rows('select id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,external_message_id from brain.channel_requests')).toEqual(before);
});

it('v19 요청과 migration checksum을 보존하고 v20을 적용한다', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v19-')); folders.push(directory);
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name < '0020')) await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 19 });
  await db.query(`insert into brain.channels values ('00000000-0000-7000-8000-000000000001','telegram','bot');
    insert into brain.channel_conversations values ('00000000-0000-7000-8000-000000000002','00000000-0000-7000-8000-000000000001','chat',null);
    set role brain_app;
    insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at) values ('00000000-0000-7000-8000-000000000003','00000000-0000-7000-8000-000000000002','core','result','notice','보존',now()); reset role`);
  const before = await db.rows('select * from brain.schema_migrations order by version');
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 19, to: 27, applied: ['0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql'] });
  expect(await db.rows('select * from brain.schema_migrations where version <= 19 order by version')).toEqual(before);
  expect(await db.rows('select body,bundle from brain.channel_requests')).toEqual([{ body: '보존', bundle: null }]);
});

it('v20의 역순 물리 행을 기록 시각순으로 옮기고 새 시도를 뒤에 연결한다', async () => {
  const db = await fresh(); const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v20-')); folders.push(directory);
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name < '0021')) await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 20 });
  const store = postgresStore({ databaseUrl: db.appUrl });
  const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const now = new Date('2026-10-31T00:00:00Z');
  try {
    await store.ensureChannel({ id: id(1), kind: 'telegram', botRef: 'bot' });
    await store.ensureChannelConversation({ id: id(2), channelId: id(1), externalRef: 'chat', threadRef: null });
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'body', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    await db.query(`alter table brain.channel_attempt_results disable trigger channel_result_fence;
      insert into brain.channel_attempt_results(request_id,work_item_id,attempt_token,created_at,outcome,error_code,retryable,finished_at) values
      ('${id(3)}','${id(4)}','${id(5)}','2026-10-31T00:00:02Z','unknown','NEW',true,'2026-10-31T00:00:03Z'),
      ('${id(3)}','${id(4)}','${id(9)}','2026-10-31T00:00:01Z','definite_failed','OLD',false,'2026-10-31T00:00:01Z');
      alter table brain.channel_attempt_results enable trigger channel_result_fence`);
    const history = await db.rows('select request_id,work_item_id,attempt_token,created_at,outcome,error_code,retryable,finished_at from brain.channel_attempt_results order by created_at');
    const checksums = await db.rows('select version,checksum from brain.schema_migrations where version between 17 and 20 order by version');
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 20, to: 27 });
    expect(await db.rows('select request_id,work_item_id,attempt_token,created_at,outcome,error_code,retryable,finished_at from brain.channel_attempt_results order by created_at')).toEqual(history);
    expect(await db.rows('select version,checksum from brain.schema_migrations where version between 17 and 20 order by version')).toEqual(checksums);
    expect(await store.readChannelStatus(id(3))).toMatchObject({ request: { delivery: 'unknown' } });
    await expect(db.query(`update brain.channel_attempt_results set outcome='sent' where attempt_token='${id(5)}'`)).rejects.toMatchObject({ code: 'BRS01' });
    await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: id(6) });
    expect(await store.gateChannelAttempt({ requestId: id(3), workItemId: id(4), attemptToken: id(6), now })).toEqual({ ok: true, outcome: 'won' });
    expect((await db.rows<{ attempt_token: string }>('select attempt_token from brain.channel_attempt_results order by sequence')).map(r => r.attempt_token)).toEqual([id(9), id(5), id(6)]);
  } finally { await store.close(); }
});
it('0022의 건강 행과 기존 확장 역할을 0023으로 보존한다', async () => {
  const { randomBytes, randomUUID } = await import('node:crypto');
  const { provisionExtension } = await import('../src/index.js');
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-health-upgrade-')); folders.push(directory);
  const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(n => /^\d{4}_.*\.sql$/.test(n) && n < '0023').sort();
  for (const name of names) await copyFile(new URL(`../migrations/${name}`, import.meta.url),join(directory,name));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners:[{owner:'core',directory}] })).toMatchObject({ok:true,to:22});
  const name = `x${randomBytes(5).toString('hex')}`, role = `brain_ext_${name}`, password = randomBytes(24).toString('hex');
  const admin = new pg.Client({connectionString:db.url}), store = postgresStore({databaseUrl:db.appUrl});
  let ext: pg.Client | undefined;
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[name,`${name}.import`]);
    const id=randomUUID(),work=randomUUID(),token=randomUUID(),now=clock.now();
    await store.addWork({id:work,kind:`${name}.import`,targetKind:'import',targetId:'legacy',createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'test',kinds:[`${name}.import`],attemptToken:token});
    const url = new URL(db.url); url.username=role; url.password=password; ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
    await ext.query("insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) values ($1,$2,'d','b','daily','key','a',true,'steps',42,'count','2026-01-01','Asia/Seoul',false,'hash',now(),1,$3,$4)",[id,name,work,token]);
    expect(await runMigrations({databaseUrl:db.url,clock})).toMatchObject({ok:true,from:22,to:27});
    expect((await admin.query('select id,value,value_type,activity_id from brain.health_current_v1 where id=$1',[id])).rows).toMatchObject([{id,value:42,value_type:'number',activity_id:null}]);
    expect((await admin.query("select has_column_privilege($1,'brain.health_observations','value_text','INSERT') as permitted,has_table_privilege($1,'brain.health_authority_rules','INSERT') as authority",[role])).rows[0]).toEqual({permitted:true,authority:false});
    expect((await admin.query("select has_column_privilege($1,'brain.analyses','summary_raw','INSERT') as payload, has_column_privilege($1,'brain.analysis_artifacts','role','INSERT') as relation, has_table_privilege($1,'brain.analysis_artifacts','SELECT') as read",[role])).rows[0]).toEqual({payload:true,relation:true,read:false});
    await provisionExtension(db.url,name,password);
    expect(await runMigrations({databaseUrl:db.url,clock})).toMatchObject({ok:true,from:27,to:27,applied:[]});
  } finally { await ext?.end(); await store.close(); await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{}); await admin.end(); }
});
it('0025의 특수 JSON 원형을 바꾸지 않고 0026에서 논리 비교한다', async () => {
  const { randomUUID } = await import('node:crypto');
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-json-upgrade-')); folders.push(directory);
  const names = (await readdir(new URL('../migrations/', import.meta.url))).filter(n => /^\d{4}_.*\.sql$/.test(n) && n < '0026').sort();
  for (const name of names) await copyFile(new URL(`../migrations/${name}`, import.meta.url),join(directory,name));
  expect(await runMigrations({databaseUrl:db.url,clock,owners:[{owner:'core',directory}]})).toMatchObject({ok:true,to:25});
  const admin = new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  try {
    await admin.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('jsontest','1',now(),true,now())");
    await admin.query("insert into brain.extension_work_kinds(extension_name,kind) values ('jsontest','jsontest.import')");
    const work=randomUUID(),token=randomUUID(),now=clock.now();
    await store.addWork({id:work,kind:'jsontest.import',targetKind:'import',targetId:'legacy',createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'test',kinds:['jsontest.import'],attemptToken:token});
    const insert = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_json,value_json_raw,value_json_encoding) values ($1,'jsontest','d','b','day_summary',$2,'a',true,'day_summary.drinks_json','json','2026-01-01','Asia/Seoul',false,'hash',$3,1,$4,$5,'json','{}'::jsonb,$6,$7)`;
    const a=Buffer.from('{"x":"\\u0000","y":"😀"}');
    const b=Buffer.from('{"y":"\\ud83d\\ude00", "x":"\\u0000"}','utf16le');
    await admin.query(insert,[randomUUID(),'one',now,work,token,a,'utf-8']);
    await admin.query(insert,[randomUUID(),'two',now,work,token,b,'utf-16le']);
    expect((await admin.query("select reason from brain.health_resolution_v1 where metric='day_summary.drinks_json'")).rows).toEqual([{reason:'value_ambiguous'}]);
    expect(await runMigrations({databaseUrl:db.url,clock})).toMatchObject({ok:true,from:25,to:27});
    expect((await admin.query("select reason,cardinality(selected_ids) as count from brain.health_resolution_v1 where metric='day_summary.drinks_json'")).rows).toEqual([{reason:null,count:2}]);
    expect((await admin.query("select value_json_raw from brain.health_observations where metric='day_summary.drinks_json' order by original_key")).rows).toEqual([{value_json_raw:a},{value_json_raw:b}]);
  } finally { await store.close(); await admin.end(); }
});
