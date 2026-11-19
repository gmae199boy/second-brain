import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { comparePackagePaths } from '../../../packages/core/src/extensions/manifest.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const plugin = join(root, 'plugins/garmin'), pack = join(plugin, 'package'), source = join(root, 'extensions/garmin');
const temporary: string[] = [];
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });
const read = (path: string) => readFileSync(path, 'utf8');
const json = (path: string) => JSON.parse(read(path));
function files(dir: string, base = ''): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => {
    const path = base ? `${base}/${item.name}` : item.name;
    if (item.isDirectory()) return files(join(dir, item.name), path);
    if (!item.isFile()) throw new Error('unexpected package entry');
    return [path];
  }).sort(comparePackagePaths);
}
function digest(paths: string[]): string {
  const hash = createHash('sha256');
  for (const path of paths) {
    const name = Buffer.from(path), data = readFileSync(join(pack, path));
    hash.update(`f${name.length}:`); hash.update(name); hash.update(`:${data.length}:`); hash.update(data);
  }
  return hash.digest('hex');
}
function git(...args: string[]) { return spawnSync('git', args, { cwd: root, encoding: 'utf8' }); }
function newer(a: string, b: string) {
  const va = a.split('.').map(BigInt), vb = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (va[i]! > vb[i]!) return true; if (va[i]! < vb[i]!) return false; }
  return false;
}

describe('Garmin marketplace package', () => {
  it('contains the declared product bytes, no oracle or provenance, and the canonical digest', () => {
    const manifest = json(join(pack, 'manifest.json')) as { files: string[]; core_compat: unknown; plugin_version: string } & Record<string, unknown>;
    expect(manifest.files).toEqual([...new Set(manifest.files)].sort(comparePackagePaths));
    expect(files(pack)).toEqual([...manifest.files, 'digest'].sort(comparePackagePaths));
    expect(read(join(pack, 'digest'))).toBe(`${digest(manifest.files)}\n`);
    const { files: paths, core_compat: range, plugin_version: version, ...actual } = manifest;
    expect(actual).toEqual(json(join(source, 'manifest.json')));
    expect(range).toEqual({ min: '0.0.0', max_exclusive: '1.0.0' });
    expect(version).toBe(json(join(plugin, '.claude-plugin/plugin.json')).version);
    expect(paths.every(path => !/^(tests|fixtures)\//.test(path) && path !== 'UPSTREAM.md' && !path.startsWith('src/garmin_pipeline/store/migrations/') && path !== 'src/garmin_pipeline/capture.py')).toBe(true);
    for (const path of paths.filter(path => path !== 'manifest.json')) expect(readFileSync(join(pack, path))).toEqual(readFileSync(join(source, path)));
    const expectedSources = files(join(source, 'src')).filter(path => /\.(py|json)$/.test(path) && path !== 'garmin_pipeline/capture.py' && !path.startsWith('garmin_pipeline/store/migrations/') && !path.includes('__pycache__/')).map(path => `src/${path}`);
    expect(paths.filter(path => path.startsWith('src/'))).toEqual(expectedSources);
    for (const folder of ['migrations', 'skills']) {
      const expected = files(join(source, folder)).map(path => `${folder}/${path}`);
      expect(paths.filter(path => path.startsWith(`${folder}/`))).toEqual(expected);
    }
  });

  it('guides when core is missing and delegates the Garmin name to the core shim', () => {
    const home = mkdtempSync(join(tmpdir(), 'garmin-plugin-')); temporary.push(home);
    const brainHome = join(home, 'brain home'), calls = join(home, 'calls');
    const env = { HOME: home, PATH: '/usr/bin:/bin', SECOND_BRAIN_HOME: brainHome, CLAUDE_PLUGIN_ROOT: plugin, CALLS: calls };
    const run = () => spawnSync('sh', [join(plugin, 'bin/install.sh'), '--json'], { env, encoding: 'utf8' });
    const missing = run(); expect(missing.status).toBe(0); expect(missing.stdout).toMatch(/core.*먼저 설치/);
    expect(readdirSync(home)).toEqual([]);
    mkdirSync(join(brainHome, 'bin'), { recursive: true });
    writeFileSync(join(brainHome, 'bin/brain'), '#!/bin/sh\nprintf "%s\\n" "$@" > "$CALLS"\nexit 17\n'); chmodSync(join(brainHome, 'bin/brain'), 0o700);
    expect(run().stdout).toMatch(/core.*먼저 설치/);
    writeFileSync(join(brainHome, 'installed.json'), '{}');
    expect(run().status).toBe(17);
    expect(read(calls).split('\n')).toEqual(['ext', 'install', 'garmin', '--json', '']);
  });

  it('설치 스킬은 지원 확인과 터미널 로그인 및 이름 재개를 안내한다', () => {
    const skill = read(join(plugin, 'skills/brain-garmin-install/SKILL.md'));
    expect(skill).toContain('`brain guide schema ext --json`');
    expect(skill).toContain('`brain ext login garmin`');
    expect(skill).toContain('`brain ext install garmin --json`을 같은 이름으로 한 번 재개한다');
    expect(skill).toContain('실패·취소 또는 응답이 없으면 재개하지 않고');
    expect(skill).toContain('기존 connected와 login skipped는 그 상태대로 보고한다');
    expect(skill).toContain('`login_required`는 패키지 메타데이터이지 현재 로그인 상태가 아니다');
    expect(skill).toContain('수집 계정 준비 또는 예약 발화의 증거가 아니다');
    for (const code of ['LOGIN_REQUIRED', 'AUTH_CANCELLED', 'AUTH_UNAVAILABLE', 'EXTENSION_AUTH_FAILED', 'EXTENSION_CHECK_FAILED', 'EXTENSION_SCHEDULER_UNAVAILABLE', 'EXTENSION_INVALID', 'EXTENSION_NOT_INSTALLED']) expect(skill).toContain(code);
    for (const code of ['TOKEN_VERIFY_PENDING', 'GARMIN_BINDING_RECOVERY_REQUIRED']) expect(skill).toContain(code);
    expect(skill).toContain('모든 설치 명령의 성공·실패·취소·인증 대기 뒤에는');
    for (const state of ['`login`', '`connection`', '`schedule`', '`install.stages`']) expect(skill).toContain(state);
    expect(skill).not.toContain('터미널 인증 실행 항목이 없어');
    expect(skill).not.toContain('--package');
    expect(json(join(pack, 'manifest.json')).auth).toMatchObject({kind:'garmin.auth', runtime:'python', entry:'src/auth.py', probe_on_install:true});
  });

  it('registers the marketplace hook and pins an earlier ref with independent versioning', () => {
    const market = json(join(root, '.claude-plugin/marketplace.json')) as { plugins: { name: string; source: string }[] };
    expect(market.plugins.find(p => p.name === 'second-brain-garmin')?.source).toBe('./plugins/garmin');
    expect(json(join(plugin, 'hooks/hooks.json')).hooks.SessionStart[0].hooks[0]).toEqual({ type: 'command', command: 'sh "${CLAUDE_PLUGIN_ROOT}/bin/install.sh" || exit 0', async: true });
    const ref = read(join(plugin, 'app-ref')).trim(), version = json(join(plugin, '.claude-plugin/plugin.json')).version as string;
    expect(ref).toMatch(/^[a-f0-9]{40}$/); expect(version).toMatch(/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/);
    const head = git('rev-parse', 'HEAD').stdout.trim();
    expect(ref).not.toBe(head); expect(git('merge-base', '--is-ancestor', ref, `${head}^`).status).toBe(0);
    const oldRef = git('show', 'HEAD:plugins/garmin/app-ref'), oldVersion = git('show', 'HEAD:plugins/garmin/.claude-plugin/plugin.json');
    if (oldRef.status === 0 && oldVersion.status === 0) {
      if (oldRef.stdout.trim() !== ref) expect(newer(version, jsonVersion(oldVersion.stdout))).toBe(true);
      const release = git('log', '-1', '--format=%H', '--', 'plugins/garmin/app-ref').stdout.trim();
      const releaseRef = git('show', `${release}:plugins/garmin/app-ref`);
      expect(git('merge-base', '--is-ancestor', releaseRef.stdout.trim(), `${release}^`).status).toBe(0);
      const priorRef = git('show', `${release}^:plugins/garmin/app-ref`);
      const priorVersion = git('show', `${release}^:plugins/garmin/.claude-plugin/plugin.json`);
      const releaseVersion = git('show', `${release}:plugins/garmin/.claude-plugin/plugin.json`);
      if (priorRef.status === 0 && priorVersion.status === 0 && priorRef.stdout !== releaseRef.stdout) expect(newer(jsonVersion(releaseVersion.stdout), jsonVersion(priorVersion.stdout))).toBe(true);
    }
  });
});
function jsonVersion(text: string): string { return (JSON.parse(text) as { version: string }).version; }
