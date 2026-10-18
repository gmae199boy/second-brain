import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_FOLDER,
  BOOTSTRAP_LOG_FILE,
  CONFIG_FILE,
  DEFAULT_HOME_FOLDER,
  DEFAULT_REPO,
  HOME_ENV,
  INSTALLED_FILE,
  LOCK_FOLDER,
  LOCK_PID_FILE,
  LOCK_STALE_MS,
  LOG_FOLDER,
  MIN_NODE_VERSION,
  MIN_PNPM_MAJOR,
  PLUGIN_RUN_FILE,
  PNPM_INSTALL_COMMAND,
  REPO_ENV,
  RUN_FOLDER,
  atLeastVersion,
  childStdio,
  main,
  parseArgs,
  readsUpdateAutoOff,
  resolveHome,
  resolveRepo,
  sameRepo,
  type BootstrapDeps,
  type CommandRequest,
  type CommandResult,
} from '../src/bootstrap.js';
// By path, not by package name: this package depends on nothing but `node:`
// built-ins, so there is no `second_brain` in its own `node_modules` to import
// the check from (`englishSentences` is Core's, under `testing/`).
import { assertKoreanProse } from '../../../packages/core/src/testing/language.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** A fixed home, so an expected command line can be written out in full. */
const HOME = '/tmp/brain-home';
const APP = join(HOME, APP_FOLDER);
const ENV: NodeJS.ProcessEnv = { [HOME_ENV]: HOME };

/** What a fake command answers. Anything left out is "exit 0, no output". */
type Responder = (line: string, request: CommandRequest) => Partial<CommandResult> | undefined;

interface Harness {
  deps: BootstrapDeps;
  /** Every command, as `command arg arg`, in the order it was run. */
  calls: string[];
  lines: string[];
  questions: string[];
  /** The `systemMessage` texts, in order. Hook mode says at most one. */
  messages: string[];
  /** The file the progress lines were redirected to, if any. */
  logPath?: string;
  /** Whether the lock folder is there right now. */
  locked(): boolean;
  /** Every path written, in order, including the temporary ones. */
  writes: string[];
  /** What one file holds now, or `undefined` when there is no such file. */
  file(path: string): string | undefined;
}

interface HarnessOptions {
  respond?: Responder;
  /** Whether `<home>/app` is already there. */
  exists?: boolean;
  isTTY?: boolean;
  /** The answer to every question. */
  answer?: boolean;
  nodeVersion?: string;
  /** The files the run can read, by absolute path. */
  files?: Record<string, string>;
  /** A lock somebody else is holding: its `pid` file, and how old it is. */
  heldLock?: { pid?: number; ageMs?: number };
  /** Which pids are alive, for the stale test. This process's own by default. */
  alive?: readonly number[];
  /**
   * Files the installer leaves behind when it runs, which is how
   * `installed.json` comes to exist part-way through a hook run: the record is
   * written by the installer, and the step after it reads what was written.
   */
  installerWrites?: Record<string, string>;
  /** How many renames fail before one works, for the record that cannot be written. */
  brokenMoves?: number;
}

/** A folder that exists only in the harness's own map of folders. */
const PID = 4242;

/**
 * A machine on which everything is in order: git and a pnpm 12 are installed,
 * and an existing `<home>/app` is a clean clone of the right repository. Each
 * test replaces exactly the one answer its row of the I/O matrix is about.
 */
function healthy(line: string): Partial<CommandResult> | undefined {
  if (line === 'pnpm --version') return { stdout: '12.11.2\n' };
  if (line.endsWith('rev-parse --show-toplevel')) return { stdout: `${APP}\n` };
  if (line.endsWith('remote get-url origin')) return { stdout: `${DEFAULT_REPO}\n` };
  return undefined;
}

/**
 * The machine, as a map of files and folders in memory.
 *
 * The lock is the one thing this file does to the filesystem itself, so it is
 * modelled rather than mocked away: `makeFolder` only succeeds once for a
 * path, which is the whole property the lock rests on.
 */
function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const lines: string[] = [];
  const questions: string[] = [];
  const messages: string[] = [];
  const writes: string[] = [];
  let moves = 0;
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const folders = new Map<string, number>();
  const alive = new Set<number>(options.alive ?? [PID]);
  const now = 1_700_000_000_000;
  let logPath: string | undefined;

  const lock = join(HOME, LOCK_FOLDER);
  if (options.heldLock !== undefined) {
    folders.set(lock, now - (options.heldLock.ageMs ?? 0));
    if (options.heldLock.pid !== undefined) {
      files.set(join(lock, LOCK_PID_FILE), `${String(options.heldLock.pid)}\n`);
    }
  }

  const deps: BootstrapDeps = {
    run: async (request: CommandRequest): Promise<CommandResult> => {
      const line = [request.command, ...request.args].join(' ');
      calls.push(line);
      const scripted = options.respond?.(line, request) ?? healthy(line) ?? {};
      const code = scripted.code ?? 0;
      if (line.startsWith(INSTALLER) && code === 0) {
        for (const [path, text] of Object.entries(options.installerWrites ?? {})) {
          files.set(path, text);
        }
      }
      return { code, stdout: scripted.stdout ?? '' };
    },
    ask: async (question: string): Promise<boolean> => {
      questions.push(question);
      return options.answer ?? false;
    },
    isTTY: options.isTTY ?? true,
    log: (line: string): void => {
      // Every line the installer prints goes through here, so the
      // output-language rule covers all of them at once (Conventions, output
      // language 2026-10-16): a later story that adds an English line fails
      // the first test that reaches it.
      assertKoreanProse(line, { label: 'bootstrap line' });
      lines.push(line);
    },
    message: (text: string): void => {
      assertKoreanProse(text, { label: 'bootstrap systemMessage' });
      messages.push(text);
    },
    logToFile: (path: string): void => {
      logPath = path;
    },
    exists: (path: string) => (path === APP ? (options.exists ?? false) : folders.has(path)),
    realpath: (path: string) => path,
    readText: (path: string) => files.get(path),
    writeText: (path: string, text: string) => {
      writes.push(path);
      files.set(path, text);
    },
    moveFile: (from: string, to: string) => {
      const text = files.get(from);
      // The real one removes the source whatever happens, so a failed write
      // cannot leave a temporary file beside the record.
      files.delete(from);
      moves += 1;
      if (moves <= (options.brokenMoves ?? 0) || text === undefined) return false;
      files.set(to, text);
      return true;
    },
    makeFolder: (path: string) => {
      if (folders.has(path)) return false;
      folders.set(path, now);
      return true;
    },
    makeFolders: (path: string) => {
      if (!folders.has(path)) folders.set(path, now);
    },
    removeFolder: (path: string) => {
      folders.delete(path);
      for (const key of [...files.keys()]) {
        if (key.startsWith(`${path}/`)) files.delete(key);
      }
    },
    folderMtimeMs: (path: string) => folders.get(path),
    alive: (pid: number) => alive.has(pid),
    nowMs: () => now,
    pid: PID,
    nodeVersion: options.nodeVersion ?? '24.16.0',
    nodePath: '/fake/node',
  };

  return {
    deps,
    calls,
    lines,
    questions,
    messages,
    writes,
    file: (path: string) => files.get(path),
    get logPath() {
      return logPath;
    },
    locked: () => folders.has(lock),
  };
}

/**
 * Fall back to the healthy machine for every command the test does not name. A
 * list of answers is given out one per call, which is how a command that is
 * run twice — `pnpm --version`, before and after an install — can answer
 * differently the second time.
 */
function respondWith(
  answers: Record<string, Partial<CommandResult> | readonly Partial<CommandResult>[]>,
): Responder {
  const seen = new Map<string, number>();
  return (line) => {
    const scripted = answers[line];
    if (scripted === undefined) return healthy(line);
    if (!Array.isArray(scripted)) return scripted;
    const index = seen.get(line) ?? 0;
    seen.set(line, index + 1);
    return scripted[Math.min(index, scripted.length - 1)];
  };
}

const INSTALLER = `/fake/node ${join(APP, 'apps', 'cli', 'dist', 'install.js')}`;

describe('resolving where things go', () => {
  it('uses the folder the environment names', () => {
    expect(resolveHome({ [HOME_ENV]: '/somewhere/else' })).toBe('/somewhere/else');
  });

  it('falls back to the default folder under the home directory', () => {
    expect(resolveHome({})).toMatch(new RegExp(`/${DEFAULT_HOME_FOLDER}$`));
  });

  it('ignores an empty override, which is a variable that was never set', () => {
    expect(resolveHome({ [HOME_ENV]: '   ' })).toMatch(new RegExp(`/${DEFAULT_HOME_FOLDER}$`));
  });

  it('clones the published repository unless told otherwise', () => {
    expect(resolveRepo({})).toBe(DEFAULT_REPO);
    expect(resolveRepo({ [REPO_ENV]: 'file:///tmp/fork.git' })).toBe('file:///tmp/fork.git');
  });

  it('treats the trailing slash and the .git suffix as the same repository', () => {
    expect(sameRepo('https://example.com/x.git', 'https://example.com/x')).toBe(true);
    expect(sameRepo('https://example.com/x/', 'https://example.com/x.git')).toBe(true);
    expect(sameRepo('https://example.com/x', 'https://example.com/y')).toBe(false);
  });
});

describe('a first install', () => {
  it('clones, installs, builds and starts the installer, in that order', async () => {
    const run = harness({ exists: false });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual([
      'git --version',
      `git clone ${DEFAULT_REPO} ${APP}`,
      'pnpm --version',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm build',
      INSTALLER,
    ]);
    expect(run.questions).toEqual([]);
  });

  it('clones the repository the environment names, for a fork or a test', async () => {
    const run = harness({ exists: false });

    await main([], { ...ENV, [REPO_ENV]: 'file:///tmp/fork.git' }, run.deps);

    expect(run.calls).toContain(`git clone file:///tmp/fork.git ${APP}`);
  });

  it('passes its own arguments on to the installer', async () => {
    const run = harness({ exists: false });

    await main(['--verbose'], ENV, run.deps);

    expect(run.calls.at(-1)).toBe(`${INSTALLER} --verbose`);
  });

  it('works from an absolute path even when the home is given as a relative one', async () => {
    const run = harness({ exists: false });

    const code = await main([], { [HOME_ENV]: 'relative-home' }, run.deps);

    expect(code).toBe(0);
    // Every step below runs with the clone as its working directory, so a
    // relative path would be resolved against itself once per step.
    const app = resolve('relative-home', APP_FOLDER);
    expect(run.calls).toContain(`git clone ${DEFAULT_REPO} ${app}`);
    expect(run.calls.at(-1)).toBe(`/fake/node ${join(app, 'apps', 'cli', 'dist', 'install.js')}`);
  });

  it('hands back whatever the installer exited with', async () => {
    const run = harness({
      exists: false,
      respond: respondWith({ [INSTALLER]: { code: 7 } }),
    });

    expect(await main([], ENV, run.deps)).toBe(7);
  });
});

describe('a second run', () => {
  it('fast-forwards the existing clone instead of cloning again', async () => {
    const run = harness({ exists: true });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual([
      'git --version',
      `git -C ${APP} rev-parse --show-toplevel`,
      `git -C ${APP} remote get-url origin`,
      `git -C ${APP} status --porcelain`,
      `git -C ${APP} symbolic-ref -q HEAD`,
      `git -C ${APP} pull --ff-only`,
      'pnpm --version',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm build',
      INSTALLER,
    ]);
  });
});

describe('an app folder Brain must not touch', () => {
  it('stops when the folder has local changes, without running git pull', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({ [`git -C ${APP} status --porcelain`]: { stdout: ' M README.md\n' } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).not.toContain(`git -C ${APP} pull --ff-only`);
    expect(run.lines.join('\n')).toContain('로컬 변경이 있으므로');
    expect(run.lines.join('\n')).toContain(`git -C ${APP} status`);
  });

  it('stops when the clone is pinned to a commit by the plugin, without pulling', async () => {
    // A plugin install leaves the clone detached, where `pull --ff-only` fails
    // for want of a branch to track — which used to be reported as a history
    // that had diverged.
    const run = harness({
      exists: true,
      respond: respondWith({ [`git -C ${APP} symbolic-ref -q HEAD`]: { code: 1 } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).not.toContain(`git -C ${APP} pull --ff-only`);
    const said = run.lines.join('\n');
    expect(said).toContain('고정해 둔 클론입니다');
    expect(said).toContain('app-ref');
  });

  it('stops when the clone cannot be fast-forwarded, changing nothing', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({ [`git -C ${APP} pull --ff-only`]: { code: 1 } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    // Nothing was reset, nothing was forced, and the build never started.
    expect(run.calls).toEqual([
      'git --version',
      `git -C ${APP} rev-parse --show-toplevel`,
      `git -C ${APP} remote get-url origin`,
      `git -C ${APP} status --porcelain`,
      `git -C ${APP} symbolic-ref -q HEAD`,
      `git -C ${APP} pull --ff-only`,
    ]);
    expect(run.lines.join('\n')).toContain('fast-forward할 수 없으므로');
  });

  it('stops when the folder is not a git repository at all', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({
        [`git -C ${APP} rev-parse --show-toplevel`]: { code: 128 },
      }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).toEqual([
      'git --version',
      `git -C ${APP} rev-parse --show-toplevel`,
    ]);
    expect(run.lines.join('\n')).toContain('git 클론이 아니므로');
    expect(run.lines.join('\n')).toContain(HOME_ENV);
  });

  it('stops when the folder only sits inside somebody else’s clone', async () => {
    // An empty `<home>/app` under another clone of this same repository: git
    // answers for the enclosing one, whose top level is a folder above.
    const run = harness({
      exists: true,
      respond: respondWith({
        [`git -C ${APP} rev-parse --show-toplevel`]: { stdout: `${HOME}\n` },
      }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    // Above all: the enclosing repository was not pulled.
    expect(run.calls).toEqual(['git --version', `git -C ${APP} rev-parse --show-toplevel`]);
    expect(run.lines.join('\n')).toContain('git 클론이 아니므로');
  });

  it('stops when the clone came from another repository', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({
        [`git -C ${APP} remote get-url origin`]: { stdout: 'https://example.com/other.git\n' },
      }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).not.toContain(`git -C ${APP} pull --ff-only`);
    expect(run.lines.join('\n')).toContain('https://example.com/other.git');
  });
});

describe('pnpm', () => {
  it('is used as it is when it is major 12 or newer', async () => {
    const run = harness({ exists: false });

    await main([], ENV, run.deps);

    expect(run.questions).toEqual([]);
    expect(run.calls).not.toContain('npm install -g pnpm@latest');
    expect(run.lines).toContain('pnpm 12.11.2이 준비되어 있습니다');
  });

  it('is installed after a yes when it is missing', async () => {
    const run = harness({
      exists: false,
      isTTY: true,
      answer: true,
      respond: respondWith({ 'pnpm --version': [{ code: 127 }, { stdout: '12.11.2\n' }] }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.questions).toHaveLength(1);
    expect(run.questions[0]).toContain(PNPM_INSTALL_COMMAND);
    expect(run.calls).toEqual([
      'git --version',
      `git clone ${DEFAULT_REPO} ${APP}`,
      'pnpm --version',
      'npm install -g pnpm@latest',
      // What npm installed is not necessarily what the PATH now finds, so the
      // version is read again before anything is built with it.
      'pnpm --version',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm build',
      INSTALLER,
    ]);
    expect(run.lines.join('\n')).toContain('pnpm이 설치되어 있지 않습니다');
  });

  it('is installed after a yes when it is older than 12', async () => {
    const run = harness({
      exists: false,
      isTTY: true,
      answer: true,
      respond: respondWith({
        'pnpm --version': [{ stdout: '10.34.4\n' }, { stdout: '12.11.2\n' }],
      }),
    });

    expect(await main([], ENV, run.deps)).toBe(0);
    expect(run.lines.join('\n')).toContain(`pnpm 10.34.4은 ${MIN_PNPM_MAJOR}보다 오래되었습니다`);
    expect(run.calls).toContain('npm install -g pnpm@latest');
  });

  it('stops when an older pnpm still comes first on the PATH after the install', async () => {
    const run = harness({
      exists: false,
      isTTY: true,
      answer: true,
      respond: respondWith({ 'pnpm --version': { stdout: '10.34.4\n' } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    // Nothing was built with the pnpm that is still too old.
    expect(run.calls).not.toContain('pnpm install --frozen-lockfile --ignore-scripts');
    const said = run.lines.join('\n');
    expect(said).toContain(
      `\`${PNPM_INSTALL_COMMAND}\` 뒤에도 pnpm 10.34.4은 ${MIN_PNPM_MAJOR}보다 오래되었습니다`,
    );
    expect(said).toContain('which -a pnpm');
  });

  it('stops with the command to run when the answer is no', async () => {
    const run = harness({
      exists: false,
      isTTY: true,
      answer: false,
      respond: respondWith({ 'pnpm --version': { code: 127 } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.questions).toHaveLength(1);
    expect(run.calls).not.toContain('npm install -g pnpm@latest');
    expect(run.lines.join('\n')).toContain(PNPM_INSTALL_COMMAND);
  });

  it('asks nothing outside a terminal and says what to run instead', async () => {
    const run = harness({
      exists: false,
      isTTY: false,
      respond: respondWith({ 'pnpm --version': { code: 127 } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.questions).toEqual([]);
    expect(run.lines.join('\n')).toContain(PNPM_INSTALL_COMMAND);
  });

  it('stops when the installation of pnpm itself fails', async () => {
    const run = harness({
      exists: false,
      isTTY: true,
      answer: true,
      respond: respondWith({
        'pnpm --version': { code: 127 },
        'npm install -g pnpm@latest': { code: 1 },
      }),
    });

    expect(await main([], ENV, run.deps)).toBe(1);
    expect(run.calls).not.toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });
});

describe('required tools', () => {
  it('stops before cloning when node is too old', async () => {
    const run = harness({ exists: false, nodeVersion: '22.14.0' });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).toEqual(['git --version']);
    expect(run.lines.join('\n')).toContain(`node ${MIN_NODE_VERSION} 이상이 필요한데`);
    expect(run.lines.join('\n')).toContain('brew install node');
  });

  it('stops before cloning when git is missing, and says how to get it', async () => {
    const run = harness({
      exists: false,
      respond: respondWith({ 'git --version': { code: 127 } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).toEqual(['git --version']);
    expect(run.lines.join('\n')).toContain('xcode-select --install');
  });

  it('reports everything that is missing at once', async () => {
    const run = harness({
      exists: false,
      nodeVersion: '22.14.0',
      respond: respondWith({ 'git --version': { code: 127 } }),
    });

    await main([], ENV, run.deps);

    expect(run.lines).toHaveLength(2);
  });
});

describe('a step that fails', () => {
  it.each([
    ['pnpm install --frozen-lockfile --ignore-scripts', 'pnpm install'],
    ['pnpm build', 'pnpm build'],
    [`git clone ${DEFAULT_REPO} ${APP}`, 'git clone'],
  ])('names %s and its exit code', async (command, step) => {
    const run = harness({
      exists: false,
      respond: respondWith({ [command]: { code: 3 } }),
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.lines).toContain(`\`${step}\`이 실패했습니다. 종료 코드 3.`);
    expect(run.calls).not.toContain(INSTALLER);
  });
});

/**
 * The entry point is committed as built JavaScript, because npm installs it
 * from git without a build step. These are the fixtures that keep that
 * arrangement honest.
 */
describe('the committed entry point', () => {
  const builds: string[] = [];

  afterAll(() => {
    for (const build of builds) rmSync(build, { recursive: true, force: true });
  });

  it('is exactly what the source compiles to', () => {
    const out = mkdtempSync(join(tmpdir(), 'brain-bootstrap-build-'));
    builds.push(out);
    execFileSync(
      join(packageRoot, 'node_modules', '.bin', 'tsc'),
      ['-p', join(packageRoot, 'tsconfig.json'), '--outDir', out],
      { stdio: 'pipe' },
    );

    expect(readFileSync(join(packageRoot, 'bin', 'second-brain.js'), 'utf8')).toBe(
      readFileSync(join(out, 'bootstrap.js'), 'utf8'),
    );
  });

  it('starts with a shebang, so npm can link it as a command', () => {
    const built = readFileSync(join(packageRoot, 'bin', 'second-brain.js'), 'utf8');

    expect(built.startsWith('#!/usr/bin/env node\n')).toBe(true);
  });

  it.each([
    ['the source', join(packageRoot, 'src', 'bootstrap.ts')],
    ['the built file', join(packageRoot, 'bin', 'second-brain.js')],
  ])('imports nothing but node built-ins in %s', (_what, path) => {
    const specifiers = [...readFileSync(path, 'utf8').matchAll(/^import .* from '([^']+)';$/gm)].map(
      (match) => match[1],
    );

    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((specifier) => !specifier?.startsWith('node:'))).toEqual([]);
  });
});

/**
 * `npx github:…` must install this repository without installing anything and
 * without building anything, which is only true as long as the root manifest
 * stays this shape. The boundary test of `second_brain` guards the same root
 * from the other side.
 */
describe('the root manifest', () => {
  interface RootManifest {
    bin?: Record<string, string>;
    files?: string[];
    engines?: Record<string, string>;
    scripts?: Record<string, string>;
    packageManager?: string;
    dependencies?: Record<string, string>;
  }

  const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as RootManifest;

  it('exposes the committed entry point as the one command', () => {
    expect(root.bin).toEqual({ 'second-brain': 'tooling/bootstrap/bin/second-brain.js' });
  });

  it('packs the entry point and nothing else', () => {
    expect(root.files).toEqual(['tooling/bootstrap/bin/second-brain.js']);
  });

  it.each(['prepare', 'prepack', 'preinstall', 'install', 'postinstall'])(
    'has no %s script, which npm would run on a git install',
    (lifecycle) => {
      expect(root.scripts?.[lifecycle]).toBeUndefined();
    },
  );

  it('declares no dependencies for npm to install', () => {
    expect(root.dependencies).toBeUndefined();
  });

  it('asks for a pnpm of 12 or newer without pinning one', () => {
    expect(root.engines?.pnpm).toBe(`>=${MIN_PNPM_MAJOR}`);
    // A pin that the running pnpm cannot switch to fails before any work
    // starts, so there is none (AD: 2026-10-13).
    expect(root.packageManager).toBeUndefined();
  });

  it('asks for exactly the node the entry point checks for', () => {
    // One floor, major, minor and patch: `node:sqlite` became a release
    // candidate in 24.15.0 and `crypto.randomUUIDv7` arrived in 24.16.0, so a
    // major-only check accepts a node the clone then fails to build on.
    //
    // Nothing enforces it at install time: pnpm 12.11.2 does not fail an
    // install on `engines.node` here (measured 2026-10-14), so the manifest is
    // a statement of the requirement and the entry point is the gate.
    expect(root.engines?.node).toBe(`>=${MIN_NODE_VERSION}`);
  });
});

/**
 * The floor is spelled twice — here and in `apps/cli/src/runtime/node-floor.ts`
 * — because this file may import nothing. The comparison is the same rule, so
 * the two have to agree on the floor and on what passes it.
 */
describe('the node floor', () => {
  const nodeFloor = readFileSync(
    join(repoRoot, 'apps', 'cli', 'src', 'runtime', 'node-floor.ts'),
    'utf8',
  );

  it('is the one the CLI declares', () => {
    expect(nodeFloor).toContain(`export const NODE_FLOOR = '${MIN_NODE_VERSION}';`);
  });

  it('compares major, minor and patch as numbers and not as text', () => {
    expect(atLeastVersion('24.16.0', MIN_NODE_VERSION)).toBe(true);
    expect(atLeastVersion('v24.16.0', MIN_NODE_VERSION)).toBe(true);
    expect(atLeastVersion('25.0.0', MIN_NODE_VERSION)).toBe(true);
    // The two a major-only check used to let through, and the one every string
    // comparison gets wrong: "9" > "24" as text.
    expect(atLeastVersion('24.15.0', MIN_NODE_VERSION)).toBe(false);
    expect(atLeastVersion('24.9.0', MIN_NODE_VERSION)).toBe(false);
    expect(atLeastVersion('', MIN_NODE_VERSION)).toBe(false);
  });
});

/**
 * The entry point cannot import `apps/cli/src/config/paths.ts`: at install
 * time there is nothing built to import. So the two spellings of the rule are
 * tied together here, rather than left to drift apart quietly.
 */
describe('the configuration folder rule', () => {
  const paths = readFileSync(join(repoRoot, 'apps', 'cli', 'src', 'config', 'paths.ts'), 'utf8');

  it.each([
    ['HOME_ENV', HOME_ENV],
    ['DEFAULT_HOME_FOLDER', DEFAULT_HOME_FOLDER],
    ['CONFIG_FILE', CONFIG_FILE],
    // The two files both sides touch: the record this file reads to decide
    // whether to do anything, and the lock they take turns holding.
    ['INSTALLED_FILE', INSTALLED_FILE],
    ['LOCK_FOLDER', LOCK_FOLDER],
    ['LOCK_PID_FILE', LOCK_PID_FILE],
    ['LOG_FOLDER', LOG_FOLDER],
    ['BOOTSTRAP_LOG_FILE', BOOTSTRAP_LOG_FILE],
    // The record this file writes and the `plugin` check reads.
    ['RUN_FOLDER', RUN_FOLDER],
    ['PLUGIN_RUN_FILE', PLUGIN_RUN_FILE],
  ])('agrees with the CLI on %s', (constant, value) => {
    expect(paths).toContain(`export const ${constant} = '${value}';`);
  });
});

/** A commit, as `--ref` takes one and as `installed.json` records one. */
const REF = 'c'.repeat(40);

/** Another, for the rows about a record that names something else. */
const OTHER = 'd'.repeat(40);

const INSTALLED_PATH = join(HOME, INSTALLED_FILE);
const CONFIG_PATH = join(HOME, CONFIG_FILE);
const RUN_PATH = join(HOME, RUN_FOLDER, PLUGIN_RUN_FILE);

/** The record a session with this plugin folder and this ref left behind. */
function saw(root: string, ref: string, last?: Record<string, unknown>): string {
  return JSON.stringify({
    plugin_root: root,
    app_ref: ref,
    seen_at: '2026-10-17T00:00:00.000Z',
    ...(last === undefined ? {} : { last_bootstrap: last }),
  });
}

/** The `installed.json` a finished install of `commit` left behind. */
function record(commit: string): string {
  return JSON.stringify({
    commit,
    schema_version: 4,
    node: '/opt/homebrew/bin/node',
    plugin_root: '/plugin',
    installed_at: '2026-10-17T00:00:00.000Z',
  });
}

/** `git -C <app> …`, as the harness records a call. */
function git(...args: readonly string[]): string {
  return `git -C ${APP} ${args.join(' ')}`;
}

/** Hook mode's own arguments: the ref it consumes, and what it passes on. */
const HOOK_ARGS = ['--yes', '--ref', REF, '--plugin-root', '/plugin'] as const;

/** What the installer is started with in hook mode: everything but the ref. */
const HOOK_INSTALLER = `${INSTALLER} --yes --plugin-root /plugin`;

/** A machine where every git question about `REF` answers the happy way. */
function atRef(line: string): Partial<CommandResult> | undefined {
  if (line === git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`)) return { stdout: REF };
  if (line === git('merge-base', '--is-ancestor', 'HEAD', REF)) return { code: 0 };
  return healthy(line);
}

describe('parseArgs', () => {
  it('takes the ref for itself and passes everything else on', () => {
    expect(parseArgs([...HOOK_ARGS])).toEqual({
      ref: REF,
      // Read on the way past and still passed on: the installer records it,
      // and hook mode needs it for the sessions that never reach the installer.
      pluginRoot: '/plugin',
      rest: ['--yes', '--plugin-root', '/plugin'],
    });
  });

  it('reads no plugin root from a --plugin-root with nothing after it', () => {
    expect(parseArgs(['--ref', REF, '--plugin-root'])).toEqual({ ref: REF, rest: ['--plugin-root'] });
    expect(parseArgs(['--ref', REF, '--plugin-root', '--yes'])).toEqual({
      ref: REF,
      rest: ['--plugin-root', '--yes'],
    });
  });

  it('records no relative plugin root, and still passes it on untouched', () => {
    // The installer refuses a relative path, and a hook's working directory is
    // whatever the harness was started in.
    expect(parseArgs(['--ref', REF, '--plugin-root', 'plugin'])).toEqual({
      ref: REF,
      rest: ['--plugin-root', 'plugin'],
    });
  });

  it('is npx mode when there is no ref', () => {
    expect(parseArgs(['--yes'])).toEqual({ rest: ['--yes'] });
  });

  it('drops a --ref with nothing after it rather than installing something else', () => {
    expect(parseArgs(['--yes', '--ref'])).toEqual({ rest: ['--yes'] });
    expect(parseArgs(['--ref', '--yes'])).toEqual({ rest: ['--yes'] });
  });
});

describe('reading [update] auto without a TOML parser', () => {
  it('finds a plain false under the update table', () => {
    expect(readsUpdateAutoOff('[update]\nauto = false\n')).toBe(true);
    expect(readsUpdateAutoOff('[store]\npath = "/x"\n\n[update]\nauto = false\n')).toBe(true);
    expect(readsUpdateAutoOff('[update]\nauto=false  # 꺼 둡니다\n')).toBe(true);
  });

  it('reads anything else as on, which is the codec default', () => {
    expect(readsUpdateAutoOff('')).toBe(false);
    expect(readsUpdateAutoOff('[update]\nauto = true\n')).toBe(false);
    // The same key in another table is another key.
    expect(readsUpdateAutoOff('[plugin]\nauto = false\n')).toBe(false);
    // Shapes this reading cannot be sure about are left to the codec.
    expect(readsUpdateAutoOff('update = { auto = false }\n')).toBe(false);
    expect(readsUpdateAutoOff('[update]\nauto = \\\n  false\n')).toBe(false);
  });
});

describe('the install lock', () => {
  it('is taken for the whole of an npx install and released at the end', async () => {
    const run = harness({ exists: false });

    expect(await main([], ENV, run.deps)).toBe(0);
    expect(run.locked()).toBe(false);
  });

  it('is released when a step fails', async () => {
    const run = harness({
      exists: false,
      respond: respondWith({ 'pnpm build': { code: 1 } }),
    });

    expect(await main([], ENV, run.deps)).toBe(1);
    expect(run.locked()).toBe(false);
  });

  it('stops an npx install that somebody else is already doing', async () => {
    const run = harness({ exists: false, heldLock: { pid: 777 }, alive: [777] });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual(['git --version']);
    expect(run.lines.join('\n')).toContain('다른 설치가 진행 중입니다');
  });

  it('stops a hook run that somebody else is already doing, saying nothing', async () => {
    const run = harness({ exists: true, heldLock: { pid: 777 }, alive: [777] });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.messages).toEqual([]);
    expect(run.calls).toEqual(['git --version']);
  });

  it('reclaims a lock whose owning process is gone', async () => {
    // The pid settles it: an owner that is gone cannot come back, however
    // recently the folder was touched.
    const run = harness({
      exists: false,
      heldLock: { pid: 777 },
      alive: [PID],
      respond: atRef,
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toContain(`git clone ${DEFAULT_REPO} ${APP}`);
  });

  it('reclaims a lock nobody has touched for half an hour, with no pid in it', async () => {
    const run = harness({
      exists: false,
      heldLock: { ageMs: LOCK_STALE_MS + 60_000 },
    });

    expect(await main([], ENV, run.deps)).toBe(0);
  });

  it('leaves a young lock with no pid in it alone', async () => {
    const run = harness({ exists: false, heldLock: { ageMs: 60_000 } });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual(['git --version']);
  });
});

describe('hook mode on a first install', () => {
  it('runs clone, install, build and the installer, in that order', async () => {
    const run = harness({ exists: false, respond: atRef });

    await main([...HOOK_ARGS], ENV, run.deps);

    expect(run.calls).toEqual([
      'git --version',
      `git clone --no-checkout ${DEFAULT_REPO} ${APP}`,
      git('checkout', '--detach', REF),
      'pnpm --version',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm build',
      HOOK_INSTALLER,
    ]);
    // Nothing is asked: a hook has no terminal and nobody to answer it.
    expect(run.questions).toEqual([]);
  });

  it('sends its progress lines to the log file, not to stdout', async () => {
    const run = harness({ exists: false, respond: atRef });

    await main([...HOOK_ARGS], ENV, run.deps);

    expect(run.logPath).toBe(join(HOME, LOG_FOLDER, BOOTSTRAP_LOG_FILE));
  });
});

describe('hook mode when there is nothing to do', () => {
  it('says nothing and spawns nothing when the record already names the ref', async () => {
    const run = harness({ exists: true, files: { [INSTALLED_PATH]: record(REF) } });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.messages).toEqual([]);
    expect(run.lines).toEqual([]);
  });

  it('says nothing when [update] auto is off and something is already installed', async () => {
    const run = harness({
      exists: true,
      files: {
        [INSTALLED_PATH]: record(OTHER),
        [CONFIG_PATH]: 'schema_version = 1\n\n[update]\nauto = false\n',
        // The plugin has not moved since the last session, so this is the
        // ordinary fast path and touches nothing at all.
        [RUN_PATH]: saw('/plugin', REF),
      },
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual([]);
    expect(run.messages).toEqual([]);
  });

  it('installs anyway when auto is off and nothing is installed yet', async () => {
    // A first install is not an update: there is no installation for the
    // setting to be about.
    const run = harness({
      exists: false,
      respond: atRef,
      files: { [CONFIG_PATH]: '[update]\nauto = false\n' },
    });

    await main([...HOOK_ARGS], ENV, run.deps);

    expect(run.calls).toContain(`git clone --no-checkout ${DEFAULT_REPO} ${APP}`);
  });

  it('says nothing when the plugin is behind what is installed', async () => {
    const run = harness({
      exists: true,
      files: { [INSTALLED_PATH]: record(OTHER) },
      respond: respondWith({
        [git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`)]: { stdout: REF },
        [git('merge-base', '--is-ancestor', REF, OTHER)]: { code: 0 },
      }),
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.messages).toEqual([]);
    expect(run.calls).not.toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });

  it('says nothing when the two histories have diverged', async () => {
    const run = harness({
      exists: true,
      files: { [INSTALLED_PATH]: record(OTHER) },
      respond: respondWith({
        [git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`)]: { stdout: REF },
        [git('merge-base', '--is-ancestor', REF, OTHER)]: { code: 1 },
        [git('merge-base', '--is-ancestor', OTHER, REF)]: { code: 1 },
      }),
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.messages).toEqual([]);
    expect(run.calls).not.toContain(git('checkout', '--detach', REF));
  });
});

describe('hook mode on a clone it has to move forward', () => {
  it('fetches, checks the three relations, and detaches at the ref', async () => {
    const run = harness({
      exists: true,
      files: { [INSTALLED_PATH]: record(OTHER) },
      respond: respondWith({
        [git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`)]: { stdout: REF },
        [git('merge-base', '--is-ancestor', REF, OTHER)]: { code: 1 },
        [git('merge-base', '--is-ancestor', OTHER, REF)]: { code: 0 },
        [git('merge-base', '--is-ancestor', 'HEAD', REF)]: { code: 0 },
        [`${INSTALLER} --yes --plugin-root /plugin`]: { code: 0 },
      }),
    });

    await main([...HOOK_ARGS], ENV, run.deps);

    expect(run.calls).toEqual([
      'git --version',
      git('rev-parse', '--show-toplevel'),
      git('remote', 'get-url', 'origin'),
      git('status', '--porcelain'),
      git('fetch', 'origin'),
      git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`),
      git('merge-base', '--is-ancestor', REF, OTHER),
      git('merge-base', '--is-ancestor', OTHER, REF),
      git('merge-base', '--is-ancestor', 'HEAD', REF),
      git('checkout', '--detach', REF),
      'pnpm --version',
      'pnpm install --frozen-lockfile --ignore-scripts',
      'pnpm build',
      HOOK_INSTALLER,
    ]);
  });

  it('refuses a clone whose HEAD is not an ancestor of the ref, and checks nothing out', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({
        [git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`)]: { stdout: REF },
        [git('merge-base', '--is-ancestor', 'HEAD', REF)]: { code: 1 },
      }),
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).not.toContain(git('checkout', '--detach', REF));
    expect(run.messages[0]).toContain('저장소 준비');
    expect(run.lines.join('\n')).toContain('조상이 아니므로');
  });

  it('refuses a clone with local changes, as the npx door does', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({ [git('status', '--porcelain')]: { stdout: ' M README.md\n' } }),
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(1);
    expect(run.calls).not.toContain(git('fetch', 'origin'));
    expect(run.messages).toHaveLength(1);
  });

  it('refuses when the ref the plugin names is not in the clone', async () => {
    const run = harness({
      exists: true,
      respond: respondWith({
        [git('rev-parse', '--verify', '--quiet', `${REF}^{commit}`)]: { code: 1 },
      }),
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(1);
    expect(run.lines.join('\n')).toContain(REF);
  });
});

describe('hook mode when a step fails', () => {
  it.each([
    ['pnpm install --frozen-lockfile --ignore-scripts', '클론 빌드'],
    ['pnpm build', '클론 빌드'],
    [`${INSTALLER} --yes --plugin-root /plugin`, '설치기'],
  ])('says one line naming the step for %s, and releases the lock', async (command, step) => {
    const run = harness({
      exists: false,
      respond: (line) => (line === command ? { code: 3 } : atRef(line)),
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).toContain(step);
    expect(run.messages[0]).toContain(join(HOME, LOG_FOLDER, BOOTSTRAP_LOG_FILE));
    // It reaches the model and not the screen (Decision 2026-10-18), so it
    // asks for the one thing that gets it to the person.
    expect(run.messages[0]).toContain('사용자에게 한 줄로');
    expect(run.locked()).toBe(false);
  });

  it('says the floor when the node running it is too old, and touches no git', async () => {
    const run = harness({ exists: false, nodeVersion: '24.15.0' });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).toEqual(['git --version']);
    expect(run.lines.join('\n')).toContain(MIN_NODE_VERSION);
    expect(run.messages[0]).toContain('필요한 도구 확인');
  });

  it('refuses when the installer exited 0 and the record does not name the ref', async () => {
    const run = harness({
      exists: false,
      respond: atRef,
      installerWrites: { [INSTALLED_PATH]: record(OTHER) },
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.messages[0]).toContain('완료 기록 확인');
  });
});

describe('hook mode when it worked', () => {
  it('names the short commit in the one line it says', async () => {
    const run = harness({
      exists: false,
      respond: atRef,
      installerWrites: { [INSTALLED_PATH]: record(REF) },
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.messages).toHaveLength(1);
    expect(run.messages[0]).toContain(`Brain을 ${REF.slice(0, 7)}로 설치했습니다`);
    // The line reaches the model and not the screen (Decision 2026-10-18), so
    // it asks for the one thing that gets it to the person.
    expect(run.messages[0]).toContain('사용자에게 한 줄로');
    expect(run.locked()).toBe(false);
  });

  it('reads the record again under the lock, in case another run just made it', async () => {
    // Two sessions at once: the one that got the lock installed this very ref
    // and released it, and this one had read the folder before that happened.
    const run = harness({
      exists: true,
      respond: atRef,
      files: { [INSTALLED_PATH]: record(REF) },
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual([]);
  });
});

/**
 * Where a child's three streams go. It is its own function because stdin is
 * the one stream the two modes have to disagree about, and because getting it
 * wrong is invisible in a test that pipes everything anyway.
 */
describe('childStdio', () => {
  it('lets an npx child keep this process’s stdin, because the installer asks', () => {
    // Four questions, and `--yes` skips only the last of them: a child with no
    // stdin would answer every interactive `npx` with exit 3.
    expect(childStdio(false, undefined)).toEqual(['inherit', 'inherit', 'inherit']);
  });

  it('closes stdin in hook mode and sends both other streams to the log', () => {
    // No terminal behind a hook and nothing that may be asked (Boundaries).
    expect(childStdio(false, 7)).toEqual(['ignore', 7, 7]);
  });

  it('closes stdin for a captured probe either way, and pipes its stdout', () => {
    expect(childStdio(true, undefined)).toEqual(['ignore', 'pipe', 'inherit']);
    expect(childStdio(true, 7)).toEqual(['ignore', 'pipe', 7]);
  });
});

/**
 * The record a `SessionStart` leaves under `<home>/run/`, which is what makes
 * `brain doctor run` able to speak about the plugin folder that is actually
 * calling. The plugin cache keeps one folder per version, so after a
 * `claude plugin update` that nothing has installed yet, `installed.json`'s
 * `plugin_root` names a folder nothing calls any more (2.5 human check 1).
 */
describe('the plugin record', () => {
  /** The time the harness's clock is stopped at, as the record spells it. */
  const NOW = '2023-11-14T22:13:20.000Z';

  interface Written {
    plugin_root?: string;
    app_ref?: string;
    seen_at?: string;
    last_bootstrap?: { at?: string; result?: string; step?: string; log?: string };
  }

  function written(run: Harness): Written {
    const text = run.file(RUN_PATH);
    expect(text, `${RUN_PATH}에 기록이 없습니다`).toBeDefined();
    return JSON.parse(text ?? '') as Written;
  }

  it('names the plugin folder and its ref even when nothing is installed', async () => {
    // The row this record exists for: a new plugin folder, an older install,
    // and `[update] auto` off, so the session installs nothing.
    const run = harness({
      exists: true,
      files: {
        [INSTALLED_PATH]: record(OTHER),
        [CONFIG_PATH]: '[update]\nauto = false\n',
      },
    });

    const code = await main([...HOOK_ARGS], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.messages).toEqual([]);
    expect(written(run)).toEqual({ plugin_root: '/plugin', app_ref: REF, seen_at: NOW });
    // One fetch and nothing else: `doctor run` asks this clone which of the
    // two commits is the ancestor, and the plugin's one was pushed after the
    // last install. Nothing is checked out and HEAD does not move.
    expect(run.calls).toEqual([git('fetch', 'origin')]);
  });

  it('asks git nothing when the folder and the ref are the ones on disk', async () => {
    const run = harness({
      exists: true,
      files: {
        [INSTALLED_PATH]: record(OTHER),
        [CONFIG_PATH]: '[update]\nauto = false\n',
        [RUN_PATH]: saw('/plugin', REF),
      },
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    // The fast path runs on almost every session: a record rewritten per
    // session would make the cheapest path in the program a write, and a fetch
    // would make it a network call.
    expect(run.writes).toEqual([]);
    expect(run.calls).toEqual([]);
    expect(run.file(RUN_PATH)).toBe(saw('/plugin', REF));
  });

  it('goes on when the fetch it makes for doctor fails', async () => {
    const run = harness({
      exists: true,
      files: {
        [INSTALLED_PATH]: record(OTHER),
        [CONFIG_PATH]: '[update]\nauto = false\n',
      },
      respond: respondWith({ [git('fetch', 'origin')]: { code: 1 } }),
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    expect(run.messages).toEqual([]);
    expect(run.lines.join('\n')).toContain('실패했습니다');
    expect(written(run).plugin_root).toBe('/plugin');
  });

  it('replaces a record that names another folder, keeping the last outcome', async () => {
    const last = { at: '2026-10-17T00:00:00.000Z', result: 'installed', log: '/log/bootstrap.log' };
    const run = harness({
      exists: true,
      files: {
        [INSTALLED_PATH]: record(REF),
        [RUN_PATH]: saw('/plugin/0.1.1', OTHER, last),
      },
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    expect(written(run)).toEqual({
      plugin_root: '/plugin',
      app_ref: REF,
      seen_at: NOW,
      // Still the last thing a bootstrap did here: this session installed
      // nothing, which is the whole reason the folder moved without an install.
      last_bootstrap: last,
    });
  });

  it('replaces a record it cannot read back, rather than reporting on it', async () => {
    const run = harness({
      exists: true,
      files: { [INSTALLED_PATH]: record(REF), [RUN_PATH]: '{ not json' },
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    expect(written(run)).toEqual({ plugin_root: '/plugin', app_ref: REF, seen_at: NOW });
  });

  it('is written through a temporary file, so a reader never sees half of one', async () => {
    const run = harness({ exists: true, files: { [INSTALLED_PATH]: record(REF) } });

    await main([...HOOK_ARGS], ENV, run.deps);

    expect(run.writes).toEqual([`${RUN_PATH}.${String(PID)}.tmp`]);
    expect(run.file(`${RUN_PATH}.${String(PID)}.tmp`)).toBeUndefined();
  });

  it('says so in the log when the record cannot be written, and installs anyway', async () => {
    const run = harness({
      exists: false,
      brokenMoves: 10,
      respond: atRef,
      installerWrites: { [INSTALLED_PATH]: record(REF) },
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    expect(run.file(RUN_PATH)).toBeUndefined();
    expect(run.lines.join('\n')).toContain('플러그인 기록을 쓸 수 없었습니다');
  });

  it('records the outcome against this session’s folder after a write that failed', async () => {
    // The first write did not take, so the file still names the old folder.
    // Writing the outcome onto that would put this session's result beside a
    // folder it never came from.
    const run = harness({
      exists: false,
      brokenMoves: 1,
      respond: atRef,
      files: { [RUN_PATH]: saw('/plugin/0.1.1', OTHER) },
      installerWrites: { [INSTALLED_PATH]: record(REF) },
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    expect(written(run)).toMatchObject({
      plugin_root: '/plugin',
      app_ref: REF,
      seen_at: NOW,
      last_bootstrap: { result: 'installed' },
    });
  });

  it('records the step a failed install stopped at, and where the reason is', async () => {
    const run = harness({
      exists: false,
      respond: (line) => (line === 'pnpm build' ? { code: 3 } : atRef(line)),
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(1);
    expect(written(run).last_bootstrap).toEqual({
      at: NOW,
      result: 'failed',
      step: '클론 빌드',
      log: join(HOME, LOG_FOLDER, BOOTSTRAP_LOG_FILE),
    });
  });

  it('records an install that finished, with no step and the log it wrote', async () => {
    const run = harness({
      exists: false,
      respond: atRef,
      installerWrites: { [INSTALLED_PATH]: record(REF) },
    });

    expect(await main([...HOOK_ARGS], ENV, run.deps)).toBe(0);
    expect(written(run)).toEqual({
      plugin_root: '/plugin',
      app_ref: REF,
      seen_at: NOW,
      last_bootstrap: {
        at: NOW,
        result: 'installed',
        log: join(HOME, LOG_FOLDER, BOOTSTRAP_LOG_FILE),
      },
    });
  });

  it('leaves no record at all when the launcher named no plugin folder', async () => {
    // Not a path any launcher takes; it is here because a record naming no
    // folder would be worse than none, and the check for it is one line.
    const run = harness({ exists: true, files: { [INSTALLED_PATH]: record(OTHER) } });

    await main(['--yes', '--ref', REF], ENV, run.deps);

    expect(run.file(RUN_PATH)).toBeUndefined();
  });
});

describe('a lock whose pid is alive', () => {
  it('is reclaimed anyway once nobody has touched the folder for half an hour', async () => {
    // Pids are recycled. A live process that is not this lock's owner used to
    // make the lock permanent, because a readable pid ended the stale test.
    const run = harness({
      exists: false,
      heldLock: { pid: 777, ageMs: LOCK_STALE_MS + 60_000 },
      alive: [PID, 777],
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toContain(`git clone ${DEFAULT_REPO} ${APP}`);
  });

  it('is left alone while the folder is young', async () => {
    const run = harness({
      exists: false,
      heldLock: { pid: 777, ageMs: 60_000 },
      alive: [PID, 777],
    });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(0);
    expect(run.calls).toEqual(['git --version']);
  });
});
