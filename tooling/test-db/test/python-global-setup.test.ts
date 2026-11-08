import { expect, it } from 'vitest';
import { preparePythonTestDatabase, type PythonSetupDependencies } from '../../../apps/cli/python-test/global-setup.js';
import type { SlotLease } from '../src/slots/lease.js';
const id = 'a'.repeat(64);
const lease: SlotLease = { runId: 'run', slotId: 'direct', fileId: 'direct', containerId: id, port: 32768, url: 'postgres://postgres:pw@127.0.0.1:32768/postgres' };
function harness(env: NodeJS.ProcessEnv = {}) {
  const calls: string[] = [], ledgers: unknown[] = [];
  const deps: PythonSetupDependencies = {
    env, repo: '/repo', pid: 12, runId: () => 'run', lookup: async () => 'start',
    validate: async path => { calls.push(`validate:${path}`); return lease; },
    create: async (runId, slotId) => { calls.push('create'); return { id, name: `brain-slot-${runId}-${slotId}-0`, runId, slotId, port: lease.port, url: lease.url }; },
    remove: async value => { calls.push(`remove:${value}`); },
    writeLedger: async (_repo, ledger) => { ledgers.push(JSON.parse(JSON.stringify(ledger))); },
    writeLease: async (path, value) => { calls.push(`lease:${path}`); expect(value).toEqual(lease); },
    removeLease: async path => { calls.push(`unlink:${path}`); },
  };
  return { deps, calls, ledgers, env };
}
it('validates and uses an existing lease without owning the container', async () => {
  const h = harness({ BRAIN_TEST_SLOT_LEASE: '/lease', BRAIN_TEST_DATABASE_URL: 'old' });
  expect(await preparePythonTestDatabase(h.deps)).toBeUndefined();
  expect(h.env.BRAIN_TEST_DATABASE_URL).toBe(lease.url); expect(h.calls).toEqual(['validate:/lease']);
  h.deps.validate = async () => { throw new Error('bad lease'); };
  await expect(preparePythonTestDatabase(h.deps)).rejects.toThrow('bad lease');
});
it('preserves a non-owned external URL including the compose port', async () => {
  const h = harness({ BRAIN_TEST_DATABASE_URL: 'postgres://u:p@127.0.0.1:54329/postgres' });
  expect(await preparePythonTestDatabase(h.deps)).toBeUndefined();
  expect(h.env.BRAIN_TEST_DATABASE_URL).toContain('54329'); expect(h.calls).toEqual([]);
});
it('owns a direct cluster and records removal without a compose fallback', async () => {
  const h = harness(), teardown = await preparePythonTestDatabase(h.deps);
  expect(h.calls).toEqual(['create', 'lease:/repo/.brain-test-runs/run.lease.json']);
  expect(h.env.BRAIN_TEST_SLOT_LEASE).toBe('/repo/.brain-test-runs/run.lease.json');
  expect(h.env.BRAIN_TEST_DATABASE_URL).toBe(lease.url); expect(h.env.BRAIN_TEST_RUN_ID).toBe('run'); expect(h.env.BRAIN_TEST_SLOT_ID).toBe('direct');
  await teardown!(); expect(h.calls).toContain(`remove:${id}`); expect(h.calls).toContain('unlink:/repo/.brain-test-runs/run.lease.json');
  expect(h.env.BRAIN_TEST_DATABASE_URL).toBeUndefined(); expect(JSON.stringify(h.ledgers)).toContain('removed');
});
it('propagates removal failure and records it while attempting lease cleanup', async () => {
  const h = harness(); h.deps.remove = async () => { throw new Error('docker unavailable'); };
  const teardown = await preparePythonTestDatabase(h.deps);
  await expect(teardown!()).rejects.toThrow('Python slot cleanup failed');
  expect(h.calls).toContain('unlink:/repo/.brain-test-runs/run.lease.json'); expect(JSON.stringify(h.ledgers)).toContain('docker unavailable');
});
it('cleans the created cluster if writing the lease fails', async () => {
  const h = harness(); h.deps.writeLease = async () => { throw new Error('write failed'); };
  await expect(preparePythonTestDatabase(h.deps)).rejects.toThrow('write failed'); expect(h.calls).toContain(`remove:${id}`);
});

it('skips a completed direct ledger and recovers a dead direct container', async () => {
  const { access, mkdtemp, rm, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { writeLedger, readLedger } = await import('../src/slots/ledger.js');
  const { recoverRuns } = await import('../src/python-slots.js');
  const root = await mkdtemp(join(tmpdir(), 'direct-recovery-'));
  try {
    const h = harness(); h.deps.repo = root; h.deps.writeLedger = writeLedger;
    const teardown = await preparePythonTestDatabase(h.deps);
    await teardown!();
    expect((await readLedger(root, 'run')).state).toBe('completed');
    const noDocker = async () => { throw new Error('completed ledger must not inspect Docker'); };
    const completed = await recoverRuns(root, noDocker, async () => null);
    expect(completed).toEqual([{ runId: 'run', state: 'completed', removed: [] }]);

    const dead = harness(); dead.deps.repo = root; dead.deps.runId = () => 'dead'; dead.deps.writeLedger = writeLedger; dead.deps.writeLease = async () => {};
    await preparePythonTestDatabase(dead.deps);
    const leasePath = join(root, '.brain-test-runs', 'dead.lease.json'); await writeFile(leasePath, 'lease');
    const fixtureId = 'b'.repeat(64), present = new Set([id, fixtureId]); const removed: string[] = [];
    const docker = async (args: string[]) => {
      if (args[0] === 'ps') return { stdout: args.includes('label=brain.fixture') ? (present.has(fixtureId) ? fixtureId : '') : [...present].join('\n') };
      if (args[0] === 'rm') { removed.push(args[2]!); present.delete(args[2]!); return { stdout: '' }; }
      if (args[0] === 'inspect' && args.at(-1) === 'brain-slot-dead-direct-0') return { stdout: JSON.stringify({ Id: id, Name: '/brain-slot-dead-direct-0', Config: { Labels: { 'brain.test-run': 'dead', 'brain.test-slot': 'direct' } } }) };
      if (args[0] === 'inspect' && args[2] === '{{json .}}' && args.at(-1) === fixtureId) return { stdout: JSON.stringify({ Id: fixtureId, Config: { Labels: { 'brain.test-run': 'dead', 'brain.fixture': 'fixture' } } }) };
      throw { code: 1, stderr: `Error: No such object: ${args.at(-1)}` };
    };
    const events = await recoverRuns(root, docker, async () => null);
    expect(events.some(event => (event as { state: string }).state === 'error')).toBe(false);
    expect(removed).toEqual([id, fixtureId]);
    expect((await readLedger(root, 'dead')).state).toBe('completed');
    await expect(access(leasePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await recoverRuns(root, noDocker, async () => null)).every(event => (event as { state: string }).state === 'completed')).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
});
