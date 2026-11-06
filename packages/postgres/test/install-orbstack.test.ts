import { cp, mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createIsolatedTestDatabase, type TestDatabase } from '@second-brain/test-db';
import type { CommandRunner, CommandRequest } from '../../../apps/cli/src/runtime/command-runner.js';
import { database, clock } from './fixture.js';
// These imports deliberately exercise the built CLI, as its installed entry point does.
import { systemInstallDeps, runInstaller, runInstallerWithFlags } from '../../../apps/cli/dist/install.js';
import { installPostgres } from '../../../apps/cli/dist/install/postgres.js';
import { dispatch } from '../../../apps/cli/dist/dispatch.js';
import { commands } from '../../../apps/cli/dist/commands/index.js';
import { homeResources } from '../../../apps/cli/dist/config/resources.js';
import { withoutHarnessFolders } from '../../../apps/cli/test/environment.js';
const homes: string[] = []; const databases: TestDatabase[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map(db => db.drop())); await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
const flags = { yes: true, help: false, connect: [] };
async function extensionWorld() {
  const kit = await world('running', true, true); expect((await kit.setup()).ok).toBe(true);
  const db = kit.db!, { postgresStore, runMigrations } = await import('../src/index.js');
  // Production's database is owned by brain_owner; the test helper creates it as postgres.
  const dbName = new URL(db.url).pathname.slice(1);
  if (!/^brain_test_[a-f0-9]+$/.test(dbName)) throw new Error('invalid fixture database name');
  await db.query(`alter database "${dbName}" owner to brain_owner`);
  const dir = join(kit.home, 'extensions/testext');
  await mkdir(join(kit.home, 'extensions'), { recursive: true });
  await cp(fileURLToPath(new URL('../../../apps/cli/test/fixtures/extensions/testext/', import.meta.url)), dir, { recursive: true });
  const manifestPath = join(dir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  Object.assign(manifest, { files: ['bin/check.mjs', 'bin/echo-stats.mjs', 'manifest.json', 'migrations/0001_testext.sql'], core_compat: { min: '0.0.0', max_exclusive: '1.0.0' }, plugin_version: '1.0.0' });
  await writeFile(manifestPath, JSON.stringify(manifest));
  const store = postgresStore({ databaseUrl: db.appUrl });
  expect(await store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now: clock.now(), workKinds: ['testext.job'] })).toEqual({ ok: true });
  const migration = await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'testext', directory: join(dir, 'migrations') }] });
  expect(migration.ok, JSON.stringify(migration)).toBe(true);
  await writeFile(join(dir, 'migrations/0002_marker.sql'), 'create table testext.marker (value text);\n');
  const options = { home: kit.home, urlEnv: 'BRAIN_DATABASE_URL', env: kit.env, clock, runner: kit.runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: new URL(db.url).pathname.slice(1) };
  return { ...kit, db, dir, store, install: (confirmOffline?: (request: import('../../../apps/cli/src/install/postgres.js').OfflineConfirmationRequest) => Promise<string>) => installPostgres({ ...options, ...(confirmOffline ? { confirmOffline } : {}) }) };
}

it('서로 다른 core는 실제 데몬과 명령 진입을 막고 운영자 offline 확인 후 migration한다', async () => {
  const kit = await extensionWorld();
  try {
    const installedPath = join(kit.home, 'installed.json'); const installed = JSON.parse(await readFile(installedPath, 'utf8'));
    const target = installed.commit; installed.commit = target === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40); await writeFile(installedPath, JSON.stringify(installed));
    const { acquireDaemonLock } = await import('../../../apps/cli/dist/daemon/lock.js');
    await kit.db.query("insert into brain.work_hold_groups(name,held_at) values ('extension:testext',now())");
    const { randomUUID } = await import('node:crypto'); const channel = randomUUID(), conversation = randomUUID(), file = randomUUID(), session = randomUUID(), message = randomUUID();
    const self = (await kit.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    await kit.db.query(`insert into brain.channels values ('${channel}','telegram','synthetic'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,'${self}'); insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','sha256:${'a'.repeat(64)}',1,now()); insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','session','${self}','test',now(),'import'); insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${message}','${session}','message','user','synthetic memory',now())`);
    const memory = { messages: await kit.db.rows('select * from brain.messages'), files: await kit.db.rows('select * from brain.files'), channels: await kit.db.rows('select * from brain.channel_conversations'), holds: await kit.db.rows('select * from brain.work_hold_groups') };
    const before = await kit.db.rows("select * from brain.extensions where name='testext'");
    const result = await kit.install(async request => {
      expect(request).toMatchObject({ previousCommit: installed.commit, targetCommit: target });
      expect(request.challenge).toContain(`${kit.home} ${installed.commit} ${target} `);
      expect((await acquireDaemonLock({ home: kit.home, clock })).ok).toBe(false);
      expect(await kit.db.rows("select pg_try_advisory_lock(hashtextextended('extension-install:testext',0)) as acquired")).toEqual([{ acquired: false }]);
      expect(await kit.db.rows("select to_regclass('testext.marker') as marker")).toEqual([{ marker: null }]);
      return request.challenge;
    });
    expect(result).toMatchObject({ ok: true, report: { offline_confirmation: { previous_commit: installed.commit, target_commit: target, method: 'operator' } } });
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await kit.db.rows("select * from brain.extensions where name='testext'")).toEqual(before);
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    expect({ messages: await kit.db.rows('select * from brain.messages'), files: await kit.db.rows('select * from brain.files'), channels: await kit.db.rows('select * from brain.channel_conversations'), holds: await kit.db.rows('select * from brain.work_hold_groups') }).toEqual(memory);
  } finally { await kit.store.close(); }
});

it.each(['missing', 'wrong-target', 'wrong-home', 'old-confirmation', 'changed-identity', 'resumed-entry', 'changed-manifest'] as const)('offline 확인 %s은 변경 전에 거부된다', async mode => {
  const kit = await extensionWorld();
  try {
    const path = join(kit.home, 'installed.json'); const installed = JSON.parse(await readFile(path, 'utf8'));
    installed.commit = installed.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40); await writeFile(path, JSON.stringify(installed));
    const before = { ledger: await kit.db.rows("select * from brain.schema_migrations where owner='testext'"), registry: await kit.db.rows("select * from brain.extensions where name='testext'") };
    const result = await kit.install(mode === 'missing' ? undefined : async request => {
      if (mode === 'changed-identity') await writeFile(path, JSON.stringify({ ...installed, commit: 'c'.repeat(40) }));
      if (mode === 'changed-manifest') { const manifestPath = join(kit.dir, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.core_compat = { min: '1.0.0', max_exclusive: '2.0.0' }; await writeFile(manifestPath, JSON.stringify(manifest)); }
      if (mode === 'resumed-entry') await writeFile(join(kit.home, 'run/daemon.pid'), 'replacement');
      if (mode === 'wrong-home') return request.challenge.replace(request.home, `${request.home}-other`);
      if (mode === 'wrong-target') return `확인 ${request.previousCommit} ${'f'.repeat(40)}`;
      if (mode === 'old-confirmation') return `확인 ${'d'.repeat(40)} ${request.targetCommit}`;
      return request.challenge;
    });
    expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await kit.db.rows("select * from brain.schema_migrations where owner='testext'")).toEqual(before.ledger);
    expect(await kit.db.rows("select * from brain.extensions where name='testext'")).toEqual(before.registry);
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    expect(await kit.db.rows("select to_regclass('testext.marker') as marker")).toEqual([{ marker: null }]);
  } finally { await kit.store.close(); }
});

it('실패한 cross-commit migration의 owner는 보존되지만 offline 확인은 재사용되지 않는다', async () => {
  const kit = await extensionWorld();
  try {
    const installedPath = join(kit.home, 'installed.json'); const installed = JSON.parse(await readFile(installedPath, 'utf8'));
    installed.commit = installed.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40); await writeFile(installedPath, JSON.stringify(installed));
    const path = join(kit.dir, 'migrations/0002_marker.sql'); await writeFile(path, 'select missing_column;\n');
    let previousChallenge = '';
    expect(await kit.install(async request => { previousChallenge = request.challenge; return request.challenge; })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
    const gate = await kit.db.rows('select * from brain.extension_quiesce'); expect(gate).toHaveLength(1);
    expect(JSON.parse(await readFile(join(kit.home, 'run/bootstrap-extension-migrations.json'), 'utf8')).offlineConfirmation).toMatchObject({ previous_commit: installed.commit, method: 'operator' });
    await writeFile(path, 'create table testext.marker (value text);\n');
    expect(await kit.install(async () => previousChallenge)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual(gate);
    expect(await kit.install(async request => request.challenge)).toMatchObject({ ok: true });
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  } finally { await kit.store.close(); }
});

it.each(['journal', 'gate', 'incompatible', 'identity', 'legacy'] as const)('installPostgres는 %s에서 확장 SQL 전 안전하게 거부한다', async kind => {
  const kit = await extensionWorld();
  try {
    const ledger = await kit.db.rows("select * from brain.schema_migrations where owner='testext'");
    if (kind === 'journal') await writeFile(join(kit.home, 'extensions/.transition-testext.json'), '{}');
    if (kind === 'gate') await kit.db.query("insert into brain.extension_quiesce values ('testext','00000000-0000-7000-8000-000000000090',now())");
    if (kind === 'incompatible') { const path = join(kit.dir, 'manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8')); manifest.core_compat = { min: '1.0.0', max_exclusive: '2.0.0' }; await writeFile(path, JSON.stringify(manifest)); }
    if (kind === 'identity') await rm(join(kit.home, 'installed.json'));
    if (kind === 'legacy') await kit.db.query("drop table brain.extension_quiesce; delete from brain.schema_migrations where owner='core' and version>=35");
    const gates = kind === 'legacy' ? [] : await kit.db.rows('select * from brain.extension_quiesce');
    const result = await kit.install(); expect(result).toMatchObject({ ok: false, code: 'DB_LOCKED', message: expect.stringContaining(kind === 'legacy' ? '신원' : '복구') });
    expect(await kit.db.rows("select * from brain.schema_migrations where owner='testext'")).toEqual(ledger);
    expect(await kit.db.rows("select to_regclass('testext.marker') as marker")).toEqual([{ marker: null }]);
    if (kind !== 'legacy') expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual(gates);
    else expect(await kit.db.rows("select to_regclass('brain.extension_quiesce') as gate")).toEqual([{ gate: null }]);
  } finally { await kit.store.close(); }
});

it('installPostgres는 미정산 일감을 거부하고 자기 gate와 공용 기억을 보존한다', async () => {
  const { randomUUID } = await import('node:crypto');
  const kit = await extensionWorld();
  try {
    const id = randomUUID(), pending = randomUUID(), token = randomUUID(), channel = randomUUID(), conversation = randomUUID(), file = randomUUID(), session = randomUUID(), message = randomUUID();
    await kit.db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values ('${id}','testext.job','probe','a',now(),now(),'supervised',now(),now()+interval '10 minutes','test')`);
    await kit.db.query(`insert into brain.work_attempts(token,work_item_id,started_at,incarnation) values ('${token}','${id}',now(),'test'); update brain.work_items set current_attempt_token='${token}' where id='${id}'`);
    await kit.db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class) values ('${pending}','testext.job','probe','b','2026-01-01','2026-01-01','supervised')`);
    const self = (await kit.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    await kit.db.query(`insert into brain.work_hold_groups(name,held_at) values ('extension:testext',now()); insert into brain.channels values ('${channel}','telegram','synthetic'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref,user_id) values ('${conversation}','${channel}','chat',null,'${self}'); insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','sha256:${'a'.repeat(64)}',1,now())`);
    await kit.db.query(`insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','session','${self}','test',now(),'import'); insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${message}','${session}','message','user','synthetic memory',now())`);
    const before = { files: await kit.db.rows('select * from brain.files'), channels: await kit.db.rows('select * from brain.channel_conversations'), messages: await kit.db.rows('select * from brain.messages'), holds: await kit.db.rows('select * from brain.work_hold_groups') };
    const installedPath = join(kit.home, 'installed.json'); const installed = JSON.parse(await readFile(installedPath, 'utf8'));
    installed.commit = installed.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40); await writeFile(installedPath, JSON.stringify(installed));
    const installing = await kit.install(async request => request.challenge);
    expect(installing).toMatchObject({ ok: false, code: 'DB_LOCKED', message: expect.stringContaining('미정산') });
    const gate = await kit.db.rows("select owner from brain.extension_quiesce where name='testext'"); expect(gate).toHaveLength(1);
    expect(JSON.parse(await readFile(join(kit.home, 'run/bootstrap-extension-migrations.json'), 'utf8')).owner).toBe(gate[0]!.owner);
    expect(await kit.db.rows(`select current_attempt_token,claimed_by,completed_at from brain.work_items where id='${id}'`)).toEqual([{ current_attempt_token: token, claimed_by: 'test', completed_at: null }]);
    expect(await kit.db.rows(`select finished_at from brain.work_attempts where token='${token}'`)).toEqual([{ finished_at: null }]);
    expect(await kit.db.rows("select to_regclass('testext.marker') as marker")).toEqual([{ marker: null }]);
    const claim = await kit.store.claimSupervisedWork({ now: clock.now(), claimedBy: 'other', kinds: ['testext.job'], attemptToken: randomUUID() });
    expect(claim).toMatchObject({ ok: true, item: null });
    await kit.db.query(`update brain.work_attempts set finished_at=now(),outcome='died' where token='${token}'; update brain.work_items set current_attempt_token=null,claimed_at=null,claim_expires_at=null,claimed_by=null,completed_at=now(),outcome='failed' where id='${id}'`);
    expect(await kit.install(async request => request.challenge)).toMatchObject({ ok: true });
    expect(await kit.db.rows("select to_regclass('testext.marker') as marker")).toEqual([{ marker: 'testext.marker' }]);
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    expect({ files: await kit.db.rows('select * from brain.files'), channels: await kit.db.rows('select * from brain.channel_conversations'), messages: await kit.db.rows('select * from brain.messages'), holds: await kit.db.rows('select * from brain.work_hold_groups') }).toEqual(before);
  } finally { await kit.store.close(); }
});

it('installPostgres는 중단된 자기 journal과 gate를 같은 owner로 재개한다', async () => {
  const kit = await extensionWorld();
  try {
    const owner = '00000000-0000-7000-8000-000000000090';
    const build = JSON.parse(await readFile(new URL('../../../apps/cli/dist/build.json', import.meta.url), 'utf8'));
    await mkdir(join(kit.home, 'run'), { recursive: true });
    await writeFile(join(kit.home, 'run/bootstrap-extension-migrations.json'), JSON.stringify({ commit: build.commit, names: ['testext'], owner }));
    await kit.db.query(`insert into brain.extension_quiesce values ('testext','${owner}',now())`);
    expect(await kit.install()).toMatchObject({ ok: true });
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    await expect(readFile(join(kit.home, 'run/bootstrap-extension-migrations.json'))).rejects.toThrow();
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
  } finally { await kit.store.close(); }
});

it('installPostgres는 실패한 migration의 gate owner로 수정 후 재개한다', async () => {
  const kit = await extensionWorld();
  try {
    const path = join(kit.dir, 'migrations/0002_marker.sql'); await writeFile(path, 'select missing_column;\n');
    expect(await kit.install()).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
    const gate = await kit.db.rows("select owner from brain.extension_quiesce where name='testext'"); expect(gate).toHaveLength(1);
    expect(JSON.parse(await readFile(join(kit.home, 'run/bootstrap-extension-migrations.json'), 'utf8')).owner).toBe(gate[0]!.owner);
    await writeFile(path, 'create table testext.marker (value text);\n');
    expect(await kit.install()).toMatchObject({ ok: true });
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
  } finally { await kit.store.close(); }
});

it('두 확장의 두 번째 migration 실패와 부분 gate 해제 뒤 같은 owner로 재개한다', async () => {
  const kit = await extensionWorld();
  try {
    const dir = join(kit.home, 'extensions/zext'); await cp(kit.dir, dir, { recursive: true });
    const manifestPath = join(dir, 'manifest.json');
    await writeFile(manifestPath, (await readFile(manifestPath, 'utf8')).replaceAll('testext', 'zext'));
    await writeFile(join(dir, 'migrations/0001_testext.sql'), 'create schema zext; create table zext.checks(id integer);');
    await writeFile(join(dir, 'migrations/0002_marker.sql'), 'select missing_column;');
    expect(await kit.store.recordExtensionInstall({ name: 'zext', version: '0.1.0', now: clock.now(), workKinds: ['zext.job'] })).toEqual({ ok: true });
    await kit.db.query("insert into brain.work_hold_groups(name,held_at) values ('extension:testext',now())");
    const holds = await kit.db.rows('select * from brain.work_hold_groups');
    expect(await kit.install()).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
    const gates = await kit.db.rows('select * from brain.extension_quiesce order by name'); expect(gates).toHaveLength(2);
    const owner = gates[0]!.owner; expect(gates[1]!.owner).toBe(owner);
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='zext' order by version")).toEqual([{ version: 1 }]);
    await writeFile(join(dir, 'migrations/0002_marker.sql'), 'create table zext.marker(value text);');
    // Fail the second actual release after the first has committed.
    await kit.db.query(`create function brain.fail_zext_release() returns trigger language plpgsql as $$ begin if old.name='zext' then raise exception 'synthetic release failure'; end if; return old; end $$; create trigger fail_zext_release before delete on brain.extension_quiesce for each row execute function brain.fail_zext_release()`);
    expect(await kit.install()).toMatchObject({ ok: false });
    expect(await kit.db.rows("select name,owner from brain.extension_quiesce order by name")).toEqual([{ name: 'zext', owner }]);
    expect(JSON.parse(await readFile(join(kit.home, 'run/bootstrap-extension-migrations.json'), 'utf8')).owner).toBe(owner);
    await kit.db.query('drop trigger fail_zext_release on brain.extension_quiesce; drop function brain.fail_zext_release()');
    await kit.db.query("insert into brain.extension_quiesce values ('otherext','00000000-0000-7000-8000-000000000099',now())");
    const other = await kit.db.rows("select * from brain.extension_quiesce where name='otherext'");
    expect(await kit.install()).toMatchObject({ ok: false, code: 'DB_LOCKED' });
    expect(await kit.db.rows("select * from brain.extension_quiesce where name='otherext'")).toEqual(other);
    expect((await kit.db.rows("select owner from brain.extension_quiesce where name='zext'"))[0]!.owner).toBe(owner);
    await kit.db.query("delete from brain.extension_quiesce where name='otherext'");
    expect(await kit.install()).toMatchObject({ ok: true });
    expect(await kit.db.rows('select * from brain.extension_quiesce')).toEqual([]);
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='testext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await kit.db.rows("select version from brain.schema_migrations where owner='zext' order by version")).toEqual([{ version: 1 }, { version: 2 }]);
    expect(await kit.db.rows('select * from brain.work_hold_groups')).toEqual(holds);
  } finally { await kit.store.close(); }
});

it.each(['live', 'unknown'] as const)('installPostgres는 %s daemon 잠금을 보존하고 확장 SQL을 실행하지 않는다', async state => {
  const kit = await extensionWorld();
  const { acquireDaemonLock } = await import('../../../apps/cli/dist/daemon/lock.js');
  let lock: Awaited<ReturnType<typeof acquireDaemonLock>> | undefined;
  try {
    const path = join(kit.home, 'run/daemon.pid');
    if (state === 'live') { lock = await acquireDaemonLock({ home: kit.home, clock }); expect(lock.ok).toBe(true); }
    else { await mkdir(join(kit.home, 'run'), { recursive: true }); await writeFile(path, 'unknown'); }
    const before = await readFile(path, 'utf8');
    expect(await kit.install()).toMatchObject({ ok: false, code: 'DB_LOCKED', message: expect.stringContaining('데몬') });
    expect(await readFile(path, 'utf8')).toBe(before);
    expect(await kit.db.rows("select to_regclass('testext.marker') as marker")).toEqual([{ marker: null }]);
  } finally { if (lock?.ok) await lock.release(); await kit.store.close(); }
});
async function world(mode = 'running', withDatabase = true, isolated = false) {
  const home = await mkdtemp(join(tmpdir(), 'brain-orbstack-')); homes.push(home);
  const env: NodeJS.ProcessEnv = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(home, 'claude'), SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'), SECOND_BRAIN_LAUNCHCTL: fileURLToPath(new URL('../../../apps/cli/test/fixtures/fake-launchctl.sh', import.meta.url)), FAKE_LAUNCHCTL_DIR: join(home, 'launchctl') };
  delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER;
  delete env.DOCKER_HOST;
  await mkdir(join(home, 'claude'), { recursive: true });
  await writeFile(join(home, 'config.toml'), 'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
  const db = withDatabase ? await database(false, isolated ? createIsolatedTestDatabase : undefined) : undefined; if (db) databases.push(db);
  if (db) env.BRAIN_DATABASE_URL = db.appUrl;
  const calls: CommandRequest[] = [];
  let container: 'absent' | 'running' | 'stopped' = 'absent';
  let volumeExists = false;
  const good = (stdout = '') => ({ ok: true as const, stdout, stderr: '' });
  const runner: CommandRunner = async request => {
    calls.push(request);
    if (request.command === 'orb') return mode === 'missing' ? { ok: false, code: 'ENOENT', stdout: '', stderr: '', message: 'missing' } : good(mode === 'stopped' ? 'Stopped' : 'Running');
    const args = request.args;
    if (args[0] === 'context') return good(mode === 'other-context' ? 'desktop-linux' : 'orbstack');
    if (args[0] === 'version') return good('29');
    if (args[0] === 'volume') return volumeExists
      ? good(JSON.stringify([{ Labels: { 'com.docker.compose.project': homeResources(home).project } }]))
      : { ok: false, stdout: '', stderr: 'no such volume', message: 'missing' };
    if (args[0] === 'ps') return good(container === 'absent' ? '' : JSON.stringify({ Labels: 'com.docker.compose.service=postgres', State: container === 'running' ? 'running' : 'exited', Status: container === 'running' ? 'Up (healthy)' : 'Exited' }));
    if (args.includes('up')) { container = 'running'; volumeExists = true; }
    if (args.includes('down')) { container = 'absent'; if (args.includes('-v')) volumeExists = false; }
    return good();
  };
  const deps = systemInstallDeps({ runner }); deps.isTTY = false; deps.log = () => {};
  // Keep installation verification in-process while retaining the actual PG assembly.
  deps.installed.verify = async () => ({ ok: true });
  deps.daemon.register = async () => ({ label: homeResources(home).label, plist_path: null, status: 'unsupported', plist_changed: false });
  if (db) deps.postgres = () => installPostgres({ home, urlEnv: 'BRAIN_DATABASE_URL', env, clock, runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: new URL(db.url).pathname.slice(1) });
  const execute = async (args: string[], commandRunner = runner) => {
    let stdout = ''; const exit = await dispatch(commands, [...args, '--json'], { clock, env, runner: commandRunner, stdout: (s: string) => { stdout += s; }, stderr: () => {} });
    return { exit, ...JSON.parse(stdout) };
  };
  return { home, env, db, calls, runner, deps, execute, stopContainer: () => { container = 'stopped'; }, setup: () => runInstallerWithFlags(flags, env, deps) };
}
it.each(['missing', 'stopped', 'other-context'])('stops setup and doctor with guidance and skipped db checks when OrbStack is %s', async mode => {
  const kit = await world(mode, false); const before = await readdir(kit.home);
  expect(await kit.setup()).toMatchObject({ ok: false, failure: { code: 'ORBSTACK_UNAVAILABLE', exit: 2 } });
  expect(await readdir(kit.home)).toEqual(before);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor.data.checks).toEqual(expect.arrayContaining([{ id: 'orbstack', status: 'fail', code: 'ORBSTACK_UNAVAILABLE', detail: expect.any(String) }]));
  for (const id of ['container', 'db', 'writable', 'pg_trgm', 'redaction_cleanup', 'schema-version', 'failures', 'untagged', 'transcripts']) expect(doctor.data.checks).toContainEqual({ id, status: 'skip', detail: '앞선 점검 실패: orbstack' });
  expect(kit.calls.some(c => c.args.includes('up') || c.args.includes('start'))).toBe(false);
});
it('skips adapter probes with the container prerequisite when postgres is stopped', async () => {
  const kit = await world('running', false);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'orbstack', status: 'ok' }));
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'container', status: 'fail' }));
  for (const id of ['db', 'writable', 'pg_trgm', 'redaction_cleanup', 'schema-version', 'failures', 'untagged', 'transcripts']) expect(doctor.data.checks).toContainEqual({ id, status: 'skip', detail: '앞선 점검 실패: container' });
  expect(kit.calls.some(c => c.args.includes('up') || c.args.includes('start'))).toBe(false);
});
it('uses PG prerequisites for a home with no selector and leaves uninstall without compose alone', async () => {
  const kit = await world('running', false);
  await writeFile(join(kit.home, 'config.toml'), 'schema_version=1\n');
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'orbstack', status: 'ok' }));
  expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id: 'container', status: 'fail' }));
  kit.calls.length = 0;
  expect(await kit.execute(['setup', 'uninstall'])).toMatchObject({ ok: true });
  expect(kit.calls).toHaveLength(0);
});
it('runs setup twice against one database with compose, roles and migrations once', async () => {
  const kit = await world();
  const first = await kit.setup(); expect(first).toMatchObject({ ok: true, report: { postgres: { owner_created: true, compose_started: true } } });
  const volume = await kit.runner({ command: 'docker', args: ['volume', 'inspect', homeResources(kit.home).volume], env: kit.env, timeoutMs: 5000 });
  expect(volume.ok).toBe(true);
  expect(JSON.parse(volume.stdout)).toEqual([{ Labels: { 'com.docker.compose.project': homeResources(kit.home).project } }]);
  const migrations = await kit.db!.rows('select * from brain.schema_migrations');
  const second = await kit.setup(); expect(second).toMatchObject({ ok: true, report: { postgres: { owner_created: false, applied: [], compose_started: false } } });
  expect(await kit.db!.rows('select * from brain.schema_migrations')).toEqual(migrations);
  expect(kit.calls.filter(c => c.args.includes('up'))).toHaveLength(1);
  const doctor = await kit.execute(['doctor', 'run']);
  for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'schema-version']) expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
});
it('restarts a stopped postgres container with unchanged compose and restores healthy doctor checks', async () => {
  const kit = await world();
  expect(await kit.setup()).toMatchObject({ ok: true, report: { postgres: { compose_started: true } } });
  const composePath = join(kit.home, 'postgres', 'compose.yaml');
  const compose = await readFile(composePath, 'utf8');
  const migrations = await kit.db!.rows('select * from brain.schema_migrations');
  kit.stopContainer();
  expect(await kit.setup()).toMatchObject({ ok: true, report: { postgres: { compose_started: true, applied: [], owner_created: false } } });
  expect(kit.calls.filter(c => c.args.includes('up'))).toHaveLength(2);
  expect(await readFile(composePath, 'utf8')).toBe(compose);
  expect(await kit.db!.rows('select * from brain.schema_migrations')).toEqual(migrations);
  const doctor = await kit.execute(['doctor', 'run']);
  expect(doctor).toMatchObject({ exit: 0, ok: true });
  for (const id of ['orbstack', 'container', 'db', 'writable', 'pg_trgm', 'redaction_cleanup', 'schema-version']) expect(doctor.data.checks).toContainEqual(expect.objectContaining({ id, status: 'ok' }));
});
it('imports the transcripts on disk during a PG setup', async () => {
  const kit = await world();
  const folder = join(kit.home, 'claude', 'projects', '-tmp-import'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'import.jsonl'), await readFile(new URL('../../claude-code/test/fixtures/two-turns.jsonl', import.meta.url)));
  const legacy = join(kit.home, 'brain.db'); await writeFile(legacy, 'legacy');
  const result = await kit.setup(); expect(result).toMatchObject({ ok: true, report: { postgres: { legacy_sqlite_path: legacy, import: { enqueued: 1 } } } });
  expect(await readFile(legacy, 'utf8')).toBe('legacy');
  expect((await kit.db!.rows('select * from brain.sessions')).length).toBe(1);
  expect((await kit.db!.rows('select * from brain.messages')).length).toBeGreaterThan(0);
});
it('leaves the volume after setup uninstall and removes it only with consent', async () => {
  const kit = await world(); expect((await kit.setup()).ok).toBe(true); kit.calls.length = 0;
  expect(await kit.execute(['setup', 'uninstall', '--delete-volume'])).toMatchObject({ exit: 3, error: { code: 'CONFIRMATION_REQUIRED' } });
  expect(kit.calls).toHaveLength(0);
  expect(await kit.execute(['setup', 'uninstall'])).toMatchObject({ ok: true, data: { postgres: { down: true, volume_removed: false } } });
  expect(kit.calls.filter(c => c.args.includes('down')).at(-1)?.args).not.toContain('-v');
  expect(await kit.execute(['setup', 'uninstall', '--delete-volume', '--yes'])).toMatchObject({ ok: true, data: { postgres: { down: true, volume_removed: true } } });
  expect(kit.calls.filter(c => c.args.includes('down')).at(-1)?.args).toContain('-v');
});
it('uninstalls a PG-configured home without compose without calling the runner', async () => {
  const kit = await world('stopped', false);
  expect(await kit.execute(['setup', 'uninstall'])).toMatchObject({ exit: 0, ok: true, data: { postgres: null } });
  expect(kit.calls).toHaveLength(0);
});
it('removes daemon traces but leaves the container when uninstall finds OrbStack stopped', async () => {
  const kit = await world('stopped', false);
  for (const folder of ['postgres', 'run', 'log']) await mkdir(join(kit.home, folder));
  const compose = join(kit.home, 'postgres', 'compose.yaml');
  await writeFile(compose, '# fixture\n');
  const traces = ['run/daemon.pid', 'run/heartbeat', 'log/daemon.log', 'log/daemon.log.1'].map(path => join(kit.home, path));
  for (const path of traces) await writeFile(path, 'stale trace');
  const result = await kit.execute(['setup', 'uninstall']);
  expect(result).toMatchObject({ exit: 2, ok: false, error: { code: 'ORBSTACK_UNAVAILABLE' } });
  expect(result.error.message).toContain('데몬 정리는 끝났지만');
  expect(result.error.message).toContain('컨테이너를 남겼습니다');
  for (const path of traces) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(compose, 'utf8')).toBe('# fixture\n');
  expect(kit.calls.map(c => [c.command, ...c.args])).toEqual([['orb', 'status']]);
});
it.each(['stderr', 'stdout', 'message'] as const)('reports the bounded %s tail when only compose down fails', async source => {
  const kit = await world('running', false);
  await mkdir(join(kit.home, 'postgres'));
  await writeFile(join(kit.home, 'postgres', 'compose.yaml'), '# fixture\n');
  const failure = { ok: false as const, stderr: '', stdout: '', message: '', [source]: 'discard-prefix' + 'x'.repeat(2100) + 'down-failure-tail' };
  const runner: CommandRunner = request => request.args.includes('down') ? Promise.resolve(failure) : kit.runner(request);
  const result = await kit.execute(['setup', 'uninstall'], runner);
  expect(result).toMatchObject({ exit: 2, ok: false, error: { code: 'DB_UNAVAILABLE' } });
  expect(result.error.message).toContain('데몬 정리는 끝났지만');
  expect(result.error.message).not.toContain('discard-prefix');
  expect(result.error.message.split('\n').at(-1)).toBe(failure[source].slice(-2000));
});
it.each(['volume', 'port'])('returns exit 2 from installer and CLI for a %s conflict', async conflict => {
  const kit = await world('running', false);
  const runner: CommandRunner = async request => {
    if (conflict === 'volume' && request.args[0] === 'volume') return { ok: true, stdout: JSON.stringify([{ Labels: { 'com.docker.compose.project': 'other-project' } }]), stderr: '' };
    if (conflict === 'port' && request.args.includes('up')) return { ok: false, stdout: '', stderr: 'port is already allocated', message: 'failed' };
    return kit.runner(request);
  };
  const lines: string[] = [];
  kit.deps.log = line => lines.push(line);
  kit.deps.postgres = () => installPostgres({ home: kit.home, env: kit.env, urlEnv: 'BRAIN_DATABASE_URL', clock, runner });
  expect(await runInstaller(['--yes'], kit.env, kit.deps)).toBe(2);
  expect(lines.join('\n')).toContain('DB_UNAVAILABLE');
  const expectedDetail = conflict === 'volume' ? 'other-project' : String(homeResources(kit.home).port);
  expect(lines.join('\n')).toContain(expectedDetail);
  const result = await kit.execute(['setup', 'run', '--yes'], runner);
  expect(result).toMatchObject({ exit: 2, ok: false, error: { code: 'DB_UNAVAILABLE', message: expect.stringContaining(expectedDetail) } });
  if (conflict === 'volume') expect(kit.calls.some(c => c.args.includes('up'))).toBe(false);
});

it('installPostgres creates self before migrating a v31 database with settings and conversations', async () => {
  const { runMigrations } = await import('../src/index.js');
  const { randomUUID } = await import('node:crypto');
  const kit = await world(), db = kit.db!;
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 31 })).toMatchObject({ ok: true, to: 31 });
  const channel = randomUUID(), conversation = randomUUID();
  await db.query("insert into brain.settings(key,value,updated_at) values ('timezone','UTC','2026-01-01T00:00:00Z')");
  await db.query(`insert into brain.channels(id,kind,bot_ref) values ('${channel}','telegram','synthetic'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${conversation}','${channel}','chat','thread')`);
  const result = await installPostgres({ home: kit.home, urlEnv: 'BRAIN_DATABASE_URL', env: kit.env, clock, runner: kit.runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: new URL(db.url).pathname.slice(1) });
  expect(result).toMatchObject({ ok: true, report: { schema_version: 41, owner_created: true } });
  const self = (await db.rows('select id from brain.users where is_self=1'))[0]!.id;
  expect(await db.rows("select user_id,value,updated_at from brain.settings where key='timezone'")).toEqual([{ user_id: self, value: 'UTC', updated_at: new Date('2026-01-01T00:00:00Z') }]);
  expect(await db.rows(`select user_id,external_ref,thread_ref from brain.channel_conversations where id='${conversation}'`)).toEqual([{ user_id: self, external_ref: 'chat', thread_ref: 'thread' }]);
});

it('retries setup after a v32 migration failure without replacing self or old data', async () => {
  const { runMigrations } = await import('../src/index.js');
  const { randomUUID } = await import('node:crypto');
  const kit = await world(), db = kit.db!, channel = randomUUID(), conversation = randomUUID();
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 31 })).toMatchObject({ ok: true, to: 31 });
  await db.query("insert into brain.settings(key,value,updated_at) values ('timezone','UTC','2026-01-01T00:00:00Z')");
  await db.query(`insert into brain.channels(id,kind,bot_ref) values ('${channel}','telegram','synthetic'); insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${conversation}','${channel}','chat','thread')`);
  // A conflicting column causes 0032 to fail inside its own transaction after setup creates self.
  await db.query('alter table brain.settings add column user_id text');
  const options = { home: kit.home, urlEnv: 'BRAIN_DATABASE_URL', env: kit.env, clock, runner: kit.runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: new URL(db.url).pathname.slice(1) };
  expect(await installPostgres(options)).toMatchObject({ ok: false, code: 'MIGRATION_FAILED', file: '0032_user_keys.sql' });
  expect((await db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'"))[0]!.version).toBe(31);
  const self = (await db.rows('select id from brain.users where is_self=1'))[0]!.id;
  const oldSetting = await db.rows("select key,value,updated_at from brain.settings where key='timezone'");
  const oldConversation = await db.rows(`select id,channel_id,external_ref,thread_ref from brain.channel_conversations where id='${conversation}'`);
  await db.query('alter table brain.settings drop column user_id');
  expect(await installPostgres(options)).toMatchObject({ ok: true, report: { schema_version: 41, owner_created: false } });
  expect(await db.rows('select id from brain.users where is_self=1')).toEqual([{ id: self }]);
  expect(await db.rows("select key,value,updated_at from brain.settings where key='timezone'")).toEqual(oldSetting);
  expect(await db.rows(`select id,channel_id,external_ref,thread_ref from brain.channel_conversations where id='${conversation}'`)).toEqual(oldConversation);
  expect(await db.rows("select user_id from brain.settings where key='timezone'")).toEqual([{ user_id: self }]);
  expect(await db.rows(`select user_id from brain.channel_conversations where id='${conversation}'`)).toEqual([{ user_id: self }]);
});
