import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DoctorCheck } from 'second_brain';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config/codec.js';
import { configFilePath } from '../src/config/paths.js';
import {
  NODE_FLOOR,
  atLeast,
  meetsNodeFloor,
  runtimeChecks,
  type RunNode,
  type RuntimeChecksOptions,
} from '../src/doctor/checks.js';
import { shimPath, writeShim } from '../src/install/shim.js';
import { assertKoreanLine } from './language.js';

/**
 * The machine half of doctor, against the real filesystem — the shim, its mode,
 * its signature and the entry point it names are the point, so a fake
 * filesystem would prove nothing about them. The one thing that is injected is
 * running a node, because the interesting cases are a node that is not there
 * and a node that is too old, and neither can be arranged on this machine.
 */

/** The built entry point: a shim the installer wrote names this file. */
const distBin = fileURLToPath(new URL('../dist/bin.js', import.meta.url));

const manifest = fileURLToPath(new URL('../../../package.json', import.meta.url));

const homes: string[] = [];

async function tempHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'brain-checks-'));
  homes.push(home);
  return home;
}

/** A home with a configuration and a shim: what a finished install leaves. */
async function installedHome(): Promise<string> {
  const home = await tempHome();
  await writeConfig(home, {});
  await writeShim(home, { bin: distBin });
  return home;
}

/**
 * Every check, run in order, as a map from id to what it answered.
 *
 * Each `detail` is held against the output-language rule here, which is what
 * covers every branch below at once (Conventions, output language 2026-10-16):
 * a check added to `doctor/checks.ts` with an English detail fails the first
 * test that reaches it. The id and the status word stay English (Boundaries),
 * and so does whatever Node itself said, which the checker is told about.
 */
async function report(options: RuntimeChecksOptions): Promise<Map<string, DoctorCheck>> {
  const checks = new Map<string, DoctorCheck>();
  for (const source of runtimeChecks(options)) {
    const check = await source.run();
    assertKoreanLine(check.detail ?? '', { label: `${check.id} detail` });
    checks.set(source.id, check);
  }
  return checks;
}

/** A node that answers with this version, without one being installed. */
function nodeSaying(version: string): RunNode {
  return async () => ({ ok: true, stdout: `${version}\n` });
}

afterEach(async () => {
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

beforeAll(() => {
  if (!existsSync(distBin)) {
    throw new Error(`${distBin} does not exist. Run \`pnpm build\` before these tests.`);
  }
});

describe('runtimeChecks', () => {
  it('registers the four machine checks, in the order they are reported', () => {
    expect(runtimeChecks({ home: '/nowhere' }).map((source) => source.id)).toEqual([
      'config',
      'shim',
      'node-path',
      'node-version',
    ]);
  });

  it('reports every check as ok for a home a finished install left behind', async () => {
    const home = await installedHome();

    const checks = await report({ home, runNode: nodeSaying(NODE_FLOOR) });

    const failed = [...checks.values()].filter((check) => check.status !== 'ok');
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(checks.get('config')?.detail).toBe(configFilePath(home));
    expect(checks.get('shim')?.detail).toBe(shimPath(home));
  });

  it('asks the node the shim names, not the one running this process', async () => {
    const home = await tempHome();
    await writeShim(home, { bin: distBin, node: '/opt/some/node' });
    const asked: string[] = [];

    await report({
      home,
      runNode: async (path) => {
        asked.push(path);
        return { ok: true, stdout: 'v24.16.0' };
      },
    });

    expect(asked).toEqual(['/opt/some/node']);
  });

  it('reads the shim once, so the two checks about it cannot disagree', async () => {
    const home = await installedHome();
    const sources = runtimeChecks({ home, runNode: nodeSaying('24.16.0') });
    const shim = sources.find((source) => source.id === 'shim');
    const nodePath = sources.find((source) => source.id === 'node-path');

    expect(await shim?.run()).toMatchObject({ status: 'ok' });
    await rm(shimPath(home));

    // The file is gone now, and `node-path` still answers from the read that
    // already happened: one report makes one statement about one file.
    expect(await nodePath?.run()).toMatchObject({ id: 'node-path', status: 'ok' });
  });
});

describe('the config check', () => {
  it('names the configuration file when it reads', async () => {
    const home = await installedHome();

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('config')).toEqual({
      id: 'config',
      status: 'ok',
      detail: configFilePath(home),
    });
  });

  it('fails with CONFIG_MISSING when there is no file, and creates none', async () => {
    const home = await tempHome();

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('config')).toMatchObject({ status: 'fail', code: 'CONFIG_MISSING' });
    expect(checks.get('config')?.detail).toContain(configFilePath(home));
  });

  it('fails with CONFIG_INVALID for a file it cannot understand', async () => {
    const home = await tempHome();
    await writeFile(configFilePath(home), 'store.path = "relative/brain.db"\n', 'utf8');

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('config')).toMatchObject({ status: 'fail', code: 'CONFIG_INVALID' });
  });

  it('reports what the caller already read, rather than reading it again', async () => {
    const home = await installedHome();
    // The dispatcher has read it by the time doctor runs, and what it read is
    // what the command ran with — a second read could say something else.
    const checks = await report({
      home,
      config: { ok: false, code: 'CONFIG_INVALID', message: '디스패처가 읽은 그대로입니다' },
      runNode: nodeSaying('24.16.0'),
    });

    expect(checks.get('config')).toEqual({
      id: 'config',
      status: 'fail',
      code: 'CONFIG_INVALID',
      detail: '디스패처가 읽은 그대로입니다',
    });
  });
});

describe('the shim check', () => {
  it('fails, and skips node-path, when there is no shim', async () => {
    const home = await tempHome();

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
    expect(checks.get('shim')?.detail).toContain(shimPath(home));
    expect(checks.get('shim')?.detail).toContain('brain setup run');
    // Nothing is known about a node nobody could read the name of.
    expect(checks.get('node-path')).toMatchObject({ id: 'node-path', status: 'skip' });
  });

  it('fails when the shim is there but not executable, and still asks its node', async () => {
    const home = await installedHome();
    await chmod(shimPath(home), 0o644);

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
    expect(checks.get('shim')?.detail).toContain('실행 권한이 없습니다');
    // The file was read and parsed, so the node it names is known — and a
    // report that skipped it would hide a second thing that is also wrong.
    expect(checks.get('node-path')).toMatchObject({ status: 'ok' });
  });

  it('fails when the file carries no brain signature line, and still asks its node', async () => {
    const home = await installedHome();
    const path = shimPath(home);
    const text = await readFile(path, 'utf8');
    await writeFile(path, text.replace(/^# Written by.*\n/m, ''), { mode: 0o755 });

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
    expect(checks.get('shim')?.detail).toContain('서명 줄이 없습니다');
    expect(checks.get('node-path')).toMatchObject({ status: 'ok' });
  });

  it('fails when the shim carries a home other than this one', async () => {
    const home = await tempHome();
    const other = await tempHome();
    // A hook calling this would write into the other brain, silently.
    await writeShim(home, { bin: distBin, home: other });

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
    expect(checks.get('shim')?.detail).toContain(other);
    expect(checks.get('shim')?.detail).toContain(home);
    expect(checks.get('node-path')).toMatchObject({ status: 'ok' });
  });

  it('passes when the shim carries exactly this folder', async () => {
    const home = await installedHome();

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toEqual({ id: 'shim', status: 'ok', detail: shimPath(home) });
  });

  it('fails when the shim cannot be read back at all', async () => {
    const home = await installedHome();
    const path = shimPath(home);
    const text = await readFile(path, 'utf8');
    // Signed, so it is ours, and still unreadable: a shape no version wrote.
    await writeFile(path, text.replace(/^exec .*\n/m, 'exec node bin.js "$@"\n'), {
      mode: 0o755,
    });

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
    expect(checks.get('shim')?.detail).toContain('다시 읽어 들일 수 없습니다');
    // Not read and not parsed are the only two states with no node name in
    // them, and so the only two that skip.
    expect(checks.get('node-path')?.status).toBe('skip');
  });

  it('fails when the entry point the shim names is not there, and still asks its node', async () => {
    const home = await tempHome();
    await writeShim(home, { bin: join(home, 'app', 'dist', 'bin.js') });

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
    expect(checks.get('shim')?.detail).toContain('bin.js');
    expect(checks.get('node-path')).toMatchObject({ status: 'ok' });
  });

});

describe('the node checks', () => {
  it('fails node-path when the node the shim names cannot be run', async () => {
    const home = await tempHome();
    await writeShim(home, { bin: distBin, node: '/nonexistent/node' });

    const checks = await report({
      home,
      runNode: async () => ({ ok: false, message: 'ENOENT' }),
    });

    expect(checks.get('node-path')).toMatchObject({ status: 'fail' });
    expect(checks.get('node-path')?.detail).toContain('/nonexistent/node');
    expect(checks.get('node-path')?.detail).toContain('ENOENT');
  });

  it('really runs the node the shim names when nothing is injected', async () => {
    // The seam is for the awkward cases; the ordinary one has to work without
    // it, or the check is only ever exercised against a fake.
    const home = await installedHome();

    const checks = await report({ home });

    expect(checks.get('node-path')).toMatchObject({ status: 'ok' });
    expect(checks.get('node-path')?.detail).toContain(process.execPath);
    expect(checks.get('node-path')?.detail).toContain(process.versions.node);
  });

  it('fails node-path when that node is below the floor', async () => {
    const home = await installedHome();

    const checks = await report({ home, runNode: nodeSaying('v22.11.0') });

    expect(checks.get('node-path')).toMatchObject({ status: 'fail' });
    expect(checks.get('node-path')?.detail).toContain('22.11.0');
    expect(checks.get('node-path')?.detail).toContain(NODE_FLOOR);
  });

  it('fails node-path when that node answers with something that is not a version', async () => {
    const home = await installedHome();

    const checks = await report({
      home,
      runNode: async () => ({ ok: true, stdout: 'not a node at all\n' }),
    });

    expect(checks.get('node-path')).toMatchObject({ status: 'fail' });
    expect(checks.get('node-path')?.detail).toContain('not a node at all');
  });

  it('reports the node running this process for node-version', async () => {
    const home = await installedHome();

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    // These tests only run at all on a node this build supports, so the check
    // has to pass; `atLeast` is where the comparison itself is measured.
    expect(checks.get('node-version')).toEqual({
      id: 'node-version',
      status: 'ok',
      detail: `node ${process.versions.node}`,
    });
  });
});

describe('the node floor', () => {
  it('is the one the root package.json declares', async () => {
    // Two spellings of a floor is how an installer comes to accept a node the
    // hooks then fail on.
    const root = JSON.parse(await readFile(manifest, 'utf8')) as {
      engines?: { node?: string };
    };

    expect(root.engines?.node).toBe(`>=${NODE_FLOOR}`);
  });

  it('accepts this node, which is why these tests can run', () => {
    expect(meetsNodeFloor(process.versions.node)).toBe(true);
  });
});

describe('atLeast', () => {
  it('compares major, minor and patch as numbers and not as text', () => {
    expect(atLeast('24.16.0', '24.16.0')).toBe(true);
    expect(atLeast('24.16.1', '24.16.0')).toBe(true);
    expect(atLeast('24.17.0', '24.16.0')).toBe(true);
    expect(atLeast('25.0.0', '24.16.0')).toBe(true);
    // The one every string comparison gets wrong: "9" > "24" as text.
    expect(atLeast('24.9.0', '24.16.0')).toBe(false);
    expect(atLeast('9.0.0', '24.16.0')).toBe(false);
    expect(atLeast('24.15.9', '24.16.0')).toBe(false);
  });

  it('reads a leading v and ignores whatever follows the patch', () => {
    expect(atLeast('v24.16.0', '24.16.0')).toBe(true);
    expect(atLeast('24.16.0-nightly20260101', '24.16.0')).toBe(true);
  });

  it('refuses what is not a version rather than guessing at it', () => {
    expect(atLeast('', '24.16.0')).toBe(false);
    expect(atLeast('24.16', '24.16.0')).toBe(false);
    expect(atLeast('unknown', '24.16.0')).toBe(false);
  });
});
