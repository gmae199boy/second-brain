import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { validateExternalRun } from '../src/slots/external-contract.js';
import { writeLedger } from '../src/slots/ledger.js';
import type { ProcessSample } from '../src/slots/processes.js';

it('rejects a bare run ID and requires a live coordinator, matching file paths and descendant identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'external-contract-')), fileId = 'a'.repeat(20), runId = 'run', slotId = 'slot1';
  const dir = join(root, '.brain-test-runs', runId, fileId);
  const env = { BRAIN_TEST_RUN_ID: runId, BRAIN_TEST_FILE_ID: fileId, BRAIN_TEST_SLOT_ID: slotId, BRAIN_TEST_FILE_DIR: dir, BRAIN_TEST_PG_RESOURCE_LOG: join(dir, 'resources.jsonl'), BRAIN_TEST_HOOK_RESOURCE_LOG: join(dir, 'hook-resources.jsonl'), BRAIN_TEST_PROCESS_LOG: join(dir, 'processes.jsonl'), BRAIN_TEST_METRICS_LOG: join(dir, 'fixture-events.jsonl'), BRAIN_TEST_SLOT_LEASE: join(dir, 'lease.json') };
  const row = (pid: number, ppid: number, started: string): ProcessSample => ({ pid, ppid, pgid: 11, started, cpu: 0, time: '0:00' });
  try {
    await expect(validateExternalRun(root, { BRAIN_TEST_RUN_ID: runId })).rejects.toThrow('incomplete');
    await writeLedger(root, { runId, kind: 'coordinator', state: 'running', coordinator: { pid: 10, started: 'owner' }, slots: [], files: [{ fileId, slotId, resourceLog: env.BRAIN_TEST_PG_RESOURCE_LOG, pid: 11, pgid: 11, started: 'child' }], resources: [], cleanup: [] });
    const lookup = async (pid: number) => pid === 10 ? 'owner' : pid === 11 ? 'child' : null;
    const sample = async () => [row(10, 1, 'owner'), row(11, 10, 'child'), row(process.pid, 11, 'current')];
    await expect(validateExternalRun(root, env, lookup, sample)).resolves.toBeUndefined();
    for (const key of ['BRAIN_TEST_FILE_DIR', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG']) await expect(validateExternalRun(root, { ...env, [key]: '/parent/file' }, lookup, sample)).rejects.toThrow('paths');
    await expect(validateExternalRun(root, { ...env, BRAIN_TEST_SLOT_LEASE: '/invalid' }, lookup, sample)).rejects.toThrow('paths');
    await expect(validateExternalRun(root, env, async () => null, sample)).rejects.toThrow('coordinator');
    await expect(validateExternalRun(root, env, lookup, async () => [row(10, 1, 'owner'), row(11, 10, 'child'), row(process.pid, 1, 'current')])).rejects.toThrow('descendant');
  } finally { await rm(root, { recursive: true, force: true }); }
});
