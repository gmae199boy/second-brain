import pg from 'pg';
import { spawn, execFileSync } from 'node:child_process';
import { appendFile, cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createIsolatedTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { database, clock } from './fixture.js';
import { runtimeDatabaseFence, runMigrations, postgresStore, provisionExtension } from '../src/index.js';
import { withRuntimeFence, runtimeFencePath } from '../../../apps/cli/src/install/runtime-fence.js';
import { installPostgres } from '../../../apps/cli/dist/install/postgres.js';
import { writeConfig } from '../../../apps/cli/src/config/codec.js';
import { dispatch } from '../../../apps/cli/src/dispatch.js';
import { commands } from '../../../apps/cli/src/commands/index.js';
import { withoutHarnessFolders } from '../../../apps/cli/test/environment.js';
const homes: string[] = [], databases: TestDatabase[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.drop(); for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true }); });
async function world() {
  const db = await database(false, createIsolatedTestDatabase); databases.push(db);
  const home = await mkdtemp(join(tmpdir(), 'brain-unattended-')); homes.push(home);
  const name = new URL(db.url).pathname.slice(1); await db.query(`alter database "${name}" owner to brain_owner`);
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 45 })).toMatchObject({ ok: true });
  const build = JSON.parse(await readFile(new URL('../../../apps/cli/dist/build.json', import.meta.url), 'utf8'));
  await writeFile(join(home, 'installed.json'), JSON.stringify({ commit: build.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40), schema_version: 45, node: process.execPath, plugin_root: null, installed_at: clock.now().toISOString() }));
  await mkdir(join(home, 'run')); await mkdir(join(home, 'extensions'));
  const env = { ...withoutHarnessFolders(process.env), HOME: home, SECOND_BRAIN_HOME: home, SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents'), SECOND_BRAIN_LAUNCHCTL: fileURLToPath(new URL('../../../apps/cli/test/fixtures/fake-launchctl.sh', import.meta.url)), FAKE_LAUNCHCTL_DIR: join(home, 'launchctl'), BRAIN_DATABASE_URL: db.appUrl };
  await writeConfig(home, {}); await writeFile(join(home, '.env'), `BRAIN_DATABASE_URL=${db.appUrl}\n`);
  const runner = async (request: { args: readonly string[] }) => request.args[0] === 'volume' ? { ok: false as const, stdout: '', stderr: 'no such volume', message: 'missing' } : { ok: true as const, stdout: '', stderr: '' };
  return { db, home, env, options: { home, urlEnv: 'BRAIN_DATABASE_URL', env, clock, runner, secrets: { adminUrl: db.url, appPassword: 'brain-test-app' }, databaseName: name } };
}
it('비대화 core migration 중 새 hook과 옛 접속 실패 경로는 spool로 보류하고 로그인 복구 뒤 drain한다', async () => {
  const k = await world();
  // journal을 모르는 옛 hook의 접속 실패 경로도 같은 DB로 별도 홈에서 실행한다.
  const oldHome = join(k.home, 'old-hook'); await mkdir(oldHome); await writeConfig(oldHome, {}); await writeFile(join(oldHome, '.env'), `BRAIN_DATABASE_URL=${k.db.appUrl}\n`);
  const transcript = fileURLToPath(new URL('../../claude-code/test/fixtures/two-turns.jsonl', import.meta.url));
  const hook = async (home: string) => {
    let output = '';
    const code = await dispatch(commands, ['sessions', 'ingest', 'claude-code', '--json'], { env: { ...k.env, SECOND_BRAIN_HOME: home }, clock, stdin: async () => JSON.stringify({ session_id: '4f1e7a90-1c2b-4d3e-8f55-000000000000', transcript_path: transcript }), stdout: text => { output += text; }, stderr: () => {} });
    expect(code).toBe(0); expect(JSON.parse(output)).toMatchObject({ ok: true, data: { spooled: true } });
  };
  await k.db.query("create role brain_ext_fixture login password 'synthetic'; comment on role brain_ext_fixture is 'second-brain extension:" + k.options.databaseName + "'");
  const extensionUrl = new URL(k.db.appUrl); extensionUrl.username = 'brain_ext_fixture'; extensionUrl.password = 'synthetic';
  const clients = [new pg.Client({ connectionString: k.db.appUrl }), new pg.Client({ connectionString: extensionUrl.toString() })];
  for (const client of clients) { client.on('error', () => {}); await client.connect(); await client.query('select 1'); }
  const result = await installPostgres({ ...k.options, observeOffline: async () => {
    expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: false }]);
    for (const client of clients) await expect(client.query('select 1')).rejects.toThrow();
    await hook(k.home); await hook(oldHome);
    expect(await k.db.rows("select count(*)::int as count from pg_stat_activity where datname=current_database() and usename='brain_app'")).toEqual([{ count: 0 }]);
  } });
  for (const client of clients) await client.end().catch(() => {});
  expect(result).toMatchObject({ ok: true, report: { schema_version: 48, offline_confirmation: { method: 'automatic', evidence: { runtime_backends: 0 } } } });
  expect(await k.db.rows("select has_function_privilege('brain_ext_fixture','brain.extension_event_emit(uuid,uuid,text,text,date,text,text,uuid,jsonb)','EXECUTE') allowed")).toEqual([{ allowed: true }]);
  expect(await k.db.rows("select count(*)::int n from brain.schema_migrations where owner='core' and version=48")).toEqual([{ n: 1 }]);
  expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: true }]);
  await expect(readFile(runtimeFencePath(k.home))).rejects.toMatchObject({ code: 'ENOENT' });
  for (const home of [k.home, oldHome]) {
    let output = ''; const code = await dispatch(commands, ['queue', 'drain', '--json'], { env: { ...k.env, SECOND_BRAIN_HOME: home }, clock, stdout: text => { output += text; }, stderr: () => {} });
    expect(code, output).toBe(0); expect(JSON.parse(output)).toMatchObject({ ok: true });
  }
  expect((await k.db.rows('select count(*)::int as count from brain.messages'))[0]!.count).toBe(4);
});
it('프로세스 중단 journal은 다음 설치기에서 원래 로그인 상태로 복구하고 실패 시에도 원복한다', async () => {
  const k = await world();
  await k.db.query("create role brain_ext_disabled nologin; comment on role brain_ext_disabled is 'second-brain extension:" + k.options.databaseName + "'");
  const dbFence = await runtimeDatabaseFence(k.db.url);
  const original = await dbFence.snapshot();
  await writeFile(runtimeFencePath(k.home), JSON.stringify(original)); await dbFence.block(original); await dbFence.close();
  await expect(withRuntimeFence(k.home, k.db.url, async () => { throw new Error('정지 검증 실패'); })).rejects.toThrow('정지 검증 실패');
  expect(await k.db.rows("select rolname,rolcanlogin from pg_roles where rolname in ('brain_app','brain_ext_disabled') order by rolname")).toEqual([{ rolname: 'brain_app', rolcanlogin: true }, { rolname: 'brain_ext_disabled', rolcanlogin: false }]);
  await expect(readFile(runtimeFencePath(k.home))).rejects.toMatchObject({ code: 'ENOENT' });
});
it('다른 DB가 있는 cluster는 역할을 변경하지 않고 거부한다', async () => {
  const k = await world(); await k.db.query('create database unrelated');
  const fence = await runtimeDatabaseFence(k.db.url);
  try { await expect(fence.snapshot()).rejects.toThrow('전용'); }
  finally { await fence.close(); }
  expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: true }]);
  await k.db.query('drop database unrelated');
});

it.each(['membership', 'marker'] as const)('불명확한 %s 역할은 NOLOGIN 전에 거부한다', async mode => {
  const k = await world();
  if (mode === 'membership') await k.db.query('create role synthetic_writer login; grant brain_app to synthetic_writer');
  else await k.db.query('create role brain_ext_unknown login');
  await expect(withRuntimeFence(k.home, k.db.url, async () => true)).rejects.toThrow('역할');
  expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: true }]);
});
it('NOLOGIN 중 실제 설치기 SIGKILL 뒤 같은 설치기는 daemon fence와 로그인 상태를 복구한다', async () => {
  const k = await world();
  const { randomUUID } = await import('node:crypto');
  const lockOwner = `${process.pid} ${randomUUID()}\n`;
  await mkdir(join(k.home, 'install.lock')); await writeFile(join(k.home, 'install.lock/owner'), lockOwner);
  const module = new URL('../../../apps/cli/dist/install/postgres.js', import.meta.url).href;
  const script = `import { installPostgres } from ${JSON.stringify(module)};
    const env=process.env;
    const runner=async r=>r.args[0]==='volume'?{ok:false,stdout:'',stderr:'no such volume',message:'missing'}:{ok:true,stdout:'',stderr:''};
    const result=await installPostgres({home:env.SECOND_BRAIN_HOME,urlEnv:'BRAIN_DATABASE_URL',env,clock:{now:()=>new Date()},runner,secrets:{adminUrl:env.CASE_DB,appPassword:'brain-test-app'},databaseName:env.CASE_NAME,observeOffline:async()=>{if(env.CASE_KILL==='yes'){const {trackedProcessLauncher}=await import(env.CASE_REGISTRY);const {writeFile}=await import('node:fs/promises');const child=await trackedProcessLauncher(env.SECOND_BRAIN_HOME).start({command:process.execPath,args:['-e','setInterval(()=>{},1000)'],env:{}});if(!child.ok)throw Error('자식 시작 실패');await writeFile(env.CASE_ORPHAN,String(child.handle.pid));process.kill(process.pid,'SIGKILL')}}});
    process.stdout.write(JSON.stringify(result));`;
  const invoke = (kill: boolean) => new Promise<{ code: number | null; signal: NodeJS.Signals | null; text: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...k.env, SECOND_BRAIN_INSTALL_LOCK_OWNER: lockOwner, CASE_DB: k.db.url, CASE_NAME: k.options.databaseName, CASE_KILL: kill ? 'yes' : 'no', CASE_REGISTRY: new URL('../../../apps/cli/dist/runtime/process-registry.js', import.meta.url).href, CASE_ORPHAN: join(k.home, 'run/orphan-pid') }, stdio: ['ignore', 'pipe', 'pipe'] });
    let text=''; child.stdout.on('data', value => { text+=value; }); child.stderr.on('data', value => { text+=value; }); child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, text }));
  });
  let orphanPid: number | undefined;
  try {
  const stopped = await invoke(true); expect(stopped.signal, stopped.text).toBe('SIGKILL');
  expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: false }]);
  expect(JSON.parse(await readFile(join(k.home, 'run/daemon.pid'), 'utf8')).boot_at).toBe('9999-01-01T00:00:00.000Z');
  orphanPid = Number(await readFile(join(k.home, 'run/orphan-pid'), 'utf8'));
  const denied = await invoke(false); expect(JSON.parse(denied.text)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: false }]);
  process.kill(-orphanPid, 'SIGKILL');
  let groupGone = false;
  for (let attempt=0; attempt<500; attempt++) { try { process.kill(-orphanPid,0); await new Promise(resolve=>setTimeout(resolve,20)); } catch (error) { if ((error as NodeJS.ErrnoException).code==='ESRCH') { groupGone = true; break; } throw error; } }
  expect(groupGone, '시험이 종료한 고아 그룹의 OS 회수를 확인합니다').toBe(true);
  const resumed = await invoke(false); expect(resumed.code, resumed.text).toBe(0); expect(JSON.parse(resumed.text), resumed.text).toMatchObject({ ok: true });
  expect(await k.db.rows("select rolcanlogin from pg_roles where rolname='brain_app'")).toEqual([{ rolcanlogin: true }]);
  await expect(readFile(runtimeFencePath(k.home))).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(join(k.home, 'run/daemon.pid'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { if (orphanPid) try { process.kill(-orphanPid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
});

it('core48 무인 갱신은 기존 배포 Garmin을 교체 대기로 정지하고 새 패키지로만 해제한다', async () => {
  const k = await world();
  const archive = join(k.home, 'baseline.tar');
  execFileSync('git', ['archive', '--output', archive, 'e407369b57841a5d759945a2a70c38480329e3bb', 'plugins/garmin/package']);
  execFileSync('tar', ['-xf', archive, '-C', k.home]);
  const old = join(k.home, 'plugins/garmin/package'), target = join(k.home, 'extensions/garmin');
  await cp(old, target, { recursive: true });
  const { ensureExtensionPassword } = await import('../../../apps/cli/src/config/codec.js');
  await provisionExtension(k.db.url, 'garmin', await ensureExtensionPassword(k.home, 'garmin'));
  await appendFile(join(k.home, '.env'), `BRAIN_POSTGRES_PASSWORD=${decodeURIComponent(new URL(k.db.url).password)}\n`);
  expect(await runMigrations({ databaseUrl: k.db.url, clock, coreMaxVersion: 46, owners: [{ owner: 'garmin', directory: join(target, 'migrations') }] })).toMatchObject({ ok: true });
  await k.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('garmin','1.2.6',now(),true,now()); insert into brain.extension_work_kinds(extension_name,kind) values ('garmin','garmin.report')");
  const sourceBefore = await readFile(join(target, 'src/report_channel.py'));
  const result = await installPostgres(k.options);
  expect(result).toMatchObject({ ok: true, report: { schema_version: 48, offline_confirmation: { method: 'automatic' } } });
  const store = postgresStore({ databaseUrl: k.db.appUrl });
  try {
    const gate = await store.readExtensionQuiesce('garmin');
    expect(gate.ok && gate.owner).toBeTruthy();
    expect(await store.getExtensionInstallProgress('garmin')).toMatchObject({ journal: { progress: { replacement: { fromVersion: '1.2.6', owner: gate.ok ? gate.owner : null } } } });
    expect(await readFile(join(target, 'src/report_channel.py'))).toEqual(sourceBefore);
    const { extensionRuntime } = await import('../../../apps/cli/src/runtime/extensions.js');
    const { readConfig } = await import('../../../apps/cli/src/config/codec.js');
    const runtime = extensionRuntime({ home: k.home, env: k.env, config: await readConfig(k.home), clock });
    const manifest = JSON.parse(await readFile(join(old, 'manifest.json'), 'utf8'));
    const build = JSON.parse(await readFile(new URL('../../../apps/cli/dist/build.json', import.meta.url), 'utf8'));
    await writeFile(join(k.home, 'installed.json'), JSON.stringify({ commit: build.commit, schema_version: 48, node: process.execPath, plugin_root: null, installed_at: clock.now().toISOString() }));
    await expect(runtime.packages.checkCore!(manifest)).rejects.toThrow('1.2.7');
    // 최신 패키지 전환은 기존 교체 프로토콜을 사용하며 auth/scheduler 단계 전에 gate를 해제한다.
    let output = '';
    const currentPackage = fileURLToPath(new URL('../../../plugins/garmin/package', import.meta.url));
    const currentManifest = JSON.parse(await readFile(join(currentPackage, 'manifest.json'), 'utf8'));
    const exit = await dispatch(commands, ['ext','install','--package',currentPackage,'--json'], { env: k.env, clock, stdout: text => { output += text; }, stderr: () => {} });
    expect(exit, output).not.toBe(0);
    expect(['EXTENSION_LOGIN_REQUIRED', 'EXTENSION_SCHEDULER_UNAVAILABLE']).toContain(JSON.parse(output).error.code);
    expect(await store.getExtension('garmin'), output).toMatchObject({ extension: { version: currentManifest.version } });
    expect(await store.readExtensionQuiesce('garmin'), output).toMatchObject({ owner: null });
    expect(await store.getExtensionInstallProgress('garmin')).toMatchObject({ journal: { progress: { name: 'garmin' } } });
    const progress = await store.getExtensionInstallProgress('garmin');
    expect(progress.ok && progress.journal?.progress.replacement).toBeUndefined();
    const { extensionDatabaseUrl } = await import('../../../apps/cli/src/config/codec.js');
    const url = await extensionDatabaseUrl(k.home, 'garmin', k.db.appUrl);
    const probe = JSON.parse(execFileSync(join(target, '.venv/bin/python'), ['-c', 'import json,psycopg,sys;sys.path.insert(0,sys.argv[1]);from role_probe import probe_role;c=psycopg.connect(sys.argv[2]);print(json.dumps(probe_role(c)));c.close()', join(target, 'src'), url], { encoding: 'utf8', env: { ...k.env, PYTHONDONTWRITEBYTECODE: '1' } }));
    expect(probe).toMatchObject({ no_excess_functions: true, event_emit_execute: true });
  } finally { await store.close(); }
}, 180_000);
