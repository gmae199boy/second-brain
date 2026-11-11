#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, writeFileSync, writeSync, } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
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
 * Historical lock age retained for compatibility; age no longer permits recovery.

 */
export const LOCK_STALE_MS = 30 * 60 * 1000;
// A snapshot records even ignored build artifacts and Git metadata. Never follow
// symlinks, and refuse unusual files rather than deleting an unverified object.
function backupEntry(root, path) {
    const full = path ? join(root, path) : root;
    const stat = lstatSync(full);
    const directory = stat.isDirectory();
    const content = directory ? 'dir' : stat.isFile()
        ? createHash('sha256').update(readFileSync(full)).digest('hex')
        : stat.isSymbolicLink() ? `link:${readlinkSync(full)}` : (() => { throw new Error('unsupported backup entry'); })();
    return { path, directory, identity: `${stat.dev}:${stat.ino}:${stat.mode}:${content}` };
}
function snapshotBackup(root) {
    const entries = [];
    const walk = (path) => {
        const entry = backupEntry(root, path);
        entries.push(entry);
        if (entry.directory)
            for (const name of readdirSync(path ? join(root, path) : root).sort())
                walk(path ? join(path, name) : name);
    };
    walk('');
    return entries;
}
function removeVerifiedBackup(root, entries) {
    try {
        const expected = new Map(entries.map(entry => [entry.path, entry]));
        if (expected.size !== entries.length || !expected.get('')?.directory)
            return false;
        const current = snapshotBackup(root);
        if (current.some(entry => JSON.stringify(entry) !== JSON.stringify(expected.get(entry.path))))
            return false;
        for (const entry of current.reverse()) {
            // Check again at deletion, and use rmdir for directories so a new child
            // can never be swept away by a recursive removal.
            if (JSON.stringify(backupEntry(root, entry.path)) !== JSON.stringify(entry))
                return false;
            const full = entry.path ? join(root, entry.path) : root;
            if (entry.directory)
                rmdirSync(full);
            else
                rmSync(full);
        }
        return true;
    }
    catch {
        return false;
    }
}
/** The configuration folder for this run — the same rule as the CLI's. */
export function resolveHome(env) {
    const override = env[HOME_ENV]?.trim();
    if (override !== undefined && override !== '') {
        return override;
    }
    return join(homedir(), DEFAULT_HOME_FOLDER);
}
export function resolveRepo(env) {
    const override = env[REPO_ENV]?.trim();
    if (override !== undefined && override !== '') {
        return override;
    }
    return DEFAULT_REPO;
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
export function parseArgs(argv) {
    const rest = [];
    let ref;
    let pluginRoot;
    let interactiveRef = false;
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '--interactive-ref') {
            interactiveRef = true;
            continue;
        }
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
                // Absolute only, which is what the installer accepts: a relative path
                // would be recorded against this process's working directory, and a
                // hook's working directory is whatever the harness was started in.
                const trimmed = value.trim();
                if (isAbsolute(trimmed))
                    pluginRoot = trimmed;
            }
        }
        rest.push(argument ?? '');
    }
    return {
        ...(ref === undefined ? {} : { ref }),
        ...(interactiveRef ? { interactiveRef: true } : {}),
        ...(pluginRoot === undefined ? {} : { pluginRoot }),
        rest,
    };
}
/**
 * The whole run, as an exit code. `argv` is the user's arguments, without the
 * node and script entries; everything but `--ref` is passed on to the
 * installer.
 */
export async function main(argv, env, deps) {
    const parsed = parseArgs(argv);
    if (parsed.interactiveRef) {
        if (!isCommit(parsed.ref)) {
            deps.log('대화형 갱신에는 전체 커밋 식별자가 필요합니다.');
            return 1;
        }
        return interactiveRefMode(parsed.ref, parsed.rest, env, deps);
    }
    return parsed.ref === undefined
        ? npxMode(parsed.rest, env, deps)
        : hookMode(parsed.ref, parsed.pluginRoot, parsed.rest, env, deps);
}
/**
 * The door a person takes. It asks, it prints as it goes, and it hands the
 * installer's own exit code straight back.
 */
async function npxMode(argv, env, deps) {
    // Absolute from here on: every command below runs with the clone as its
    // working directory, so a relative home would be resolved against itself
    // once per step.
    const home = resolve(resolveHome(env));
    const app = join(home, APP_FOLDER);
    const repo = resolveRepo(env);
    const missing = await missingTools(deps);
    if (missing.length > 0) {
        for (const line of missing)
            deps.log(line);
        return 1;
    }
    // The same lock a `SessionStart` takes. An install that ran beside one
    // already in flight would have two `pnpm install`s in one `node_modules` and
    // two installers writing one configuration folder.
    const lockOwner = await waitForLock(home, deps);
    const stage = join(home, `.app-stage-${randomUUID()}`);
    try {
        const hadApp = deps.exists(app);
        if (deps.exists(join(home, '.app-next'))) {
            deps.log('중단된 app 전환을 먼저 복구하세요');
            return 1;
        }
        if (hadApp) {
            if (await checkClone(app, repo, deps) !== 0)
                return 1;
            if ((await capture(['symbolic-ref', '-q', 'HEAD'], app, deps)).code !== 0) {
                deps.log('고정된 클론은 플러그인의 ref로 갱신하세요');
                return 1;
            }
        }
        const previous = hadApp ? await capture(['rev-parse', 'HEAD'], app, deps) : undefined;
        if (previous && (previous.code !== 0 || !/^[0-9a-f]{40}$/.test(previous.stdout.trim())))
            return 1;
        const folder = await prepareApp(stage, repo, deps);
        if (folder !== 0)
            return folder;
        if (previous && await isAncestor(previous.stdout.trim(), 'HEAD', stage, deps) !== true) {
            deps.log('기존 app 이력과 대상 이력이 일치하지 않습니다');
            return 1;
        }
        const pnpm = await ensurePnpm(stage, deps, true);
        if (pnpm !== 0)
            return pnpm;
        const built = await installAndBuild(stage, deps);
        if (built !== 0)
            return built;
        const target = stagedTarget(stage, deps);
        if (!target) {
            deps.log('대상 설치기가 app 승격을 지원하는지 확인할 수 없습니다. 지원되는 버전으로 다시 시도하세요.');
            return 1;
        }
        deps.log('설치기를 시작합니다');
        const installer = await deps.run({
            command: deps.nodePath,
            args: [installerPath(stage), ...argv],
            cwd: stage,
            env: { ...process.env, SECOND_BRAIN_INSTALL_LOCK_OWNER: lockOwner, SECOND_BRAIN_STAGED_APP: stage, SECOND_BRAIN_PREVIOUS_APP_HEAD: previous?.stdout.trim() ?? '' },
        });
        // The installer owns the outcome from here on, so hand its code straight on.
        if (installer.code === 0 && (deps.readText(join(stage, 'apps/cli/dist/build.json')) !== deps.readText(join(app, 'apps/cli/dist/build.json')) || !await finishAppPromotion(home, repo, target, lockOwner, deps)))
            return 1;
        return installer.code;
    }
    finally {
        deps.removeFolder(stage);
        releaseLock(home, deps, lockOwner);
    }
}
/** Explicit ref upgrade with the same staged and lock fences as the hook,
 * while retaining the terminal streams for the installer. */
async function interactiveRefMode(ref, argv, env, deps) {
    const home = resolve(resolveHome(env));
    const app = join(home, APP_FOLDER);
    const repo = resolveRepo(env);
    const missing = await missingTools(deps);
    if (missing.length) {
        for (const line of missing)
            deps.log(line);
        return 1;
    }
    const lockOwner = await waitForLock(home, deps);
    const stage = join(home, `.app-stage-${randomUUID()}`);
    try {
        const installed = readInstalled(home, deps);
        if (installed.present && !installed.commit) {
            deps.log('설치 기록의 commit을 확인할 수 없습니다.');
            return 1;
        }
        if (deps.exists(join(home, '.app-promotion.json')) && installed.commit === ref) {
            return await finishAppPromotion(home, repo, ref, lockOwner, deps) ? 0 : 1;
        }
        const interrupted = deps.exists(join(home, '.app-promotion.json'));
        if (interrupted) {
            if (!installed.commit || !await validateInterruptedPromotion(home, repo, ref, installed.commit, deps)) {
                deps.log('중단된 app 전환의 신원 또는 소유권을 확인할 수 없습니다.');
                return 1;
            }
        }
        else if (deps.exists(join(home, '.app-next')) || deps.exists(join(home, '.app-previous'))) {
            deps.log('중단된 app 전환을 먼저 복구하세요');
            return 1;
        }
        if (installed.present && !deps.exists(app)) {
            deps.log('설치 기록에 해당하는 app이 없습니다.');
            return 1;
        }
        if (deps.exists(app)) {
            const prepared = await prepareAppAt(app, repo, ref, installed.commit === ref ? undefined : installed.commit, deps, true);
            if (prepared !== 0) {
                if (prepared === 'quiet')
                    deps.log('요청한 ref로 갱신할 수 없습니다.');
                return 1;
            }
        }
        const previous = deps.exists(app) ? await capture(['rev-parse', 'HEAD'], app, deps) : undefined;
        if (previous && (previous.code !== 0 || !isCommit(previous.stdout.trim()))) {
            deps.log('기존 app 신원을 확인할 수 없습니다.');
            return 1;
        }
        if (installed.commit && previous && await isAncestor(installed.commit, previous.stdout.trim(), app, deps) !== true) {
            deps.log('설치 기록과 기존 app 이력이 일치하지 않습니다.');
            return 1;
        }
        const staged = await prepareAppAt(stage, repo, ref, undefined, deps);
        if (staged !== 0)
            return 1;
        const pnpm = await ensurePnpm(stage, deps, true);
        if (pnpm !== 0)
            return pnpm;
        const built = await installAndBuild(stage, deps);
        if (built !== 0)
            return built;
        if (stagedTarget(stage, deps) !== ref) {
            deps.log('대상 설치기의 app 승격 지원을 확인할 수 없습니다.');
            return 1;
        }
        deps.log('설치기를 시작합니다');
        const installer = await deps.run({ command: deps.nodePath, args: [installerPath(stage), ...argv], cwd: stage,
            env: { ...process.env, SECOND_BRAIN_INSTALL_LOCK_OWNER: lockOwner, SECOND_BRAIN_STAGED_APP: stage, SECOND_BRAIN_PREVIOUS_APP_HEAD: previous?.stdout.trim() ?? '' } });
        if (installer.code !== 0)
            return installer.code;
        if (readInstalled(home, deps).commit !== ref || deps.readText(join(stage, 'apps/cli/dist/build.json')) !== deps.readText(join(app, 'apps/cli/dist/build.json')) || !await finishAppPromotion(home, repo, ref, lockOwner, deps)) {
            deps.log('설치 완료 기록 또는 app 승격을 확인할 수 없습니다.');
            return 1;
        }
        return 0;
    }
    finally {
        deps.removeFolder(stage);
        releaseLock(home, deps, lockOwner);
    }
}
/** Validate the incomplete promotion before allowing the installer to re-enter.
 * Its journal is an audit record only: the installer must automatically recheck
 * its own database and daemon fences before doing any migration. */
async function validateInterruptedPromotion(home, repo, ref, installed, deps) {
    const app = join(home, APP_FOLDER), previous = join(home, '.app-previous');
    if (!deps.exists(app) || !deps.exists(previous) || deps.exists(join(home, '.app-next')))
        return false;
    try {
        const marker = JSON.parse(deps.readText(join(home, '.app-promotion.json')) ?? '');
        const journal = JSON.parse(deps.readText(join(home, RUN_FOLDER, 'bootstrap-extension-migrations.json')) ?? '');
        const owner = typeof marker.owner === 'string' ? /^(\d+) ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\n$/.exec(marker.owner) : null;
        const pid = Number(owner?.[1]);
        const confirmation = journal.offlineConfirmation;
        if (marker.target !== ref || marker.hadPrevious !== true || !owner || !Number.isSafeInteger(pid) || pid < 1 || deps.alive(pid) || journal.promotionOwner !== marker.owner || !isCommit(marker.previousHead) || marker.previousHead !== journal.previousHead || journal.commit !== ref || !Array.isArray(journal.names) || journal.names.some(name => typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,30}$/.test(name)) || typeof journal.owner !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(journal.owner) || confirmation?.home !== deps.realpath(home) || confirmation.previous_commit !== installed || confirmation.target_commit !== ref || (confirmation.method !== 'operator' && confirmation.method !== 'automatic'))
            return false;
        if (stagedTarget(app, deps) !== ref || await checkClone(app, repo, deps) !== 0 || await checkClone(previous, repo, deps) !== 0)
            return false;
        const [activeHead, oldHead] = await Promise.all([capture(['rev-parse', 'HEAD'], app, deps), capture(['rev-parse', 'HEAD'], previous, deps)]);
        if (activeHead.code !== 0 || activeHead.stdout.trim() !== ref || oldHead.code !== 0 || oldHead.stdout.trim() !== marker.previousHead)
            return false;
        if (await isAncestor(installed, marker.previousHead, app, deps) !== true || await isAncestor(marker.previousHead, ref, app, deps) !== true)
            return false;
        return true;
    }
    catch {
        return false;
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
async function hookMode(ref, pluginRoot, installerArgs, env, deps) {
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
    const failed = (step) => {
        noteBootstrap(home, seen.record, { result: 'failed', step, log: logPath }, deps);
        deps.message(`Brain 설치가 ${step}에서 멈췄습니다. 까닭은 ${logPath}에 있습니다. ` +
            '이것을 사용자에게 한 줄로 전하고, 자세한 상태는 `brain doctor run`이 말한다고 알려 주세요');
        return 1;
    };
    // The fast path, and the one that runs on almost every session: one JSON
    // file, and a few lines of TOML. No git, no pnpm, nothing spawned.
    const before = readInstalled(home, deps);
    if (before.commit === ref && !deps.exists(join(home, '.app-promotion.json')) && !deps.exists(join(home, '.app-previous')) && !deps.exists(join(home, '.app-next')))
        return 0;
    // A first install happens whatever the configuration says — there is no
    // installation yet for an update to be automatic about.
    if (before.present && before.commit !== ref && !updateAuto(home, deps)) {
        // Nothing is being installed, and the one thing a person will ask next is
        // what the difference is. `doctor run` answers that by asking the clone
        // which of the two commits is the ancestor, and the plugin's commit was
        // pushed after the last install, so the clone does not have it and the
        // check can only say it does not know. One fetch, no checkout: the clone
        // stays exactly where it is (Never: the update behaviour itself).
        if (seen.moved)
            await fetchOrigin(app, deps);
        return 0;
    }
    const missing = await missingTools(deps);
    if (missing.length > 0) {
        for (const line of missing)
            deps.log(line);
        return failed('필요한 도구 확인');
    }
    // Wait for the shared lock; a previous installer may be updating this home.
    const lockOwner = await waitForLock(home, deps);
    const stage = join(home, `.app-stage-${randomUUID()}`);
    try {
        // Read again under the lock: the install that just released it may have
        // been for this very ref.
        const taken = readInstalled(home, deps);
        if (taken.commit === ref) {
            if (!deps.exists(join(home, '.app-promotion.json')))
                return deps.exists(join(home, '.app-previous')) || deps.exists(join(home, '.app-next')) ? failed('중단된 app 전환 복구') : 0;
            return await finishAppPromotion(home, repo, ref, lockOwner, deps) ? 0 : failed('중단된 app 전환 복구');
        }
        const interrupted = deps.exists(join(home, '.app-promotion.json'));
        if (interrupted && (!taken.commit || !await validateInterruptedPromotion(home, repo, ref, taken.commit, deps)))
            return failed('중단된 app 전환 신원 확인');
        if (!interrupted && deps.exists(join(home, '.app-previous')))
            return failed('중단된 app 전환 복구');
        if (deps.exists(join(home, '.app-next')))
            return failed('중단된 app 전환 복구');
        const prepared = deps.exists(app) ? await prepareAppAt(app, repo, ref, taken.commit, deps, true) : 0;
        if (prepared === 'quiet')
            return 0;
        if (prepared !== 0)
            return failed('저장소 준비');
        const previous = deps.exists(app) ? await capture(['rev-parse', 'HEAD'], app, deps) : undefined;
        if (previous && (previous.code !== 0 || !/^[0-9a-f]{40}$/.test(previous.stdout.trim())))
            return failed('기존 app 신원 확인');
        const staged = await prepareAppAt(stage, repo, ref, undefined, deps);
        if (staged !== 0)
            return failed('대상 저장소 준비');
        const pnpm = await ensurePnpm(stage, deps, false);
        if (pnpm !== 0)
            return failed('pnpm 확인');
        const built = await installAndBuild(stage, deps);
        if (built !== 0)
            return failed('클론 빌드');
        if (stagedTarget(stage, deps) !== ref)
            return failed('대상 설치기 승격 지원 확인');
        deps.log('설치기를 시작합니다');
        const installer = await deps.run({
            command: deps.nodePath,
            args: [installerPath(stage), ...installerArgs],
            cwd: stage,
            env: { ...process.env, SECOND_BRAIN_INSTALL_LOCK_OWNER: lockOwner, SECOND_BRAIN_STAGED_APP: stage, SECOND_BRAIN_PREVIOUS_APP_HEAD: previous?.stdout.trim() ?? '' },
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
        if (deps.readText(join(stage, 'apps/cli/dist/build.json')) !== deps.readText(join(app, 'apps/cli/dist/build.json')) || !await finishAppPromotion(home, repo, ref, lockOwner, deps))
            return failed('이전 app 정리');
        noteBootstrap(home, seen.record, { result: 'installed', log: logPath }, deps);
        deps.message(`Brain을 ${shortRef(ref)}로 설치했습니다. 이것을 사용자에게 한 줄로 전해 주세요`);
        return 0;
    }
    finally {
        deps.removeFolder(stage);
        releaseLock(home, deps, lockOwner);
    }
}
/** The installer the clone built, which is what both modes hand over to. */
function installerPath(app) {
    return join(app, 'apps', 'cli', 'dist', 'install.js');
}
/** Remove only the previous app named by this installer's promotion marker. */
function stagedTarget(stage, deps) {
    try {
        const build = JSON.parse(deps.readText(join(stage, 'apps/cli/dist/build.json')) ?? '');
        return build.staged_promotion === 1 && typeof build.commit === 'string' && /^[0-9a-f]{40}$/.test(build.commit) && deps.exists(installerPath(stage)) ? build.commit : undefined;
    }
    catch {
        return undefined;
    }
}
async function finishAppPromotion(home, repo, target, lockOwner, deps) {
    const marker = join(home, '.app-promotion.json'), backup = join(home, '.app-previous');
    const journalPath = join(home, RUN_FOLDER, 'bootstrap-extension-migrations.json');
    try {
        const markerText = deps.readText(marker);
        const record = JSON.parse(markerText ?? '');
        const app = join(home, APP_FOLDER);
        const build = JSON.parse(deps.readText(join(app, 'apps/cli/dist/build.json')) ?? '');
        const bin = join(app, 'apps/cli/dist/bin.js');
        const quoted = `'${bin.replaceAll("'", `'\\''`)}'`;
        const shim = deps.readText(join(home, 'bin/brain'))?.split('\n') ?? [];
        const match = typeof record.owner === 'string' ? /^(\d+) ([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\n$/.exec(record.owner) : null;
        const pid = Number(match?.[1]);
        if (record.backupEntries !== undefined && (record.cleanup !== true || !Array.isArray(record.backupEntries)))
            return false;
        if (record.target !== target || !match || !Number.isSafeInteger(pid) || pid < 1 || (record.owner !== lockOwner && deps.alive(pid)) || deps.readText(join(home, LOCK_FOLDER, 'owner')) !== lockOwner || typeof record.hadPrevious !== 'boolean' || (!record.hadPrevious && deps.exists(backup)) || (record.hadPrevious && !deps.exists(backup) && record.cleanup !== true) || (record.hadPrevious ? !isCommit(record.previousHead) : record.previousHead !== null) || deps.exists(join(home, '.app-next')) || build.commit !== target || build.staged_promotion !== 1 || readInstalled(home, deps).commit !== target || !deps.exists(bin) || !shim.includes(`BIN=${quoted}`) || !shim.includes('exec "$NODE" "$BIN" "$@"'))
            return false;
        if (await checkClone(app, repo, deps) !== 0)
            return false;
        const head = await capture(['rev-parse', 'HEAD'], app, deps);
        if (head.code !== 0 || head.stdout.trim() !== target)
            return false;
        if (record.hadPrevious && await isAncestor(record.previousHead, target, app, deps) !== true)
            return false;
        if (record.hadPrevious && deps.exists(backup) && !Array.isArray(record.backupEntries)) {
            if (await checkClone(backup, repo, deps) !== 0)
                return false;
            const oldHead = await capture(['rev-parse', 'HEAD'], backup, deps);
            if (oldHead.code !== 0 || oldHead.stdout.trim() !== record.previousHead)
                return false;
        }
        if (deps.readText(join(home, LOCK_FOLDER, 'owner')) !== lockOwner || deps.readText(marker) !== markerText)
            return false;
        const journalText = deps.readText(journalPath);
        if (journalText === undefined && deps.exists(journalPath))
            return false;
        if (journalText !== undefined) {
            const journal = JSON.parse(journalText);
            if (journal.commit !== target || journal.promotionOwner !== record.owner || journal.previousHead !== record.previousHead)
                return false;
            deps.removeFolder(journalPath);
            if (deps.exists(journalPath))
                return false;
        }
        if (record.cleanup !== true || (record.hadPrevious && deps.exists(backup) && !Array.isArray(record.backupEntries))) {
            const temp = `${marker}.${String(deps.pid)}.tmp`;
            const backupEntries = record.hadPrevious && deps.exists(backup) ? deps.snapshotBackup(backup) : undefined;
            if (backupEntries && (await checkClone(backup, repo, deps) !== 0 || JSON.stringify(deps.snapshotBackup(backup)) !== JSON.stringify(backupEntries)))
                return false;
            if (deps.readText(join(home, LOCK_FOLDER, 'owner')) !== lockOwner || deps.readText(marker) !== markerText)
                return false;
            const content = JSON.stringify({ ...record, cleanup: true, backupEntries });
            deps.writeText(temp, content);
            if (deps.readText(temp) !== content || !deps.moveFile(temp, marker) || deps.readText(marker) !== content)
                return false;
            record.backupEntries = backupEntries;
        }
        if (deps.readText(join(home, LOCK_FOLDER, 'owner')) !== lockOwner)
            return false;
        if (deps.exists(backup) && (!record.backupEntries || !deps.removeVerifiedBackup(backup, record.backupEntries)))
            return false;
    }
    catch {
        return false;
    }
    if (deps.exists(backup))
        return false;
    deps.removeFolder(marker);
    return !deps.exists(marker);
}
/** The two steps between a checkout and the installer, in both modes. */
async function installAndBuild(app, deps) {
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
    if (install.code !== 0)
        return failedStep('pnpm install', install.code, deps);
    deps.log('빌드합니다');
    const build = await deps.run({ command: 'pnpm', args: ['build'], cwd: app });
    if (build.code !== 0)
        return failedStep('pnpm build', build.code, deps);
    return 0;
}
/**
 * What has to be there before anything is fetched. Both lines say how to get
 * the missing thing, because someone on a fresh Mac has nothing else to go on.
 */
async function missingTools(deps) {
    const missing = [];
    if (!atLeastVersion(deps.nodeVersion, MIN_NODE_VERSION)) {
        missing.push(`node ${MIN_NODE_VERSION} 이상이 필요한데 이것은 ${deps.nodeVersion}입니다. \`brew install node\`로 설치하세요`);
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
async function prepareApp(app, repo, deps) {
    if (!deps.exists(app)) {
        deps.log(`${repo}를 ${app}에 클론합니다`);
        // git creates the parent folders of the destination itself.
        const clone = await deps.run({ command: 'git', args: ['clone', repo, app] });
        if (clone.code !== 0)
            return failedStep('git clone', clone.code, deps);
        return 0;
    }
    const ours = await checkClone(app, repo, deps);
    if (ours !== 0)
        return ours;
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
async function prepareAppAt(app, repo, ref, recorded, deps, checkOnly = false) {
    if (!deps.exists(app)) {
        deps.log(`${repo}를 ${app}에 클론합니다`);
        const clone = await deps.run({
            command: 'git',
            args: ['clone', '--no-checkout', repo, app],
        });
        if (clone.code !== 0)
            return failedStep('git clone', clone.code, deps);
        return detach(app, ref, deps);
    }
    const ours = await checkClone(app, repo, deps);
    if (ours !== 0)
        return 1;
    deps.log(`${app}에서 origin을 가져옵니다`);
    const fetched = await deps.run({ command: 'git', args: ['-C', app, 'fetch', 'origin'] });
    if (fetched.code !== 0)
        return failedStep('git fetch', fetched.code, deps);
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
    return checkOnly ? 0 : detach(app, ref, deps);
}
/** The clone, at one commit and on no branch. */
async function detach(app, ref, deps) {
    deps.log(`${app}을 ${ref}로 맞춥니다`);
    const checkout = await deps.run({
        command: 'git',
        args: ['-C', app, 'checkout', '--detach', ref],
    });
    if (checkout.code !== 0)
        return failedStep('git checkout', checkout.code, deps);
    return 0;
}
/**
 * Whether `maybeAncestor` is an ancestor of `descendant` in this clone.
 * `undefined` when git could not answer, which is a third answer and not a no:
 * acting on it would be acting on a guess.
 */
async function isAncestor(maybeAncestor, descendant, app, deps) {
    const run = await capture(['merge-base', '--is-ancestor', maybeAncestor, descendant], app, deps);
    if (run.code === 0)
        return true;
    if (run.code === 1)
        return false;
    return undefined;
}
/**
 * Whether `<home>/app` is this repository's own clean clone, and nothing else.
 * Shared by both modes: the refusals are the same ones either way.
 */
async function checkClone(app, repo, deps) {
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
    if (status.code !== 0)
        return failedStep('git status', status.code, deps);
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
async function ensurePnpm(app, deps, mayAsk) {
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
    if (installed.code !== 0)
        return failedStep(PNPM_INSTALL_COMMAND, installed.code, deps);
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
/** What `pnpm` the PATH finds, in the clone, where a pin would still apply. */
async function pnpmVersion(app, deps) {
    const found = await deps.run({ command: 'pnpm', args: ['--version'], cwd: app, capture: true });
    const version = found.stdout.trim();
    const major = majorOf(version);
    if (found.code === 0 && major !== undefined && major >= MIN_PNPM_MAJOR) {
        return { enough: true, version, reason: '' };
    }
    const reason = found.code === 0 && major !== undefined
        ? `pnpm ${version}은 ${MIN_PNPM_MAJOR}보다 오래되었습니다`
        : 'pnpm이 설치되어 있지 않습니다';
    return { enough: false, version, reason };
}
/**
 * Read the completion record. A file that is there and cannot be understood
 * counts as present with no commit: something installed here, and this run
 * cannot tell what — which must not be read as "nothing is installed", because
 * that would make a first install of a folder that already has one.
 */
function readInstalled(home, deps) {
    const text = deps.readText(join(home, INSTALLED_FILE));
    if (text === undefined)
        return { present: false };
    let document;
    try {
        document = JSON.parse(text);
    }
    catch {
        return { present: true };
    }
    if (typeof document !== 'object' || document === null)
        return { present: true };
    const commit = document.commit;
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
export function readsUpdateAutoOff(toml) {
    let table = '';
    for (const raw of toml.split('\n')) {
        const line = raw.split('#')[0]?.trim() ?? '';
        if (line === '')
            continue;
        const header = /^\[\s*([^[\]]+?)\s*\]$/.exec(line);
        if (header !== null) {
            table = header[1] ?? '';
            continue;
        }
        if (table !== 'update')
            continue;
        const assigned = /^auto\s*=\s*(\S+)$/.exec(line);
        if (assigned === null)
            continue;
        return assigned[1] === 'false';
    }
    return false;
}
function updateAuto(home, deps) {
    const text = deps.readText(join(home, CONFIG_FILE));
    if (text === undefined)
        return true;
    return !readsUpdateAutoOff(text);
}
function pluginRunPath(home) {
    return join(home, RUN_FOLDER, PLUGIN_RUN_FILE);
}
/**
 * Write down which plugin folder called and what it asks for.
 *
 * Nothing is written when the folder and the commit are the ones already on
 * disk. That is the case on almost every session, and this runs before the
 * decision not to install anything: a record rewritten per session would turn
 * the cheapest path in the program into a write, and `seen_at` would stop
 * meaning when this plugin was first seen.
 */
function noteSeenPlugin(home, pluginRoot, ref, deps) {
    const before = readPluginRun(home, deps);
    if (pluginRoot === undefined) {
        return { ...(before === undefined ? {} : { record: before }), moved: false };
    }
    if (before?.plugin_root === pluginRoot && before.app_ref === ref) {
        return { record: before, moved: false };
    }
    const record = {
        plugin_root: pluginRoot,
        app_ref: ref,
        seen_at: isoTime(deps.nowMs()),
        // Carried over: it is still the last thing a bootstrap did on this machine,
        // and the session that moves the folder forward has not run the installer
        // yet — or is never going to, which is the case this record exists for.
        ...(before?.last_bootstrap === undefined ? {} : { last_bootstrap: before.last_bootstrap }),
    };
    writePluginRun(home, record, deps);
    return { record, moved: true };
}
/**
 * Bring origin's commits into the clone without touching what is checked out.
 *
 * A failure is logged and no more: this runs on a path that is not installing
 * anything, and the only thing that depends on it is how well `doctor run` can
 * describe two commits.
 */
async function fetchOrigin(app, deps) {
    deps.log(`${app}에서 origin을 가져옵니다`);
    const fetched = await deps.run({ command: 'git', args: ['-C', app, 'fetch', 'origin'] });
    if (fetched.code !== 0) {
        deps.log(`\`git fetch\`가 실패했습니다. 종료 코드 ${String(fetched.code)}.`);
    }
}
/** Add how this run ended to the record, keeping what it says about the plugin. */
function noteBootstrap(home, seen, outcome, deps) {
    if (seen === undefined)
        return;
    writePluginRun(home, { ...seen, last_bootstrap: { ...outcome, at: isoTime(deps.nowMs()) } }, deps);
}
/** Temp file and rename, so a doctor reading it sees one record or the other. */
function writePluginRun(home, record, deps) {
    const path = pluginRunPath(home);
    const temp = `${path}.${String(deps.pid)}.tmp`;
    deps.makeFolders(join(home, RUN_FOLDER));
    deps.writeText(temp, `${JSON.stringify(record, undefined, 2)}\n`);
    if (deps.moveFile(temp, path))
        return true;
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
function readPluginRun(home, deps) {
    const text = deps.readText(pluginRunPath(home));
    if (text === undefined)
        return undefined;
    let document;
    try {
        document = JSON.parse(text);
    }
    catch {
        return undefined;
    }
    if (typeof document !== 'object' || document === null)
        return undefined;
    const record = document;
    const root = record['plugin_root'];
    const appRef = record['app_ref'];
    const seenAt = record['seen_at'];
    if (typeof root !== 'string' || root === '')
        return undefined;
    if (!isCommit(appRef) || typeof seenAt !== 'string' || seenAt === '')
        return undefined;
    const last = lastBootstrapOf(record['last_bootstrap']);
    return {
        plugin_root: root,
        app_ref: appRef,
        seen_at: seenAt,
        ...(last === undefined ? {} : { last_bootstrap: last }),
    };
}
/** The outcome in a record, or `undefined` when it is not one to carry over. */
function lastBootstrapOf(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const found = value;
    const at = found['at'];
    const result = found['result'];
    const log = found['log'];
    const step = found['step'];
    if (typeof at !== 'string' || at === '')
        return undefined;
    if (result !== 'installed' && result !== 'failed')
        return undefined;
    if (typeof log !== 'string' || log === '')
        return undefined;
    const named = typeof step === 'string' && step !== '';
    // A failure with no step names nothing a person could act on.
    if (result === 'failed' && !named)
        return undefined;
    return { at, result, log, ...(named ? { step: step } : {}) };
}
/** The storage normal form of a time (Conventions): UTC, to the millisecond. */
function isoTime(ms) {
    return new Date(ms).toISOString();
}
/** A lock with missing or dead owner is retained: a child may still write. */
async function waitForLock(home, deps) {
    const lock = join(home, LOCK_FOLDER);
    deps.makeFolders(home);
    let warned = false;
    for (;;) {
        if (deps.makeFolder(lock)) {
            const owner = `${deps.pid} ${randomUUID()}\n`;
            deps.writeText(join(lock, LOCK_PID_FILE), `${deps.pid}\n`);
            deps.writeText(join(lock, 'owner'), owner);
            if (deps.readText(join(lock, 'owner')) !== owner)
                throw new Error('설치 잠금 소유권을 기록하지 못했습니다');
            return owner;
        }
        if (!warned) {
            deps.log('다른 설치가 진행 중이거나 이전 설치 잠금이 남아 기다립니다. 복구하려면 새 설치를 차단하고 이전 설치와 모든 자식의 공유 상태 쓰기 종료를 확인한 뒤 해당 잠금만 제거하고 다시 실행하세요.');
            warned = true;
        }
        await (deps.waitForInstallLock?.() ?? new Promise(resolve => setTimeout(resolve, 100)));
    }
}
/** Only the invocation whose unique token remains in the lock may release it. */
function releaseLock(home, deps, owner) {
    const lock = join(home, LOCK_FOLDER);
    if (deps.readText(join(lock, 'owner')) === owner)
        deps.removeFolder(lock);
}
function capture(args, app, deps) {
    return deps.run({ command: 'git', args: ['-C', app, ...args], capture: true });
}
function leaveItAlone(app) {
    return `${app}을 다른 곳으로 옮기거나 ${HOME_ENV}을 다른 곳으로 가리킨 뒤 다시 실행하세요.`;
}
/** Every failure of a step says which step and what code. Exit 1 throughout. */
function failedStep(step, code, deps) {
    deps.log(`\`${step}\`이 실패했습니다. 종료 코드 ${String(code)}.`);
    return 1;
}
/** The major of `12.11.2` or `v24.16.0`; undefined when it is not a version. */
function majorOf(version) {
    const major = Number.parseInt(version.replace(/^v/, ''), 10);
    return Number.isNaN(major) ? undefined : major;
}
/**
 * Whether `version` is at or above `floor`, comparing major, minor and patch
 * as numbers. It is `apps/cli/src/runtime/node-floor.ts`'s rule, spelled again
 * because this file may import nothing; a test ties the two floors together.
 */
export function atLeastVersion(version, floor) {
    const left = versionParts(version);
    const right = versionParts(floor);
    if (left === undefined || right === undefined)
        return false;
    for (let index = 0; index < 3; index += 1) {
        const mine = left[index] ?? 0;
        const theirs = right[index] ?? 0;
        if (mine !== theirs)
            return mine > theirs;
    }
    return true;
}
function versionParts(value) {
    const matched = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
    const [major, minor, patch] = [matched?.[1], matched?.[2], matched?.[3]];
    if (major === undefined || minor === undefined || patch === undefined)
        return undefined;
    return [Number(major), Number(minor), Number(patch)];
}
/** A full object name: 40 lowercase hex characters and nothing else. */
function isCommit(value) {
    return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}
/** The first seven characters, as git prints a commit for a person to read. */
function shortRef(ref) {
    return ref.slice(0, 7);
}
/**
 * Whether two URLs name the same repository, as far as a trailing slash and a
 * trailing `.git` go: `…/x`, `…/x/` and `…/x.git` are one. It does not equate
 * different forms of the same remote — `git@host:owner/x` and
 * `https://host/owner/x` are two repositories here, and a clone made with one
 * will not be updated by a run that asks for the other.
 */
export function sameRepo(left, right) {
    return bareUrl(left) === bareUrl(right);
}
function bareUrl(url) {
    return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}
/** The real world, injected in one place so the tests can replace all of it. */
export function systemDeps() {
    /** Where progress lines go, once hook mode has said where. */
    let logPath;
    let logFd;
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
    const logFile = () => {
        if (logPath === undefined)
            return undefined;
        if (logFd !== undefined)
            return logFd;
        try {
            mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 });
            logFd = openSync(logPath, 'a', 0o600);
            writeSync(logFd, `\n=== ${new Date().toISOString()} ===\n`);
        }
        catch {
            // Not `undefined`: that would mean npx mode, where the lines belong on
            // stdout. `2` is stderr, which is the right sink for both.
            logFd = 2;
        }
        return logFd;
    };
    return {
        run: (request) => runCommand(request, logFile),
        ask: askTerminal,
        // Both ends have to be a terminal: a question needs an answer and a place
        // to be read. Anything else counts as "no" (I/O matrix).
        isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
        log: (line) => {
            const fd = logFile();
            if (fd === undefined) {
                process.stdout.write(`${line}\n`);
                return;
            }
            try {
                writeSync(fd, `${line}\n`);
            }
            catch {
                // Not stdout: in hook mode that is the model's context, and it carries
                // one line (Decision 2026-10-17).
                process.stderr.write(`${line}\n`);
            }
        },
        message: (text) => {
            process.stdout.write(`${JSON.stringify({ systemMessage: text })}\n`);
        },
        logToFile: (path) => {
            logPath = path;
        },
        exists: existsSync,
        realpath: (path) => {
            try {
                return realpathSync(path);
            }
            catch {
                return path;
            }
        },
        readText: (path) => {
            try {
                return readFileSync(path, 'utf8');
            }
            catch {
                return undefined;
            }
        },
        writeText: (path, text) => {
            try {
                writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 });
            }
            catch {
                // The caller verifies the owner record before allowing any install.
            }
        },
        moveFile: (from, to) => {
            try {
                renameSync(from, to);
                return true;
            }
            catch {
                try {
                    rmSync(from, { force: true });
                }
                catch {
                    // Nothing left to try. The caller says so in the log.
                }
                return false;
            }
        },
        makeFolder: (path) => {
            try {
                mkdirSync(path, { mode: 0o700 });
                return true;
            }
            catch {
                return false;
            }
        },
        // 0700, like the codec and the shim make it: `.env` lives in this folder,
        // and a `mkdir -p` at the default mode would leave it world-readable.
        makeFolders: (path) => {
            try {
                mkdirSync(path, { recursive: true, mode: 0o700 });
            }
            catch {
                // Nothing to do about it here: the step that needed the folder fails
                // next, and says which one it was.
            }
        },
        snapshotBackup,
        removeVerifiedBackup,
        removeFolder: (path) => {
            try {
                rmSync(path, { recursive: true, force: true });
            }
            catch {
                // A lock that cannot be released remains for explicit recovery.
            }
        },
        folderMtimeMs: (path) => {
            try {
                return statSync(path).mtimeMs;
            }
            catch {
                return undefined;
            }
        },
        alive: (pid) => {
            try {
                process.kill(pid, 0);
                return true;
            }
            catch (error) {
                // EPERM is a process this user may not signal, which is still a
                // process: only ESRCH means there is nobody there.
                return error.code === 'EPERM';
            }
        },
        nowMs: () => Date.now(),
        pid: process.pid,
        nodeVersion: process.versions.node,
        nodePath: process.execPath,
    };
}
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
export function childStdio(captured, log) {
    // In hook mode a child's own output is part of the account of what happened,
    // and the one line on stdout is not the place for it.
    const sink = log ?? 'inherit';
    const input = captured || log !== undefined ? 'ignore' : 'inherit';
    // Only the answer is read from a captured child; its stderr still goes to
    // the terminal — or to the log — so a probe that fails says why instead of
    // turning into a bare refusal.
    return [input, captured ? 'pipe' : sink, sink];
}
function runCommand(request, logFile) {
    const captured = request.capture === true;
    return new Promise((resolve) => {
        const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            env: request.env,
            stdio: [...childStdio(captured, logFile())],
        });
        let stdout = '';
        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        // A command that is not installed is not an exception here, it is an
        // answer: 127, the shell's own code for it.
        child.once('error', () => resolve({ code: 127, stdout }));
        child.once('close', (code) => resolve({ code: code ?? 1, stdout }));
    });
}
async function askTerminal(question) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
        const answer = await terminal.question(`${question} [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
    }
    finally {
        terminal.close();
    }
}
/**
 * True when node was told to run this file, rather than a test importing it.
 * Both sides go through `realpathSync` because npm links the entry into a
 * `node_modules/.bin`, and because `/tmp` on a Mac is a symlink.
 */
function invokedDirectly(here) {
    const entry = process.argv[1];
    if (entry === undefined)
        return false;
    try {
        return realpathSync(entry) === realpathSync(fileURLToPath(here));
    }
    catch {
        return false;
    }
}
if (invokedDirectly(import.meta.url)) {
    process.exitCode = await main(process.argv.slice(2), process.env, systemDeps());
}
