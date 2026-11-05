import { execFileSync, spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withoutHarnessFolders } from '../../../apps/cli/test/environment.js';

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
  writeFileSync(join(root, 'installer-spy.cjs'), `const fs = require('node:fs'); const path = require('node:path');
if (process.argv[1] && process.argv[1].endsWith('/apps/cli/dist/install.js')) {
  const stage = process.env.SECOND_BRAIN_STAGED_APP;
  fs.appendFileSync(${JSON.stringify(join(root, 'installer-spy.log'))}, JSON.stringify({ stage, bin: fs.existsSync(path.join(stage, 'apps/cli/dist/bin.js')), build: JSON.parse(fs.readFileSync(path.join(stage, 'apps/cli/dist/build.json'), 'utf8')) }) + '\\n');
}`);

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
      // cannot ask anything and ends in the exit code that says so (3, "needs
      // a confirmation nobody gave"), naming the consent a non-interactive
      // install needs. That code travelling all the way back out is the
      // handover this test is about.
      expect(first.status).toBe(3);
      expect(first.stdout).toContain(`file://${bare}를 `);
      // The installer sees a built stage; declining consent removes it without promotion.
      const seen = JSON.parse(readFileSync(join(root, 'installer-spy.log'), 'utf8').trim());
      expect(seen.stage).toMatch(new RegExp(`^${home}/\\.app-stage-`));
      expect(seen.bin).toBe(true); expect(seen.build.staged_promotion).toBe(1);
      expect(existsSync(join(home, 'app'))).toBe(false);
      expect(readdirSync(home).filter(name => name.startsWith('.app-stage-'))).toEqual([]);
      expect(first.stdout).toContain('second-brain 0.0.0');
      expect(first.stdout).toContain(`설정 폴더: ${home}`);
      expect(first.stdout).toContain('--yes');
    },
    SLOW,
  );

  it(
    'preserves an existing clone when a staged update lacks consent',
    () => {
      // A pre-existing clone must remain untouched if the installer declines consent.
      const app = join(home, 'app'); git(['clone', '-q', `file://${bare}`, app]);
      mkdirSync(join(app, 'node_modules'));
      writeFileSync(join(app, 'node_modules', 'preserved-fixture'), 'original');
      const second = npx();

      expect(second.status).toBe(3);
      expect(second.stdout).toContain(`file://${bare}를 `);
      expect(second.stdout).toContain('설치기를 시작합니다');
      const seen = readFileSync(join(root, 'installer-spy.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(seen).toHaveLength(2); expect(seen[1].bin).toBe(true);
      expect(seen[1].build.staged_promotion).toBe(1);
      expect(readFileSync(join(app, 'node_modules', 'preserved-fixture'), 'utf8')).toBe('original');
      expect(readdirSync(home).filter(name => name.startsWith('.app-stage-'))).toEqual([]);
      // Same ending as the first run.
      expect(second.stdout).toContain('second-brain 0.0.0');
      expect(second.stdout).toContain(`설정 폴더: ${home}`);
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
      ...withoutHarnessFolders(process.env),
      NODE_OPTIONS: `--require=${join(root, 'installer-spy.cjs')}`,
      SECOND_BRAIN_LAUNCHCTL: join(repoRoot, 'apps/cli/test/fixtures/fake-launchctl.sh'),
      SECOND_BRAIN_LAUNCH_AGENTS: join(root, 'launch-agents'),
      FAKE_LAUNCHCTL_DIR: join(root, 'launchctl'),
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
