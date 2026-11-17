import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../../package-garmin/check-release-identity.mjs', import.meta.url));
const temporary: string[] = [];
afterEach(() => { for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });

it('compares the candidate against the explicitly selected published identity and fails closed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'garmin-release-')); temporary.push(dir);
  const pack = join(dir, 'plugins/garmin/package'); mkdirSync(pack, { recursive: true });
  const set = (version: unknown, digest: string) => {
    writeFileSync(join(pack, 'manifest.json'), JSON.stringify({ name: 'garmin', version }));
    writeFileSync(join(pack, 'digest'), `${digest}\n`);
  };
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
  };
  git('init', '-q'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.invalid');
  set('1.2.14', 'a'.repeat(64)); git('add', '.'); git('commit', '-qm', 'published'); git('tag', 'published');
  const run = (...args: string[]) => spawnSync(process.execPath, [script, ...args], { cwd: dir, encoding: 'utf8' });
  expect(run('HEAD').status).toBe(0);
  set('1.2.14', 'b'.repeat(64));
  const conflict = run('HEAD'); expect(conflict.status).toBe(1); expect(conflict.stderr).toContain('different digest');
  set(['1.2.14'], 'b'.repeat(64)); expect(run('HEAD').status).toBe(1);
  git('add', '.'); git('commit', '-qm', 'malformed baseline');
  set('1.2.15', 'b'.repeat(64)); expect(run('HEAD').status).toBe(1);
  expect(run('published').status).toBe(0);
  set('1.2.15', 'invalid'); expect(run('HEAD').status).toBe(1);
  expect(run('missing-ref').status).toBe(1); expect(run().status).toBe(1);
});
