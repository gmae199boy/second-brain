import { join } from 'node:path';
import { readLedger, liveness, lookupProcess, type Lookup } from './ledger.js';
import { sampleProcesses, type Sampler } from './processes.js';

/** Existing run IDs are accepted only for a live coordinator and its actual child. */
export async function validateExternalRun(root: string, env: NodeJS.ProcessEnv, lookup: Lookup = lookupProcess, sample: Sampler = sampleProcesses): Promise<void> {
  const runId = env.BRAIN_TEST_RUN_ID, fileId = env.BRAIN_TEST_FILE_ID, slotId = env.BRAIN_TEST_SLOT_ID;
  if (!runId || !/^[a-zA-Z0-9_-]+$/.test(runId) || !fileId || !/^[a-f0-9]{20}$/.test(fileId) || !slotId || !/^[a-zA-Z0-9_-]+$/.test(slotId)) throw new Error('incomplete external test run contract');
  const fileDir = join(root, '.brain-test-runs', runId, fileId);
  if (env.BRAIN_TEST_FILE_DIR !== fileDir || env.BRAIN_TEST_PG_RESOURCE_LOG !== join(fileDir, 'resources.jsonl') || env.BRAIN_TEST_HOOK_RESOURCE_LOG !== join(fileDir, 'hook-resources.jsonl') || env.BRAIN_TEST_PROCESS_LOG !== join(fileDir, 'processes.jsonl') || env.BRAIN_TEST_METRICS_LOG !== join(fileDir, 'fixture-events.jsonl') || (slotId !== 'hook' && env.BRAIN_TEST_SLOT_LEASE !== join(fileDir, 'lease.json'))) throw new Error('invalid external test resource paths');
  const ledger = await readLedger(root, runId);
  if (ledger.runId !== runId || ledger.kind !== 'coordinator' || ledger.state !== 'running' || !ledger.coordinator || await liveness(ledger.coordinator, lookup) !== 'alive') throw new Error('external coordinator not alive');
  const file = ledger.files.find(value => (value as { fileId?: unknown })?.fileId === fileId) as { slotId?: string; pid?: number; pgid?: number; started?: string; resourceLog?: string; hookResourceLog?: string } | undefined;
  if (!file || file.slotId !== slotId || file.resourceLog !== env.BRAIN_TEST_PG_RESOURCE_LOG || (slotId === 'hook' && file.hookResourceLog !== env.BRAIN_TEST_HOOK_RESOURCE_LOG) || !Number.isInteger(file.pid) || file.pid! <= 1 || file.pgid !== file.pid || typeof file.started !== 'string' || !file.started || await liveness({ pid: file.pid!, started: file.started }, lookup) !== 'alive') throw new Error('external child identity unavailable');
  const rows = await sample(), byPid = new Map(rows.map(row => [row.pid, row]));
  if (byPid.get(file.pid!)?.started !== file.started || byPid.get(ledger.coordinator.pid)?.started !== ledger.coordinator.started || byPid.get(file.pid!)?.ppid !== ledger.coordinator.pid) throw new Error('external child identity mismatch');
  let current = process.pid; const seen = new Set<number>();
  while (current !== file.pid && current > 1 && !seen.has(current)) { seen.add(current); current = byPid.get(current)?.ppid ?? 0; }
  if (current !== file.pid) throw new Error('not a descendant of external coordinator child');
}
