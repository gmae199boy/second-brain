import { withoutHarnessFolders } from '../../../apps/cli/test/environment.js';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { createIsolatedTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { installPostgres } from '../../../apps/cli/dist/install/postgres.js';
import { database, clock } from './fixture.js';
import { CORE_SCHEMA_VERSION, runMigrations, postgresStore } from '../src/index.js';
import { spawn, type ChildProcess } from 'node:child_process';
import { digestPackageFiles, readPackageObservation } from '../../../apps/cli/src/runtime/extension-package.js';

const homes: string[] = [], databases: TestDatabase[] = [];
const children = new Map<ChildProcess, Promise<void>>();
let traceGateCleanup = false;
const traceCleanup = (stage: string) => { if (traceGateCleanup) process.stderr.write(`[replacement-gate] cleanup ${stage}\n`); };
function track<T extends ChildProcess>(child: T): T {
  const closed = new Promise<void>(resolve => { child.once('close', () => resolve()); child.once('error', () => resolve()); });
  children.set(child, closed); return child;
}
afterEach(async () => {
  traceCleanup('children begin');
  for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const timer = setTimeout(() => { for (const child of children.keys()) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 2000);
  try { await Promise.all(children.values()); } finally { clearTimeout(timer); children.clear(); }
  traceCleanup('children end; databases begin');
  const errors: unknown[] = [];
  for (const db of databases.splice(0)) {
    try {
      for (const name of ['oldext', 'garmin']) {
        const role = `brain_ext_${name}`;
        const owned = await db.rows(`select 1 from pg_roles where rolname='${role}' and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database()`);
        if (owned.length) await db.query(`drop owned by "${role}"; drop role "${role}"`);
      }
    } catch (error) {errors.push(error);}
    traceCleanup('database drop begin');
    try {await db.drop();} catch(error) {errors.push(error);}
    traceCleanup('database drop end');
  }
  traceCleanup('homes begin');
  const cleaned = await Promise.allSettled(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
  for (const result of cleaned) if (result.status === 'rejected') errors.push(result.reason);
  traceCleanup('homes end'); traceGateCleanup = false;
  if (errors.length) throw new AggregateError(errors, '시험 자원 정리 실패');
});
async function world(name: 'garmin' | 'oldext', schema = 27) {
  const home = await mkdtemp(join(await realpath(tmpdir()), 'brain-retired-')); homes.push(home);
  const db = await database(false, createIsolatedTestDatabase); databases.push(db);
  const databaseName = new URL(db.url).pathname.slice(1);
  await db.query(`alter database "${databaseName}" owner to brain_owner`);
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: schema })).toMatchObject({ok:true});
  const dir = join(home, 'extensions', name), migrations = join(dir, 'migrations');
  await mkdir(migrations, {recursive:true}); await mkdir(join(home, 'run'), {recursive:true});
  const fixture = await readFile(new URL('../../core/fixtures/extensions/legacy-garmin-1.0.0-manifest.json', import.meta.url), 'utf8');
  await writeFile(join(dir, 'manifest.json'), name === 'garmin' ? fixture : fixture.replaceAll('garmin', name));
  // Public migration bytes from revision 09947d2; ledger is synthetic and contains no health data.
  const source = fileURLToPath(new URL('./fixtures/legacy-garmin-migrations/', import.meta.url));
  await cp(source, migrations, {recursive:true});
  for (const file of await readdir(migrations)) {
    const original = await readFile(join(migrations,file), 'utf8');
    const body = name === 'garmin' ? original : original.replaceAll('garmin',name);
    await writeFile(join(migrations,file),body);
    const hash = createHash('sha256').update(body).digest('hex');
    await db.query(`insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('${name}',${Number(file.slice(0,4))},'${file}','${hash}',now())`);
  }
  await db.query(`insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('${name}','1.0.0',now(),false,now()); insert into brain.work_hold_groups values ('extension:${name}',now())`);
  const build = JSON.parse(await readFile(new URL('../../../apps/cli/dist/build.json', import.meta.url),'utf8'));
  const installed = {commit: build.commit === 'a'.repeat(40) ? 'b'.repeat(40) : 'a'.repeat(40), schema_version:schema,node:process.execPath,plugin_root:null,installed_at:'2026-01-01T00:00:00Z'};
  await writeFile(join(home,'installed.json'),JSON.stringify(installed));
  const runner = async (request: {args: readonly string[]}) => request.args[0] === 'volume' ? {ok:false as const,stdout:'',stderr:'no such volume',message:'missing'} : {ok:true as const,stdout:'',stderr:''};
  const env: NodeJS.ProcessEnv = {...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME:home}; delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER;
  const options = {home,urlEnv:'BRAIN_DATABASE_URL',env,clock,runner,secrets:{adminUrl:db.url,appPassword:'brain-test-app'},databaseName};
  const install = () => installPostgres({...options,observeOffline:async r => r.verificationId});
  return {home, db, dir, build, installed, install, options};
}

it.each(['garmin','oldext'] as const)('legacy %s preserves its applied history and gate through rerun', async name => {
  const k = await world(name); const before = await k.db.rows(`select * from brain.schema_migrations where owner='${name}' order by version`);
  expect(await k.install()).toMatchObject({ok:true});
  expect(await k.db.rows(`select * from brain.schema_migrations where owner='${name}' order by version`)).toEqual(before);
  const gate = await k.db.rows('select * from brain.extension_quiesce'); const progress = await k.db.rows('select * from brain.extension_install_progress');
  expect(gate).toHaveLength(1); expect(progress[0]?.progress).toMatchObject({replacement:{owner:gate[0]?.owner,fromVersion:'1.0.0'}});
  await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,commit:k.build.commit,schema_version:CORE_SCHEMA_VERSION}));
  expect(await k.install()).toMatchObject({ok:true});
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual(gate); expect(await k.db.rows('select * from brain.extension_install_progress')).toEqual(progress);
  await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,schema_version:CORE_SCHEMA_VERSION}));
  expect(await k.install()).toMatchObject({ok:true});
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual(gate); expect(await k.db.rows('select * from brain.extension_install_progress')).toEqual(progress);
});

it('rejects unapproved retired manifest in a current installation', async () => {
  const k = await world('oldext', 39); await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,commit:k.build.commit}));
  expect(await k.install()).toMatchObject({ok:false,code:'DB_LOCKED'});
});

it.each(['invalid-progress','transition','checksum','unknown'] as const)('legacy rejects %s before confirmation', async mode => {
  const k = await world('oldext');
  if (mode === 'invalid-progress' || mode === 'transition') {
    const value = mode === 'invalid-progress' ? {} : {name:'oldext',packageDigest:'a'.repeat(64),result:null,failedStage:null,lastFailure:null,stages:{},authWorkId:null,scheduleIds:[],transition:{owner:'12345678-1234-1234-1234-123456789abc',registered:false}};
    await k.db.query(`insert into brain.extension_install_progress values ('oldext',1,'${JSON.stringify(value)}'::jsonb)`);
  }
  if (mode === 'checksum') await writeFile(join(k.dir,'migrations/0001_tracer.sql'),'altered');
  if (mode === 'unknown') { const file = join(k.dir,'manifest.json'); const manifest = JSON.parse(await readFile(file,'utf8')); manifest.unknown = true; await writeFile(file,JSON.stringify(manifest)); }
  let called = false;
  const result = await installPostgres({...k.options,observeOffline:async r => {called = true; return r.verificationId;}});
  expect(result).toMatchObject({ok:false,code:'DB_LOCKED'}); expect(called).toBe(false);
  await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'});
});

it('resumes with the same owner after a failed progress write', async () => {
  const k = await world('oldext');
  await k.db.query(`create function brain.reject_progress() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$; create trigger reject_progress before insert on brain.extension_install_progress for each row execute function brain.reject_progress()`);
  expect(await k.install()).toMatchObject({ok:false});
  const gate = await k.db.rows('select * from brain.extension_quiesce'); expect(gate).toHaveLength(1);
  const journal = JSON.parse(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8')); expect(journal.owner).toBe(gate[0]?.owner);
  await k.db.query('drop trigger reject_progress on brain.extension_install_progress; drop function brain.reject_progress()');
  expect(await k.install()).toMatchObject({ok:true});
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual(gate);
  const progress = await k.db.rows('select progress from brain.extension_install_progress'); expect(progress[0]?.progress).toMatchObject({replacement:{owner:journal.owner}});
});

it('resumes after replacement progress was saved before journal removal', async () => {
  const k = await world('oldext');
  await k.db.query(`create function brain.reject_progress() returns trigger language plpgsql as $$ begin raise exception 'injected'; end $$; create trigger reject_progress before insert on brain.extension_install_progress for each row execute function brain.reject_progress()`);
  expect(await k.install()).toMatchObject({ok:false});
  const journal = JSON.parse(await readFile(join(k.home,'run/bootstrap-extension-migrations.json'),'utf8'));
  await k.db.query('drop trigger reject_progress on brain.extension_install_progress; drop function brain.reject_progress()');
  const progress = {name:'oldext',packageDigest:'a'.repeat(64),result:null,failedStage:null,lastFailure:null,stages:{},authWorkId:null,scheduleIds:[],replacement:{owner:journal.owner,fromVersion:'1.0.0',at:'2026-10-28T01:02:03.456Z'}};
  await k.db.query(`insert into brain.extension_install_progress values ('oldext',1,'${JSON.stringify(progress)}'::jsonb)`);
  expect(await k.install()).toMatchObject({ok:true});
  expect((await k.db.rows('select progress from brain.extension_install_progress'))[0]?.progress).toEqual(progress);
  expect((await k.db.rows('select owner from brain.extension_quiesce'))[0]?.owner).toBe(journal.owner);
});

it('rejects a replacement owner that differs from its gate', async () => {
  const k = await world('oldext'); expect(await k.install()).toMatchObject({ok:true});
  await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,commit:k.build.commit,schema_version:CORE_SCHEMA_VERSION}));
  await k.db.query(`update brain.extension_install_progress set progress=jsonb_set(progress,'{replacement,owner}','"12345678-1234-1234-1234-123456789abc"')`);
  expect(await k.install()).toMatchObject({ok:false,code:'DB_LOCKED'});
});

// The CLI uses only this synthetic home and the per-test database on the owned server.
async function cliWorld() {
  const k = await world('oldext');
  expect(await k.install()).toMatchObject({ok:true});
  await writeFile(join(k.home,'installed.json'), JSON.stringify({...k.installed,commit:k.build.commit,schema_version:CORE_SCHEMA_VERSION}));
  return cliForWorld(k);
}
async function cliForWorld(k: Awaited<ReturnType<typeof world>>) {
  const adminPassword = decodeURIComponent(new URL(k.db.url).password);
  await writeFile(join(k.home,'config.toml'), 'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
  await writeFile(join(k.home,'.env'), `BRAIN_POSTGRES_PASSWORD=${JSON.stringify(adminPassword)}\nBRAIN_APP_PASSWORD="brain-test-app"\nBRAIN_EXT_GARMIN_PASSWORD="${'a'.repeat(48)}"\nBRAIN_EXT_OLDEXT_PASSWORD="${'a'.repeat(48)}"\n`);
  const env: NodeJS.ProcessEnv = {...withoutHarnessFolders(process.env),HOME:k.home,SECOND_BRAIN_HOME:k.home,BRAIN_DATABASE_URL:k.db.appUrl,BRAIN_POSTGRES_PASSWORD:adminPassword,BRAIN_APP_PASSWORD:'brain-test-app',SECOND_BRAIN_TEST_EXTENSIONS:join(k.home,'source-extensions')};
  delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER; delete env.SECOND_BRAIN_STAGED_APP; delete env.SECOND_BRAIN_PREVIOUS_APP_HEAD;
  const cli = fileURLToPath(new URL('../../../apps/cli/dist/bin.js',import.meta.url));
  const run = (args:string[], timeoutMs = 60000) => new Promise<{code:number|null;stdout:string;stderr:string;body:any}>((resolve,reject) => {
    const child = track(spawn(process.execPath,[cli,...args],{env,stdio:['ignore','pipe','pipe']})); let stdout='',stderr='';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data',chunk => {stdout+=chunk.toString();}); child.stderr.on('data',chunk => {stderr+=chunk.toString();});
    child.once('error',error => {clearTimeout(timer); reject(error);}); child.once('close',code => {clearTimeout(timer); if (child.signalCode) return reject(Error(`CLI ${args.join(' ')} 종료 신호 ${child.signalCode}: ${stdout}${stderr}`)); let body; try {body=JSON.parse(stdout);} catch {} resolve({code,stdout,stderr,body});});
  });
  const tty = (args:string[]) => new Promise<{code:number;output:string}>((resolve,reject) => {
    const program = `import os,pty,subprocess,select,json,sys,time,signal,fcntl,termios\ndef session():\n os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)\nm,s=pty.openpty(); p=subprocess.Popen([sys.argv[1],sys.argv[2]]+sys.argv[3:],stdin=s,stdout=s,stderr=s,preexec_fn=session); os.close(s); out=b''; deadline=time.monotonic()+10\ndef stop(signum, frame):\n try: os.killpg(p.pid,signal.SIGKILL)\n except ProcessLookupError: pass\n p.wait(); sys.exit(128+signum)\nsignal.signal(signal.SIGTERM,stop)\nwhile p.poll() is None and time.monotonic()<deadline:\n r,_,_=select.select([m],[],[],.2)\n if r:\n  try: out+=os.read(m,65536)\n  except OSError: break\nif p.poll() is None: os.killpg(p.pid,signal.SIGKILL)\np.wait()\nwhile True:\n try:\n  r,_,_=select.select([m],[],[],0)\n  if not r: break\n  chunk=os.read(m,65536)\n  if not chunk: break\n  out+=chunk\n except OSError: break\nos.close(m); print(json.dumps({'code':p.returncode,'output':out.decode('utf8','replace')}))`;
    const child = track(spawn('python3',['-c',program,process.execPath,cli,...args],{env,stdio:['ignore','pipe','pipe']})); let stdout='',stderr='';
    child.stdout.on('data',x => {stdout+=x.toString();}); child.stderr.on('data',x => {stderr+=x.toString();});
    child.once('error',reject); child.once('close',code => {if(code!==0) reject(Error(stderr)); else {try {resolve(JSON.parse(stdout));} catch(error) {reject(error);}}});
  });
  return {...k,env,run,tty};
}

async function syntheticPackage(k: Awaited<ReturnType<typeof cliWorld>>, mode: 'valid' | 'incompatible' | 'digest' | 'checksum' | 'older' | 'different' = 'valid') {
  const dir = join(k.home,`package-${randomUUID()}`); await mkdir(join(dir,'migrations'),{recursive:true}); await mkdir(join(dir,'bin'));
  for (const file of await readdir(join(k.dir,'migrations'))) await cp(join(k.dir,'migrations',file),join(dir,'migrations',file));
  if (mode === 'checksum') await writeFile(join(dir,'migrations/0001_tracer.sql'), '-- changed historical migration\n');
  await writeFile(join(dir,'migrations/0009_new.sql'),'select 1;\n');
  await writeFile(join(dir,'bin/check.mjs'),"console.log(JSON.stringify({abi:1,type:'result',summary:'synthetic'}));\n");
  const files = ['bin/check.mjs','manifest.json',...(await readdir(join(dir,'migrations'))).sort().map(name=>`migrations/${name}`)];
  const manifest = {name:'oldext',version:mode === 'older' ? '0.9.0' : mode === 'different' ? '1.2.0' : '1.1.0',core:1,abi:1,migrations:'migrations',connection_check:{runtime:'node',entry:'bin/check.mjs'},files,core_compat:mode === 'incompatible' ? {min:'999.0.0',max_exclusive:'1000.0.0'} : {min:'0.0.0',max_exclusive:'999.0.0'},plugin_version:'1.1.0'};
  await writeFile(join(dir,'manifest.json'),JSON.stringify(manifest));
  const bytes = new Map(await Promise.all(files.map(async file => [file,await readFile(join(dir,file))] as const)));
  await writeFile(join(dir,'digest'),`${digestPackageFiles(files,bytes)}\n`);
  if (mode === 'digest') await writeFile(join(dir,'bin/check.mjs'),'tampered\n');
  return dir;
}

async function replacementSnapshot(k: Awaited<ReturnType<typeof cliWorld>>) {
  return {observation:await readPackageObservation(k.home,'oldext'),gate:await k.db.rows('select * from brain.extension_quiesce order by name'),progress:await k.db.rows('select * from brain.extension_install_progress order by name'),ledger:await k.db.rows("select * from brain.schema_migrations where owner='oldext' order by version"),manifest:await readFile(join(k.dir,'manifest.json'),'utf8')};
}

it('교체 대기 중 CLI 진입을 거부하고 재연결 뒤에도 예약 청구를 막는다', async () => {
  traceGateCleanup = true;
  const step = async <T>(name: string, action: () => Promise<T>): Promise<T> => {
    process.stderr.write(`[replacement-gate] ${name} begin\n`);
    try { const result = await action(); process.stderr.write(`[replacement-gate] ${name} end\n`); return result; }
    catch (error) { process.stderr.write(`[replacement-gate] ${name} failed\n`); throw error; }
  };
  const k = await step('prepare world', () => cliWorld());
  const before = await step('initial snapshot', () => replacementSnapshot(k));
  for (const args of [['ext','enable','oldext','--json'],['ext','run','oldext','sync','--json'],['ext','oldext','sync','--json'],['ext','install','oldext','--json']]) {
    const result = await step(`cli ${args.slice(1,3).join(' ')}`, () => k.run(args,10000));
    expect(result.body?.error?.code, result.stdout+result.stderr).toBe('EXTENSION_REPLACEMENT_REQUIRED');
  }
  const login = await step('login pty', () => k.tty(['ext','login','oldext','--json']));
  expect(login.code,login.output).not.toBe(-9); expect(login.output).toContain('EXTENSION_REPLACEMENT_REQUIRED');
  const id = randomUUID();
  await step('insert work', () => k.db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,hold_group) values ('${id}','oldext.sync','extension','synthetic',now(),now(),'supervised',null)`));
  const scheduled = randomUUID(), at = new Date('2026-01-01T09:00:00.000Z');
  const scheduler = postgresStore({databaseUrl:k.db.appUrl});
  try {
    const self = await step('read self', () => scheduler.readSelfUser()); if (!self.ok || !self.user) throw Error('missing synthetic self');
    const added = await step('add schedule', () => scheduler.addSchedule({id:scheduled,kind:'oldext.sync',holdGroup:null,targetKind:'extension',targetId:'synthetic',triggerKind:'cron',cronExpr:'0 9 * * *',runAt:null,triggerUpdatedAt:null,timeZone:'UTC',timeZoneSource:'fixed',intervalSeconds:null,extension:'oldext',scheduleKey:'synthetic',userId:self.user!.id,enabled:true,removedAt:null,nextRunAt:at,lastRunAt:null,createdAt:at}));
    expect(added.ok).toBe(true);
    const fired = await step('fire schedule', () => scheduler.fireSchedule({scheduleId:scheduled,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:at,nextRunAt:new Date(at.getTime()+86400000),now:new Date(),occurrences:[{occurrenceAt:at,status:'pending'}],work:{id:randomUUID(),kind:'oldext.sync',targetKind:'extension',targetId:'synthetic',createdAt:at,nextAttemptAt:at}}));
    expect(fired).toMatchObject({ok:true,fired:false});
  } finally { await step('close scheduler', () => scheduler.close()); }
  for (let i=0;i<2;i++) {
    const store = postgresStore({databaseUrl:k.db.appUrl});
    try { const claim = await step(`claim ${i+1}`, () => store.claimSupervisedWork({now:new Date(),claimedBy:'synthetic-worker',kinds:['oldext.sync'],attemptToken:randomUUID()})); expect(claim).toMatchObject({ok:true,item:null}); }
    finally {await step(`close claim store ${i+1}`, () => store.close());}
    const denied = await step(`cli enable retry ${i+1}`, () => k.run(['ext','enable','oldext','--json'],10000)); expect(denied.body?.error?.code).toBe('EXTENSION_REPLACEMENT_REQUIRED');
  }
  expect(await step('final snapshot', () => replacementSnapshot(k))).toEqual(before);
},60000);

it.each(['incompatible','digest','checksum','older'] as const)('CLI 패키지 %s 거부는 gate, 이력 및 옛 파일을 보존한다', async mode => {
  const k = await cliWorld(), before = await replacementSnapshot(k), packageDir = await syntheticPackage(k,mode);
  const result = await k.run(['ext','install','--package',packageDir,'--json']);
  expect(result.code,result.stdout+result.stderr).not.toBe(0);
  expect(await replacementSnapshot(k)).toEqual(before);
},60000);

it('CLI의 검증된 node 패키지는 checksum 접두를 유지하고 비활성 및 보류를 보존한다', async () => {
  const k = await cliWorld(), packageDir = await syntheticPackage(k), before = await replacementSnapshot(k);
  const result = await k.run(['ext','install','--package',packageDir,'--json']);
  expect(result.code,result.stdout+result.stderr).toBe(0);
  const after = await replacementSnapshot(k);
  expect(after.ledger.slice(0,8)).toEqual(before.ledger); expect(after.ledger.map(r=>r.version)).toEqual([1,2,3,4,5,6,7,8,9]);
  expect(after.gate).toEqual([]); expect(after.progress[0]?.progress).not.toHaveProperty('replacement'); expect(after.progress[0]?.progress).not.toHaveProperty('transition');
  expect(await k.db.rows("select enabled from brain.extensions where name='oldext'")).toEqual([{enabled:false}]);
  expect(await k.db.rows("select name from brain.work_hold_groups where name='extension:oldext'")).toEqual([{name:'extension:oldext'}]);
  const enabled = await k.run(['ext','enable','oldext','--json']); expect(enabled.code,enabled.stdout+enabled.stderr).toBe(0);
  expect(await k.db.rows("select enabled from brain.extensions where name='oldext'")).toEqual([{enabled:true}]);
  expect(await k.db.rows("select name from brain.work_hold_groups where name='extension:oldext'")).toEqual([]);
},60000);

it('교체 migration 중 CLI 강제 종료 뒤 다른 패키지는 거부하고 같은 패키지로 재개한다', async () => {
  const k = await cliWorld(), packageDir = await syntheticPackage(k);
  await k.db.query(`create function brain.pause_replacement() returns trigger language plpgsql as $$ begin if new.owner='oldext' and new.version=9 then perform pg_sleep(12); end if; return new; end $$; create trigger pause_replacement before insert on brain.schema_migrations for each row execute function brain.pause_replacement()`);
  const cli = fileURLToPath(new URL('../../../apps/cli/dist/bin.js',import.meta.url));
  const child = track(spawn(process.execPath,[cli,'ext','install','--package',packageDir,'--json'],{env:k.env,stdio:['ignore','pipe','pipe']})); let output='';
  child.stdout.on('data',x=>{output+=x.toString();}); child.stderr.on('data',x=>{output+=x.toString();});
  try {
    await expect.poll(async () => (await k.db.rows("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='PgSleep') as sleeping"))[0]?.sleeping, {timeout:30000}).toBe(true);
    child.kill('SIGKILL'); await children.get(child);
    expect(child.signalCode,output).toBe('SIGKILL');
    const owner = await readFile(join(k.home,'install.lock/owner'),'utf8'); expect(owner.startsWith(`${child.pid} `)).toBe(true);
    const denied = await k.run(['ext','enable','oldext','--json']); expect(denied.body?.error?.code).toBe('EXTENSION_REPLACEMENT_REQUIRED');
    await expect.poll(async () => (await k.db.rows("select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='PgSleep') as sleeping"))[0]?.sleeping, {timeout:20000}).toBe(false);
    await k.db.query('drop trigger pause_replacement on brain.schema_migrations; drop function brain.pause_replacement()');
    const waiting = track(spawn(process.execPath,[cli,'ext','install','--package',packageDir,'--json'],{env:k.env,stdio:['ignore','pipe','pipe']})); let warning='';
    waiting.stderr.on('data',x=>{warning+=x.toString();});
    await expect.poll(() => warning,{timeout:10000}).toContain('이전 설치와 모든 자식의 공유 상태 쓰기 종료를 확인한 뒤 해당 잠금만 제거');
    expect(waiting.exitCode).toBeNull(); waiting.kill('SIGTERM'); await children.get(waiting);
    // 이전 설치와 대기 자식의 종료를 확인한 뒤 해당 잠금만 제거한다.
    expect(await readFile(join(k.home,'install.lock/owner'),'utf8')).toBe(owner); await rm(join(k.home,'install.lock'),{recursive:true});
    const other = await syntheticPackage(k,'different');
    const rejected = await k.run(['ext','install','--package',other,'--json']); expect(rejected.code).not.toBe(0);
    const resumed = await k.run(['ext','install','--package',packageDir,'--json']); expect(resumed.code,resumed.stdout+resumed.stderr).toBe(0);
    expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await children.get(child);
  }
},90000);


async function setupViaCli(k: Awaited<ReturnType<typeof world>>) {
  const { createServer, createConnection } = await import('node:net');
  const { chmod, symlink } = await import('node:fs/promises');
  const { homeResources } = await import('../../../apps/cli/dist/config/resources.js');
  const pg = (await import('pg')).default;
  const adminUrl = new URL(k.db.url); adminUrl.pathname='/postgres';
  const password = decodeURIComponent(adminUrl.password);
  if (decodeURIComponent(adminUrl.username) !== 'postgres' || !password) throw Error('전용 서버 관리자 계정이 필요합니다');
  const admin = new pg.Client({connectionString:adminUrl.toString()}); await admin.connect();
  const role = k.dir.endsWith('/garmin') ? 'brain_ext_garmin' : 'brain_ext_oldext';
  const dbName = k.options.databaseName; let renamed = false;
  const sockets = new Set<import('node:net').Socket>();
  const proxy = createServer(incoming => {
    const endpoint = new URL(k.db.url);
    const outgoing = createConnection({host:endpoint.hostname,port:Number(endpoint.port || 5432)}); sockets.add(incoming); sockets.add(outgoing);
    incoming.on('close',()=>sockets.delete(incoming)); outgoing.on('close',()=>sockets.delete(outgoing));
    incoming.on('error',()=>outgoing.destroy()); outgoing.on('error',()=>incoming.destroy()); incoming.pipe(outgoing).pipe(incoming);
  });
  const localChildren: ChildProcess[] = [];
  try {
    await admin.query("select pg_advisory_lock(hashtextextended('second-brain:legacy-pty-brain-database',0))");
    if ((await admin.query("select 1 from pg_database where datname='brain'")).rowCount) throw Error('기존 brain DB를 보존합니다');
    await admin.query(`alter database "${dbName}" rename to brain`); renamed=true; await admin.query(`comment on role "${role}" is 'second-brain extension:brain'`);
    await new Promise<void>((resolve,reject)=>{proxy.once('error',reject);proxy.listen(homeResources(k.home).port,'127.0.0.1',()=>resolve());});
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
    await writeFile(join(k.home,'.env'),`BRAIN_POSTGRES_PASSWORD=${JSON.stringify(password)}\nBRAIN_APP_PASSWORD="brain-test-app"\n`);
    await writeFile(join(k.home,'config.toml'),'schema_version=1\n[store]\nurl_env="BRAIN_DATABASE_URL"\n');
    const { postgresSecrets } = await import('../../../apps/cli/dist/config/codec.js');
    const { renderPostgresCompose } = await import('../../../apps/cli/dist/install/postgres.js');
    await postgresSecrets(k.home,homeResources(k.home).port,'BRAIN_DATABASE_URL');
    await mkdir(join(k.home,'postgres')); await writeFile(join(k.home,'postgres/compose.yaml'),renderPostgresCompose(k.home));
    await symlink(fileURLToPath(new URL('../../../',import.meta.url)),join(k.home,'app'));
    const env:NodeJS.ProcessEnv = {...withoutHarnessFolders(process.env),HOME:k.home,SECOND_BRAIN_HOME:k.home,PATH:`${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,CLAUDE_CONFIG_DIR:join(k.home,'claude'),SECOND_BRAIN_LAUNCH_AGENTS:join(k.home,'agents'),SECOND_BRAIN_LAUNCHCTL:fileURLToPath(new URL('../../../apps/cli/test/fixtures/fake-launchctl.sh',import.meta.url)),FAKE_LAUNCHCTL_DIR:join(k.home,'launchctl'),BRAIN_DATABASE_URL:`postgres://brain_app:brain-test-app@127.0.0.1:${homeResources(k.home).port}/brain`};
    delete env.DOCKER_HOST; delete env.SECOND_BRAIN_INSTALL_LOCK_OWNER; delete env.SECOND_BRAIN_STAGED_APP; delete env.SECOND_BRAIN_PREVIOUS_APP_HEAD;
    const cli=fileURLToPath(new URL('../../../apps/cli/dist/bin.js',import.meta.url));
    const ptyScript=String.raw`import os,pty,select,subprocess,sys,time,re,json,fcntl,termios,struct,signal
master,slave=pty.openpty(); fcntl.ioctl(slave,termios.TIOCSWINSZ,struct.pack('HHHH',40,500,0,0))
def session():
 os.setsid(); fcntl.ioctl(0,termios.TIOCSCTTY,0)
p=subprocess.Popen([sys.argv[1],sys.argv[2],'setup','run','--yes']+(['--json'] if sys.argv[3]=='json' else []),stdin=slave,stdout=slave,stderr=slave,env=os.environ,preexec_fn=session); os.close(slave)
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
    const ttyRun=(mode: 'correct'|'wrong'|'eof'|'json' = 'correct')=>new Promise<{code:number;answered:boolean;output:string}>((resolve,reject)=>{
      const child=track(spawn('python3',['-c',ptyScript,process.execPath,cli,mode],{env,stdio:['ignore','pipe','pipe']})); localChildren.push(child); let out='',err='';
      const timer=setTimeout(()=>child.kill('SIGTERM'),40000);
      child.stdout.on('data',b=>{out+=b.toString();});child.stderr.on('data',b=>{err+=b.toString();});
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('close',code=>{clearTimeout(timer);if(code!==0)reject(Error(err));else {try{resolve(JSON.parse(out));}catch(e){reject(e);}}});
    });
    const rows = async (sql: string) => {
      const url = new URL(adminUrl); url.pathname = '/brain';
      const client = new pg.Client({connectionString:url.toString()}); await client.connect();
      try { return (await client.query(sql)).rows; } finally { await client.end(); }
    };
    const packageFiles = async () => Promise.all(['manifest.json',...(await readdir(join(k.dir,'migrations'))).sort().map(file=>`migrations/${file}`)].map(async file => [file,createHash('sha256').update(await readFile(join(k.dir,file))).digest('hex')]));
    const before = {files:await packageFiles(),installed:await readFile(join(k.home,'installed.json'),'utf8'), ledger:await rows('select * from brain.schema_migrations order by owner,version'), gate:(await rows("select to_regclass('brain.extension_quiesce') as name"))[0]?.name, progress:await rows('select * from brain.extension_install_progress'), manifest:await readFile(join(k.dir,'manifest.json'),'utf8')};
    const first = await ttyRun(); expect(first.answered,first.output).toBe(false); expect(first.code,first.output).toBe(0);
    const again = await ttyRun(); expect(again.code,again.output).toBe(0);
    expect(JSON.parse(await readFile(join(k.home,'installed.json'),'utf8'))).toMatchObject({commit:k.build.commit,schema_version:46});
  } finally {
    for (const child of localChildren) if (child.exitCode===null && child.signalCode===null) child.kill('SIGTERM');
    const killTimer = setTimeout(()=>{for(const child of localChildren)if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL');},2000);
    try {await Promise.all(localChildren.map(child=>children.get(child)));} finally {clearTimeout(killTimer);}
    for (const socket of sockets) socket.destroy(); if (proxy.listening) await new Promise<void>(resolve=>proxy.close(()=>resolve()));
    try {if(renamed){await admin.query(`comment on role "${role}" is 'second-brain extension:${dbName}'`);await admin.query(`alter database brain rename to "${dbName}"`);}} finally {await admin.end();}
  }
}

async function realLegacyWorld(name:'garmin'|'oldext') {
  const k = await world(name), role = `brain_ext_${name}`;
  const existing = await k.db.rows(`select 1 from pg_roles where rolname='${role}'`);
  if (existing.length) throw Error('다른 DB의 확장 역할을 보존합니다');
  await k.db.query(`create role "${role}" login password '${'a'.repeat(48)}'; comment on role "${role}" is 'second-brain extension:${k.options.databaseName}'; create schema "${name}" authorization brain_owner; grant usage,create on schema "${name}" to "${role}"; delete from brain.schema_migrations where owner='${name}'`);
  expect(await runMigrations({databaseUrl:k.db.url,clock,owners:[{owner:name,directory:join(k.dir,'migrations')}]})).toMatchObject({ok:true});
  const user=randomUUID(), session=randomUUID(), message=randomUUID(), file=randomUUID(), channel=randomUUID(), conversation=randomUUID(), schedule=randomUUID(), work=randomUUID(), attempt=randomUUID();
  await k.db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',0,now());
    insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','session','${user}','test',now(),'import');
    insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${message}','${session}','message','user','synthetic',now());
    insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','sha256:${'a'.repeat(64)}',1,now());
    insert into brain.channels(id,kind,bot_ref) values ('${channel}','telegram','synthetic');
    insert into brain.channel_conversations(id,channel_id,external_ref,thread_ref) values ('${conversation}','${channel}','synthetic','thread');
    insert into brain.settings(key,value,updated_at) values ('${name}.synthetic','preserve',now());
    insert into brain.schedules(id,kind,target_kind,target_id,next_run_at,created_at,local_time,time_zone,hold_group) values ('${schedule}','${name}.synthetic','probe','synthetic',now(),now(),'09:30','UTC','extension:${name}');
    insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,completed_at,execution_class,hold_group,outcome) values ('${work}','${name}.synthetic','probe','synthetic',now(),now(),now(),'supervised','extension:${name}','succeeded');
    insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome) values ('${attempt}','${work}',now(),now(),'succeeded');
    insert into brain.schedule_successes values ('${schedule}','2026-01-02','UTC','${work}','2026-01-01T00:00:00Z');
    insert into ${name}.datasets(dataset,account,account_confirmed) values ('synthetic','account',true);
    insert into ${name}.import_batches values ('synthetic-batch','synthetic',now());
    insert into ${name}.raw_payloads values ('synthetic','synthetic-batch','account','day','synthetic-key','synthetic-endpoint',1,2,'synthetic','{\"synthetic\":true}');
    update ${name}.raw_payloads set body_raw=decode('0001ff','hex'), body_encoding='utf-8' where dataset='synthetic';
    insert into ${name}.import_mapping values ('synthetic','synthetic-table','synthetic-key','synthetic-kind','${message}','${createHash('sha256').update(Buffer.from('0001ff','hex')).digest('hex')}','synthetic-batch');
    insert into ${name}.preserved_rows(id,dataset,original_table,original_key,values_json) values ('${randomUUID()}','synthetic','synthetic-table','synthetic-key','{"synthetic":true}');
    insert into ${name}.import_provenance values ('synthetic','synthetic-table','synthetic-key','synthetic-metric','synthetic-reason');
    insert into ${name}.artifact_inventory(dataset,artifact_key,batch,category,metadata,metadata_raw) values ('synthetic','synthetic-artifact','synthetic-batch','synthetic','{\"synthetic\":true}',decode('0001ff','hex'));
    insert into ${name}.collect_state values ('synthetic','account','2020-01-01','synthetic-endpoint','synthetic-revision',1);
    insert into ${name}.normalize_items values ('synthetic','day','synthetic-key','synthetic-endpoint','synthetic-revision',1,1,true,null,2)`);
  return {...k, ids:{user,session,message,file,channel,conversation,schedule,work,attempt}};
}

const durableTables = ['datasets','import_batches','raw_payloads','import_mapping','artifact_inventory','preserved_rows'] as const;
const retiredTables = ['import_provenance','collect_state','normalize_items'] as const;
async function preserved(k: Awaited<ReturnType<typeof realLegacyWorld>>, name:'garmin'|'oldext', includeRetired = true) {
  const {ids} = k;
  const isModern = (await k.db.rows("select to_regclass('brain.schedule_occurrences') is not null as present"))[0]?.present;
  const accounting = isModern
    ? await k.db.rows(`select schedule_id,occurrence_at,time_zone,status,work_id,recorded_at from brain.schedule_occurrences where schedule_id='${ids.schedule}' order by occurrence_at`)
    : await k.db.rows(`select su.schedule_id,(su.local_date+s.local_time::time) at time zone su.time_zone as occurrence_at,su.time_zone,'done'::text as status,su.work_id,su.recorded_at from brain.schedule_successes su join brain.schedules s on s.id=su.schedule_id where su.schedule_id='${ids.schedule}'`);
  const facts = {
    accounting,
    users:await k.db.rows(`select id,name,is_self,created_at from brain.users where id='${ids.user}'`),
    sessions:await k.db.rows(`select * from brain.sessions where id='${ids.session}'`), messages:await k.db.rows(`select * from brain.messages where id='${ids.message}'`),
    files:await k.db.rows(`select * from brain.files where id='${ids.file}'`),channels:await k.db.rows(`select * from brain.channels where id='${ids.channel}'`),
    conversations:await k.db.rows(`select id,channel_id,external_ref,thread_ref from brain.channel_conversations where id='${ids.conversation}'`),
    settings:await k.db.rows(`select key,value,updated_at from brain.settings where key='${name}.synthetic'`),
    schedules:await k.db.rows(`select id,kind,target_kind,target_id,next_run_at,created_at,time_zone,hold_group from brain.schedules where id='${ids.schedule}'`),
    work:await k.db.rows(`select id,kind,target_kind,target_id,created_at,next_attempt_at,completed_at,execution_class,hold_group,outcome from brain.work_items where id='${ids.work}'`),
    attempts:await k.db.rows(`select token,work_item_id,started_at,finished_at,outcome from brain.work_attempts where token='${ids.attempt}'`),
    extension:await Promise.all([...durableTables,...(includeRetired ? retiredTables : [])].map(async table => {
      const rows = await k.db.rows(`select * from ${name}.${table} where dataset='synthetic'`);
      expect(rows,`${name}.${table} 합성 데이터`).toHaveLength(1); return rows;
    })),
  };
  return createHash('sha256').update(JSON.stringify(facts)).digest('hex');
}

it.each(['garmin','oldext'] as const)('실제 CLI setup 이후 %s 패키지를 교체해 이력과 사용자를 보존한다', async name => {
  const k = await realLegacyWorld(name), before = await preserved(k,name);
  const durableBefore = await preserved(k,name,false);
  const raw = await k.db.rows(`select encode(body_raw,'hex') as bytes,body_encoding from ${name}.raw_payloads where dataset='synthetic'`);
  expect(raw).toEqual([{bytes:'0001ff',body_encoding:'utf-8'}]);
  expect(await k.db.rows(`select content_hash from ${name}.import_mapping where dataset='synthetic'`)).toEqual([{content_hash:createHash('sha256').update(Buffer.from('0001ff','hex')).digest('hex')}]);
  const history = await k.db.rows(`select owner,version,name,checksum from brain.schema_migrations where owner='${name}' order by version`);
  expect(history).toHaveLength(8);
  await setupViaCli(k);
  expect(await preserved(k,name)).toBe(before);
  expect(await k.db.rows("select max(version)::int as version from brain.schema_migrations where owner='core'")).toEqual([{version:46}]);
  const gates = await k.db.rows('select name,owner from brain.extension_quiesce'); expect(gates).toHaveLength(1);
  expect(await k.db.rows(`select owner,version,name,checksum from brain.schema_migrations where owner='${name}' order by version`)).toEqual(history);
  const cli = await cliForWorld(k);
  const target = name === 'garmin' ? join(k.home,'plugins/garmin/package') : await syntheticPackage(cli);
  if (name === 'garmin') { await mkdir(join(k.home,'plugins/garmin'),{recursive:true}); await cp(fileURLToPath(new URL('../../../plugins/garmin/package',import.meta.url)),target,{recursive:true}); }
  const beforeRejected = {gate:await k.db.rows('select * from brain.extension_quiesce'),progress:await k.db.rows('select * from brain.extension_install_progress'),manifest:await readFile(join(k.dir,'manifest.json'),'utf8')};
  const invalid = join(k.home,'invalid-package'); await cp(target,invalid,{recursive:true});
  await writeFile(join(invalid,'digest'),`${'0'.repeat(64)}\n`);
  const rejected = await cli.run(['ext','install','--package',invalid,'--json']);
  expect(rejected.body?.error?.code,rejected.stdout+rejected.stderr).toBe('EXTENSION_INVALID');
  expect(await preserved(k,name)).toBe(before);
  expect({gate:await k.db.rows('select * from brain.extension_quiesce'),progress:await k.db.rows('select * from brain.extension_install_progress'),manifest:await readFile(join(k.dir,'manifest.json'),'utf8')}).toEqual(beforeRejected);
  expect(await k.db.rows(`select owner,version,name,checksum from brain.schema_migrations where owner='${name}' order by version`)).toEqual(history);
  const result = await cli.run(['ext','install','--package',target,'--json']);
  // 합성 home에는 실행 중인 데몬이 없어 연결 확인 뒤 예약 단계에서 멈춘다.
  if (name === 'garmin') expect(result.body?.error?.code,result.stdout+result.stderr).toBe('EXTENSION_SCHEDULER_UNAVAILABLE');
  else expect(result.code,result.stdout+result.stderr).toBe(0);
  const after = await k.db.rows(`select owner,version,name,checksum from brain.schema_migrations where owner='${name}' order by version`);
  expect(after.slice(0,8)).toEqual(history);
  expect(after.map(row=>row.version)).toEqual(Array.from({length:name==='garmin'?18:9},(_,i)=>i+1));
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual([]);
  const progress = await k.db.rows(`select progress from brain.extension_install_progress where name='${name}'`);
  expect(progress[0]?.progress).not.toHaveProperty('replacement'); expect(progress[0]?.progress).not.toHaveProperty('transition');
  expect(await preserved(k,name,name !== 'garmin')).toBe(name === 'garmin' ? durableBefore : before);
  if (name === 'garmin') for (const table of retiredTables) {
    expect((await k.db.rows(`select to_regclass('garmin.${table}') as relation`))[0]?.relation).toBeNull();
  }
  expect(await k.db.rows(`select enabled from brain.extensions where name='${name}'`)).toEqual([{enabled:false}]);
  expect(await k.db.rows(`select name from brain.work_hold_groups where name='extension:${name}'`)).toEqual([{name:`extension:${name}`}]);
  const enabled = await cli.run(['ext','enable',name,'--json']); expect(enabled.code,enabled.stdout+enabled.stderr).toBe(0);
},180000);

it('은퇴 키가 없어도 호환 범위가 없는 옛 manifest는 허용된 legacy에서 교체 대기로 남긴다', async () => {
  const k = await world('oldext'); const file = join(k.dir,'manifest.json');
  const manifest = JSON.parse(await readFile(file,'utf8')); for (const item of manifest.work) delete item.verification_snapshot;
  await writeFile(file,JSON.stringify(manifest));
  const before = await k.db.rows("select * from brain.schema_migrations where owner='oldext' order by version");
  expect(await k.install()).toMatchObject({ok:true});
  expect(await k.db.rows("select * from brain.schema_migrations where owner='oldext' order by version")).toEqual(before);
  expect((await k.db.rows("select progress from brain.extension_install_progress where name='oldext'"))[0]?.progress).toMatchObject({replacement:{fromVersion:'1.0.0'}});
});

it('옛 manifest와 registry의 버전이 다르면 확인 전 거부한다', async () => {
  const k = await world('oldext'); await k.db.query("update brain.extensions set version='1.0.1' where name='oldext'"); let called = false;
  expect(await installPostgres({...k.options,observeOffline:async r=>{called=true;return r.verificationId;}})).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(called).toBe(false); await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'});
});

it.each(['registry','checksum'] as const)('교체 대기 cross-commit 확인 중 %s 변경은 첫 변경 전에 거부한다', async change => {
  const k = await world('oldext'); expect(await k.install()).toMatchObject({ok:true});
  await writeFile(join(k.home,'installed.json'),JSON.stringify({...k.installed,schema_version:CORE_SCHEMA_VERSION}));
  const gate = await k.db.rows('select * from brain.extension_quiesce'), progress = await k.db.rows('select * from brain.extension_install_progress');
  const ledger = await k.db.rows('select * from brain.schema_migrations order by owner,version');
  const outcome = await installPostgres({...k.options,observeOffline:async r=>{
    if (change === 'registry') await k.db.query("update brain.extensions set version='1.0.1' where name='oldext'");
    else await writeFile(join(k.dir,'migrations/0001_tracer.sql'),'changed');
    return r.verificationId;
  }});
  expect(outcome).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await k.db.rows('select * from brain.extension_quiesce')).toEqual(gate);
  expect(await k.db.rows('select * from brain.extension_install_progress')).toEqual(progress);
  expect(await k.db.rows('select * from brain.schema_migrations order by owner,version')).toEqual(ledger);
  await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'});
});

it('호환 범위가 없는 현행 문법 manifest는 명시 허용 시에만 교체 대상으로 판독한다', async () => {
  const k = await world('oldext'); const file = join(k.dir,'manifest.json');
  const value = JSON.parse(await readFile(file,'utf8')); for (const entry of value.work) delete entry.verification_snapshot;
  await writeFile(file,JSON.stringify(value));
  const {installedExtensionMigrations} = await import('../../../apps/cli/src/runtime/extensions.js');
  expect(await installedExtensionMigrations(k.home,['oldext'],'0.1.0',new Set(['oldext']))).toMatchObject([{owner:'oldext',replacement:true,version:'1.0.0'}]);
  await expect(installedExtensionMigrations(k.home,['oldext'],'0.1.0')).rejects.toThrow();
  value.files=['manifest.json']; value.core_compat={min:'999.0.0',max_exclusive:'1000.0.0'}; value.plugin_version='1.0.0';
  await writeFile(file,JSON.stringify(value));
  await expect(installedExtensionMigrations(k.home,['oldext'],'0.1.0',new Set(['oldext']))).rejects.toThrow();
});

it('PostgreSQL 공개 상태는 교체 여부를 표시하되 gate owner를 노출하지 않는다', async () => {
  const k = await world('oldext'); expect(await k.install()).toMatchObject({ok:true});
  const store = postgresStore({databaseUrl:k.db.appUrl});
  try {
    const gate = await store.readExtensionQuiesce('oldext'); if(!gate.ok || !gate.owner) throw Error('missing gate');
    const status = await store.getExtensionPublicStatus('oldext');
    expect(status).toMatchObject({ok:true,status:{replacementRequired:true}});
    expect(JSON.stringify(status)).not.toContain(gate.owner);
  } finally {await store.close();}
});


it('offline 확인 중 삽입된 유효 진행 기록을 보존하고 설치를 거부한다', async () => {
  const k = await world('oldext');
  const ledger = await k.db.rows('select * from brain.schema_migrations order by owner,version');
  const gate = await k.db.rows("select to_regclass('brain.extension_quiesce') as name");
  const progress = {name:'oldext',packageDigest:'a'.repeat(64),result:null,failedStage:null,lastFailure:null,stages:{},authWorkId:null,scheduleIds:[]};
  const result = await installPostgres({...k.options,observeOffline:async r => {
    await k.db.query(`insert into brain.extension_install_progress values ('oldext',1,'${JSON.stringify(progress)}'::jsonb)`);
    return r.verificationId;
  }});
  expect(result).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await k.db.rows('select * from brain.schema_migrations order by owner,version')).toEqual(ledger);
  expect(await k.db.rows("select to_regclass('brain.extension_quiesce') as name")).toEqual(gate);
  expect(await k.db.rows('select progress from brain.extension_install_progress')).toEqual([{progress}]);
  await expect(readFile(join(k.home,'run/bootstrap-extension-migrations.json'))).rejects.toMatchObject({code:'ENOENT'});
});

it.each([11,15])('진행 표가 없는 schema %s에서 교체 대기를 생성한다', async schema => {
  const k = await world('oldext',schema);
  expect((await k.db.rows("select to_regclass('brain.extension_install_progress') as table_name"))[0]?.table_name).toBeNull();
  expect(await k.install()).toMatchObject({ok:true});
  expect((await k.db.rows("select progress from brain.extension_install_progress where name='oldext'"))[0]?.progress).toMatchObject({replacement:{fromVersion:'1.0.0'}});
});

it('schema 16에서 진행 표가 없으면 DDL 전에 거부한다', async () => {
  const k = await world('oldext',16); await k.db.query('drop table brain.extension_install_progress');
  const ledger = await k.db.rows('select * from brain.schema_migrations order by owner,version');
  expect(await k.install()).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await k.db.rows('select * from brain.schema_migrations order by owner,version')).toEqual(ledger);
  expect((await k.db.rows("select to_regclass('brain.extension_install_progress') as table_name"))[0]?.table_name).toBeNull();
});


it.each(['mixed','two-retired'] as const)('복수 확장 %s에서 두 번째 저장 실패 후 같은 owner로 재개한다', async mode => {
  const k = await world('oldext');
  const other = 'garmin', dir = join(k.home,'extensions',other);
  await cp(k.dir,dir,{recursive:true});
  for (const file of await readdir(join(dir,'migrations'))) {
    const path = join(dir,'migrations',file); const sql = (await readFile(path,'utf8')).replaceAll('oldext',other);
    await writeFile(path,sql);
    const hash = createHash('sha256').update(sql).digest('hex');
    await k.db.query(`insert into brain.schema_migrations(owner,version,name,checksum,applied_at) values ('${other}',${Number(file.slice(0,4))},'${file}','${hash}',now())`);
  }
  const manifestPath = join(dir,'manifest.json'); const manifest = JSON.parse((await readFile(manifestPath,'utf8')).replaceAll('oldext',other));
  if (mode === 'mixed') { for (const work of manifest.work) delete work.verification_snapshot; manifest.core_compat={min:'0.0.0',max_exclusive:'999.0.0'}; manifest.files=['manifest.json']; manifest.plugin_version='1.0.0'; }
  await writeFile(manifestPath,JSON.stringify(manifest));
  await k.db.query(`insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('${other}','1.0.0',now(),false,now()); insert into brain.work_hold_groups values ('extension:${other}',now())`);
  const history = await k.db.rows("select * from brain.schema_migrations where owner in ('oldext','garmin') order by owner,version");
  if (mode === 'two-retired') {
    await k.db.query(`create function brain.reject_second_progress() returns trigger language plpgsql as $$ begin if new.name='oldext' then raise exception 'injected'; end if; return new; end $$; create trigger reject_second_progress before insert on brain.extension_install_progress for each row execute function brain.reject_second_progress()`);
    expect(await k.install()).toMatchObject({ok:false});
    const gates = await k.db.rows('select * from brain.extension_quiesce order by name'); expect(gates).toHaveLength(2);
    const saved = await k.db.rows('select * from brain.extension_install_progress'); expect(saved).toHaveLength(1);
    await k.db.query('drop trigger reject_second_progress on brain.extension_install_progress; drop function brain.reject_second_progress()');
    expect(await k.install()).toMatchObject({ok:true});
    expect(await k.db.rows('select * from brain.extension_quiesce order by name')).toEqual(gates);
    const resumed = await k.db.rows('select * from brain.extension_install_progress order by name');
    expect(resumed[0]).toEqual(saved[0]);
    for (const row of resumed) expect(row.progress).toMatchObject({replacement:{owner:gates.find(gate=>gate.name===row.name)?.owner}});
  } else {
    expect(await k.install()).toMatchObject({ok:true});
    expect(await k.db.rows('select name from brain.extension_quiesce order by name')).toEqual([{name:'oldext'}]);
    expect(await k.db.rows('select name from brain.extension_install_progress order by name')).toEqual([{name:'oldext'}]);
  }
  expect(await k.db.rows("select * from brain.schema_migrations where owner in ('oldext','garmin') order by owner,version")).toEqual(history);
});
