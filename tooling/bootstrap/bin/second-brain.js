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
 * The whole run, as an exit code. `argv` is the user's arguments, without the
 * node and script entries; they are passed on to the installer.
 */
export async function main(argv, env, deps) {
    // Absolute from here on: every command below runs with the clone as its
    // working directory, so a relative home would be resolved against itself
    // once per step.
    const app = resolve(resolveHome(env), APP_FOLDER);
    const repo = resolveRepo(env);
    const missing = await missingTools(deps);
    if (missing.length > 0) {
        for (const line of missing)
            deps.log(line);
        return 1;
    }
    const folder = await prepareApp(app, repo, deps);
    if (folder !== 0)
        return folder;
    const pnpm = await ensurePnpm(app, deps);
    if (pnpm !== 0)
        return pnpm;
    deps.log(`installing dependencies in ${app}`);
    const install = await deps.run({
        command: 'pnpm',
        args: ['install', '--frozen-lockfile'],
        cwd: app,
    });
    if (install.code !== 0)
        return failedStep('pnpm install', install.code, deps);
    deps.log('building');
    const build = await deps.run({ command: 'pnpm', args: ['build'], cwd: app });
    if (build.code !== 0)
        return failedStep('pnpm build', build.code, deps);
    deps.log('starting the installer');
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
async function missingTools(deps) {
    const missing = [];
    const major = majorOf(deps.nodeVersion);
    if (major === undefined || major < MIN_NODE_MAJOR) {
        missing.push(`node ${MIN_NODE_MAJOR} or newer is required, this is ${deps.nodeVersion}. Install it with: brew install node`);
    }
    const git = await deps.run({ command: 'git', args: ['--version'], capture: true });
    if (git.code !== 0) {
        missing.push('git is required. Install it with: xcode-select --install');
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
        deps.log(`cloning ${repo} into ${app}`);
        // git creates the parent folders of the destination itself.
        const clone = await deps.run({ command: 'git', args: ['clone', repo, app] });
        if (clone.code !== 0)
            return failedStep('git clone', clone.code, deps);
        return 0;
    }
    // The top level of the clone, not `--is-inside-work-tree`: that answers for
    // an enclosing repository too, so an empty `<home>/app` inside somebody's
    // own clone of this repository would look like a clone of it — and get
    // pulled, one folder up from where Brain was looking.
    const toplevel = await capture(['rev-parse', '--show-toplevel'], app, deps);
    if (toplevel.code !== 0 || deps.realpath(toplevel.stdout.trim()) !== deps.realpath(app)) {
        deps.log(`${app} is there but is not a git clone, so Brain will not touch it.`);
        deps.log(leaveItAlone(app));
        return 1;
    }
    const origin = await capture(['remote', 'get-url', 'origin'], app, deps);
    const url = origin.stdout.trim();
    if (origin.code !== 0 || !sameRepo(url, repo)) {
        const what = url === '' ? 'an unknown repository' : url;
        deps.log(`${app} is a clone of ${what}, not of ${repo}, so Brain will not touch it.`);
        deps.log(leaveItAlone(app));
        return 1;
    }
    const status = await capture(['status', '--porcelain'], app, deps);
    if (status.code !== 0)
        return failedStep('git status', status.code, deps);
    if (status.stdout.trim() !== '') {
        deps.log(`${app} has local changes, so Brain will not update it.`);
        deps.log(`See them with: git -C ${app} status`);
        deps.log('Keep or drop them yourself, then run this again.');
        return 1;
    }
    deps.log(`updating ${app}`);
    // Fast-forward only: if history has diverged, a human decides, not Brain.
    const pull = await deps.run({ command: 'git', args: ['-C', app, 'pull', '--ff-only'] });
    if (pull.code !== 0) {
        deps.log(`${app} cannot be fast-forwarded, so Brain left it as it is.`);
        deps.log(`See why with: git -C ${app} log --oneline --graph --all -n 20`);
        return 1;
    }
    return 0;
}
/**
 * A pnpm of at least major 12, asking first. The version is deliberately not
 * pinned: a pin that cannot be honoured is worse than no pin, since the
 * switch fails before any work starts.
 */
async function ensurePnpm(app, deps) {
    const found = await pnpmVersion(app, deps);
    if (found.enough) {
        deps.log(`pnpm ${found.version} is in place`);
        return 0;
    }
    deps.log(`${found.reason}.`);
    if (!deps.isTTY) {
        deps.log(`Run this yourself and start again: ${PNPM_INSTALL_COMMAND}`);
        return 1;
    }
    const agreed = await deps.ask(`Install the latest pnpm now (${PNPM_INSTALL_COMMAND})?`);
    if (!agreed) {
        deps.log(`Run this yourself and start again: ${PNPM_INSTALL_COMMAND}`);
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
        deps.log(`${after.reason}, even after ${PNPM_INSTALL_COMMAND}.`);
        deps.log('Another pnpm must come first on your PATH. Find it with: which -a pnpm');
        return 1;
    }
    deps.log(`pnpm ${after.version} is in place`);
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
        ? `pnpm ${version} is older than ${MIN_PNPM_MAJOR}`
        : 'pnpm is not installed';
    return { enough: false, version, reason };
}
function capture(args, app, deps) {
    return deps.run({ command: 'git', args: ['-C', app, ...args], capture: true });
}
function leaveItAlone(app) {
    return `Move ${app} aside, or point ${HOME_ENV} somewhere else, then run this again.`;
}
/** Every failure of a step says which step and what code. Exit 1 throughout. */
function failedStep(step, code, deps) {
    deps.log(`${step} failed with exit code ${code}.`);
    return 1;
}
/** The major of `12.11.2` or `v24.16.0`; undefined when it is not a version. */
function majorOf(version) {
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
export function sameRepo(left, right) {
    return bareUrl(left) === bareUrl(right);
}
function bareUrl(url) {
    return url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
}
/** The real world, injected in one place so the tests can replace all of it. */
export function systemDeps() {
    return {
        run: runCommand,
        ask: askTerminal,
        // Both ends have to be a terminal: a question needs an answer and a place
        // to be read. Anything else counts as "no" (I/O matrix).
        isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true,
        log: (line) => {
            process.stdout.write(`${line}\n`);
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
        nodeVersion: process.versions.node,
        nodePath: process.execPath,
    };
}
function runCommand(request) {
    const captured = request.capture === true;
    return new Promise((resolve) => {
        const child = spawn(request.command, [...request.args], {
            cwd: request.cwd,
            // Only the answer is read; stderr still goes to the terminal, so a probe
            // that fails says why instead of turning into a bare refusal.
            stdio: captured ? ['ignore', 'pipe', 'inherit'] : 'inherit',
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
