import { execFile as execFileCallback } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import type { DoctorCheck, DoctorCheckSource } from 'second_brain';
import { readConfig, type ReadConfigResult } from '../config/codec.js';
import { configFilePath } from '../config/paths.js';
import { SHIM_SIGNATURE, parseShim, shimPath, type ParsedShim } from '../install/shim.js';

/**
 * Lowest node this build runs on. One constant, and a test holds it against
 * the root `package.json`'s `engines.node`: two spellings of a floor is how an
 * installer comes to accept a node the hooks then fail on.
 */
export const NODE_FLOOR = '24.16.0';

/**
 * How long the shim's node is given to answer `--version`. It is a check, not
 * a command: a node on a network share that has gone away must make doctor
 * slower by two seconds, not hang it.
 */
export const NODE_PROBE_TIMEOUT_MS = 2_000;

/** What asking a node for its version came back with. */
export type NodeRun = { ok: true; stdout: string } | { ok: false; message: string };

/**
 * Running `<node> --version`, injected so the node checks can be driven from a
 * test without a second node on the machine.
 */
export type RunNode = (path: string) => Promise<NodeRun>;

export interface RuntimeChecksOptions {
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
}

/**
 * The runtime's half of `brain admin doctor`, for one configuration folder: the
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
 * Later epics add to it here: a connector's own check per harness (epic 2), the
 * spool's depth and the last hook arrival (epic 2, 3), the mirror and the
 * export (epic 4, 5), the embedding backlog and replication lag (epic 6, 7).
 *
 * ```ts
 * return [...above, { id: 'spool', run: () => spoolCheck(config) }];
 * ```
 *
 * `node-path` comes after `shim` because it is a statement about the node the
 * shim names: with no node name to read, there is nothing to ask, which is a
 * `skip` and not a failure of node's. A shim that failed for some other reason
 * still names a node, and that node is still asked.
 */
export function runtimeChecks(options: RuntimeChecksOptions): readonly DoctorCheckSource[] {
  const { home } = options;
  const runNode = options.runNode ?? systemRunNode;
  // Read and parsed once: `shim` and `node-path` are two statements about the
  // same file, and two reads could disagree about it.
  const shim = once(async () => inspectShim(home));

  return [
    { id: 'config', run: async () => configCheck(home, options.config) },
    { id: 'shim', run: async () => shimCheck(await shim()) },
    { id: 'node-path', run: async () => nodePathCheck(await shim(), runNode) },
    { id: 'node-version', run: async () => nodeVersionCheck() },
  ];
}

/**
 * The configuration file. It is a check rather than a precondition because
 * doctor is `diagnostic`: it runs without a configuration on purpose, so that
 * "there is no configuration" is something the report says instead of something
 * that stops the report (Decision 2026-10-14).
 */
async function configCheck(
  home: string,
  given: ReadConfigResult | undefined,
): Promise<DoctorCheck> {
  const read = given ?? (await readConfig(home));
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
interface ShimState {
  path: string;
  /** The shim's three facts, when the file could be read and parsed. */
  shim?: ParsedShim;
  /** Why the shim is not usable. Unset when it is. */
  message?: string;
}

/**
 * Everything the shim has to be for a hook to work: there, executable, written
 * by us, readable back, pointed at this installation, and naming an entry point
 * that exists. A hook is started with none of the user's shell environment
 * (AD-19), so any one of these missing means every turn fails silently — which
 * is exactly the failure a doctor check is for.
 */
async function inspectShim(home: string): Promise<ShimState> {
  const path = shimPath(home);
  const rerun = 'Run `brain setup run`.';

  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return { path, message: `${path}: ${describe(error)}. ${rerun}` };
  }

  const shim = parseShim(text);
  if (shim === undefined) {
    return { path, message: `${path} could not be read back. ${rerun}` };
  }

  // From here the shim's own facts are known, so they travel with every answer
  // below: the node it names is asked about whichever of these failed.
  const failed = (message: string): ShimState => ({ path, shim, message });

  try {
    await access(path, constants.X_OK);
  } catch {
    return failed(`${path} is not executable. ${rerun}`);
  }

  if (!text.includes(SHIM_SIGNATURE)) {
    return failed(`${path} carries no brain signature line. ${rerun}`);
  }

  if (shim.home !== home) {
    // Another installation's shim, sitting where this one's belongs. A hook
    // calling it would write into the other brain, silently.
    return failed(`${path} carries the folder ${shim.home}, not ${home}. ${rerun}`);
  }

  if (!(await isReadable(shim.bin))) {
    return failed(`${path} names an entry point that is not there: ${shim.bin}. ${rerun}`);
  }

  return { path, shim };
}

function shimCheck(state: ShimState): DoctorCheck {
  if (state.message !== undefined) {
    return { id: 'shim', status: 'fail', detail: state.message };
  }
  return { id: 'shim', status: 'ok', detail: state.path };
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
    return { id: 'node-path', status: 'skip', detail: 'the shim could not be read' };
  }

  const run = await runNode(node);
  if (!run.ok) {
    return { id: 'node-path', status: 'fail', detail: `${node}: ${run.message}` };
  }

  const version = parseVersion(run.stdout);
  if (version === undefined) {
    return {
      id: 'node-path',
      status: 'fail',
      detail: `${node} answered --version with ${oneLine(run.stdout)}, which is not a version`,
    };
  }

  if (!meetsNodeFloor(version)) {
    return {
      id: 'node-path',
      status: 'fail',
      detail: `${node} is node ${version}, below the ${NODE_FLOOR} this build needs`,
    };
  }
  return { id: 'node-path', status: 'ok', detail: `node ${version} at ${node}` };
}

/** The node running this process, which is the one that answered the command. */
function nodeVersionCheck(): DoctorCheck {
  const version = process.versions.node;
  if (!meetsNodeFloor(version)) {
    return {
      id: 'node-version',
      status: 'fail',
      detail: `node ${version} is below the ${NODE_FLOOR} this build needs`,
    };
  }
  return { id: 'node-version', status: 'ok', detail: `node ${version}` };
}

/** Whether a version is at or above `NODE_FLOOR`. Exported for its own test. */
export function meetsNodeFloor(version: string): boolean {
  return atLeast(version, NODE_FLOOR);
}

/**
 * Whether `version` is at or above `floor`, comparing major, minor and patch as
 * numbers. Anything after the patch — `-nightly`, `+build` — is ignored: a
 * prerelease of a version at the floor is close enough for a check that is
 * about "is this node too old", and the alternative is semver's whole order for
 * one comparison.
 */
export function atLeast(version: string, floor: string): boolean {
  const left = parts(version);
  const right = parts(floor);
  if (left === undefined || right === undefined) return false;
  for (let index = 0; index < 3; index += 1) {
    const mine = left[index] ?? 0;
    const theirs = right[index] ?? 0;
    if (mine !== theirs) return mine > theirs;
  }
  return true;
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
  return candidates.find((candidate) => candidate !== '') ?? 'unknown error';
}

function oneLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}
