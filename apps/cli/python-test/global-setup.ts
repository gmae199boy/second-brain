import { randomBytes } from 'node:crypto';
import { link, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createCluster, removeCluster, type Cluster } from '../../../tooling/test-db/src/slots/cluster.js';
import { lookupProcess, writeLedger, type Ledger } from '../../../tooling/test-db/src/slots/ledger.js';
import { validateSlotLease, type SlotLease } from '../../../tooling/test-db/src/slots/lease.js';

export interface PythonSetupDependencies {
  env: NodeJS.ProcessEnv;
  repo: string;
  pid: number;
  runId: () => string;
  lookup: (pid: number) => Promise<string | null>;
  validate: (path: string) => Promise<SlotLease>;
  create: (runId: string, slotId: string, generation: string) => Promise<Cluster>;
  remove: (id: string) => Promise<void>;
  writeLedger: (repo: string, ledger: Ledger) => Promise<void>;
  writeLease: (path: string, lease: SlotLease) => Promise<void>;
  removeLease: (path: string) => Promise<void>;
}
const defaults: PythonSetupDependencies = {
  env: process.env,
  repo: fileURLToPath(new URL('../../../', import.meta.url)),
  pid: process.pid,
  runId: () => randomBytes(12).toString('hex'),
  lookup: lookupProcess,
  validate: validateSlotLease,
  create: createCluster,
  remove: removeCluster,
  writeLedger,
  writeLease: async (path, lease) => {
    const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
    try {
      await writeFile(temp, JSON.stringify(lease) + '\n', { flag: 'wx', mode: 0o600 });
      await link(temp, path);
    } finally { await unlink(temp).catch(() => {}); }
  },
  removeLease: async path => { await unlink(path); },
};

export async function preparePythonTestDatabase(overrides: Partial<PythonSetupDependencies> = {}): Promise<(() => Promise<void>) | undefined> {
  const deps = { ...defaults, ...overrides }, env = deps.env;
  if (env.BRAIN_TEST_SLOT_LEASE) {
    const lease = await deps.validate(env.BRAIN_TEST_SLOT_LEASE);
    env.BRAIN_TEST_DATABASE_URL = lease.url;
    return undefined;
  }
  if (env.BRAIN_TEST_DATABASE_URL?.trim()) return undefined;

  const runId = deps.runId(), slotId = 'direct', started = await deps.lookup(deps.pid);
  if (!started) throw new Error('cannot identify Python test coordinator');
  const leasePath = join(deps.repo, '.brain-test-runs', `${runId}.lease.json`);
  const ledger: Ledger = { runId, kind: 'direct', state: 'running', coordinator: { pid: deps.pid, started }, slots: [{ slotId, generation: '0', name: `brain-slot-${runId}-${slotId}-0` }], files: [{ fileId: 'direct' }], resources: [], cleanup: [] };
  await deps.writeLedger(deps.repo, ledger);
  let cluster: Cluster | undefined, leaseWritten = false;
  const previous = { BRAIN_TEST_SLOT_LEASE: env.BRAIN_TEST_SLOT_LEASE, BRAIN_TEST_DATABASE_URL: env.BRAIN_TEST_DATABASE_URL, BRAIN_TEST_RUN_ID: env.BRAIN_TEST_RUN_ID, BRAIN_TEST_SLOT_ID: env.BRAIN_TEST_SLOT_ID };
  const cleanup = async (complete = true) => {
    const errors: unknown[] = [];
    if (cluster) {
      try { await deps.remove(cluster.id); ledger.cleanup.push({ resource: cluster.id, result: 'removed' }); }
      catch (error) { ledger.cleanup.push({ resource: cluster.id, result: 'error', error: String(error) }); errors.push(error); }
    }
    if (leaseWritten) {
      try { await deps.removeLease(leasePath); ledger.cleanup.push({ resource: 'lease', result: 'removed' }); }
      catch (error) { ledger.cleanup.push({ resource: 'lease', result: 'error', error: String(error) }); errors.push(error); }
    }
    if (complete && !errors.length) ledger.state = 'completed';
    try { await deps.writeLedger(deps.repo, ledger); } catch (error) { errors.push(error); }
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete env[key]; else env[key] = value; }
    if (errors.length) throw new AggregateError(errors, 'Python slot cleanup failed');
  };
  try {
    cluster = await deps.create(runId, slotId, '0');
    ledger.resources.push({ type: 'container', id: cluster.id, name: cluster.name, runId, slotId, port: cluster.port });
    await deps.writeLedger(deps.repo, ledger);
    const lease: SlotLease = { runId, slotId, fileId: 'direct', containerId: cluster.id, port: cluster.port, url: cluster.url };
    await deps.writeLease(leasePath, lease); leaseWritten = true;
    env.BRAIN_TEST_SLOT_LEASE = leasePath; env.BRAIN_TEST_DATABASE_URL = cluster.url; env.BRAIN_TEST_RUN_ID = runId; env.BRAIN_TEST_SLOT_ID = slotId;
    return cleanup;
  } catch (error) {
    try { await cleanup(false); } catch (cleanupError) { throw new AggregateError([error, cleanupError], 'Python slot setup and cleanup failed'); }
    throw error;
  }
}
export default async function setup(): Promise<(() => Promise<void>) | undefined> { return preparePythonTestDatabase(); }
