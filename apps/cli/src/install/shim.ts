import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_MARKER } from 'second_brain';
import { HOME_ENV, LOCK_FOLDER, LOCK_PID_FILE } from '../config/paths.js';
import { NODE_FLOOR } from '../runtime/node-floor.js';

/**
 * The fixed `brain` a harness hook calls (AD-19). A hook is started with none
 * of the user's shell environment — no PATH worth trusting, no `nvm`, no
 * configuration folder — so the shim carries all three facts it needs as
 * literals: the node that ran the installer, the built entry point beside it,
 * and this installation's configuration folder. It never calls `npx`, which
 * would reach the network and resolve to whatever is newest.
 *
 * The node is pinned by its real path and the pin is not assumed to hold: a
 * version manager removes a node, a Homebrew upgrade moves one, and a shim
 * pointing at a node that is gone fails every turn silently. So the shim
 * carries the same `sh` node finder the plugin launcher carries, falls back to
 * it, and — when it can take the install lock — rewrites its own `NODE=` line
 * so the next hook does not go looking again.
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

/** The environment variable a test points the fixed-folder search at. */
export const NODE_DIRS_ENV = 'SECOND_BRAIN_NODE_DIRS';

/** The fixed folders looked in when no version manager has a node. */
export const NODE_DIRS_DEFAULT = '/opt/homebrew/bin:/usr/local/bin';

/**
 * Finding a node without trusting PATH, as POSIX `sh`.
 *
 * This text is the one copy. The shim embeds it to recover from a pin that has
 * gone stale, and `plugin/bin/session-start.sh` embeds the same bytes to find a
 * node at all — a `SessionStart` hook inherits the harness's PATH, which on a
 * GUI launch holds no `nvm` and sometimes not even Homebrew. A test compares
 * the launcher's copy against this constant, so the two cannot drift.
 *
 * Only `nvm` is looked for among the version managers, and only the two fixed
 * folders: `volta`, `fnm`, `asdf` and `mise` each have their own layout and
 * their own shims, and guessing at four more of them in `sh` is how this file
 * would come to pick a node nobody uses (Boundaries).
 */
export const NODE_FINDER_SH = [
  `# --- node finding (second-brain). One copy: apps/cli/src/install/shim.ts.`,
  `SECOND_BRAIN_NODE_FLOOR='${NODE_FLOOR}'`,
  `SECOND_BRAIN_NVM_DIR=\${NVM_DIR:-$HOME/.nvm}`,
  `if [ -z "\${${NODE_DIRS_ENV}+set}" ]; then`,
  `  ${NODE_DIRS_ENV}='${NODE_DIRS_DEFAULT}'`,
  `fi`,
  `brain_version=''`,
  `brain_node=''`,
  ``,
  `# Whether version $1 is at or above version $2, as numbers and not as text.`,
  `brain_at_least() {`,
  `  brain_left=$1`,
  `  brain_right=$2`,
  `  brain_field=0`,
  `  while [ "$brain_field" -lt 3 ]; do`,
  `    brain_one=\${brain_left%%.*}`,
  `    brain_two=\${brain_right%%.*}`,
  `    case $brain_left in *.*) brain_left=\${brain_left#*.} ;; *) brain_left=0 ;; esac`,
  `    case $brain_right in *.*) brain_right=\${brain_right#*.} ;; *) brain_right=0 ;; esac`,
  `    brain_one=\${brain_one%%[!0123456789]*}`,
  `    brain_two=\${brain_two%%[!0123456789]*}`,
  `    [ -n "$brain_one" ] || brain_one=0`,
  `    [ -n "$brain_two" ] || brain_two=0`,
  `    if [ "$brain_one" -gt "$brain_two" ]; then return 0; fi`,
  `    if [ "$brain_one" -lt "$brain_two" ]; then return 1; fi`,
  `    brain_field=$((brain_field + 1))`,
  `  done`,
  `  return 0`,
  `}`,
  ``,
  `# The version the node at $1 answers with, in brain_version.`,
  `brain_node_version() {`,
  `  brain_version=''`,
  `  [ -x "$1" ] || return 1`,
  `  brain_version=$("$1" --version 2>/dev/null) || return 1`,
  `  brain_version=\${brain_version#v}`,
  `  case $brain_version in [0123456789]*) ;; *) return 1 ;; esac`,
  `  return 0`,
  `}`,
  ``,
  `# Whether the node at $1 is one this build can run on.`,
  `brain_node_enough() {`,
  `  brain_node_version "$1" || return 1`,
  `  brain_at_least "$brain_version" "$SECOND_BRAIN_NODE_FLOOR"`,
  `}`,
  ``,
  `# A node of at least the floor, in brain_node: the highest nvm version`,
  `# first, then the fixed folders in the order they are named.`,
  `brain_find_node() {`,
  `  brain_node=''`,
  `  brain_best=''`,
  `  for brain_candidate in "$SECOND_BRAIN_NVM_DIR"/versions/node/v*/bin/node; do`,
  `    brain_node_enough "$brain_candidate" || continue`,
  `    if [ -z "$brain_node" ] || brain_at_least "$brain_version" "$brain_best"; then`,
  `      brain_node=$brain_candidate`,
  `      brain_best=$brain_version`,
  `    fi`,
  `  done`,
  `  [ -z "$brain_node" ] || return 0`,
  ``,
  `  brain_folders=$${NODE_DIRS_ENV}`,
  `  while [ -n "$brain_folders" ]; do`,
  `    brain_folder=\${brain_folders%%:*}`,
  `    case $brain_folders in *:*) brain_folders=\${brain_folders#*:} ;; *) brain_folders='' ;; esac`,
  `    [ -n "$brain_folder" ] || continue`,
  `    if brain_node_enough "$brain_folder/node"; then`,
  `      brain_node=$brain_folder/node`,
  `      return 0`,
  `    fi`,
  `  done`,
  `  return 1`,
  `}`,
  ``,
  `# Where it looked, for the one line that says nothing was found.`,
  `brain_node_places() {`,
  `  printf '%s' "$SECOND_BRAIN_NVM_DIR/versions/node/v*/bin/node, $${NODE_DIRS_ENV}"`,
  `}`,
  `# --- end of node finding`,
].join('\n');

export interface ShimInput {
  /** Absolute path of the node binary that is to run the CLI. */
  node: string;
  /** Absolute path of the built CLI entry point. */
  bin: string;
  /** The configuration folder this shim belongs to. */
  home: string;
}

/** The shell variable the shim pins the node in, and `parseShim` reads back. */
const NODE_VARIABLE = 'NODE';

/** The shell variable the shim pins the entry point in. */
const BIN_VARIABLE = 'BIN';

/** The last line of every shim, as written and as read back: exact, both ways. */
const EXEC_LINE = `exec "$${NODE_VARIABLE}" "$${BIN_VARIABLE}" "$@"`;

/**
 * Re-pinning the `NODE=` line in place, under the install lock.
 *
 * Under the lock because a bootstrap may be rewriting this very file at the
 * same moment, and because the shim must never be the reason an install is
 * half-written. A lock it cannot take is not a failure: the found node still
 * runs this turn, and the next hook looks again — slower, never wrong.
 *
 * `awk` and not `sed`: the replacement is one line built from an environment
 * variable, so no path character is ever read as pattern syntax. A path with a
 * single quote in it is run and not pinned, because splicing one into an `sh`
 * word from `sh` cannot be done here without a quoting pass of its own.
 */
const REPIN_SH = [
  `# Pin the node that was just found, so the next hook does not look again.`,
  `brain_repin() {`,
  `  case $${NODE_VARIABLE} in *\\'*) return 0 ;; esac`,
  `  brain_lock=$${HOME_ENV}/${LOCK_FOLDER}`,
  `  mkdir -p "$${HOME_ENV}" 2>/dev/null || return 0`,
  `  mkdir "$brain_lock" 2>/dev/null || return 0`,
  `  echo $$ > "$brain_lock/${LOCK_PID_FILE}" 2>/dev/null`,
  `  brain_temp=$0.$$.tmp`,
  `  if { BRAIN_NODE=$${NODE_VARIABLE} awk 'BEGIN { brain_line = "${NODE_VARIABLE}=\\047" ENVIRON["BRAIN_NODE"] "\\047" } !brain_pinned && /^${NODE_VARIABLE}=/ { print brain_line; brain_pinned = 1; next } { print }' "$0" > "$brain_temp"; } 2>/dev/null; then`,
  `    chmod 755 "$brain_temp" 2>/dev/null && mv -f "$brain_temp" "$0" 2>/dev/null`,
  `  fi`,
  `  rm -f "$brain_temp" 2>/dev/null`,
  `  rm -f "$brain_lock/${LOCK_PID_FILE}" 2>/dev/null`,
  `  rmdir "$brain_lock" 2>/dev/null`,
  `  return 0`,
  `}`,
].join('\n');

/**
 * The one Korean line a shim with no node to run can say (output language).
 *
 * It goes inside an `sh` double-quoted word, so the backticks around the
 * command are escaped: unescaped ones would be a command substitution, and the
 * line meant to say what to run would run it.
 */
const NO_NODE_MESSAGE =
  `brain: node $SECOND_BRAIN_NODE_FLOOR 이상을 찾지 못했습니다. ` +
  `찾아본 곳: $(brain_node_places). node를 설치한 뒤 \\\`brain setup run\\\`을 실행하세요`;

/** The pin, checked; the finder, as the fallback; the one refusal otherwise. */
const FALLBACK_SH = [
  `if [ ! -x "$${NODE_VARIABLE}" ]; then`,
  `  if brain_find_node; then`,
  `    ${NODE_VARIABLE}=$brain_node`,
  `    brain_repin`,
  `  else`,
  `    echo "${NO_NODE_MESSAGE}" >&2`,
  `    exit 127`,
  `  fi`,
  `fi`,
].join('\n');

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

/**
 * The shim, as text. POSIX `sh`, no bashisms: every path is single-quoted, so
 * a space or a `$` in a path is never read back as syntax.
 *
 * The folder is passed in assignment context — `VAR=${VAR:-'…'}` with no
 * double quotes around it — because inside double quotes a single quote is a
 * literal character, and `"${VAR:-'/path'}"` would export `'/path'`, quotes
 * included. In assignment context the word needs no outer quotes at all.
 *
 * The node and the entry point are their own assignments rather than words on
 * the `exec` line, because the node is the one fact the shim may have to
 * replace at runtime: one line to find, one line to write.
 */
export function renderShim(input: ShimInput): string {
  return [
    '#!/bin/sh',
    SHIM_SIGNATURE,
    `${HOME_ENV}=\${${HOME_ENV}:-${quote(input.home)}}; export ${HOME_ENV}`,
    `${NODE_VARIABLE}=${quote(input.node)}`,
    `${BIN_VARIABLE}=${quote(input.bin)}`,
    NODE_FINDER_SH,
    REPIN_SH,
    FALLBACK_SH,
    EXEC_LINE,
    '',
  ].join('\n');
}

/** What a shim on disk says. The three facts `renderShim` wrote into it. */
export type ParsedShim = ShimInput;

/** The `SECOND_BRAIN_HOME=${SECOND_BRAIN_HOME:-` that the folder follows. */
const HOME_PREFIX = `${HOME_ENV}=\${${HOME_ENV}:-`;

/** What the folder's line says after the folder. */
const HOME_SUFFIX = `}; export ${HOME_ENV}`;

const NODE_PREFIX = `${NODE_VARIABLE}=`;

const BIN_PREFIX = `${BIN_VARIABLE}=`;

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
  const nodeLine = lines.find((line) => line.startsWith(NODE_PREFIX));
  const binLine = lines.find((line) => line.startsWith(BIN_PREFIX));
  if (homeLine === undefined || nodeLine === undefined || binLine === undefined) {
    return undefined;
  }
  // `renderShim` always ends by handing the arguments on to the two variables
  // it just set. A file that does not is not one of ours, and a shim that
  // dropped `"$@"` would run every hook as a bare `brain` with no command.
  if (!lines.includes(EXEC_LINE)) return undefined;

  const home = unquote(homeLine, HOME_PREFIX.length);
  const node = unquote(nodeLine, NODE_PREFIX.length);
  const bin = unquote(binLine, BIN_PREFIX.length);
  if (home === undefined || node === undefined || bin === undefined) return undefined;
  // Nothing may follow the quoted word but what `renderShim` puts there: a
  // line with anything else on it is doing something this code did not write.
  if (homeLine.slice(home.end) !== HOME_SUFFIX) return undefined;
  if (nodeLine.slice(node.end) !== '') return undefined;
  if (binLine.slice(bin.end) !== '') return undefined;

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
  /** The node the shim was pinned to, which is what `installed.json` records. */
  node: string;
}

/**
 * Write `<home>/bin/brain`, at mode 0755, unless it already holds exactly this
 * text. `node` defaults to the node running this process and `bin` to the entry
 * point beside this file, which is what an install wants: whatever node started
 * the installer is the node the hooks will use.
 *
 * The node is pinned by its real path. A version manager's `bin` entry is
 * usually a symlink into a folder named after the version, and a symlink is the
 * thing most likely to be re-pointed at a node this build cannot run on — the
 * real path at least fails loudly, and the shim's own fallback then finds
 * another one.
 */
export async function writeShim(
  home: string,
  input: Partial<ShimInput> = {},
): Promise<WrittenShim> {
  const path = shimPath(home);
  const node = realPath(input.node ?? process.execPath);
  const content = renderShim({
    node,
    bin: input.bin ?? cliEntryPath(),
    home: input.home ?? home,
  });

  const existing = await readText(path);
  if (existing === content) {
    // The bytes are right; only the mode could still be wrong, and a chmod
    // leaves the file identical. Nothing was rewritten, so nothing changed.
    await chmod(path, 0o755);
    return { path, changed: false, node };
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
  return { path, changed: true, node };
}

/** A path with its symlinks resolved, or the path itself when it has none. */
function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
