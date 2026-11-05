import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
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
