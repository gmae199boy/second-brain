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
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BOOTSTRAP_LOG_FILE, INSTALLED_FILE, LOG_FOLDER } from '../src/bootstrap.js';

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

function git(args: readonly string[]): string {
  return execFileSync('git', [...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'brain-hook-'));
  bare = join(root, 'second-brain.git');
  home = join(root, 'home');
  plugin = join(root, 'plugin');
  mkdirSync(home, { recursive: true });

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

function sessionStart(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('sh', [join(plugin, 'bin', 'session-start.sh')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SECOND_BRAIN_HOME: home,
      SECOND_BRAIN_REPO: `file://${bare}`,
      CLAUDE_PLUGIN_ROOT: plugin,
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
      const run = sessionStart();

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
    },
    SLOW,
  );

  it(
    'does nothing at all on a second session with the same ref',
    () => {
      const before = log();

      const run = sessionStart();

      expect(run.status).toBe(0);
      // No line for the model, and no line in the log either: the fast path
      // reads one JSON file and a few lines of TOML and stops.
      expect(run.stdout).toBe('');
      expect(run.stderr).toBe('');
      expect(log()).toBe(before);
    },
    SLOW,
  );
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
