import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  chmod,
  copyFile,
  mkdir,
  readFile,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  BRAIN_MARKER,
  claudeCodeConnector,
  type Connector,
} from 'second_brain';
import { memoryConnector, type MemoryConnector } from 'second_brain/testing';
import { HOME_ENV, configFilePath, envFilePath } from '../src/config/paths.js';
import { setupConnectCommand } from '../src/commands/setup-connect.js';
import { dispatch } from '../src/dispatch.js';
import { parseShim, shimPath, writeShim } from '../src/install/shim.js';
import { systemClock } from '../src/runtime/clock.js';
import { withoutHarnessFolders } from './environment.js';
import { tempHomes } from './temp-home.js';

/**
 * `brain setup connect` against a fake harness, and `brain setup run` against a
 * real SQLite file through the built `brain`. The connector half runs in
 * process because the registry is what is being faked; the installer half runs
 * the built entry point, since the point of it is the artifacts on disk — the
 * configuration folder, the database, the files root and the shim — and that
 * they do not move on a re-run.
 */

const binPath = fileURLToPath(new URL('../dist/bin.js', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

interface Envelope {
  ok: boolean;
  now: string;
  data?: {
    harness?: string;
    target?: string;
    changed?: boolean;
    plugin_root?: string | null;
    home?: string;
    config_path?: string;
    store?: { path?: string; schema_version?: number; applied?: string[] };
    owner?: { name?: string; created?: boolean };
    files?: { path?: string; created?: boolean };
    mirror_path?: string;
    shim?: { path?: string; changed?: boolean };
    harnesses?: { harness: string; target: string; changed: boolean }[];
    checks?: { id: string; status: string; code?: string; detail?: string }[];
    summary?: { passed?: number; failed?: number };
    update?: { auto?: boolean };
    installed?: { path?: string; commit?: string | null };
  };
  warnings: string[];
  error?: {
    code: string;
    message: string;
    exit_code?: number;
    retryable?: boolean;
    hint?: string;
    retry?: { ns: string; verb: string; args: Record<string, unknown> };
    retry_argv?: string[];
  };
}

const temporary = tempHomes();

async function emptyHome(): Promise<string> {
  const home = await temporary.create('brain-setup-');
  return home;
}

/** One in-process invocation against a registry this test owns. */
async function runConnect(
  registry: readonly Connector[],
  args: readonly string[],
  home: string,
): Promise<Run> {
  let stdout = '';
  let stderr = '';
  const code = await dispatch([setupConnectCommand(registry)], args, {
    clock: systemClock,
    env: withoutHarnessFolders({ [HOME_ENV]: home }),
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  });
  return { code, stdout, stderr };
}

/**
 * A child environment with nothing a Postgres install left behind: `PATH` is
 * the node folder plus the system ones, so there is no `docker` to find, and
 * every database variable is gone.
 */
function childEnvironment(): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = withoutHarnessFolders({
    ...process.env,
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
  });
  delete childEnv['SECOND_BRAIN_DATABASE_URL'];
  delete childEnv['BRAIN_TEST_DATABASE_URL'];
  return childEnv;
}

/** The built `brain`, as a child process, with one configuration folder. */
function runBrain(args: readonly string[], home: string): Promise<Run> {
  return spawned(process.execPath, [binPath, ...args], {
    ...childEnvironment(),
    [HOME_ENV]: home,
  });
}

/** The shim itself, with no `SECOND_BRAIN_HOME` anywhere in its environment. */
function runShim(home: string, args: readonly string[]): Promise<Run> {
  const childEnv = childEnvironment();
  delete childEnv[HOME_ENV];
  return spawned(shimPath(home), args, childEnv);
}

function spawned(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<Run> {
  const child = spawn(command, [...args], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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

describe('brain setup connect', () => {
  it('registers the shim once, however many times it is run', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });

    const first = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);
    const again = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);

    expect(first.code).toBe(0);
    expect(again.code).toBe(0);
    expect((JSON.parse(first.stdout) as Envelope).data).toEqual({
      harness: 'demo',
      target: '/memory/demo/settings.json',
      plugin_root: null,
      changed: true,
    });
    expect((JSON.parse(again.stdout) as Envelope).data).toEqual({
      harness: 'demo',
      target: '/memory/demo/settings.json',
      plugin_root: null,
      changed: false,
    });
    // One entry, carrying the marker, naming this home's shim.
    expect(demo.marked()).toEqual([`${BRAIN_MARKER} hook -> ${shimPath(home)}`]);
  });

  it('prints one line in text mode, and says the second time nothing changed', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo', label: 'Demo' });

    const first = await runConnect([demo], ['setup', 'connect', 'demo'], home);
    const again = await runConnect([demo], ['setup', 'connect', 'demo'], home);

    expect(first.stdout).toBe(`/memory/demo/settings.json에 Demo를 연결했습니다\n`);
    expect(again.stdout).toBe(
      `/memory/demo/settings.json에 Demo가 이미 연결되어 있습니다\n`,
    );
    expect(first.stderr).toBe('');
  });

  it('answers USAGE and exits 2 for a harness nobody registered', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', 'nope', '--json'], home);

    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.ok).toBe(false);
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('아는 하네스: demo.');
    expect(demo.entries()).toEqual([]);
  });

  it.each([
    ['an empty harness name', ''],
    ['a harness name of spaces', '  '],
  ])('answers USAGE, naming the argument, for %s', async (_what, name) => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', name, '--json'], home);

    // `brain setup connect "$(…)"` with a capture that came back empty: a
    // command that went looking for the harness "" would answer "no connector
    // for" what is really a broken command line.
    expect(run.code).toBe(2);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('USAGE');
    expect(envelope.error?.message).toContain('harness');
    expect(envelope.error?.message).toContain('비어 있습니다');
    expect(demo.entries()).toEqual([]);
  });

  it.each([
    ['an escape sequence', '\u001b[31mdemo'],
    ['a zero-width space', 'de\u200bmo'],
    ['a bidi override', 'de\u202emo'],
  ])('answers USAGE for a harness name carrying %s', async (_what, name) => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', name, '--json'], home);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('USAGE');
    expect(demo.entries()).toEqual([]);
  });

  it('says there is no connector at all when the registry is empty', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });

    const run = await runConnect([], ['setup', 'connect', 'anything', '--json'], home);

    expect(run.code).toBe(2);
    expect((JSON.parse(run.stdout) as Envelope).error?.message).toContain('아직 커넥터를 등록하지 않습니다');
  });

  it('reports SHIM_MISSING and writes nothing when the shim is gone', async () => {
    const home = await emptyHome();
    const { path } = await writeShim(home, { bin: binPath });
    await unlink(path);
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);

    expect(run.code).toBe(1);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.error?.code).toBe('SHIM_MISSING');
    expect(envelope.error?.message).toContain('brain setup run');
    expect(demo.entries()).toEqual([]);
  });

  it('runs with no configuration folder, because it needs none', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const demo = memoryConnector({ harness: 'demo' });

    const run = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);

    expect(existsSync(configFilePath(home))).toBe(false);
    expect(run.code).toBe(0);
    expect(run.stderr).not.toContain('CONFIG_MISSING');
  });

  it('reports a connector that refuses, as its own code', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const broken = memoryConnector({
      harness: 'demo',
      failure: { code: 'HARNESS_UNREADABLE', message: 'settings.json is not JSON' },
    });

    const run = await runConnect([broken], ['setup', 'connect', 'demo', '--json'], home);

    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe('HARNESS_UNREADABLE');
  });
});

describe('plugin connections', () => {
  it.each(['mode', 'signature', 'entry', 'parse'])('rejects an unusable shim before invoking the connector: %s', async (problem) => {
    const home = await emptyHome();
    const { path } = await writeShim(home, { bin: binPath });
    if (problem === 'mode') await chmod(path, 0o600);
    if (problem === 'signature') await writeFile(path, (await readFile(path, 'utf8')).replace('Written by second-brain', 'Written by somebody'));
    if (problem === 'entry') await writeShim(home, { bin: join(home, 'missing.js') });
    if (problem === 'parse') await writeFile(path, '#!/bin/sh\nexit 0\n');
    const demo = memoryConnector();
    const run = await runConnect([demo], ['setup', 'connect', 'demo', '--json'], home);
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as Envelope).error?.code).toBe(problem === 'parse' ? 'SHIM_MISSING' : 'SHIM_INVALID');
    expect(demo.entries()).toEqual([]);
  });
  it('warns when no plugin has run and leaves unmarked settings byte for byte', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const config = join(home, 'claude');
    await mkdir(config);
    const target = join(config, 'settings.json');
    const text = '{ "hooks": {"Stop":[{"hooks":[{"type":"command","command":"echo user"}]}]} }';
    await writeFile(target, text);
    const run = await runConnect([claudeCodeConnector({ configDir: config })], ['setup', 'connect', 'claude-code', '--json'], home);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(run.code).toBe(0);
    expect(envelope.ok).toBe(true);
    expect(envelope.warnings).toEqual(['PLUGIN_NOT_INSTALLED']);
    expect(envelope.data).toMatchObject({ plugin_root: null, changed: false });
    expect(await readFile(target, 'utf8')).toBe(text);
    const human = await runConnect([claudeCodeConnector({ configDir: config })], ['setup', 'connect', 'claude-code'], home);
    expect(human.stdout).toContain('Claude Code 플러그인이 설치되어 있지 않습니다. Claude Code에서 second-brain 플러그인을 설치하세요');
  });
  it('prefers run/plugin.json, reports the root and explains cleanup in Korean', async () => {
    const home = await emptyHome();
    await writeShim(home, { bin: binPath });
    const config = join(home, 'claude');
    await mkdir(config);
    const target = join(config, 'settings.json');
    await writeFile(target, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'old # second-brain' }] }] } }));
    await mkdir(join(home, 'run'));
    await writeFile(join(home, 'installed.json'), JSON.stringify({ commit: 'a'.repeat(40), schema_version: 6, node: process.execPath, plugin_root: '/installed/plugin', installed_at: new Date().toISOString() }));
    await writeFile(join(home, 'run', 'plugin.json'), JSON.stringify({ plugin_root: '/current/plugin', app_ref: 'a'.repeat(40), seen_at: new Date().toISOString() }));
    const connector = claudeCodeConnector({ configDir: config });
    const text = await runConnect([connector], ['setup', 'connect', 'claude-code'], home);
    expect(text.stdout).toBe(`${target}에서 예전 brain hook을 지웠습니다\nClaude Code는 /current/plugin의 플러그인으로 연결되어 있습니다\n`);
    const run = await runConnect([connector], ['setup', 'connect', 'claude-code', '--json'], home);
    const envelope = JSON.parse(run.stdout) as Envelope;
    expect(envelope.warnings).toEqual([]);
    expect(envelope.data).toMatchObject({ plugin_root: '/current/plugin', changed: false });
  });
});
