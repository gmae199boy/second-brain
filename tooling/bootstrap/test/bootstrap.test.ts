import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  APP_FOLDER,
  DEFAULT_HOME_FOLDER,
  DEFAULT_REPO,
  HOME_ENV,
  MIN_NODE_MAJOR,
  MIN_PNPM_MAJOR,
  PNPM_INSTALL_COMMAND,
  REPO_ENV,
  main,
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
}

interface HarnessOptions {
  respond?: Responder;
  /** Whether `<home>/app` is already there. */
  exists?: boolean;
  isTTY?: boolean;
  /** The answer to every question. */
  answer?: boolean;
  nodeVersion?: string;
}

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

function harness(options: HarnessOptions = {}): Harness {
  const calls: string[] = [];
  const lines: string[] = [];
  const questions: string[] = [];

  const deps: BootstrapDeps = {
    run: async (request: CommandRequest): Promise<CommandResult> => {
      const line = [request.command, ...request.args].join(' ');
      calls.push(line);
      const scripted = options.respond?.(line, request) ?? healthy(line) ?? {};
      return { code: scripted.code ?? 0, stdout: scripted.stdout ?? '' };
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
    exists: () => options.exists ?? false,
    realpath: (path: string) => path,
    nodeVersion: options.nodeVersion ?? '24.16.0',
    nodePath: '/fake/node',
  };

  return { deps, calls, lines, questions };
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
      'pnpm install --frozen-lockfile',
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
      `git -C ${APP} pull --ff-only`,
      'pnpm --version',
      'pnpm install --frozen-lockfile',
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
      'pnpm install --frozen-lockfile',
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
    expect(run.calls).not.toContain('pnpm install --frozen-lockfile');
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
    expect(run.calls).not.toContain('pnpm install --frozen-lockfile');
  });
});

describe('required tools', () => {
  it('stops before cloning when node is too old', async () => {
    const run = harness({ exists: false, nodeVersion: '22.14.0' });

    const code = await main([], ENV, run.deps);

    expect(code).toBe(1);
    expect(run.calls).toEqual(['git --version']);
    expect(run.lines.join('\n')).toContain(`node ${MIN_NODE_MAJOR} 이상이 필요한데`);
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
    ['pnpm install --frozen-lockfile', 'pnpm install'],
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

  it('asks for the node major the entry point checks for, and may ask for more', () => {
    const floor = root.engines?.node ?? '';
    const match = /^>=(\d+)(?:\.\d+\.\d+)?$/.exec(floor);

    expect(match, `engines.node is ${floor}, which is not a \`>=major[.minor.patch]\` floor`)
      .not.toBeNull();
    expect(Number(match?.[1])).toBe(MIN_NODE_MAJOR);
    // The manifest may be stricter than the entry point: `node:sqlite` became a
    // release candidate in 24.15.0 and `crypto.randomUUIDv7` arrived in
    // 24.16.0, and the source of truth sits on both. The entry point checks the
    // major alone because it runs before anything is cloned and cannot know
    // which minor this repository will turn out to need.
    //
    // Nothing enforces the minor yet: pnpm 12.11.2 does not fail an install on
    // `engines.node` here (measured 2026-10-14), so `>=24.16.0` is a statement
    // of the requirement and not a gate. The check that catches a node too old
    // for `node:sqlite` belongs to `doctor run`, in story 8.
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
  ])('agrees with the CLI on %s', (constant, value) => {
    expect(paths).toContain(`export const ${constant} = '${value}';`);
  });
});
