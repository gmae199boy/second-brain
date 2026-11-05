import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { comparePackagePaths } from '../../../packages/core/src/extensions/manifest.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(root, 'plugins/testext'), pack = join(plugin, 'package');
const fixture = join(root, 'apps/cli/test/fixtures/extensions/testext');
const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path));
function allFiles(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return allFiles(join(dir, entry.name), path);
    if (!entry.isFile()) throw new Error('unexpected non-regular package file');
    return [path];
  }).sort(comparePackagePaths);
}
function packageDigest(dir: string, paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of paths) { const name = Buffer.from(path), bytes = readFileSync(join(dir, path)); hash.update(`f${name.length}:`); hash.update(name); hash.update(`:${bytes.length}:`); hash.update(bytes); }
  return hash.digest('hex');
}
function git(...args: string[]) { return spawnSync('git', args, { cwd: root, encoding: 'utf8' }); }
function versionGreater(a: string, b: string): boolean {
  if (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(a) || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(b)) return false;
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (left[i]! > right[i]!) return true; if (left[i]! < right[i]!) return false; }
  return false;
}

describe('testext marketplace package', () => {
  it('ships exactly the declared fixture bytes and the matching digest', () => {
    const manifest = json(join(pack, 'manifest.json')) as { files: string[]; core_compat: unknown; plugin_version: string };
    expect(manifest.files).toEqual([...new Set(manifest.files)].sort(comparePackagePaths));
    expect(allFiles(pack)).toEqual([...manifest.files, 'digest'].sort(comparePackagePaths));
    expect(read(join(pack, 'digest'))).toBe(`${packageDigest(pack, manifest.files)}\n`);
    const source = json(join(fixture, 'manifest.json')) as Record<string, unknown>;
    const { files: _files, core_compat: _compat, plugin_version: _pluginVersion, ...actual } = manifest;
    expect(actual).toEqual(source);
    for (const path of manifest.files.filter(path => path !== 'manifest.json')) expect(readFileSync(join(pack, path))).toEqual(readFileSync(join(fixture, path)));
    expect(manifest.core_compat).toEqual({ min: '0.0.0', max_exclusive: '1.0.0' });
    expect(manifest.plugin_version).toBe(json(join(plugin, '.claude-plugin/plugin.json')).version);
  });

  it('only instructs the user when core is absent; with core it invokes the actual shim with --package', () => {
    const home = mkdtempSync(join(tmpdir(), 'brain-plugin-home-')); temporary.push(home);
    const brainHome = join(home, 'brain home'), log = join(home, 'calls');
    const env = { HOME: home, PATH: '/usr/bin:/bin', SECOND_BRAIN_HOME: brainHome, CLAUDE_PLUGIN_ROOT: plugin, CALLS: log };
    const run = () => spawnSync('sh', [join(plugin, 'bin/install.sh')], { env, encoding: 'utf8' });
    const absent = run(); expect(absent.status).toBe(0); expect(absent.stdout).toMatch(/core.*먼저 설치/);
    expect(readdirSync(home)).toEqual([]);
    mkdirSync(join(brainHome, 'bin'), { recursive: true });
    writeFileSync(join(brainHome, 'bin/brain'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS"\nexit 17\n'); chmodSync(join(brainHome, 'bin/brain'), 0o700);
    expect(run().stdout).toMatch(/core.*먼저 설치/);
    writeFileSync(join(brainHome, 'installed.json'), '{}');
    const installed = run(); expect(installed.status).toBe(17);
    expect(read(log).split('\n')).toEqual(['ext', 'install', '--package', join(plugin, 'package'), '']);
  });

  it('declares the fixture as a marketplace SessionStart hook', () => {
    const market = json(join(root, '.claude-plugin/marketplace.json')) as { plugins: { name: string; source: string }[] };
    expect(market.plugins.find(x => x.name === 'second-brain-testext')?.source).toBe('./plugins/testext');
    expect(json(join(plugin, 'hooks/hooks.json')).hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/bin/install.sh" || exit 0', async: true });
  });
});

describe('plugin release refs', () => {
  it('compares semver as numeric components and rejects unchanged or lower versions', () => {
    expect(versionGreater('1.10.0', '1.9.99')).toBe(true);
    expect(versionGreater('0.1.0', '0.1.0')).toBe(false);
    expect(versionGreater('0.0.9', '0.1.0')).toBe(false);
    expect(versionGreater('01.2.3', '1.2.3')).toBe(false);
  });
  it.each(['plugin', 'plugins/testext'])('%s pins an earlier commit and increases its own version when its ref changes', dir => {
    const refPath = `${dir}/app-ref`, manifestPath = `${dir}/.claude-plugin/plugin.json`;
    const ref = read(join(root, refPath)); expect(ref).toMatch(/^[a-f0-9]{40}\n$/);
    const current = json(join(root, manifestPath)) as { version: string }; expect(current.version).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
    const head = git('rev-parse', 'HEAD'); expect(head.status).toBe(0);
    expect(git('merge-base', '--is-ancestor', ref.trim(), head.stdout.trim()).status).toBe(0);
    const oldRef = git('show', `HEAD:${refPath}`), oldManifest = git('show', `HEAD:${manifestPath}`);
    if (oldRef.status === 0 && oldManifest.status === 0) {
      // The working tree may point at HEAD for a future release commit; a
      // committed and unchanged ref must point strictly behind its own HEAD.
      if (oldRef.stdout === ref) expect(ref.trim()).not.toBe(head.stdout.trim());
      if (oldRef.stdout !== ref) expect(versionGreater(current.version, (JSON.parse(oldManifest.stdout) as { version: string }).version)).toBe(true);
      const changed = git('log', '-1', '--format=%H', '--', refPath); expect(changed.status).toBe(0);
      const release = changed.stdout.trim(); expect(release).toMatch(/^[a-f0-9]{40}$/);
      const releaseRef = git('show', `${release}:${refPath}`), parentRef = git('show', `${release}^:${refPath}`);
      const releaseManifest = git('show', `${release}:${manifestPath}`), parentManifest = git('show', `${release}^:${manifestPath}`);
      expect(releaseRef.status).toBe(0); expect(releaseManifest.status).toBe(0);
      expect(git('merge-base', '--is-ancestor', releaseRef.stdout.trim(), `${release}^`).status).toBe(0);
      if (parentRef.status === 0 && parentManifest.status === 0 && parentRef.stdout !== releaseRef.stdout) {
        const before = (JSON.parse(parentManifest.stdout) as { version: string }).version;
        const after = (JSON.parse(releaseManifest.stdout) as { version: string }).version;
        expect(versionGreater(after, before)).toBe(true);
      }
    } else {
      expect(oldRef.status).not.toBe(0); expect(oldManifest.status).not.toBe(0);
    }
  });
});
