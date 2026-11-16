import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createIsolatedTestDatabase, createTestDatabase } from '../../../src/index.js';
import { ownedDocker } from '../../../src/slots/owned-command.js';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
it('exposes the real parent run and file registration', async () => {
  expect(process.env.BRAIN_TEST_RUN_ID).toMatch(/^[a-f0-9]{24}$/);
  expect(process.env.BRAIN_TEST_FILE_ID).toMatch(/^[a-f0-9]{20}$/);
  const db = process.env.OWNERSHIP_LEAK_FIXTURE ? await createIsolatedTestDatabase() : undefined;
  if (process.env.OWNERSHIP_SHARED_TEST && db) {
    process.env.BRAIN_TEST_DATABASE_URL = db.url;
    await createTestDatabase();
    await ownedDocker(['version', '--format', '{{.Client.Version}}']);
  }
  if (process.env.OWNERSHIP_WRITE_CHILD) spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  let nestedRunId: string | undefined;
  if (process.env.OWNERSHIP_NESTED_REPORT) {
    nestedRunId = `nested-${randomBytes(10).toString('hex')}`;
    const result = spawnSync(process.execPath, ['tooling/test-db/dist/python-slots.js', '--config', 'tooling/test-db/test/fixtures/slot-runner/vitest.config.ts', '--run-id', nestedRunId, '--slots', '1', '--report', process.env.OWNERSHIP_NESTED_REPORT, '--files', 'tooling/test-db/test/fixtures/slot-runner/pass-a.fixture.ts'], { encoding: 'utf8', timeout: 180000 });
    expect(result.status, result.stderr).toBe(0);
  }
  const labels = db?.fixtureContainer ? JSON.parse((await ownedDocker(['inspect', '--format', '{{json .Config.Labels}}', db.fixtureContainer.id])).stdout) as Record<string, string> : undefined;
  let temp: { env?: string; root: string; path: string; fileDir?: string } | undefined;
  if (process.env.OWNERSHIP_OBSERVE_TEMP) {
    const path = mkdtempSync(join(tmpdir(), 'ordinary-fixture-'));
    temp = { env: process.env.TMPDIR, root: tmpdir(), path, fileDir: process.env.BRAIN_TEST_FILE_DIR };
    rmSync(path, { recursive: true, force: true });
  }
  // Deliberately leave the owned fixture for the parent after pool.close().
  writeFileSync(process.env.OWNERSHIP_TEST_OUTPUT!, JSON.stringify({ runId: process.env.BRAIN_TEST_RUN_ID, fileId: process.env.BRAIN_TEST_FILE_ID, pid: process.pid, container: db?.fixtureContainer?.id, labels, nestedRunId, temp }));
}, 240000);
