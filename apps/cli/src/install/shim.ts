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

/** What a shim on disk says. The three facts `renderShim` wrote into it. */
export type ParsedShim = ShimInput;

/** The `SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-` that the folder follows. */
const HOME_PREFIX = `${HOME_ENV}=\${${HOME_ENV}:-`;

/** The `exec ` that the node and the entry point follow. */
const EXEC_PREFIX = 'exec ';

/**
 * Read a shim back: the node it names, the entry point it names, and the
 * configuration folder it carries. `undefined` when the text is not a shim this
 * code wrote — a file somebody replaced, or one an older version wrote in
 * another shape — because a doctor check that guessed at half a shim would
 * report on a path nothing will ever run.
 *
 * It is the inverse of `renderShim`'s quoting, and the round-trip is the test:
 * a path with a space or a quote in it has to come back the same string, since
 * those are exactly the paths where a regular expression over the line would
 * read the wrong thing and say nothing about it.
 */
export function parseShim(text: string): ParsedShim | undefined {
  const lines = text.split('\n');
  const homeLine = lines.find((line) => line.startsWith(HOME_PREFIX));
  const execLine = lines.find((line) => line.startsWith(EXEC_PREFIX));
  if (homeLine === undefined || execLine === undefined) return undefined;

  const home = unquote(homeLine, HOME_PREFIX.length);
  const node = unquote(execLine, EXEC_PREFIX.length);
  if (home === undefined || node === undefined) return undefined;
  // One space between the two words, as `renderShim` writes them.
  if (execLine[node.end] !== ' ') return undefined;
  const bin = unquote(execLine, node.end + 1);
  if (bin === undefined) return undefined;
  // `renderShim` always ends the line by passing the arguments on. A line that
  // does not is not one of ours, and a shim that drops `"$@"` would run every
  // hook as a bare `brain` with no command at all.
  if (execLine.slice(bin.end) !== ` "$@"`) return undefined;

  return { node: node.value, bin: bin.value, home: home.value };
}

/**
 * One single-quoted `sh` word, from `start`, and the index just after it.
 * `undefined` when there is no quoted word there, or when it never closes.
 *
 * Inside single quotes `sh` takes every character literally, so the only thing
 * to undo is the splice `quote` uses for an embedded quote: `'\''` closes the
 * word, escapes one quote, and opens it again.
 */
function unquote(line: string, start: number): { value: string; end: number } | undefined {
  if (line[start] !== "'") return undefined;

  let value = '';
  let index = start + 1;
  for (;;) {
    const character = line[index];
    if (character === undefined) return undefined;
    if (character === "'") {
      if (line.startsWith(`'\\''`, index)) {
        value += "'";
        index += 4;
        continue;
      }
      return { value, end: index + 1 };
    }
    value += character;
    index += 1;
  }
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
