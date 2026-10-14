import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_MARKER } from 'second_brain';
import { HOME_ENV } from '../config/paths.js';

/**
 * The fixed `brain` a harness hook calls (AD-19). A hook is started with none
 * of the user's shell environment — no PATH worth trusting, no `nvm`, no
 * configuration folder — so the shim carries all three facts it needs as
 * literals: the node that ran the installer, the built entry point beside it,
 * and this installation's configuration folder. It never calls `npx`, which
 * would reach the network and resolve to whatever is newest.
 *
 * Writing it is idempotent: identical content is not written again, so
 * `brain setup run` twice leaves the same bytes and the same mtime.
 */

/** Folder of the shim, under the configuration folder. */
export const SHIM_FOLDER = 'bin';

/** Name of the shim. The same word the user types. */
export const SHIM_NAME = 'brain';

/**
 * The one line that says a Brain wrote this file, for doctor and uninstall. It
 * carries core's marker rather than a second spelling of it, so the thing that
 * identifies Brain's own entries is one constant everywhere (AD-19).
 */
export const SHIM_SIGNATURE = `# Written by ${BRAIN_MARKER}. \`brain setup run\` rewrites it.`;

/** Where the shim of this configuration folder lives. */
export function shimPath(home: string): string {
  return join(home, SHIM_FOLDER, SHIM_NAME);
}

/**
 * The built CLI entry point, as an absolute path. Resolved against this
 * module's own URL, so it is `dist/bin.js` beside `dist/install/shim.js`
 * whatever the working directory is.
 */
export function cliEntryPath(): string {
  return fileURLToPath(new URL('../bin.js', import.meta.url));
}

export interface ShimInput {
  /** Absolute path of the node binary that is to run the CLI. */
  node: string;
  /** Absolute path of the built CLI entry point. */
  bin: string;
  /** The configuration folder this shim belongs to. */
  home: string;
}

/**
 * The shim, as text. POSIX `sh`, no bashisms: every path is single-quoted, so
 * a space or a `$` in a path is never read back as syntax.
 *
 * The folder is passed in assignment context — `VAR=${VAR:-'…'}` with no
 * double quotes around it — because inside double quotes a single quote is a
 * literal character, and `"${VAR:-'/path'}"` would export `'/path'`, quotes
 * included. In assignment context the word needs no outer quotes at all.
 */
export function renderShim(input: ShimInput): string {
  return [
    '#!/bin/sh',
    SHIM_SIGNATURE,
    `${HOME_ENV}=\${${HOME_ENV}:-${quote(input.home)}}; export ${HOME_ENV}`,
    `exec ${quote(input.node)} ${quote(input.bin)} "$@"`,
    '',
  ].join('\n');
}

export interface WrittenShim {
  path: string;
  /** False when the shim already said exactly this. */
  changed: boolean;
}

/**
 * Write `<home>/bin/brain`, at mode 0755, unless it already holds exactly this
 * text. `node` defaults to the node running this process and `bin` to the entry
 * point beside this file, which is what an install wants: whatever node started
 * the installer is the node the hooks will use.
 */
export async function writeShim(
  home: string,
  input: Partial<ShimInput> = {},
): Promise<WrittenShim> {
  const path = shimPath(home);
  const content = renderShim({
    node: input.node ?? process.execPath,
    bin: input.bin ?? cliEntryPath(),
    home: input.home ?? home,
  });

  const existing = await readText(path);
  if (existing === content) {
    // The bytes are right; only the mode could still be wrong, and a chmod
    // leaves the file identical. Nothing was rewritten, so nothing changed.
    await chmod(path, 0o755);
    return { path, changed: false };
  }

  // The configuration folder first, and at 0700 like the codec makes it: a
  // `mkdir -p` of `<home>/bin` alone would create a missing `<home>` at 0755
  // and leave the folder that holds `.env` readable by everyone.
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(join(home, SHIM_FOLDER), { recursive: true, mode: 0o755 });
  // The mode is set at creation, so the file is never briefly non-executable
  // for a hook that fires in between.
  await writeFile(path, content, { encoding: 'utf8', mode: 0o755 });
  await chmod(path, 0o755);
  return { path, changed: true };
}

/** A path quoted for `sh`: single quotes, with an embedded one spliced out. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The file's text, or `undefined` when there is no file to compare against. */
async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}
