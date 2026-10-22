import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(async () => {
  const home = await scratch();
  vi.stubEnv('HOME', home);
  vi.stubEnv('XDG_CONFIG_HOME', join(home, 'xdg'));
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('gitRepositoryInspector on a real repository', () => {
  it('answers the top of the working folder, the common directory and the remote', async () => {
    const path = await repository();

    const checkout = await gitRepositoryInspector().inspect(path);
    if (checkout.kind !== 'checkout') throw new Error(JSON.stringify(checkout));

    expect(checkout.checkout).toEqual({
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
    if (checkout.kind !== 'checkout') throw new Error(JSON.stringify(checkout));

    // The worktree is the top, never the folder the harness happened to be in
    // (AD-12).
    expect(checkout.checkout.worktreePath).toBe(path);
    expect(checkout.checkout.commonDir).toBe(join(path, '.git'));
  });

  it('gives two worktrees of one repository the same common directory', async () => {
    const path = await repository();
    const second = join(await scratch(), 'review');
    await git(path, 'worktree', 'add', '-q', second, '-b', 'review');

    const first = await gitRepositoryInspector().inspect(path);
    if (first.kind !== 'checkout') throw new Error(JSON.stringify(first));
    const added = await gitRepositoryInspector().inspect(await realpath(second));
    if (added.kind !== 'checkout') throw new Error(JSON.stringify(added));

    // The common directory is what makes two folders of one clone a single
    // project even when there is no remote to name it by (AD-12).
    expect(added.checkout.commonDir).toBe(first.checkout.commonDir);
    expect(added.checkout.worktreePath).not.toBe(first.checkout.worktreePath);
    expect(added.checkout.worktreePath).toBe(await realpath(second));
  });

  it('answers a null remote for a repository that has none', async () => {
    const path = await repository(null);

    const checkout = await gitRepositoryInspector().inspect(path);
    if (checkout.kind !== 'checkout') throw new Error(JSON.stringify(checkout));

    // Not a failure: the caller falls back to the common directory, and the
    // repository is still a project.
    expect(checkout.checkout).toEqual({
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
    if (checkout.kind !== 'checkout') throw new Error(JSON.stringify(checkout));

    expect(checkout.checkout.remoteUrl).toBe('git@demo.example:brain-owner/notes.git');
  });

  it('takes the first remote git lists when there is no origin', async () => {
    const path = await repository(null);
    await git(path, 'remote', 'add', 'upstream', 'git@demo.example:brain-owner/upstream.git');

    const checkout = await gitRepositoryInspector().inspect(path);
    if (checkout.kind !== 'checkout') throw new Error(JSON.stringify(checkout));

    expect(checkout.checkout.remoteUrl).toBe('git@demo.example:brain-owner/upstream.git');
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
    if (checkout.kind !== 'checkout') throw new Error(JSON.stringify(checkout));

      expect(checkout.checkout).toEqual({
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
  it('answers not_repository for a folder that is not a repository', async () => {
    const checkout = await gitRepositoryInspector().inspect(await scratch());

    expect(checkout).toEqual({ kind: 'not_repository' });
  });

  it('answers missing for a path with nothing at it', async () => {
    const checkout = await gitRepositoryInspector().inspect(
      join(await scratch(), 'not', 'there'),
    );

    // The row of the matrix a transcript's own cwd produces once the folder
    // has been deleted: a value, never a throw.
    expect(checkout).toEqual({ kind: 'missing' });
  });

  it('answers not_repository for a relative path, which is no evidence at all', async () => {
    // A relative path would be resolved against this process's own working
    // directory, and the process's cwd is never what a tag rests on (AD-12).
    expect(await gitRepositoryInspector().inspect('.')).toEqual({ kind: 'not_repository' });
    expect(await gitRepositoryInspector().inspect('sub/dir')).toEqual({ kind: 'not_repository' });
    expect(await gitRepositoryInspector().inspect('')).toEqual({ kind: 'not_repository' });
  });

  it("answers not_repository for a bare repository, which is nobody's working folder", async () => {
    const path = join(await scratch(), 'bare.git');
    await mkdir(path, { recursive: true });
    await run('git', [...IDENTITY, 'init', '-q', '--bare', path]);

    const checkout = await gitRepositoryInspector().inspect(path);

    expect(checkout).toEqual({ kind: 'not_repository' });
  });
});


describe('gitRepositoryInspector failure classification', () => {
  async function fakeGit(source: string): Promise<string> {
    const command = join(await scratch(), 'git-fixture');
    await writeFile(command, `#!/bin/sh\n${source}\n`, { mode: 0o755 });
    return command;
  }

  it('distinguishes missing git from an absent cwd or a non-directory', async () => {
    const cwd = await scratch();
    const inspector = gitRepositoryInspector({ command: join(cwd, 'missing-git') });
    expect(await inspector.inspect(cwd)).toMatchObject({ kind: 'unknown', reason: 'git_missing' });
    expect(await inspector.inspect(join(cwd, 'missing'))).toEqual({ kind: 'missing' });
    const file = join(cwd, 'file');
    await writeFile(file, '');
    expect(await inspector.inspect(file)).toEqual({ kind: 'not_repository' });
  });

  it('classifies a timed out process and malformed successful output', async () => {
    const cwd = await scratch();
    expect(await gitRepositoryInspector({
      command: await fakeGit('exec /bin/sleep 1'), timeoutMs: 10,
    }).inspect(cwd)).toMatchObject({ kind: 'unknown', reason: 'timeout' });
    expect(await gitRepositoryInspector({
      command: await fakeGit('echo garbage'),
    }).inspect(cwd)).toMatchObject({ kind: 'unknown', reason: 'unexpected' });
  });

  it.each(['dubious ownership', 'Permission denied'])('classifies git permission stderr: %s', async (message) => {
    expect(await gitRepositoryInspector({
      command: await fakeGit(`echo '${message}' >&2; exit 128`),
    }).inspect(await scratch())).toMatchObject({ kind: 'unknown', reason: 'permission' });
  });

  it('classifies inaccessible cwd as permission', async () => {
    if (process.getuid?.() === 0) return;
    const cwd = await scratch();
    await chmod(cwd, 0);
    try {
      expect(await gitRepositoryInspector().inspect(cwd)).toMatchObject({ kind: 'unknown', reason: 'permission' });
    } finally { await chmod(cwd, 0o700); }
  });

  it.each(['remote', 'get-url'])('does not invent a local identity when %s fails', async (phase) => {
    const command = await fakeGit(`
if [ "$3" = rev-parse ]; then
  echo /demo/repo
  echo /demo/repo/.git
elif [ "$3" = remote ] && [ "$4" != get-url ] && [ "${phase}" != remote ]; then
  echo origin
else
  echo 'unexpected failure' >&2
  exit 1
fi`);
    expect(await gitRepositoryInspector({ command }).inspect(await scratch()))
      .toMatchObject({ kind: 'unknown', reason: 'unexpected' });
  });

  it('forces English git diagnostics without inherited LANGUAGE', async () => {
    const old = process.env['LANGUAGE'];
    process.env['LANGUAGE'] = 'ko';
    try {
      const command = await fakeGit('if [ "$LC_ALL" = C ] && [ -z "$LANGUAGE" ]; then echo "not a git repository" >&2; else echo unknown >&2; fi; exit 128');
      expect(await gitRepositoryInspector({ command }).inspect(await scratch())).toEqual({ kind: 'not_repository' });
    } finally {
      if (old === undefined) delete process.env['LANGUAGE'];
      else process.env['LANGUAGE'] = old;
    }
  });
});


describe('저장소 형제 폴더 목록', () => {
  it('폴더와 폴더 링크만 경로순으로 돌려주고 끊어진 링크는 뺀다', async () => {
    const root = await scratch();
    await mkdir(join(root, 'z'));
    await mkdir(join(root, 'a'));
    await writeFile(join(root, 'file'), '일반 파일');
    await symlink(join(root, 'a'), join(root, 'linked'));
    await symlink(join(root, 'absent'), join(root, 'broken'));
    await symlink(join(root, 'file'), join(root, 'file-link'));
    const inspector = gitRepositoryInspector();
    expect(await inspector.listFolders(root)).toEqual({
      kind: 'listed', folders: ['a', 'linked', 'z'].map((name) => join(root, name)),
    });
    expect(await inspector.listFolders(join(root, 'absent'))).toEqual({ kind: 'missing' });
    expect(await inspector.listFolders(join(root, 'file', 'child'))).toEqual({ kind: 'missing' });
    expect(await inspector.inspect(join(root, 'file', 'child'))).toEqual({ kind: 'missing' });
  });
});
