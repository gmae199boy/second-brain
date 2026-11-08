import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { acquireLock } from '../src/slots/lock.js';

it('serializes hook lane owners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hook-lane-'));
  let first: Awaited<ReturnType<typeof acquireLock>> | undefined, second: Awaited<ReturnType<typeof acquireLock>> | undefined;
  try {
    first = await acquireLock('hook-lane', { pid: 10, started: 'first' }, 'one', { directory });
    let acquired = false;
    const pending = acquireLock('hook-lane', { pid: 11, started: 'second' }, 'two', { directory, timeoutMs: 10_000 }).then(lock => { acquired = true; return lock; });
    await new Promise(resolve => setTimeout(resolve, 150)); expect(acquired).toBe(false);
    await first.release(); second = await pending;
    expect(second.waitMs).toBeGreaterThan(0); expect(second.owner.runId).toBe('two');
    await second.release();
  } finally { await first?.release(); await second?.release(); await rm(directory, { recursive: true, force: true }); }
}, 30_000);

it('rejects occupied hook port, project and volume while surfacing Docker errors', async () => {
  const { hookResourcesAvailable } = await import('../../bootstrap/test/hook-resources.js');
  const { homeResources } = await import('../../../apps/cli/src/config/resources.js');
  const home = '/synthetic-hook-home', volume = homeResources(home).volume;
  const good = { status: 0, stdout: '', stderr: '' };
  const missing = { status: 1, stdout: '', stderr: `Error response from daemon: get ${volume}: no such volume` };
  const probe = (responses: typeof good[]) => () => responses.shift()!;
  expect(hookResourcesAvailable(home, probe([{ ...good, status: 2 }]))).toBe(false);
  expect(hookResourcesAvailable(home, probe([good, { ...good, stdout: 'container-id' }]))).toBe(false);
  expect(hookResourcesAvailable(home, probe([good, good, good]))).toBe(false);
  expect(hookResourcesAvailable(home, probe([good, good, missing]))).toBe(true);
  expect(() => hookResourcesAvailable(home, probe([good, { ...good, status: 1, stderr: 'permission denied' }]))).toThrow('project');
  expect(() => hookResourcesAvailable(home, probe([good, good, { ...good, status: 1, stderr: 'daemon unavailable' }]))).toThrow('volume');
});

it('reselects a conflicting home at most five times and removes rejected roots', async () => {
  const { selectHookRoot } = await import('../../bootstrap/test/hook-resources.js');
  let count = 0; const removed: string[] = [];
  const create = () => `root${++count}`, home = (root: string) => `${root}/home`;
  expect(selectHookRoot(create, () => count === 3, root => removed.push(root), home)).toEqual({ root: 'root3', home: 'root3/home' });
  expect(removed).toEqual(['root1', 'root2']); count = 0; removed.length = 0;
  expect(() => selectHookRoot(create, () => false, root => removed.push(root), home)).toThrow('5회');
  expect(count).toBe(5); expect(removed).toHaveLength(5);
});
it('records hook resources only when the runner supplies a log', async () => {
  const { recordHookResources } = await import('../../bootstrap/test/hook-resources.js');
  const writes: string[] = [];
  const append = ((...args: unknown[]) => { writes.push(String(args[1])); }) as typeof import('node:fs').appendFileSync;
  recordHookResources('/tmp/hook-home', {}, append); expect(writes).toHaveLength(0);
  recordHookResources('/tmp/hook-home', { BRAIN_TEST_HOOK_RESOURCE_LOG: '/tmp/hook.jsonl' }, append);
  expect(JSON.parse(writes[0]!)).toMatchObject({ home: '/tmp/hook-home', project: expect.any(String), volume: expect.any(String), port: expect.any(Number) });
});
