import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { extHome } from './ext-fixture.js';
const tty = vi.hoisted(() => ({ enabled: false, cancelOnManifest: false }));
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, lstat: async (...args: Parameters<typeof actual.lstat>) => { const result = await actual.lstat(...args); if (tty.cancelOnManifest && String(args[0]).endsWith('/manifest.json')) { tty.cancelOnManifest = false; const listener = process.listeners('SIGINT').at(-1); if (!listener) throw Error('missing login signal handler'); listener('SIGINT'); } return result; }, open: (...args: Parameters<typeof actual.open>) => tty.enabled && args[0] === '/dev/tty' ? Promise.resolve({ close: async () => {} }) : actual.open(...args) };
});
import { extLoginCommand, launchTerminal } from '../src/commands/ext-login.js';

describe('terminal extension login', () => {
  it('rejects non-terminal input before opening the store', async () => {
    expect(extLoginCommand.standalone).toBe(true);
    if (extLoginCommand.standalone !== true) throw new Error('wrong command');
    const result = await extLoginCommand.run({ args: ['garmin'], env: {}, options: {}, clock: {} as never, stdin: async () => '', recordHookArrival: async () => {} });
    expect(result).toMatchObject({ ok: false, code: 'LOGIN_REQUIRED' });
  });
  it('reports a spawn failure with a fixed unavailable code', async () => {
    expect(await launchTerminal('/not-present/synthetic-python', '/not-present/entry', {}, [])).toEqual({ status: null, code: 'AUTH_UNAVAILABLE' });
  });
  it('gives SIGINT precedence over arbitrary stderr', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-signal-'));
    const entry = join(dir, 'entry.mjs');
    try {
      await writeFile(entry, "console.error('synthetic private diagnostic'); process.kill(process.pid, 'SIGINT');\n");
      expect(await launchTerminal(process.execPath, entry, {}, [])).toEqual({ status: null, code: 'AUTH_CANCELLED' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('accepts only a declared final error code from a child', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'login-test-'));
    const entry = join(dir, 'entry.mjs');
    try {
      await writeFile(entry, "process.exit(0);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toMatchObject({ status: 0 });
      await writeFile(entry, "console.error('RATE_LIMITED'); process.exit(1);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toEqual({ status: 1, code: 'RATE_LIMITED' });
      await writeFile(entry, "console.error('private response'); process.exit(1);\n");
      expect(await launchTerminal(process.execPath, entry, {}, ['RATE_LIMITED'])).toEqual({ status: 1, code: 'LOGIN_REQUIRED' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

it('terminal login requires self and passes scope-aware snapshot to the child', async () => {
  const { mkdir, readFile, access } = await import('node:fs/promises');
  const fixture = await extHome(), directory = join(fixture.home, 'extensions', 'testext');
  const streams = [process.stdin, process.stdout, process.stderr];
  const descriptors = streams.map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ name: 'testext', version: '1', core: 1, abi: 1, migrations: 'migrations', connection_check: { runtime: 'node', entry: 'check.mjs' }, auth: { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'login.mjs' }, settings: [{ key: 'testext.global', type: 'string', required: ['auth'], scope: 'global' }] }));
    await writeFile(join(directory, 'login.mjs'), "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.BRAIN_EXTENSION_HOME+'/login-snapshot',process.env.BRAIN_SETTINGS_SNAPSHOT);\n");
    await fixture.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','1',now(),true,now()); insert into brain.settings(user_id,key,value,updated_at) values (null,'testext.global','global',now()),((select id from brain.users where is_self=1),'testext.global','user',now())");
    const selfId = (await fixture.db.rows('select id from brain.users where is_self=1'))[0]!.id;
    await fixture.db.query('update brain.users set is_self=0 where is_self=1');
    tty.enabled = true; for (const stream of streams) Object.defineProperty(stream, 'isTTY', { configurable: true, value: true });
    if (!extLoginCommand.standalone) throw Error('wrong command');
    const context = { args: ['testext'], env: fixture.env, options: {}, clock: {} as never, stdin: async () => '', recordHookArrival: async () => {} };
    expect(await extLoginCommand.run(context)).toMatchObject({ ok: false, code: 'USER_MISSING' });
    expect(await access(join(directory, 'login-snapshot')).then(() => true, () => false)).toBe(false);
    const gateOwner = '12345678-1234-1234-1234-123456789abc';
    await fixture.db.query(`insert into brain.extension_quiesce(name,owner,started_at) values ('testext','${gateOwner}',now())`);
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'DB_LOCKED',message:expect.stringContaining('중단된 확장 설치')});
    expect(await access(join(directory, 'login-snapshot')).then(() => true, () => false)).toBe(false);
    await fixture.db.query("delete from brain.extension_quiesce where name='testext'");
    const progress = {name:'testext',packageDigest:'a'.repeat(64),result:null,failedStage:null,lastFailure:null,stages:{},authWorkId:null,scheduleIds:[],replacement:{owner:gateOwner,fromVersion:'1',at:'2026-10-29T00:00:00.000Z'}};
    await fixture.db.query(`insert into brain.extension_install_progress(name,revision,progress) values ('testext',1,'${JSON.stringify(progress)}'::jsonb)`);
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'EXTENSION_REPLACEMENT_REQUIRED'});
    await fixture.db.query("update brain.extension_install_progress set progress=jsonb_set(progress - 'replacement', '{unknown}', 'true'::jsonb) where name='testext'");
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'USER_MISSING'});
    await fixture.db.query(`update brain.users set is_self=1 where id='${selfId}'`);
    expect(await extLoginCommand.run(context)).toMatchObject({ ok: true });
    expect(JSON.parse(await readFile(join(directory, 'login-snapshot'), 'utf8'))).toMatchObject({ user_id: selfId, values: { 'testext.global': 'global' } });
  } finally {
    tty.enabled = false;
    streams.forEach((stream, index) => { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(stream, 'isTTY', descriptor); else Reflect.deleteProperty(stream, 'isTTY'); });
    await fixture.cleanup();
  }
}, 60000);

it('부모 PID에만 전달된 SIGINT를 자식에 전달하고 자식 종료를 기다린다', async () => {
  const { spawn } = await import('node:child_process');
  const { readFile, access } = await import('node:fs/promises');
  const { fileURLToPath, pathToFileURL } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'login-parent-signal-'));
  let parent: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  try {
    const entry = join(dir, 'child.mjs'), ready = join(dir, 'ready'), stopped = join(dir, 'stopped');
    await writeFile(entry, `import {writeFileSync} from 'node:fs'; process.on('SIGINT',()=>{writeFileSync(${JSON.stringify(stopped)},'done');process.exit(0)}); writeFileSync(${JSON.stringify(ready)},'ready'); setInterval(()=>{},1000);`);
    const compiled = pathToFileURL(fileURLToPath(new URL('../dist/commands/ext-login.js', import.meta.url))).href;
    const script = `import {launchTerminal} from ${JSON.stringify(compiled)};const result=await launchTerminal(process.execPath,${JSON.stringify(entry)},process.env,[]);console.log(JSON.stringify(result));`;
    parent = spawn(process.execPath, ['--input-type=module','-e',script], {stdio:['ignore','pipe','pipe'], detached:true});
    const owned = parent;
    closed = new Promise((resolve, reject) => { owned.once('error', reject); owned.once('close', resolve); });
    let output = ''; parent.stdout!.on('data', chunk => { output += String(chunk); });
    await Promise.race([expect.poll(async () => access(ready).then(() => true, () => false), { timeout: 10000 }).toBe(true), closed.then(code => { throw Error(`parent exited before ready: ${code}`); })]);
    parent.kill('SIGINT');
    expect(await closed).toBe(0);
    expect(await readFile(stopped, 'utf8')).toBe('done');
    expect(JSON.parse(output)).toEqual({status:null,code:'AUTH_CANCELLED'});
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    try { await closed; } finally { await rm(dir, {recursive:true,force:true}); }
  }
}, 30000);

it('기존 인증 성공 또는 connected 상태에서 거부와 실행 장애가 설치 기록을 덮지 않는다', async () => {
  const { mkdir, readFile } = await import('node:fs/promises');
  const fixture = await extHome(), directory = join(fixture.home, 'extensions', 'testext');
  const streams = [process.stdin, process.stdout, process.stderr];
  const descriptors = streams.map(stream => Object.getOwnPropertyDescriptor(stream, 'isTTY'));
  try {
    await mkdir(directory, {recursive:true});
    const manifest = { name:'testext', version:'1', core:1, abi:1, migrations:'migrations', connection_check:{runtime:'node',entry:'check.mjs'}, auth:{kind:'testext.login',execution:'supervised',runtime:'node',entry:'login.mjs',probe_on_install:true}, error_codes:['GARMIN_BOUND_LOGIN_REFUSED'] };
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(directory,'login.mjs'),"console.error('GARMIN_BOUND_LOGIN_REFUSED');process.exit(1);\n");
    await fixture.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at,connection_status,connection_checked_at) values ('testext','1',now(),true,now(),'connected',now())");
    const progress = {name:'testext',packageDigest:'a'.repeat(64),result:'installed',failedStage:null,lastFailure:null,stages:{login:{status:'succeeded',code:null,at:'2026-10-29T00:00:00.000Z'}},authWorkId:null,scheduleIds:[]};
    await fixture.db.query(`insert into brain.extension_install_progress(name,revision,progress) values ('testext',1,'${JSON.stringify(progress)}'::jsonb)`);
    tty.enabled = true; for (const stream of streams) Object.defineProperty(stream,'isTTY',{configurable:true,value:true});
    if (!extLoginCommand.standalone) throw Error('wrong command');
    const context = {args:['testext'],env:fixture.env,options:{},clock:{} as never,stdin:async()=>'',recordHookArrival:async()=>{}};
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'GARMIN_BOUND_LOGIN_REFUSED'});
    expect((await fixture.db.rows("select progress from brain.extension_install_progress where name='testext'"))[0]!.progress).toEqual(progress);
    manifest.auth.runtime = 'python';
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'AUTH_UNAVAILABLE'});
    expect((await fixture.db.rows("select progress from brain.extension_install_progress where name='testext'"))[0]!.progress).toEqual(progress);
    const pending = {...progress, result:'login_required', stages:{login:{status:'pending',code:'LOGIN_REQUIRED',at:'2026-10-29T00:00:00.000Z'}}};
    await fixture.db.query(`update brain.extension_install_progress set progress='${JSON.stringify(pending)}'::jsonb where name='testext'`);
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'AUTH_UNAVAILABLE'});
    expect((await fixture.db.rows("select progress from brain.extension_install_progress where name='testext'"))[0]!.progress).toEqual(pending);
    await fixture.db.query("update brain.extensions set connection_status=null,connection_checked_at=null where name='testext'");
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'AUTH_UNAVAILABLE'});
    expect((await fixture.db.rows("select progress from brain.extension_install_progress where name='testext'"))[0]!.progress).toMatchObject({result:'failed',stages:{login:{status:'failed',code:'AUTH_UNAVAILABLE'}}});
    expect(await readFile(join(directory,'manifest.json'),'utf8')).toContain('python');
    // The second command is cancelled before its terminal child exists; the
    // token from the previous successful login must still be probed on resume.
    manifest.auth.runtime = 'node';
    await writeFile(join(directory,'manifest.json'),JSON.stringify(manifest));
    await writeFile(join(directory,'login.mjs'),"import {writeFileSync} from 'node:fs';writeFileSync(process.env.BRAIN_EXTENSION_HOME+'/unexpected-child','started');\n");
    const verifyPending = {...progress, result:null, failedStage:null, stages:{login:{status:'pending',code:'TOKEN_VERIFY_PENDING',at:'2026-10-29T00:00:00.000Z'}}};
    await fixture.db.query(`update brain.extension_install_progress set progress='${JSON.stringify(verifyPending)}'::jsonb where name='testext'`);
    const before = await fixture.db.rows("select revision,progress from brain.extension_install_progress where name='testext'");
    tty.cancelOnManifest = true;
    expect(await extLoginCommand.run(context)).toMatchObject({ok:false,code:'AUTH_CANCELLED'});
    expect((await fixture.db.rows("select revision,progress from brain.extension_install_progress where name='testext'"))).toEqual(before);
    const { access } = await import('node:fs/promises');
    expect(await access(join(directory,'unexpected-child')).then(() => true, () => false)).toBe(false);

  } finally {
    tty.enabled = false; tty.cancelOnManifest = false;
    streams.forEach((stream,index) => { const descriptor=descriptors[index]; if(descriptor) Object.defineProperty(stream,'isTTY',descriptor); else Reflect.deleteProperty(stream,'isTTY'); });
    await fixture.cleanup();
  }
}, 60000);

it('게시된 자식 종료 뒤 저널 기록과 잠금 반환까지 실제 SIGINT를 보류한다', async () => {
  const { spawn } = await import('node:child_process');
  const { access, readFile } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'login-journal-signal-'));
  let parent: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  try {
    const entry = join(dir, 'auth.mjs'), ready = join(dir, 'child-closed'), release = join(dir, 'release'), journal = join(dir, 'journal');
    await writeFile(entry, "console.error('GARMIN_TOKEN_PUBLISHED'); process.exit(0);\n");
    const compiled = pathToFileURL(fileURLToPath(new URL('../dist/commands/ext-login.js', import.meta.url))).href;
    const script = `import {withLoginSignalBoundary,launchTerminal} from ${JSON.stringify(compiled)};import {writeFile,access} from 'node:fs/promises';const result=await withLoginSignalBoundary(async control=>{control.started();const result=await launchTerminal(process.execPath,${JSON.stringify(entry)},process.env,[],{protectedPublication:true});await writeFile(${JSON.stringify(ready)},'closed');for(;;){try{await access(${JSON.stringify(release)});break}catch{await new Promise(r=>setTimeout(r,20))}}await writeFile(${JSON.stringify(journal)},'TOKEN_VERIFY_PENDING');return result});console.log(JSON.stringify(result));`;
    parent = spawn(process.execPath, ['--input-type=module','-e',script], {stdio:['ignore','pipe','pipe'], detached:true});
    const owned = parent;
    closed = new Promise((resolve,reject) => { owned.once('error',reject); owned.once('close',resolve); });
    let output = ''; parent.stdout!.on('data', chunk => { output += String(chunk); });
    await Promise.race([expect.poll(async () => access(ready).then(() => true, () => false), {timeout:10000}).toBe(true), closed.then(code => {throw Error(`early exit ${code}`);})]);
    parent.kill('SIGINT');
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(parent.exitCode).toBeNull();
    expect(parent.signalCode).toBeNull();
    await writeFile(release,'continue');
    expect(await closed).toBe(0);
    expect(await readFile(journal,'utf8')).toBe('TOKEN_VERIFY_PENDING');
    expect(JSON.parse(output)).toMatchObject({status:0});
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    try { await closed; } finally { await rm(dir,{recursive:true,force:true}); }
  }
}, 30000);

it('일반 인증 자식이 SIGINT와 SIGTERM을 무시하면 강제 종료 후 반환한다', async () => {
  const { spawn } = await import('node:child_process');
  const { access } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(), 'login-unresponsive-'));
  let parent: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  try {
    const entry = join(dir,'auth.mjs'), ready = join(dir,'ready');
    await writeFile(entry, `import {writeFileSync} from 'node:fs';process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`);
    const compiled = pathToFileURL(fileURLToPath(new URL('../dist/commands/ext-login.js', import.meta.url))).href;
    const script = `import {launchTerminal} from ${JSON.stringify(compiled)};console.log(JSON.stringify(await launchTerminal(process.execPath,${JSON.stringify(entry)},process.env,[])));`;
    parent = spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe'],detached:true});
    const owned = parent; closed = new Promise((resolve,reject) => {owned.once('error',reject);owned.once('close',resolve);});
    let output = ''; parent.stdout!.on('data',chunk => {output += String(chunk);});
    await Promise.race([expect.poll(async () => access(ready).then(() => true, () => false),{timeout:10000}).toBe(true),closed.then(code => {throw Error(`early exit ${code}`);})]);
    parent.kill('SIGINT');
    expect(await closed).toBe(0);
    expect(JSON.parse(output)).toEqual({status:null,code:'AUTH_CANCELLED'});
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    try { await closed; } finally { await rm(dir,{recursive:true,force:true}); }
  }
},30000);

it('확장 설치 잠금 대기의 SIGINT가 자식 실행 전에 대기를 취소한다', async () => {
  const { spawn } = await import('node:child_process');
  const { access } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const { withExtensionInstallLock } = await import('second_brain/postgres');
  const fixture = await extHome(), dir = await mkdtemp(join(tmpdir(), 'login-lock-cancel-'));
  let release!: () => void, acquired!: () => void;
  const holding = new Promise<void>(resolve => { acquired = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const holder = withExtensionInstallLock(fixture.db.appUrl, 'testext', async () => { acquired(); await gate; });
  let parent: ReturnType<typeof spawn> | undefined, closed: Promise<number | null> | undefined;
  try {
    await holding;
    const ready = join(dir,'ready'), ran = join(dir,'ran');
    const compiled = pathToFileURL(fileURLToPath(new URL('../dist/commands/ext-login.js', import.meta.url))).href;
    const lock = pathToFileURL(fileURLToPath(new URL('../../../packages/postgres/dist/extension-install-lock.js',import.meta.url))).href;
    const script = `import {withLoginSignalBoundary} from ${JSON.stringify(compiled)};import {withExtensionInstallLock} from ${JSON.stringify(lock)};import {writeFile} from 'node:fs/promises';try { await withLoginSignalBoundary(async control=>{await writeFile(${JSON.stringify(ready)},'ready');return withExtensionInstallLock(process.env.TEST_DATABASE_URL,'testext',async()=>{await writeFile(${JSON.stringify(ran)},'ran')},control.signal)});console.log('unexpected'); } catch(e) {console.log(e.code)}`;
    parent = spawn(process.execPath,['--input-type=module','-e',script],{env:{...process.env,TEST_DATABASE_URL:fixture.db.appUrl},stdio:['ignore','pipe','pipe'],detached:true});
    const owned = parent; closed = new Promise((resolve,reject) => {owned.once('error',reject);owned.once('close',resolve);});
    let output = ''; parent.stdout!.on('data',chunk => {output += String(chunk);});
    await Promise.race([expect.poll(async () => access(ready).then(() => true, () => false),{timeout:10000}).toBe(true),closed.then(code => {throw Error(`early exit ${code}`);})]);
    parent.kill('SIGINT');
    expect(await Promise.race([closed,new Promise(resolve => setTimeout(() => resolve('timeout'),5000))])).toBe(0);
    expect(output.trim()).toBe('EXTENSION_INSTALL_CANCELLED');
    expect(await access(ran).then(() => true, () => false)).toBe(false);
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    release();
    try { await closed; await holder; } finally { await rm(dir,{recursive:true,force:true}); await fixture.cleanup(); }
  }
},60000);

it('일반 인증 자식 종료 뒤 stderr helper가 남아도 취소가 끝난다', async () => {
  const { spawn } = await import('node:child_process');
  const { access, readFile } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(),'login-helper-pipe-'));
  let parent: ReturnType<typeof spawn> | undefined, closed: Promise<number | null> | undefined, helperPid = 0;
  try {
    const entry = join(dir,'entry.mjs'), ready = join(dir,'ready');
    await writeFile(entry, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const helper=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','ignore','inherit']});process.on('SIGINT',()=>process.exit(0));writeFileSync(${JSON.stringify(ready)},String(helper.pid));setInterval(()=>{},1000);`);
    const compiled = pathToFileURL(fileURLToPath(new URL('../dist/commands/ext-login.js', import.meta.url))).href;
    const script = `import {launchTerminal} from ${JSON.stringify(compiled)};console.log(JSON.stringify(await launchTerminal(process.execPath,${JSON.stringify(entry)},process.env,[])));`;
    parent = spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe'],detached:true});
    const owned = parent; closed = new Promise((resolve,reject) => {owned.once('error',reject);owned.once('close',resolve);});
    let output = ''; parent.stdout!.on('data',chunk => {output += String(chunk);});
    await Promise.race([expect.poll(async () => access(ready).then(() => true, () => false),{timeout:10000}).toBe(true),closed.then(code => {throw Error(`early exit ${code}`);})]);
    helperPid = Number(await readFile(ready,'utf8'));
    expect(helperPid).toBeGreaterThan(0);
    parent.kill('SIGINT');
    expect(await Promise.race([closed,new Promise(resolve => setTimeout(() => resolve('timeout'),4000))])).toBe(0);
    expect(JSON.parse(output)).toEqual({status:null,code:'AUTH_CANCELLED'});
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    try {
      await closed;
      if (helperPid) await expect.poll(() => { try { process.kill(helperPid,0); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw error; } }, {timeout:10000}).toBe(false);
    } finally { await rm(dir,{recursive:true,force:true}); }
  }
},30000);

it('자식 시작 전 설정 대기 중 SIGINT는 취소 상태를 남기고 실행을 막는다', async () => {
  const { spawn } = await import('node:child_process');
  const { access } = await import('node:fs/promises');
  const { pathToFileURL, fileURLToPath } = await import('node:url');
  const dir = await mkdtemp(join(tmpdir(),'login-setup-cancel-'));
  let parent: ReturnType<typeof spawn> | undefined, closed: Promise<number | null> | undefined;
  try {
    const ready = join(dir,'ready'), ran = join(dir,'ran');
    const compiled = pathToFileURL(fileURLToPath(new URL('../dist/commands/ext-login.js', import.meta.url))).href;
    const script = `import {withLoginSignalBoundary} from ${JSON.stringify(compiled)};import {writeFile} from 'node:fs/promises';const result=await withLoginSignalBoundary(async control=>{await writeFile(${JSON.stringify(ready)},'ready');await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('signal timeout')),10000);const done=()=>{clearTimeout(timer);resolve()};if(control.signal.aborted)done();else control.signal.addEventListener('abort',done,{once:true})});if(control.signal.aborted)return 'AUTH_CANCELLED';control.started();await writeFile(${JSON.stringify(ran)},'ran');return 'started'});console.log(result)`;
    parent = spawn(process.execPath,['--input-type=module','-e',script],{stdio:['ignore','pipe','pipe'],detached:true});
    const owned = parent; closed = new Promise((resolve,reject) => {owned.once('error',reject);owned.once('close',resolve);});
    let output = ''; parent.stdout!.on('data',chunk => {output += String(chunk);});
    await Promise.race([expect.poll(async () => access(ready).then(() => true, () => false),{timeout:10000}).toBe(true),closed.then(code => {throw Error(`early exit ${code}`);})]);
    parent.kill('SIGINT');
    expect(await closed).toBe(0);
    expect(output.trim()).toBe('AUTH_CANCELLED');
    expect(await access(ran).then(() => true, () => false)).toBe(false);
  } finally {
    if (parent?.pid) { try { process.kill(-parent.pid,'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    try { await closed; } finally { await rm(dir,{recursive:true,force:true}); }
  }
},30000);
