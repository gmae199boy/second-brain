import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BRAIN_MARKER } from 'second_brain';
import { HOME_ENV } from '../src/config/paths.js';
import {
  NODE_FINDER_SH,
  SHIM_SIGNATURE,
  cliEntryPath,
  parseShim,
  renderShim,
  shimPath,
  writeShim,
} from '../src/install/shim.js';
import { NODE_FLOOR } from '../src/runtime/node-floor.js';
import { assertKoreanLine } from './language.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

/**
 * The shim is the one file a harness hook ever calls, started with none of the
 * user's shell environment (AD-19), so what is tested here is that the file is
 * self-sufficient: it carries its own node, its own entry point and its own
 * configuration folder, and running it really does reach the CLI.
 *
 * The runnable half points at the built entry point on purpose: these tests
 * import `src/`, where `cliEntryPath()` would resolve beside the sources, and
 * the shim the installer writes is the one in `dist/`.
 */

const distBin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const distShimModule = fileURLToPath(new URL('../dist/install/shim.js', import.meta.url));

const temporary = tempHomes();

async function tempHome(): Promise<string> {
  const home = await temporary.create('brain-shim-');
  return home;
}

/** Run the shim itself, with no `SECOND_BRAIN_HOME` in the environment. */
function runShim(
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...withoutHarnessFolders(process.env), ...env };
  if (env[HOME_ENV] === undefined) delete childEnv[HOME_ENV];

  const child = spawn(path, [...args], { env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(() => temporary.cleanup());

describe('renderShim', () => {
  it('is POSIX sh that pins the node and the entry point it was given', () => {
    const text = renderShim({
      node: '/opt/homebrew/bin/node',
      bin: '/home/me/.second_brain/app/apps/cli/dist/bin.js',
      home: '/home/me/.second_brain',
    });

    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    expect(text).toContain(SHIM_SIGNATURE);
    // Two assignments and one `exec` over them: the node is the one fact the
    // shim may have to replace at runtime, so it is a line of its own.
    expect(text).toContain(`\nNODE='/opt/homebrew/bin/node'\n`);
    expect(text).toContain(`\nBIN='/home/me/.second_brain/app/apps/cli/dist/bin.js'\n`);
    expect(text).toContain(`\nexec "$NODE" "$BIN" "$@"\n`);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('carries the one node finder, so a pin that has gone stale is recoverable', () => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/h' });

    expect(text).toContain(NODE_FINDER_SH);
    expect(text).toContain('if [ ! -x "$NODE" ]; then');
    expect(text).toContain('brain_repin');
  });

  it('passes the folder in assignment context, so the quotes do not survive', () => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/home/me/.second_brain' });

    // In `"${VAR:-'/path'}"` the single quotes are literal characters, and the
    // shim would export a folder name with quotes in it.
    expect(text).toContain(
      `${HOME_ENV}=\${${HOME_ENV}:-'/home/me/.second_brain'}; export ${HOME_ENV}`,
    );
    expect(text).not.toContain(`"\${${HOME_ENV}`);
  });

  it('signs the file with core\'s one marker, not a second spelling of it', () => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/h' });

    expect(SHIM_SIGNATURE).toContain(BRAIN_MARKER);
    expect(text).toContain(`# Written by ${BRAIN_MARKER}.`);
  });

  it('never calls npx, which would reach the network', () => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/h' });

    expect(text).not.toContain('npx');
  });

  it('quotes a path with a space or a quote in it so sh cannot re-read it', () => {
    const text = renderShim({
      node: "/opt/no de/b'in/node",
      bin: '/a b/bin.js',
      home: "/h o/m'e",
    });

    expect(text).toContain(`NODE='/opt/no de/b'\\''in/node'`);
    expect(text).toContain(`BIN='/a b/bin.js'`);
    expect(text).toContain(`:-'/h o/m'\\''e'}`);
  });
});

describe('parseShim', () => {
  /** The paths worth round-tripping: the ordinary one and the awkward ones. */
  const inputs = [
    {
      name: 'ordinary absolute paths',
      input: {
        node: '/opt/homebrew/bin/node',
        bin: '/home/me/.second_brain/app/apps/cli/dist/bin.js',
        home: '/home/me/.second_brain',
      },
    },
    {
      name: 'paths with spaces in them',
      input: {
        node: '/Volumes/My Disk/node',
        bin: '/a b/bin.js',
        home: '/Users/me/Application Support/brain',
      },
    },
    {
      name: 'paths with single quotes in them, which sh splices',
      input: { node: "/opt/no de/b'in/node", bin: "/a'b/bin.js", home: "/h o/m'e" },
    },
    {
      name: 'a path that is nothing but quotes',
      input: { node: "/'''", bin: "/''", home: "/'" },
    },
    {
      name: 'paths with a dollar sign, which sh must not expand',
      input: { node: '/opt/$PATH/node', bin: '/a/${HOME}/bin.js', home: '/h/$1' },
    },
  ];

  for (const { name, input } of inputs) {
    it(`reads back ${name}`, () => {
      expect(parseShim(renderShim(input))).toEqual(input);
    });
  }

  it('reads back the shim that was really written, from the file', async () => {
    const home = await tempHome();
    const { path } = await writeShim(home, { bin: distBin });

    expect(parseShim(await readFile(path, 'utf8'))).toEqual({
      node: process.execPath,
      bin: distBin,
      home,
    });
  });

  it('answers undefined for a file that is not a shim at all', () => {
    expect(parseShim('something else\n')).toBeUndefined();
    expect(parseShim('')).toBeUndefined();
  });

  it('answers undefined when a line is there but the home line is not', () => {
    expect(parseShim(`#!/bin/sh\nNODE='/n'\nBIN='/b'\nexec "$NODE" "$BIN" "$@"\n`)).toBeUndefined();
  });

  it.each([
    ['the node', `NODE='/n'`],
    ['the entry point', `BIN='/b'`],
  ])('answers undefined when %s is missing', (_what, line) => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/h' }).replace(`${line}\n`, '');

    expect(parseShim(text)).toBeUndefined();
  });

  it.each([
    ['a quoted word that never closes', `NODE='/n`],
    ['a word that is not quoted at all', 'NODE=/n'],
    ['something after the quoted word', `NODE='/n' # the node`],
  ])('answers undefined for %s', (_what, line) => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/h' }).replace(`NODE='/n'`, line);

    expect(parseShim(text)).toBeUndefined();
  });

  it.each([
    // A shim that does not pass the arguments on would run every hook as a
    // bare `brain` with no command at all.
    ['nothing after the entry point', `exec "$NODE" "$BIN"`],
    ['the arguments unquoted', `exec "$NODE" "$BIN" $@`],
    ['something else after them', `exec "$NODE" "$BIN" "$@" >/dev/null`],
    ['the two words the other way round', `exec "$BIN" "$NODE" "$@"`],
  ])('answers undefined for an exec line with %s', (_name, line) => {
    const text = renderShim({ node: '/n', bin: '/b', home: '/h' }).replace(
      `exec "$NODE" "$BIN" "$@"`,
      line,
    );

    expect(parseShim(text)).toBeUndefined();
  });
});

describe('writeShim', () => {
  it('writes an executable shim naming this node and this entry point', async () => {
    const home = await tempHome();

    const written = await writeShim(home);

    expect(written).toEqual({ path: shimPath(home), changed: true, node: process.execPath });
    expect(written.path).toBe(join(home, 'bin', 'brain'));
    const mode = (await stat(written.path)).mode & 0o777;
    expect(mode.toString(8)).toBe('755');

    const text = await readFile(written.path, 'utf8');
    expect(text).toContain(`'${process.execPath}'`);
    expect(text).toContain(`'${cliEntryPath()}'`);
    expect(text).toContain(`'${home}'`);
  });

  it('names an entry point that is really there, from the built module', async () => {
    // The whole point of the shim is that a hook can run it; one naming a file
    // that does not exist would fail on every turn, silently.
    const built = (await import(distShimModule)) as { cliEntryPath: () => string };

    expect(built.cliEntryPath()).toBe(distBin);
    expect(existsSync(built.cliEntryPath())).toBe(true);
  });

  it('creates a missing configuration folder at 0700, and bin at 0755', async () => {
    const parent = await tempHome();
    const home = join(parent, 'fresh');

    const written = await writeShim(home, { bin: distBin });

    // `.env` lives in this folder; a `mkdir -p` of `<home>/bin` alone would
    // have created `<home>` at 0755.
    expect(((await stat(home)).mode & 0o777).toString(8)).toBe('700');
    expect(((await stat(join(home, 'bin'))).mode & 0o777).toString(8)).toBe('755');
    expect(((await stat(written.path)).mode & 0o777).toString(8)).toBe('755');
  });

  it('does not write again when the content is already right', async () => {
    const home = await tempHome();
    const first = await writeShim(home);
    const before = await readFile(first.path, 'utf8');
    const mtimeBefore = (await stat(first.path)).mtimeMs;

    const again = await writeShim(home);

    expect(again).toEqual({ path: first.path, changed: false, node: process.execPath });
    expect(await readFile(first.path, 'utf8')).toBe(before);
    expect((await stat(first.path)).mtimeMs).toBe(mtimeBefore);
  });

  it('rewrites a shim that names another node, and says it changed', async () => {
    const home = await tempHome();
    await writeShim(home, { node: '/an/old/node' });

    const again = await writeShim(home);

    expect(again.changed).toBe(true);
    expect(await readFile(again.path, 'utf8')).not.toContain('/an/old/node');
  });

  it('restores the mode of a shim somebody made non-executable', async () => {
    const home = await tempHome();
    const first = await writeShim(home);
    await chmod(first.path, 0o644);

    const again = await writeShim(home);

    expect(again.changed).toBe(false);
    expect(((await stat(first.path)).mode & 0o777).toString(8)).toBe('755');
  });

  it('replaces a file that is not a shim at all', async () => {
    const home = await tempHome();
    await writeShim(home);
    await writeFile(shimPath(home), 'something else\n', 'utf8');

    const again = await writeShim(home);

    expect(again.changed).toBe(true);
    expect(await readFile(again.path, 'utf8')).toContain(SHIM_SIGNATURE);
  });
});

describe('the shim, run as a hook would run it', () => {
  beforeAll(() => {
    if (!existsSync(distBin)) {
      throw new Error(`${distBin} does not exist. Run \`pnpm build\` before these tests.`);
    }
  });

  /**
   * The detail of the `config` check, which is where doctor says which folder
   * it looked in. `doctor run` is `diagnostic`, so a folder with no
   * configuration in it is a failing check and an exit 1 rather than an error
   * envelope — which still proves the shim reached the CLI and pointed it
   * somewhere, and now says where.
   */
  function configDetail(stdout: string): string {
    const envelope = JSON.parse(stdout) as {
      data?: { checks?: { id: string; detail?: string }[] };
    };
    const check = envelope.data?.checks?.find((candidate) => candidate.id === 'config');
    expect(check).toBeDefined();
    return check?.detail ?? '';
  }

  it('reaches the CLI and reports the folder it carries, with no variable set', async () => {
    const home = await tempHome();
    const { path } = await writeShim(home, { bin: distBin });

    const run = await runShim(path, ['doctor', 'run', '--json']);

    // Ran, and reported a brain that is not installed: exit 1, not 2.
    expect(run.code).toBe(1);
    expect(configDetail(run.stdout)).toContain(home);
  });

  it('lets a folder named in the environment win over the one it carries', async () => {
    const home = await tempHome();
    const other = await tempHome();
    const { path } = await writeShim(home, { bin: distBin });

    const run = await runShim(path, ['doctor', 'run', '--json'], { [HOME_ENV]: other });

    const detail = configDetail(run.stdout);
    expect(detail).toContain(other);
    expect(detail).not.toContain(home);
  });

  it('survives a configuration folder with a space in its name', async () => {
    const parent = await tempHome();
    const home = join(parent, 'two words');
    const { path } = await writeShim(home, { bin: distBin });

    const run = await runShim(path, ['doctor', 'run', '--json']);

    expect(run.code).toBe(1);
    expect(configDetail(run.stdout)).toContain(home);
  });
});

describe('the pinned node', () => {
  it('is the real path, not the symlink the installer happened to be started by', async () => {
    const home = await tempHome();
    const link = join(home, 'node-link');
    await symlink(process.execPath, link);

    const written = await writeShim(home, { bin: distBin, node: link });

    // A version manager's `bin` entry is a symlink into a folder named after
    // the version, and a symlink is the thing most likely to be re-pointed at
    // a node this build cannot run.
    expect(written.node).toBe(process.execPath);
    expect(await readFile(written.path, 'utf8')).toContain(`NODE='${process.execPath}'`);
  });

  it('is left as it is when it cannot be resolved at all', async () => {
    const home = await tempHome();

    const written = await writeShim(home, { bin: distBin, node: '/nonexistent/node' });

    expect(written.node).toBe('/nonexistent/node');
  });
});

/**
 * The shim's own recovery, with real `sh`: a pin that has gone stale — an `nvm`
 * version removed, a Homebrew upgrade — must not make every harness turn fail
 * in silence (AD-19, F7).
 *
 * The fixed folders and `nvm`'s are both pointed into a temporary directory, so
 * nothing here depends on what this machine happens to have installed.
 */
describe('a shim whose node is gone', () => {
  /** A folder holding a `node` that answers `--version` with this version. */
  async function fakeNode(version: string): Promise<string> {
    const folder = await temporary.create('brain-node-');
    const path = join(folder, 'node');
    await writeFile(
      path,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\nexit 0\n`,
      { mode: 0o755 },
    );
    return folder;
  }

  /** An `nvm` layout with one version per entry. */
  async function fakeNvm(versions: readonly string[]): Promise<string> {
    const nvm = await temporary.create('brain-nvm-');
    for (const version of versions) {
      const bin = join(nvm, 'versions', 'node', `v${version}`, 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(
        join(bin, 'node'),
        `#!/bin/sh\nif [ "$1" = "--version" ]; then echo v${version}; exit 0; fi\nexit 0\n`,
        { mode: 0o755 },
      );
    }
    return nvm;
  }

  /** The node a shim on disk is pinned to right now. */
  async function pinnedNode(path: string): Promise<string | undefined> {
    return parseShim(await readFile(path, 'utf8'))?.node;
  }

  it('finds another node, runs with it, and pins it for the next hook', async () => {
    const home = await tempHome();
    const folder = await fakeNode(NODE_FLOOR);
    const empty = await tempHome();
    const { path } = await writeShim(home, { bin: distBin, node: '/nonexistent/node' });

    const run = await runShim(path, ['guide', 'schema'], {
      NVM_DIR: join(empty, 'nvm'),
      SECOND_BRAIN_NODE_DIRS: folder,
    });

    // The fake node exits 0 for anything that is not `--version`, so a clean
    // exit is this shim having found it and handed over to it.
    expect(run.code).toBe(0);
    expect(run.stderr).toBe('');
    expect(await pinnedNode(path)).toBe(join(folder, 'node'));
    // The lock is taken to re-pin and released again, whatever happened.
    expect(existsSync(join(home, 'install.lock'))).toBe(false);
  });

  it('prefers the highest nvm version over the fixed folders', async () => {
    const home = await tempHome();
    const nvm = await fakeNvm(['24.16.0', '24.19.0', '22.20.0']);
    const folder = await fakeNode('25.0.0');
    const { path } = await writeShim(home, { bin: distBin, node: '/nonexistent/node' });

    await runShim(path, ['guide', 'schema'], {
      NVM_DIR: nvm,
      SECOND_BRAIN_NODE_DIRS: folder,
    });

    // The highest of the versions that meet the floor, and the one below it
    // never considered — even though the fixed folder holds a newer node, the
    // order is nvm first (Boundaries).
    expect(await pinnedNode(path)).toBe(join(nvm, 'versions', 'node', 'v24.19.0', 'bin', 'node'));
  });

  it('ignores an nvm version below the floor', async () => {
    const home = await tempHome();
    const nvm = await fakeNvm(['22.20.0']);
    const folder = await fakeNode(NODE_FLOOR);
    const { path } = await writeShim(home, { bin: distBin, node: '/nonexistent/node' });

    await runShim(path, ['guide', 'schema'], {
      NVM_DIR: nvm,
      SECOND_BRAIN_NODE_DIRS: folder,
    });

    expect(await pinnedNode(path)).toBe(join(folder, 'node'));
  });

  it('runs with the node it found even when the lock cannot be taken', async () => {
    const home = await tempHome();
    const folder = await fakeNode(NODE_FLOOR);
    const empty = await tempHome();
    const { path } = await writeShim(home, { bin: distBin, node: '/nonexistent/node' });
    // An install in flight: the shim must not touch the file, and must not
    // refuse to run either.
    await mkdir(join(home, 'install.lock'));

    const run = await runShim(path, ['guide', 'schema'], {
      NVM_DIR: join(empty, 'nvm'),
      SECOND_BRAIN_NODE_DIRS: folder,
    });

    expect(run.code).toBe(0);
    expect(await pinnedNode(path)).toBe('/nonexistent/node');
  });

  it('says one Korean line and exits 127 when there is no node at all', async () => {
    const home = await tempHome();
    const empty = await tempHome();
    const { path } = await writeShim(home, { bin: distBin, node: '/nonexistent/node' });

    const run = await runShim(path, ['guide', 'schema'], {
      NVM_DIR: join(empty, 'nvm'),
      SECOND_BRAIN_NODE_DIRS: empty,
    });

    expect(run.code).toBe(127);
    expect(run.stdout).toBe('');
    assertKoreanLine(run.stderr.trim(), { label: 'shim refusal' });
    expect(run.stderr).toContain(NODE_FLOOR);
    expect(run.stderr).toContain(empty);
    // Nothing was rewritten over a refusal.
    expect(await pinnedNode(path)).toBe('/nonexistent/node');
  });
});
