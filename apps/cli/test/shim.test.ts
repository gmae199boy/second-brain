import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { BRAIN_MARKER } from 'second_brain';
import { HOME_ENV } from '../src/config/paths.js';
import { SHIM_SIGNATURE, cliEntryPath, renderShim, shimPath, writeShim } from '../src/install/shim.js';

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

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-shim-'));
  homes.push(home);
  return home;
}

/** Run the shim itself, with no `SECOND_BRAIN_HOME` in the environment. */
function runShim(
  path: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, ...env };
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

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

describe('renderShim', () => {
  it('is POSIX sh that execs the node and the entry point it was given', () => {
    const text = renderShim({
      node: '/opt/homebrew/bin/node',
      bin: '/home/me/.second_brain/app/apps/cli/dist/bin.js',
      home: '/home/me/.second_brain',
    });

    expect(text.split('\n')[0]).toBe('#!/bin/sh');
    expect(text).toContain(SHIM_SIGNATURE);
    expect(text).toContain(
      `exec '/opt/homebrew/bin/node' '/home/me/.second_brain/app/apps/cli/dist/bin.js' "$@"`,
    );
    expect(text.endsWith('\n')).toBe(true);
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

    expect(text).toContain(`exec '/opt/no de/b'\\''in/node' '/a b/bin.js' "$@"`);
    expect(text).toContain(`:-'/h o/m'\\''e'}`);
  });
});

describe('writeShim', () => {
  it('writes an executable shim naming this node and this entry point', async () => {
    const home = await tempHome();

    const written = await writeShim(home);

    expect(written).toEqual({ path: shimPath(home), changed: true });
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

    expect(again).toEqual({ path: first.path, changed: false });
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

  it('reaches the CLI and reports the folder it carries, with no variable set', async () => {
    const home = await tempHome();
    const { path } = await writeShim(home, { bin: distBin });

    // No configuration in the folder, so the command gets as far as reading it
    // and says so: proof the shim found the CLI and pointed it at this home.
    const run = await runShim(path, ['admin', 'doctor', '--json']);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as { error?: { code: string; message: string } };
    expect(envelope.error?.code).toBe('CONFIG_MISSING');
    expect(envelope.error?.message).toContain(home);
  });

  it('lets a folder named in the environment win over the one it carries', async () => {
    const home = await tempHome();
    const other = await tempHome();
    const { path } = await writeShim(home, { bin: distBin });

    const run = await runShim(path, ['admin', 'doctor', '--json'], { [HOME_ENV]: other });

    const envelope = JSON.parse(run.stdout) as { error?: { message: string } };
    expect(envelope.error?.message).toContain(other);
    expect(envelope.error?.message).not.toContain(home);
  });

  it('survives a configuration folder with a space in its name', async () => {
    const parent = await tempHome();
    const home = join(parent, 'two words');
    const { path } = await writeShim(home, { bin: distBin });

    const run = await runShim(path, ['admin', 'doctor', '--json']);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as { error?: { message: string } };
    expect(envelope.error?.message).toContain(home);
  });
});
