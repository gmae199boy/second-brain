import { execFile as execFileCallback } from 'node:child_process';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { installedPath } from '../config/paths.js';
import { shimPath } from './shim.js';

/**
 * The two runtime records of an installation: what the build is, and what the
 * last finished install left behind (AD-19, Conventions: 설치·런타임 기록).
 *
 * Neither goes through the configuration codec (AD-18). Configuration is what a
 * person chose and may edit; these two are what this machine did, and a codec
 * that read them would have to warn about keys and repair values for a file
 * nobody writes by hand. They are plain JSON, and anything that cannot be read
 * back is `undefined` rather than a repair: the plugin check then says it does
 * not know, which is a true statement and the only safe one.
 */

/** Which source this `dist/` was built from, as `dist/build.json` says. */
export interface BuildIdentity {
  /** The full 40-character commit, or `null` on a tree that is not a clone. */
  commit: string | null;
  /** The store schema version this build was made for. */
  schema_version: number;
}

/** What an install decided, without the time it decided it. */
export interface InstalledFacts {
  /** The commit the installed build came from, from `build.json`. */
  commit: string | null;
  schema_version: number;
  /** The node the shim was pinned to — the one a harness hook will run. */
  node: string;
  /** The plugin folder this install came from, or `null` when it did not. */
  plugin_root: string | null;
}

/**
 * `<home>/installed.json`. `snake_case` because it is a record read by other
 * programs — the bootstrap reads it with nothing but `node:` built-ins — and
 * those are the names the envelope and the plugin check already use.
 */
export interface InstalledRecord extends InstalledFacts {
  /** When the record was written, ISO-8601 in UTC (Conventions). */
  installed_at: string;
}

/** Where `write-build-info.mjs` put this build's identity. */
export function buildInfoPath(): string {
  return fileURLToPath(new URL('../../dist/build.json', import.meta.url));
}

/**
 * The root of the clone this build came from: four folders above this module,
 * which is `<app>/apps/cli/{src,dist}/install/`. It is where the plugin check
 * runs `git merge-base`, since that is the only place the commits it is
 * comparing exist.
 */
export function appRootPath(): string {
  return fileURLToPath(new URL('../../../../', import.meta.url));
}

/**
 * This build's identity, or `undefined` when there is none to read — a `dist/`
 * from before this file existed, or one somebody copied without it. A caller
 * that cannot say which commit it is running must say so and not guess.
 */
export async function readBuildIdentity(): Promise<BuildIdentity | undefined> {
  const text = await readText(buildInfoPath());
  if (text === undefined) return undefined;

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null) return undefined;

  const { commit, schema_version: schemaVersion } = document as Record<string, unknown>;
  if (!(commit === null || isCommit(commit))) return undefined;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) return undefined;
  return { commit, schema_version: schemaVersion };
}

/**
 * What the last finished install recorded in `<home>`, or `undefined` when
 * there is no record or it cannot be read back whole. Every field is checked,
 * because a half-read record is what makes an update decision on a commit that
 * is not one.
 */
export async function readInstalled(home: string): Promise<InstalledRecord | undefined> {
  const text = await readText(installedPath(home));
  if (text === undefined) return undefined;

  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof document !== 'object' || document === null) return undefined;

  const record = document as Record<string, unknown>;
  const { commit, node, plugin_root: pluginRoot, installed_at: installedAt } = record;
  const schemaVersion = record['schema_version'];
  if (!(commit === null || isCommit(commit))) return undefined;
  if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion)) return undefined;
  if (typeof node !== 'string' || node === '') return undefined;
  if (!(pluginRoot === null || (typeof pluginRoot === 'string' && pluginRoot !== ''))) {
    return undefined;
  }
  if (typeof installedAt !== 'string' || installedAt === '') return undefined;

  return {
    commit,
    schema_version: schemaVersion,
    node,
    plugin_root: pluginRoot,
    installed_at: installedAt,
  };
}

export interface WrittenInstalled {
  path: string;
  record: InstalledRecord;
}

/**
 * Write `<home>/installed.json`, temp file and rename, at mode 0644.
 *
 * The rename is what makes it safe to read from a `SessionStart` hook that may
 * be running while an install finishes: a reader sees either the old record or
 * the new one, never half of either. 0644 and not 0600 because there is nothing
 * private in it and the hook may run as a different process than the install.
 *
 * The time is taken here rather than passed in: it is the time the record was
 * written, and a caller that supplied it could record a time that is not when
 * anything happened.
 */
export async function writeInstalled(
  home: string,
  facts: InstalledFacts,
): Promise<WrittenInstalled> {
  const path = installedPath(home);
  const record: InstalledRecord = { ...facts, installed_at: new Date().toISOString() };
  const temp = `${path}.${String(process.pid)}.tmp`;

  try {
    await writeFile(temp, `${JSON.stringify(record, undefined, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o644,
    });
    await rename(temp, path);
  } catch (error) {
    await unlink(temp).catch(() => undefined);
    throw error;
  }
  return { path, record };
}

/** Whether this install is finished enough to be recorded as finished. */
export type CompletionCheck = { ok: true } | { ok: false; message: string };

/** How long the shim is given to answer. A check, not a command. */
export const COMPLETION_TIMEOUT_MS = 30_000;

const execFile = promisify(execFileCallback);

/**
 * Prove the installation works from the outside before it is recorded as
 * finished: run `<home>/bin/brain guide schema --json` — the shim, the node it
 * pins, the entry point it names and the CLI behind them — and require both an
 * exit 0 and an `ok: true` envelope.
 *
 * `guide schema` is the one command that reads neither the configuration nor
 * the database, so what fails here is the installation itself and nothing
 * about this machine's data. Doctor has already said the parts are in place;
 * this says they work together, which is the thing a `SessionStart` hook needs
 * and the thing a record of "installed" is supposed to mean.
 *
 * Two variables are passed on and nothing else. `PATH`, because the CLI behind
 * the shim spawns nothing but may yet; and `HOME`, because the shim's own node
 * finder looks under `${NVM_DIR:-$HOME/.nvm}` when the pinned node is gone, and
 * a shim run with no `HOME` would refuse for the wrong reason.
 *
 * `SECOND_BRAIN_HOME` above all is not passed: the shim carries its own folder,
 * and inheriting one would check some other installation's.
 */
export async function verifyCompletion(home: string): Promise<CompletionCheck> {
  const path = shimPath(home);
  let stdout: string;
  try {
    const result = await execFile(path, ['guide', 'schema', '--json'], {
      timeout: COMPLETION_TIMEOUT_MS,
      encoding: 'utf8',
      env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '' },
      windowsHide: true,
    });
    stdout = result.stdout;
  } catch (error) {
    return { ok: false, message: `${path}을 실행할 수 없습니다: ${describe(error)}` };
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(stdout);
  } catch {
    return { ok: false, message: `${path}이 JSON 엔벨로프가 아닌 것을 냈습니다` };
  }
  if (
    typeof envelope !== 'object' ||
    envelope === null ||
    (envelope as { ok?: unknown }).ok !== true
  ) {
    return { ok: false, message: `${path}이 \`ok: true\`가 아닌 엔벨로프를 냈습니다` };
  }
  return { ok: true };
}

/** `plugin/app-ref`: the commit the plugin folder asks to be installed. */
export const APP_REF_FILE = 'app-ref';

/**
 * The commit a plugin folder names, or `undefined` when there is none to read.
 * The file is one line of 40 lowercase hex characters, and anything else is not
 * read as a commit: a check that compared a stray line against a sha would
 * report on something that cannot be resolved.
 */
export async function readAppRef(pluginRoot: string): Promise<string | undefined> {
  const text = await readText(join(pluginRoot, APP_REF_FILE));
  if (text === undefined) return undefined;
  const ref = text.trim();
  return isCommit(ref) ? ref : undefined;
}

/** A full object name: 40 lowercase hex characters and nothing else. */
export function isCommit(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/** The first seven characters, as git prints a commit for a person to read. */
export function shortCommit(commit: string): string {
  return commit.slice(0, 7);
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
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
