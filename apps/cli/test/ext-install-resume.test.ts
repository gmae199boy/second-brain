import type { ExtensionInstallProgress } from 'second_brain';
import { afterEach, expect, it } from 'vitest';
import { cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extHome } from './ext-fixture.js';

const cleanup: (() => Promise<void>)[] = [];
async function resumeSource(fixture: Awaited<ReturnType<typeof extHome>>) {
  const roots = join(fixture.home, 'packages'), source = join(roots, 'resumext');
  await mkdir(roots); await cp(fileURLToPath(new URL('./fixtures/extensions/testext/', import.meta.url)), source, { recursive: true });
  for (const file of ['manifest.json', 'bin/check.mjs', 'migrations/0001_testext.sql']) {
    const path = join(source, file); await writeFile(path, (await readFile(path, 'utf8')).replaceAll('testext', 'resumext'));
  }
  fixture.env.SECOND_BRAIN_TEST_EXTENSIONS = roots; return source;
}
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

it('수정 migration의 prepared stage 삭제 직후 중단해도 같은 owner로 설치를 완료한다', async () => {
  const { spawn } = await import('node:child_process');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  const first = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(first.code, first.stdout + first.stderr).toBe(0);
  const registry = await fixture.db.rows("select * from brain.extensions where name='resumext'");
  const target = join(fixture.home, 'extensions/resumext');
  for (const folder of ['reports', 'staging', 'tokenstore']) { await mkdir(join(target, folder), { recursive: true }); await writeFile(join(target, folder, 'preserved'), folder); }
  const manifestPath = join(source, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8')); manifest.version = '0.2.0';
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select missing_column;\n');
  const failed = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(failed.body.error.code).toBe('MIGRATION_FAILED');
  const before = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
  const owner = before.transition!.owner;
  expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }]);
  expect(await fixture.db.rows("select * from brain.extensions where name='resumext'")).toEqual(registry);
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select 1;\n');
  const stage = join(fixture.home, 'extensions', `.transition-resumext-${owner}`);
  const hook = join(fixture.home, 'interrupt-discard.cjs');
  await writeFile(hook, `const fs = require('node:fs'); const original = fs.promises.rm; fs.promises.rm = async function(path, options) { const result = await original(path, options); if (String(path) === ${JSON.stringify(stage)}) process.kill(process.pid, 'SIGKILL'); return result; }; require('node:module').syncBuiltinESMExports();\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', 'resumext', '--json'], { env: { ...fixture.env, NODE_OPTIONS: `--require=${hook}` }, stdio: 'ignore' });
  const signal = await new Promise<NodeJS.Signals | null>((resolve, reject) => { child.once('error', reject); child.once('close', (_code, value) => resolve(value)); });
  expect(signal).toBe('SIGKILL');
  const journal = JSON.parse(await readFile(join(fixture.home, 'extensions/.transition-resumext.json'), 'utf8'));
  expect(journal).toMatchObject({ owner, phase: 'discarding', digest: before.packageDigest });
  await expect(stat(stage)).rejects.toThrow();
  const pending = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
  expect(pending.transition?.owner).toBe(owner); expect(pending.packageDigest).not.toBe(before.packageDigest);
  expect((await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'"))[0]!.owner).toBe(owner);
  expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }]);
  // The killed synthetic installer has no child writer; remove only its lock.
  await rm(join(fixture.home, 'install.lock'), { recursive: true });
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select 2;\n');
  const wrong = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(wrong.body.error.code).toBe('EXTENSION_INVALID');
  expect((await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'"))[0]!.owner).toBe(owner);
  expect((JSON.parse(await readFile(join(fixture.home, 'extensions/.transition-resumext.json'), 'utf8'))).phase).toBe('discarding');
  expect(await fixture.db.rows("select * from brain.extensions where name='resumext'")).toEqual(registry);
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select 1;\n');
  const resumed = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'")).toEqual([]);
  expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }, { owner: 'resumext', version: 2 }]);
  expect(await readFile(join(target, 'migrations/0002_more.sql'), 'utf8')).toBe('select 1;\n');
  for (const folder of ['reports', 'staging', 'tokenstore']) expect(await readFile(join(target, folder, 'preserved'), 'utf8')).toBe(folder);
  await expect(stat(join(fixture.home, 'extensions/.transition-resumext.json'))).rejects.toThrow();
});

it('최초 DDL 실패 후 앞 단계와 적용된 SQL을 보존하고 수정된 SQL부터 재개한다', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select missing_column;\n');
  const failed = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(failed.body).toMatchObject({ ok: false, error: { code: 'MIGRATION_FAILED' }, data: { install: { result: 'failed', failed_stage: 'migration' } } });
  expect(failed.body.data).toEqual((await fixture.run(['ext', 'status', 'resumext', '--json'])).body.data);
  expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }]);
  const target = join(fixture.home, 'extensions/resumext');
  await expect(stat(join(target, 'manifest.json'))).rejects.toThrow();
  const rows = await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'");
  const beforeProgress = rows[0]!.progress as ExtensionInstallProgress;
  const manifestPath = join(source, 'manifest.json'); const validManifest = await readFile(manifestPath, 'utf8');
  await writeFile(manifestPath, '{');
  const preflight = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(preflight.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_INVALID' }, data: { install: { failed_stage: 'migration' } } });
  const preserved = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
  expect(preserved.packageDigest).toBe(beforeProgress.packageDigest);
  expect(preserved.stages).toEqual(beforeProgress.stages);
  expect(preserved.authWorkId).toBe(beforeProgress.authWorkId); expect(preserved.scheduleIds).toEqual(beforeProgress.scheduleIds);
  await writeFile(manifestPath, validManifest);
  expect(beforeProgress).toMatchObject({ result: 'failed', failedStage: 'migration', stages: { role: { status: 'succeeded' }, migration: { status: 'failed' } } });
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select 1;\n');
  const resumed = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
  expect(await readFile(join(target, 'manifest.json'), 'utf8')).toBe(validManifest);
  expect(await readFile(join(target, 'migrations/0002_more.sql'), 'utf8')).toBe('select 1;\n');
  expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }, { owner: 'resumext', version: 2 }]);
  const after = await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'");
  const afterProgress = after[0]!.progress as ExtensionInstallProgress;
  expect(afterProgress.stages.package?.status).toBe('succeeded');
  expect(afterProgress.stages.environment?.status).toBe('skipped');
  expect(afterProgress.stages.role).toEqual(beforeProgress.stages.role);
});

it('동시 설치는 직렬화하여 하나의 패키지와 DDL 이력을 남긴다', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  await resumeSource(fixture);
  const results = await Promise.all([fixture.run(['ext', 'install', 'resumext', '--json']), fixture.run(['ext', 'install', 'resumext', '--json'])]);
  for (const result of results) expect(result.code, result.stdout + result.stderr).toBe(0);
  expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }]);
  const rows = await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'");
  expect(rows).toHaveLength(1);
  expect((rows[0]!.progress as ExtensionInstallProgress).stages.migration?.status).toBe('succeeded');
});

it('기존 데몬이 인증 미완료를 감독하고 완료 뒤 재개하며 활성 일감을 재사용한다', async () => {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.auth = { kind: 'resumext.login', execution: 'supervised', runtime: 'node', entry: 'bin/login.mjs' };
  manifest.work = [{ kind: 'resumext.sync', execution: 'supervised', runtime: 'node', entry: 'bin/check.mjs' }];
  manifest.default_schedules = [{ kind: 'resumext.sync', target_kind: 'account', target_id: 'default', local_time: '09:00' }];
  const checkPath = join(source, 'bin/check.mjs');
  const check = await readFile(checkPath, 'utf8');
  await writeFile(checkPath, `import { appendFileSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path'; appendFileSync(join(dirname(dirname(fileURLToPath(import.meta.url))),'tokenstore/checks'),'check\\n');\n` + check);
  manifest.error_codes = ['LOGIN_REQUIRED'];
  manifest.settings = [{ key: 'resumext.tokenstore', type: 'string', machine: 'tokenstore', required: ['auth'] }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'bin/login.mjs'), `import { existsSync, mkdirSync, appendFileSync } from 'node:fs';
const dir = JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT).values['resumext.tokenstore'];
mkdirSync(dir, {recursive:true}); appendFileSync(dir + '/runs', 'run\\n');
await new Promise(resolve => setTimeout(resolve, 700));
if (!existsSync(dir + '/ready')) { console.error('SYNTHETIC_AUTH_SECRET'); console.log(JSON.stringify({abi:1,type:'error',code:'LOGIN_REQUIRED',retryable:false,message:'SYNTHETIC_AUTH_SECRET'})); }
else console.log(JSON.stringify({abi:1,type:'result'}));\n`);
  const first = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(first.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_LOGIN_REQUIRED' }, data: { install: { result: 'login_required' } } });
  expect(first.body.data).toEqual((await fixture.run(['ext', 'status', 'resumext', '--json'])).body.data);
  let journal = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
  expect(journal).toMatchObject({ result: 'login_required', stages: { login: { status: 'pending' } } });
  expect(journal.stages.connection).toBeUndefined(); expect(journal.stages.schedule).toBeUndefined();
  const id = journal.authWorkId; const pendingAt = journal.stages.login?.at;
  const validManifest = await readFile(join(source, 'manifest.json'), 'utf8');
  await writeFile(join(source, 'manifest.json'), '{');
  const invalid = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(invalid.body.error.code).toBe('EXTENSION_INVALID');
  const preserved = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
  expect(preserved.authWorkId).toBe(id); expect(preserved.stages).toEqual(journal.stages); expect(preserved.packageDigest).toBe(journal.packageDigest);
  await writeFile(join(source, 'manifest.json'), validManifest);
  const controller = new AbortController();
  const daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25, cancelPollMs: 25, cancelGraceMs: 50, groupConfirmMs: 200 } });
  try {
    await expect.poll(async () => (await fixture.db.rows("select claimed_at from brain.work_items where kind='resumext.login'"))[0]?.claimed_at, { timeout: 10000 }).toBeTruthy();
    const active = await fixture.run(['ext', 'install', 'resumext', '--json']);
    expect(active.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    journal = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
    expect(journal.authWorkId).toBe(id); expect(journal.stages.login?.at).toBe(pendingAt);
    await expect.poll(async () => (await fixture.db.rows("select outcome from brain.work_items where kind='resumext.login'"))[0]?.outcome, { timeout: 10000 }).toBe('failed');
    const tokenstore = join(fixture.home, 'extensions/resumext/tokenstore');
    await writeFile(join(tokenstore, 'ready'), 'ok');
    const retried = await fixture.run(['ext', 'install', 'resumext', '--json']);
    expect(retried.body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    await expect.poll(async () => (await fixture.db.rows("select count(*)::integer as n from brain.work_items where kind='resumext.login' and outcome='succeeded'"))[0]?.n, { timeout: 10000 }).toBe(1);
    const completed = await fixture.run(['ext', 'install', 'resumext', '--json']);
    expect(completed.code, completed.stdout + completed.stderr).toBe(0);
    const repeated = await fixture.run(['ext', 'install', 'resumext', '--json']);
    expect(repeated.code).toBe(0);
    expect(repeated.body.data).toEqual(completed.body.data);
    expect(completed.body.data.install.result).toBe('installed');
    expect((await readFile(join(tokenstore, 'checks'), 'utf8')).trim().split('\n')).toHaveLength(1);
    expect(await fixture.db.rows('select id from brain.schedules')).toHaveLength(1);
    expect(await fixture.ledger('resumext')).toHaveLength(1);
    expect((await readFile(join(tokenstore, 'runs'), 'utf8')).trim().split('\n')).toHaveLength(2);
    const facts = await fixture.db.rows("select outcome,last_error from brain.work_items where kind='resumext.login' order by created_at");
    expect(facts).toHaveLength(2);
    expect(JSON.stringify({ first, active, retried, completed, facts, journal })).not.toContain('SYNTHETIC_AUTH_SECRET');
    journal = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
    expect(journal.stages.login?.status).toBe('succeeded');
  } finally { controller.abort(); await daemon; }
});

it('재설치는 이행 키와 사용자 변경·삭제를 보존하고 빠진 키를 비활성화한다', async () => {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.work = [{ kind: 'resumext.sync', execution: 'supervised', runtime: 'node', entry: 'bin/check.mjs', missed: 'coalesce' }];
  manifest.default_schedules = [{ kind:'resumext.sync',target_kind:'account',target_id:'default',local_time:'09:00' },{kind:'resumext.sync',target_kind:'account',target_id:'removed',key:'removed',cron:'0 10 * * *',time_zone:'UTC'},{kind:'resumext.sync',target_kind:'account',target_id:'obsolete',key:'obsolete',cron:'0 11 * * *'}];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  const unavailable = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(unavailable.body.error.code).toBe('EXTENSION_SCHEDULER_UNAVAILABLE');
  expect(unavailable.body.data.install).toMatchObject({ result: 'scheduler_unavailable', failed_stage: 'schedule', last_failure: { code: 'EXTENSION_SCHEDULER_UNAVAILABLE' } });
  expect(unavailable.body.data).toEqual((await fixture.run(['ext', 'status', 'resumext', '--json'])).body.data);
  expect(await fixture.db.rows('select id from brain.schedules')).toHaveLength(0);
  const controller = new AbortController();
  const daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25 } });
  try {
    await expect.poll(async () => { try { return JSON.parse(await readFile(join(fixture.home, 'run/supervisor-ready.json'), 'utf8')).pid; } catch { return null; } }, { timeout: 10000 }).toBe(process.pid);
    // A row already transformed by 0033 has the derived installation key.
    await fixture.db.query(`insert into brain.schedules(id,kind,hold_group,target_kind,target_id,trigger_kind,cron_expr,time_zone,time_zone_source,extension,schedule_key,user_id,enabled,next_run_at,created_at)
      select uuidv7(),'resumext.sync','extension:resumext','account','default','cron','0 9 * * *','Asia/Seoul','user','resumext','resumext.sync:account:default',id,true,now()+interval '1 day',now() from brain.users where is_self=1`);
    const first = await fixture.run(['ext','install','resumext','--json']);expect(first.code,first.stdout+first.stderr).toBe(0);
    expect(await fixture.db.rows("select missed_policy from brain.extension_work_kinds where kind='resumext.sync'")).toEqual([{missed_policy:'coalesce'}]);
    const initial=await fixture.db.rows("select id,schedule_key,cron_expr,enabled,removed_at from brain.schedules where extension='resumext' order by schedule_key");expect(initial).toHaveLength(3);
    const migrated=initial.find(row=>row.schedule_key==='resumext.sync:account:default')!,removed=initial.find(row=>row.schedule_key==='removed')!;
    const changed=await fixture.run(['schedules','update',String(migrated.id),'--cron','15 8 * * 5','--tz','America/New_York','--disable','--json']);expect(changed.code,changed.stdout+changed.stderr).toBe(0);
    const tombstone=await fixture.run(['schedules','remove',String(removed.id),'--json']);expect(tombstone.body.data).toMatchObject({marked:true});
    manifest.default_schedules=manifest.default_schedules.filter((item:{key?:string})=>item.key!=='obsolete');
    manifest.default_schedules.push({kind:'resumext.sync',target_kind:'account',target_id:'new',key:'new',cron:'0 12 * * *'});
    await writeFile(join(source,'manifest.json'),JSON.stringify(manifest));
    const reinstalled=await fixture.run(['ext','install','resumext','--json']);expect(reinstalled.code,reinstalled.stdout+reinstalled.stderr).toBe(0);
    expect(reinstalled.body.data.install.disabled_schedule_keys).toEqual(['obsolete']);
    expect((await fixture.run(['ext','status','resumext','--json'])).body.data.install.disabled_schedule_keys).toEqual(['obsolete']);
    const after=await fixture.db.rows("select id,schedule_key,cron_expr,time_zone,time_zone_source,enabled,removed_at from brain.schedules where extension='resumext' order by schedule_key");expect(after).toHaveLength(4);
    expect(after).toContainEqual(expect.objectContaining({id:migrated.id,schedule_key:'resumext.sync:account:default',cron_expr:'15 8 * * 5',time_zone:'America/New_York',time_zone_source:'fixed',enabled:false}));
    expect(after).toContainEqual(expect.objectContaining({id:removed.id,schedule_key:'removed',enabled:false,removed_at:expect.anything()}));
    expect(after).toContainEqual(expect.objectContaining({schedule_key:'obsolete',enabled:false}));expect(after).toContainEqual(expect.objectContaining({schedule_key:'new',enabled:true}));
    expect(reinstalled.body.data.install.schedule_ids).toHaveLength(3);
    const repeated=await fixture.run(['ext','install','resumext','--json']);expect(repeated.code).toBe(0);expect(repeated.body.data.install.disabled_schedule_keys).toEqual(['obsolete']);
    expect(await fixture.db.rows("select id,schedule_key,cron_expr,time_zone,time_zone_source,enabled,removed_at from brain.schedules where extension='resumext' order by schedule_key")).toEqual(after);
  } finally { controller.abort(); await daemon; }
});

it.each(['SIGINT', 'SIGTERM'] as const)('실행 중 %s 취소 시 자식 종료를 확인하고 이전 단계를 보존해 재개한다', async signal => {
  const { spawn } = await import('node:child_process');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  await writeFile(join(source, 'bin/check.mjs'), `import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const dir=join(dirname(dirname(fileURLToPath(import.meta.url))),'tokenstore'); mkdirSync(dir,{recursive:true});
writeFileSync(join(dir,'pid'),String(process.pid)); if(!existsSync(join(dir,'ready'))) await new Promise(r=>setTimeout(r,30000));
console.log(JSON.stringify({abi:1,type:'result'}));\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', 'resumext', '--json'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.resume();
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('close', (code, ended) => resolve({ code, signal: ended })));
  const tokenstore = join(fixture.home, 'extensions/resumext/tokenstore'), pidFile = join(tokenstore, 'pid');
  try {
    await expect.poll(async () => { try { return Number(await readFile(pidFile, 'utf8')); } catch { return 0; } }, { timeout: 10000 }).toBeGreaterThan(0);
    const pid = Number(await readFile(pidFile, 'utf8')); child.kill(signal);
    const ended = await exited; expect(ended.code, stdout).toBe(1);
    expect(JSON.parse(stdout).error.code).toBe('EXTENSION_INSTALL_CANCELLED');
    expect(() => process.kill(pid, 0)).toThrow();
    const journal = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
    expect(journal.result).toBe('cancelled'); expect(journal.stages.migration?.status).toBe('succeeded');
    await writeFile(join(tokenstore, 'ready'), 'ok');
    const resumed = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(await fixture.ledger('resumext')).toEqual([{ owner: 'resumext', version: 1 }]);
  } finally { child.kill('SIGKILL'); }
});

it.each(['disabled', 'failure'] as const)('데몬 heartbeat가 있어도 감독자 %s 상태에서는 예약하지 않는다', async state => {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { postgresStore } = await import('second_brain/postgres');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.work = [{ kind: 'resumext.sync', execution: 'supervised', runtime: 'node', entry: 'bin/check.mjs' }];
  manifest.default_schedules = [{ kind: 'resumext.sync', target_kind: 'account', target_id: 'default', local_time: '09:00' }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  const controller = new AbortController();
  const daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100,
    supervisor: { pollMs: 25, disabled: state === 'disabled' },
    ...(state === 'failure' ? { createStore: (options: Parameters<typeof postgresStore>[0]) => ({ ...postgresStore(options), async listExtensions() { return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '시험 실패' }; } }) } : {}) });
  try {
    await expect.poll(async () => { try { return Boolean(await stat(join(fixture.home, 'run/heartbeat'))); } catch { return false; } }, { timeout: 10000 }).toBe(true);
    const result = await fixture.run(['ext', 'install', 'resumext', '--json']);
    expect(result.body.error.code).toBe('EXTENSION_SCHEDULER_UNAVAILABLE');
    expect(await fixture.db.rows('select id from brain.schedules')).toHaveLength(0);
  } finally { controller.abort(); await daemon; }
});


it('패키지를 찾기 전 실패도 저장하고 실패 응답과 상태가 같은 사실을 반환한다', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const failed = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(failed.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_NOT_FOUND' }, data: { installed: false, install: { result: 'failed', failed_stage: 'package', stages: { package: { status: 'failed', code: 'EXTENSION_NOT_FOUND' } } } } });
  const status = await fixture.run(['ext', 'status', 'resumext', '--json']);
  expect(status.body.data).toEqual(failed.body.data);
});

it('설치 잠금 대기 중 취소는 소유자의 종료를 기다리지 않고 journal을 바꾸지 않는다', async () => {
  const { spawn } = await import('node:child_process');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  await writeFile(join(source, 'bin/check.mjs'), `import { mkdirSync, writeFileSync, existsSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; import { dirname, join } from 'node:path';
const dir=join(dirname(dirname(fileURLToPath(import.meta.url))),'tokenstore'); mkdirSync(dir,{recursive:true}); writeFileSync(join(dir,'owner'),String(process.pid));
while (!existsSync(join(dir,'ready'))) await new Promise(r=>setTimeout(r,40)); console.log(JSON.stringify({abi:1,type:'result'}));\n`);
  const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
  const launch = () => {
    const child = spawn(process.execPath, [bin, 'ext', 'install', 'resumext', '--json'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr.resume();
    return { child, result: new Promise<{ code: number | null; stdout: string }>(resolve => child.once('close', code => resolve({ code, stdout }))) };
  };
  const owner = launch(); let waiter: ReturnType<typeof launch> | undefined;
  const dir = join(fixture.home, 'extensions/resumext/tokenstore');
  try {
    await expect.poll(async () => { try { return await readFile(join(dir, 'owner'), 'utf8'); } catch { return ''; } }, { timeout: 10000 }).not.toBe('');
    const before = await fixture.db.rows("select revision,progress from brain.extension_install_progress where name='resumext'");
    waiter = launch(); await new Promise(resolve => setTimeout(resolve, 300));
    const started = Date.now(); waiter.child.kill('SIGINT');
    const stopped = await waiter.result; expect(Date.now() - started).toBeLessThan(2000);
    expect(stopped.code).toBe(1); expect(JSON.parse(stopped.stdout).error.code).toBe('EXTENSION_INSTALL_CANCELLED');
    expect(owner.child.exitCode).toBeNull();
    expect(await fixture.db.rows("select revision,progress from brain.extension_install_progress where name='resumext'")).toEqual(before);
    await writeFile(join(dir, 'ready'), 'ok'); expect((await owner.result).code).toBe(0);
    expect((await fixture.run(['ext', 'install', 'resumext', '--json'])).code).toBe(0);
  } finally { owner.child.kill('SIGKILL'); waiter?.child.kill('SIGKILL'); }
});

it('실제 데몬 인증 일감 조회 중 취소하면 자식 종료를 확인한 뒤 재개한다', async () => {
  const { spawn } = await import('node:child_process');
  const { default: pg } = await import('pg');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  const source = await resumeSource(fixture);
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'));
  manifest.auth = { kind: 'resumext.login', execution: 'supervised', runtime: 'node', entry: 'bin/login.mjs' };
  manifest.settings = [{ key: 'resumext.tokenstore', type: 'string', machine: 'tokenstore', required: ['auth'] }];
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'bin/login.mjs'), `import { mkdirSync, writeFileSync, existsSync } from 'node:fs'; const dir=JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT).values['resumext.tokenstore']; mkdirSync(dir,{recursive:true}); writeFileSync(dir+'/pid',String(process.pid)); while(!existsSync(dir+'/ready')) await new Promise(r=>setTimeout(r,40)); console.log(JSON.stringify({abi:1,type:'result'}));\n`);
  const controller = new AbortController();
  const daemon = runDaemon({ home: fixture.home, env: fixture.env, clock: systemClock, idGen: uuidV7IdGen(), signal: controller.signal, drainPauseMs: 25, heartbeatMs: 100, supervisor: { pollMs: 25, cancelPollMs: 25, cancelGraceMs: 100, groupConfirmMs: 500 } });
  const blocker = new pg.Client({ connectionString: fixture.db.url }); let child: ReturnType<typeof spawn> | undefined;
  try {
    expect((await fixture.run(['ext', 'install', 'resumext', '--json'])).body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    const dir = join(fixture.home, 'extensions/resumext/tokenstore'), pidFile = join(dir, 'pid');
    await expect.poll(async () => { try { return Number(await readFile(pidFile, 'utf8')); } catch { return 0; } }, { timeout: 10000 }).toBeGreaterThan(0);
    const pid = Number(await readFile(pidFile, 'utf8'));
    await blocker.connect(); await blocker.query('begin'); await blocker.query('lock table brain.work_items in access exclusive mode');
    const bin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
    child = spawn(process.execPath, [bin, 'ext', 'install', 'resumext', '--json'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; child.stdout!.setEncoding('utf8').on('data', chunk => { stdout += chunk; }); child.stderr!.resume();
    const ended = new Promise<number | null>(resolve => child!.once('close', code => resolve(code)));
    await new Promise(resolve => setTimeout(resolve, 300)); child.kill('SIGINT'); await blocker.query('rollback');
    expect(await ended, stdout).toBe(1); expect(JSON.parse(stdout).error.code).toBe('EXTENSION_INSTALL_CANCELLED');
    expect(() => process.kill(pid, 0)).toThrow();
    const journal = (await fixture.db.rows("select progress from brain.extension_install_progress where name='resumext'"))[0]!.progress as ExtensionInstallProgress;
    expect(journal.result).toBe('cancelled'); expect(journal.stages.migration?.status).toBe('succeeded');
    const work = await fixture.db.rows("select outcome,current_attempt_token from brain.work_items where kind='resumext.login'");
    expect(work).toMatchObject([{ outcome: 'cancelled', current_attempt_token: null }]);
    await writeFile(join(dir, 'ready'), 'ok');
    expect((await fixture.run(['ext', 'install', 'resumext', '--json'])).body.error.code).toBe('EXTENSION_LOGIN_REQUIRED');
    await expect.poll(async () => (await fixture.db.rows("select count(*)::integer as n from brain.work_items where kind='resumext.login' and outcome='succeeded'"))[0]?.n, { timeout: 10000 }).toBe(1);
    expect((await fixture.run(['ext', 'install', 'resumext', '--json'])).code).toBe(0);
  } finally { child?.kill('SIGKILL'); await blocker.query('rollback').catch(() => {}); await blocker.end().catch(() => {}); controller.abort(); await daemon; }
});


it('자격 증명 파일 접근 실패를 설정 단계에 기록하고 복구 후 연결을 반복하지 않는다', async () => {
  const fixture = await extHome(); cleanup.push(fixture.cleanup);
  await resumeSource(fixture);
  const first = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(first.code, first.stdout + first.stderr).toBe(0);
  const envFile = join(fixture.home, '.env'), backup = join(fixture.home, '.env.saved');
  await rename(envFile, backup);
  try {
    const failed = await fixture.run(['ext', 'install', 'resumext', '--json']);
    expect(failed.body).toMatchObject({ ok: false, error: { code: 'EXTENSION_CONFIG_INVALID' }, data: { install: { result: 'failed', failed_stage: 'configuration', last_failure: { stage: 'configuration', code: 'EXTENSION_CONFIG_INVALID' } } } });
    const status = await fixture.run(['ext', 'status', 'resumext', '--json']);
    expect(failed.body.data).toEqual(status.body.data);
    expect(status.body.data.connection).toEqual(first.body.data.connection);
  } finally { await rename(backup, envFile); }
  const recovered = await fixture.run(['ext', 'install', 'resumext', '--json']);
  expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
  expect(recovered.body.data.install.result).toBe('installed');
  expect(recovered.body.data.install.stages.configuration.status).toBe('succeeded');
  expect(recovered.body.data.install.stages.connection).toEqual(first.body.data.install.stages.connection);
  expect(recovered.body.data.connection).toEqual(first.body.data.connection);
});
it('기본 예약을 모두 제거한 재설치는 행을 보존하고 비활성 키를 텍스트와 상태에 보고한다',async()=>{
 const {runDaemon}=await import('../src/daemon/run.js');const {systemClock}=await import('../src/runtime/clock.js');const {uuidV7IdGen}=await import('../src/runtime/id-gen.js');
 const fixture=await extHome();cleanup.push(fixture.cleanup);const source=await resumeSource(fixture);const path=join(source,'manifest.json');const manifest=JSON.parse(await readFile(path,'utf8'));
 manifest.work=[{kind:'resumext.sync',execution:'supervised',runtime:'node',entry:'bin/check.mjs'}];manifest.default_schedules=[{kind:'resumext.sync',target_kind:'account',target_id:'a',key:'alpha',local_time:'09:00'},{kind:'resumext.sync',target_kind:'account',target_id:'b',key:'beta',cron:' 0   10 * * * ',time_zone:'UTC'}];await writeFile(path,JSON.stringify(manifest));
 const controller=new AbortController();const daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
 try{
  await expect.poll(async()=>{try{return JSON.parse(await readFile(join(fixture.home,'run/supervisor-ready.json'),'utf8')).pid;}catch{return null;}},{timeout:10000}).toBe(process.pid);
  const installed=await fixture.run(['ext','install','resumext','--json']);expect(installed.code,installed.stdout+installed.stderr).toBe(0);
  const before=await fixture.db.rows("select id,schedule_key,cron_expr from brain.schedules where extension='resumext' order by schedule_key");expect(before).toHaveLength(2);expect(before).toContainEqual(expect.objectContaining({schedule_key:'beta',cron_expr:'0 10 * * *'}));
  manifest.default_schedules=[];await writeFile(path,JSON.stringify(manifest));
  const updated=await fixture.run(['ext','install','resumext','--json']);expect(updated.code,updated.stdout+updated.stderr).toBe(0);expect(updated.body.data.install).toMatchObject({schedule_ids:[],disabled_schedule_keys:['alpha','beta']});
  const after=await fixture.db.rows("select id,schedule_key,cron_expr,enabled from brain.schedules where extension='resumext' order by schedule_key");expect(after).toEqual(before.map(row=>({...row,enabled:false})));
  const status=await fixture.run(['ext','status','resumext','--json']);expect(status.body.data.install).toMatchObject({schedule_ids:[],disabled_schedule_keys:['alpha','beta']});
  const textStatus=await fixture.run(['ext','status','resumext']);expect(textStatus.stdout).toContain('비활성화된 예약 키: alpha, beta');
  const textInstall=await fixture.run(['ext','install','resumext']);expect(textInstall.stdout).toContain('비활성화된 예약 키: alpha, beta');
 }finally{controller.abort();await daemon;}
});

it('migration 대기 중 프로세스 중단 후 같은 owner로 재개하고 영속 파일을 보존한다', async () => {
  const { spawn } = await import('node:child_process');
  const { rm } = await import('node:fs/promises');
  const { default: pg } = await import('pg');
  const fixture = await extHome(); cleanup.push(fixture.cleanup); const source = await resumeSource(fixture);
  const first = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(first.code, first.stdout + first.stderr).toBe(0);
  const target = join(fixture.home, 'extensions', 'resumext');
  for (const folder of ['reports', 'staging', 'tokenstore']) { await mkdir(join(target, folder), { recursive: true }); await writeFile(join(target, folder, 'preserved'), folder); }
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8')); manifest.version = '0.2.0';
  await writeFile(join(source, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(source, 'migrations/0002_more.sql'), 'select 1;\n');
  const blocker = new pg.Client({ connectionString: fixture.db.url });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    await blocker.connect(); await blocker.query('begin'); await blocker.query('select pg_advisory_xact_lock($1)', [4919270911]);
    child = spawn(process.execPath, [fileURLToPath(new URL('../dist/bin.js', import.meta.url)), 'ext', 'install', 'resumext', '--json'], { env: fixture.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.resume(); child.stderr!.resume(); const exited = new Promise<void>(resolve => child!.once('close', () => resolve()));
    await expect.poll(async () => (await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'")).length, { timeout: 10000 }).toBe(1);
    await expect.poll(async () => { try { return JSON.parse(await readFile(join(fixture.home, 'extensions/.transition-resumext.json'), 'utf8')).phase; } catch { return ''; } }, { timeout: 10000 }).toBe('prepared');
    const owner = (await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'"))[0]!.owner;
    child.kill('SIGKILL'); await exited; child = undefined; await blocker.query('rollback');
    // This synthetic installer has no spawned writer; its process has exited.
    await rm(join(fixture.home, 'install.lock'), { recursive: true });
    expect((await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'"))[0]!.owner).toBe(owner);
    const resumed = await fixture.run(['ext', 'install', 'resumext', '--json']); expect(resumed.code, resumed.stdout + resumed.stderr).toBe(0);
    expect(await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'")).toEqual([]);
    expect(await fixture.ledger('resumext')).toHaveLength(2);
    for (const folder of ['reports', 'staging', 'tokenstore']) expect(await readFile(join(target, folder, 'preserved'), 'utf8')).toBe(folder);
  } finally { child?.kill('SIGKILL'); await blocker.query('rollback').catch(() => {}); await blocker.end().catch(() => {}); }
});

it('실제 supervisor 확장 자식과 후손의 종료·정산 뒤에만 설치 파일을 전환한다', async () => {
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { postgresStore } = await import('second_brain/postgres');
  const { default: pg } = await import('pg');
  const fixture = await extHome(); cleanup.push(fixture.cleanup); const source = await resumeSource(fixture);
  const manifestPath = join(source, 'manifest.json'); const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.work = [{ kind:'resumext.sync', execution:'supervised', runtime:'node', entry:'bin/worker.mjs' }];
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(source, 'bin/worker.mjs'), `import {spawn} from 'node:child_process'; import {writeFileSync,existsSync,mkdirSync} from 'node:fs'; import {join} from 'node:path'; const dir=join(process.env.BRAIN_EXTENSION_HOME,'tokenstore'); mkdirSync(dir,{recursive:true}); const marker=join(dir,'release'); const child=spawn(process.execPath,['-e',"const fs=require('node:fs');const p=process.argv[1];setInterval(()=>{if(fs.existsSync(p))process.exit(0)},50)",marker],{stdio:'inherit'}); writeFileSync(join(dir,'pids'),JSON.stringify([process.pid,child.pid])); setInterval(()=>{if(existsSync(marker)) { process.stdout.write(JSON.stringify({abi:1,type:'result'})+'\\n'); process.exit(0); }},50);`);
  const first = await fixture.run(['ext','install','resumext','--json']); expect(first.code, first.stdout+first.stderr).toBe(0);
  const target = join(fixture.home,'extensions/resumext'), store = postgresStore({databaseUrl:fixture.db.appUrl});
  const controller = new AbortController(), daemon = runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,groupConfirmMs:2000}});
  const blocker = new pg.Client({connectionString:fixture.db.url}); await blocker.connect();
  let installing: Promise<Awaited<ReturnType<typeof fixture.run>>> | undefined;
  try {
    await expect.poll(async()=>{try{return JSON.parse(await readFile(join(fixture.home,'run/supervisor-ready.json'),'utf8')).pid}catch{return null}},{timeout:10000}).toBe(process.pid);
    const id=uuidV7IdGen().next(), now=new Date(); expect((await store.addWork({id,kind:'resumext.sync',targetKind:'probe',targetId:'a',createdAt:now,nextAttemptAt:now})).ok).toBe(true);
    await expect.poll(async()=>{try{return JSON.parse(await readFile(join(target,'tokenstore/pids'),'utf8')) as number[]}catch{return []}},{timeout:15000}).toHaveLength(2);
    const processes = JSON.parse(await readFile(join(target,'tokenstore/pids'),'utf8')) as number[];
    await expect.poll(async()=> (await fixture.db.rows(`select pid from brain.work_attempts where work_item_id='${id}'`))[0]?.pid,{timeout:10000}).toBe(processes[0]);
    const active = await fixture.db.rows(`select a.pid,a.pgid,a.finished_at,w.current_attempt_token from brain.work_attempts a join brain.work_items w on w.id=a.work_item_id where w.id='${id}'`);
    expect(active[0]).toMatchObject({pid:processes[0],pgid:processes[0],finished_at:null,current_attempt_token:expect.any(String)});
    manifest.version='0.2.0'; await writeFile(manifestPath,JSON.stringify(manifest));
    installing=fixture.run(['ext','install','resumext','--json']);
    await expect.poll(async()=> (await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'")).length,{timeout:10000}).toBe(1);
    expect(JSON.parse(await readFile(join(target,'manifest.json'),'utf8')).version).toBe('0.1.0');
    await expect(stat(join(fixture.home,'extensions/.transition-resumext.json'))).rejects.toThrow();
    for (const pid of processes) expect(()=>process.kill(pid,0)).not.toThrow();
    await blocker.query('begin'); await blocker.query('select id from brain.work_items where id=$1 for update',[id]);
    await writeFile(join(target,'tokenstore/release'),'yes');
    await expect.poll(()=>processes.every(pid=>{try{process.kill(pid,0);return false}catch{return true}}),{timeout:15000}).toBe(true);
    expect((await fixture.db.rows(`select finished_at from brain.work_attempts where work_item_id='${id}'`))[0]?.finished_at).toBeNull();
    await expect(stat(join(fixture.home,'extensions/.transition-resumext.json'))).rejects.toThrow();
    expect(JSON.parse(await readFile(join(target,'manifest.json'),'utf8')).version).toBe('0.1.0');
    await blocker.query('rollback');
    await expect.poll(async()=> (await fixture.db.rows(`select finished_at from brain.work_attempts where work_item_id='${id}'`))[0]?.finished_at,{timeout:15000}).toBeTruthy();
    for (const pid of processes) expect(()=>process.kill(pid,0)).toThrow();
    const completed=await installing; expect(completed.code,completed.stdout+completed.stderr).toBe(0);
    expect(JSON.parse(await readFile(join(target,'manifest.json'),'utf8')).version).toBe('0.2.0');
    expect(await fixture.db.rows("select owner from brain.extension_quiesce where name='resumext'")).toEqual([]);
  } finally { await blocker.query('rollback').catch(()=>{}); await blocker.end(); await writeFile(join(target,'tokenstore/release'),'yes').catch(()=>{}); controller.abort(); await daemon; await installing?.catch(()=>{}); await store.close(); }
}, 60000);
