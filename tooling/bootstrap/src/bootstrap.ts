#!/usr/bin/env node
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

/**
 * The install entry point, on two doors.
 *
 * `npx github:gmae199boy/second-brain` is the one a person types. The harness
 * plugin's `SessionStart` hook takes the same file with `--ref <sha>`, which is
 * hook mode: no questions, at most one line on stdout, and work only when the
 * plugin carries a commit this machine has not installed yet (AD-19, AD-20).
 *
 * It is the one file npm packs from this repository, so it may import nothing
 * but `node:` built-ins — npm installs it without dependencies and without a
 * build. Everything real happens in the clone it makes under `<home>/app`:
 * this file only checks the environment, fetches the repository, builds it,
 * and hands over to the installer that the clone just built.
 *
 * The committed `bin/second-brain.js` is the build of this file, and
 * `plugin/bootstrap.mjs` is a copy of that. Tests compare all three, so
 * editing one without rebuilding fails the suite.
 */

/** Where the configuration folder is, when it is not the default one. */
export const HOME_ENV = 'SECOND_BRAIN_HOME';

/** Folder name under the user's home directory (AD-18). */
export const DEFAULT_HOME_FOLDER = '.second_brain';

/** What a finished install left behind, under the configuration folder. */
export const INSTALLED_FILE = 'installed.json';

/** The install lock: one folder, taken with `mkdir`, owned by a `pid` file. */
export const LOCK_FOLDER = 'install.lock';

/** The owner of the lock: one decimal line. */
export const LOCK_PID_FILE = 'pid';

/** Where this file's own progress lines go in hook mode. */
export const LOG_FOLDER = 'log';

export const BOOTSTRAP_LOG_FILE = 'bootstrap.log';

/** Where the records of a running installation live (Conventions). */
export const RUN_FOLDER = 'run';

/**
 * What the last `SessionStart` saw and did: which plugin folder called this
 * file, which commit that folder asks for, and how the last run that did
 * anything ended.
 *
 * It exists because the plugin cache is keyed by version — a
 * `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` per version, with
 * the older folders left behind — so `installed.json`'s `plugin_root` names the
 * folder the last *install* came from, which after a `claude plugin update`
 * with `[update] auto = false` is not the folder that is now asking for
 * anything. Without this record `brain doctor run` compares the installation
 * against a stale folder and reports that all is well (2.5 human check 1).
 */
export const PLUGIN_RUN_FILE = 'plugin.json';

/** The configuration file, read here for one key and nothing else. */
export const CONFIG_FILE = 'config.toml';

/**
 * Every constant above repeats `apps/cli/src/config/paths.ts` on purpose: this
 * file cannot import it, because at this point in an install there is nothing
 * built to import. A test ties the two spellings together.
 */

/** Which repository to clone. Overridden for a fork, and by the tests. */
export const REPO_ENV = 'SECOND_BRAIN_REPO';

export const DEFAULT_REPO = 'https://github.com/gmae199boy/second-brain.git';

/** The clone lives beside the configuration, not inside the npx cache. */
export const APP_FOLDER = 'app';

/**
 * Lowest node this build runs on, major, minor and patch. The minor matters:
 * `node:sqlite` was a release candidate in 24.15.0 and `randomUUIDv7` arrived
 * in 24.16.0, so a major-only check accepts a node the clone then fails to
 * build on — which used to happen three steps later with no reason given.
 */
export const MIN_NODE_VERSION = '24.16.0';

export const MIN_PNPM_MAJOR = 12;

/** The one way to get a current pnpm. The version is not pinned (AD: 2026-10-13). */
export const PNPM_INSTALL_COMMAND = 'npm install -g pnpm@latest';

/**
 * How long a lock folder may go untouched before it is taken for abandoned.
 *
 * It is the second half of the stale test and not the first: a lock whose
 * owning process is gone is reclaimed at once, whatever its age. This covers
 * the case the pid cannot settle — a pid file that was never written, or one
 * whose number has since been handed to an unrelated process.
 */
export const LOCK_STALE_MS = 30 * 60 * 1000;

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
  /** Only ever called when `isTTY` is true, and never in hook mode. */
  ask(question: string): Promise<boolean>;
  isTTY: boolean;
  /**
   * One progress line. In hook mode it goes to the log file instead of stdout,
   * because stdout there is the model's context and carries one line at most.
   */
  log(line: string): void;
  /**
   * The one thing a hook says: the harness turns it into
   * `{"systemMessage":"…"}` on stdout. Called at most once per run, and never
   * on the paths hook mode is deliberately silent about (Decision 2026-10-17).
   */
  message(text: string): void;
  /**
   * Send progress lines and child output to this file from now on, appended.
   * The file is not opened until there is something to write, so a session that
   * decides there is nothing to do leaves no trace at all.
   */
  logToFile(path: string): void;
  exists(path: string): boolean;
  /** The path with every symlink resolved, or the path itself if it has none. */
  realpath(path: string): string;
  /** The file's text, or `undefined` when it is not there or cannot be read. */
  readText(path: string): string | undefined;
  writeText(path: string, text: string): void;
  /**
   * Rename one file over another, which is how a record is replaced whole: a
   * reader sees the old file or the new one and never half of either. `false`
   * when it could not be done, in which case the source is removed — a leftover
   * temporary file beside a record is worse than no record at all.
   */
  moveFile(from: string, to: string): boolean;
  /** One folder, created or not: `true` only when this call created it. */
  makeFolder(path: string): boolean;
  /** The folder and its parents, at mode 0700 like the codec makes them. */
  makeFolders(path: string): void;
  removeFolder(path: string): void;
  /** When the folder was last touched, in epoch milliseconds. */
  folderMtimeMs(path: string): number | undefined;
  /** Whether a process with this pid exists — `kill(pid, 0)` without ESRCH. */
  alive(pid: number): boolean;
  nowMs(): number;
  /** This process's own pid, written into the lock. */
  pid: number;
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

/** What this invocation asked for: hook mode when there is a ref. */
export interface BootstrapArgs {
  /** The commit the plugin asks to be installed. Absent means npx mode. */
  ref?: string;
  /**
   * The plugin folder the launcher came from, when it named one. It is also in
   * `rest`, because it is the installer's argument too (see below); this is
   * only read, so that hook mode can record where this session came from.
   */
  pluginRoot?: string;
  /** Everything else, in order, as the installer is to receive it. */
  rest: readonly string[];
}

/**
 * Read `--ref <sha>` out of the arguments and leave the rest alone.
 *
 * `--ref` is this file's own and is consumed here: the installer knows nothing
 * about commits. `--plugin-root` is not consumed — it is the installer's, and
 * is passed straight on, so what the completion record says about where the
 * install came from is what the launcher actually handed over. It is read on
 * the way past all the same, because the plugin record is written by sessions
 * that do not install anything and so never reach the installer.
 */
export function parseArgs(argv: readonly string[]): BootstrapArgs {
  const rest: string[] = [];
  let ref: string | undefined;
  let pluginRoot: string | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--ref') {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        ref = value.trim();
        index += 1;
        continue;
      }
      // A `--ref` with nothing after it is not hook mode and not an argument
      // the installer knows: dropping it is the one reading that cannot start
      // an install of the wrong thing.
      continue;
    }
    if (argument === '--plugin-root') {
      const value = argv[index + 1];
      if (value !== undefined && !value.startsWith('-')) {
        const trimmed = value.trim();
        if (trimmed !== '') pluginRoot = trimmed;
      }
    }
    rest.push(argument ?? '');
  }

  return {
    ...(ref === undefined ? {} : { ref }),
    ...(pluginRoot === undefined ? {} : { pluginRoot }),
    rest,
  };
}

/**
 * The whole run, as an exit code. `argv` is the user's arguments, without the
 * node and script entries; everything but `--ref` is passed on to the
 * installer.
 */
export async function main(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: BootstrapDeps,
): Promise<number> {
  const parsed = parseArgs(argv);
  return parsed.ref === undefined
    ? npxMode(parsed.rest, env, deps)
    : hookMode(parsed.ref, parsed.pluginRoot, parsed.rest, env, deps);
}

/**
 * The door a person takes. It asks, it prints as it goes, and it hands the
 * installer's own exit code straight back.
 */
async function npxMode(
  argv: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: BootstrapDeps,
): Promise<number> {
  // Absolute from here on: every command below runs with the clone as its
  // working directory, so a relative home would be resolved against itself
  // once per step.
  const home = resolve(resolveHome(env));
  const app = join(home, APP_FOLDER);
  const repo = resolveRepo(env);

  const missing = await missingTools(deps);
  if (missing.length > 0) {
    for (const line of missing) deps.log(line);
    return 1;
  }

  // The same lock a `SessionStart` takes. An install that ran beside one
  // already in flight would have two `pnpm install`s in one `node_modules` and
  // two installers writing one configuration folder.
  if (!takeLock(home, deps)) {
    deps.log('다른 설치가 진행 중입니다. 그것이 끝난 뒤에 다시 실행하세요.');
    return 0;
  }

  try {
    const folder = await prepareApp(app, repo, deps);
    if (folder !== 0) return folder;

    const pnpm = await ensurePnpm(app, deps, true);
    if (pnpm !== 0) return pnpm;

    const built = await installAndBuild(app, deps);
    if (built !== 0) return built;

    deps.log('설치기를 시작합니다');
    const installer = await deps.run({
      command: deps.nodePath,
      args: [installerPath(app), ...argv],
      cwd: app,
    });
    // The installer owns the outcome from here on, so hand its code straight on.
    return installer.code;
  } finally {
    releaseLock(home, deps);
  }
}

/**
 * The door a `SessionStart` hook takes, with the commit the plugin carries.
 *
 * Every decision not to act is silent: a lock somebody else holds, a plugin
 * that is behind, a history that has diverged, an `[update] auto` that is off.
 * An asynchronous hook's stdout goes into the model's context on the next turn,
 * every session, so a line per decision would be a line per turn about nothing
 * (Decision 2026-10-17). `brain doctor run`'s `plugin` check is where those
 * four are said out loud, to somebody who asked — which it can only do about
 * the folder that actually called, so the first thing this does is write that
 * folder down (`PLUGIN_RUN_FILE`).
 *
 * What it does say, it says to the model: an asynchronous hook's `systemMessage`
 * reaches the next turn's context and not the user's screen (2.5 human check 4,
 * Decision 2026-10-18), so the three lines below are written to be passed on in
 * one sentence rather than read directly.
 */
async function hookMode(
  ref: string,
  pluginRoot: string | undefined,
  installerArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  deps: BootstrapDeps,
): Promise<number> {
  const home = resolve(resolveHome(env));
  const app = join(home, APP_FOLDER);
  const repo = resolveRepo(env);
  const logPath = join(home, LOG_FOLDER, BOOTSTRAP_LOG_FILE);
  // Said before anything can print: from here on a progress line is a line in
  // the log, not a line in the model's context. The file itself is only opened
  // when something is actually written to it.
  deps.logToFile(logPath);

  // Before any decision below, because almost every one of them is to do
  // nothing and return. The write itself only happens when the folder or the
  // commit it asks for has moved, so the fast path stays a few reads
  // (Boundaries).
  const seen = noteSeenPlugin(home, pluginRoot, ref, deps);

  /** One failure: the step in the message, the reason in the log. */
  const failed = (step: string): number => {
    noteBootstrap(home, seen, { result: 'failed', step, log: logPath }, deps);
    deps.message(
      `Brain 설치가 ${step}에서 멈췄습니다. 까닭은 ${logPath}에 있습니다. ` +
        '이것을 사용자에게 한 줄로 전하고, 자세한 상태는 `brain doctor run`이 말한다고 알려 주세요',
    );
    return 1;
  };

  // The fast path, and the one that runs on almost every session: one JSON
  // file, and a few lines of TOML. No git, no pnpm, nothing spawned.
  const before = readInstalled(home, deps);
  if (before.commit === ref) return 0;
  // A first install happens whatever the configuration says — there is no
  // installation yet for an update to be automatic about.
  if (before.present && !updateAuto(home, deps)) return 0;

  const missing = await missingTools(deps);
  if (missing.length > 0) {
    for (const line of missing) deps.log(line);
    return failed('필요한 도구 확인');
  }

  // A lock somebody else holds means another session got here first. There is
  // nothing to add and nothing to wait for: that install is this install.
  if (!takeLock(home, deps)) return 0;

  try {
    // Read again under the lock: the install that just released it may have
    // been for this very ref.
    const taken = readInstalled(home, deps);
    if (taken.commit === ref) return 0;

    const prepared = await prepareAppAt(app, repo, ref, taken.commit, deps);
    if (prepared === 'quiet') return 0;
    if (prepared !== 0) return failed('저장소 준비');

    const pnpm = await ensurePnpm(app, deps, false);
    if (pnpm !== 0) return failed('pnpm 확인');

    const built = await installAndBuild(app, deps);
    if (built !== 0) return failed('클론 빌드');

    deps.log('설치기를 시작합니다');
    const installer = await deps.run({
      command: deps.nodePath,
      args: [installerPath(app), ...installerArgs],
      cwd: app,
    });
    if (installer.code !== 0) {
      deps.log(`설치기가 종료 코드 ${String(installer.code)}로 끝났습니다.`);
      return failed('설치기');
    }

    // The installer exited 0, which says its own steps took; this says the
    // thing a hook actually needs — that the record now names the commit this
    // run was asked for. Without it a `SessionStart` would try again next
    // session, every session, and say nothing about why.
    const after = readInstalled(home, deps);
    if (after.commit !== ref) {
      deps.log(`설치기가 끝났는데 ${join(home, INSTALLED_FILE)}이 ${ref}를 담고 있지 않습니다.`);
      return failed('완료 기록 확인');
    }

    noteBootstrap(home, seen, { result: 'installed', log: logPath }, deps);
    deps.message(
      `Brain을 ${shortRef(ref)}로 설치했습니다. 이것을 사용자에게 한 줄로 전해 주세요`,
    );
    return 0;
  } finally {
    releaseLock(home, deps);
  }
}

/** The installer the clone built, which is what both modes hand over to. */
function installerPath(app: string): string {
  return join(app, 'apps', 'cli', 'dist', 'install.js');
}

/** The two steps between a checkout and the installer, in both modes. */
async function installAndBuild(app: string, deps: BootstrapDeps): Promise<number> {
  deps.log(`${app}에 의존성을 설치합니다`);
  // `--ignore-scripts`: nothing this repository depends on has an install
  // script (measured 2026-10-15), so refusing to run one costs nothing and
  // means a dependency that gains one cannot run code on a machine that only
  // started a harness session.
  const install = await deps.run({
    command: 'pnpm',
    args: ['install', '--frozen-lockfile', '--ignore-scripts'],
    cwd: app,
  });
  if (install.code !== 0) return failedStep('pnpm install', install.code, deps);

  deps.log('빌드합니다');
  const build = await deps.run({ command: 'pnpm', args: ['build'], cwd: app });
  if (build.code !== 0) return failedStep('pnpm build', build.code, deps);
  return 0;
}

/**
 * What has to be there before anything is fetched. Both lines say how to get
 * the missing thing, because someone on a fresh Mac has nothing else to go on.
 */
async function missingTools(deps: BootstrapDeps): Promise<readonly string[]> {
  const missing: string[] = [];

  if (!atLeastVersion(deps.nodeVersion, MIN_NODE_VERSION)) {
    missing.push(
      `node ${MIN_NODE_VERSION} 이상이 필요한데 이것은 ${deps.nodeVersion}입니다. \`brew install node\`로 설치하세요`,
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

  const ours = await checkClone(app, repo, deps);
  if (ours !== 0) return ours;

  // A plugin install leaves the clone detached at the commit its `app-ref`
  // named, and `pull --ff-only` on a detached HEAD fails for want of a branch
  // to track — which this function would then report as a history that has
  // diverged. Say what is actually true instead.
  const branch = await capture(['symbolic-ref', '-q', 'HEAD'], app, deps);
  if (branch.code !== 0) {
    deps.log(`${app}은 Claude Code 플러그인이 특정 commit에 고정해 둔 클론입니다.`);
    deps.log('이 클론은 npx가 아니라 플러그인의 `app-ref`로 갱신됩니다.');
    deps.log('플러그인을 업데이트하고 Claude Code 세션을 새로 시작하세요.');
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

/** 0 the clone is at `ref`, 1 it could not be, `quiet` there is nothing to do. */
type Prepared = 0 | 1 | 'quiet';

/**
 * Get `<home>/app` to exactly `ref`, for hook mode.
 *
 * A new clone is made with `--no-checkout` and then detached at the ref, and an
 * existing one is only moved forward: `HEAD` has to be an ancestor of the ref
 * before anything is checked out. `merge --ff-only <ref>` would not do — it
 * succeeds and does nothing when `HEAD` is already ahead of the ref, which is
 * exactly a user running their own newer clone (Decision 2026-10-17).
 *
 * The two questions about the recorded commit are asked here, after the fetch
 * and under the lock, rather than before any of it: the record may name a
 * commit this clone has and the plugin's ref may be one it does not, and the
 * answer to "which is newer" is not knowable until both are in the object
 * database.
 */
async function prepareAppAt(
  app: string,
  repo: string,
  ref: string,
  recorded: string | undefined,
  deps: BootstrapDeps,
): Promise<Prepared> {
  if (!deps.exists(app)) {
    deps.log(`${repo}를 ${app}에 클론합니다`);
    const clone = await deps.run({
      command: 'git',
      args: ['clone', '--no-checkout', repo, app],
    });
    if (clone.code !== 0) return failedStep('git clone', clone.code, deps);
    return detach(app, ref, deps);
  }

  const ours = await checkClone(app, repo, deps);
  if (ours !== 0) return 1;

  deps.log(`${app}에서 origin을 가져옵니다`);
  const fetched = await deps.run({ command: 'git', args: ['-C', app, 'fetch', 'origin'] });
  if (fetched.code !== 0) return failedStep('git fetch', fetched.code, deps);

  const present = await capture(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], app, deps);
  if (present.code !== 0) {
    deps.log(`플러그인이 가리키는 ${ref}가 ${app}에 없습니다.`);
    return 1;
  }

  if (recorded !== undefined) {
    if ((await isAncestor(ref, recorded, app, deps)) === true) {
      deps.log(`플러그인의 ${ref}는 설치된 ${recorded}보다 오래되었으므로 아무것도 하지 않습니다.`);
      return 'quiet';
    }
    if ((await isAncestor(recorded, ref, app, deps)) !== true) {
      deps.log(`플러그인의 ${ref}와 설치된 ${recorded}의 이력이 갈라졌으므로 아무것도 하지 않습니다.`);
      return 'quiet';
    }
  }

  if ((await isAncestor('HEAD', ref, app, deps)) !== true) {
    deps.log(`${app}의 HEAD가 ${ref}의 조상이 아니므로 Brain은 건드리지 않습니다.`);
    deps.log(`\`git -C ${app} log --oneline --graph --all -n 20\`로 이유를 보세요`);
    return 1;
  }

  return detach(app, ref, deps);
}

/** The clone, at one commit and on no branch. */
async function detach(app: string, ref: string, deps: BootstrapDeps): Promise<Prepared> {
  deps.log(`${app}을 ${ref}로 맞춥니다`);
  const checkout = await deps.run({
    command: 'git',
    args: ['-C', app, 'checkout', '--detach', ref],
  });
  if (checkout.code !== 0) return failedStep('git checkout', checkout.code, deps);
  return 0;
}

/**
 * Whether `maybeAncestor` is an ancestor of `descendant` in this clone.
 * `undefined` when git could not answer, which is a third answer and not a no:
 * acting on it would be acting on a guess.
 */
async function isAncestor(
  maybeAncestor: string,
  descendant: string,
  app: string,
  deps: BootstrapDeps,
): Promise<boolean | undefined> {
  const run = await capture(
    ['merge-base', '--is-ancestor', maybeAncestor, descendant],
    app,
    deps,
  );
  if (run.code === 0) return true;
  if (run.code === 1) return false;
  return undefined;
}

/**
 * Whether `<home>/app` is this repository's own clean clone, and nothing else.
 * Shared by both modes: the refusals are the same ones either way.
 */
async function checkClone(app: string, repo: string, deps: BootstrapDeps): Promise<number> {
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
  return 0;
}

/**
 * A pnpm of at least major 12. `mayAsk` is false in hook mode: a hook has no
 * terminal and nobody to answer it, and a `SessionStart` that installed
 * software globally without being asked would be the worst kind of surprise.
 *
 * The version is deliberately not pinned: a pin that cannot be honoured is
 * worse than no pin, since the switch fails before any work starts.
 */
async function ensurePnpm(
  app: string,
  deps: BootstrapDeps,
  mayAsk: boolean,
): Promise<number> {
  const found = await pnpmVersion(app, deps);
  if (found.enough) {
    deps.log(`pnpm ${found.version}이 준비되어 있습니다`);
    return 0;
  }

  deps.log(`${found.reason}.`);

  if (!mayAsk || !deps.isTTY) {
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

/** What `<home>/installed.json` says, as much of it as this file needs. */
export interface InstalledState {
  /** Whether there is a record at all. A first install has none. */
  present: boolean;
  /** The commit it names, when it names one that is a commit. */
  commit?: string;
}

/**
 * Read the completion record. A file that is there and cannot be understood
 * counts as present with no commit: something installed here, and this run
 * cannot tell what — which must not be read as "nothing is installed", because
 * that would make a first install of a folder that already has one.
 */
function readInstalled(home: string, deps: BootstrapDeps): InstalledState {
  const text = deps.readText(join(home, INSTALLED_FILE));
  if (text === undefined) return { present: false };

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return { present: true };
  }
  if (typeof document !== 'object' || document === null) return { present: true };
  const commit = (document as { commit?: unknown }).commit;
  return isCommit(commit) ? { present: true, commit } : { present: true };
}

/**
 * Whether `[update] auto` lets this run install a newer app.
 *
 * It is read line by line, because this file has no TOML parser and may not
 * gain a dependency to get one. Only a plain `auto = false` under an
 * `[update]` header counts: anything this reading cannot be sure about — an
 * inline table, a value spread over lines, a file that is not readable — is
 * taken as on, which is the codec's default and the answer that errs towards
 * doing what the plugin asked (Decision 2026-10-17).
 */
export function readsUpdateAutoOff(toml: string): boolean {
  let table = '';
  for (const raw of toml.split('\n')) {
    const line = raw.split('#')[0]?.trim() ?? '';
    if (line === '') continue;
    const header = /^\[\s*([^[\]]+?)\s*\]$/.exec(line);
    if (header !== null) {
      table = header[1] ?? '';
      continue;
    }
    if (table !== 'update') continue;
    const assigned = /^auto\s*=\s*(\S+)$/.exec(line);
    if (assigned === null) continue;
    return assigned[1] === 'false';
  }
  return false;
}

function updateAuto(home: string, deps: BootstrapDeps): boolean {
  const text = deps.readText(join(home, CONFIG_FILE));
  if (text === undefined) return true;
  return !readsUpdateAutoOff(text);
}

/** How the last hook run that did anything ended, for a person to be told. */
export interface LastBootstrap {
  /** When it ended, ISO-8601 in UTC (Conventions). */
  at: string;
  result: 'installed' | 'failed';
  /** The step it stopped at. Only on a failure. */
  step?: string;
  /** Where the reason is, which is the log this run was writing. */
  log: string;
}

/** `<home>/run/plugin.json`: see `PLUGIN_RUN_FILE`. */
export interface PluginRun {
  /** The plugin folder whose launcher called this file. */
  plugin_root: string;
  /** The commit that folder's `app-ref` asks to be installed. */
  app_ref: string;
  /** When those two were first seen as they are now, ISO-8601 in UTC. */
  seen_at: string;
  last_bootstrap?: LastBootstrap;
}

function pluginRunPath(home: string): string {
  return join(home, RUN_FOLDER, PLUGIN_RUN_FILE);
}

/**
 * Write down which plugin folder called and what it asks for, and answer with
 * the record as it now stands — `undefined` only when there is nothing to
 * record, which is a hook run with no `--plugin-root` and no record from an
 * earlier one.
 *
 * Nothing is written when the folder and the commit are the ones already on
 * disk. That is the case on almost every session, and this runs before the
 * decision not to install anything: a record rewritten per session would turn
 * the cheapest path in the program into a write, and `seen_at` would stop
 * meaning when this plugin was first seen.
 */
function noteSeenPlugin(
  home: string,
  pluginRoot: string | undefined,
  ref: string,
  deps: BootstrapDeps,
): PluginRun | undefined {
  const before = readPluginRun(home, deps);
  if (pluginRoot === undefined) return before;
  if (before?.plugin_root === pluginRoot && before.app_ref === ref) return before;

  const record: PluginRun = {
    plugin_root: pluginRoot,
    app_ref: ref,
    seen_at: isoTime(deps.nowMs()),
    // Carried over: it is still the last thing a bootstrap did on this machine,
    // and the session that moves the folder forward has not run the installer
    // yet — or is never going to, which is the case this record exists for.
    ...(before?.last_bootstrap === undefined ? {} : { last_bootstrap: before.last_bootstrap }),
  };
  return writePluginRun(home, record, deps) ? record : before;
}

/** Add how this run ended to the record, keeping what it says about the plugin. */
function noteBootstrap(
  home: string,
  seen: PluginRun | undefined,
  outcome: Omit<LastBootstrap, 'at'>,
  deps: BootstrapDeps,
): void {
  if (seen === undefined) return;
  writePluginRun(home, { ...seen, last_bootstrap: { ...outcome, at: isoTime(deps.nowMs()) } }, deps);
}

/** Temp file and rename, so a doctor reading it sees one record or the other. */
function writePluginRun(home: string, record: PluginRun, deps: BootstrapDeps): boolean {
  const path = pluginRunPath(home);
  const temp = `${path}.${String(deps.pid)}.tmp`;
  deps.makeFolders(join(home, RUN_FOLDER));
  deps.writeText(temp, `${JSON.stringify(record, undefined, 2)}\n`);
  if (deps.moveFile(temp, path)) return true;
  // Said out loud rather than swallowed (Conventions): a doctor that goes on
  // reading the completion record's folder is the consequence, and this is the
  // only account of why.
  deps.log(`${path}에 플러그인 기록을 쓸 수 없었습니다.`);
  return false;
}

/**
 * The record as it was last written, or `undefined` when there is none or it
 * cannot be read back whole. Every field is checked, because this file is read
 * by `brain doctor run` to decide which folder it reports on, and a half-read
 * record would point it at a path that was never written here.
 */
function readPluginRun(home: string, deps: BootstrapDeps): PluginRun | undefined {
  const text = deps.readText(pluginRunPath(home));
  if (text === undefined) return undefined;

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null) return undefined;

  const record = document as Record<string, unknown>;
  const root = record['plugin_root'];
  const appRef = record['app_ref'];
  const seenAt = record['seen_at'];
  if (typeof root !== 'string' || root === '') return undefined;
  if (!isCommit(appRef) || typeof seenAt !== 'string' || seenAt === '') return undefined;

  const last = lastBootstrapOf(record['last_bootstrap']);
  return {
    plugin_root: root,
    app_ref: appRef,
    seen_at: seenAt,
    ...(last === undefined ? {} : { last_bootstrap: last }),
  };
}

/** The outcome in a record, or `undefined` when it is not one to carry over. */
function lastBootstrapOf(value: unknown): LastBootstrap | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = value as Record<string, unknown>;
  const at = found['at'];
  const result = found['result'];
  const log = found['log'];
  const step = found['step'];
  if (typeof at !== 'string' || at === '') return undefined;
  if (result !== 'installed' && result !== 'failed') return undefined;
  if (typeof log !== 'string' || log === '') return undefined;
  const named = typeof step === 'string' && step !== '';
  // A failure with no step names nothing a person could act on.
  if (result === 'failed' && !named) return undefined;
  return { at, result, log, ...(named ? { step: step as string } : {}) };
}

/** The storage normal form of a time (Conventions): UTC, to the millisecond. */
function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

/**
 * Take `<home>/install.lock`, or answer that somebody else has it.
 *
 * `mkdir` of one folder is the one "create unless it exists" every filesystem
 * does atomically, so the folder is the lock and the `pid` file inside it is
 * only the owner's name. A lock whose owner is gone, or one nobody has touched
 * for `LOCK_STALE_MS`, is reclaimed once — once, because a loop of reclaiming
 * and failing to take would be two processes fighting over a third's folder.
 */
function takeLock(home: string, deps: BootstrapDeps): boolean {
  const lock = join(home, LOCK_FOLDER);
  deps.makeFolders(home);

  if (deps.makeFolder(lock)) {
    deps.writeText(join(lock, LOCK_PID_FILE), `${String(deps.pid)}\n`);
    return true;
  }
  if (!staleLock(lock, deps)) return false;

  deps.removeFolder(lock);
  if (!deps.makeFolder(lock)) return false;
  deps.writeText(join(lock, LOCK_PID_FILE), `${String(deps.pid)}\n`);
  return true;
}

/** Whether the lock that is there belongs to nobody any more. */
function staleLock(lock: string, deps: BootstrapDeps): boolean {
  const text = deps.readText(join(lock, LOCK_PID_FILE));
  const pid = text === undefined ? undefined : pidOf(text);
  // An owner that is gone cannot come back, however recently the folder was
  // touched.
  if (pid !== undefined && !deps.alive(pid)) return true;

  // Otherwise the age decides, whether there was a pid to read or not: pids
  // are recycled, and a live process that is not this lock's owner would
  // otherwise make the lock permanent.
  const mtime = deps.folderMtimeMs(lock);
  if (mtime === undefined) return false;
  return deps.nowMs() - mtime > LOCK_STALE_MS;
}

/** The decimal pid one line holds, or `undefined` when it holds no pid. */
function pidOf(text: string): number | undefined {
  const matched = /^\s*(\d+)\s*$/.exec(text);
  const pid = matched?.[1];
  if (pid === undefined) return undefined;
  const number = Number(pid);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/**
 * Release the lock, on every ending there is. It is called from a `finally`,
 * so a failure, a refusal and an exception all leave the folder free: a lock
 * left behind by a crash costs the next session half an hour.
 */
function releaseLock(home: string, deps: BootstrapDeps): void {
  deps.removeFolder(join(home, LOCK_FOLDER));
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
function failedStep(step: string, code: number, deps: BootstrapDeps): 1 {
  deps.log(`\`${step}\`이 실패했습니다. 종료 코드 ${String(code)}.`);
  return 1;
}

/** The major of `12.11.2` or `v24.16.0`; undefined when it is not a version. */
function majorOf(version: string): number | undefined {
  const major = Number.parseInt(version.replace(/^v/, ''), 10);
  return Number.isNaN(major) ? undefined : major;
}

/**
 * Whether `version` is at or above `floor`, comparing major, minor and patch
 * as numbers. It is `apps/cli/src/runtime/node-floor.ts`'s rule, spelled again
 * because this file may import nothing; a test ties the two floors together.
 */
export function atLeastVersion(version: string, floor: string): boolean {
  const left = versionParts(version);
  const right = versionParts(floor);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const mine = left[index] ?? 0;
    const theirs = right[index] ?? 0;
    if (mine !== theirs) return mine > theirs;
  }
  return true;
}

function versionParts(value: string): [number, number, number] | undefined {
  const matched = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  const [major, minor, patch] = [matched?.[1], matched?.[2], matched?.[3]];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [Number(major), Number(minor), Number(patch)];
}

/** A full object name: 40 lowercase hex characters and nothing else. */
function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The first seven characters, as git prints a commit for a person to read. */
function shortRef(ref: string): string {
  return ref.slice(0, 7);
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
  /** Where progress lines go, once hook mode has said where. */
  let logPath: string | undefined;
  let logFd: number | undefined;

  /**
   * The log's file descriptor, opened on first use. Lazy on purpose: a session
   * that decides there is nothing to install must leave no file behind, and
   * opening in append mode creates one.
   *
   * A log that cannot be opened is given up on rather than retried, and the
   * lines go to stderr instead — never to stdout, which in hook mode carries
   * one line and is read by the model. The harness drops a hook's stderr when
   * it exits 0, which it always does here, so this is a sink and not a second
   * kind of output; dropping the lines outright would leave this file with no
   * account of what it did at all.
   */
  const logFile = (): number | undefined => {
    if (logPath === undefined) return undefined;
    if (logFd !== undefined) return logFd;
    try {
      mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
      logFd = openSync(logPath, 'a', 0o600);
      writeSync(logFd, `\n=== ${new Date().toISOString()} ===\n`);
    } catch {
      // Not `undefined`: that would mean npx mode, where the lines belong on
      // stdout. `2` is stderr, which is the right sink for both.
      logFd = 2;
    }
    return logFd;
  };

  return {
    run: (request: CommandRequest) => runCommand(request, logFile),
    ask: askTerminal,
    // Both ends have to be a terminal: a question needs an answer and a place
    // to be read. Anything else counts as "no" (I/O matrix).
    isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
    log: (line: string): void => {
      const fd = logFile();
      if (fd === undefined) {
        process.stdout.write(`${line}\n`);
        return;
      }
      try {
        writeSync(fd, `${line}\n`);
      } catch {
        // Not stdout: in hook mode that is the model's context, and it carries
        // one line (Decision 2026-10-17).
        process.stderr.write(`${line}\n`);
      }
    },
    message: (text: string): void => {
      process.stdout.write(`${JSON.stringify({ systemMessage: text })}\n`);
    },
    logToFile: (path: string): void => {
      logPath = path;
    },
    exists: existsSync,
    realpath: (path: string): string => {
      try {
        return realpathSync(path);
      } catch {
        return path;
      }
    },
    readText: (path: string): string | undefined => {
      try {
        return readFileSync(path, 'utf8');
      } catch {
        return undefined;
      }
    },
    writeText: (path: string, text: string): void => {
      try {
        writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
      } catch {
        // The lock is the folder; its `pid` file is only the owner's name, and
        // a lock with no name in it is still held. Failing the install over a
        // file nobody has to read would be the wrong trade.
      }
    },
    moveFile: (from: string, to: string): boolean => {
      try {
        renameSync(from, to);
        return true;
      } catch {
        try {
          rmSync(from, { force: true });
        } catch {
          // Nothing left to try. The caller says so in the log.
        }
        return false;
      }
    },
    makeFolder: (path: string): boolean => {
      try {
        mkdirSync(path, { mode: 0o700 });
        return true;
      } catch {
        return false;
      }
    },
    // 0700, like the codec and the shim make it: `.env` lives in this folder,
    // and a `mkdir -p` at the default mode would leave it world-readable.
    makeFolders: (path: string): void => {
      try {
        mkdirSync(path, { recursive: true, mode: 0o700 });
      } catch {
        // Nothing to do about it here: the step that needed the folder fails
        // next, and says which one it was.
      }
    },
    removeFolder: (path: string): void => {
      try {
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Same: a lock that cannot be released goes stale, which the next run
        // reclaims. There is no better answer available from here.
      }
    },
    folderMtimeMs: (path: string): number | undefined => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    },
    alive: (pid: number): boolean => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        // EPERM is a process this user may not signal, which is still a
        // process: only ESRCH means there is nobody there.
        return (error as { code?: unknown }).code === 'EPERM';
      }
    },
    nowMs: () => Date.now(),
    pid: process.pid,
    nodeVersion: process.versions.node,
    nodePath: process.execPath,
  };
}

/** One child's three streams. A number is a file descriptor to write to. */
export type ChildStdio = readonly ['ignore' | 'inherit', 'pipe' | 'inherit' | number, 'inherit' | number];

/**
 * Where one child's streams go: `log` is the log file's descriptor in hook
 * mode and `undefined` in npx mode, which is the one thing that distinguishes
 * the two.
 *
 * stdin is the part that matters. In npx mode the installer asks four
 * questions, so it has to keep this process's stdin — closing it would make
 * every interactive `npx` answer exit 3, "needs a confirmation nobody gave".
 * In hook mode there is no terminal behind it and nothing may be asked, so
 * stdin is closed rather than inherited from whatever started the harness.
 *
 * A captured probe never has questions and its stdin is closed either way.
 */
export function childStdio(captured: boolean, log: number | undefined): ChildStdio {
  // In hook mode a child's own output is part of the account of what happened,
  // and the one line on stdout is not the place for it.
  const sink = log ?? 'inherit';
  const input = captured || log !== undefined ? 'ignore' : 'inherit';
  // Only the answer is read from a captured child; its stderr still goes to
  // the terminal — or to the log — so a probe that fails says why instead of
  // turning into a bare refusal.
  return [input, captured ? 'pipe' : sink, sink];
}

function runCommand(
  request: CommandRequest,
  logFile: () => number | undefined,
): Promise<CommandResult> {
  const captured = request.capture === true;
  return new Promise((resolve) => {
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      stdio: [...childStdio(captured, logFile())],
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
