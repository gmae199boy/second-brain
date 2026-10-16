#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

/**
 * The install entry point: `npx github:gmae199boy/second-brain`.
 *
 * It is the one file npm packs from this repository, so it may import nothing
 * but `node:` built-ins — npm installs it without dependencies and without a
 * build. Everything real happens in the clone it makes under `<home>/app`:
 * this file only checks the environment, fetches the repository, builds it,
 * and hands over to the installer that the clone just built.
 *
 * The committed `bin/second-brain.js` is the build of this file. A test
 * compares the two, so editing one without rebuilding fails the suite.
 */

/** Where the configuration folder is, when it is not the default one. */
export const HOME_ENV = 'SECOND_BRAIN_HOME';

/** Folder name under the user's home directory (AD-18). */
export const DEFAULT_HOME_FOLDER = '.second_brain';

/**
 * Both constants above repeat `apps/cli/src/config/paths.ts` on purpose: this
 * file cannot import it, because at this point in an install there is nothing
 * built to import. A test ties the two spellings together.
 */

/** Which repository to clone. Overridden for a fork, and by the tests. */
export const REPO_ENV = 'SECOND_BRAIN_REPO';

export const DEFAULT_REPO = 'https://github.com/gmae199boy/second-brain.git';

/** The clone lives beside the configuration, not inside the npx cache. */
export const APP_FOLDER = 'app';

export const MIN_NODE_MAJOR = 24;

export const MIN_PNPM_MAJOR = 12;

/** The one way to get a current pnpm. The version is not pinned (AD: 2026-10-13). */
export const PNPM_INSTALL_COMMAND = 'npm install -g pnpm@latest';

/** One external command. An array of arguments, never a shell string. */
export interface CommandRequest {
  command: string;
  args: readonly string[];
  cwd?: string;
  /** Read stdout instead of letting the child write to the terminal. */
  capture?: boolean;
}

export interface CommandResult {
  /** 127 when the command could not be started at all. */
  code: number;
  /** Empty unless the request asked to capture. */
  stdout: string;
}

/**
 * Everything this file does to the world, in one injected object, so the whole
 * I/O matrix can be driven from a test without a repository or a terminal.
 */
export interface BootstrapDeps {
  run(request: CommandRequest): Promise<CommandResult>;
  /** Only ever called when `isTTY` is true. */
  ask(question: string): Promise<boolean>;
  isTTY: boolean;
  log(line: string): void;
  exists(path: string): boolean;
  /** The path with every symlink resolved, or the path itself if it has none. */
  realpath(path: string): string;
  nodeVersion: string;
  /** The node that is running this file; the installer is started with it. */
  nodePath: string;
}

/** The configuration folder for this run — the same rule as the CLI's. */
export function resolveHome(env: NodeJS.ProcessEnv): string {
  const override = env[HOME_ENV]?.trim();
  if (override !== undefined && override !== '') {
    return override;
  }
  return join(homedir(), DEFAULT_HOME_FOLDER);
}

export function resolveRepo(env: NodeJS.ProcessEnv): string {
  const override = env[REPO_ENV]?.trim();
  if (override !== undefined && override !== '') {
    return override;
  }
  return DEFAULT_REPO;
}

/**
 * The whole run, as an exit code. `argv` is the user's arguments, without the
 * node and script entries; they are passed on to the installer.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: BootstrapDeps,
): Promise<number> {
  // Absolute from here on: every command below runs with the clone as its
  // working directory, so a relative home would be resolved against itself
  // once per step.
  const app = resolve(resolveHome(env), APP_FOLDER);
  const repo = resolveRepo(env);

  const missing = await missingTools(deps);
  if (missing.length > 0) {
    for (const line of missing) deps.log(line);
    return 1;
  }

  const folder = await prepareApp(app, repo, deps);
  if (folder !== 0) return folder;

  const pnpm = await ensurePnpm(app, deps);
  if (pnpm !== 0) return pnpm;

  deps.log(`${app}에 의존성을 설치합니다`);
  const install = await deps.run({
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: app,
  });
  if (install.code !== 0) return failedStep('pnpm install', install.code, deps);

  deps.log('빌드합니다');
  const build = await deps.run({ command: 'pnpm', args: ['build'], cwd: app });
  if (build.code !== 0) return failedStep('pnpm build', build.code, deps);

  deps.log('설치기를 시작합니다');
  const installer = await deps.run({
    command: deps.nodePath,
    args: [join(app, 'apps', 'cli', 'dist', 'install.js'), ...argv],
    cwd: app,
  });
  // The installer owns the outcome from here on, so hand its code straight on.
  return installer.code;
}

/**
 * What has to be there before anything is fetched. Both lines say how to get
 * the missing thing, because someone on a fresh Mac has nothing else to go on.
 */
async function missingTools(deps: BootstrapDeps): Promise<readonly string[]> {
  const missing: string[] = [];

  const major = majorOf(deps.nodeVersion);
  if (major === undefined || major < MIN_NODE_MAJOR) {
    missing.push(
      `node ${MIN_NODE_MAJOR} 이상이 필요한데 이것은 ${deps.nodeVersion}입니다. \`brew install node\`로 설치하세요`,
    );
  }

  const git = await deps.run({ command: 'git', args: ['--version'], capture: true });
  if (git.code !== 0) {
    missing.push('git이 필요합니다. `xcode-select --install`로 설치하세요');
  }

  return missing;
}

/**
 * Get `<home>/app` to a clean checkout of `repo`, or refuse. Anything already
 * there that Brain did not put there is left exactly as it is: this is the
 * user's home directory, and a wrong guess here destroys their work.
 */
async function prepareApp(app: string, repo: string, deps: BootstrapDeps): Promise<number> {
  if (!deps.exists(app)) {
    deps.log(`${repo}를 ${app}에 클론합니다`);
    // git creates the parent folders of the destination itself.
    const clone = await deps.run({ command: 'git', args: ['clone', repo, app] });
    if (clone.code !== 0) return failedStep('git clone', clone.code, deps);
    return 0;
  }

  // The top level of the clone, not `--is-inside-work-tree`: that answers for
  // an enclosing repository too, so an empty `<home>/app` inside somebody's
  // own clone of this repository would look like a clone of it — and get
  // pulled, one folder up from where Brain was looking.
  const toplevel = await capture(['rev-parse', '--show-toplevel'], app, deps);
  if (toplevel.code !== 0 || deps.realpath(toplevel.stdout.trim()) !== deps.realpath(app)) {
    deps.log(`${app}이 있지만 git 클론이 아니므로 Brain은 건드리지 않습니다.`);
    deps.log(leaveItAlone(app));
    return 1;
  }

  const origin = await capture(['remote', 'get-url', 'origin'], app, deps);
  const url = origin.stdout.trim();
  if (origin.code !== 0 || !sameRepo(url, repo)) {
    const what = url === '' ? '알 수 없는 저장소' : url;
    deps.log(`${app}은 ${repo}가 아니라 ${what}의 클론이므로 Brain은 건드리지 않습니다.`);
    deps.log(leaveItAlone(app));
    return 1;
  }

  const status = await capture(['status', '--porcelain'], app, deps);
  if (status.code !== 0) return failedStep('git status', status.code, deps);
  if (status.stdout.trim() !== '') {
    deps.log(`${app}에 로컬 변경이 있으므로 Brain은 업데이트하지 않습니다.`);
    deps.log(`\`git -C ${app} status\`로 변경 내용을 보세요`);
    deps.log('변경을 직접 정리한 뒤 다시 실행하세요.');
    return 1;
  }

  deps.log(`${app}을 업데이트합니다`);
  // Fast-forward only: if history has diverged, a human decides, not Brain.
  const pull = await deps.run({ command: 'git', args: ['-C', app, 'pull', '--ff-only'] });
  if (pull.code !== 0) {
    deps.log(`${app}은 fast-forward할 수 없으므로 Brain은 그대로 두었습니다.`);
    deps.log(`\`git -C ${app} log --oneline --graph --all -n 20\`로 이유를 보세요`);
    return 1;
  }
  return 0;
}

/**
 * A pnpm of at least major 12, asking first. The version is deliberately not
 * pinned: a pin that cannot be honoured is worse than no pin, since the
 * switch fails before any work starts.
 */
async function ensurePnpm(app: string, deps: BootstrapDeps): Promise<number> {
  const found = await pnpmVersion(app, deps);
  if (found.enough) {
    deps.log(`pnpm ${found.version}이 준비되어 있습니다`);
    return 0;
  }

  deps.log(`${found.reason}.`);

  if (!deps.isTTY) {
    deps.log(`\`${PNPM_INSTALL_COMMAND}\`를 직접 실행한 뒤 다시 시작하세요`);
    return 1;
  }

  const agreed = await deps.ask(`지금 최신 pnpm을 설치할까요? (\`${PNPM_INSTALL_COMMAND}\`)`);
  if (!agreed) {
    deps.log(`\`${PNPM_INSTALL_COMMAND}\`를 직접 실행한 뒤 다시 시작하세요`);
    return 1;
  }

  const installed = await deps.run({
    command: 'npm',
    args: ['install', '-g', 'pnpm@latest'],
  });
  if (installed.code !== 0) return failedStep(PNPM_INSTALL_COMMAND, installed.code, deps);

  // npm installed a current pnpm somewhere, which is not the same as the
  // `pnpm` the PATH finds: an older one earlier on the PATH still wins. Say so
  // here, rather than letting it come back three steps later as a build that
  // failed for no stated reason.
  const after = await pnpmVersion(app, deps);
  if (!after.enough) {
    deps.log(`\`${PNPM_INSTALL_COMMAND}\` 뒤에도 ${after.reason}.`);
    deps.log('다른 pnpm이 PATH 앞쪽에 있습니다. `which -a pnpm`으로 찾으세요');
    return 1;
  }
  deps.log(`pnpm ${after.version}이 준비되어 있습니다`);
  return 0;
}

interface PnpmVersion {
  enough: boolean;
  version: string;
  /** Why it is not enough. Empty when it is. */
  reason: string;
}

/** What `pnpm` the PATH finds, in the clone, where a pin would still apply. */
async function pnpmVersion(app: string, deps: BootstrapDeps): Promise<PnpmVersion> {
  const found = await deps.run({ command: 'pnpm', args: ['--version'], cwd: app, capture: true });
  const version = found.stdout.trim();
  const major = majorOf(version);
  if (found.code === 0 && major !== undefined && major >= MIN_PNPM_MAJOR) {
    return { enough: true, version, reason: '' };
  }
  const reason =
    found.code === 0 && major !== undefined
      ? `pnpm ${version}은 ${MIN_PNPM_MAJOR}보다 오래되었습니다`
      : 'pnpm이 설치되어 있지 않습니다';
  return { enough: false, version, reason };
}

function capture(
  args: readonly string[],
  app: string,
  deps: BootstrapDeps,
): Promise<CommandResult> {
  return deps.run({ command: 'git', args: ['-C', app, ...args], capture: true });
}

function leaveItAlone(app: string): string {
  return `${app}을 다른 곳으로 옮기거나 ${HOME_ENV}을 다른 곳으로 가리킨 뒤 다시 실행하세요.`;
}

/** Every failure of a step says which step and what code. Exit 1 throughout. */
function failedStep(step: string, code: number, deps: BootstrapDeps): number {
  deps.log(`\`${step}\`이 실패했습니다. 종료 코드 ${code}.`);
  return 1;
}

/** The major of `12.11.2` or `v24.16.0`; undefined when it is not a version. */
function majorOf(version: string): number | undefined {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  return Number.isNaN(major) ? undefined : major;
}

/**
 * Whether two URLs name the same repository, as far as a trailing slash and a
 * trailing `.git` go: `…/x`, `…/x/` and `…/x.git` are one. It does not equate
 * different forms of the same remote — `git@host:owner/x` and
 * `https://host/owner/x` are two repositories here, and a clone made with one
 * will not be updated by a run that asks for the other.
 */
export function sameRepo(left: string, right: string): boolean {
  return bareUrl(left) === bareUrl(right);
}

function bareUrl(url: string): string {
  return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}

/** The real world, injected in one place so the tests can replace all of it. */
export function systemDeps(): BootstrapDeps {
  return {
    run: runCommand,
    ask: askTerminal,
    // Both ends have to be a terminal: a question needs an answer and a place
    // to be read. Anything else counts as "no" (I/O matrix).
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    log: (line: string): void => {
      process.stdout.write(`${line}\n`);
    },
    exists: existsSync,
    realpath: (path: string): string => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
  };
}

function runCommand(request: CommandRequest): Promise<CommandResult> {
  const captured = request.capture === true;
  return new Promise((resolve) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      // Only the answer is read; stderr still goes to the terminal, so a probe
      // that fails says why instead of turning into a bare refusal.
      stdio: captured ? ['ignore', 'pipe', 'inherit'] : 'inherit',
    });

    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    // A command that is not installed is not an exception here, it is an
    // answer: 127, the shell's own code for it.
    child.once('error', () => resolve({ code: 127, stdout }));
    child.once('close', (code) => resolve({ code: code ?? 1, stdout }));
  });
}

async function askTerminal(question: string): Promise<boolean> {
  const terminal = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await terminal.question(`${question} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    terminal.close();
  }
}

/**
 * True when node was told to run this file, rather than a test importing it.
 * Both sides go through `realpathSync` because npm links the entry into a
 * `node_modules/.bin`, and because `/tmp` on a Mac is a symlink.
 */
function invokedDirectly(here: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(here));
  } catch {
    return false;
  }
}

if (invokedDirectly(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2), process.env, systemDeps());
}
