#!/usr/bin/env node
// 실제 설치 검증의 소유 자원과 증거를 분리한다.
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, openSync, closeSync, symlinkSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { parseEnv } from 'node:util';

const repo = fileURLToPath(new URL('../../', import.meta.url));
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const write = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
const receiptName = 'ownership.json';

function prepare() {
  const newRef = git('rev-parse', `${readFileSync(join(repo, 'plugin/app-ref'), 'utf8').trim()}^{commit}`);
  // 후보 직전 커밋에도 확장 기능이 있으므로 설치 후 후보 갱신을 검증할 수 있다.
  const baseline = git('rev-parse', `${newRef}^1^{commit}`);
  execFileSync('git', ['-C', repo, 'merge-base', '--is-ancestor', baseline, newRef]);
  if (baseline === newRef) throw new Error('배포 ref 또는 갱신 기준이 예상과 다릅니다.');
  const root = mkdtempSync(join(tmpdir(), 'brain-mac-install-'));
  const home = join(root, 'brain-home');
  const label = `io.github.gmae199boy.second-brain.daemon.${createHash('sha256').update(home).digest('hex').slice(0, 12)}`;
  for (const name of ['brain-home', 'claude-config', 'launch-agents', 'evidence', 'fixtures']) mkdirSync(join(root, name), { recursive: true, mode: 0o700 });
  cpSync(join(repo, 'plugin'), join(root, 'plugin'), { recursive: true });
  cpSync(join(repo, 'apps/cli/test/fixtures/extensions/testext'), join(root, 'fixtures/testext'), { recursive: true });
  const fixture = join(root, 'fixtures/testext');
  const manifestPath = join(fixture, 'manifest.json');
  const manifest = json(manifestPath);
  manifest.auth = { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'bin/login.mjs' };
  manifest.work = [{ kind: 'testext.sync', execution: 'supervised', runtime: 'node', entry: 'bin/check.mjs' }];
  manifest.default_schedules = [{ kind: 'testext.sync', target_kind: 'account', target_id: 'default', local_time: '09:00' }];
  manifest.error_codes = ['LOGIN_REQUIRED'];
  manifest.settings = [{ key: 'testext.tokenstore', type: 'string', machine: 'tokenstore', required: ['auth'] }, { key: 'testext.limit', type: 'number', required: [] }];
  write(manifestPath, manifest);
  writeFileSync(join(fixture, 'bin/login.mjs'), `import { existsSync, mkdirSync } from 'node:fs';
const dir = JSON.parse(process.env.BRAIN_SETTINGS_SNAPSHOT).values['testext.tokenstore'];
mkdirSync(dir, { recursive: true });
if (!existsSync(dir + '/ready')) console.log(JSON.stringify({ abi: 1, type: 'error', code: 'LOGIN_REQUIRED', retryable: false, message: '시험 로그인 미완료' }));
else console.log(JSON.stringify({ abi: 1, type: 'result' }));
`);
  const suffix = createHash('sha256').update(home).digest('hex').slice(0, 12);
  const receipt = { format: 1, id: randomUUID(), root, home, label, project: `second-brain-${suffix}`, volume: `second-brain-pg-${suffix}`, baseline, candidate: newRef, phase: 'prepared' };
  write(join(root, receiptName), receipt);
  console.log(JSON.stringify({ root, baseline, candidate: newRef, label, phase: receipt.phase }, null, 2));
}

function owned(rootArg) {
  if (!rootArg) throw new Error('소유 디렉터리를 지정하세요.');
  const root = resolve(rootArg);
  const receipt = json(join(root, receiptName));
  const suffix = createHash('sha256').update(join(root, 'brain-home')).digest('hex').slice(0, 12);
  if (!basename(root).startsWith('brain-mac-install-') || receipt.format !== 1 || receipt.root !== root || receipt.home !== join(root, 'brain-home') || receipt.project !== `second-brain-${suffix}` || receipt.volume !== `second-brain-pg-${suffix}` || receipt.label !== `io.github.gmae199boy.second-brain.daemon.${suffix}`) throw new Error('소유권 영수증이 일치하지 않습니다.');
  return receipt;
}

function setup(rootArg) {
  const receipt = owned(rootArg), { root, home } = receipt;
  if (receipt.phase !== 'prepared') throw new Error('준비 상태에서만 설치를 시작할 수 있습니다.');
  receipt.phase = 'starting'; write(join(root, receiptName), receipt);
  const plugin = join(root, 'plugin');
  writeFileSync(join(plugin, 'app-ref'), receipt.baseline + '\n');
  const env = { ...process.env, SECOND_BRAIN_HOME: home, SECOND_BRAIN_REPO: pathToFileURL(repo).href,
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'), CLAUDE_PLUGIN_ROOT: plugin,
    SECOND_BRAIN_LAUNCHCTL: join(repo, 'apps/cli/test/fixtures/fake-launchctl.sh'),
    SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'), FAKE_LAUNCHCTL_DIR: join(root, 'launchctl') };
  delete env.BRAIN_DATABASE_URL; delete env.SECOND_BRAIN_TEST_EXTENSIONS;
  const result = spawnSync('sh', [join(plugin, 'bin/session-start.sh')], { env, cwd: root, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(root, 'evidence/bootstrap.txt'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.error || result.status !== 0) throw new Error(`bootstrap 실행 실패: ${result.error?.message ?? result.status}. 영수증과 기록을 보존합니다.`);
  const installed = json(join(home, 'installed.json'));
  if (installed.commit !== receipt.baseline || !existsSync(join(home, 'bin/brain'))) throw new Error('bootstrap 완료 ref를 확인하지 못했습니다.');
  receipt.phase = 'installed'; write(join(root, receiptName), receipt);
  console.log('격리 앱과 PostgreSQL 설치 완료. 영수증과 bootstrap 기록을 보관하세요.');
}

function doctor(rootArg) {
  const { root, home, phase } = owned(rootArg);
  if (phase !== 'installed' || existsSync(join(home, 'extensions'))) throw new Error('확장이 없는 설치 홈이 필요합니다.');
  const allowed = join(root, 'allowed'); mkdirSync(allowed, { recursive: true });
  for (const name of ['git', 'docker', 'sh', 'dirname', 'grep', 'head', 'tr', 'sed', 'cat', 'uname', 'which', 'mkdir', 'touch', 'rm', 'sleep', 'node']) {
    const path = name === 'node' ? process.execPath : execFileSync('which', [name], { encoding: 'utf8' }).trim();
    if (!existsSync(join(allowed, name))) symlinkSync(path, join(allowed, name));
  }
  const spy = join(root, 'evidence/process-spy.log');
  rmSync(spy, { force: true });
  const env = { ...process.env, SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    BRAIN_RESTRICTED_PATH: allowed, BRAIN_PROCESS_SPY: spy,
    NODE_OPTIONS: `--require=${join(repo, 'tooling/bootstrap/test/fixtures/process-spy.cjs')}` };
  delete env.BRAIN_DATABASE_URL;
  const result = spawnSync(join(home, 'bin/brain'), ['doctor', 'run', '--json'], { env, encoding: 'utf8', timeout: 120000 });
  writeFileSync(join(root, 'evidence/doctor.json'), result.stdout, { mode: 0o600 });
  const body = JSON.parse(result.stdout);
  if (result.status !== 0 || !body.ok || !Array.isArray(body.data?.checks) || body.data.checks.some(check => check.status === 'fail') || existsSync(join(home, 'extensions'))) throw new Error('빈 확장 doctor 검증 실패');
  const log = existsSync(spy) ? readFileSync(spy, 'utf8') : '';
  if (/(?:^|[\s/'"=])(?:python(?:3(?:\.\d+)?)?|uv)(?:$|[\s/'";])/im.test(log)) throw new Error('Python 또는 uv 탐색이 관찰되었습니다.');
  console.log('빈 확장 doctor와 Python·uv 미탐색을 확인했습니다.');
}

async function verify(rootArg) {
  const receipt = owned(rootArg), { root, home } = receipt;
  if (receipt.phase !== 'installed') throw new Error('설치 완료 상태가 필요합니다.');
  const plugin = join(root, 'plugin'), evidence = join(root, 'evidence');
  const env = { ...process.env, SECOND_BRAIN_HOME: home, SECOND_BRAIN_REPO: pathToFileURL(repo).href,
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'), CLAUDE_PLUGIN_ROOT: plugin,
    SECOND_BRAIN_TEST_EXTENSIONS: join(root, 'fixtures'),
    SECOND_BRAIN_LAUNCHCTL: join(repo, 'apps/cli/test/fixtures/fake-launchctl.sh'),
    SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'), FAKE_LAUNCHCTL_DIR: join(root, 'launchctl') };
  delete env.BRAIN_DATABASE_URL;
  const brain = (...args) => {
    const result = spawnSync(join(home, 'bin/brain'), [...args, '--json'], { env, encoding: 'utf8', timeout: 120000 });
    let body; try { body = JSON.parse(result.stdout); } catch { throw new Error(`CLI 응답이 JSON이 아닙니다: ${args.join(' ')}`); }
    write(join(evidence, `${String(++sequence).padStart(2, '0')}-${args.join('-')}.json`), body);
    return body;
  };
  let sequence = 0;
  const pause = () => new Promise(resolve => setTimeout(resolve, 500));
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const fd = openSync(join(evidence, 'daemon.log'), 'a', 0o600);
  const daemon = spawn(join(home, 'bin/brain'), ['daemon', 'run'], { env, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  writeFileSync(join(root, 'daemon.pid'), String(daemon.pid), { mode: 0o600 });
  const ended = new Promise(resolve => daemon.once('close', resolve));
  try {
    for (let i = 0; i < 60 && !existsSync(join(home, 'run/supervisor-ready.json')); i++) await pause();
    assert(existsSync(join(home, 'run/supervisor-ready.json')), '데몬 감독자가 준비되지 않았습니다.');
    const first = brain('ext', 'install', 'testext');
    assert(first.error?.code === 'EXTENSION_LOGIN_REQUIRED', '초기 로그인 필요 상태가 아닙니다.');
    const token = join(home, 'extensions/testext/tokenstore');
    for (let i = 0; i < 60 && !existsSync(token); i++) await pause();
    assert(existsSync(token), '시험 로그인 tokenstore가 없습니다.');
    await new Promise(resolve => setTimeout(resolve, 2000));
    writeFileSync(join(token, 'ready'), 'fixture login complete\n');
    let complete;
    for (let i = 0; i < 30; i++) {
      complete = brain('ext', 'install', 'testext');
      if (complete.ok && complete.data?.install?.result === 'installed') break;
      await pause();
    }
    assert(complete?.ok && complete.data?.install?.result === 'installed', '로그인 재개가 완료되지 않았습니다.');
    for (const stage of ['package', 'environment', 'migration', 'role', 'configuration', 'login', 'connection', 'schedule']) assert(['succeeded', 'skipped'].includes(complete.data.install.stages[stage]?.status), `단계 미완료: ${stage}`);
    assert(complete.data.connection?.status === 'connected' && complete.data.install.schedule_ids?.length === 1, '연결 또는 예약 확인 실패');
    const configured = brain('config', 'set', 'testext.limit', '42');
    assert(configured.ok, '시험 설정 저장 실패');
    const vars = parseEnv(readFileSync(join(home, '.env'), 'utf8'));
    const database = new URL(vars.BRAIN_DATABASE_URL).pathname.slice(1);
    assert(/^[a-z][a-z0-9_]*$/.test(database), 'DB 이름 오류');
    const args = ['compose', '--env-file', join(home, '.env'), '-f', join(home, 'postgres/compose.yaml'), 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-tAc'];
    const counts = () => execFileSync('docker', [...args, "select (select count(*) from brain.work_items where kind='testext.login'), (select count(*) from brain.schema_migrations where owner='testext'), (select count(*) from brain.schedules), (select coalesce(string_agg(id::text, ',' order by id::text), '') from brain.schedules)"], { encoding: 'utf8' }).trim();
    const before = brain('ext', 'status', 'testext');
    const countsBefore = counts();
    const repeat = brain('ext', 'install', 'testext');
    const countsAfter = counts();
    write(join(evidence, 'repeat-db.json'), { before: countsBefore, after: countsAfter });
    assert(countsBefore === countsAfter && countsBefore.startsWith('2|1|1|'), '재설치 전후 인증·DDL·예약 이력이 달라졌습니다.');
    assert(repeat.ok && JSON.stringify(repeat.data) === JSON.stringify(before.data), '재설치 상태가 달라졌습니다.');
    const query = sql => execFileSync('docker', [...args, sql], { encoding: 'utf8' }).trim();
    query('insert into testext.checks values (43, now())');
    const preserved = () => ({ tree: treeHash(join(home, 'extensions/testext')),
      setting: query("select value from brain.settings where key='testext.limit' and (user_id is null or user_id=(select id from brain.users where is_self=1)) order by user_id nulls last limit 1"),
      row: query('select id, checked_at from testext.checks where id=43'),
      schedules: query("select count(*) || '|' || coalesce(string_agg(id::text, ',' order by id::text), '') from brain.schedules") });
    const stateBefore = preserved();
    assert(stateBefore.setting === '42' && stateBefore.row.startsWith('43|') && stateBefore.schedules.startsWith('1|'), '전환 전 데이터 확인 실패');
    const disabled = brain('ext', 'disable', 'testext');
    const off = brain('ext', 'status', 'testext');
    assert(disabled.ok && off.data?.enabled === false, '비활성화 확인 실패');
    const stateOff = preserved();
    assert(JSON.stringify(stateBefore) === JSON.stringify(stateOff), '비활성화 뒤 파일 또는 DB 데이터가 달라졌습니다.');
    const enabled = brain('ext', 'enable', 'testext');
    const on = brain('ext', 'status', 'testext');
    assert(enabled.ok && on.data?.enabled === true, '활성화 확인 실패');
    const stateOn = preserved();
    write(join(evidence, 'toggle-preservation.json'), { before: stateBefore, disabled: stateOff, enabled: stateOn });
    assert(JSON.stringify(stateBefore) === JSON.stringify(stateOn), '활성화 뒤 파일 또는 DB 데이터가 달라졌습니다.');
    assert(existsSync(join(token, 'ready')), '활성 전환 중 파일이 사라졌습니다.');
  } finally {
    daemon.kill('SIGTERM');
    const exit = await Promise.race([ended, new Promise(resolve => setTimeout(() => resolve('timeout'), 30000))]);
    if (exit === 'timeout') throw new Error('데몬 종료를 확인하지 못했습니다. PID 기록을 보존합니다.');
    rmSync(join(root, 'daemon.pid'));
  }
  console.log('설치 CLI의 로그인·연결·예약 및 활성 전환을 확인했습니다.');
}

function treeHash(root) {
  const hash = createHash('sha256');
  const walk = (path, relative) => {
    const st = lstatSync(path); hash.update(`${relative}\0${st.mode & 0o777}\0`);
    if (st.isSymbolicLink()) hash.update(`link\0${readlinkSync(path)}\0`);
    else if (st.isDirectory()) { hash.update('dir\0'); for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`); }
    else if (st.isFile()) { hash.update('file\0'); hash.update(readFileSync(path)); }
    else throw new Error('지원하지 않는 확장 파일입니다.');
  };
  walk(root, ''); return hash.digest('hex');
}

function upgrade(rootArg) {
  const receipt = owned(rootArg), { root, home } = receipt;
  if (receipt.phase !== 'installed' || existsSync(join(root, 'daemon.pid'))) throw new Error('설치 완료 및 데몬 종료 상태가 필요합니다.');
  const plugin = join(root, 'plugin');
  const env = { ...process.env, SECOND_BRAIN_HOME: home, SECOND_BRAIN_REPO: pathToFileURL(repo).href,
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'), CLAUDE_PLUGIN_ROOT: plugin,
    SECOND_BRAIN_TEST_EXTENSIONS: join(root, 'fixtures'), SECOND_BRAIN_LAUNCHCTL: join(repo, 'apps/cli/test/fixtures/fake-launchctl.sh'),
    SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'), FAKE_LAUNCHCTL_DIR: join(root, 'launchctl') };
  delete env.BRAIN_DATABASE_URL;
  const cli = () => {
    const result = execFileSync(join(home, 'bin/brain'), ['ext', 'status', 'testext', '--json'], { env, encoding: 'utf8' });
    const body = JSON.parse(result); if (!body.ok) throw new Error('확장 상태 조회 실패'); return body.data;
  };
  const vars = parseEnv(readFileSync(join(home, '.env'), 'utf8'));
  const database = new URL(vars.BRAIN_DATABASE_URL).pathname.slice(1);
  if (!/^[a-z][a-z0-9_]*$/.test(database)) throw new Error('DB 이름 오류');
  const compose = ['compose', '--env-file', join(home, '.env'), '-f', join(home, 'postgres/compose.yaml'), 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-tAc'];
  const sql = query => execFileSync('docker', [...compose, query], { encoding: 'utf8' }).trim();
  sql('insert into testext.checks values (42, now())');
  const setting = () => sql("select exists(select 1 from information_schema.columns where table_schema='brain' and table_name='settings' and column_name='user_id')") === 't'
    ? sql("select value from brain.settings where key='testext.limit' and (user_id is null or user_id=(select id from brain.users where is_self=1)) order by user_id nulls last limit 1")
    : sql("select value from brain.settings where key='testext.limit'");
  const snapshot = () => ({ status: cli(), config: readFileSync(join(home, 'config.toml'), 'utf8'),
    manifest: createHash('sha256').update(readFileSync(join(home, 'extensions/testext/manifest.json'))).digest('hex'),
    ddl: createHash('sha256').update(readFileSync(join(home, 'extensions/testext/migrations/0001_testext.sql'))).digest('hex'),
    tree: treeHash(join(home, 'extensions/testext')),
    tokenstore: createHash('sha256').update(readFileSync(join(home, 'extensions/testext/tokenstore/ready'))).digest('hex'),
    setting: setting(),
    counts: sql("select (select count(*) from testext.checks where id=42), (select count(*) from brain.schedules), (select count(*) from brain.schema_migrations where owner='testext')") });
  const before = snapshot();
  if (before.setting !== '42' || before.counts !== '1|1|1') throw new Error('갱신 전 시험 데이터가 예상과 다릅니다.');
  writeFileSync(join(plugin, 'app-ref'), receipt.candidate + '\n');
  const result = spawnSync('sh', [join(plugin, 'bin/session-start.sh')], { env, cwd: root, encoding: 'utf8', timeout: 900000, maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(join(root, 'evidence/upgrade.txt'), result.stdout + result.stderr, { mode: 0o600 });
  if (result.status !== 0 || json(join(home, 'installed.json')).commit !== receipt.candidate) throw new Error('bootstrap 갱신 실패');
  const after = snapshot();
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('갱신 전후 확장 상태가 달라졌습니다.');
  write(join(root, 'evidence/upgrade-snapshot.json'), { before, after });
  receipt.phase = 'upgraded'; write(join(root, receiptName), receipt);
  console.log('bootstrap 갱신 후 확장 상태와 데이터 보존을 확인했습니다.');
}

function cleanup(rootArg) {
  const receipt = owned(rootArg), { root, home } = receipt;
  if (existsSync(join(root, 'daemon.pid'))) throw new Error('소유 데몬의 종료 확인이 필요합니다.');
  const fakeLaunchctl = join(repo, 'apps/cli/test/fixtures/fake-launchctl.sh');
  const loaded = join(root, 'launchctl/loaded', receipt.label);
  if (existsSync(loaded)) {
    const result = spawnSync(fakeLaunchctl, ['bootout', `gui/${process.getuid()}/${receipt.label}`], { env: { ...process.env, FAKE_LAUNCHCTL_DIR: join(root, 'launchctl') }, encoding: 'utf8' });
    if (result.status !== 0) throw new Error('격리 Label 정리에 실패했습니다.');
  }
  rmSync(join(root, 'launch-agents', `${receipt.label}.plist`), { force: true });
  const compose = join(home, 'postgres/compose.yaml');
  if (existsSync(compose)) {
    const content = readFileSync(compose, 'utf8');
    if (!content.includes(`name: ${receipt.project}\n`) || !content.includes(`name: ${receipt.volume}\n`)) throw new Error('compose 소유권이 일치하지 않습니다.');
    const envFile = join(home, '.env');
    if (!existsSync(envFile)) throw new Error('DB 설정이 없어 정리를 중단합니다.');
    const args = ['compose', '--env-file', envFile, '-f', compose];
    // 컨테이너와 볼륨은 이 홈만 소유한다. role은 DB marker가 일치할 때만 제거한다.
    const sql = `DO $do$ BEGIN IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='brain_ext_testext' AND shobj_description(oid, 'pg_authid')='second-brain extension:' || current_database()) THEN DROP OWNED BY brain_ext_testext; DROP ROLE brain_ext_testext; END IF; END $do$;`;
    const vars = parseEnv(readFileSync(envFile, 'utf8'));
    const database = new URL(vars.BRAIN_DATABASE_URL).pathname.slice(1);
    if (!/^[a-z][a-z0-9_]*$/.test(database)) throw new Error('DB 이름이 올바르지 않습니다.');
    const running = spawnSync('docker', [...args, 'ps', '--status', 'running', '--quiet', 'postgres'], { encoding: 'utf8' });
    if (running.status !== 0) throw new Error('컨테이너 상태 확인 실패: 영수증을 보존합니다.');
    if (running.stdout.trim()) {
      const probe = spawnSync('docker', [...args, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', 'postgres', '-tAc', `select 1 from pg_database where datname = '${database}'`], { encoding: 'utf8' });
      if (probe.status !== 0) throw new Error('DB 확인 실패: 영수증을 보존합니다.');
      if (probe.stdout.trim() === '1') {
        const role = spawnSync('docker', [...args, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-c', sql], { encoding: 'utf8' });
        if (role.status !== 0) throw new Error('role 정리 실패: 영수증과 리소스를 보존합니다.');
      }
    }
    execFileSync('docker', [...args, 'down', '-v'], { stdio: 'pipe', timeout: 120000 });
  }
  rmSync(root, { recursive: true });
  console.log('소유 격리 리소스를 정리했습니다.');
}

async function main() {
  const [command = 'prepare', arg] = process.argv.slice(2);
  if (command === 'prepare') prepare();
  else if (command === 'setup') setup(arg);
  else if (command === 'doctor') doctor(arg);
  else if (command === 'verify') await verify(arg);
  else if (command === 'upgrade') upgrade(arg);
  else if (command === 'cleanup') cleanup(arg);
  else throw new Error('사용법: node tooling/mac-install/run.mjs [prepare | setup|doctor|verify|upgrade|cleanup <소유 디렉터리>]');
}
try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
