import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isoWithOffset, isWarningCode, type DoctorCheck } from 'second_brain';
import { memorySpool, sampleSpoolRecord, type MemorySpool } from 'second_brain/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { writeConfig } from '../src/config/codec.js';
import { configFilePath, pluginRunPath, spoolPath } from '../src/config/paths.js';
import {
  NODE_FLOOR,
  atLeast,
  meetsNodeFloor,
  runtimeChecks,
  type RunGit,
  type RunNode,
  type RuntimeChecksOptions,
} from '../src/doctor/checks.js';
import { shimPath, writeShim } from '../src/install/shim.js';
import { systemClock } from '../src/runtime/clock.js';
import { fileSpool } from '../src/runtime/spool.js';
import { assertKoreanLine } from './language.js';
import { tempHomes } from './temp-home.js';

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

const temporary = tempHomes();

async function tempHome(): Promise<string> {
  const home = await temporary.create('brain-checks-');
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

afterEach(() => temporary.cleanup());

beforeAll(() => {
  if (!existsSync(distBin)) {
    throw new Error(`${distBin} does not exist. Run \`pnpm build\` before these tests.`);
  }
});

describe('runtimeChecks', () => {
  it('registers the machine checks, in the order they are reported', () => {
    expect(runtimeChecks({ home: '/nowhere' }).map((source) => source.id)).toEqual([
      'config',
      'shim',
      'node-path',
      'node-version',
      'plugin',
      'last-hook',
      'spool',
      'daemon',
    ]);
  });

  it('reports healthy installed checks and warns about the absent daemon', async () => {
    const home = await installedHome();

    const checks = await report({ home, runNode: nodeSaying(NODE_FLOOR) });

    const failed = [...checks.values()].filter((check) => check.status !== 'ok' && check.id !== 'daemon');
    expect(failed, JSON.stringify(failed)).toEqual([]);
    expect(checks.get('daemon')).toMatchObject({ status: 'warn' });
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

  it('warns, and does not fail, when the shim carries a home other than this one', async () => {
    const home = await tempHome();
    const other = await tempHome();
    // Two installations, or a `SECOND_BRAIN_HOME` pointed somewhere for an
    // afternoon. Calling it a failure made doctor refuse to say anything else
    // about an install that works (F9).
    await writeShim(home, { bin: distBin, home: other });

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    expect(checks.get('shim')).toMatchObject({ status: 'warn' });
    // No shared code: nothing is degraded and nothing is being worked around.
    expect(checks.get('shim')?.code).toBeUndefined();
    expect(checks.get('shim')?.detail).toContain(other);
    expect(checks.get('shim')?.detail).toContain(home);
    // And every check after it still runs, which is the point.
    expect(checks.get('node-path')).toMatchObject({ status: 'ok' });
    expect(checks.get('node-version')).toMatchObject({ status: 'ok' });
  });

  it('still fails a shim that carries another home and names no entry point', async () => {
    const home = await tempHome();
    const other = await tempHome();
    await writeShim(home, { bin: join(home, 'gone', 'bin.js'), home: other });

    const checks = await report({ home, runNode: nodeSaying('24.16.0') });

    // A file that cannot work is a failure whatever else is true of it.
    expect(checks.get('shim')).toMatchObject({ status: 'fail' });
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

/**
 * The `plugin` check's judgement table, row by row (AD-19, F7).
 *
 * The record and the `app-ref` are real files in temporary folders, because
 * reading them is half of what the check does. Only the ancestry questions are
 * injected: "behind", "ahead", "diverged" and "cannot say" are four answers
 * git gives about commits that would have to exist in this clone, and three of
 * them cannot be arranged here.
 */
describe('the plugin check', () => {
  /** What this build says about itself, which the check holds the record to. */
  const build = JSON.parse(
    readFileSync(fileURLToPath(new URL('../dist/build.json', import.meta.url)), 'utf8'),
  ) as { commit: string | null; schema_version: number };

  /** Another commit, for the rows about two commits that are not the same. */
  const OTHER = 'b'.repeat(40);

  /** Ancestry, as `merge-base --is-ancestor` answers it: 0 yes, 1 no. */
  function ancestry(answers: Record<string, number>): RunGit {
    return async (args) => {
      const [maybeAncestor, descendant] = args.slice(-2);
      return { code: answers[`${String(maybeAncestor)} ${String(descendant)}`] ?? 128 };
    };
  }

  /** A home with a configuration, a shim and a completion record. */
  async function recorded(
    facts: { commit?: string | null; pluginRoot?: string | null; installedAt?: string },
    config: { updateAuto?: boolean } = {},
  ): Promise<string> {
    const home = await tempHome();
    await writeConfig(home, config);
    await writeShim(home, { bin: distBin });
    await writeFile(
      join(home, 'installed.json'),
      JSON.stringify({
        commit: facts.commit === undefined ? build.commit : facts.commit,
        schema_version: build.schema_version,
        node: process.execPath,
        plugin_root: facts.pluginRoot === undefined ? null : facts.pluginRoot,
        installed_at: facts.installedAt ?? '2026-10-17T00:00:00.000Z',
      }),
      'utf8',
    );
    return home;
  }

  /** A plugin folder whose `app-ref` names this commit. */
  async function pluginAt(ref: string | undefined): Promise<string> {
    const folder = await tempHome();
    if (ref !== undefined) await writeFile(join(folder, 'app-ref'), `${ref}\n`, 'utf8');
    return folder;
  }

  /** What a `SessionStart` left under `<home>/run/`, as text or as a record. */
  async function sessionSaw(home: string, record: unknown): Promise<void> {
    await mkdir(join(home, 'run'), { recursive: true, mode: 0o700 });
    await writeFile(
      pluginRunPath(home),
      typeof record === 'string' ? record : JSON.stringify(record),
      'utf8',
    );
  }

  async function pluginCheck(home: string, runGit?: RunGit): Promise<DoctorCheck> {
    const checks = await report({
      home,
      runNode: nodeSaying(NODE_FLOOR),
      ...(runGit === undefined ? {} : { runGit }),
    });
    const check = checks.get('plugin');
    expect(check).toBeDefined();
    return check as DoctorCheck;
  }

  it('is ok, and says so, when nothing has finished installing here', async () => {
    const home = await tempHome();

    expect(await pluginCheck(home)).toMatchObject({ status: 'ok' });
  });

  it('is ok when the install did not come from a plugin', async () => {
    const home = await recorded({ pluginRoot: null });

    expect(await pluginCheck(home)).toMatchObject({ status: 'ok' });
  });

  it('warns with no code when the app-ref cannot be read', async () => {
    const plugin = await pluginAt(undefined);
    const home = await recorded({ pluginRoot: plugin });

    const check = await pluginCheck(home);

    expect(check).toMatchObject({ status: 'warn' });
    expect(check.code).toBeUndefined();
    expect(check.detail).toContain(plugin);
  });

  it('warns with no code when the build answering this command is another one', async () => {
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit: 'c'.repeat(40) });

    const check = await pluginCheck(home);

    expect(check).toMatchObject({ status: 'warn' });
    expect(check.code).toBeUndefined();
    expect(check.detail).toContain('ccccccc');
  });

  it('warns with no code when the record carries no commit at all', async () => {
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit: null });

    const check = await pluginCheck(home);

    expect(check).toMatchObject({ status: 'warn' });
    expect(check.code).toBeUndefined();
  });

  it('is ok when the plugin and the install are the same commit', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(commit);
    const home = await recorded({ pluginRoot: plugin, commit });

    const check = await pluginCheck(home);

    expect(check).toMatchObject({ status: 'ok' });
    expect(check.detail).toContain(commit.slice(0, 7));
  });

  it('warns PLUGIN_BEHIND when the plugin asks for something older', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit });

    const check = await pluginCheck(home, ancestry({ [`${OTHER} ${commit}`]: 0 }));

    expect(check).toMatchObject({ status: 'warn', code: 'PLUGIN_BEHIND' });
  });

  it('is ok when the plugin is ahead and automatic updating is on', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit }, { updateAuto: true });

    const check = await pluginCheck(
      home,
      ancestry({ [`${OTHER} ${commit}`]: 1, [`${commit} ${OTHER}`]: 0 }),
    );

    expect(check).toMatchObject({ status: 'ok' });
    expect(check.detail).toContain('다음 세션');
  });

  it('warns UPDATE_AVAILABLE when the plugin is ahead and nothing will fetch it', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit }, { updateAuto: false });

    const check = await pluginCheck(
      home,
      ancestry({ [`${OTHER} ${commit}`]: 1, [`${commit} ${OTHER}`]: 0 }),
    );

    expect(check).toMatchObject({ status: 'warn', code: 'UPDATE_AVAILABLE' });
    // The detail is the only place anybody is told how to turn it on.
    expect(check.detail).toContain('[update] auto = true');
  });

  it('warns with no code when the two histories have diverged', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit });

    const check = await pluginCheck(
      home,
      ancestry({ [`${OTHER} ${commit}`]: 1, [`${commit} ${OTHER}`]: 1 }),
    );

    expect(check).toMatchObject({ status: 'warn' });
    expect(check.code).toBeUndefined();
    expect(check.detail).toContain('갈라졌습니다');
  });

  it('warns with no code when git cannot answer at all', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit });

    // A ref that is not in this clone, or no clone to ask: "not known" and
    // "not related" are different answers.
    const check = await pluginCheck(home, async () => ({ code: 128 }));

    expect(check).toMatchObject({ status: 'warn' });
    expect(check.code).toBeUndefined();
    expect(check.detail).toContain('알 수 없습니다');
  });

  it.each(['PLUGIN_BEHIND', 'UPDATE_AVAILABLE'])(
    'carries %s as a shared code, so the envelope lifts it into warnings',
    (code) => {
      // `doctor-run.ts` puts a check's `code` into `warnings[]` when it is one
      // of the shared ones, so a code this check invented would be reported as
      // a detail and nowhere else (Conventions, NFR-2).
      expect(isWarningCode(code)).toBe(true);
    },
  );

  /**
   * The folder the last session came from, which is the one that is asking.
   * The plugin cache keeps one folder per version, so after a
   * `claude plugin update` with nothing installed since, the completion
   * record's folder is a version nothing calls any more and comparing against
   * it reported that all was well (2.5 human check 1).
   */
  describe('with a record of the last session', () => {
    /** The record a session with this folder and this ref leaves behind. */
    function saw(root: string, ref: string, last?: unknown): unknown {
      return {
        plugin_root: root,
        app_ref: ref,
        seen_at: '2026-10-18T00:00:00.000Z',
        ...(last === undefined ? {} : { last_bootstrap: last }),
      };
    }

    it('warns UPDATE_AVAILABLE about the new folder, not the installed one', async () => {
      const commit = build.commit ?? 'a'.repeat(40);
      const old = await pluginAt(commit);
      const fresh = await pluginAt(OTHER);
      const home = await recorded({ pluginRoot: old, commit }, { updateAuto: false });
      await sessionSaw(home, saw(fresh, OTHER));

      const check = await pluginCheck(
        home,
        ancestry({ [`${OTHER} ${commit}`]: 1, [`${commit} ${OTHER}`]: 0 }),
      );

      // Against the old folder this is `ok`, which is what the check used to
      // say: both of them hold the installed commit.
      expect(check).toMatchObject({ status: 'warn', code: 'UPDATE_AVAILABLE' });
    });

    it('warns PLUGIN_BEHIND about the new folder when it asks for something older', async () => {
      const commit = build.commit ?? 'a'.repeat(40);
      const fresh = await pluginAt(OTHER);
      const home = await recorded({ pluginRoot: null, commit });
      await sessionSaw(home, saw(fresh, OTHER));

      const check = await pluginCheck(home, ancestry({ [`${OTHER} ${commit}`]: 0 }));

      expect(check).toMatchObject({ status: 'warn', code: 'PLUGIN_BEHIND' });
    });

    it('falls back to the completion record when there is no record of a session', async () => {
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({ pluginRoot: plugin, commit });

      // An installation from before this record existed, and an npx one: both
      // have to go on working exactly as they did (Boundaries).
      expect(await pluginCheck(home)).toMatchObject({ status: 'ok' });
    });

    it('ignores a record it cannot read back, and says that it did', async () => {
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({ pluginRoot: plugin, commit });
      await sessionSaw(home, '{ not json');

      const check = await pluginCheck(home);

      expect(check).toMatchObject({ status: 'ok' });
      expect(check.detail).toContain(commit.slice(0, 7));
      // True whether or not there is a completion record to fall back to.
      expect(check.detail).toContain(`${pluginRunPath(home)}을 읽을 수 없어서 무시했습니다`);
    });

    it('says the record was ignored even when there is no completion record', async () => {
      const home = await tempHome();
      await writeConfig(home, {});
      await writeShim(home, { bin: distBin });
      await sessionSaw(home, '{ not json');

      const check = await pluginCheck(home);

      expect(check.detail).toContain('완료 기록이 아직 없습니다');
      expect(check.detail).toContain('무시했습니다');
    });

    it.each([
      ['a plugin folder that is not a path', { plugin_root: '', app_ref: 'a'.repeat(40), seen_at: 'x' }],
      ['a ref that is not a commit', { plugin_root: '/p', app_ref: 'nope', seen_at: 'x' }],
      ['no time at all', { plugin_root: '/p', app_ref: 'a'.repeat(40) }],
    ])('refuses %s rather than reporting on half a record', async (_what, broken) => {
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({ pluginRoot: plugin, commit });
      await sessionSaw(home, broken);

      const check = await pluginCheck(home);

      expect(check.detail).toContain(pluginRunPath(home));
    });

    it('drops an outcome it cannot read and keeps the rest of the record', async () => {
      // The bootstrap's own reader drops it too, and it decides what to write
      // from the folder and the ref alone: refusing the whole record here
      // would be a state nothing ever writes its way out of.
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({ pluginRoot: null, commit });
      await sessionSaw(home, saw(plugin, commit, { at: 'y', result: 'failed', log: '/l' }));

      const check = await pluginCheck(home);

      // The folder in the record was used, so the record was not refused.
      expect(check).toMatchObject({ status: 'ok' });
      expect(check.detail).toContain(commit.slice(0, 7));
      expect(check.detail).not.toContain('마지막 설치');
      expect(check.detail).not.toContain(pluginRunPath(home));
    });

    it('reports a finished install in one more sentence, and stays ok', async () => {
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({ pluginRoot: plugin, commit });
      await sessionSaw(
        home,
        saw(plugin, commit, {
          at: '2026-10-18T02:12:40.000Z',
          result: 'installed',
          log: join(home, 'log', 'bootstrap.log'),
        }),
      );

      const check = await pluginCheck(home);

      expect(check).toMatchObject({ status: 'ok' });
      expect(check.detail).toContain('2026-10-18T02:12:40.000Z');
    });

    it('warns about a bootstrap that stopped, naming the step and the log', async () => {
      // The hook said it once, to the model, in a session nobody may have
      // looked at (Decision 2026-10-18).
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({ pluginRoot: plugin, commit });
      const log = join(home, 'log', 'bootstrap.log');
      await sessionSaw(
        home,
        saw(plugin, commit, { at: '2026-10-18T02:12:40.000Z', result: 'failed', step: '클론 빌드', log }),
      );

      const check = await pluginCheck(home);

      expect(check).toMatchObject({ status: 'warn' });
      expect(check.detail).toContain('클론 빌드');
      expect(check.detail).toContain(log);
    });

    it('stops warning about a failure the install got past by another door', async () => {
      // `npx` or `brain setup run` finishes the install, and the next session
      // takes the fast path and never rewrites the record — so a warn about
      // that old failure would be there for good.
      const commit = build.commit ?? 'a'.repeat(40);
      const plugin = await pluginAt(commit);
      const home = await recorded({
        pluginRoot: plugin,
        commit,
        installedAt: '2026-10-18T03:00:00.000Z',
      });
      await sessionSaw(
        home,
        saw(plugin, commit, {
          at: '2026-10-18T02:00:00.000Z',
          result: 'failed',
          step: '클론 빌드',
          log: join(home, 'log', 'bootstrap.log'),
        }),
      );

      const check = await pluginCheck(home);

      expect(check).toMatchObject({ status: 'ok' });
    });

    it('is ok, and says so, when a plugin came but nothing has finished installing', async () => {
      const home = await tempHome();
      await writeConfig(home, {});
      await writeShim(home, { bin: distBin });
      const plugin = await pluginAt(OTHER);
      await sessionSaw(home, saw(plugin, OTHER));

      const check = await pluginCheck(home);

      expect(check).toMatchObject({ status: 'ok' });
      expect(check.detail).toContain(plugin);
    });
  });

  it('really asks git when nothing is injected, rather than only ever a fake', async () => {
    const commit = build.commit ?? 'a'.repeat(40);
    const plugin = await pluginAt(OTHER);
    const home = await recorded({ pluginRoot: plugin, commit });

    // `OTHER` is not a commit of this repository, so git answers that it
    // cannot say — which is the one real answer available here, and proves the
    // default seam runs git rather than nothing.
    const check = await pluginCheck(home);

    expect(check).toMatchObject({ status: 'warn' });
    expect(check.detail).toContain('알 수 없습니다');
  });
});

/**
 * The spool check: what is waiting to go into the database (AD-9). It is a
 * `warn` whenever there is anything, because nothing is broken — the records
 * are safe and a later drain puts them in — and it may not be silent, because
 * a spool nobody looks at is the one failure mode the whole mechanism has.
 */
describe('the spool check', () => {
  /** The spool check's answer for one spool. */
  async function spoolCheck(home: string, spool?: MemorySpool): Promise<DoctorCheck> {
    const source = runtimeChecks({ home, ...(spool === undefined ? {} : { spool }) }).find(
      (candidate) => candidate.id === 'spool',
    );
    if (source === undefined) throw new Error('there is no spool check');
    const check = await source.run();
    assertKoreanLine(check.detail ?? '', { label: 'spool detail' });
    return check;
  }

  it('is ok with nothing waiting, and says so rather than nothing', async () => {
    const home = await installedHome();

    expect(await spoolCheck(home)).toEqual({ id: 'spool', status: 'ok', detail: '0건' });
  });

  it('is ok when there is no spool folder at all', async () => {
    // Which is the state of a brain whose database has always been reachable:
    // the folder is made by the first write that could not reach it.
    const home = await tempHome();

    expect(await spoolCheck(home)).toMatchObject({ id: 'spool', status: 'ok', detail: '0건' });
  });

  it('warns with SPOOLED, the count and the oldest instant when something is waiting', async () => {
    const home = await installedHome();
    const spool = memorySpool();
    const older = new Date('2026-01-02T03:04:05.000Z');
    expect(
      await spool.append([
        sampleSpoolRecord({ id: '01940000-0000-7000-8000-0000000000e1' }),
        sampleSpoolRecord({ id: '01940000-0000-7000-8000-0000000000e2', occurredAt: older }),
      ]),
    ).toMatchObject({ ok: true });

    const check = await spoolCheck(home, spool);

    // A shared code, so the envelope carries it in `warnings[]` too.
    expect(check).toMatchObject({ id: 'spool', status: 'warn', code: 'SPOOLED' });
    expect(isWarningCode(check.code ?? '')).toBe(true);
    expect(check.detail).toContain('2건');
    // The instant with this machine's offset, as every instant a person reads
    // is (Conventions, 시각).
    expect(check.detail).toContain(isoWithOffset(older));
  });

  it('counts the records of a claimed file too', async () => {
    // A record a drain is in the middle of replaying has still not reached the
    // database, so a report that stopped counting it would say the spool had
    // emptied when somebody merely picked it up.
    const home = await installedHome();
    const spool = memorySpool();
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    expect(await spool.claim()).toMatchObject({ ok: true });

    expect(await spoolCheck(home, spool)).toMatchObject({ status: 'warn', code: 'SPOOLED' });
  });

  it('warns about the lines nobody will try again, even with nothing waiting', async () => {
    // A line moved to `failed/` has given up: nothing will touch it again, and
    // a work log entry has no original to be read a second time. So it must not
    // be silent, and this line is the only place anybody would see it (NFR-2,
    // 2026-10-16).
    const home = await installedHome();
    const spool = memorySpool();
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });
    const claimed = await spool.claim();
    expect(claimed).toMatchObject({ ok: true });
    if (!claimed.ok || claimed.claim === null) return;
    expect(
      await spool.rewrite(claimed.claim.handle, { keep: [], failed: claimed.claim.lines }),
    ).toMatchObject({ ok: true });

    const check = await spoolCheck(home, spool);

    expect(check).toMatchObject({ status: 'warn', code: 'SPOOLED' });
    expect(check.detail).toContain('0건');
    expect(check.detail).toContain('실패로 옮긴 줄 1건');
  });

  it('reports the count with no instant when nothing waiting could be read', async () => {
    const home = await installedHome();
    const spool = memorySpool();
    const unreadable: MemorySpool = {
      ...spool,
      async stats() {
        return { ok: true, records: 2, earliest: null, failed: 0 };
      },
    };

    const check = await spoolCheck(home, unreadable);

    expect(check).toMatchObject({ status: 'warn', code: 'SPOOLED', detail: '2건' });
  });

  it('fails when the spool itself cannot be read', async () => {
    const home = await installedHome();
    const spool = memorySpool({ statsFailure: 'spool 폴더를 읽을 수 없습니다' });

    expect(await spoolCheck(home, spool)).toEqual({
      id: 'spool',
      status: 'fail',
      detail: 'spool 폴더를 읽을 수 없습니다',
    });
  });

  it('reports the real folder of the home it was asked about', async () => {
    // Nothing injected: the default is this home's `spool/`, which is what
    // every real invocation reports on.
    const home = await installedHome();
    const spool = fileSpool({ folder: spoolPath(home), clock: systemClock });
    expect(await spool.append([sampleSpoolRecord()])).toMatchObject({ ok: true });

    expect(await spoolCheck(home)).toMatchObject({ status: 'warn', code: 'SPOOLED', detail: expect.stringContaining('1건') });
  });
});

describe('last-hook check', () => {
  async function hookCheck(home: string, names = ['claude-code']): Promise<DoctorCheck> {
    const check = runtimeChecks({ home, harnessNames: names }).find((source) => source.id === 'last-hook');
    if (check === undefined) throw new Error('missing last-hook check');
    return check.run();
  }
  it('reports missing records per harness', async () => {
    const home = await installedHome();
    expect(await hookCheck(home, ['claude-code', 'other'])).toEqual({ id: 'last-hook', status: 'ok', detail: 'claude-code: 아직 받은 hook이 없습니다. other: 아직 받은 hook이 없습니다' });
  });
  it('reports the mtime with an offset and accepts empty root content', async () => {
    const home = await installedHome();
    await mkdir(join(home, 'run'), { recursive: true });
    const path = join(home, 'run', 'last-hook-claude-code');
    await writeFile(path, '');
    const { stat } = await import('node:fs/promises');
    expect(await hookCheck(home)).toEqual({ id: 'last-hook', status: 'ok', detail: `claude-code: ${isoWithOffset((await stat(path)).mtime)}` });
  });
  it('prefers the running plugin root and detects a second plugin folder', async () => {
    const home = await installedHome();
    const { recordHookArrival } = await import('../src/runtime/hook-arrival.js');
    await recordHookArrival(home, 'claude-code', '/old/plugin');
    await writeFile(join(home, 'installed.json'), JSON.stringify({ commit: 'a'.repeat(40), schema_version: 6, node: process.execPath, plugin_root: '/installed/plugin', installed_at: new Date().toISOString() }));
    await writeFile(pluginRunPath(home), JSON.stringify({ plugin_root: '/current/plugin', app_ref: 'a'.repeat(40), seen_at: new Date().toISOString() }));
    const check = await hookCheck(home);
    expect(check).toMatchObject({ status: 'warn', code: 'PLUGIN_DUPLICATE' });
    expect(check.detail).toContain('/old/plugin');
    expect(check.detail).toContain('/current/plugin');
    await recordHookArrival(home, 'claude-code', '/current/plugin');
    expect(await hookCheck(home)).toMatchObject({ status: 'ok' });
  });
  it('falls back to the installed plugin root', async () => {
    const home = await installedHome();
    const { recordHookArrival } = await import('../src/runtime/hook-arrival.js');
    await recordHookArrival(home, 'claude-code', '/old/plugin');
    await writeFile(join(home, 'installed.json'), JSON.stringify({ commit: 'a'.repeat(40), schema_version: 6, node: process.execPath, plugin_root: '/installed/plugin', installed_at: new Date().toISOString() }));
    expect(await hookCheck(home)).toMatchObject({ status: 'warn', code: 'PLUGIN_DUPLICATE', detail: expect.stringContaining('/installed/plugin') });
  });
});
