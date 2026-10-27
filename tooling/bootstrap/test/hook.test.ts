import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
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
  configDir = join(root, 'claude-config');
  mkdirSync(join(configDir, 'projects', '-demo'), { recursive: true });
  copyFileSync(join(repoRoot, 'packages/claude-code/test/fixtures/two-turns.jsonl'), join(configDir, 'projects', '-demo', 'first-session.jsonl'));

  const work = join(root, 'work');
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
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

/** The log the bootstrap appends to, or `''` when it has never written one. */
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

function hook(event: string, input = ''): { status: number | null; stdout: string; stderr: string } {
  const hooks = JSON.parse(readFileSync(join(plugin, 'hooks/hooks.json'), 'utf8')) as { hooks: { [event: string]: { hooks: { command: string }[] }[] } };
  const command = hooks.hooks[event]?.[0]?.hooks[0]?.command;
  if (command === undefined) throw new Error(`Missing hook: ${event}`);
  const result = spawnSync('sh', ['-c', command], {
    input,
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SECOND_BRAIN_LAUNCHCTL: join(repoRoot, 'apps/cli/test/fixtures/fake-launchctl.sh'),
      SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'),
      FAKE_LAUNCHCTL_DIR: join(root, 'launchctl'),
      SECOND_BRAIN_HOME: home,
      SECOND_BRAIN_REPO: `file://${bare}`,
      CLAUDE_PLUGIN_ROOT: plugin,
      CLAUDE_CONFIG_DIR: configDir,
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe('the plugin SessionStart hook', () => {
  it(
    'clones, builds, installs, and records the commit the plugin asked for',
    () => {
      const run = hook('SessionStart');

      expect(run.status).toBe(0);
      // At most one line, and it is the JSON a harness turns into a
      // systemMessage: an asynchronous hook's stdout goes to the model.
      const lines = run.stdout.split('\n').filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      const said = JSON.parse(lines[0] ?? '') as { systemMessage?: string };
      expect(said.systemMessage).toContain(snapshotCommit.slice(0, 7));

      const record = installed();
      expect(record.commit).toBe(snapshotCommit);
      expect(record.plugin_root).toBe(plugin);
      expect(record.schema_version).toBeGreaterThan(0);
      const db = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
      try {
        expect(db.prepare('select ingest_source from sessions where harness_session_id = ?').get('first-session')).toMatchObject({ ingest_source: 'import' });
      } finally { db.close(); }

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
  it('collects a Stop payload, records its arrival, and ignores a transcript with no conversation', () => {
    const transcript = join(root, 'stop-transcript.jsonl');
    copyFileSync(join(repoRoot, 'packages/claude-code/test/fixtures/two-turns.jsonl'), transcript);
    const run = hook('Stop', JSON.stringify({ session_id: 'stop-session', transcript_path: transcript }));
    expect(run.status).toBe(0);
    expect(run.stdout).toBe('');
    expect(run.stderr).toBe('');
    expect(readFileSync(join(home, 'run', 'last-hook-claude-code'), 'utf8')).toBe(`${plugin}\n`);
    const doctor = spawnSync(join(home, 'bin', 'brain'), ['doctor', 'run', '--json'], { encoding: 'utf8', env: { ...process.env, SECOND_BRAIN_HOME: home, CLAUDE_CONFIG_DIR: configDir } });
    expect(doctor.status).toBe(0);
    const report = JSON.parse(doctor.stdout) as { data: { checks: { id: string; status: string; detail: string }[] } };
    expect(report.data.checks.find((check) => check.id === 'last-hook')).toMatchObject({ status: 'ok', detail: expect.stringMatching(/claude-code: \d{4}-/) });
    expect(report.data.checks.find((check) => check.id === 'plugin')).toMatchObject({ status: 'ok', detail: expect.stringContaining(snapshotCommit.slice(0, 7)) });
    const empty = join(root, 'empty-transcript.jsonl');
    writeFileSync(empty, JSON.stringify({ type: 'system', subtype: 'init', sessionId: 'empty-session', timestamp: new Date().toISOString() }) + '\n');
    expect(hook('Stop', JSON.stringify({ session_id: 'empty-session', transcript_path: empty })).status).toBe(0);
    const db = new DatabaseSync(join(home, 'brain.db'), { readOnly: true });
    try {
      const session = db.prepare('select id from sessions where harness_session_id = ?').get('stop-session') as { id: string };
      expect(db.prepare('select count(*) as n from messages where session_id = ?').get(session.id)).toMatchObject({ n: 4 });
      expect(db.prepare('select id from sessions where harness_session_id = ?').get('empty-session')).toBeUndefined();
    } finally { db.close(); }
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
