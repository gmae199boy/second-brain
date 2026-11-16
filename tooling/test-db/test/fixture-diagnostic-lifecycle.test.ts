import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

it('diagnoses failed and timed-out tests before user afterEach drops the actual fixture', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'fixture-lifecycle-')), pointer = join(dir, 'pointer');
  const env: NodeJS.ProcessEnv = { ...process.env, DIAGNOSTIC_METRICS_POINTER: pointer, BRAIN_TEST_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/postgres' };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG']) delete env[key];
  try {
    const failure = await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/diagnostic-lifecycle/vitest.config.ts'], { cwd: root, env, timeout: 150000, maxBuffer: 1000000 }).then(() => null, error => error as { stdout?: string; stderr?: string });
    expect(failure).not.toBeNull(); expect(`${failure?.stdout ?? ''}${failure?.stderr ?? ''}`).toMatch(/timed out/i);
    const log = await readFile(pointer, 'utf8');
    const events = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { fixtureId: string; testId: string | null; phase: string });
    const diagnostics = events.filter(event => event.phase === 'test-failure-diagnostic');
    expect(diagnostics).toHaveLength(2); expect(new Set(diagnostics.map(event => event.testId)).size).toBe(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.testId).toMatch(/^[a-f0-9]{20}$/);
      const prior = events.indexOf(diagnostic), dropped = events.findIndex(event => event.fixtureId === diagnostic.fixtureId && event.phase === 'container-drop');
      expect(prior).toBeLessThan(dropped);
    }
    expect(JSON.stringify(events)).not.toMatch(/postgres:\/\/|brain-fixture-test|select /i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 180000);
