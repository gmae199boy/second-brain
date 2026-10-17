import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { clockContract, idGenContract, isUuidV7 } from 'second_brain/testing';
import { systemClock } from '../src/runtime/clock.js';
import { gitRepositoryInspector } from '../src/runtime/git.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

/**
 * The Runtime side of the frame: the same contract cases Core hands to every
 * adapter, run against the real system clock and the real UUIDv7 generator
 * (AD-1: the implementations live here, the contract lives in Core).
 */
describe('systemClock satisfies the clock contract', () => {
  for (const testCase of clockContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => systemClock);
    });
  }
});

describe('uuidV7IdGen satisfies the id contract', () => {
  for (const testCase of idGenContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => uuidV7IdGen());
    });
  }

  it('mints a thousand ids inside one millisecond that still sort in order', () => {
    const idGen = uuidV7IdGen();
    const startedAt = Date.now();
    const ids = Array.from({ length: 1000 }, () => idGen.next());
    const elapsed = Date.now() - startedAt;

    expect(ids.every((id) => isUuidV7(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    // The burst is meant to land inside a millisecond or two; the point of the
    // case is that the ordering holds even then.
    expect(elapsed).toBeLessThan(1000);
  });

  it('carries the current time in the timestamp half of the id', () => {
    const before = Date.now();
    const id = uuidV7IdGen().next();
    const after = Date.now();

    const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('systemClock', () => {
  it('reads the system clock when asked, never at import time (AD-3)', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});

/**
 * `gitRepositoryInspector` against real repositories in a temporary folder.
 * Nothing here touches a configuration of this machine: every repository is
 * made with `-c user.name=…` so no global git setting is read for the identity
 * and none is written.
 */

const run = promisify(execFile);
const scratches: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratches.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/** A temporary folder, with its real path: a macOS `/var` temp is a symlink. */
async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'brain-git-'));
  scratches.push(directory);
  return realpath(directory);
}

/** Identity on the command line only, so nothing of this machine is read. */
const IDENTITY = [
  '-c',
  'user.name=brain-owner',
  '-c',
  'user.email=brain-owner@demo.example',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'init.defaultBranch=main',
];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...IDENTITY, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return stdout;
}

/** A repository with one commit, and a remote unless `remote` is null. */
async function repository(
  remote: string | null = 'git@demo.example:brain-owner/notes.git',
): Promise<string> {
  const path = join(await scratch(), 'repo');
  await mkdir(path, { recursive: true });
  await git(path, 'init', '-q');
  await writeFile(join(path, 'notes.md'), 'the import notes\n', 'utf8');
  await git(path, 'add', 'notes.md');
  await git(path, 'commit', '-q', '-m', 'the first note');
  if (remote !== null) await git(path, 'remote', 'add', 'origin', remote);
  return path;
}

describe('gitRepositoryInspector on a real repository', () => {
  it('answers the top of the working folder, the common directory and the remote', async () => {
    const path = await repository();

    const checkout = await gitRepositoryInspector().inspect(path);

    expect(checkout).toEqual({
      remoteUrl: 'git@demo.example:brain-owner/notes.git',
      commonDir: join(path, '.git'),
      worktreePath: path,
    });
  });

  it('answers the top for a session opened in a sub-folder', async () => {
    const path = await repository();
    const inside = join(path, 'sub', 'dir');
    await mkdir(inside, { recursive: true });

    const checkout = await gitRepositoryInspector().inspect(inside);

    // The worktree is the top, never the folder the harness happened to be in
    // (AD-12).
    expect(checkout?.worktreePath).toBe(path);
    expect(checkout?.commonDir).toBe(join(path, '.git'));
  });

  it('gives two worktrees of one repository the same common directory', async () => {
    const path = await repository();
    const second = join(await scratch(), 'review');
    await git(path, 'worktree', 'add', '-q', second, '-b', 'review');

    const first = await gitRepositoryInspector().inspect(path);
    const added = await gitRepositoryInspector().inspect(await realpath(second));

    // The common directory is what makes two folders of one clone a single
    // project even when there is no remote to name it by (AD-12).
    expect(added?.commonDir).toBe(first?.commonDir);
    expect(added?.worktreePath).not.toBe(first?.worktreePath);
    expect(added?.worktreePath).toBe(await realpath(second));
  });

  it('answers a null remote for a repository that has none', async () => {
    const path = await repository(null);

    const checkout = await gitRepositoryInspector().inspect(path);

    // Not a failure: the caller falls back to the common directory, and the
    // repository is still a project.
    expect(checkout).toEqual({
      remoteUrl: null,
      commonDir: join(path, '.git'),
      worktreePath: path,
    });
  });

  it('prefers origin when the repository has more than one remote', async () => {
    const path = await repository(null);
    // `alt` sorts before `origin`, and git lists remotes alphabetically, so
    // this passes only because `origin` is actually preferred rather than
    // because it happened to come first (Decision 2026-10-18).
    await git(path, 'remote', 'add', 'alt', 'git@demo.example:brain-owner/alt.git');
    await git(path, 'remote', 'add', 'origin', 'git@demo.example:brain-owner/notes.git');

    const checkout = await gitRepositoryInspector().inspect(path);

    expect(checkout?.remoteUrl).toBe('git@demo.example:brain-owner/notes.git');
  });

  it('takes the first remote git lists when there is no origin', async () => {
    const path = await repository(null);
    await git(path, 'remote', 'add', 'upstream', 'git@demo.example:brain-owner/upstream.git');

    const checkout = await gitRepositoryInspector().inspect(path);

    expect(checkout?.remoteUrl).toBe('git@demo.example:brain-owner/upstream.git');
  });

  it('ignores a GIT_DIR in the environment and answers for the folder it was given', async () => {
    const path = await repository();
    const other = await repository('git@demo.example:brain-owner/other.git');
    // What a hook inherits from a shell left inside another repository.
    // `GIT_DIR` wins over `-C <cwd>`, so a tag read under it would belong to
    // a repository the session was never opened in (AD-12).
    process.env['GIT_DIR'] = join(other, '.git');
    process.env['GIT_WORK_TREE'] = other;
    try {
      const checkout = await gitRepositoryInspector().inspect(path);

      expect(checkout).toEqual({
        remoteUrl: 'git@demo.example:brain-owner/notes.git',
        commonDir: join(path, '.git'),
        worktreePath: path,
      });
    } finally {
      delete process.env['GIT_DIR'];
      delete process.env['GIT_WORK_TREE'];
    }
  });
});

describe('gitRepositoryInspector on a folder it can say nothing about', () => {
  it('answers null for a folder that is not a repository', async () => {
    const checkout = await gitRepositoryInspector().inspect(await scratch());

    expect(checkout).toBeNull();
  });

  it('answers null for a path with nothing at it', async () => {
    const checkout = await gitRepositoryInspector().inspect(
      join(await scratch(), 'not', 'there'),
    );

    // The row of the matrix a transcript's own cwd produces once the folder
    // has been deleted: a value, never a throw.
    expect(checkout).toBeNull();
  });

  it('answers null for a relative path, which is no evidence at all', async () => {
    // A relative path would be resolved against this process's own working
    // directory, and the process's cwd is never what a tag rests on (AD-12).
    expect(await gitRepositoryInspector().inspect('.')).toBeNull();
    expect(await gitRepositoryInspector().inspect('sub/dir')).toBeNull();
    expect(await gitRepositoryInspector().inspect('')).toBeNull();
  });

  it("answers null for a bare repository, which is nobody's working folder", async () => {
    const path = join(await scratch(), 'bare.git');
    await mkdir(path, { recursive: true });
    await run('git', [...IDENTITY, 'init', '-q', '--bare', path]);

    const checkout = await gitRepositoryInspector().inspect(path);

    expect(checkout).toBeNull();
  });
});
