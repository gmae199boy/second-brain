import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, expect, inject } from 'vitest';
import { diagnoseTestFailure, setFailureProbe } from '../src/fixture-observability.js';
import { installChildGuard } from './child-guard.js';
import { configureFileTempDir } from './typescript-temp-dir.js';

declare module 'vitest' { export interface ProvidedContext { brainTestRunId: string } }

const runId = inject('brainTestRunId');
if (runId) {
  if (!/^[a-f0-9]{24}$/.test(runId)) throw new Error('invalid TypeScript test run identity');
  const repo = fileURLToPath(new URL('../../../', import.meta.url));
  const fileId = randomBytes(10).toString('hex');
  const runDir = join(repo, '.brain-test-runs', runId), fileDir = join(runDir, fileId);
  mkdirSync(fileDir, { recursive: false });
  const started = execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } }).trim();
  if (!started) throw new Error('cannot identify TypeScript test worker');
  writeFileSync(join(runDir, 'files', `${fileId}.json`), JSON.stringify({ fileId, file: expect.getState().testPath ?? null, worker: { pid: process.pid, started } }) + '\n', { flag: 'wx', mode: 0o600 });
  configureFileTempDir(process.env, expect.getState().testPath, repo, fileDir);
  process.env.BRAIN_TEST_RUN_ID = runId;
  process.env.BRAIN_TEST_FILE_ID = fileId;
  process.env.BRAIN_TEST_SLOT_ID = 'typescript';
  process.env.BRAIN_TEST_PG_RESOURCE_LOG = join(fileDir, 'resources.jsonl');
  process.env.BRAIN_TEST_HOOK_RESOURCE_LOG = join(fileDir, 'hook-resources.jsonl');
  process.env.BRAIN_TEST_FILE_DIR = fileDir;
  process.env.BRAIN_TEST_PROCESS_LOG = join(fileDir, 'processes.jsonl');
  process.env.BRAIN_TEST_METRICS_LOG = join(fileDir, 'fixture-events.jsonl');
  const sealChildren = installChildGuard(join(fileDir, 'children.jsonl'));
  afterAll(sealChildren);
}

if (!process.env.BRAIN_TEST_METRICS_LOG && process.env.BRAIN_TEST_PG_RESOURCE_LOG) process.env.BRAIN_TEST_METRICS_LOG = join(process.env.BRAIN_TEST_PG_RESOURCE_LOG, '..', 'fixture-events.jsonl');
beforeEach(({ task }) => {
  const names: string[] = []; let current: typeof task | undefined = task;
  while (current) { names.unshift(current.name); current = current.suite as typeof task | undefined; }
  process.env.BRAIN_TEST_CASE_ID = createHash('sha256').update(JSON.stringify([task.id, names])).digest('hex').slice(0, 20);
  setFailureProbe(() => task.result?.state === 'fail');
});
afterEach(async () => { try { await diagnoseTestFailure(); } finally { setFailureProbe(); delete process.env.BRAIN_TEST_CASE_ID; } });
