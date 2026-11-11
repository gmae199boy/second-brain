import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import pg from 'pg';
import { parseEnv } from 'node:util';
import { tmpdir, uptime } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hookResourcesAvailable, recordHookResources, selectHookRoot } from './hook-resources.js';
import { assertDaemonIdentity } from './hook-daemon-assertions.js';
import { acquireLock, type Lock } from '../../test-db/src/slots/lock.js';
import { lookupProcess } from '../../test-db/src/slots/ledger.js';
import { withoutHarnessFolders } from '../../../apps/cli/test/environment.js';
import {
  BOOTSTRAP_LOG_FILE,
  INSTALLED_FILE,
  LOG_FOLDER,
  PLUGIN_RUN_FILE,
  RUN_FOLDER,
} from '../src/bootstrap.js';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The plugin's install path, whole, with real git and a real build: the
 * launcher finds a node, the bootstrap clones a snapshot of this working tree
 * from a temporary bare repository, builds it, runs the installer, and the
 * installer leaves a completion record naming the very commit the plugin asked
 * for. Then the same thing again, which must do nothing at all.
 *
 * This is the one test that measures the whole of AD-19's install path rather
 * than a step of it. Nothing is pushed anywhere and the real `~/.second_brain`
 * and `~/.claude` are never touched: the configuration folder, the repository
 * URL and the plugin folder are all under a temporary directory.
 *
 * It is slow by nature (a clone, an install and a build), so it gets its own
 * generous timeout rather than the project default.
 */

/** A clone, a pnpm install and a build, on a cold store. */
const SLOW = 900_000;

let root: string;
let bare: string;
let work: string;
let home: string;
let plugin: string;
let snapshotCommit: string;
let configDir: string;

let hookLane: Lock | undefined;
beforeAll(async () => {
  const started = await lookupProcess(process.pid);
  if (!started) throw new Error('hook lane 소유자 신원을 확인하지 못했습니다');
  const runId = process.env.BRAIN_TEST_RUN_ID || randomBytes(12).toString('hex');
  hookLane = await acquireLock('hook-lane', { pid: process.pid, started }, runId);
  console.log(JSON.stringify({ hookLane: 'acquired', waitMs: hookLane.waitMs, runId }));
}, SLOW);

afterAll(async () => {
  if (hookLane) {
    await hookLane.release();
    console.log(JSON.stringify({ hookLane: 'released', runId: hookLane.owner.runId }));
    hookLane = undefined;
  }
}, SLOW);

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  ({ root, home } = selectHookRoot(
    () => mkdtempSync(join(tmpdir(), 'brain-hook-')),
    hookResourcesAvailable,
    candidate => rmSync(candidate, { recursive: true, force: true }),
    candidate => join(candidate, 'home'),
  ));
  recordHookResources(home);
  bare = join(root, 'second-brain.git');
  plugin = join(root, 'plugin');
  mkdirSync(home, { recursive: true });
  const allowed = join(root, 'allowed-tools');
  mkdirSync(allowed);
  for (const name of ['git', 'docker', 'orb', 'sh', 'dirname', 'grep', 'head', 'tr', 'sed', 'cat', 'uname', 'which', 'mkdir', 'touch', 'rm', 'sleep', 'mv', 'cp', 'chmod']) {
    const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
    if (found.status !== 0) throw new Error(`시험 명령을 찾을 수 없습니다: ${name}`);
    symlinkSync(found.stdout.trim(), join(allowed, name));
  }
  // Keep the pinned Node executable in this fixture's restricted tool directory,
  // so subsequent hooks retain the same tool precedence as the first install.
  copyFileSync(process.execPath, join(allowed, 'node'));
  chmodSync(join(allowed, 'node'), 0o755);
  const pnpm = spawnSync('/usr/bin/which', ['pnpm'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = join(allowed, 'pnpm');
  writeFileSync(wrapper, `#!/bin/sh\nprintf '%s %s\\n' "$PWD" "$*" >> '${join(root,'pnpm-calls')}'\nPATH='${process.env.PATH}'\nexport PATH\nunset NODE_OPTIONS BRAIN_PROCESS_SPY BRAIN_RESTRICTED_PATH\nexec '${pnpm}' "$@"\n`);
  chmodSync(wrapper, 0o755);
  configDir = join(root, 'claude-config');
  mkdirSync(join(configDir, 'projects', '-demo'), { recursive: true });
  copyFileSync(join(repoRoot, 'packages/claude-code/test/fixtures/two-turns.jsonl'), join(configDir, 'projects', '-demo', 'first-session.jsonl'));

  work = join(root, 'work');
  snapshot(work);

  git(['init', '-q', '-b', 'main', work]);
  git(['-C', work, 'add', '-A']);
  git([
    '-C',
    work,
    '-c',
    'user.email=test@example.invalid',
    '-c',
    'user.name=test',
    'commit',
    '-q',
    '-m',
    'snapshot',
  ]);
  git(['init', '-q', '--bare', '-b', 'main', bare]);
  // A push, not a bare clone: a local bare clone hardlinks the object files,
  // which has produced an unreadable repository on this machine.
  git(['-C', work, 'push', '-q', bare, 'main']);
  snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();

  // The plugin folder as a marketplace would hand it over, with its `app-ref`
  // pointing at the snapshot rather than at whatever is committed.
  cpSync(join(repoRoot, 'plugin'), plugin, { recursive: true });
  writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`, 'utf8');
});

afterAll(() => {
  if (home !== undefined && existsSync(join(home, 'postgres', 'compose.yaml'))) {
    const compose = ['compose', '--env-file', join(home, '.env'), '-f', join(home, 'postgres', 'compose.yaml')];
    const before = spawnSync('docker', [...compose, 'ps', '-aq'], { encoding: 'utf8', timeout: 120_000 });
    if (before.status !== 0) throw new Error(`시험 PostgreSQL 식별에 실패했습니다: ${before.stderr}`);
    const ids = before.stdout.trim().split('\n').filter(Boolean);
    const result = spawnSync('docker', [...compose, 'down', '-v'], { encoding: 'utf8', timeout: 120_000 });
    if (result.status !== 0) throw new Error(`시험 PostgreSQL 정리에 실패했습니다: ${result.stderr}`);
    for (const id of ids) {
      const check = spawnSync('docker', ['inspect', id], { encoding: 'utf8', timeout: 120_000 });
      if (check.status === 0 || !/no such object/i.test(check.stderr)) throw new Error(`시험 컨테이너 정리를 확인하지 못했습니다: ${id}`);
    }
    console.log(JSON.stringify({ fixtureCompose: 'removed', containers: ids }));
  }
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});
async function homeDatabase(admin = false) {
  const env = parseEnv(readFileSync(join(home, '.env'), 'utf8'));
  const url = new URL(env.BRAIN_DATABASE_URL!);
  if (admin) { url.username = 'postgres'; url.password = env.BRAIN_POSTGRES_PASSWORD!; }
  const client = new pg.Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}


/** The log the bootstrap appends to, or `''` when it has never written one. */
function treeHash(directory: string): string {
  const hash = createHash('sha256');
  const walk = (path: string, relative: string) => {
    const stat = lstatSync(path);
    hash.update(`${relative}\0${stat.mode & 0o777}\0`);
    if (stat.isSymbolicLink()) hash.update(`link\0${readlinkSync(path)}\0`);
    else if (stat.isDirectory()) {
      hash.update('dir\0');
      for (const name of readdirSync(path).sort()) walk(join(path, name), `${relative}/${name}`);
    } else if (stat.isFile()) { hash.update('file\0'); hash.update(readFileSync(path)); }
    else throw new Error(`지원하지 않는 파일: ${relative}`);
  };
  walk(directory, '');
  return hash.digest('hex');
}

function log(): string {
  const path = join(home, LOG_FOLDER, BOOTSTRAP_LOG_FILE);
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

interface Record {
  commit?: string;
  schema_version?: number;
  node?: string;
  plugin_root?: string;
  installed_at?: string;
}

function installed(): Record {
  return JSON.parse(readFileSync(join(home, INSTALLED_FILE), 'utf8')) as Record;
}

interface PluginRun {
  plugin_root?: string;
  app_ref?: string;
  seen_at?: string;
  last_bootstrap?: { at?: string; result?: string; step?: string; log?: string };
}

function runRecordPath(): string {
  return join(home, RUN_FOLDER, PLUGIN_RUN_FILE);
}

function runRecord(): PluginRun {
  return JSON.parse(readFileSync(runRecordPath(), 'utf8')) as PluginRun;
}

/** The temporary home owns its URL, including when the shell exports an empty value. */
function isolatedEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.BRAIN_DATABASE_URL;
  return env;
}

function hook(event: string, input = '', extraEnv: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')) as { hooks: { [event: string]: { hooks: { command: string }[] }[] } };
  const command = hooks.hooks[event]?.[0]?.hooks[0]?.command;
  if (command === undefined) throw new Error(`Missing hook: ${event}`);
  const result = spawnSync('sh', ['-c', command], {
    input,
    cwd: root,
    encoding: 'utf8',
    env: {
      ...isolatedEnvironment(),
      PATH: join(root, 'allowed-tools'),
      SECOND_BRAIN_NODE_DIRS: join(root, 'allowed-tools'),
      NVM_DIR: join(root, 'empty-nvm'),
      BRAIN_RESTRICTED_PATH: join(root, 'allowed-tools'),
      BRAIN_PROCESS_SPY: join(root, 'process-spy.log'),
      NODE_OPTIONS: `--require=${join(repoRoot, 'tooling/bootstrap/test/fixtures/process-spy.cjs')}`,
      SECOND_BRAIN_LAUNCHCTL: join(repoRoot, 'apps/cli/test/fixtures/fake-launchctl.sh'),
      SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'),
      FAKE_LAUNCHCTL_DIR: join(root, 'launchctl'),
      SECOND_BRAIN_HOME: home,
      SECOND_BRAIN_REPO: `file://${bare}`,
      CLAUDE_PLUGIN_ROOT: plugin,
      CLAUDE_CONFIG_DIR: configDir,
      ...extraEnv,
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the plugin SessionStart hook', () => {
  it(
    'clones, builds, installs, and records the commit the plugin asked for',
    async () => {
      const run = hook('SessionStart');

      expect(run.status).toBe(0);
      // At most one line, and it is the JSON a harness turns into a
      // systemMessage: an asynchronous hook's stdout goes to the model.
      const lines = run.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const said = JSON.parse(lines[0] ?? '') as { systemMessage?: string };
      expect(said.systemMessage, log()).toContain(snapshotCommit.slice(0, 7));

      const record = installed();
      expect(record.commit).toBe(snapshotCommit);
      expect(record.plugin_root).toBe(plugin);
      expect(record.schema_version).toBeGreaterThan(0);
      const db = await homeDatabase();
      try {
        expect((await db.query('select ingest_source from brain.sessions where harness_session_id = $1', ['first-session'])).rows[0]).toMatchObject({ ingest_source: 'import' });
      } finally { await db.end(); }

      // The node the shim was pinned to, which is the node a hook will run.
      expect(record.node).toBe(
        readFileSync(join(home, 'bin', 'brain'), 'utf8')
          .split('\n')
          .find((line) => line.startsWith('NODE='))
          ?.slice('NODE='.length)
          .replace(/^'|'$/g, ''),
      );

      // The clone built itself, and the install went all the way through.
      expect(existsSync(join(home, 'app', 'apps', 'cli', 'dist', 'bin.js'))).toBe(true);
      const shim = readFileSync(join(home,'bin/brain'),'utf8');
      expect(shim).toContain(join(home,'app/apps/cli/dist/bin.js'));
      expect(shim).not.toContain('.app-stage-');
      expect(JSON.parse(readFileSync(join(home,'app/apps/cli/dist/build.json'),'utf8')).commit).toBe(record.commit);
      expect(existsSync(join(home, 'config.toml'))).toBe(true);
      expect(existsSync(join(home, 'extensions'))).toBe(false);
      // The lock is released on every ending there is.
      expect(existsSync(join(home, 'install.lock'))).toBe(false);
      // Everything it did on the way is in the log, not in the model's context.
      expect(log()).toContain('설치기를 시작합니다');

      // And the record of the session itself: which plugin folder called, what
      // it asked for, and how this run ended (2.5 human check 1).
      expect(runRecord()).toMatchObject({
        plugin_root: plugin,
        app_ref: snapshotCommit,
        last_bootstrap: {
          result: 'installed',
          log: join(home, LOG_FOLDER, BOOTSTRAP_LOG_FILE),
        },
      });
    },
    SLOW,
  );

  it(
    'does nothing at all on a second session with the same ref',
    () => {
      const before = log();
      const recorded = statSync(runRecordPath()).mtimeMs;

      const run = hook('SessionStart');

      expect(run.status).toBe(0);
      // No line for the model, and no line in the log either: the fast path
      // reads one JSON file and a few lines of TOML and stops.
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
      expect(log()).toBe(before);
      // Including the record: the folder and the ref are the ones in it
      // already, so there is nothing to write (Acceptance).
      expect(statSync(runRecordPath()).mtimeMs).toBe(recorded);
    },
    SLOW,
  );
  it('갱신 전에 기존 데몬을 멈추고 새 빌드를 노출한다', async () => {
    mkdirSync(join(home, 'run'), { recursive: true });
    const lock = join(home, 'run/daemon.pid'), ready = join(root, 'synthetic-daemon-ready'), pidFile = join(root, 'synthetic-daemon-pid');
    const resident = spawn(process.execPath, ['-e', "const fs=require('node:fs');process.on('SIGTERM',()=>{fs.rmSync(process.env.CASE_LOCK,{force:true});process.exit(0)});fs.writeFileSync(process.env.CASE_READY,'ready');setInterval(()=>{},1000)"], { env: { ...isolatedEnvironment(), CASE_LOCK: lock, CASE_READY: ready }, stdio: 'ignore' });
    const residentClosed = new Promise<void>((resolve, reject) => { resident.once('close', () => resolve()); resident.once('error', reject); });
    for (let attempt=0; !existsSync(ready) && attempt<100; attempt++) await new Promise(resolve=>setTimeout(resolve,20));
    expect(existsSync(ready)).toBe(true);
    writeFileSync(pidFile, String(resident.pid));
    writeFileSync(lock, JSON.stringify({ pid: resident.pid, boot_at: new Date(Date.now()-uptime()*1000).toISOString(), started_at:new Date().toISOString(), commit:installed().commit }));
    writeFileSync(join(home, 'run/heartbeat'), '');
    git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'upgrade']);
    git(['-C', work, 'push', '-q', bare, 'main']);
    snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
    writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`, 'utf8');
    let run;
    try { run = hook('SessionStart', '', { FAKE_LAUNCHCTL_PID_FILE: pidFile }); }
    finally { resident.kill('SIGTERM'); await residentClosed; }
    expect(run.status).toBe(0);
    expect(installed().commit).toBe(snapshotCommit);
    if (process.platform !== 'darwin') return;
    expect(runRecord().last_bootstrap?.result).toBe('installed');
    const label = `io.github.gmae199boy.second-brain.daemon.${createHash('sha256').update(home).digest('hex').slice(0,12)}`;
    const calls = readFileSync(join(root, 'launchctl', 'calls'), 'utf8').split('\n');
    expect(calls.filter((line) => line === `bootout gui/${String(process.getuid?.())}/${label}`)).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith('bootstrap '))).toHaveLength(2);
    const plist = readFileSync(join(root, 'launch-agents', `${label}.plist`), 'utf8');
    expect(plist).toContain(join(home,'bin/brain')); expect(plist).not.toContain('.app-stage-');
    const argumentsXml = plist.match(/<array>(.*?)<\/array>/s)?.[1] ?? '';
    const args = [...argumentsXml.matchAll(/<string>(.*?)<\/string>/g)].map((match) => (match[1] ?? '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#13;', '\r'));
    const env = { ...isolatedEnvironment(), SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: configDir,
      SECOND_BRAIN_LAUNCHCTL: join(repoRoot, 'apps/cli/test/fixtures/fake-launchctl.sh'),
      SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'), FAKE_LAUNCHCTL_DIR: join(root, 'launchctl') };
    rmSync(join(home, 'run', 'daemon.pid'), { force: true });
    const daemon = spawn(args[0]!, args.slice(1), { env, stdio: 'ignore' });
    const closed = new Promise<void>((resolve, reject) => { daemon.on('close', () => resolve()); daemon.on('error', reject); });
    try {
      const deadline = Date.now() + 20_000;
      let status: { alive: boolean; commit: string | null; pid: number | null } = { alive: false, commit: null, pid: null };
      do {
        const checked = spawnSync(join(home, 'bin', 'brain'), ['daemon', 'status', '--json'], { env, encoding: 'utf8' });
        expect(checked.status).toBe(0);
        status = JSON.parse(checked.stdout).data as typeof status;
        if (status.alive) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      expect(daemon.pid).toBeDefined();
      const raw = JSON.parse(readFileSync(join(home, 'run', 'daemon.pid'), 'utf8')) as {pid:number;commit:string|null};
      let processAlive = false;
      try { process.kill(daemon.pid!, 0); processAlive = daemon.exitCode === null && daemon.signalCode === null; } catch { /* The identity assertion reports a dead process. */ }
      assertDaemonIdentity(raw, status, daemon.pid!, installed().commit ?? null, snapshotCommit, processAlive);
    } finally { daemon.kill('SIGTERM'); await closed; }
  }, SLOW);

  it('실제 app 승격 뒤 완료 기록 실패를 같은 대상으로 재시도하며 원래 backup을 보존한다', async () => {
    const app = join(home, 'app'), previous = installed().commit!;
    const oldBuild = readFileSync(join(app, 'apps/cli/dist/build.json'));
    const oldBin = readFileSync(join(app, 'apps/cli/dist/bin.js'));
    git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'promotion retry']);
    git(['-C', work, 'push', '-q', bare, 'main']); snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
    writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`);
    const preload = join(root, 'promotion-failure.cjs'), failed = join(root, 'promotion-failed'), observed = join(root, 'promotion-backup-observed');
    writeFileSync(preload, `const fs = require('node:fs'); const path = require('node:path'); const old = fs.promises.writeFile;
fs.promises.writeFile = async function(file,...args) { const p=String(file); if (/installed\\.json\\.\\d+\\.tmp$/.test(p)) { const root=process.env.SECOND_BRAIN_HOME; if (!fs.existsSync(${JSON.stringify(failed)})) { fs.writeFileSync(${JSON.stringify(failed)},'once'); throw new Error('synthetic installed record failure'); } fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({build:fs.readFileSync(path.join(root,'.app-previous/apps/cli/dist/build.json'),'base64'),bin:fs.readFileSync(path.join(root,'.app-previous/apps/cli/dist/bin.js'),'base64')})); } return old.call(this,file,...args); }; require('node:module').syncBuiltinESMExports();
`);
    const env = { NODE_OPTIONS: `--require=${preload}` };
    const first = hook('SessionStart', '', env); expect(first.status, log()).toBe(0);
    expect(runRecord().last_bootstrap).toMatchObject({ result: 'failed', step: '설치기' });
    expect(existsSync(failed), log()).toBe(true);
    const marker = join(home, '.app-promotion.json'), backup = join(home, '.app-previous');
    expect(installed().commit).toBe(previous);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toMatchObject({ target: snapshotCommit, hadPrevious: true, owner: expect.any(String) });
    expect(readFileSync(join(backup, 'apps/cli/dist/build.json'))).toEqual(oldBuild);
    expect(readFileSync(join(backup, 'apps/cli/dist/bin.js'))).toEqual(oldBin);
    const second = hook('SessionStart', '', env); expect(second.status, log()).toBe(0);
    const during = JSON.parse(readFileSync(observed, 'utf8'));
    expect(Buffer.from(during.build, 'base64')).toEqual(oldBuild); expect(Buffer.from(during.bin, 'base64')).toEqual(oldBin);
    expect(installed().commit).toBe(snapshotCommit);
    expect(JSON.parse(readFileSync(join(app, 'apps/cli/dist/build.json'), 'utf8')).commit).toBe(snapshotCommit);
    expect(readFileSync(join(home, 'bin/brain'), 'utf8')).toContain(join(app, 'apps/cli/dist/bin.js'));
    expect(existsSync(marker)).toBe(false); expect(existsSync(backup)).toBe(false);
  }, SLOW);

  it('collects a Stop payload, records its arrival, and ignores a transcript with no conversation', async () => {
    const transcript = join(root, 'stop-transcript.jsonl');
    copyFileSync(join(repoRoot, 'packages/claude-code/test/fixtures/two-turns.jsonl'), transcript);
    const run = hook('Stop', JSON.stringify({ session_id: 'stop-session', transcript_path: transcript }));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(readFileSync(join(home, 'run', 'last-hook-claude-code'), 'utf8')).toBe(`${plugin}\n`);
    const doctor = spawnSync(join(home, 'bin', 'brain'), ['doctor', 'run', '--json'], { encoding: 'utf8', env: { ...isolatedEnvironment(), PATH: join(root, 'allowed-tools'), BRAIN_RESTRICTED_PATH: join(root, 'allowed-tools'), BRAIN_PROCESS_SPY: join(root, 'process-spy.log'), NODE_OPTIONS: `--require=${join(repoRoot, 'tooling/bootstrap/test/fixtures/process-spy.cjs')}`, SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: configDir } });
    expect(doctor.status).toBe(0);
    const report = JSON.parse(doctor.stdout) as { data: { checks: { id: string; status: string; detail: string }[] } };
    expect(report.data.checks.find((check) => check.id === 'last-hook')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/claude-code: \d{4}-/) });
    expect(report.data.checks.find((check) => check.id === 'plugin')).toMatchObject({ status: 'ok', detail: expect.stringContaining(snapshotCommit.slice(0, 7)) });
    const empty = join(root, 'empty-transcript.jsonl');
    writeFileSync(empty, JSON.stringify({ type: 'system', subtype: 'init', sessionId: 'empty-session', timestamp: new Date().toISOString() }) + '\n');
    expect(hook('Stop', JSON.stringify({ session_id: 'empty-session', transcript_path: empty })).status).toBe(0);
    const db = await homeDatabase();
    try {
      const session = (await db.query('select id from brain.sessions where harness_session_id = $1', ['stop-session'])).rows[0] as { id: string };
      expect((await db.query('select count(*)::int as n from brain.messages where session_id = $1', [session.id])).rows[0]).toMatchObject({ n: 4 });
      expect((await db.query('select id from brain.sessions where harness_session_id = $1', ['empty-session'])).rows[0]).toBeUndefined();
    } finally { await db.end(); }
    const calls = readFileSync(join(root, 'process-spy.log'), 'utf8');
    expect(calls).toContain('docker');
    expect(calls).toContain('git');
    expect(calls).not.toMatch(/(?:^|[\s/'"=])(?:python(?:3(?:\.\d+)?)?|uv)(?:$|[\s/'";])/im);
    expect(existsSync(join(home, 'extensions'))).toBe(false);
  }, SLOW);


  it('실제 package 설치와 같은 core bootstrap이 겹쳐도 둘 다 성공하고 일관된다', async () => {
    const name = `race${createHash('sha256').update(root).digest('hex').slice(0, 10)}`;
    const pkg = join(realpathSync(root), 'race-package'); cpSync(join(repoRoot, 'apps/cli/test/fixtures/extensions/testext'), pkg, { recursive: true });
    const manifestPath = join(pkg, 'manifest.json'); const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replaceAll('testext', name));
    const checkPath = join(pkg, 'bin/check.mjs'); writeFileSync(checkPath, readFileSync(checkPath, 'utf8').replaceAll('testext', name));
    Object.assign(manifest, { files:['bin/check.mjs','bin/echo-stats.mjs','manifest.json','migrations/0001_testext.sql'], core_compat:{min:'0.0.0',max_exclusive:'1.0.0'}, plugin_version:'1.0.0' });
    writeFileSync(manifestPath, JSON.stringify(manifest));
    const sqlPath = join(pkg, 'migrations/0001_testext.sql'); writeFileSync(sqlPath, readFileSync(sqlPath,'utf8').replaceAll('testext',name));
    const hash=createHash('sha256'); for(const path of manifest.files as string[]){const data=readFileSync(join(pkg,path)), bytes=Buffer.from(path);hash.update(`f${bytes.length}:`);hash.update(bytes);hash.update(`:${data.length}:`);hash.update(data);}
    const digest=hash.digest('hex'); writeFileSync(join(pkg,'digest'),`${digest}\n`);
    const env: NodeJS.ProcessEnv = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME:home, SECOND_BRAIN_REPO:`file://${bare}`, SECOND_BRAIN_NODE_DIRS:join(root,'allowed-tools'), PATH:join(root,'allowed-tools'), SECOND_BRAIN_LAUNCHCTL:join(repoRoot,'apps/cli/test/fixtures/fake-launchctl.sh'), SECOND_BRAIN_LAUNCH_AGENTS:join(root,'launch-agents'), FAKE_LAUNCHCTL_DIR:join(root,'launchctl') };
    delete env.NODE_OPTIONS; delete env.BRAIN_DATABASE_URL;
    const db=await homeDatabase(true); let installer: ReturnType<typeof spawn> | undefined, bootstrap: ReturnType<typeof spawn> | undefined;
    let installerDone: Promise<{code:number|null;output:string}> | undefined, bootstrapDone: Promise<{code:number|null;output:string}> | undefined;
    const watch=(child:ReturnType<typeof spawn>) => { let output=''; child.stdout?.on('data', chunk=>{output+=String(chunk)}); child.stderr?.on('data', chunk=>{output+=String(chunk)}); return new Promise<{code:number|null;output:string}>(resolve=>child.once('close',code=>resolve({code,output}))); };
    try {
      git(['-C',join(home,'app'),'checkout','-q','main']);
      await db.query('begin'); await db.query('select pg_advisory_xact_lock($1)',[4919270911]);
      installer=spawn(join(home,'bin/brain'),['ext','install','--package',pkg,'--json'],{env,stdio:['ignore','pipe','pipe'],detached:true}); installerDone=watch(installer);
      let installerOutput = '';
      installer.stdout?.on('data', chunk => { installerOutput += String(chunk); });
      installer.stderr?.on('data', chunk => { installerOutput += String(chunk); });
      try { await expect.poll(()=>{try{return JSON.parse(readFileSync(join(home,`extensions/.transition-${name}.json`),'utf8')).phase}catch{return ''}},{timeout:30000}).toBe('prepared'); }
      catch (error) { console.error('package installer before prepared:', installerOutput); throw error; }
      const owner=readFileSync(join(home,'install.lock/owner'),'utf8');
      bootstrap=spawn(process.execPath,[join(plugin,'bootstrap.mjs'),'--yes'],{env,stdio:['ignore','pipe','pipe'],detached:true}); bootstrapDone=watch(bootstrap);
      await new Promise(resolve=>setTimeout(resolve,500)); expect(bootstrap.exitCode).toBeNull(); expect(readFileSync(join(home,'install.lock/owner'),'utf8')).toBe(owner);
      await db.query('rollback'); const first=await installerDone; expect(first.code,first.output).toBe(0);
      const second=await bootstrapDone; expect(second.code,second.output).toBe(0);
      expect(installed().commit).toBe(snapshotCommit);
      expect(JSON.parse(readFileSync(join(home,'app/apps/cli/dist/build.json'),'utf8')).commit).toBe(snapshotCommit);
      const row=(await db.query('select version,package_digest,plugin_version from brain.extensions where name=$1',[name])).rows;
      expect(row).toEqual([{version:'0.1.0',package_digest:digest,plugin_version:'1.0.0'}]);
      expect(readFileSync(join(home,'extensions',name,'manifest.json'),'utf8')).toBe(readFileSync(manifestPath,'utf8'));
      for(const path of manifest.files as string[]) expect(readFileSync(join(home,'extensions',name,path))).toEqual(readFileSync(join(pkg,path)));
      expect((await db.query('select version from brain.schema_migrations where owner=$1 order by version',[name])).rows).toEqual([{version:1}]);
    } finally {
      await db.query('rollback').catch(()=>{});
      for(const child of [installer,bootstrap]) if(child?.exitCode===null && child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch { /* already exited */ } }
      await installerDone; await bootstrapDone;
      await db.query('delete from brain.extension_install_progress where name=$1',[name]); await db.query('delete from brain.extensions where name=$1',[name]); await db.query('delete from brain.schema_migrations where owner=$1',[name]);
      await db.query(`drop schema if exists "${name}" cascade`);
      const role=`brain_ext_${name}`, owned=await db.query("select 1 from pg_roles where rolname=$1 and shobj_description(oid,'pg_authid')='second-brain extension:' || current_database()",[role]);
      if(owned.rowCount) await db.query(`drop owned by "${role}"; drop role "${role}"`);
      await db.end(); rmSync(join(home,'extensions',name),{recursive:true,force:true}); git(['-C',join(home,'app'),'checkout','-q','--detach',snapshotCommit]);
    }
  }, SLOW);

  it('설치된 확장의 다른 commit을 SessionStart가 무질문 갱신하고 기억과 이력을 보존한다', async () => {
    const fixtures = join(root, 'extension-fixtures');
    cpSync(join(repoRoot, 'apps/cli/test/fixtures/extensions/testext'), join(fixtures, 'testext'), { recursive: true });
    const sourceManifest = join(fixtures, 'testext/manifest.json');
    const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8'));
    Object.assign(manifest, { files:['bin/check.mjs','bin/echo-stats.mjs','manifest.json','migrations/0001_testext.sql'], core_compat:{min:'0.0.0',max_exclusive:'1.0.0'}, plugin_version:'1.0.0' });
    writeFileSync(sourceManifest, JSON.stringify(manifest));
    const env = { ...withoutHarnessFolders(process.env), SECOND_BRAIN_HOME: home, SECOND_BRAIN_TEST_EXTENSIONS: fixtures };
    const brain = (...args: string[]) => spawnSync(join(home, 'bin/brain'), args, { env, encoding: 'utf8' });
    const result = brain('ext', 'install', 'testext', '--json'); expect(result.status, result.stdout + result.stderr).toBe(0);
    const directory = join(home, 'extensions/testext');
    writeFileSync(join(directory, 'migrations/0002_new.sql'), 'create table testext.new_table (id integer primary key);');
    const beforeTree = treeHash(directory), previous = installed().commit, app = join(home, 'app');
    const db = await homeDatabase(true);
    try {
      const ledger = (await db.query("select * from brain.schema_migrations where owner='testext' order by version")).rows;
      const registry = (await db.query("select * from brain.extensions where name='testext'")).rows;
      git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'extension upgrade']);
      git(['-C', work, 'push', '-q', bare, 'main']); snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
      writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`);
      const manifestPath = join(directory, 'manifest.json'), original = readFileSync(manifestPath, 'utf8');
      const incompatible = JSON.parse(original); incompatible.core_compat = { min:'1.0.0', max_exclusive:'2.0.0' };
      writeFileSync(manifestPath, JSON.stringify(incompatible));
      try {
        expect(hook('SessionStart').status).toBe(0); expect(runRecord().last_bootstrap?.result).toBe('failed');
        expect(installed().commit).toBe(previous); expect(git(['-C', app, 'rev-parse', 'HEAD']).trim()).toBe(previous);
        expect((await db.query("select * from brain.schema_migrations where owner='testext' order by version")).rows).toEqual(ledger);
      } finally { writeFileSync(manifestPath, original); }
      expect(hook('SessionStart').status, log()).toBe(0);
      expect(runRecord().last_bootstrap?.result, log()).toBe('installed'); expect(installed().commit).toBe(snapshotCommit);
      expect(git(['-C', app, 'rev-parse', 'HEAD']).trim()).toBe(snapshotCommit);
      expect(treeHash(directory)).toBe(beforeTree);
      expect((await db.query("select * from brain.extensions where name='testext'")).rows).toEqual(registry);
      expect((await db.query("select version from brain.schema_migrations where owner='testext' order by version")).rows).toEqual([{version:1},{version:2}]);
      expect((await db.query("select * from brain.schema_migrations where owner='testext' and version=1")).rows).toEqual(ledger);
      expect((await db.query("select to_regclass('testext.new_table') as name")).rows).toEqual([{name:'testext.new_table'}]);
      expect(JSON.parse(readFileSync(join(home, 'run/last-core-update.json'), 'utf8'))).toMatchObject({method:'automatic',evidence:{runtime_backends:0}});
      expect(existsSync(join(home, 'run/core-update.json'))).toBe(false);
      const { installedExtensionMigrations } = await import('../../../apps/cli/dist/runtime/extensions.js');
      const external = join(root, 'external.sql'); writeFileSync(external, 'select 1;');
      const linked = join(directory, 'migrations/0003_external.sql'); symlinkSync(external, linked);
      try { await expect(installedExtensionMigrations(home,['testext'])).rejects.toThrow(); } finally { rmSync(linked); }
    } finally { await db.end(); }
  }, SLOW);

  it.skipIf(process.env.BRAIN_PYTHON_UPDATE_TEST !== '1')('무인 bootstrap 갱신이 Python 확장 환경과 데이터를 보존한다', async () => {
    process.stdout.write('HOOK_PYTHON_PRESERVATION_START\n');
    const spyDir = join(root, 'spy'); mkdirSync(spyDir);
    const spyLog = join(root, 'uv-calls');
    const uv = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    const wrapper = join(spyDir, 'uv');
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\n' "$*" >> "${spyLog}"\nexec "${uv}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const fixtures = join(root, 'python-fixtures'); cpSync(join(repoRoot, 'apps/cli/test/fixtures/extensions/pyfixture'), join(fixtures, 'pyfixture'), { recursive: true });
    const sourceManifest = join(fixtures, 'pyfixture/manifest.json'), compatible = JSON.parse(readFileSync(sourceManifest, 'utf8'));
    Object.assign(compatible, { files: ['.python-version', 'check.py', 'judge.py', 'manifest.json', 'migrations/0001_pyfixture.sql', 'pyproject.toml', 'uv.lock'], core_compat: { min: '0.0.0', max_exclusive: '1.0.0' }, plugin_version: '1.0.0' });
    writeFileSync(sourceManifest, JSON.stringify(compatible));
    const env = { ...isolatedEnvironment(), SECOND_BRAIN_HOME: home, PATH: `${spyDir}:${process.env.PATH ?? ''}`,
      SECOND_BRAIN_TEST_EXTENSIONS: fixtures };
    const brain = (...args: string[]) => spawnSync(join(home, 'bin/brain'), args, { env, encoding: 'utf8' });
    const result = brain('ext', 'install', 'pyfixture', '--json');
    expect(result.status, result.stdout + result.stderr).toBe(0);
    expect(readFileSync(spyLog, 'utf8')).toContain('sync');
    writeFileSync(spyLog, '');
    const directory = join(home, 'extensions/pyfixture');
    const environment = treeHash(directory);
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    const status = JSON.parse(brain('ext', 'status', 'pyfixture', '--json').stdout).data;
    const db = await homeDatabase(true);
    try {
      await db.query('create schema if not exists pyfixture; create table pyfixture.data (id integer); insert into pyfixture.data values (7)');
      const ledger = (await db.query("select * from brain.schema_migrations where owner='pyfixture'")).rows;
      git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'python upgrade']);
      git(['-C', work, 'push', '-q', bare, 'main']);
      snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
      writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`);
      const previous=installed().commit;
      expect(hook('SessionStart', '', { PATH: env.PATH, NODE_OPTIONS: '', BRAIN_PROCESS_SPY: '', BRAIN_RESTRICTED_PATH: '' }).status, log()).toBe(0);
      expect(runRecord().last_bootstrap, log()).toMatchObject({ result: 'installed' });
      expect(installed().commit).toBe(snapshotCommit);
      expect(readFileSync(spyLog, 'utf8')).toBe('');
      expect(treeHash(directory)).toBe(environment);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
      expect(JSON.parse(brain('ext', 'status', 'pyfixture', '--json').stdout).data).toEqual(status);
      expect((await db.query('select id from pyfixture.data')).rows).toEqual([{ id: 7 }]);
      expect((await db.query("select * from brain.schema_migrations where owner='pyfixture'")).rows).toEqual(ledger);
      process.stdout.write('HOOK_PYTHON_PRESERVATION_PASS\n');
    } finally { await db.end(); }
  }, SLOW);

});

/**
 * Everything git would see in a commit of this working tree — tracked files
 * plus anything new that is not ignored, which is how the committed entry
 * point and the plugin folder get in. Ignored files stay out, so the clone has
 * no `node_modules` and no `dist`: it has to build them itself, which is the
 * point.
 */
function snapshot(work: string): void {
  const listed = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  )
    .split('\0')
    .filter((entry) => entry !== '');

  for (const relative of listed) {
    const source = join(repoRoot, relative);
    let entry;
    try {
      // Never `stat`: some entries are symlinks to folders, and this has to
      // copy the link rather than follow it, exactly as git records it.
      entry = lstatSync(source);
    } catch {
      // `ls-files` also lists a tracked file that has been deleted.
      continue;
    }

    const target = join(work, relative);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), target);
    } else if (entry.isFile()) {
      copyFileSync(source, target);
    }
  }
}
