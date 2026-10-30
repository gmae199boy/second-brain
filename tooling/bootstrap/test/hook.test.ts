import { createHash } from 'node:crypto';
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

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'brain-hook-'));
  bare = join(root, 'second-brain.git');
  home = join(root, 'home');
  plugin = join(root, 'plugin');
  mkdirSync(home, { recursive: true });
  const allowed = join(root, 'allowed-tools');
  mkdirSync(allowed);
  for (const name of ['git', 'docker', 'sh', 'dirname', 'grep', 'head', 'tr', 'sed', 'cat', 'uname', 'which', 'mkdir', 'touch', 'rm', 'sleep']) {
    const found = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
    if (found.status !== 0) throw new Error(`시험 명령을 찾을 수 없습니다: ${name}`);
    symlinkSync(found.stdout.trim(), join(allowed, name));
  }
  symlinkSync(process.execPath, join(allowed, 'node'));
  const pnpm = spawnSync('/usr/bin/which', ['pnpm'], { encoding: 'utf8' }).stdout.trim();
  const wrapper = join(allowed, 'pnpm');
  writeFileSync(wrapper, `#!/bin/sh\nPATH='${process.env.PATH}'\nexport PATH\nunset NODE_OPTIONS BRAIN_PROCESS_SPY BRAIN_RESTRICTED_PATH\nexec '${pnpm}' "$@"\n`);
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
    const result = spawnSync('docker', ['compose', '--env-file', join(home, '.env'), '-f', join(home, 'postgres', 'compose.yaml'), 'down', '-v'], { encoding: 'utf8', timeout: 120_000 });
    if (result.status !== 0) throw new Error(`시험 PostgreSQL 정리에 실패했습니다: ${result.stderr}`);
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
  it('restarts a loaded daemon once after updating the plugin ref and exposes the new build', async () => {
    // The split lifecycle test represents a resident old build using this live
    // test process. The fake records restart delivery; real transition is 9.8.
    mkdirSync(join(home, 'run'), { recursive: true });
    writeFileSync(join(home, 'run', 'daemon.pid'), JSON.stringify({ pid: process.pid,
      boot_at: new Date(Date.now() - uptime() * 1000).toISOString(),
      started_at: new Date().toISOString(), commit: installed().commit }));
    writeFileSync(join(home, 'run', 'heartbeat'), '');
    git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'upgrade']);
    git(['-C', work, 'push', '-q', bare, 'main']);
    snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
    writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`, 'utf8');
    const run = hook('SessionStart');
    expect(run.status).toBe(0);
    expect(installed().commit).toBe(snapshotCommit);
    if (process.platform !== 'darwin') { rmSync(join(home, 'run', 'daemon.pid')); return; }
    expect(log()).toContain('데몬을 다시 띄우지 못했습니다.');
    expect(log()).toContain('기다리는 동안 새 빌드 데몬을 확인하지 못했습니다');
    // The installer logs the DAEMON_NOT_RESTARTED explanation without a code or prefix.
    expect(log()).toContain('데몬을 새 빌드로 다시 띄우지 못해 옛 빌드가 계속 돌 수 있습니다.');
    const label = `io.github.gmae199boy.second-brain.daemon.${createHash('sha256').update(home).digest('hex').slice(0,12)}`;
    const calls = readFileSync(join(root, 'launchctl', 'calls'), 'utf8').split('\n');
    expect(calls.filter((line) => line === `kill SIGTERM gui/${String(process.getuid?.())}/${label}`)).toHaveLength(1);
    expect(calls.filter((line) => line.startsWith('bootstrap '))).toHaveLength(1);
    const plist = readFileSync(join(root, 'launch-agents', `${label}.plist`), 'utf8');
    const argumentsXml = plist.match(/<array>(.*?)<\/array>/s)?.[1] ?? '';
    const args = [...argumentsXml.matchAll(/<string>(.*?)<\/string>/g)].map((match) => (match[1] ?? '').replaceAll('&amp;', '&').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&#13;', '\r'));
    const env = { ...isolatedEnvironment(), SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: configDir,
      SECOND_BRAIN_LAUNCHCTL: join(repoRoot, 'apps/cli/test/fixtures/fake-launchctl.sh'),
      SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'), FAKE_LAUNCHCTL_DIR: join(root, 'launchctl') };
    rmSync(join(home, 'run', 'daemon.pid'));
    const daemon = spawn(args[0]!, args.slice(1), { env, stdio: 'ignore' });
    const closed = new Promise<void>((resolve, reject) => { daemon.on('close', () => resolve()); daemon.on('error', reject); });
    try {
      const deadline = Date.now() + 20_000;
      let status: { alive: boolean; commit: string | null } = { alive: false, commit: null };
      do {
        const checked = spawnSync(join(home, 'bin', 'brain'), ['daemon', 'status', '--json'], { env, encoding: 'utf8' });
        expect(checked.status).toBe(0);
        status = JSON.parse(checked.stdout).data as typeof status;
        if (status.alive) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      } while (Date.now() < deadline);
      expect(status.alive).toBe(true); expect(status.commit).toBe(installed().commit);
    } finally { daemon.kill('SIGTERM'); await closed; }
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


  it('설치된 확장을 갱신할 때 보존하고 새 마이그레이션만 적용한다', async () => {
    const fixtures = join(root, 'extension-fixtures');
    cpSync(join(repoRoot, 'apps/cli/test/fixtures/extensions/testext'), join(fixtures, 'testext'), { recursive: true });
    const sourceManifest = join(fixtures, 'testext/manifest.json');
    const manifest = JSON.parse(readFileSync(sourceManifest, 'utf8'));
    manifest.settings = [{ key: 'testext.limit', type: 'number', required: [] }];
    writeFileSync(sourceManifest, JSON.stringify(manifest));
    const env = { ...isolatedEnvironment(), SECOND_BRAIN_HOME: home, SECOND_BRAIN_TEST_EXTENSIONS: fixtures };
    const brain = (...args: string[]) => spawnSync(join(home, 'bin/brain'), args, { env, encoding: 'utf8' });
    const installedExt = brain('ext', 'install', 'testext', '--json');
    expect(installedExt.status, installedExt.stdout + installedExt.stderr).toBe(0);
    mkdirSync(join(home, 'extensions/.install-interrupted'));
    mkdirSync(join(home, 'extensions/unregistered'));
    const directory = join(home, 'extensions/testext');
    const hash = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');
    const manifestHash = hash(join(directory, 'manifest.json'));
    const ddlHash = hash(join(directory, 'migrations/0001_testext.sql'));
    expect(brain('config', 'set', 'testext.limit', '42', '--json').status).toBe(0);
    const setting = JSON.parse(brain('config', 'get', 'testext.limit', '--json').stdout).data;
    const status = JSON.parse(brain('ext', 'status', 'testext', '--json').stdout).data;
    const config = readFileSync(join(home, 'config.toml'), 'utf8');
    const db = await homeDatabase(true);
    try {
      await db.query('insert into testext.checks values (42, now())');
      writeFileSync(join(directory, 'migrations/0002_new.sql'), 'create table testext.new_table (id integer primary key);');
      const beforeTree = treeHash(directory);
      const upgrade = () => {
        git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'extension upgrade']);
        git(['-C', work, 'push', '-q', bare, 'main']);
        snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
        writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`);
        return hook('SessionStart');
      };
      const beforeLog = log().length;
      expect(upgrade().status, log()).toBe(0);
      expect(log().slice(beforeLog)).toContain('적용 1건');
      expect(installed().commit).toBe(snapshotCommit);
      expect(treeHash(directory)).toBe(beforeTree);
      expect(hash(join(directory, 'manifest.json'))).toBe(manifestHash);
      expect(hash(join(directory, 'migrations/0001_testext.sql'))).toBe(ddlHash);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
      expect(JSON.parse(brain('ext', 'status', 'testext', '--json').stdout).data).toEqual(status);
      expect(JSON.parse(brain('config', 'get', 'testext.limit', '--json').stdout).data).toEqual(setting);
      expect((await db.query('select id from testext.checks')).rows).toEqual([{ id: 42 }]);
      const ledger = (await db.query("select version, checksum, applied_at from brain.schema_migrations where owner='testext' order by version")).rows;
      expect(ledger.map((row: { version: number }) => row.version)).toEqual([1, 2]);
      expect(upgrade().status, log()).toBe(0);
      expect((await db.query("select version, checksum, applied_at from brain.schema_migrations where owner='testext' order by version")).rows).toEqual(ledger);
      const external = join(root, 'external.sql');
      writeFileSync(external, 'create table testext.external_executed (id integer);');
      const link = join(directory, 'migrations/0003_external.sql');
      symlinkSync(external, link);
      const beforeLink = installed().commit;
      upgrade();
      expect(installed().commit).toBe(beforeLink);
      expect(runRecord().last_bootstrap?.result).toBe('failed');
      expect((await db.query("select to_regclass('testext.external_executed') as name")).rows).toEqual([{ name: null }]);
      rmSync(link);
      const manifestPath = join(directory, 'manifest.json');
      const savedManifest = join(root, 'saved-manifest.json');
      renameSync(manifestPath, savedManifest);
      symlinkSync(savedManifest, manifestPath);
      expect(hook('SessionStart').status).toBe(0);
      expect(installed().commit).toBe(beforeLink);
      expect(runRecord().last_bootstrap?.result).toBe('failed');
      rmSync(manifestPath);
      renameSync(savedManifest, manifestPath);
      writeFileSync(join(directory, 'migrations/0003_bad.sql'), 'invalid sql;');
      const before = installed().commit;
      upgrade();
      expect(installed().commit).toBe(before);
      expect(runRecord().last_bootstrap?.result).toBe('failed');
      expect((await db.query("select version from brain.schema_migrations where owner='testext' order by version")).rows).toEqual([{ version: 1 }, { version: 2 }]);
      rmSync(join(directory, 'migrations/0003_bad.sql'));
      expect(hook('SessionStart').status, log()).toBe(0);
      expect(installed().commit).toBe(snapshotCommit);
    } finally { await db.end(); }
    expect(readFileSync(join(root, 'process-spy.log'), 'utf8')).not.toMatch(/(?:^|[\s/'"=])(?:python(?:3(?:\.\d+)?)?|uv)(?:$|[\s/'";])/im);
  }, SLOW);

  it.skipIf(process.env.BRAIN_PYTHON_UPDATE_TEST !== '1')('실제 bootstrap 갱신에서 Python 확장 전체를 보존한다', async () => {
    const spyDir = join(root, 'spy'); mkdirSync(spyDir);
    const spyLog = join(root, 'uv-calls');
    const uv = execFileSync('which', ['uv'], { encoding: 'utf8' }).trim();
    const wrapper = join(spyDir, 'uv');
    writeFileSync(wrapper, `#!/bin/sh\nprintf '%s\n' "$*" >> "${spyLog}"\nexec "${uv}" "$@"\n`);
    chmodSync(wrapper, 0o755);
    const env = { ...isolatedEnvironment(), SECOND_BRAIN_HOME: home, PATH: `${spyDir}:${process.env.PATH ?? ''}`,
      SECOND_BRAIN_TEST_EXTENSIONS: join(repoRoot, 'apps/cli/test/fixtures/extensions') };
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
      await db.query('create schema pyfixture; create table pyfixture.data (id integer); insert into pyfixture.data values (7)');
      const ledger = (await db.query("select * from brain.schema_migrations where owner='pyfixture'")).rows;
      git(['-C', work, '-c', 'user.email=test@example.invalid', '-c', 'user.name=test', 'commit', '--allow-empty', '-q', '-m', 'python upgrade']);
      git(['-C', work, 'push', '-q', bare, 'main']);
      snapshotCommit = git(['-C', work, 'rev-parse', 'HEAD']).trim();
      writeFileSync(join(plugin, 'app-ref'), `${snapshotCommit}\n`);
      expect(hook('SessionStart', '', { PATH: env.PATH, NODE_OPTIONS: '', BRAIN_PROCESS_SPY: '', BRAIN_RESTRICTED_PATH: '' }).status, log()).toBe(0);
      expect(installed().commit).toBe(snapshotCommit);
      expect(readFileSync(spyLog, 'utf8')).toBe('');
      expect(treeHash(directory)).toBe(environment);
      expect(readFileSync(join(home, 'config.toml'), 'utf8')).toBe(config);
      expect(JSON.parse(brain('ext', 'status', 'pyfixture', '--json').stdout).data).toEqual(status);
      expect((await db.query('select id from pyfixture.data')).rows).toEqual([{ id: 7 }]);
      expect((await db.query("select * from brain.schema_migrations where owner='pyfixture'")).rows).toEqual(ledger);
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
