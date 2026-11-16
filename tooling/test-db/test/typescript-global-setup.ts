import { randomBytes } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestProject } from 'vitest/node';
import { lookupProcess, writeLedger, type Ledger } from '../src/slots/ledger.js';
import { validateExternalRun } from '../src/slots/external-contract.js';
import { recoverRuns } from '../src/python-slots.js';
import type { Docker } from '../src/slots/cluster.js';
import type { Lookup } from '../src/slots/ledger.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

type OwnershipOptions = { root?: string; env?: NodeJS.ProcessEnv; run?: Docker; lookup?: Lookup };
export async function prepareOwnership(project: TestProject, options: OwnershipOptions = {}): Promise<() => Promise<void>> {
  const { root = repo, env = process.env, run, lookup = lookupProcess } = options;
  if (env.BRAIN_TEST_RUN_ID) {
    // The coordinator records the spawned child immediately after spawn. Its
    // Vitest setup can race that atomic ledger write, so allow a bounded wait.
    let failure: unknown;
    for (let attempt = 0; attempt < 30; attempt++) {
      try { await validateExternalRun(root, env, lookup); failure = undefined; break; }
      catch (error) { failure = error; if (attempt < 29) await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    if (failure) throw new Error('external test run contract rejected', { cause: failure });
    project.provide('brainTestRunId', ''); return async () => {};
  }
  const recovery = await recoverRuns(root, run, lookup);
  process.stderr.write(`Test resource recovery: ${JSON.stringify(recovery)}\n`);
  const runId = randomBytes(12).toString('hex');
  const started = await lookup(process.pid);
  if (!started) throw new Error('cannot identify TypeScript test owner');
  const owner = { pid: process.pid, started };
  const ledger: Ledger = { runId, kind: 'typescript', state: 'running', coordinator: owner, slots: [], files: [], resources: [], cleanup: [{ recovery }] };
  await mkdir(join(root, '.brain-test-runs', runId, 'files'), { recursive: true });
  await writeLedger(root, ledger);
  project.provide('brainTestRunId', runId);
  return async () => {
    const result = await recoverRuns(root, run, lookup, runId, owner);
    process.stderr.write(`Test resource cleanup: ${JSON.stringify(result)}\n`);
    if (result.some(row => { const event = row as { state?: string; remaining?: string[] }; return event.state === 'error' || (event.remaining?.length ?? 0) > 0; })) throw new Error('TypeScript test resources quarantined');
  };
}
type Cleanup = () => void | Promise<void>;
type CloseState = { ownership: Cleanup[]; databases: Cleanup[] };
const closeKey = Symbol.for('brain.test-resource-close-state');
function closeState(project: TestProject): CloseState {
  const host = project.vitest as unknown as Record<symbol, CloseState | undefined>;
  if (host[closeKey]) return host[closeKey]!;
  const state: CloseState = { ownership: [], databases: [] }; host[closeKey] = state;
  project.vitest.onClose(async () => {
    const errors: unknown[] = [];
    for (const cleanup of state.ownership) try { await cleanup(); } catch (error) { errors.push(error); }
    // Projects share the test database; a quarantined user fences that database.
    if (!errors.length) for (const cleanup of state.databases) try { await cleanup(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'test resource cleanup failed');
  });
  return state;
}
export function registerDatabaseCleanup(project: TestProject, cleanup: Cleanup): void { closeState(project).databases.push(cleanup); }
export default async function setup(project: TestProject, options: OwnershipOptions = {}): Promise<void> {
  const state = closeState(project);
  state.ownership.push(await prepareOwnership(project, options));
}
