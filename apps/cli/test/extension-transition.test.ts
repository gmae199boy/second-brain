import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extensionTransitions } from '../src/runtime/extension-transition.js';
import { extensionRuntime } from '../src/runtime/extensions.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const owner = '12345678-1234-4234-8234-123456789abc', other = '12345678-1234-4234-8234-123456789abd';
const digest = 'a'.repeat(64);
async function setup(previous = true) {
  const home = await mkdtemp(join(tmpdir(), 'brain-transition-')); roots.push(home);
  const source = join(home, 'source'), target = join(home, 'extensions', 'testext');
  await mkdir(source, { recursive: true }); await writeFile(join(source, 'code'), 'new');
  if (previous) {
    for (const dir of ['reports', 'staging', 'tokenstore']) { await mkdir(join(target, dir), { recursive: true }); await writeFile(join(target, dir, 'data'), dir); }
    await writeFile(join(target, 'code'), 'old');
  }
  return { home, source, target };
}
const prepare = (home: string, source: string) => extensionTransitions(home).prepare({ name: 'testext', owner, digest, directory: source });

describe('persistent extension transition', () => {
  it('repairs partial SQL replacements and deletions without replacing the owned environment', async () => {
    const { home, source, target } = await setup();
    await mkdir(join(source, 'migrations')); await writeFile(join(source, 'migrations/0001_one.sql'), 'old'); await writeFile(join(source, 'migrations/0002_two.sql'), 'old');
    const packages = extensionRuntime({ home, env: {}, config: { ok: false, code: 'CONFIG_MISSING', message: 'synthetic' }, clock: { now: () => new Date(0) } }).packages;
    const old = (await packages.inspect!('testext', source, 'migrations')).digest;
    const real = extensionTransitions(home); await real.prepare({ name: 'testext', owner, digest: old, directory: source });
    const stage = await real.stagedDirectory('testext', owner); await mkdir(join(stage, '.venv/bin'), { recursive: true });
    await symlink('/synthetic/python', join(stage, '.venv/bin/python')); await writeFile(join(stage, '.venv/marker'), 'unchanged'); const inode = (await stat(join(stage, '.venv/marker'))).ino;
    await writeFile(join(source, 'migrations/0001_one.sql'), 'new'); await rm(join(source, 'migrations/0002_two.sql'));
    const next = (await packages.inspect!('testext', source, 'migrations')).digest;
    const input = { name: 'testext', owner, source, migrations: 'migrations', digest: next, verify: async (dir: string) => (await packages.inspect!('testext', dir, 'migrations', undefined, owner)).digest === next };
    await expect(real.refreshPreparedMigrations({ ...input, owner: other })).rejects.toThrow();
    let interrupted = false;
    const move: typeof rename = async (from, to) => { await rename(from, to); if (!interrupted) { interrupted = true; throw new Error('crash after replace'); } };
    await expect(extensionTransitions(home, move).refreshPreparedMigrations(input)).rejects.toThrow('crash');
    expect((await real.read('testext'))?.digest).toBe(old); expect(await readFile(join(stage, 'migrations/0001_one.sql'), 'utf8')).toBe('new');
    await expect(real.refreshPreparedMigrations({ ...input, verify: async () => false })).rejects.toThrow('digest mismatch');
    await expect(stat(join(stage, 'migrations/0002_two.sql'))).rejects.toThrow();
    expect((await real.read('testext'))?.digest).toBe(old);
    await real.refreshPreparedMigrations(input);
    expect((await real.read('testext'))?.digest).toBe(next); expect((await stat(join(stage, '.venv/marker'))).ino).toBe(inode);
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('old');
    await expect(packages.inspect!('testext', stage, 'migrations')).rejects.toThrow();
    await real.activate('testext', owner); await expect(real.refreshPreparedMigrations(input)).rejects.toThrow();
  });
  it('rejects symlinked source, environment roots and SQL in an owned stage', async () => {
    const { home, source } = await setup(); await mkdir(join(source, 'migrations')); await writeFile(join(source, 'migrations/0001_one.sql'), 'one');
    const packages = extensionRuntime({ home, env: {}, config: { ok: false, code: 'CONFIG_MISSING', message: 'synthetic' }, clock: { now: () => new Date(0) } }).packages;
    await symlink('/synthetic', join(source, 'link')); await expect(packages.inspect!('testext', source, 'migrations')).rejects.toThrow(); await rm(join(source, 'link'));
    const digest = (await packages.inspect!('testext', source, 'migrations')).digest, transition = extensionTransitions(home);
    await transition.prepare({ name: 'testext', owner, digest, directory: source }); const stage = await transition.stagedDirectory('testext', owner);
    await symlink('/synthetic', join(stage, '.venv')); await expect(packages.inspect!('testext', stage, 'migrations', undefined, owner)).rejects.toThrow(); await rm(join(stage, '.venv'));
    await rm(join(stage, 'migrations/0001_one.sql')); await symlink('/synthetic', join(stage, 'migrations/0001_one.sql'));
    await expect(transition.refreshPreparedMigrations({ name: 'testext', owner, source, migrations: 'migrations', digest, verify: async () => true })).rejects.toThrow();
  });
  it('exposes the same journal and stage through a new runtime instance', async () => {
    const { home, source, target } = await setup();
    const make = () => extensionRuntime({ home, env: {}, config: { ok: false, code: 'CONFIG_MISSING', message: 'synthetic' }, clock: { now: () => new Date(0) } });
    const first = make().packages.transition!;
    await first.prepare({ name: 'testext', owner, digest, directory: source });
    const second = make().packages.transition!;
    expect((await second.read('testext'))?.owner).toBe(owner);
    await second.activate('testext', owner);
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('new');
    await make().packages.transition!.rollback('testext', owner);
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('old');
  });
  it('resumes prepared and active stages in new instances and preserves extension data through commit', async () => {
    const { home, source, target } = await setup();
    await prepare(home, source);
    const second = extensionTransitions(home), stage = await second.stagedDirectory('testext', owner);
    expect(await readFile(join(stage, 'code'), 'utf8')).toBe('new');
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('old');
    await second.activate('testext', owner);
    const third = extensionTransitions(home);
    expect((await third.read('testext'))?.phase).toBe('active');
    expect(await third.activate('testext', owner)).toBe(target);
    for (const dir of ['reports', 'staging', 'tokenstore']) expect(await readFile(join(target, dir, 'data'), 'utf8')).toBe(dir);
    await third.commit('testext', owner);
    expect(await extensionTransitions(home).read('testext')).toBeNull();
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('new');
  });
  it.each(['backup', 'activate'] as const)('recovers after %s rename fails', async failure => {
    const { home, source, target } = await setup(); await prepare(home, source);
    let injected = false;
    const failing: typeof rename = async (from, to) => {
      if (!injected && (failure === 'backup' ? String(to).endsWith('/previous') : String(from).endsWith('/new'))) { injected = true; throw new Error('injected rename failure'); }
      await rename(from, to);
    };
    await expect(extensionTransitions(home, failing).activate('testext', owner)).rejects.toThrow('injected');
    const recovered = extensionTransitions(home);
    expect((await recovered.read('testext'))?.phase).toBe('switching');
    await recovered.activate('testext', owner);
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('new');
    await recovered.rollback('testext', owner);
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('old');
    for (const dir of ['reports', 'staging', 'tokenstore']) expect(await readFile(join(target, dir, 'data'), 'utf8')).toBe(dir);
  });
  it('resumes rollback after interruption moving the replacement aside', async () => {
    const { home, source, target } = await setup(); await prepare(home, source);
    await extensionTransitions(home).activate('testext', owner);
    const failing: typeof rename = async (from, to) => { if (String(from).endsWith('/previous')) throw new Error('injected rollback'); await rename(from, to); };
    await expect(extensionTransitions(home, failing).rollback('testext', owner)).rejects.toThrow('injected');
    await extensionTransitions(home).rollback('testext', owner);
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('old');
  });
  it('rebuilds an incomplete pre-switch copy on retry', async () => {
    const { home, source, target } = await setup();
    await rm(join(target, 'reports'), { recursive: true }); await writeFile(join(target, 'reports'), 'invalid');
    await expect(prepare(home, source)).rejects.toThrow();
    expect((await extensionTransitions(home).read('testext'))?.phase).toBe('preparing');
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('old');
    await rm(join(target, 'reports')); await mkdir(join(target, 'reports')); await writeFile(join(target, 'reports', 'data'), 'restored');
    await prepare(home, source); await extensionTransitions(home).activate('testext', owner);
    expect(await readFile(join(target, 'reports', 'data'), 'utf8')).toBe('restored');
  });
  it('handles first install, validates ownership and identity, and rejects corrupt journal', async () => {
    const { home, source, target } = await setup(false); await prepare(home, source);
    await expect(extensionTransitions(home).prepare({ name: 'testext', owner: other, digest, directory: source })).rejects.toThrow();
    await expect(extensionTransitions(home).activate('testext', other)).rejects.toThrow();
    await extensionTransitions(home).activate('testext', owner);
    await extensionTransitions(home).rollback('testext', owner);
    await expect(readFile(join(target, 'code'))).rejects.toThrow();
    await writeFile(join(home, 'extensions', '.transition-testext.json'), '{');
    await expect(extensionTransitions(home).read('testext')).rejects.toThrow();
  });
});

it('blocks bootstrap extension migrations for a journal or a database gate', async () => {
  const { extensionMigrationSafety } = await import('../src/install/postgres.js');
  const { home, source } = await setup();
  const store = { async readExtensionQuiesce() { return { ok: true as const, owner: null, running: 0 }; } };
  await prepare(home, source);
  expect(await extensionMigrationSafety(home, ['testext'], store)).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  await extensionTransitions(home).rollback('testext', owner);
  expect(await extensionMigrationSafety(home, ['testext'], { async readExtensionQuiesce() { return { ok: true as const, owner, running: 0 }; } })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await extensionMigrationSafety(home, ['testext'], store)).toEqual({ ok: true });
});
