import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  isoWithOffset,
  prereqFailed,
  type DoctorCheck,
  type DoctorCheckSource,
  type Spool,
} from 'second_brain';
import { readConfig, type ReadConfigResult } from '../config/codec.js';
import { HOME_ENV, configFilePath, pluginRunPath, spoolPath, lastHookPath } from '../config/paths.js';
import {
  appRootPath,
  readAppRef,
  readBuildIdentity,
  readInstalled,
  readPluginRun,
  shortCommit,
  type BuildIdentity,
  type InstalledRecord,
  type LastBootstrap,
} from '../install/installed.js';
import { SHIM_SIGNATURE, parseShim, shimPath, type ParsedShim } from '../install/shim.js';
import { harnesses } from '../harnesses.js';
import { systemClock } from '../runtime/clock.js';
import { NODE_FLOOR, atLeast, meetsNodeFloor } from '../runtime/node-floor.js';
import { fileSpool } from '../runtime/spool.js';

/**
 * Lowest node this build runs on, and the comparison behind it. They live in
 * `runtime/node-floor.ts` because `install/shim.ts` writes the same floor into
 * the `sh` it generates and cannot import this module back, and they are
 * re-exported here because this is where a reader of doctor looks for them.
 */
export { NODE_FLOOR, atLeast, meetsNodeFloor };

/**
 * How long the shim's node is given to answer `--version`. It is a check, not
 * a command: a node on a network share that has gone away must make doctor
 * slower by two seconds, not hang it.
 */
export const NODE_PROBE_TIMEOUT_MS = 2_000;

/**
 * How long git is given to answer an ancestry question. Longer than the node
 * probe because it may be the first command to touch a cold object database,
 * and still short enough that a clone on a disconnected network share makes
 * doctor slower rather than hanging it.
 */
export const GIT_PROBE_TIMEOUT_MS = 5_000;

/** What asking a node for its version came back with. */
export type NodeRun = { ok: true; stdout: string } | { ok: false; message: string };

/**
 * Running `<node> --version`, injected so the node checks can be driven from a
 * test without a second node on the machine.
 */
export type RunNode = (path: string) => Promise<NodeRun>;

export interface RuntimeChecksOptions {
  harnessNames?: readonly string[];
  /** The configuration folder these checks are about. */
  home: string;
  /**
   * What reading the configuration already answered, so the `config` check
   * reports that rather than reading the folder a second time. Left out — as
   * the installer leaves it out — the check reads it itself.
   */
  config?: ReadConfigResult;
  /** Test seam. Defaults to `execFile` with the timeout above. */
  runNode?: RunNode;
  /** Test seam for the `plugin` check's ancestry questions. */
  runGit?: RunGit;
  /**
   * The spool the `spool` check reports on. Defaults to this home's folder,
   * which is what every real invocation wants; a test hands in the in-memory
   * fake to reach the answers a folder cannot be put into.
   */
  spool?: Spool;
}

/**
 * Asking git whether one commit is an ancestor of another, injected because the
 * interesting answers — behind, ahead, diverged, unknown — cannot all be
 * arranged in the clone the tests run from.
 *
 * The answer is the exit code of `git merge-base --is-ancestor`, as a code and
 * not a boolean: 0 is yes, 1 is no, and anything else means git could not
 * answer, which is a third thing the check has to be able to say.
 */
export type RunGit = (args: readonly string[]) => Promise<{ code: number }>;

/**
 * The runtime's half of `brain doctor run`, for one configuration folder: the
 * checks a store cannot answer because they are facts about this machine — the
 * configuration file, the shim a harness hook calls, and the node behind it —
 * in the order they are reported.
 *
 * It is the one list, and both callers take it: the dispatcher hands it to
 * `createBrain`, and the installer's last step hands it to `runDoctor` for the
 * home it just wrote. So a check added here appears in both without anything
 * else being touched, which is the whole reason it is a list and not two call
 * sites with four checks written out.
 *
 * Later epics add to it here: a connector's own check per harness and the last
 * hook arrival (epic 2, 3), the mirror and the export (epic 4, 5), the
 * embedding backlog and replication lag (epic 6, 7).
 *
 * `node-path` comes after `shim` because it is a statement about the node the
 * shim names: with no node name to read, there is nothing to ask, which is a
 * `skip` and not a failure of node's. A shim that failed for some other reason
 * still names a node, and that node is still asked.
 */
export function runtimeChecks(options: RuntimeChecksOptions): readonly DoctorCheckSource[] {
  const { home } = options;
  const runNode = options.runNode ?? systemRunNode;
  const runGit = options.runGit ?? systemRunGit;
  const spool = options.spool ?? fileSpool({ folder: spoolPath(home), clock: systemClock });
  // Read and parsed once: `shim` and `node-path` are two statements about the
  // same file, and two reads could disagree about it.
  const shim = once(async () => inspectShim(home));
  // The same rule for the configuration: `config` reports it and `plugin`
  // reads `[update] auto` out of it, and one report makes one statement.
  const config = once(async () => options.config ?? (await readConfig(home)));

  return [
    { id: 'config', run: async () => configCheck(home, await config()) },
    { id: 'shim', run: async () => shimCheck(await shim()) },
    { id: 'node-path', run: async () => nodePathCheck(await shim(), runNode) },
    { id: 'node-version', run: async () => nodeVersionCheck() },
    { id: 'plugin', run: async () => pluginCheck(home, await config(), runGit) },
    { id: 'last-hook', run: async () => lastHookCheck(home, options.harnessNames ?? harnesses.map((h) => h.parser.harness)) },
    { id: 'spool', run: async () => spoolCheck(spool) },
  ];
}

/**
 * What is waiting in the spool: writes the database could not take, which a
 * later drain will put in (AD-9).
 *
 * It is a `warn` and not a `fail` whenever there is anything, because nothing
 * is broken — the spool working is the brain working, and the records are safe
 * until drain runs. But it may not be silent either: the one failure mode this
 * whole mechanism has is a spool that fills up and nobody notices, and until
 * drain exists (story 11) this line is the only place anyone would see it.
 *
 * A folder that is not there is nothing waiting, which is the state of a brain
 * whose database has always been reachable.
 */
async function spoolCheck(spool: Spool): Promise<DoctorCheck> {
  const stats = await spool.stats();
  if (!stats.ok) {
    return { id: 'spool', status: 'fail', detail: stats.message };
  }

  // Lines nobody will try again: a line nothing could read, a record that
  // failed its ten attempts, a `.open` file a killed process left behind. They
  // are added to whichever sentence this check was going to say, because this
  // line is the only place anybody would ever see them (2026-10-16).
  const aside = stats.failed === 0 ? '' : `, 실패로 옮긴 줄 ${String(stats.failed)}건`;

  if (stats.records === 0) {
    // Still a `warn` when something was given up on, and still not a `fail`:
    // nothing is broken, and the records are kept rather than lost — but a
    // write that will never reach the database must not be silent (NFR-2).
    return stats.failed === 0
      ? { id: 'spool', status: 'ok', detail: '0건' }
      : { id: 'spool', status: 'warn', code: 'SPOOLED', detail: `0건${aside}` };
  }
  const count = `${String(stats.records)}건`;
  // The instant with this machine's offset, as every instant a person reads
  // is (Conventions, 시각). `null` only for records nothing could decode: the
  // count is still worth saying.
  const waiting =
    stats.earliest === null ? count : `${count}, 가장 오래된 것 ${isoWithOffset(stats.earliest)}`;
  return { id: 'spool', status: 'warn', code: 'SPOOLED', detail: `${waiting}${aside}` };
}

/**
 * The configuration file. It is a check rather than a precondition because
 * doctor is `diagnostic`: it runs without a configuration on purpose, so that
 * "there is no configuration" is something the report says instead of something
 * that stops the report (Decision 2026-10-14).
 */
function configCheck(home: string, read: ReadConfigResult): DoctorCheck {
  if (!read.ok) {
    return { id: 'config', status: 'fail', code: read.code, detail: read.message };
  }
  return { id: 'config', status: 'ok', detail: configFilePath(home) };
}

/**
 * What one read of `<home>/bin/brain` established.
 *
 * `shim` and `message` are independent on purpose: a file that parsed and is
 * still unusable — not executable, unsigned, carrying another home, naming an
 * entry point that is gone — has both, and the node it names is a fact worth
 * checking even then. Only a file that could not be read, or not parsed, leaves
 * `shim` unset.
 */
export interface ShimState {
  path: string;
  /** The shim's three facts, when the file could be read and parsed. */
  shim?: ParsedShim;
  /** Why the shim is not usable. Unset when it is. */
  message?: string;
  /**
   * What is worth saying about a shim that is still usable. A shim carrying
   * another folder than the one being asked about is the one of these: it is
   * somebody's second installation, or a `SECOND_BRAIN_HOME` pointed somewhere
   * for an afternoon, and calling that a failure made doctor refuse to say
   * anything else about a working install (F9).
   */
  warning?: string;
}

/**
 * Everything the shim has to be for a hook to work: there, executable, written
 * by us, readable back, pointed at this installation, and naming an entry point
 * that exists. A hook is started with none of the user's shell environment
 * (AD-19), so any one of these missing means every turn fails silently — which
 * is exactly the failure a doctor check is for.
 */
export async function inspectShim(home: string): Promise<ShimState> {
  const path = shimPath(home);
  const rerun = '`brain setup run`을 실행하세요.';

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { path, message: `${path}을 읽을 수 없습니다: ${describe(error)}. ${rerun}` };
  }

  const shim = parseShim(text);
  if (shim === undefined) {
    return { path, message: `${path}을 다시 읽어 들일 수 없습니다. ${rerun}` };
  }

  // Not a failure, and every check below carries on: this file works, it just
  // belongs to another folder than the one being asked about (F9). Both paths
  // are named, because which of the two is wrong is the reader's to decide.
  const carried =
    shim.home === home
      ? {}
      : {
          warning:
            `${path}이 담고 있는 폴더는 ${shim.home}이고, 지금 보는 폴더는 ${home}입니다. ` +
            `두 설치가 있거나 ${HOME_ENV}이 다른 곳을 가리킵니다.`,
        };

  // From here the shim's own facts are known, so they travel with every answer
  // below: the node it names is asked about whichever of these failed.
  const failed = (message: string): ShimState => ({ path, shim, ...carried, message });

  try {
    await access(path, constants.X_OK);
  } catch {
    return failed(`${path}에 실행 권한이 없습니다. ${rerun}`);
  }

  if (!text.includes(SHIM_SIGNATURE)) {
    return failed(`${path}에 brain 서명 줄이 없습니다. ${rerun}`);
  }

  if (!(await isReadable(shim.bin))) {
    return failed(`${path}이 가리키는 진입점이 없습니다: ${shim.bin}. ${rerun}`);
  }

  return { path, shim, ...carried };
}

function shimCheck(state: ShimState): DoctorCheck {
  if (state.message !== undefined) {
    return { id: 'shim', status: 'fail', detail: state.message };
  }
  if (state.warning !== undefined) {
    // No code: nothing is degraded and nothing is being worked around, so
    // there is no shared code that would mean this (Conventions).
    return { id: 'shim', status: 'warn', detail: state.warning };
  }
  return { id: 'shim', status: 'ok', detail: state.path };
}

/**
 * The plugin's relationship to this installation: which plugin folder the last
 * session came from, what that folder asks for, what the last install recorded,
 * and what the `dist/` answering this command was built from (AD-19, F7).
 *
 * It is the one line that tells a person why a session did not update, and the
 * one place the last bootstrap's own outcome is reported. The bootstrap's
 * `SessionStart` is silent about everything it decides not to do — a line per
 * session would go into the model's context every turn (Decision 2026-10-17) —
 * and what it does say reaches the model and not the screen (Decision
 * 2026-10-18), so "there is a newer app and `[update] auto` is off" and "the
 * last install stopped at the build" have to be said here or nowhere.
 *
 * Every answer but a clean match is a `warn`, never a `fail`: none of them is a
 * broken installation. The two that have a shared code carry it, so the
 * envelope's `warnings[]` names them; the rest say their sentence and no more.
 */
async function pluginCheck(
  home: string,
  config: ReadConfigResult,
  runGit: RunGit,
): Promise<DoctorCheck> {
  const record = await readInstalled(home);
  const seen = await readPluginRun(home);
  // What is added to whatever the comparison below comes to. Both are about
  // the same one subject — the plugin — so they are one check's one line and
  // not a second check (Conventions: one problem, one line).
  const notes: string[] = [];
  if (seen.status === 'invalid') {
    notes.push(`${pluginRunPath(home)}을 읽을 수 없어서 무시했습니다`);
  }
  const last = seen.status === 'ok' ? seen.record.last_bootstrap : undefined;
  if (last !== undefined) notes.push(lastBootstrapSentence(last));

  const verdict = await pluginVerdict(
    home,
    record,
    config,
    runGit,
    seen.status === 'ok' ? seen.record.plugin_root : undefined,
  );

  // A bootstrap that stopped part way through is worth saying out loud however
  // the comparison came out: the hook says it once, to the model, in a session
  // the person may never have looked at (Decision 2026-10-18). Unless the
  // install finished afterwards by another door — an `npx` run or a
  // `setup run` — in which case the hook has had nothing to do since and will
  // never rewrite the record, and a warn about it would never go away.
  const stillStopped =
    last?.result === 'failed' &&
    !(record !== undefined && finishedAfter(record.installed_at, last.at));
  const status = verdict.status === 'ok' && stillStopped ? 'warn' : verdict.status;
  const detail = sentences(verdict.detail, ...notes);
  return { ...verdict, status, ...(detail === '' ? {} : { detail }) };
}

/** Whether the completion record was written after that outcome was recorded. */
function finishedAfter(installedAt: string, at: string): boolean {
  const installed = Date.parse(installedAt);
  const stopped = Date.parse(at);
  // Either time unreadable is not "later": the outcome stands until something
  // says otherwise.
  return Number.isFinite(installed) && Number.isFinite(stopped) && installed > stopped;
}

/** One sentence about the last bootstrap, for somebody who was not watching. */
function lastBootstrapSentence(last: LastBootstrap): string {
  if (last.result === 'installed') return `마지막 설치는 ${last.at}에 끝났습니다`;
  const step = last.step ?? '알 수 없는 단계';
  return `마지막 설치는 ${last.at}에 ${step}에서 멈췄습니다. 까닭은 ${last.log}에 있습니다`;
}

/**
 * Sentences into one line, with one full stop between each pair of them. One
 * part is handed back exactly as it was: the sentences below are written whole,
 * and only joining them calls for a stop to be taken off the end of one.
 */
function sentences(...parts: readonly (string | undefined)[]): string {
  const found = parts.filter((part): part is string => part !== undefined && part !== '');
  if (found.length < 2) return found[0] ?? '';
  return found.map((part) => part.replace(/\.$/, '')).join('. ');
}

/**
 * The comparison itself: what the record says, what the plugin folder asks
 * for, and how the two are related.
 *
 * `seenRoot` is the folder the last session's hook came from, when there is a
 * record of one. It comes first because it is the folder that is asking now,
 * and `installed.json`'s is the folder that asked last time anything was
 * installed — which after a `claude plugin update` with no install since is a
 * version-numbered folder nothing calls any more (2.5 human check 1).
 */
async function pluginVerdict(
  home: string,
  record: InstalledRecord | undefined,
  config: ReadConfigResult,
  runGit: RunGit,
  seenRoot: string | undefined,
): Promise<DoctorCheck> {
  const ok = (detail: string): DoctorCheck => ({ id: 'plugin', status: 'ok', detail });
  const warn = (detail: string, code?: string): DoctorCheck => ({
    id: 'plugin',
    status: 'warn',
    ...(code === undefined ? {} : { code }),
    detail,
  });

  const pluginRoot = seenRoot ?? record?.plugin_root ?? null;
  if (pluginRoot === null) {
    return record === undefined
      ? // Nothing has finished installing here yet, which the `config` and
        // `shim` checks above already say. One problem, one line.
        ok('완료 기록이 아직 없습니다')
      : ok('플러그인이 아닌 경로로 설치되었습니다');
  }
  if (record === undefined) {
    // A plugin has run a hook here and no install has finished: either one is
    // running right now, or the one that ran did not get through.
    return ok(`${pluginRoot}의 플러그인이 왔지만 완료 기록이 아직 없습니다`);
  }
  const installed = record.commit;
  if (installed === null) {
    return warn(`${pluginRoot}에서 설치했지만 기록에 빌드 commit이 없습니다`);
  }

  const ref = await readAppRef(pluginRoot);
  if (ref === undefined) {
    return warn(`${pluginRoot}의 app-ref를 읽을 수 없습니다`);
  }

  const mismatch = buildMismatch(await readBuildIdentity(), installed);
  if (mismatch !== undefined) return warn(mismatch);

  if (ref === installed) {
    return ok(`플러그인과 설치가 같은 ${shortCommit(ref)}입니다`);
  }

  const behind = await isAncestor(ref, installed, runGit);
  if (behind === true) {
    return warn(
      `플러그인의 app-ref ${shortCommit(ref)}가 설치된 ${shortCommit(installed)}보다 오래되었습니다`,
      'PLUGIN_BEHIND',
    );
  }

  const ahead = await isAncestor(installed, ref, runGit);
  if (ahead === true) {
    const auto = config.ok ? config.config.updateAuto : true;
    return auto
      ? ok(`플러그인이 ${shortCommit(ref)}를 담고 있어서 다음 세션에서 갱신합니다`)
      : warn(
          `플러그인이 ${shortCommit(ref)}를 담고 있는데 자동 업데이트가 꺼져 있습니다. ` +
            `${configFilePath(home)}의 \`[update] auto = true\`로 켜세요.`,
          'UPDATE_AVAILABLE',
        );
  }
  if (behind === false && ahead === false) {
    return warn(
      `플러그인의 app-ref ${shortCommit(ref)}와 설치된 ${shortCommit(installed)}의 이력이 갈라졌습니다`,
    );
  }
  // One of the two questions could not be answered — the ref is not in this
  // clone, or there is no clone to ask. "Not known" and "not related" are
  // different answers, and guessing either way would be the silent failure.
  return warn(
    `플러그인의 app-ref ${shortCommit(ref)}와 설치된 ${shortCommit(installed)}의 관계를 알 수 없습니다`,
  );
}

/** Why the build answering this command is not the one the record names. */
function buildMismatch(
  build: BuildIdentity | undefined,
  recorded: string,
): string | undefined {
  if (build === undefined) return '이 빌드에 build.json이 없어서 어느 commit인지 알 수 없습니다';
  if (build.commit === null) return '이 빌드의 build.json에 commit이 없습니다';
  if (build.commit === recorded) return undefined;
  return `지금 도는 빌드는 ${shortCommit(build.commit)}인데 완료 기록은 ${shortCommit(recorded)}입니다`;
}

/**
 * Whether `maybeAncestor` is an ancestor of `descendant`, or `undefined` when
 * git could not answer — which happens for a commit that is not in this clone,
 * and for a `dist/` that was copied out of one.
 *
 * It runs in the clone this build came from, because that is the only place
 * both commits exist: the plugin folder is a copy of three files and has no
 * object database of its own.
 */
async function isAncestor(
  maybeAncestor: string,
  descendant: string,
  runGit: RunGit,
): Promise<boolean | undefined> {
  const run = await runGit([
    '-C',
    appRootPath(),
    'merge-base',
    '--is-ancestor',
    maybeAncestor,
    descendant,
  ]);
  if (run.code === 0) return true;
  if (run.code === 1) return false;
  return undefined;
}

/**
 * The node the shim names, asked for its own version. It is not the node
 * running this process: a hook runs the shim, the shim execs that node, and an
 * install made under a version manager can easily point at a node that has
 * since been removed.
 */
async function nodePathCheck(state: ShimState, runNode: RunNode): Promise<DoctorCheck> {
  const node = state.shim?.node;
  if (node === undefined) {
    // Nothing is known about a node nobody could read the name of. Reporting
    // that as a failure would be a second line about the same one problem.
    // The detail names the check that failed, in the phrase every skipped
    // prerequisite uses, so a reader does not have to guess which line above
    // this one is the cause.
    return { id: 'node-path', status: 'skip', detail: prereqFailed('shim') };
  }

  const run = await runNode(node);
  if (!run.ok) {
    return { id: 'node-path', status: 'fail', detail: `${node}을 실행할 수 없습니다: ${run.message}` };
  }

  const version = parseVersion(run.stdout);
  if (version === undefined) {
    return {
      id: 'node-path',
      status: 'fail',
      detail: `${node}이 \`--version\`에 "${oneLine(run.stdout)}"이라고 답했는데, 이것은 버전이 아닙니다`,
    };
  }

  if (!meetsNodeFloor(version)) {
    return {
      id: 'node-path',
      status: 'fail',
      detail: `${node}은 node ${version}이고, 이 빌드가 필요한 ${NODE_FLOOR}보다 낮습니다`,
    };
  }
  return { id: 'node-path', status: 'ok', detail: `${node}의 node ${version}` };
}

/** The node running this process, which is the one that answered the command. */
function nodeVersionCheck(): DoctorCheck {
  const version = process.versions.node;
  if (!meetsNodeFloor(version)) {
    return {
      id: 'node-version',
      status: 'fail',
      detail: `node ${version}은 이 빌드가 필요한 ${NODE_FLOOR}보다 낮습니다`,
    };
  }
  return { id: 'node-version', status: 'ok', detail: `node ${version}` };
}

/** `v24.16.0\n` as `24.16.0`, or `undefined` when there is no version in it. */
function parseVersion(output: string): string | undefined {
  const found = parts(output.trim());
  return found === undefined ? undefined : found.join('.');
}

/** The three numbers of a version, from text that may start with `v`. */
function parts(value: string): [number, number, number] | undefined {
  const matched = /^v?(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  const [major, minor, patch] = [matched?.[1], matched?.[2], matched?.[3]];
  if (major === undefined || minor === undefined || patch === undefined) return undefined;
  return [Number(major), Number(minor), Number(patch)];
}

const execFile = promisify(execFileCallback);

/**
 * `<node> --version`, under the timeout. Nothing is inherited that could make
 * it behave unlike the hook's run: no shell, no stdin, and a failure is a value
 * because a check never throws.
 */
async function systemRunNode(path: string): Promise<NodeRun> {
  try {
    const result = await execFile(path, ['--version'], {
      timeout: NODE_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { ok: true, stdout: result.stdout };
  } catch (error) {
    return { ok: false, message: describe(error) };
  }
}

/**
 * One git question, as its exit code. A git that is not installed, a folder
 * that is not a clone and a commit that is not there all come back as a code
 * rather than an exception, because a check never throws — and because the
 * three of them mean the same thing to the caller: git could not answer.
 *
 * 127 for a git that could not be started at all, which is the shell's own
 * code for it and is not one of the two codes `--is-ancestor` answers with.
 */
async function systemRunGit(args: readonly string[]): Promise<{ code: number }> {
  try {
    await execFile('git', [...args], {
      timeout: GIT_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });
    return { code: 0 };
  } catch (error) {
    const code: unknown = (error as { code?: unknown }).code;
    return { code: typeof code === 'number' ? code : 127 };
  }
}

/** Whether a path is there and this process may read it. */
async function isReadable(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/** Run once, however many times the result is asked for. */
function once<T>(run: () => Promise<T>): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    pending ??= run();
    return pending;
  };
}

/** Whatever went wrong, in one non-empty line (Conventions: no silent failure). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error));
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [oneLine(error.message), typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? '알 수 없는 오류';
}

function oneLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

/** Hook arrival is evidence even when a database write went to spool. */
async function lastHookCheck(home: string, names: readonly string[]): Promise<DoctorCheck> {
  const seen = await readPluginRun(home);
  const installed = await readInstalled(home);
  const root = seen.status === 'ok' ? seen.record.plugin_root : installed?.plugin_root;
  const parts: string[] = [];
  let duplicate = false;
  for (const harness of names) {
    const path = lastHookPath(home, harness);
    try {
      const [text, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      const received = text.trim();
      let detail = `${harness}: ${isoWithOffset(info.mtime)}`;
      if (received !== '' && root != null && received !== root) {
        duplicate = true;
        detail += `, hook의 플러그인 폴더 ${received}와 현재 플러그인 폴더 ${root}가 다릅니다`;
      }
      parts.push(detail);
    } catch (error) {
      parts.push((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? `${harness}: 아직 받은 hook이 없습니다`
        : `${harness}: hook 기록을 읽을 수 없습니다`);
    }
  }
  return { id: 'last-hook', status: duplicate ? 'warn' : 'ok', ...(duplicate ? { code: 'PLUGIN_DUPLICATE' } : {}), detail: parts.join('. ') };
}
