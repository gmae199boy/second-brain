import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn, execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const fixtures = fileURLToPath(new URL('./fixtures/garmin-official-auth/', import.meta.url));
const cli = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const secret = /synthetic-(?:email|password|bad-password|mfa|private-error|token|refresh|client)/;
const tokenValue = JSON.stringify({di_token:'synthetic-token',di_refresh_token:'synthetic-refresh',di_client_id:'synthetic-client'});

async function tty(env: NodeJS.ProcessEnv, mode: string) {
  return await new Promise<{ code: number | null; output: string; body: any }>((resolve, reject) => {
    const child = spawn('python3', [join(fixtures, 'terminal_driver.py'), mode, process.execPath, cli], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', chunk => { output += String(chunk); }); child.stderr.on('data', chunk => { output += String(chunk); });
    child.once('error', reject); child.once('close', code => {
      // Prompts from getpass can share a line with the CLI's final JSON.
      // Find a complete envelope without logging the terminal contents.
      let body: any;
      for (const line of output.split(/\r?\n/).reverse()) {
        for (let offset = line.indexOf('{'); offset >= 0; offset = line.indexOf('{', offset + 1)) {
          try { const value = JSON.parse(line.slice(offset)); if (typeof value?.ok === 'boolean') { body = value; break; } } catch { /* not an envelope */ }
        }
        if (body) break;
      }
      resolve({ code, output, body });
    });
  });
}

async function ownRunningDaemon(controller: AbortController, running: Promise<unknown>, ready: () => Promise<void>) {
  try { await ready(); }
  catch (error) {
    controller.abort();
    try { await running; } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'daemon setup and cleanup failed'); }
    throw error;
  }
  return async () => { controller.abort(); await running; };
}

async function daemonFor(fixture: Awaited<ReturnType<typeof extHome>>) {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const controller = new AbortController();
  const running = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
  return ownRunningDaemon(controller, running, async () => {
    await expect.poll(async () => readFile(join(fixture.home, 'run/supervisor-ready.json'), 'utf8').then(() => true, () => false), { timeout: 15000 }).toBe(true);
  });
}

async function cleanupOwned(stop: (() => Promise<void>) | undefined, fixture: Awaited<ReturnType<typeof extHome>>, archive?: string) {
  const errors: unknown[] = [];
  try { await stop?.(); } catch (error) { errors.push(error); }
  try { await fixture.cleanup(); } catch (error) { errors.push(error); }
  if (archive) try { await rm(archive, {recursive:true,force:true}); } catch (error) { errors.push(error); }
  if (errors.length) throw new AggregateError(errors, 'owned fixture cleanup failed');
}

async function noAuthWork(fixture: Awaited<ReturnType<typeof extHome>>) {
  expect(await fixture.db.rows("select id from brain.work_items where kind='garmin.auth'")).toEqual([]);
}

async function audit(fixture: Awaited<ReturnType<typeof extHome>>, surfaces: string[]) {
  const directory = join(fixture.home, 'extensions/garmin');
  const raw = await readFile(join(directory, 'synthetic-auth-audit.jsonl'), 'utf8');
  const events = raw.trim().split('\n').map(line => JSON.parse(line));
  expect(events.some(event => event.event === 'network-guard-active')).toBe(true);
  const guards = events.filter(event => event.event === 'network-guard-active').length;
  expect(events.filter(event => event.event === 'network-guard-confirmed')).toHaveLength(guards);
  expect(events.filter(event => event.event === 'native-guard-confirmed')).toHaveLength(guards);
  expect(events.filter(event => event.event === 'network-blocked')).toHaveLength(2 * guards);
  const probes = events.filter(event => event.event === 'probe');
  expect(probes.length).toBeGreaterThan(0);
  expect(probes.every(event => event.inline === true)).toBe(true);
  const progress = await fixture.db.rows("select progress from brain.extension_install_progress where name='garmin'");
  const logDir = join(fixture.home, 'log');
  const logFiles = await readdir(logDir).catch(() => [] as string[]);
  expect(logFiles).toContain('daemon.log');
  const logs = await Promise.all(logFiles.map(name => readFile(join(logDir, name), 'utf8').catch(() => '')));
  expect(JSON.stringify({ events, progress, logs, surfaces })).not.toMatch(secret);
}

it('미연결 결합 거부 뒤 복구된 토큰을 같은 이름으로 다시 검사한다', async () => {
  const fixture = await extHome({ realGarminAuth: true });
  try {
    await fixture.runDirect(['ext','install','garmin','--json']);
    const store = join(fixture.home,'extensions/garmin/tokenstore');
    await mkdir(store,{recursive:true,mode:0o700});
    await writeFile(join(store,'garmin_tokens.json'),tokenValue,{mode:0o600});
    await writeFile(join(store,'brain-account-binding.json'),'synthetic-binding',{mode:0o600});
    await writeFile(join(store,'synthetic-probe-mode'),'invalid');
    const rejected = await fixture.runDirect(['ext','install','garmin','--json']);
    expect(rejected.body.error.code).toBe('GARMIN_ACCESS_TOKEN_UNCONFIRMED');
    const refused = await tty(fixture.env,'success');
    expect(refused.body.error.code).toBe('GARMIN_BOUND_LOGIN_REFUSED');
    await writeFile(join(store,'synthetic-probe-mode'),'success');
    const recovered = await fixture.runDirect(['ext','install','garmin','--json']);
    expect(recovered.body.data.install.stages.login.status).toBe('succeeded');
    expect(recovered.body.error.code).not.toBe('GARMIN_BOUND_LOGIN_REFUSED');
    expect(await readFile(join(store,'garmin_tokens.json'),'utf8')).toBe(tokenValue);
  } finally { await fixture.cleanup(); }
}, 180000);

it('공식 이름 설치, 실제 TTY 실패·취소·성공과 한 번의 이름 재개를 관찰한다', async () => {
  const fixture = await extHome({ realGarminAuth: true });
  let stop: (() => Promise<void>) | undefined;
  const surfaces: string[] = [];
  try {
    const catalog = await fixture.runDirect(['ext', 'catalog', '--json']);
    const meta = catalog.body.data.find((row: any) => row.name === 'garmin');
    expect(meta).toMatchObject({login_required:true,installed:false});
    const first = await fixture.runDirect(['ext', 'install', 'garmin', '--json']);
    surfaces.push(first.stdout, first.stderr, catalog.stdout, catalog.stderr);
    expect(first.body.error.code, first.stdout + first.stderr).toBe('EXTENSION_LOGIN_REQUIRED');
    expect(first.body.data.install.auth_work_id).toBeNull();
    await noAuthWork(fixture);
    const directory = join(fixture.home, 'extensions/garmin');
    for (const mode of ['failure', 'eof', 'interrupt']) {
      const failed = await tty(fixture.env, mode); surfaces.push(failed.output);
      expect(failed.code).not.toBe(0);
      expect(failed.body?.error?.code, `mode=${mode} exit=${failed.code} envelope=${Boolean(failed.body)} bytes=${Buffer.byteLength(failed.output)}`).toBe(mode === 'failure' ? 'LOGIN_REQUIRED' : 'AUTH_CANCELLED');
      const status = await fixture.runDirect(['ext', 'status', 'garmin', '--json']); surfaces.push(status.stdout, status.stderr);
      expect(status.body.data.install).toMatchObject({result:mode === 'failure' ? 'failed' : 'cancelled', failed_stage:mode === 'failure' ? 'login' : null,
        stages:{login:{status:'failed', code:mode === 'failure' ? 'EXTENSION_AUTH_FAILED' : 'AUTH_CANCELLED'}}});
      const retry = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(retry.stdout, retry.stderr);
      expect(retry.body.error.code).toBe(mode === 'failure' ? 'EXTENSION_AUTH_FAILED' : 'AUTH_CANCELLED');
      expect(retry.body.data.install.result).toBe(mode === 'failure' ? 'failed' : 'cancelled');
      expect(retry.body.data.install.stages.connection).toBeUndefined();
      expect(retry.body.data.install.stages.schedule).toBeUndefined();
      expect(await fixture.db.rows("select id from brain.schedules where extension='garmin'")).toEqual([]);
    }
    const login = await tty(fixture.env, 'success'); surfaces.push(login.output);
    expect(login.code, `mode=success exit=${login.code} envelope=${Boolean(login.body)} bytes=${Buffer.byteLength(login.output)}`).toBe(0);
    expect(login.body).toMatchObject({ok:true,data:{status:'succeeded'}});
    const wait = await fixture.runDirect(['ext', 'status', 'garmin', '--json']); surfaces.push(wait.stdout, wait.stderr);
    expect(wait.body.data.install.stages.login).toMatchObject({status:'pending',code:'TOKEN_VERIFY_PENDING'});
    const token = join(directory, 'tokenstore/garmin_tokens.json');
    const tokenBefore = await readFile(token, 'utf8');
    expect(JSON.parse(tokenBefore)).toEqual(JSON.parse(tokenValue));
    // An installed role that cannot log in makes the separate DB check fail.
    await fixture.db.query('alter role brain_ext_garmin nologin');
    const failedCheck = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(failedCheck.stdout, failedCheck.stderr);
    expect(failedCheck.body.error.code).toBe('EXTENSION_CHECK_FAILED');
    expect(failedCheck.body.data.install.stages.login.status).toBe('succeeded');
    expect(failedCheck.body.data.install.stages.connection.status).toBe('failed');
    expect(failedCheck.body.data.install.stages.schedule).toBeUndefined();
    expect(await fixture.db.rows("select id from brain.schedules where extension='garmin'")).toEqual([]);
    await fixture.db.query('alter role brain_ext_garmin login');
    const pending = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(pending.stdout, pending.stderr);
    expect(pending.body.error.code).toBe('EXTENSION_SCHEDULER_UNAVAILABLE');
    expect(pending.body.data.install.stages.login.status).toBe('succeeded');
    expect(pending.body.data.install.stages.connection.status).toBe('succeeded');
    expect(await readFile(token, 'utf8')).toBe(tokenBefore);
    await noAuthWork(fixture);
    const modePath = join(directory, 'tokenstore/synthetic-probe-mode');
    const auditPath = join(directory, 'synthetic-auth-audit.jsonl');
    const priorAudit = await readFile(auditPath, 'utf8');
    const initFailure = join(directory, 'synthetic-init-fail');
    await writeFile(initFailure, 'fail');
    const closed = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(closed.stdout, closed.stderr);
    expect(closed.body.error.code).toBe('AUTH_UNAVAILABLE');
    const newAudit = (await readFile(auditPath, 'utf8')).slice(priorAudit.length);
    expect(newAudit).toContain('argv');
    expect(newAudit).not.toContain('probe');
    await rm(initFailure);
    await writeFile(modePath, 'invalid');
    const invalid = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(invalid.stdout, invalid.stderr);
    expect(invalid.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    expect(invalid.body.data.install.stages.login).toMatchObject({status:'pending',code:'LOGIN_REQUIRED'});
    await writeFile(modePath, 'transient');
    const transient = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(transient.stdout, transient.stderr);
    expect(transient.body.error.code).toBe('AUTH_UNAVAILABLE');
    expect(transient.body.data.install.stages.login).toMatchObject({status:'failed',code:'AUTH_UNAVAILABLE'});
    await writeFile(modePath, 'success');
    stop = await daemonFor(fixture);
    const done = await fixture.runDirect(['ext', 'install', 'garmin', '--json']); surfaces.push(done.stdout, done.stderr);
    expect(done.code, done.stdout + done.stderr).toBe(0);
    expect(done.body.data.install.stages.schedule.status).toBe('succeeded');
    expect((await fixture.db.rows("select id from brain.schedules where extension='garmin'")).length).toBeGreaterThan(0);
    const afterCatalog = await fixture.runDirect(['ext','catalog','--json']);
    const status = await fixture.runDirect(['ext','status','garmin','--json']);
    surfaces.push(afterCatalog.stdout, afterCatalog.stderr, status.stdout, status.stderr);
    expect(afterCatalog.body.data.find((row:any)=>row.name==='garmin')).toMatchObject({version:meta.version,login_required:true,installed:true});
    expect(status.body.data).toMatchObject({login:{status:'succeeded'},connection:{status:'connected'}});
    expect(await readFile(token, 'utf8')).toBe(tokenBefore);
    await noAuthWork(fixture);
    await audit(fixture, surfaces);
  } finally { await cleanupOwned(stop, fixture); }
}, 240000);

it('이전 인증 없는 배포본에서 현재 이름 패키지로 실제 전환하며 기존 상태를 보존한다', async () => {
  const fixture = await extHome({ realGarminAuth: true });
  let archiveRoot: string | undefined;
  let stop: (() => Promise<void>) | undefined;
  const surfaces: string[] = [];
  try {
    archiveRoot = await realpath(await mkdtemp(join(tmpdir(), 'brain-garmin-prior-')));
    const tar = join(archiveRoot, 'prior.tar');
    execFileSync('git', ['archive', '--output', tar, '7d83963c473a5979c50d6e2d8bf8beddc0ca2bc7', 'plugins/garmin/package'], { cwd: root });
    execFileSync('tar', ['-xf', tar, '-C', archiveRoot]);
    const old = join(archiveRoot, 'plugins/garmin/package');
    const oldManifest = JSON.parse(await readFile(join(old, 'manifest.json'), 'utf8'));
    const currentManifest = JSON.parse(await readFile(join(root, 'plugins/garmin/package/manifest.json'), 'utf8'));
    const oldDigest = (await readFile(join(old, 'digest'), 'utf8')).trim();
    const currentDigest = (await readFile(join(root, 'plugins/garmin/package/digest'), 'utf8')).trim();
    expect(oldManifest.auth).toBeUndefined();
    expect(oldManifest.version).not.toBe(currentManifest.version);
    expect(oldDigest).not.toBe(currentDigest);
    stop = await daemonFor(fixture);
    const prior = await fixture.runDirect(['ext','install','--package',old,'--json']); surfaces.push(prior.stdout, prior.stderr);
    expect(prior.code, prior.stdout + prior.stderr).toBe(0);
    expect(prior.body.data).toMatchObject({version:oldManifest.version,package_digest:oldDigest,connection:{status:'connected'},login:{status:'skipped'}});
    const catalog = await fixture.runDirect(['ext','catalog','--json']);
    const meta = catalog.body.data.find((row:any)=>row.name==='garmin');
    expect(meta).toMatchObject({version:currentManifest.version,login_required:true,installed:true});
    const directory = join(fixture.home,'extensions/garmin'), store = join(directory,'tokenstore');
    await mkdir(store,{recursive:true,mode:0o700});
    const token = join(store,'garmin_tokens.json'), binding = join(store,'brain-account-binding.json');
    await writeFile(token,tokenValue,{mode:0o600});
    await writeFile(binding,'synthetic-existing-binding',{mode:0o600});
    await writeFile(join(store,'synthetic-probe-mode'),'transient');
    const before = await fixture.db.rows("select id,schedule_key,enabled from brain.schedules where extension='garmin' order by id");
    expect(before.length).toBeGreaterThan(0);
    const transient = await fixture.runDirect(['ext','install','garmin','--json']); surfaces.push(transient.stdout, transient.stderr, catalog.stdout, catalog.stderr);
    expect(transient.body.error.code).toBe('AUTH_UNAVAILABLE');
    expect(transient.body.data.install.stages.login).toMatchObject({status:'failed',code:'AUTH_UNAVAILABLE'});
    const switched = await fixture.db.rows("select version,package_digest from brain.extensions where name='garmin'");
    expect(switched).toEqual([{version:currentManifest.version,package_digest:currentDigest}]);
    expect(await readFile(token,'utf8')).toBe(tokenValue);
    expect(await readFile(binding,'utf8')).toBe('synthetic-existing-binding');
    await noAuthWork(fixture);
    await writeFile(join(store,'synthetic-probe-mode'),'success');
    const resumed = await fixture.runDirect(['ext','install','garmin','--json']); surfaces.push(resumed.stdout, resumed.stderr);
    expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(resumed.body.data).toMatchObject({login:{status:'succeeded'},connection:{status:'connected'}});
    expect(await fixture.db.rows("select id,schedule_key,enabled from brain.schedules where extension='garmin' order by id")).toEqual(before);
    await writeFile(join(store,'synthetic-probe-mode'),'invalid');
    const rejected = await fixture.runDirect(['ext','install','garmin','--json']); surfaces.push(rejected.stdout, rejected.stderr);
    expect(rejected.body.error.code).toBe('GARMIN_ACCESS_TOKEN_UNCONFIRMED');
    expect(rejected.body.data.install.stages.login).toMatchObject({status:'failed',code:'GARMIN_ACCESS_TOKEN_UNCONFIRMED'});
    expect(await readFile(token,'utf8')).toBe(tokenValue);
    expect(await readFile(binding,'utf8')).toBe('synthetic-existing-binding');
    expect(await fixture.db.rows("select id,schedule_key,enabled from brain.schedules where extension='garmin' order by id")).toEqual(before);
    await writeFile(join(store,'synthetic-probe-mode'),'success');
    const restored = await fixture.runDirect(['ext','install','garmin','--json']); surfaces.push(restored.stdout, restored.stderr);
    expect(restored.code, restored.stdout + restored.stderr).toBe(0);
    expect(restored.body.data.login.status).toBe('succeeded');
    const status = await fixture.runDirect(['ext','status','garmin','--json']); surfaces.push(status.stdout, status.stderr);
    expect(status.body.data).toMatchObject({version:currentManifest.version,connection:{status:'connected'},login:{status:'succeeded'}});
    expect(await fixture.db.rows("select id,schedule_key,enabled from brain.schedules where extension='garmin' order by id")).toEqual(before);
    await noAuthWork(fixture);
    await audit(fixture, surfaces);
  } finally { await cleanupOwned(stop, fixture, archiveRoot); }
},240000);

it('사용자 로그인 성공 뒤 첫 이름 재개 한 번으로 인증과 연결과 예약을 완료한다', async () => {
  const fixture = await extHome({ realGarminAuth: true });
  let stop: (() => Promise<void>) | undefined;
  try {
    const first = await fixture.runDirect(['ext','install','garmin','--json']);
    expect(first.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    const login = await tty(fixture.env,'success');
    expect(login.code, `mode=success exit=${login.code} envelope=${Boolean(login.body)} bytes=${Buffer.byteLength(login.output)}`).toBe(0);
    const waiting = await fixture.runDirect(['ext','status','garmin','--json']);
    expect(waiting.body.data.login).toMatchObject({status:'pending',code:'TOKEN_VERIFY_PENDING'});
    stop = await daemonFor(fixture);
    const done = await fixture.runDirect(['ext','install','garmin','--json']);
    expect(done.code,done.stdout+done.stderr).toBe(0);
    expect(done.body.data.install.stages).toMatchObject({login:{status:'succeeded'},connection:{status:'succeeded'},schedule:{status:'succeeded'}});
    await noAuthWork(fixture);
    await audit(fixture,[first.stdout,first.stderr,login.output,waiting.stdout,waiting.stderr,done.stdout,done.stderr]);
  } finally { await cleanupOwned(stop, fixture); }
},240000);


it('감독자 준비 또는 종료 실패에도 시험 자원 정리를 각각 수행한다', async () => {
  const controller = new AbortController();
  let stopped = false, cleaned = false;
  const running = new Promise<void>(resolve => controller.signal.addEventListener('abort', () => { stopped = true; resolve(); }, { once: true }));
  const fixture = { cleanup: async () => { cleaned = true; } } as unknown as Awaited<ReturnType<typeof extHome>>;
  const archive = await mkdtemp(join(tmpdir(), 'brain-cleanup-check-'));
  let stop: (() => Promise<void>) | undefined;
  try {
    await expect(ownRunningDaemon(controller, running, async () => { throw Error('synthetic readiness failure'); })).rejects.toThrow('synthetic readiness failure');
  } finally { await cleanupOwned(stop, fixture, archive); }
  expect(stopped).toBe(true); expect(cleaned).toBe(true);
  await expect(readdir(archive)).rejects.toThrow();
  cleaned = false;
  const secondArchive = await mkdtemp(join(tmpdir(), 'brain-cleanup-check-'));
  await expect(cleanupOwned(async () => { throw Error('synthetic stop failure'); }, fixture, secondArchive)).rejects.toThrow('owned fixture cleanup failed');
  expect(cleaned).toBe(true);
  await expect(readdir(secondArchive)).rejects.toThrow();
});

it.each(['guard', 'timeout'])('PTY %s 실패는 소유 프로세스 그룹을 종료한 뒤 반환한다', async mode => {
  const home = await mkdtemp(join(tmpdir(), 'brain-pty-cleanup-'));
  const pidFile = join(home, 'pids.json'), script = join(home, 'fake-cli.mjs');
  let driver: ReturnType<typeof spawn> | undefined;
  let closed: Promise<number | null> | undefined;
  let pids: number[] = [];
  try {
    await writeFile(script, `import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const child=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});setInterval(()=>{},1000)"]);writeFileSync(${JSON.stringify(pidFile)},JSON.stringify([process.pid,child.pid]));${mode === 'guard' ? "console.log('Garmin 이메일:');" : ''}setInterval(()=>{},1000);`);
    driver = spawn('python3',[join(fixtures,'terminal_driver.py'),mode,process.execPath,script],{env:{...process.env,SECOND_BRAIN_HOME:home,SYNTHETIC_TTY_TIMEOUT:'2'},stdio:['ignore','pipe','pipe']});
    const owned = driver;
    closed = new Promise((resolve,reject) => {owned.once('error',reject);owned.once('close',resolve);});
    await expect.poll(async () => readFile(pidFile,'utf8').then(text => {pids = JSON.parse(text); return pids.length === 2;},() => false),{timeout:10000}).toBe(true);
    expect(await closed).not.toBe(0);
    for (const pid of pids) {
      expect(() => process.kill(pid,0)).toThrow();
    }
  } finally {
    if (pids[0]) { try { process.kill(-pids[0], 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
    driver?.kill('SIGKILL');
    try { await closed; } finally { await rm(home,{recursive:true,force:true}); }
  }
},30000);

it('PTY EOF 뒤 CLI가 늦게 정상 종료해도 남은 시간 동안 기다린다', async () => {
  const home = await mkdtemp(join(tmpdir(),'brain-pty-eof-'));
  try {
    const script = join(home,'delayed-exit.mjs');
    await writeFile(script, "import {closeSync,writeSync} from 'node:fs';writeSync(1,'{\\\"ok\\\":true}\\n');for(const fd of [0,1,2])try{closeSync(fd)}catch{};setTimeout(()=>process.exit(0),300);\n");
    const result = await new Promise<{code:number|null;out:string}>((resolve,reject) => {
      const child = spawn('python3',[join(fixtures,'terminal_driver.py'),'eof-test',process.execPath,script],{env:{...process.env,SECOND_BRAIN_HOME:home,SYNTHETIC_TTY_TIMEOUT:'5'},stdio:['ignore','pipe','pipe']});
      let out = ''; child.stdout.on('data',chunk => {out += String(chunk);}); child.stderr.on('data',chunk => {out += String(chunk);});
      child.once('error',reject); child.once('close',code => resolve({code,out}));
    });
    expect(result.code,result.out).toBe(0);
    expect(result.out).toContain('{"ok":true}');
  } finally { await rm(home,{recursive:true,force:true}); }
},30000);

it('PTY 직접 자식이 종료된 뒤에도 마지막 JSON까지 모두 회수한다', async () => {
  const home = await mkdtemp(join(tmpdir(),'brain-pty-drain-'));
  try {
    const script = join(home,'burst.mjs');
    await writeFile(script, "import {writeSync} from 'node:fs';const data=Buffer.from('x'.repeat(32768)+'\\n{\\\"ok\\\":false,\\\"error\\\":{\\\"code\\\":\\\"AUTH_CANCELLED\\\"}}\\n');for(let n=0;n<data.length;)n+=writeSync(1,data,n,data.length-n);process.exit(1);\n");
    const result = await new Promise<{code:number|null;out:string}>((resolve,reject) => {
      const child = spawn('python3',[join(fixtures,'terminal_driver.py'),'drain-test',process.execPath,script],{env:{...process.env,SECOND_BRAIN_HOME:home,SYNTHETIC_TTY_TIMEOUT:'5'},stdio:['ignore','pipe','pipe']});
      let out = ''; child.stdout.on('data',chunk => {out += String(chunk);}); child.stderr.on('data',chunk => {out += String(chunk);});
      child.once('error',reject); child.once('close',code => resolve({code,out}));
    });
    expect(result.code).toBe(1);
    expect(result.out.includes('{"ok":false,"error":{"code":"AUTH_CANCELLED"}}')).toBe(true);
    expect(result.out.split('x').length - 1).toBe(32768);
  } finally { await rm(home,{recursive:true,force:true}); }
},30000);
