import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { setTimeout } from 'node:timers/promises';
import { afterEach, expect, it } from 'vitest';
import type { TestDatabase } from '@second-brain/test-db';
import { postgresStore, runMigrations } from '../src/index.js';
import { clock, database } from './fixture.js';
import { cleanupOwnedContainers } from './fixtures/owned-container-cleanup.js';
const databases: TestDatabase[] = []; const folders: string[] = [];
afterEach(async () => { await Promise.all([...databases.splice(0).map(db => db.drop()), ...folders.splice(0).map(f => rm(f, { recursive: true, force: true }))]); });
async function fresh() { const db = await database(false); databases.push(db); return db; }
async function owner(names: string[]) {
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-')); folders.push(directory);
  for (const name of names) await writeFile(join(directory,name), 'select 1;');
  return { owner: 'example', directory };
}
it('validateOnly checks core and extension histories without applying pending files', async () => {
  const db = await fresh(), options = { databaseUrl: db.url, clock };
  expect(await runMigrations({ ...options, coreMaxVersion: 31 })).toMatchObject({ ok: true, to: 31 });
  const source = await owner(['0001_a.sql']);
  expect((await runMigrations({ ...options, owners: [source] })).ok).toBe(true);
  await writeFile(join(source.directory, '0002_b.sql'), 'create table brain.validate_probe(id int);');
  const before = await db.rows('select * from brain.schema_migrations order by owner,version');
  const tables = await db.rows("select table_schema,table_name from information_schema.tables where table_schema='brain' order by table_name");
  expect(await runMigrations({ ...options, validateOnly: true })).toMatchObject({ ok: true, from: 31, to: 31, applied: [] });
  expect(await runMigrations({ ...options, owners: [source], validateOnly: true })).toMatchObject({ ok: true, from: 31, to: 31, applied: [] });
  expect(await db.rows('select * from brain.schema_migrations order by owner,version')).toEqual(before);
  expect(await db.rows("select table_schema,table_name from information_schema.tables where table_schema='brain' order by table_name")).toEqual(tables);
  await writeFile(join(source.directory, '0001_a.sql'), 'select 2;');
  expect(await runMigrations({ ...options, owners: [source], validateOnly: true })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  await writeFile(join(source.directory, '0001_a.sql'), 'select 1;');
  expect(await runMigrations({ ...options, coreMaxVersion: 32 })).toMatchObject({ ok: true, to: 32, applied: ['0032_user_keys.sql'] });
  expect(await runMigrations({ ...options, owners: [source] })).toMatchObject({ ok: true, applied: ['0002_b.sql'] });
  expect(await db.rows("select to_regclass('brain.validate_probe') as name")).toEqual([{ name: 'brain.validate_probe' }]);
});
it('records checksums and the injected clock and applies nothing on repeat', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 0, to: 42, applied: ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql', '0033_schedule_occurrences.sql', '0034_extension_package_identity.sql', '0035_extension_quiesce.sql', '0036_schedule_target_setting.sql', '0037_schedule_dependency.sql', '0038_extension_channel_publish.sql', '0039_import_cleanup_indexes.sql', '0040_drive_uploads.sql', '0041_sources.sql', '0042_drive_connection.sql'] });
  expect(await runMigrations(options)).toMatchObject({ ok: true, from: 42, to: 42, applied: [] });
  expect(await db.rows('select owner,version,length(checksum) as length,applied_at from brain.schema_migrations order by version')).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42].map(version => ({ owner: 'core', version, length: 64, applied_at: clock.now() })));
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
    .toMatchObject({ ok: true, from: 1, to: 42, applied: ['0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql', '0033_schedule_occurrences.sql', '0034_extension_package_identity.sql', '0035_extension_quiesce.sql', '0036_schedule_target_setting.sql', '0037_schedule_dependency.sql', '0038_extension_channel_publish.sql', '0039_import_cleanup_indexes.sql', '0040_drive_uploads.sql', '0041_sources.sql', '0042_drive_connection.sql'] });
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
    .toMatchObject({ ok: true, from: 5, to: 42, applied: ['0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql', '0033_schedule_occurrences.sql', '0034_extension_package_identity.sql', '0035_extension_quiesce.sql', '0036_schedule_target_setting.sql', '0037_schedule_dependency.sql', '0038_extension_channel_publish.sql', '0039_import_cleanup_indexes.sql', '0040_drive_uploads.sql', '0041_sources.sql', '0042_drive_connection.sql'] });
  expect(await db.rows(`select completed_at,outcome from brain.work_items where id='${id}'`))
    .toEqual([{ completed_at: completedAt, outcome: null }]);
});
it('applies each file only once under simultaneous runners', async () => {
  const db = await fresh(); const options = { databaseUrl: db.url, clock };
  const results = await Promise.all([runMigrations(options), runMigrations(options)]);
  expect(results.every(r => r.ok)).toBe(true);
  expect(results.flatMap(r => r.ok ? r.applied : []).length).toBe(42);
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
    expect(await pending).toMatchObject({ ok: true, from: 0, to: 42, applied: ['0001_initial.sql', '0002_supervised_attempts.sql', '0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql', '0033_schedule_occurrences.sql', '0034_extension_package_identity.sql', '0035_extension_quiesce.sql', '0036_schedule_target_setting.sql', '0037_schedule_dependency.sql', '0038_extension_channel_publish.sql', '0039_import_cleanup_indexes.sql', '0040_drive_uploads.sql', '0041_sources.sql', '0042_drive_connection.sql'] });
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
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 2, to: 42, applied: ['0003_supervised_cancel.sql', '0004_attempt_fence.sql', '0005_attempt_outcome_detail.sql', '0006_work_outcome_closed.sql', '0007_work_dependencies.sql', '0008_work_serialization_key.sql', '0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql', '0033_schedule_occurrences.sql', '0034_extension_package_identity.sql', '0035_extension_quiesce.sql', '0036_schedule_target_setting.sql', '0037_schedule_dependency.sql', '0038_extension_channel_publish.sql', '0039_import_cleanup_indexes.sql', '0040_drive_uploads.sql', '0041_sources.sql', '0042_drive_connection.sql'] });
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
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 32 }))
    .toMatchObject({ ok: true, from: 9, to: 32, applied: ['0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql'] });
  for (const table of ['work_items', 'schedules'])
    expect(await db.rows(`select kind,hold_group from brain.${table} order by id`)).toEqual(cases);
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
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${id(90)}','synthetic',1,now()); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${id(2)}','${id(1)}','chat',null)`);
    for (const n of [3, 4]) {
      await db.query(`insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at) values ('${id(n)}','${id(2)}','test','${n}','notice','보존','${now.toISOString()}')`);
      await store.handoffChannelRequest({ requestId: id(n), workId: id(n + 10), now });
      await db.query(`insert into brain.work_attempts(token,work_item_id,started_at,incarnation) values ('${id(n+20)}','${id(n+10)}','${now.toISOString()}','worker'); update brain.work_items set attempts=1,claimed_at='${now.toISOString()}',claim_expires_at='${new Date(now.getTime()+600000).toISOString()}',claimed_by='worker',current_attempt_token='${id(n+20)}' where id='${id(n+10)}'`);
      await db.query(`insert into brain.channel_gates values ('${id(n)}','${id(n + 10)}','${id(n + 20)}',now())`);
      if (n === 3) {
        await db.query(`insert into brain.channel_attempt_results values ('${id(n)}','${id(n + 10)}','${id(n + 20)}','42',now())`);
        await db.query(`update brain.channel_requests set status='sent', external_message_id='42' where id='${id(n)}'`);
      }
    }
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 17, to: 42 });
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
  await db.query(`insert into brain.users(id,name,is_self,created_at) values ('00000000-0000-7000-8000-000000000090','synthetic',1,now());
    insert into brain.channels values ('00000000-0000-7000-8000-000000000001','telegram','bot');
    insert into brain.channel_conversations values ('00000000-0000-7000-8000-000000000002','00000000-0000-7000-8000-000000000001','chat',null);
    insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,external_message_id) values ('00000000-0000-7000-8000-000000000003','00000000-0000-7000-8000-000000000002','core','result','notice','보존',now(),'sent','42')`);
  const before = await db.rows('select id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,external_message_id from brain.channel_requests');
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 18, to: 42 });
  expect(await db.rows('select id,conversation_id,producer,producer_result_id,purpose,body,created_at,status,external_message_id from brain.channel_requests')).toEqual(before);
});

it('v19 요청과 migration checksum을 보존하고 v20을 적용한다', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v19-')); folders.push(directory);
  for (const name of (await readdir(new URL('../migrations/', import.meta.url))).filter(name => name.endsWith('.sql') && name < '0020')) await copyFile(new URL(`../migrations/${name}`, import.meta.url), join(directory, name));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 19 });
  await db.query(`insert into brain.users(id,name,is_self,created_at) values ('00000000-0000-7000-8000-000000000090','synthetic',1,now());
    insert into brain.channels values ('00000000-0000-7000-8000-000000000001','telegram','bot');
    insert into brain.channel_conversations values ('00000000-0000-7000-8000-000000000002','00000000-0000-7000-8000-000000000001','chat',null);
    set role brain_app;
    insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at) values ('00000000-0000-7000-8000-000000000003','00000000-0000-7000-8000-000000000002','core','result','notice','보존',now()); reset role`);
  const before = await db.rows('select * from brain.schema_migrations order by version');
  expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 19, to: 42, applied: ['0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql', '0033_schedule_occurrences.sql', '0034_extension_package_identity.sql', '0035_extension_quiesce.sql', '0036_schedule_target_setting.sql', '0037_schedule_dependency.sql', '0038_extension_channel_publish.sql', '0039_import_cleanup_indexes.sql', '0040_drive_uploads.sql', '0041_sources.sql', '0042_drive_connection.sql'] });
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
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${id(90)}','synthetic',1,now()); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${id(2)}','${id(1)}','chat',null)`);
    await store.createChannelRequest({ id: id(3), conversationId: id(2), producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'body', createdAt: now });
    await store.handoffChannelRequest({ requestId: id(3), workId: id(4), now });
    await db.query(`alter table brain.channel_attempt_results disable trigger channel_result_fence;
      insert into brain.channel_attempt_results(request_id,work_item_id,attempt_token,created_at,outcome,error_code,retryable,finished_at) values
      ('${id(3)}','${id(4)}','${id(5)}','2026-10-31T00:00:02Z','unknown','NEW',true,'2026-10-31T00:00:03Z'),
      ('${id(3)}','${id(4)}','${id(9)}','2026-10-31T00:00:01Z','definite_failed','OLD',false,'2026-10-31T00:00:01Z');
      alter table brain.channel_attempt_results enable trigger channel_result_fence`);
    const history = await db.rows('select request_id,work_item_id,attempt_token,created_at,outcome,error_code,retryable,finished_at from brain.channel_attempt_results order by created_at');
    const checksums = await db.rows('select version,checksum from brain.schema_migrations where version between 17 and 20 order by version');
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 20, to: 42 });
    expect(await db.rows('select request_id,work_item_id,attempt_token,created_at,outcome,error_code,retryable,finished_at from brain.channel_attempt_results order by created_at')).toEqual(history);
    expect(await db.rows('select version,checksum from brain.schema_migrations where version between 17 and 20 order by version')).toEqual(checksums);
    expect(await store.readChannelStatus(id(3))).toMatchObject({ request: { delivery: 'unknown' } });
    await expect(db.query(`update brain.channel_attempt_results set outcome='sent' where attempt_token='${id(5)}'`)).rejects.toMatchObject({ code: 'BRS01' });
    await store.claimSupervisedWork({ now, kinds: ['channel_send'], claimedBy: 'worker', attemptToken: id(6) });
    expect(await store.gateChannelAttempt({ requestId: id(3), workItemId: id(4), attemptToken: id(6), now })).toEqual({ ok: true, outcome: 'won' });
    expect((await db.rows<{ attempt_token: string }>('select attempt_token from brain.channel_attempt_results order by sequence')).map(r => r.attempt_token)).toEqual([id(9), id(5), id(6)]);
  } finally { await store.close(); }
});

it('upgrades core 39 to 40 without changing existing data or migration history', async () => {
  const db=await fresh(), options={databaseUrl:db.url,clock};
  expect(await runMigrations({...options,coreMaxVersion:39})).toMatchObject({ok:true,to:39});
  await db.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('019a0000-0000-7000-8000-000000000099','sha256:"+'a'.repeat(64)+"',1,now())");
  const history=await db.rows('select * from brain.schema_migrations order by owner,version');
  const data=await db.rows('select * from brain.files');
  expect(await runMigrations({...options,coreMaxVersion:40})).toMatchObject({ok:true,from:39,to:40,applied:['0040_drive_uploads.sql']});
  expect(await db.rows('select * from brain.schema_migrations where version<=39 order by owner,version')).toEqual(history);
  expect(await db.rows('select * from brain.files')).toEqual(data);
  const app=new pg.Client({connectionString:db.appUrl});
  try { await app.connect();
    await app.query("insert into brain.drive_uploads(root_folder_id,content_hash,remote_id,state,created_at) values ('root',$1,'reserved-id','reserved',now())",['sha256:'+'b'.repeat(64)]);
    await expect(app.query("update brain.drive_uploads set remote_id='other'")).rejects.toThrow('refused');
    await expect(app.query('delete from brain.drive_uploads')).rejects.toThrow();
  } finally {await app.end();}
});

it('upgrades 40 to 41 preserving data, history and app privilege boundary', async () => {
  const db=await fresh(), options={databaseUrl:db.url,clock};
  expect(await runMigrations({...options,coreMaxVersion:40})).toMatchObject({ok:true,to:40});
  await db.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('019a0000-0000-7000-8000-000000000099','sha256:"+'a'.repeat(64)+"',1,now())");
  await db.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ('019a0000-0000-7000-8000-000000000097','019a0000-0000-7000-8000-000000000099','legacy',1,'unsupported',now(),now())");
  const extractions=await db.rows('select * from brain.document_extractions');
  const history=await db.rows('select * from brain.schema_migrations order by owner,version'), files=await db.rows('select * from brain.files');
  expect(await runMigrations({...options,coreMaxVersion:41})).toMatchObject({ok:true,from:40,to:41,applied:['0041_sources.sql']});
  expect(await db.rows('select * from brain.schema_migrations where owner=\'core\' and version<=40 order by owner,version')).toEqual(history);
  expect(await db.rows('select * from brain.files')).toEqual(files);
  expect(await db.rows('select * from brain.document_extractions')).toEqual(extractions);
  expect(await db.rows("select has_table_privilege('public','brain.sources','select') as allowed")).toEqual([{allowed:false}]);
  expect(await db.rows("select relname, has_table_privilege('brain_app',oid,'delete') as allowed from pg_class where relnamespace='brain'::regnamespace and relname in ('sources','source_files','source_handoffs','source_attempts','source_work_publications','source_staged_bytes') order by relname")).toEqual(['source_attempts','source_files','source_handoffs','source_staged_bytes','source_work_publications','sources'].map(relname=>({relname,allowed:false})));
  const app=new pg.Client({connectionString:db.appUrl});
  try {await app.connect();await app.query("insert into brain.sources(id,kind,account,root_id,generation) values ('019a0000-0000-7000-8000-000000000098','drive','synthetic','root',1)");await expect(app.query('delete from brain.sources')).rejects.toThrow();} finally {await app.end();}
});

it('upgrades 41 to 42 preserving sources and migration history', async () => {
  const db=await fresh(), options={databaseUrl:db.url,clock};
  expect(await runMigrations({...options,coreMaxVersion:41})).toMatchObject({ok:true,to:41});
  await db.query("insert into brain.sources(id,kind,account,root_id,generation,cursor) values ('019a0000-0000-7000-8000-000000000098','drive','synthetic','root',4,'cursor')");
  const history=await db.rows('select * from brain.schema_migrations order by owner,version');
  expect(await runMigrations(options)).toMatchObject({ok:true,from:41,to:42,applied:['0042_drive_connection.sql']});
  expect(await db.rows("select id::text,root_id,generation,cursor,connected from brain.sources")).toEqual([{id:'019a0000-0000-7000-8000-000000000098',root_id:'root',generation:4,cursor:'cursor',connected:true}]);
  expect(await db.rows("select * from brain.schema_migrations where version<=41 order by owner,version")).toEqual(history);
  expect(await db.rows("select has_table_privilege('brain_app','brain.sources','delete') as allowed")).toEqual([{allowed:false}]);
});

it('upgrades 40 directly to 42 without altering existing rows or history', async () => {
  const db=await fresh(), options={databaseUrl:db.url,clock};
  expect(await runMigrations({...options,coreMaxVersion:40})).toMatchObject({ok:true,to:40});
  await db.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('019a0000-0000-7000-8000-000000000099','sha256:"+'b'.repeat(64)+"',1,now())");
  const files=await db.rows('select * from brain.files'),history=await db.rows('select * from brain.schema_migrations order by owner,version');
  expect(await runMigrations(options)).toMatchObject({ok:true,from:40,to:42,applied:['0041_sources.sql','0042_drive_connection.sql']});
  expect(await db.rows('select * from brain.files')).toEqual(files);
  expect(await db.rows('select * from brain.schema_migrations where version<=40 order by owner,version')).toEqual(history);
});

it('retains baseline 0040 and 0041 migration bytes',async()=>{
 for(const [name,expected] of [['0040_drive_uploads.sql','597fef789bea7a96aadc2640826420960e097fcb7cf011b74ae898db481e7e17'],['0041_sources.sql','ddbd4a0e1c1824a3dd8a5f2d307934e6f687d594b0a347185f1bc799636ffa11']] as const){
  const bytes=await readFile(new URL(`../migrations/${name}`,import.meta.url));expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
 }
});
it('41 to 42 retains settings, redacted and shared files, extraction chunks, and privilege boundaries',async()=>{
 const db=await fresh(),options={databaseUrl:db.url,clock};expect(await runMigrations({...options,coreMaxVersion:41})).toMatchObject({ok:true,to:41});
 const user='019a0000-0000-7000-8000-000000000301',normal='019a0000-0000-7000-8000-000000000302',hidden='019a0000-0000-7000-8000-000000000303',extraction='019a0000-0000-7000-8000-000000000304',chunk='019a0000-0000-7000-8000-000000000305',sourceA='019a0000-0000-7000-8000-000000000306',sourceB='019a0000-0000-7000-8000-000000000307',one='019a0000-0000-7000-8000-000000000308',two='019a0000-0000-7000-8000-000000000309',masked='019a0000-0000-7000-8000-000000000310';
 await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z');
 insert into brain.settings(user_id,key,value,updated_at) values ('${user}','drive.keep_local_days','17','2026-01-01Z');
 insert into brain.files(id,content_hash,size_bytes,first_seen_at,redacted_at) values ('${normal}','sha256:${'c'.repeat(64)}',3,'2026-01-01Z',null),('${hidden}','sha256:${'d'.repeat(64)}',3,'2026-01-01Z','2026-01-01Z');
 insert into brain.document_extractions(id,file_id,extractor_version,attempt,started_at) values ('${extraction}','${normal}','synthetic',1,'2026-01-01Z');
 insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ('${chunk}','${extraction}',0,'합성 보존 본문','{"type":"text","start":0,"end":8}');
 update brain.document_extractions set status='ok',media_type='text/plain',finished_at='2026-01-01Z' where id='${extraction}';update brain.files set current_extraction_id='${extraction}' where id='${normal}';
 insert into brain.sources(id,kind,account,root_id,generation,cursor) values ('${sourceA}','drive','synthetic-a','watch-a',2,'cursor-a'),('${sourceB}','drive','synthetic-b','watch-b',3,'cursor-b');
 insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ('${one}','${sourceA}','one','공유1','','text/plain','1','${normal}','indexed',false),('${two}','${sourceB}','two','공유2','','text/plain','1','${normal}','indexed',false),('${masked}','${sourceA}','hidden','가린문서','','text/plain','1','${hidden}','failed',false)`);
 const snapshots=async()=>({settings:await db.rows('select * from brain.settings order by key'),files:await db.rows('select * from brain.files order by id'),extractions:await db.rows('select * from brain.document_extractions order by id'),chunks:await db.rows('select * from brain.document_chunks order by id'),sources:await db.rows('select id,kind,account,root_id,generation,cursor,scan_id,scan_token from brain.sources order by id'),entries:await db.rows('select * from brain.source_files order by id'),history:await db.rows('select * from brain.schema_migrations where version<=41 order by owner,version')});
 const before=await snapshots();expect(await runMigrations(options)).toMatchObject({ok:true,from:41,to:42,applied:['0042_drive_connection.sql']});expect(await snapshots()).toEqual(before);
 expect(await db.rows("select has_table_privilege('brain_app','brain.sources','delete') as source_delete, has_table_privilege('public','brain.source_files','select') as public_read")).toEqual([{source_delete:false,public_read:false}]);
 const app=postgresStore({databaseUrl:db.appUrl});try{expect(await app.readSourceDocument!(masked)).toMatchObject({ok:true,source:null});expect(await app.readSourceDocument!(one)).toMatchObject({ok:true,source:{file_id:normal}});expect(await app.readSourceDocument!(two)).toMatchObject({ok:true,source:{file_id:normal}});}finally{await app.close();}
});

it('preserves keep_local_days across recreation of a fixture-owned PostgreSQL container and volume',async()=>{
 const {randomBytes}=await import('node:crypto');const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');const {prepareDatabase}=await import('../src/index.js');const run=promisify(execFile);const nonce=randomBytes(12).toString('hex'),volume=`brain-e9-${nonce}`,names=[`brain-e9-a-${nonce}`,`brain-e9-b-${nonce}`],ids:string[]=[];let volumeCreated=false;
 const docker=async(...args:string[])=>(await run('docker',args,{timeout:30000})).stdout.trim();
 const start=async(name:string)=>{const id=await docker('create','--name',name,'--label',`brain.fixture=${nonce}`,'-e','POSTGRES_PASSWORD=synthetic-fixture','-v',`${volume}:/var/lib/postgresql`,'-p','127.0.0.1::5432','postgres:18');if(!/^[a-f0-9]{64}$/.test(id))throw Error('invalid fixture container id');ids.push(id);process.stdout.write(JSON.stringify({fixture:'e9-volume',event:'container-created',id,name,volume})+'\n');await docker('start',id);const ports=JSON.parse(await docker('inspect','--format','{{json .NetworkSettings.Ports}}',id)) as Record<string,{HostIp:string;HostPort:string}[]>;const binding=ports['5432/tcp']?.[0];if(!binding||binding.HostIp!=='127.0.0.1'||!/^\d+$/.test(binding.HostPort))throw Error('invalid isolated binding');const url=`postgres://postgres:synthetic-fixture@127.0.0.1:${binding.HostPort}/postgres`;for(let i=0;i<120;i++){const client=new pg.Client({connectionString:url,connectionTimeoutMillis:500});try{await client.connect();await client.query('select 1');return url;}catch{await setTimeout(250);}finally{await client.end().catch(()=>{});}}throw Error('fixture PostgreSQL unavailable');};
 try {
  const createdVolume=await docker('volume','create','--label',`brain.fixture=${nonce}`,volume);volumeCreated=true;expect(createdVolume).toBe(volume);process.stdout.write(JSON.stringify({fixture:'e9-volume',event:'volume-created',volume})+'\n');const first=await start(names[0]!);
  expect(await prepareDatabase({databaseUrl:first,appPassword:'brain-test-app',maintenancePassword:'brain-test-maintenance'})).toMatchObject({ok:true});const firstBrain=new URL(first);firstBrain.pathname='/brain';expect(await runMigrations({databaseUrl:firstBrain.toString(),clock})).toMatchObject({ok:true,to:42});
  const client=new pg.Client({connectionString:firstBrain.toString()});await client.connect();try{await client.query("insert into brain.users(id,name,is_self,created_at) values ('019a0000-0000-7000-8000-000000000411','synthetic',1,'2026-01-01Z'); insert into brain.settings(user_id,key,value,updated_at) values ('019a0000-0000-7000-8000-000000000411','drive.keep_local_days','17','2026-01-01Z')");}finally{await client.end();}
  await docker('rm','-f',ids[0]!);const second=await start(names[1]!);expect(ids[1]).not.toBe(ids[0]);const secondBrain=new URL(second);secondBrain.pathname='/brain';const reopened=new pg.Client({connectionString:secondBrain.toString()});await reopened.connect();try{expect((await reopened.query("select value from brain.settings where key='drive.keep_local_days' and user_id='019a0000-0000-7000-8000-000000000411'")).rows).toEqual([{value:'17'}]);}finally{await reopened.end();}
 }finally{
  await cleanupOwnedContainers({docker,nonce,names,ids,volume,volumeCreated,record:event=>process.stdout.write(JSON.stringify(event)+'\n')});
 }
},180000);

it('attempts cleanup of each known resource independently after an injected inspection failure',async()=>{
 const nonce='synthetic-nonce',a='fixture-a',b='fixture-b',volume='fixture-volume',idA='a'.repeat(64),idB='b'.repeat(64),calls:string[]=[],records:unknown[]=[];let bRemoved=false,volumeRemoved=false;
 const missing=(kind:string)=>Object.assign(new Error('synthetic missing'),{stderr:`no such ${kind}`});
 const docker=async(...args:string[])=>{calls.push(args.join(' '));if(args[0]==='inspect'&&args.at(-1)===a)throw Error('synthetic inspect failure');if(args[0]==='inspect'&&args.at(-1)===b){if(bRemoved)throw missing('container');return JSON.stringify({Id:idB,Config:{Labels:{'brain.fixture':nonce}}});}if(args[0]==='rm'&&args.at(-1)===idB){bRemoved=true;return idB;}if(args[0]==='volume'&&args[1]==='inspect'){if(volumeRemoved)throw missing('volume');return JSON.stringify([{Labels:{'brain.fixture':nonce}}]);}if(args[0]==='volume'&&args[1]==='rm'){volumeRemoved=true;return volume;}throw Error('unexpected fake command');};
 await expect(cleanupOwnedContainers({docker,nonce,names:[a,b],ids:[idA,idB],volume,volumeCreated:true,record:e=>records.push(e)})).rejects.toThrow('fixture resource cleanup failed');expect(bRemoved).toBe(true);expect(volumeRemoved).toBe(true);expect(calls).not.toContain(`rm -f ${idA}`);expect(records).toEqual([expect.objectContaining({event:'cleanup-failed',names:[a,b],ids:[idA,idB],volume,failures:[{resource:a,stage:'inspect'}]})]);
});
