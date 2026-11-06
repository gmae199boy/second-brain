import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import type { CommandRunner } from '../../../apps/cli/src/runtime/command-runner.js';
import type { OfflineConfirmationRequest } from '../../../apps/cli/src/install/postgres.js';
import { installPostgres } from '../../../apps/cli/dist/install/postgres.js';
import { database, clock } from './fixture.js';
import { runMigrations } from '../src/index.js';

const homes: string[] = [], databases: TestDatabase[] = [];
afterEach(async () => {
  const results = await Promise.allSettled([...databases.splice(0).map(db => db.drop()), ...homes.splice(0).map(home => rm(home, { recursive: true, force: true }))]);
  const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
  if (errors.length) throw new AggregateError(errors, '시험 자원 정리 실패');
});
async function legacyWorld(schema = 27) {
  const home = await mkdtemp(join(tmpdir(), 'brain-legacy-')); homes.push(home);
  const db = await database(false, createTestDatabase); databases.push(db);
  const dbName = new URL(db.url).pathname.slice(1);
  if (!/^brain_test_[a-f0-9]+$/.test(dbName)) throw new Error('invalid database');
  await db.query(`alter database "${dbName}" owner to brain_owner`);
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: schema })).toMatchObject({ ok: true, to: schema });
  const dir = join(home, 'extensions/testext');
  await mkdir(join(home, 'run'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../apps/cli/test/fixtures/extensions/testext/', import.meta.url)), dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  Object.assign(manifest, { files: ['bin/check.mjs', 'bin/echo-stats.mjs', 'manifest.json', 'migrations/0001_testext.sql', 'migrations/0002_marker.sql'], core_compat: { min: '0.0.0', max_exclusive: '1.0.0' }, plugin_version: '1.0.0' });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const build = JSON.parse(await readFile(new URL('../../../apps/cli/dist/build.json', import.meta.url), 'utf8'));
  const previous = build.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40);
  const installed = { commit: previous, schema_version: schema, node: process.execPath, plugin_root: null, installed_at: '2026-01-01T00:00:00Z' };
  await writeFile(join(home, 'installed.json'), JSON.stringify(installed));
  const schedule = randomUUID(), work = randomUUID(), completed = randomUUID(), channel = randomUUID(), conversation = randomUUID(), file = randomUUID(), user = randomUUID(), self = randomUUID(), session = randomUUID(), message = randomUUID(), attempt = randomUUID();
  await db.query(`insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','0.1.0',now(),false,now());
    insert into brain.work_hold_groups values ('extension:testext',now()),('user:hold',now());
    insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',0,now());
    insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','session','${user}','test',now(),'import');
    insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${message}','${session}','message','user','memory',now());
    insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','sha256:${'a'.repeat(64)}',1,now())`);
  if (schema >= 12) await db.query("insert into brain.extension_work_kinds(extension_name,kind) values ('testext','testext.job')");
  if (schema >= 33) {
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${self}','self',1,now());
      insert into brain.schedules(id,kind,target_kind,target_id,next_run_at,created_at,time_zone,hold_group,user_id,trigger_kind,cron_expr,time_zone_source,extension,schedule_key) values ('${schedule}','testext.job','probe','custom',now(),now(),'UTC','user:hold','${self}','cron','30 9 * * *','user','testext','testext.job:probe:custom');
      insert into brain.settings(key,value,updated_at,user_id) values ('timezone','UTC',now(),'${self}')`);
  } else {
    await db.query(`insert into brain.schedules(id,kind,target_kind,target_id,next_run_at,created_at,local_time,time_zone,hold_group) values ('${schedule}','testext.job','probe','custom',now(),now(),'09:30','UTC','user:hold');
      insert into brain.settings(key,value,updated_at) values ('timezone','UTC',now())`);
  }
  await db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,hold_group,schedule_id) values ('${work}','testext.job','probe','pending','2026-01-01T00:00:00Z',now(),'supervised','user:hold','${schedule}');
    insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,completed_at,execution_class,hold_group,outcome) values ('${completed}','testext.job','probe','done',now(),now(),now(),'supervised','user:hold','succeeded');
    insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome) values ('${attempt}','${completed}','2026-01-01T01:00:00Z','2026-01-01T01:01:00Z','succeeded')`);
  if (schema >= 34) {
    await db.query(`update brain.work_attempts set result_summary='{"summary":"kept"}',previous_result='{"prior":"kept"}' where token='${attempt}';
      insert into brain.extension_work_kinds(extension_name,kind) values ('testext','testext.followup');
      update brain.extension_work_kinds set followup_kind='testext.followup',missed_policy='skip' where kind='testext.job';
      update brain.extensions set package_digest='${'a'.repeat(64)}',plugin_version='1.2.3' where name='testext';
      update brain.schedules set trigger_updated_at='2026-01-02T00:00:00Z' where id='${schedule}';
      insert into brain.schedules(id,kind,target_kind,target_id,next_run_at,created_at,time_zone,hold_group,user_id,trigger_kind,cron_expr,time_zone_source,extension,schedule_key,enabled,removed_at) values
      ('${randomUUID()}','testext.job','probe','disabled',now(),now(),'UTC','user:hold','${self}','cron','0 8 * * *','user','testext','disabled',false,null),
      ('${randomUUID()}','testext.job','probe','removed',now(),now(),'UTC','user:hold','${self}','cron','0 7 * * *','user','testext','removed',false,'2026-01-01T00:00:00Z');
      insert into brain.schedules(id,kind,target_kind,target_id,next_run_at,created_at,hold_group,user_id,trigger_kind,run_at,interval_seconds,trigger_updated_at,extension,schedule_key) values
      ('${randomUUID()}','testext.job','probe','once',now(),now(),'user:hold','${self}','once','2026-03-01T00:00:00Z',null,'2026-01-03T00:00:00Z','testext','once'),
      ('${randomUUID()}','testext.job','probe','interval',now(),now(),'user:hold','${self}','interval',null,3600,'2026-01-04T00:00:00Z','testext','interval')`);
  }
  if (schema >= 33) {
    await db.query(`insert into brain.schedule_occurrences(schedule_id,occurrence_at,time_zone,status,work_id,user_id,recorded_at) values
      ('${schedule}','2026-01-02T09:30:00Z','UTC','done','${completed}','${self}','2026-01-01T00:00:00Z'),
      ('${schedule}','2026-01-03T09:30:00Z','UTC','pending','${work}','${self}','2026-01-01T00:00:00Z'),
      ('${schedule}','2026-01-04T09:30:00Z','UTC','claimed','${work}','${self}','2026-01-01T00:00:00Z'),
      ('${schedule}','2026-01-05T09:30:00Z','UTC','pending','${work}','${self}','2026-01-01T00:00:00Z')`);
  } else {
    await db.query(`insert into brain.schedule_successes values ('${schedule}','2026-01-02','UTC','${completed}','2026-01-01T00:00:00Z');
      update brain.work_items set local_date_from='2026-01-03',local_date_to='2026-01-05',claimed_date_from='2026-01-04',claimed_date_to='2026-01-04',local_time_zone='UTC' where id='${work}'`);
  }
  if (schema >= 17) {
    await db.query(`insert into brain.channels(id,kind,bot_ref) values ('${channel}','telegram','synthetic');`);
    await db.query(schema >= 33 ? `insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat','thread','${self}')` : `insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${conversation}','${channel}','chat','thread')`);
  }
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'testext', directory: join(dir, 'migrations') }] })).toMatchObject({ ok: true });
  await db.query("insert into testext.checks(id,checked_at) values (7,'2026-01-03T00:00:00Z')");
  await writeFile(join(dir, 'migrations/0002_marker.sql'), 'create table testext.marker (value text);\n');
  const env: NodeJS.ProcessEnv = { ...process.env, SECOND_BRAIN_HOME: home }; delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER;
  const good = (stdout = '') => ({ ok: true as const, stdout, stderr: '' });
  const runner: CommandRunner = async request => {
    if (request.args[0] === 'volume') return { ok: false, stdout: '', stderr: 'no such volume', message: 'missing' };
    if (request.args[0] === 'ps') return good('');
    return good();
  };
  const options = { home, urlEnv: 'BRAIN_DATABASE_URL', env, clock, runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: dbName };
  const install = (confirmOffline?: (request: OfflineConfirmationRequest) => Promise<string>) => installPostgres({ ...options, ...(confirmOffline ? { confirmOffline } : {}) });
  return { home, db, dir, build, installed, schedule, work, completed, attempt, options, install, manifestPath };
}
// Only columns added, removed, or derived by 0032/0033/0036/0037 are
// excluded. Their exact expected conversions are asserted separately below.
const scheduleMigrationColumns = ['local_time','user_id','trigger_kind','cron_expr','run_at','trigger_updated_at','time_zone_source','extension','schedule_key','enabled','removed_at','target_setting','after_schedule'];
const workMigrationColumns = ['local_date_from','local_date_to','claimed_date_from','claimed_date_to','local_time_zone'];
const normalized = async (db: TestDatabase, initialSchema = 27) => {
  const version = Number((await db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'"))[0]!.version);
  const project = (table: string, excluded: string[] = [], where = '') => db.rows(`select to_jsonb(t) - array[${excluded.map(k => `'${k}'`).join(',')}]::text[] as row from brain.${table} t ${where} order by (to_jsonb(t) - array[${excluded.map(k => `'${k}'`).join(',')}]::text[])::text`);
  const accounting = version < 33
    ? await db.rows(`select su.schedule_id, (su.local_date + s.local_time::time) at time zone su.time_zone as occurrence_at, su.time_zone, 'done'::text as status, su.work_id, su.recorded_at from brain.schedule_successes su join brain.schedules s on s.id=su.schedule_id union all select w.schedule_id, (d::date + s.local_time::time) at time zone w.local_time_zone, w.local_time_zone, case when d::date between w.claimed_date_from and w.claimed_date_to then 'claimed' else 'pending' end, w.id, w.created_at from brain.work_items w join brain.schedules s on s.id=w.schedule_id cross join lateral generate_series(w.local_date_from::timestamp,w.local_date_to::timestamp,interval '1 day') d where w.completed_at is null order by schedule_id,occurrence_at`)
    : await db.rows('select schedule_id,occurrence_at,time_zone,status,work_id,recorded_at from brain.schedule_occurrences order by schedule_id,occurrence_at');
  if (version < 33) {
    expect(await db.rows('select local_time from brain.schedules')).toEqual([{ local_time: '09:30' }]);
    expect(await db.rows("select local_date_from::text,local_date_to::text,claimed_date_from::text,claimed_date_to::text,local_time_zone from brain.work_items where target_id='pending'")).toEqual([{local_date_from:'2026-01-03',local_date_to:'2026-01-05',claimed_date_from:'2026-01-04',claimed_date_to:'2026-01-04',local_time_zone:'UTC'}]);
  }
  if (version >= 33) {
    const self = (await db.rows('select id from brain.users where is_self=1'))[0]!.id;
    expect(await db.rows("select user_id,trigger_kind,cron_expr,run_at,trigger_updated_at,time_zone_source,extension,schedule_key,enabled,removed_at,target_id,time_zone,hold_group from brain.schedules where target_id='custom'")).toEqual([expect.objectContaining({ user_id: self, trigger_kind: 'cron', cron_expr: '30 9 * * *', run_at: null, trigger_updated_at: initialSchema >= 34 ? new Date('2026-01-02T00:00:00Z') : null, time_zone_source: 'user', extension: 'testext', schedule_key: 'testext.job:probe:custom', enabled: true, removed_at: null, target_id: 'custom', time_zone: 'UTC', hold_group: 'user:hold' })]);
    if (initialSchema >= 34) expect(await db.rows("select target_id,enabled,removed_at,cron_expr from brain.schedules where target_id in ('disabled','removed') order by target_id")).toEqual([{target_id:'disabled',enabled:false,removed_at:null,cron_expr:'0 8 * * *'},{target_id:'removed',enabled:false,removed_at:new Date('2026-01-01T00:00:00Z'),cron_expr:'0 7 * * *'}]);
    if (version >= 36) expect((await db.rows('select target_setting from brain.schedules')).every(row => row.target_setting === null)).toBe(true);
    if (version >= 37) expect((await db.rows('select after_schedule from brain.schedules')).every(row => row.after_schedule === null)).toBe(true);
    expect(await db.rows('select distinct user_id from brain.schedule_occurrences')).toEqual([{ user_id: self }]);
    expect((await db.rows('select user_id from brain.channel_conversations')).every(row=>row.user_id===self)).toBe(true);
    expect(await db.rows("select user_id from brain.settings where key='timezone'")).toEqual([{ user_id: self }]);
  }
  return {
    users: await project('users', [], initialSchema >= 34 ? '' : 'where is_self=0'), sessions: await project('sessions'), messages: await project('messages'),
    channels: version >= 17 ? await project('channels') : [], conversations: version >= 17 ? await project('channel_conversations', initialSchema >= 34 ? [] : ['user_id']) : [], files: await project('files'),
    settings: await project('settings', initialSchema >= 34 ? [] : ['user_id']), schedules: await project('schedules', initialSchema >= 34 ? ['target_setting','after_schedule'] : scheduleMigrationColumns),
    work: await project('work_items', workMigrationColumns), holds: await db.rows('select * from brain.work_hold_groups order by name'), accounting,
    registry: await project('extensions', initialSchema >= 34 ? [] : ['package_digest','plugin_version']), kinds: version >= 12 ? await project('extension_work_kinds', initialSchema >= 34 ? [] : ['followup_kind','missed_policy']) : [],
    attempts: await project('work_attempts', initialSchema >= 34 ? [] : ['result_summary','previous_result']),
    history: await db.rows("select * from brain.schema_migrations where owner='testext' and version=1"), extensionData: await db.rows('select * from testext.checks order by id'),
  };
};
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const snapshot = async (db: TestDatabase) => ({ ledger: await db.rows('select * from brain.schema_migrations order by owner,version'), registry: await db.rows('select * from brain.extensions order by name') });

it.each([11,27,34])('L1 schema%i를 전환하고 기억·사용자 보류·예약 및 회계를 보존한다', async schema => {
  const k = await legacyWorld(schema);
  const before = await normalized(k.db, schema);
  const result = await k.install(async r => { expect(r.legacySchema).toBe(schema); return r.challenge; });
  expect(result).toMatchObject({ ok: true, report: { schema_version: 41, offline_confirmation: { previous_commit: k.installed.commit, target_commit: k.build.commit, method: 'operator' } } });
  expect(await k.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
  expect(result.ok && result.report.applied.filter(name => name === '0002_marker.sql')).toEqual(['0002_marker.sql']);
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  await expect(readFile(join(k.home, 'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await k.db.rows('select enabled from brain.extensions')).toEqual([{ enabled: false }]);
  expect(await normalized(k.db, schema)).toEqual(before);
  expect(await k.db.rows('select occurrence_at,status,work_id from brain.schedule_occurrences order by occurrence_at')).toEqual([{ occurrence_at: new Date('2026-01-02T09:30:00Z'), status: 'done', work_id: k.completed }, ...['pending','claimed','pending'].map((status,i)=>({ occurrence_at:new Date(`2026-01-0${i+3}T09:30:00Z`),status,work_id:k.work }))]);
});

it.each(['enabled','hold','schedule','work','claim','attempt','completed-attempt','user-hold','transition','journal','daemon'] as const)('L2 %s 전제 불충족은 확인과 변경 전에 거부한다', async mode => {
  const k = await legacyWorld(), token = randomUUID();
  if (mode === 'enabled') await k.db.query('update brain.extensions set enabled=true');
  if (mode === 'user-hold') await k.db.query("delete from brain.work_hold_groups where name='user:hold'");
  if (mode === 'hold') await k.db.query("delete from brain.work_hold_groups where name='extension:testext'");
  if (mode === 'schedule') await k.db.query('update brain.schedules set hold_group=null');
  if (mode === 'work') await k.db.query(`update brain.work_items set hold_group=null where id='${k.work}'`);
  if (mode === 'claim') await k.db.query(`update brain.work_items set claimed_by='test',claimed_at=now(),claim_expires_at=now()+interval '1 minute' where id='${k.work}'`);
  if (mode === 'attempt') await k.db.query(`insert into brain.work_attempts(token,work_item_id,started_at) values ('${token}','${k.work}',now())`);
  if (mode === 'completed-attempt') await k.db.query(`insert into brain.work_attempts(token,work_item_id,started_at) values ('${token}','${k.completed}',now())`);
  if (mode === 'transition') await writeFile(join(k.home, 'extensions/.transition-testext.json'), '{}');
  if (mode === 'journal') await writeFile(join(k.home, 'run/bootstrap-extension-migrations.json'), '{}');
  if (mode === 'daemon') await writeFile(join(k.home, 'run/daemon.pid'), 'unknown');
  const journalPath = join(k.home, 'run/bootstrap-extension-migrations.json');
  const beforeJournal = await readFile(journalPath, 'utf8').catch(() => null);
  await mkdir(join(k.home, 'app')); await writeFile(join(k.home, 'app/sentinel'), 'unchanged');
  const before = await snapshot(k.db); let called = false;
  const result = await k.install(async r => { called = true; return r.challenge; });
  expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED' }); expect(called).toBe(false);
  expect(await snapshot(k.db)).toEqual(before);
  expect(await readFile(journalPath, 'utf8').catch(() => null)).toBe(beforeJournal);
  expect(await readFile(join(k.home, 'app/sentinel'), 'utf8')).toBe('unchanged');
});

it.each(['missing','invalid','null','same','new-schema','negative','zero','below-registry','manifest'] as const)('L3 %s 신원 또는 호환 불명은 거부한다', async mode => {
  const k = await legacyWorld(), path = join(k.home, 'installed.json');
  if (mode === 'missing') await rm(path);
  if (mode === 'invalid') await writeFile(path, '{');
  if (mode === 'null') await writeFile(path, JSON.stringify({ ...k.installed, commit: null }));
  if (mode === 'same') await writeFile(path, JSON.stringify({ ...k.installed, commit: k.build.commit }));
  if (mode === 'new-schema') await writeFile(path, JSON.stringify({ ...k.installed, schema_version: 35 }));
  if (mode === 'negative' || mode === 'zero' || mode === 'below-registry') await writeFile(path, JSON.stringify({ ...k.installed, schema_version: mode === 'negative' ? -1 : mode === 'zero' ? 0 : 10 }));
  if (mode === 'manifest') { const m = JSON.parse(await readFile(k.manifestPath, 'utf8')); m.core_compat = { min: '9.0.0', max_exclusive: '10.0.0' }; await writeFile(k.manifestPath, JSON.stringify(m)); }
  const before = await snapshot(k.db); let called = false;
  expect(await k.install(async r => { called = true; return r.challenge; })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(called).toBe(false); expect(await snapshot(k.db)).toEqual(before);
});

it('L3 적용된 확장 v1 checksum 불일치는 변경 전에 거부한다', async () => {
  const k = await legacyWorld(), before = await snapshot(k.db), data = await normalized(k.db);
  await mkdir(join(k.home, 'app')); await writeFile(join(k.home, 'app/sentinel'), 'unchanged');
  await writeFile(join(k.dir, 'migrations/0001_testext.sql'), 'select 1;');
  let called = false;
  const result = await k.install(async r => { called = true; return r.challenge; });
  expect(result.ok).toBe(false); if (result.ok) throw new Error('expected refusal');
  expect(['MIGRATION_FAILED', 'DB_LOCKED']).toContain(result.code);
  expect(called).toBe(false); expect(await snapshot(k.db)).toEqual(before); expect(await normalized(k.db)).toEqual(data);
  expect(await readFile(join(k.home, 'app/sentinel'), 'utf8')).toBe('unchanged');
  await expect(readFile(join(k.home, 'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('L3 core ledger checksum 불일치는 확인과 변경 전에 거부한다', async () => {
  const k = await legacyWorld();
  await k.db.query("update brain.schema_migrations set checksum='tampered' where owner='core' and version=1");
  const before = await snapshot(k.db), data = await normalized(k.db);
  await mkdir(join(k.home, 'app')); await writeFile(join(k.home, 'app/sentinel'), 'unchanged');
  let called = false;
  expect(await k.install(async r => { called = true; return r.challenge; })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(called).toBe(false); expect(await snapshot(k.db)).toEqual(before); expect(await normalized(k.db)).toEqual(data);
  expect(await readFile(join(k.home, 'app/sentinel'), 'utf8')).toBe('unchanged');
  await expect(readFile(join(k.home, 'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['tail','empty'] as const)('L3 core %s 이력 누락은 확인과 변경 전에 거부한다', async mode => {
  const k = await legacyWorld();
  await k.db.query(`delete from brain.schema_migrations where owner='core' ${mode === 'tail' ? 'and version=27' : ''}`);
  const before = await snapshot(k.db);
  const rows = async () => Promise.all(['users','sessions','messages','files','schedules','work_items','work_attempts','work_hold_groups','extensions','extension_work_kinds'].map(table => k.db.rows(`select to_jsonb(t) as row from brain.${table} t order by to_jsonb(t)::text`)));
  const beforeRows = await rows(); await mkdir(join(k.home, 'app')); await writeFile(join(k.home, 'app/sentinel'), 'unchanged');
  let called = false;
  expect(await k.install(async r => { called = true; return r.challenge; })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(called).toBe(false); expect(await snapshot(k.db)).toEqual(before); expect(await rows()).toEqual(beforeRows);
  expect(await readFile(join(k.home, 'app/sentinel'), 'utf8')).toBe('unchanged');
  await expect(readFile(join(k.home, 'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each(['before-tail','before-empty','after-tail','after-empty','control'] as const)('core 이력 %s에서 승격과 prepare 순서를 관측한다', async mode => {
  const { execFile } = await import('node:child_process'); const { promisify } = await import('node:util');
  const run = promisify(execFile), k = await legacyWorld();
  const repo = fileURLToPath(new URL('../../../', import.meta.url)), app = join(k.home, 'app'), stage = join(k.home, `.app-stage-${randomUUID()}`);
  await run('git', ['clone','--quiet','--no-hardlinks',repo,app]);
  await run('git', ['clone','--quiet','--no-hardlinks',repo,stage]);
  const head = (await run('git',['-C',app,'rev-parse','HEAD'])).stdout.trim();
  const appFile = await readFile(join(app, 'README.md'));
  await mkdir(join(stage,'apps/cli/dist'),{recursive:true});
  await cp(fileURLToPath(new URL('../../../apps/cli/dist/build.json',import.meta.url)),join(stage,'apps/cli/dist/build.json'));
  await mkdir(join(k.home,'install.lock')); const lockOwner = `${process.pid} ${randomUUID()}\n`;
  await writeFile(join(k.home,'install.lock/owner'),lockOwner);
  const deleteSql = `delete from brain.schema_migrations where owner='core' ${mode.endsWith('tail') ? 'and version=27' : ''}`;
  if (mode.startsWith('before')) await k.db.query(deleteSql);
  const before = await snapshot(k.db);
  await k.db.query('grant create on schema public to public');
  const publicCreate = async () => (await k.db.rows("select exists(select 1 from pg_namespace n cross join lateral aclexplode(n.nspacl) a where n.nspname='public' and a.grantee=0 and a.privilege_type='CREATE') as granted"))[0];
  expect(await publicCreate()).toEqual({granted:true});
  const challenge = join(k.home,'challenge.txt');
  const moduleUrl = new URL('../../../apps/cli/dist/install/postgres.js',import.meta.url).href;
  const pgRequire = new URL('../package.json',import.meta.url).href;
  const script = `import { writeFile } from 'node:fs/promises'; import { createRequire } from 'node:module';
    import { installPostgres } from ${JSON.stringify(moduleUrl)};
    const pg=createRequire(${JSON.stringify(pgRequire)})('pg'), env=process.env;
    const runner=async r=>r.args[0]==='volume'?{ok:false,stdout:'',stderr:'no such volume',message:'missing'}:{ok:true,stdout:'',stderr:''};
    const result=await installPostgres({home:env.CASE_HOME,urlEnv:'BRAIN_DATABASE_URL',env,clock:{now:()=>new Date('2026-10-28T01:02:03.456Z')},runner,secrets:{adminUrl:env.CASE_DB,appPassword:'brain-test-app'},databaseName:env.CASE_NAME,confirmOffline:async r=>{await writeFile(env.CASE_CHALLENGE,r.challenge); if(env.CASE_DELETE){const client=new pg.Client({connectionString:env.CASE_DB});await client.connect();try{await client.query(env.CASE_DELETE)}finally{await client.end()}} return r.challenge;}});
    process.stdout.write(JSON.stringify(result));`;
  const env = { ...process.env, CASE_HOME:k.home, CASE_DB:k.db.url, CASE_NAME:k.options.databaseName, CASE_CHALLENGE:challenge, CASE_DELETE:mode.startsWith('after') ? deleteSql : '', SECOND_BRAIN_STAGED_APP:stage, SECOND_BRAIN_PREVIOUS_APP_HEAD:head, SECOND_BRAIN_INSTALL_LOCK_OWNER:lockOwner };
  const result = JSON.parse((await run(process.execPath,['--input-type=module','-e',script],{env,timeout:30_000})).stdout);
  if (mode === 'control') {
    expect(result).toMatchObject({ok:true}); expect(await readFile(challenge,'utf8')).toContain('확인 ');
    expect(await publicCreate()).toEqual({granted:false});
    expect(JSON.parse(await readFile(join(k.home,'.app-promotion.json'),'utf8'))).toMatchObject({target:k.build.commit,hadPrevious:true});
    expect(await readFile(join(app,'apps/cli/dist/build.json'),'utf8')).toEqual(await readFile(join(stage,'apps/cli/dist/build.json'),'utf8'));
  } else {
    expect(result).toMatchObject({ok:false,code:'DB_LOCKED'});
    if (mode.startsWith('after')) expect(await readFile(challenge,'utf8')).toContain('확인 ');
    else await expect(readFile(challenge)).rejects.toMatchObject({code:'ENOENT'});
    expect(await publicCreate()).toEqual({granted:true});
    expect(await readFile(join(app,'README.md'))).toEqual(appFile);
    expect((await run('git',['-C',app,'rev-parse','HEAD'])).stdout.trim()).toBe(head);
    expect((await run('git',['-C',app,'status','--porcelain'])).stdout).toBe('');
    for (const path of ['.app-promotion.json','.app-next','.app-previous','run/bootstrap-extension-migrations.json']) await expect(readFile(join(k.home,path))).rejects.toMatchObject({code:'ENOENT'});
    const expected = mode === 'after-tail' ? before.ledger.filter(row=>!(row.owner==='core' && row.version===27)) : mode === 'after-empty' ? before.ledger.filter(row=>row.owner!=='core') : before.ledger;
    const after = await snapshot(k.db); expect(after.ledger).toEqual(expected); expect(after.registry).toEqual(before.registry);
  }
}, 60_000);

it.each(['missing','wrong','home','old','enabled','hold','schedule','work','claim','attempt','completed-attempt','core-tail','checksum','core-checksum','symlink','manifest','daemon','installed','build','home-lock','registry','gate','journal'] as const)('L4 %s 확인은 변경 전에 거부한다', async mode => {
  const k = await legacyWorld();
  if (mode === 'gate') {
    expect(await runMigrations({ databaseUrl:k.db.url, clock, coreMaxVersion:31 })).toMatchObject({ok:true});
    const { postgresStore } = await import('../src/index.js'); const store=postgresStore({databaseUrl:k.db.url});
    try { expect(await store.ensureSelfUser({id:randomUUID(),name:'self',createdAt:clock.now()})).toMatchObject({ok:true}); } finally { await store.close(); }
    expect(await runMigrations({ databaseUrl:k.db.url, clock, coreMaxVersion:35 })).toMatchObject({ok:true});
  }
  const before = await snapshot(k.db), foreignOwner = randomUUID();
  await mkdir(join(k.home, 'app')); await writeFile(join(k.home, 'app/sentinel'), 'unchanged');
  let install = k.install, buildPath = '';
  if (mode === 'build') {
    const { symlink } = await import('node:fs/promises'); const { pathToFileURL } = await import('node:url');
    const alternate = join(k.home,'alternate/apps/cli'); await mkdir(alternate,{recursive:true});
    await cp(fileURLToPath(new URL('../../../apps/cli/dist/',import.meta.url)),join(alternate,'dist'),{recursive:true});
    await symlink(fileURLToPath(new URL('../../../apps/cli/node_modules',import.meta.url)),join(alternate,'node_modules'));
    const isolated = await import(pathToFileURL(join(alternate,'dist/install/postgres.js')).href);
    install = confirmOffline => isolated.installPostgres({ ...k.options, ...(confirmOffline ? {confirmOffline} : {}) });
    buildPath=join(alternate,'dist/build.json');
  }
  const result = await install(mode === 'missing' ? undefined : async r => {
    if (mode === 'installed') await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,commit:'c'.repeat(40)}));
    if (mode === 'build') await writeFile(buildPath,JSON.stringify({...k.build,commit:'d'.repeat(40)}));
    if (mode === 'home-lock') await writeFile(join(k.home,'install.lock/owner'),'foreign-owner\n');
    if (mode === 'registry') await k.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('zext','0.1.0',now(),false,now())");
    if (mode === 'gate') await k.db.query(`insert into brain.extension_quiesce values ('testext','${foreignOwner}',now())`);
    if (mode === 'journal') await writeFile(join(k.home,'run/bootstrap-extension-migrations.json'),'foreign-journal');
    if (mode === 'enabled') await k.db.query('update brain.extensions set enabled=true');
    if (mode === 'hold') await k.db.query("delete from brain.work_hold_groups where name='extension:testext'");
    if (mode === 'schedule') await k.db.query('update brain.schedules set hold_group=null');
    if (mode === 'work') await k.db.query(`update brain.work_items set hold_group=null where id='${k.work}'`);
    if (mode === 'claim') await k.db.query(`update brain.work_items set claimed_by='test',claimed_at=now(),claim_expires_at=now()+interval '1 minute' where id='${k.work}'`);
    if (mode === 'attempt') await k.db.query(`insert into brain.work_attempts(token,work_item_id,started_at) values ('${randomUUID()}','${k.work}',now())`);
    if (mode === 'completed-attempt') await k.db.query(`insert into brain.work_attempts(token,work_item_id,started_at) values ('${randomUUID()}','${k.completed}',now())`);
    if (mode === 'core-tail') await k.db.query("delete from brain.schema_migrations where owner='core' and version=27");
    if (mode === 'checksum') await writeFile(join(k.dir, 'migrations/0001_testext.sql'), 'select 1;');
    if (mode === 'core-checksum') await k.db.query("update brain.schema_migrations set checksum='tampered' where owner='core' and version=1");
    if (mode === 'symlink') {
      const path = join(k.dir, 'migrations/0001_testext.sql'), copy = join(k.home, 'same.sql');
      await cp(path, copy); await rm(path); await symlink(copy, path);
    }
    if (mode === 'manifest') await writeFile(k.manifestPath, '{}');
    if (mode === 'daemon') await writeFile(join(k.home, 'run/daemon.pid'), 'changed');
    if (mode === 'home') return r.challenge.replace(r.home, `${r.home}-other`);
    if (mode === 'wrong' || mode === 'old') return `${r.challenge}-wrong`;
    return r.challenge;
  });
  expect(result).toMatchObject({ ok: false, code: mode === 'checksum' || mode === 'core-checksum' ? 'MIGRATION_FAILED' : 'DB_LOCKED' });
  const afterLedger = (await snapshot(k.db)).ledger;
  if (mode === 'core-checksum') expect(afterLedger).toEqual(before.ledger.map(row => row.owner === 'core' && row.version === 1 ? { ...row, checksum: 'tampered' } : row));
  else if (mode === 'core-tail') expect(afterLedger).toEqual(before.ledger.filter(row => !(row.owner === 'core' && row.version === 27)));
  else expect(afterLedger).toEqual(before.ledger);
  expect(await readFile(join(k.home, 'app/sentinel'), 'utf8')).toBe('unchanged');
  const journalPath=join(k.home,'run/bootstrap-extension-migrations.json');
  if (mode === 'journal') expect(await readFile(journalPath,'utf8')).toBe('foreign-journal');
  else await expect(readFile(journalPath)).rejects.toMatchObject({ code: 'ENOENT' });
  if (mode === 'gate') expect(await k.db.rows('select name,owner from brain.extension_quiesce')).toEqual([{name:'testext',owner:foreignOwner}]);
  if (mode === 'registry') expect(await k.db.rows('select name from brain.extensions order by name')).toEqual([{name:'testext'},{name:'zext'}]);
  if (mode === 'home-lock') expect(await readFile(join(k.home,'install.lock/owner'),'utf8')).toBe('foreign-owner\n');
  if (mode === 'installed') expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8')).commit).toBe('c'.repeat(40));
});

it.each(['31','35','gate','extension'] as const)('L5 %s 중단 뒤 새 확인과 같은 journal owner로 재개한다', async point => {
  const k = await legacyWorld(), migration = join(k.dir, 'migrations/0002_marker.sql');
  const original = await readFile(migration, 'utf8'); const beforeMemory = digest(await normalized(k.db));
  if (point === '31') await k.db.query('alter table brain.settings add column user_id text');
  if (point === '35') await k.db.query('create table brain.extension_quiesce (name text, owner text, started_at timestamptz)');
  if (point === 'gate' || point === 'extension') await writeFile(migration, 'select missing_column;');
  let challenge = '';
  expect(await k.install(async r => { challenge = r.challenge; return challenge; })).toMatchObject({ ok: false });
  const journalPath = join(k.home, 'run/bootstrap-extension-migrations.json');
  const journal = JSON.parse(await readFile(journalPath, 'utf8'));
  expect(digest(await normalized(k.db))).toBe(beforeMemory);
  if (point === '31') await k.db.query('alter table brain.settings drop column user_id');
  if (point === '35') await k.db.query('drop table brain.extension_quiesce');
  if (point === 'gate' || point === 'extension') {
    expect(await k.db.rows('select owner from brain.extension_quiesce')).toEqual([{ owner: journal.owner }]);
    await writeFile(migration, original);
  }
  expect(await k.install(async () => challenge)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(JSON.parse(await readFile(journalPath, 'utf8')).owner).toBe(journal.owner);
  expect(await k.install(async r => { expect(r.challenge).not.toBe(challenge); return r.challenge; })).toMatchObject({ ok: true });
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  expect(await k.db.rows("select name from brain.work_hold_groups order by name")).toEqual([{ name: 'extension:testext' }, { name: 'user:hold' }]);
  expect(await k.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
  expect(digest(await normalized(k.db))).toBe(beforeMemory);
});

it('L5 schema34 사용자 예약과 실행 이력은 중단과 재개 후 보존된다', async () => {
  const k = await legacyWorld(34), migration = join(k.dir, 'migrations/0002_marker.sql');
  const before = await normalized(k.db, 34), original = await readFile(migration, 'utf8');
  await writeFile(migration, 'select missing_column;');
  expect(await k.install(async r => r.challenge)).toMatchObject({ ok: false });
  expect(await normalized(k.db, 34)).toEqual(before);
  await writeFile(migration, original);
  expect(await k.install(async r => r.challenge)).toMatchObject({ ok: true });
  expect(await normalized(k.db, 34)).toEqual(before);
});

it('L6 확인 대기 중 daemon·확장 advisory·설치 잠금이 유지된다', async () => {
  const k = await legacyWorld();
  const { acquireDaemonLock } = await import('../../../apps/cli/dist/daemon/lock.js');
  const { withHomeInstallLock } = await import('../../../apps/cli/dist/runtime/install-lock.js');
  expect(await k.install(async r => {
    expect((await acquireDaemonLock({ home: k.home, clock })).ok).toBe(false);
    expect(await k.db.rows("select pg_try_advisory_lock(hashtextextended('extension-install:testext',0)) as acquired")).toEqual([{ acquired: false }]);
    const abort = new AbortController(); let entered = false;
    const waiting = withHomeInstallLock(k.home, async () => { entered = true; }, abort.signal);
    const timer = setTimeout(() => abort.abort(), 250);
    try { await expect(waiting).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_CANCELLED' }); } finally { clearTimeout(timer); }
    expect(entered).toBe(false);
    return r.challenge;
  })).toMatchObject({ ok: true });
});

it('L4 비대화 설치 의존성은 legacy offline 확인을 제공하지 않는다', async () => {
  const k = await legacyWorld();
  const { systemInstallDeps } = await import('../../../apps/cli/dist/install.js');
  const deps = systemInstallDeps({ runner: k.options.runner, secrets: k.options.secrets, databaseName: k.options.databaseName, allowOfflinePrompt: false });
  expect(await deps.postgres!(k.home, k.options.urlEnv, k.options.env)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect((await k.db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'"))[0]).toEqual({ version: 27 });
});

it('L5 승격 후 확장 migration 실패는 같은 app과 owner로 새 확인 뒤 재개한다', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const run = promisify(execFile), k = await legacyWorld(); const before = await normalized(k.db);
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const stage = join(k.home, `.app-stage-${randomUUID()}`);
  await run('git', ['clone', '--quiet', '--no-hardlinks', repo, stage]);
  const head = (await run('git', ['-C', stage, 'rev-parse', 'HEAD'])).stdout.trim();
  await run('git', ['clone', '--quiet', '--no-hardlinks', repo, join(k.home, 'app')]);
  await mkdir(join(stage, 'apps/cli/dist'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../apps/cli/dist/build.json', import.meta.url)), join(stage, 'apps/cli/dist/build.json'));
  const migration = join(k.dir, 'migrations/0002_marker.sql'), original = await readFile(migration, 'utf8');
  await writeFile(migration, 'select missing_column;');
  await mkdir(join(k.home, 'install.lock'));
  const lockOwner = `${process.pid} ${randomUUID()}\n`;
  await writeFile(join(k.home, 'install.lock/owner'), lockOwner);
  const moduleUrl = new URL('../../../apps/cli/dist/install/postgres.js', import.meta.url).href;
  const script = `import { writeFile } from 'node:fs/promises';
    import { installPostgres } from ${JSON.stringify(moduleUrl)};
    const env = process.env;
    const runner = async r => r.args[0] === 'volume' ? {ok:false,stdout:'',stderr:'no such volume',message:'missing'} : {ok:true,stdout:'',stderr:''};
    const result = await installPostgres({home:env.CASE_HOME,urlEnv:'BRAIN_DATABASE_URL',env,clock:{now:()=>new Date('2026-10-28T01:02:03.456Z')},runner,secrets:{adminUrl:env.CASE_DB,appPassword:'brain-test-app'},databaseName:env.CASE_NAME,confirmOffline:async r=>{ await writeFile(env.CASE_CHALLENGE, r.challenge); return env.CASE_OLD || r.challenge; }});
    process.stdout.write(JSON.stringify(result));`;
  const env = { ...process.env, CASE_HOME: k.home, CASE_DB: k.db.url, CASE_NAME: k.options.databaseName, CASE_CHALLENGE: join(k.home, 'challenge.txt'), SECOND_BRAIN_STAGED_APP: stage, SECOND_BRAIN_PREVIOUS_APP_HEAD: head, SECOND_BRAIN_INSTALL_LOCK_OWNER: lockOwner };
  const invoke = async () => JSON.parse((await run(process.execPath, ['--input-type=module', '-e', script], { env })).stdout);
  const invokeWithOld = async (old: string) => JSON.parse((await run(process.execPath, ['--input-type=module', '-e', script], { env: { ...env, CASE_OLD: old } })).stdout);
  const first = await invoke(); expect(first, JSON.stringify(first)).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  const journalPath = join(k.home, 'run/bootstrap-extension-migrations.json');
  const owner = JSON.parse(await readFile(journalPath, 'utf8')).owner;
  expect(await k.db.rows('select owner from brain.extension_quiesce')).toEqual([{ owner }]);
  expect(await normalized(k.db)).toEqual(before);
  const oldChallenge = await readFile(env.CASE_CHALLENGE, 'utf8');
  await writeFile(migration, original);
  expect(await invokeWithOld(oldChallenge)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(JSON.parse(await readFile(journalPath, 'utf8')).owner).toBe(owner);
  expect(await invoke()).toMatchObject({ ok: true });
  expect(await readFile(env.CASE_CHALLENGE, 'utf8')).not.toBe(oldChallenge);
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  expect(await readFile(join(k.home, 'app/apps/cli/dist/build.json'), 'utf8')).toBe(await readFile(join(stage, 'apps/cli/dist/build.json'), 'utf8'));
  expect(await normalized(k.db)).toEqual(before);
});

it.each(['35','gate'] as const)('L5 %s 직후 중단 상태는 같은 owner로 확인 후 이어진다', async point => {
  const k = await legacyWorld(), owner = randomUUID(); const before = await normalized(k.db);
  expect(await runMigrations({ databaseUrl: k.db.url, clock, coreMaxVersion: 31 })).toMatchObject({ ok: true });
  const { postgresStore } = await import('../src/index.js');
  const store = postgresStore({ databaseUrl: k.db.url });
  try { expect(await store.ensureSelfUser({ id: randomUUID(), name: 'self', createdAt: clock.now() })).toMatchObject({ ok: true }); }
  finally { await store.close(); }
  expect(await runMigrations({ databaseUrl: k.db.url, clock, coreMaxVersion: 35 })).toMatchObject({ ok: true, to: 35 });
  const path = join(k.home, 'run/bootstrap-extension-migrations.json');
  await writeFile(path, JSON.stringify({ commit: k.build.commit, names: ['testext'], owner }));
  if (point === 'gate') await k.db.query(`insert into brain.extension_quiesce values ('testext','${owner}',now())`);
  let challenge = '';
  expect(await k.install(async r => { challenge = r.challenge; return 'wrong'; })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe(owner);
  expect(await normalized(k.db)).toEqual(before);
  expect(await k.install(async r => { expect(r.challenge).not.toBe(challenge); return r.challenge; })).toMatchObject({ ok: true });
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  expect(await normalized(k.db)).toEqual(before);
});

it('L5 타 owner gate와 사용자 보류는 변경하지 않는다', async () => {
  const k = await legacyWorld();
  expect(await runMigrations({ databaseUrl: k.db.url, clock, coreMaxVersion: 31 })).toMatchObject({ ok: true });
  const { postgresStore } = await import('../src/index.js'); const store = postgresStore({ databaseUrl: k.db.url });
  try { expect(await store.ensureSelfUser({ id: randomUUID(), name: 'self', createdAt: clock.now() })).toMatchObject({ ok: true }); } finally { await store.close(); }
  expect(await runMigrations({ databaseUrl: k.db.url, clock, coreMaxVersion: 35 })).toMatchObject({ ok: true });
  const own = randomUUID(), other = randomUUID();
  await writeFile(join(k.home, 'run/bootstrap-extension-migrations.json'), JSON.stringify({ commit: k.build.commit, names: ['testext'], owner: own }));
  await k.db.query(`insert into brain.extension_quiesce values ('testext','${other}',now())`);
  const gates = await k.db.rows('select * from brain.extension_quiesce'), holds = await k.db.rows('select * from brain.work_hold_groups order by name');
  let called = false;
  expect(await k.install(async r => { called = true; return r.challenge; })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(called).toBe(false); expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual(gates); expect(await k.db.rows('select * from brain.work_hold_groups order by name')).toEqual(holds);
});

it('L5 gate 생성 직후 core 36 실패를 주입하고 새 확인으로 재개한다', async () => {
  const k = await legacyWorld(), before = await normalized(k.db);
  await k.db.query(`create function brain.fail_core36() returns trigger language plpgsql as $$ begin if new.owner='core' and new.version=36 then raise exception 'synthetic interruption after gate'; end if; return new; end $$;
    create trigger fail_core36 before insert on brain.schema_migrations for each row execute function brain.fail_core36()`);
  let old = '';
  expect(await k.install(async r => { old = r.challenge; return old; })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED', file: '0036_schedule_target_setting.sql' });
  expect(await k.db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'")).toEqual([{ version: 35 }]);
  const path = join(k.home, 'run/bootstrap-extension-migrations.json'), owner = JSON.parse(await readFile(path, 'utf8')).owner;
  expect(await k.db.rows('select owner from brain.extension_quiesce')).toEqual([{ owner }]);
  await k.db.query('drop trigger fail_core36 on brain.schema_migrations; drop function brain.fail_core36()');
  expect(await k.install(async () => old)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe(owner);
  expect(await normalized(k.db)).toEqual(before);
  expect(await k.install(async r => { expect(r.challenge).not.toBe(old); return r.challenge; })).toMatchObject({ ok: true });
  expect(await normalized(k.db)).toEqual(before);
});

it('L5 core 35 직후 gate 진입 실패를 주입하고 새 확인으로 재개한다', async () => {
  const k = await legacyWorld(), before = await normalized(k.db);
  await k.db.query(`create function brain.fail_gate_insert() returns trigger language plpgsql as $$ begin raise exception 'synthetic gate interruption'; end $$;
    create function brain.attach_gate_failure() returns event_trigger language plpgsql security definer as $$ begin
      if exists(select 1 from pg_event_trigger_ddl_commands() where object_identity='brain.extension_quiesce' and command_tag='CREATE TABLE') then
        execute 'create trigger fail_gate_insert before insert on brain.extension_quiesce for each row execute function brain.fail_gate_insert()';
      end if;
    end $$;
    create event trigger attach_gate_failure on ddl_command_end when tag in ('CREATE TABLE') execute function brain.attach_gate_failure()`);
  let old = '';
  expect(await k.install(async r => { old = r.challenge; return old; })).toMatchObject({ ok: false });
  expect(await k.db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'")).toEqual([{ version: 35 }]);
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  const path = join(k.home, 'run/bootstrap-extension-migrations.json'), owner = JSON.parse(await readFile(path, 'utf8')).owner;
  await k.db.query('drop event trigger attach_gate_failure; drop trigger fail_gate_insert on brain.extension_quiesce; drop function brain.attach_gate_failure(); drop function brain.fail_gate_insert()');
  expect(await k.install(async () => old)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(JSON.parse(await readFile(path, 'utf8')).owner).toBe(owner);
  expect(await normalized(k.db)).toEqual(before);
  expect(await k.install(async r => { expect(r.challenge).not.toBe(old); return r.challenge; })).toMatchObject({ ok: true });
  expect(await normalized(k.db)).toEqual(before);
});

async function addSecondExtension(k: Awaited<ReturnType<typeof legacyWorld>>) {
  const dir = join(k.home, 'extensions/zext'); await cp(k.dir, dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json');
  await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('testext', 'zext'));
  await writeFile(join(dir, 'migrations/0001_testext.sql'), 'create schema zext; create table zext.checks(id integer primary key, checked_at timestamptz not null);\n');
  await rm(join(dir, 'migrations/0002_marker.sql'));
  await k.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('zext','0.1.0',now(),false,now()); insert into brain.extension_work_kinds(extension_name,kind) values ('zext','zext.job'); insert into brain.work_hold_groups values ('extension:zext',now())");
  expect(await runMigrations({ databaseUrl: k.db.url, clock, owners: [{ owner: 'zext', directory: join(dir, 'migrations') }] })).toMatchObject({ ok: true });
  await k.db.query("insert into zext.checks values (8,'2026-01-03T00:00:00Z')");
  await writeFile(join(dir, 'migrations/0002_marker.sql'), 'create table zext.marker(value text);\n');
}

it('두 legacy 확장이 순서대로 정상 이행하고 사용자 보류를 보존한다', async () => {
  const k = await legacyWorld(); await addSecondExtension(k);
  const before = await k.db.rows('select * from brain.work_hold_groups order by name');
  expect(await k.install(async r => {
    for (const name of ['testext','zext']) expect(await k.db.rows(`select pg_try_advisory_lock(hashtextextended('extension-install:${name}',0)) as acquired`)).toEqual([{ acquired:false }]);
    return r.challenge;
  })).toMatchObject({ ok: true });
  expect(await k.db.rows("select owner,version from brain.schema_migrations where owner in ('testext','zext') order by owner,version")).toEqual([{ owner:'testext', version:1 }, { owner:'testext', version:2 }, { owner:'zext', version:1 }, { owner:'zext', version:2 }]);
  expect(await k.db.rows('select name,enabled from brain.extensions order by name')).toEqual([{ name:'testext', enabled:false }, { name:'zext', enabled:false }]);
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]); expect(await k.db.rows('select * from brain.work_hold_groups order by name')).toEqual(before);
  expect(await k.db.rows('select id from zext.checks')).toEqual([{ id:8 }]);
});

it('두 번째 gate 진입 실패는 첫 gate와 사용자 보류를 보존하고 같은 owner로 재개한다', async () => {
  const k = await legacyWorld(); await addSecondExtension(k);
  const holds = await k.db.rows('select * from brain.work_hold_groups order by name');
  await k.db.query(`create function brain.fail_zext_gate() returns trigger language plpgsql as $$ begin if new.name='zext' then raise exception 'injected zext gate failure'; end if; return new; end $$;
    create function brain.attach_zext_gate() returns event_trigger language plpgsql security definer as $$ begin if exists(select 1 from pg_event_trigger_ddl_commands() where object_identity='brain.extension_quiesce' and command_tag='CREATE TABLE') then execute 'create trigger fail_zext_gate before insert on brain.extension_quiesce for each row execute function brain.fail_zext_gate()'; end if; end $$;
    create event trigger attach_zext_gate on ddl_command_end when tag in ('CREATE TABLE') execute function brain.attach_zext_gate()`);
  let old = ''; expect(await k.install(async r => { old=r.challenge; return old; })).toMatchObject({ ok:false });
  const path = join(k.home,'run/bootstrap-extension-migrations.json'), owner = JSON.parse(await readFile(path,'utf8')).owner;
  expect(await k.db.rows('select name,owner from brain.extension_quiesce')).toEqual([{ name:'testext', owner }]);
  expect(await k.db.rows('select * from brain.work_hold_groups order by name')).toEqual(holds);
  await k.db.query('drop event trigger attach_zext_gate; drop trigger fail_zext_gate on brain.extension_quiesce; drop function brain.attach_zext_gate(); drop function brain.fail_zext_gate()');
  expect(await k.install(async () => old)).toMatchObject({ ok:false,code:'DB_LOCKED' });
  expect(JSON.parse(await readFile(path,'utf8')).owner).toBe(owner);
  expect(await k.install(async r => { expect(r.challenge).not.toBe(old); return r.challenge; })).toMatchObject({ ok:true });
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]); expect(await k.db.rows('select * from brain.work_hold_groups order by name')).toEqual(holds);
});

it('두 번째 확장의 타 owner gate는 확인 전 거부하고 보존한다', async () => {
  const k = await legacyWorld(); await addSecondExtension(k);
  expect(await runMigrations({ databaseUrl:k.db.url,clock,coreMaxVersion:31 })).toMatchObject({ ok:true });
  const { postgresStore } = await import('../src/index.js'); const store = postgresStore({ databaseUrl:k.db.url });
  try { expect(await store.ensureSelfUser({ id:randomUUID(),name:'self',createdAt:clock.now() })).toMatchObject({ ok:true }); } finally { await store.close(); }
  expect(await runMigrations({ databaseUrl:k.db.url,clock,coreMaxVersion:35 })).toMatchObject({ ok:true });
  const owner = randomUUID(), other = randomUUID();
  await writeFile(join(k.home,'run/bootstrap-extension-migrations.json'),JSON.stringify({ commit:k.build.commit,names:['testext','zext'],owner }));
  await k.db.query(`insert into brain.extension_quiesce values ('zext','${other}',now())`);
  const before = await snapshot(k.db), gates = await k.db.rows('select * from brain.extension_quiesce'), holds = await k.db.rows('select * from brain.work_hold_groups order by name');
  const journal = await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8'); let called=false;
  expect(await k.install(async r => { called=true; return r.challenge; })).toMatchObject({ ok:false,code:'DB_LOCKED' }); expect(called).toBe(false);
  expect(await snapshot(k.db)).toEqual(before); expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual(gates); expect(await k.db.rows('select * from brain.work_hold_groups order by name')).toEqual(holds);
  expect(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8')).toBe(journal);
});

it.each(['journal','gate','app'] as const)('SIGKILL %s 경계의 잔존 잠금과 journal을 명시 복구한다', async point => {
  const { spawn } = await import('node:child_process');
  const { promisify } = await import('node:util'); const { execFile } = await import('node:child_process'); const run = promisify(execFile);
  const k = await legacyWorld(); const before = await normalized(k.db);
  let staged = '';
  if (point === 'app') {
    const repo = fileURLToPath(new URL('../../../', import.meta.url)); staged = join(k.home, `.app-stage-${randomUUID()}`);
    await run('git',['clone','--quiet','--no-hardlinks',repo,staged]); await run('git',['clone','--quiet','--no-hardlinks',repo,join(k.home,'app')]);
    await mkdir(join(staged,'apps/cli/dist'),{recursive:true}); await cp(fileURLToPath(new URL('../../../apps/cli/dist/build.json',import.meta.url)),join(staged,'apps/cli/dist/build.json'));
  }
  if (point === 'gate') {
    await k.db.query(`create function brain.sleep_gate() returns trigger language plpgsql as $$ begin perform pg_sleep(8); return new; end $$;
      create function brain.attach_sleep_gate() returns event_trigger language plpgsql security definer as $$ begin if exists(select 1 from pg_event_trigger_ddl_commands() where object_identity='brain.extension_quiesce' and command_tag='CREATE TABLE') then execute 'create trigger sleep_gate before insert on brain.extension_quiesce for each row execute function brain.sleep_gate()'; end if; end $$;
      create event trigger attach_sleep_gate on ddl_command_end when tag in ('CREATE TABLE') execute function brain.attach_sleep_gate()`);
  } else {
    await k.db.query(`create function brain.sleep_core28() returns trigger language plpgsql as $$ begin if new.owner='core' and new.version=28 then perform pg_sleep(8); end if; return new; end $$;
      create trigger sleep_core28 before insert on brain.schema_migrations for each row execute function brain.sleep_core28()`);
  }
  const moduleUrl = new URL('../../../apps/cli/dist/install/postgres.js',import.meta.url).href;
  const script = `import {installPostgres} from ${JSON.stringify(moduleUrl)};
    const env=process.env, runner=async r=>r.args[0]==='volume'?{ok:false,stdout:'',stderr:'no such volume',message:'missing'}:{ok:true,stdout:'',stderr:''};
    const result=await installPostgres({home:env.CASE_HOME,urlEnv:'BRAIN_DATABASE_URL',env,clock:{now:()=>new Date('2026-10-28T01:02:03.456Z')},runner,secrets:{adminUrl:env.CASE_DB,appPassword:'brain-test-app'},databaseName:env.CASE_NAME,confirmOffline:async r=>{process.stdout.write('CHALLENGE '+r.challenge+'\\n');return env.CASE_OLD||r.challenge}});
    process.stdout.write('RESULT '+JSON.stringify(result)+'\\n');`;
  const env: NodeJS.ProcessEnv = { ...process.env, CASE_HOME:k.home,CASE_DB:k.db.url,CASE_NAME:k.options.databaseName };
  delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER; delete env.SECOND_BRAIN_STAGED_APP; delete env.SECOND_BRAIN_PREVIOUS_APP_HEAD;
  const inheritedLock = async () => { await mkdir(join(k.home,'install.lock')); const owner=`${process.pid} ${randomUUID()}\n`; await writeFile(join(k.home,'install.lock/owner'),owner); return owner; };
  if (point === 'app') { env.SECOND_BRAIN_STAGED_APP=staged; env.SECOND_BRAIN_PREVIOUS_APP_HEAD=(await run('git',['-C',staged,'rev-parse','HEAD'])).stdout.trim(); env.SECOND_BRAIN_INSTALL_LOCK_OWNER=await inheritedLock(); }
  const children: { child: import('node:child_process').ChildProcess; ended: Promise<{code:number|null;signal:NodeJS.Signals|null}> }[] = [];
  const start = (extra: NodeJS.ProcessEnv = {}) => {
    const child=spawn(process.execPath,['--input-type=module','-e',script],{env:{...env,...extra},stdio:['ignore','pipe','pipe']}); let output='';
    child.stdout.on('data',b=>{output+=b.toString();}); child.stderr.on('data',b=>{output+=b.toString();});
    const ended=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{ child.once('error',reject); child.once('close',(code,signal)=>resolve({code,signal})); });
    children.push({ child, ended });
    return {child,ended,text:()=>output};
  };
  const first=start();
  try {
    let sleeping=false;
    for (let i=0;i<200;i++) { if ((await k.db.rows("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='PgSleep') as sleeping"))[0]!.sleeping) { sleeping=true; break; } await new Promise(resolve=>setTimeout(resolve,50)); }
    expect(sleeping,first.text()).toBe(true);
    const challenge=first.text().match(/CHALLENGE (확인 [^\r\n]+)/)?.[1]; expect(challenge).toBeTruthy();
    const journalPath=join(k.home,'run/bootstrap-extension-migrations.json'), owner=JSON.parse(await readFile(journalPath,'utf8')).owner;
    if (point === 'gate') expect(await k.db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'")).toEqual([{version:35}]);
    if (point === 'app') expect(JSON.parse(await readFile(join(k.home,'.app-promotion.json'),'utf8')).target).toBe(k.build.commit);
    first.child.kill('SIGKILL'); expect((await first.ended).signal).toBe('SIGKILL');
    const homeOwner=await readFile(join(k.home,'install.lock/owner'),'utf8'), daemonOwner=await readFile(join(k.home,'run/daemon.pid'),'utf8');
    const waiter=start({ SECOND_BRAIN_INSTALL_LOCK_OWNER:'' }); await new Promise(resolve=>setTimeout(resolve,400)); expect(waiter.child.exitCode).toBeNull(); expect(waiter.text()).toContain('이전 설치 잠금');
    expect(await readFile(join(k.home,'install.lock/owner'),'utf8')).toBe(homeOwner); waiter.child.kill('SIGKILL'); await waiter.ended;
    await rm(join(k.home,'install.lock'),{recursive:true});
    const refused=start({ SECOND_BRAIN_INSTALL_LOCK_OWNER:'', SECOND_BRAIN_STAGED_APP:'' }); const refusalExit=await refused.ended;
    expect(refusalExit.code).toBe(0); expect(refused.text()).toContain('데몬 잠금'); expect(refused.text()).toContain('DB_LOCKED');
    expect(await readFile(join(k.home,'run/daemon.pid'),'utf8')).toBe(daemonOwner);
    await rm(join(k.home,'run/daemon.pid'));
    // The killed backend completes its sleep and releases its transaction before DDL cleanup.
    for (let i=0;i<220;i++) { if (!(await k.db.rows("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='PgSleep') as sleeping"))[0]!.sleeping) break; await new Promise(resolve=>setTimeout(resolve,50)); }
    if (point==='gate') await k.db.query('drop event trigger attach_sleep_gate; drop trigger sleep_gate on brain.extension_quiesce; drop function brain.attach_sleep_gate(); drop function brain.sleep_gate()');
    else await k.db.query('drop trigger sleep_core28 on brain.schema_migrations; drop function brain.sleep_core28()');
    if (point==='app') env.SECOND_BRAIN_INSTALL_LOCK_OWNER=await inheritedLock();
    const stale=start({CASE_OLD:challenge!}); expect((await stale.ended).code).toBe(0); expect(stale.text()).toContain('DB_LOCKED');
    expect(JSON.parse(await readFile(journalPath,'utf8')).owner).toBe(owner);
    const resumed=start(); expect((await resumed.ended).code).toBe(0); expect(resumed.text()).toContain('"ok":true'); expect(resumed.text()).not.toContain(`CHALLENGE ${challenge}\n`);
    expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    expect(await normalized(k.db)).toEqual(before);
    expect(await k.db.rows("select version,count(*)::int as count from brain.schema_migrations where owner='testext' group by version order by version")).toEqual([{version:1,count:1},{version:2,count:1}]);
    if (point==='app') await rm(join(k.home,'install.lock'),{recursive:true});
  } finally {
    for (const { child } of children) if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL');
    await Promise.all(children.map(({ended})=>ended));
  }
}, 60_000);

it.each(['correct','wrong','eof'] as const)('실제 setup run TTY %s는 legacy 확인을 강제한다', async mode => {
  const { createServer, createConnection } = await import('node:net');
  const { chmod, symlink, readlink } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process'); const { homeResources } = await import('../../../apps/cli/dist/config/resources.js');
  const pg = (await import('pg')).default; const k = await legacyWorld();
  const adminUrl = new URL(process.env.BRAIN_TEST_DATABASE_URL!); adminUrl.pathname='/postgres';
  const adminUser = decodeURIComponent(adminUrl.username), adminPassword = decodeURIComponent(adminUrl.password);
  if (adminUser !== 'postgres' || !adminPassword) throw new Error('설치기는 postgres 관리자 계정을 사용합니다. 시험 URL에 해당 계정과 비밀번호가 필요합니다.');
  const admin = new pg.Client({ connectionString: adminUrl.toString() }); await admin.connect();
  const dbName = k.options.databaseName; let renamed = false;
  try {
  // Session lock is held on the common postgres maintenance database until rename-back.
  await admin.query("select pg_advisory_lock(hashtextextended('second-brain:legacy-pty-brain-database',0))");
  const existing = await admin.query("select 1 from pg_database where datname='brain'");
  if (existing.rowCount) throw new Error('전용 시험 서버에 brain DB가 이미 있습니다. 기존 DB를 보존합니다.');
  await admin.query(`alter database "${dbName}" rename to brain`); renamed = true;
  const sockets = new Set<import('node:net').Socket>();
  const children = new Map<import('node:child_process').ChildProcess, Promise<void>>();
  const track = <T extends import('node:child_process').ChildProcess>(child: T): T => {
    const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
    children.set(child, closed); return child;
  };
  const proxy = createServer(incoming => {
    const endpoint = new URL(process.env.BRAIN_TEST_DATABASE_URL!);
    const outgoing = createConnection({host:endpoint.hostname,port:Number(endpoint.port || 5432)}); sockets.add(incoming); sockets.add(outgoing);
    incoming.on('close',()=>sockets.delete(incoming)); outgoing.on('close',()=>sockets.delete(outgoing));
    incoming.on('error',()=>outgoing.destroy()); outgoing.on('error',()=>incoming.destroy()); incoming.pipe(outgoing).pipe(incoming);
  });
  try {
    await new Promise<void>((resolve,reject)=>{ proxy.once('error',reject); proxy.listen(homeResources(k.home).port,'127.0.0.1',()=>resolve()); });
    const bin=join(k.home,'fake-bin'); await mkdir(bin);
    await writeFile(join(bin,'orb'),'#!/bin/sh\necho Running\n');
    await writeFile(join(bin,'docker'),`#!/bin/sh
case "$1 $2" in
  'context show') echo orbstack ;;
  'version --format') echo 29 ;;
  'volume inspect') echo 'no such volume' >&2; exit 1 ;;
  'ps -a') echo '{"Labels":"com.docker.compose.service=postgres","State":"running","Status":"Up (healthy)"}' ;;
  *) exit 0 ;;
esac\n`);
    await chmod(join(bin,'orb'),0o755); await chmod(join(bin,'docker'),0o755);
    await writeFile(join(k.home,'.env'),`BRAIN_POSTGRES_PASSWORD=${JSON.stringify(adminPassword)}\nBRAIN_APP_PASSWORD="brain-test-app"\n`);
    await writeFile(join(k.home,'config.toml'),'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
    const { postgresSecrets } = await import('../../../apps/cli/dist/config/codec.js');
    const { renderPostgresCompose } = await import('../../../apps/cli/dist/install/postgres.js');
    await postgresSecrets(k.home,homeResources(k.home).port,'BRAIN_DATABASE_URL');
    await mkdir(join(k.home,'postgres')); await writeFile(join(k.home,'postgres/compose.yaml'),renderPostgresCompose(k.home));
    await symlink(fileURLToPath(new URL('../../../',import.meta.url)),join(k.home,'app'));
    const env:NodeJS.ProcessEnv = { ...process.env, HOME:k.home, SECOND_BRAIN_HOME:k.home, PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`, CLAUDE_CONFIG_DIR:join(k.home,'claude'), SECOND_BRAIN_LAUNCH_AGENTS:join(k.home,'agents'), SECOND_BRAIN_LAUNCHCTL:fileURLToPath(new URL('../../../apps/cli/test/fixtures/fake-launchctl.sh',import.meta.url)), FAKE_LAUNCHCTL_DIR:join(k.home,'launchctl'), BRAIN_DATABASE_URL:`postgres://brain_app:brain-test-app@127.0.0.1:${homeResources(k.home).port}/brain` };
    delete env.DOCKER_HOST; delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER; delete env.SECOND_BRAIN_STAGED_APP; delete env.SECOND_BRAIN_PREVIOUS_APP_HEAD;
    const cli=fileURLToPath(new URL('../../../apps/cli/dist/bin.js',import.meta.url));
    const invoke = (args:string[]) => new Promise<{code:number|null;output:string}>((resolve,reject)=>{
      const child=track(spawn(process.execPath,[cli,'setup','run','--yes',...args],{env,stdio:['pipe','pipe','pipe']})); let output=''; const timer=setTimeout(()=>child.kill('SIGKILL'),15_000); child.stdout.on('data',b=>{output+=b.toString();}); child.stderr.on('data',b=>{output+=b.toString();}); child.on('error',error=>{clearTimeout(timer); reject(error);}); child.on('close',code=>{clearTimeout(timer); resolve({code,output});}); child.stdin.end();
    });
    const targetUrl=new URL(k.db.url); targetUrl.pathname='/brain';
    const readState=async () => { const c=new pg.Client({connectionString:targetUrl.toString()}); await c.connect(); try { return { ledger:(await c.query('select * from brain.schema_migrations order by owner,version')).rows,registry:(await c.query('select * from brain.extensions')).rows,holds:(await c.query('select * from brain.work_hold_groups order by name')).rows }; } finally { await c.end(); } };
    const before=await readState(), installed=await readFile(join(k.home,'installed.json'),'utf8'), appBefore=await readlink(join(k.home,'app')), configBefore=await readFile(join(k.home,'config.toml'),'utf8'), envBefore=await readFile(join(k.home,'.env'),'utf8'), composeBefore=await readFile(join(k.home,'postgres/compose.yaml'),'utf8');
    for (const args of [['--json'],[]]) { const result=await invoke(args); expect(result.code,result.output).not.toBe(0); expect(result.output).toContain('DB_LOCKED'); expect(result.output).not.toContain('기계 확인:'); expect(await readState()).toEqual(before); expect(await readFile(join(k.home,'installed.json'),'utf8')).toBe(installed); expect(await readlink(join(k.home,'app'))).toBe(appBefore); expect(await readFile(join(k.home,'config.toml'),'utf8')).toBe(configBefore); expect(await readFile(join(k.home,'.env'),'utf8')).toBe(envBefore); expect(await readFile(join(k.home,'postgres/compose.yaml'),'utf8')).toBe(composeBefore); await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'}); }
    const ptyScript=String.raw`import os,pty,select,subprocess,sys,time,re,json,fcntl,termios,struct,signal
master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,500,0,0))
p=subprocess.Popen([sys.argv[1],sys.argv[2],'setup','run','--yes']+(['--json'] if sys.argv[3]=='json' else []),stdin=slave,stdout=slave,stderr=slave,env=os.environ,start_new_session=True); os.close(slave)
def stop(signum, frame):
 try: os.killpg(p.pid,signal.SIGKILL)
 except ProcessLookupError: pass
 except PermissionError: p.kill()
 p.wait(); sys.exit(128+signum)
signal.signal(signal.SIGTERM,stop)
out=b''; answered=False; prompts=set(); deadline=time.monotonic()+35
while p.poll() is None and time.monotonic()<deadline:
 r,_,_=select.select([master],[],[],.2)
 if not r: continue
 try: chunk=os.read(master,65536)
 except OSError: break
 if not chunk: break
 out+=chunk; clean=re.sub(rb'\x1b\[[0-9;?]*[A-Za-z]',b'',out)
 for prompt in ['미러를 어디에 둘까요?','임베딩을 켤까요?','자동 업데이트를 켤까요?','시간대를 무엇으로 할까요?','이 brain을 어떤 하네스에 연결할까요?']:
  key=prompt.encode()
  if key in clean and key not in prompts: prompts.add(key); os.write(master,b'\r')
 if not answered:
  match=re.search('확인 [^\r\n]+ [0-9a-f]{40} [0-9a-f]{40} [0-9a-f-]{36}'.encode(),clean)
  if match and b'> ' in clean:
   os.write(master, b'\x04' if sys.argv[3]=='eof' else (b'wrong\n' if sys.argv[3]=='wrong' else match.group(0)+b'\n')); answered=True
if p.poll() is None:
 try: p.wait(timeout=1)
 except subprocess.TimeoutExpired:
  try: os.killpg(p.pid,signal.SIGKILL)
  except ProcessLookupError: pass
  except PermissionError: p.kill()
p.wait()
while True:
 try:
  r,_,_=select.select([master],[],[],0)
  if not r: break
  chunk=os.read(master,65536)
  if not chunk: break
  out+=chunk
 except OSError: break
os.close(master); print(json.dumps({'code':p.returncode,'answered':answered,'output':out.decode('utf8','replace')}))`;
    const ttyRun=(mode:string)=>new Promise<{code:number;answered:boolean;output:string}>((resolve,reject)=>{ const child=track(spawn('python3',['-c',ptyScript,process.execPath,cli,mode],{env,stdio:['ignore','pipe','pipe']})); let out='',err=''; const timer=setTimeout(()=>child.kill('SIGTERM'),40_000); child.stdout.on('data',b=>{out+=b.toString();}); child.stderr.on('data',b=>{err+=b.toString();}); child.on('error',error=>{clearTimeout(timer); reject(error);}); child.on('close',code=>{clearTimeout(timer); if(code!==0) reject(new Error(err)); else { try { resolve(JSON.parse(out)); } catch(e){ reject(e); } }}); });
    const jsonTty=await ttyRun('json'); expect(jsonTty.code,jsonTty.output).not.toBe(0); expect(jsonTty.answered).toBe(false); expect(jsonTty.output).toContain('DB_LOCKED'); expect(jsonTty.output).not.toContain('기계 확인:'); expect(await readState()).toEqual(before); expect(await readFile(join(k.home,'installed.json'),'utf8')).toBe(installed); expect(await readlink(join(k.home,'app'))).toBe(appBefore); expect(await readFile(join(k.home,'config.toml'),'utf8')).toBe(configBefore); expect(await readFile(join(k.home,'.env'),'utf8')).toBe(envBefore); expect(await readFile(join(k.home,'postgres/compose.yaml'),'utf8')).toBe(composeBefore); await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'});
    const tty=await ttyRun(mode);
    expect(tty.answered,tty.output).toBe(true);
    expect(tty.output).toContain('기계 확인:'); expect(tty.output).toContain('운영자의 확인이며 기계가 종료를 증명한 것이 아닙니다');
    if (mode === 'correct') {
      expect(tty.code,tty.output).toBe(0);
      expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8'))).toMatchObject({commit:k.build.commit,schema_version:41});
      const after=await readState(); expect(after.holds).toEqual(before.holds); expect(after.registry.map(r=>({name:r.name,enabled:r.enabled}))).toEqual([{name:'testext',enabled:false}]);
    } else {
      expect(tty.code,tty.output).not.toBe(0); expect(tty.output).toContain('DB_LOCKED');
      expect(await readState()).toEqual(before); expect(await readFile(join(k.home,'installed.json'),'utf8')).toBe(installed);
      expect(await readlink(join(k.home,'app'))).toBe(appBefore); expect(await readFile(join(k.home,'config.toml'),'utf8')).toBe(configBefore); expect(await readFile(join(k.home,'.env'),'utf8')).toBe(envBefore); expect(await readFile(join(k.home,'postgres/compose.yaml'),'utf8')).toBe(composeBefore); await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'});
    }
  } finally {
    for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const killTimer = setTimeout(() => { for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2_000);
    try { await Promise.all(children.values()); } finally { clearTimeout(killTimer); }
    for (const socket of sockets) socket.destroy(); if (proxy.listening) await new Promise<void>(resolve=>proxy.close(()=>resolve()));
  }
  } finally {
    try { if (renamed) await admin.query(`alter database brain rename to "${dbName}"`); }
    finally { await admin.end(); }
  }
}, 120_000);
