import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * The real thing, with a local repository standing in for GitHub: a snapshot
 * of this working tree is committed to a temporary bare repository and then
 * installed with `npx --yes git+file://…`.
 *
 * This is the one test that measures what was unknown when the story was
 * planned — that npm installs the repository from git without installing a
 * dependency and without running a build, links the committed entry point as a
 * command, and that the entry point then builds its own clone and starts the
 * installer. Nothing is pushed anywhere and the real `~/.second_brain` is never
 * touched: both the configuration folder and the repository URL are pointed at
 * the temporary directory.
 *
 * It is slow by nature (two git clones, two installs, two builds), so it gets
 * its own generous timeout rather than the project default.
 */

/** Two clones, two pnpm installs and two builds, on a cold npx cache. */
const SLOW = 900_000;

let root: string;
let bare: string;
let home: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'brain-npx-'));
  bare = join(root, 'second-brain.git');
  home = join(root, 'home');
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
});

afterAll(() => {
  if (root !== undefined) rmSync(root, { recursive: true, force: true });
});

describe('npx github:gmae199boy/second-brain', () => {
  it(
    'installs without dependencies, builds the clone and starts the installer',
    () => {
      const first = npx();

      expect(first.stderr).not.toContain('npm error');
      // `spawnSync` gives the child pipes, not a terminal, so the installer
      // cannot ask anything and ends in the exit code that says so (2), naming
      // the consent a non-interactive install needs. That code travelling all
      // the way back out is the handover this test is about.
      expect(first.status).toBe(2);
      expect(first.stdout).toContain(`cloning file://${bare}`);
      // The clone built itself: the CLI that story 1.4 left is there.
      expect(existsSync(join(home, 'app', 'apps', 'cli', 'dist', 'bin.js'))).toBe(true);
      expect(first.stdout).toContain('second-brain 0.0.0');
      expect(first.stdout).toContain(`Configuration folder: ${home}`);
      expect(first.stdout).toContain('--yes');
    },
    SLOW,
  );

  it(
    'updates the clone instead of cloning again on a second run',
    () => {
      const second = npx();

      expect(second.status).toBe(2);
      expect(second.stdout).toContain(`updating ${join(home, 'app')}`);
      expect(second.stdout).not.toContain('cloning');
      // Same ending as the first run.
      expect(second.stdout).toContain('second-brain 0.0.0');
      expect(second.stdout).toContain(`Configuration folder: ${home}`);
    },
    SLOW,
  );
});

/**
 * Everything git would see in a commit of this working tree — tracked files
 * plus anything new that is not ignored, which is how the committed entry
 * point gets in. Ignored files stay out, so the clone has no `node_modules`
 * and no `dist`: it has to build them itself, which is the point.
 */
function snapshot(work: string): void {
  const listed = execFileSync(
    'git',
    ['-C', repoRoot, 'ls-files', '-co', '--exclude-standard', '-z'],
    { encoding: 'utf8' },
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

function git(args: readonly string[]): void {
  execFileSync('git', [...args], { stdio: 'pipe' });
}

function npx(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('npx', ['--yes', `git+file://${bare}`], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      SECOND_BRAIN_HOME: home,
      SECOND_BRAIN_REPO: `file://${bare}`,
      // Keep the real npx cache out of it, so the test neither reuses nor
      // leaves behind a cached copy of the repository.
      npm_config_cache: join(root, 'npm-cache'),
      npm_config_update_notifier: 'false',
    },
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
