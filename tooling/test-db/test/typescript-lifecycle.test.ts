import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { lookupProcess } from '../src/slots/ledger.js';

it.each([false, true])('keeps the original ordinary temporary root under the actual file setup (nested=%s)', async nested => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'ordinary-temp-owner-')), output = join(dir, 'result.json');
  const original = join(dir, 'system-temp'), inherited = join(dir, 'parent-file'); await mkdir(original); await mkdir(inherited);
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: nested ? inherited : original, OWNERSHIP_TEST_OUTPUT: output, OWNERSHIP_OBSERVE_TEMP: '1' };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_FILE_DIR', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG', 'BRAIN_TEST_CASE_ID']) delete env[key];
  if (nested) { env.BRAIN_TEST_FILE_DIR = inherited; env.BRAIN_TEST_ORIGINAL_TMPDIR_SET = 'yes'; env.BRAIN_TEST_ORIGINAL_TMPDIR = original; }
  else { delete env.BRAIN_TEST_ORIGINAL_TMPDIR_SET; delete env.BRAIN_TEST_ORIGINAL_TMPDIR; }
  try {
    await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/ownership/vitest.config.ts'], { cwd: root, env, timeout: 30000 });
    const result = JSON.parse(await readFile(output, 'utf8')) as { runId: string; temp: { env: string; root: string; path: string; fileDir: string } };
    expect(result.temp.env).toBe(original); expect(result.temp.root).toBe(original);
    expect(relative(original, result.temp.path)).not.toMatch(/^\.\./); expect(result.temp.fileDir).not.toBe(original);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${result.runId}.json`), 'utf8')).state).toBe('completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 45000);

it('completes actual parent cleanup after a nested Python coordinator uses its own shared marker', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'nested-python-owner-')), output = join(dir, 'parent.json'), observation = join(dir, 'child.json');
  const env: NodeJS.ProcessEnv = { ...process.env, OWNERSHIP_TEST_OUTPUT: output, OWNERSHIP_NESTED_REPORT: join(dir, 'report.json'), BRAIN_SLOT_OWNERSHIP_OBSERVATION: observation };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_FILE_DIR', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG', 'BRAIN_TEST_CASE_ID']) delete env[key];
  try {
    await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/ownership/vitest.config.ts'], { cwd: root, env, timeout: 300000 });
    const parent = JSON.parse(await readFile(output, 'utf8')) as { runId: string; fileId: string; nestedRunId: string };
    const child = JSON.parse(await readFile(observation, 'utf8')) as { runId: string; fileId: string; fileDir: string; marker: string };
    expect(child.runId).toBe(parent.nestedRunId); expect(child.fileDir).toBe(join(root, '.brain-test-runs', child.runId, child.fileId)); expect(child.marker).toContain('"acquired"');
    await expect(readFile(join(root, '.brain-test-runs', parent.runId, parent.fileId, 'shared-db.jsonl'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${parent.runId}.json`), 'utf8')).state).toBe('completed');
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${child.runId}.json`), 'utf8')).state).toBe('completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 330000);

it('runs the actual Vitest setup writer and completes ownership only after its pool closes', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'actual-owner-')), output = join(dir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, OWNERSHIP_TEST_OUTPUT: output };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG']) delete env[key];
  try {
    const cli = join(root, 'node_modules/vitest/vitest.mjs');
    await promisify(execFile)(process.execPath, [cli, 'run', '--config', 'tooling/test-db/test/fixtures/ownership/vitest.config.ts'], { cwd: root, env, timeout: 30000 });
    const result = JSON.parse(await readFile(output, 'utf8')) as { runId: string; fileId: string; pid: number };
    const base = join(root, '.brain-test-runs', result.runId);
    const registration = JSON.parse(await readFile(join(base, 'files', `${result.fileId}.json`), 'utf8')) as { worker: { pid: number; started: string } };
    expect(registration.worker.pid).toBe(result.pid); expect(registration.worker.started).toBeTruthy();
    const guard = (await readFile(join(base, result.fileId, 'children.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line).state);
    expect(guard).toEqual(['begin', 'sealed']);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${result.runId}.json`), 'utf8')).state).toBe('completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 45000);
it('runs registered ownership cleanup even if a later global setup fails', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'setup-failed-')), output = join(dir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, OWNERSHIP_TEST_OUTPUT: output };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG']) delete env[key];
  try {
    await expect(promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/ownership/failing.config.ts'], { cwd: root, env, timeout: 30000 })).rejects.toThrow();
    const result = JSON.parse(await readFile(output, 'utf8')) as { brainTestRunId: string };
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${result.brainTestRunId}.json`), 'utf8')).state).toBe('completed');
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 45000);
it('attempts independent database teardown callbacks after an earlier callback fails', async () => {
  const { registerDatabaseCleanup } = await import('./typescript-global-setup.js');
  const callbacks: (() => Promise<void>)[] = [], calls: string[] = [];
  const project = { vitest: { onClose: (callback: () => Promise<void>) => callbacks.push(callback) } } as unknown as import('vitest/node').TestProject;
  registerDatabaseCleanup(project, () => { calls.push('first'); throw new Error('synthetic'); });
  registerDatabaseCleanup(project, () => { calls.push('second'); });
  await expect(callbacks[0]!()).rejects.toThrow('test resource cleanup failed');
  expect(calls).toEqual(['first', 'second']);
});

it('blocks the registered database cleanup when actual ownership recovery quarantines a child', async () => {
  const { default: setup, registerDatabaseCleanup } = await import('./typescript-global-setup.js');
  const root = await mkdtemp(join(tmpdir(), 'ownership-close-fence-'));
  const callbacks: (() => Promise<void>)[] = []; let runId = '', databaseRemoved = false;
  const project = { provide: (_key: string, value: string) => { runId = value; }, vitest: { onClose: (callback: () => Promise<void>) => callbacks.push(callback) } } as unknown as import('vitest/node').TestProject;
  try {
    await setup(project, { root, env: {}, lookup: async pid => pid === process.pid ? 'owner-start' : null, run: async () => ({ stdout: '' }) });
    registerDatabaseCleanup(project, () => { databaseRemoved = true; });
    const fileId = 'a'.repeat(20), base = join(root, '.brain-test-runs', runId), file = join(base, fileId);
    await mkdir(file);
    await writeFile(join(base, 'files', `${fileId}.json`), JSON.stringify({ fileId, worker: { pid: 2147483647, started: 'worker-start' } }));
    await writeFile(join(file, 'shared-db.jsonl'), '{"state":"used"}\n');
    await writeFile(join(file, 'children.jsonl'), '{"state":"begin"}\n{"state":"spawned"}\n');
    await expect(callbacks[0]!()).rejects.toThrow('test resource cleanup failed');
    expect(databaseRemoved).toBe(false);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${runId}.json`), 'utf8')).state).toBe('running');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('recovers a real fixture created by a worker after the worker exits', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'actual-fixture-owner-')), output = join(dir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, OWNERSHIP_TEST_OUTPUT: output, OWNERSHIP_LEAK_FIXTURE: '1', BRAIN_TEST_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/postgres' };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG', 'BRAIN_TEST_FILE_DIR']) delete env[key];
  try {
    await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/ownership/vitest.config.ts'], { cwd: root, env, timeout: 120000 });
    const result = JSON.parse(await readFile(output, 'utf8')) as { runId: string; fileId: string; pid: number; container: string; labels: Record<string, string> };
    expect(result.labels['brain.test-run']).toBe(result.runId);
    expect(result.labels['brain.test-file']).toBe(result.fileId);
    expect(result.labels['brain.fixture']).toMatch(/^[a-f0-9]{24}$/);
    const registration = JSON.parse(await readFile(join(root, '.brain-test-runs', result.runId, 'files', `${result.fileId}.json`), 'utf8')) as { worker: { pid: number; started: string } };
    expect(registration.worker.pid).toBe(result.pid);
    expect(await lookupProcess(result.pid)).not.toBe(registration.worker.started);
    expect(result.container).toMatch(/^[a-f0-9]{64}$/);
    const base = join(root, '.brain-test-runs', result.runId);
    const journal = await readFile(join(base, result.fileId, 'children.jsonl'), 'utf8');
    const children = journal.trim().split('\n').map(line => JSON.parse(line) as { state: string; token?: string; pid?: number });
    const groups = (await readFile(join(base, result.fileId, 'processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string; token: string; pid: number });
    expect(children.some(child => child.state === 'spawned' && groups.some(group => group.state === 'gone' && group.token === child.token))).toBe(true);
    expect(groups.filter(group => group.state === 'active').length).toBeGreaterThan(0);
    expect(groups.filter(group => group.state === 'gone')).toHaveLength(groups.filter(group => group.state === 'active').length);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${result.runId}.json`), 'utf8')).state).toBe('completed');
    await expect(promisify(execFile)('docker', ['inspect', result.container])).rejects.toThrow(/no such/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 150000);


it('records a real child call from the installed file setup', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'actual-child-writer-')), output = join(dir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, OWNERSHIP_TEST_OUTPUT: output, OWNERSHIP_WRITE_CHILD: '1' };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG', 'BRAIN_TEST_FILE_DIR']) delete env[key];
  try {
    await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/ownership/vitest.config.ts'], { cwd: root, env, timeout: 30000 });
    const result = JSON.parse(await readFile(output, 'utf8')) as { runId: string; fileId: string };
    const rows = (await readFile(join(root, '.brain-test-runs', result.runId, result.fileId, 'children.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string });
    expect(rows.some(row => row.state === 'spawned')).toBe(true);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 45000);

it('permits parent recovery after a real shared DB user and owned group finish', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url)), dir = await mkdtemp(join(tmpdir(), 'shared-owned-child-')), output = join(dir, 'result.json');
  const env: NodeJS.ProcessEnv = { ...process.env, OWNERSHIP_TEST_OUTPUT: output, OWNERSHIP_LEAK_FIXTURE: '1', OWNERSHIP_SHARED_TEST: '1', BRAIN_TEST_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/postgres' };
  for (const key of ['BRAIN_TEST_RUN_ID', 'BRAIN_TEST_FILE_ID', 'BRAIN_TEST_SLOT_ID', 'BRAIN_TEST_SLOT_LEASE', 'BRAIN_TEST_PG_RESOURCE_LOG', 'BRAIN_TEST_HOOK_RESOURCE_LOG', 'BRAIN_TEST_PROCESS_LOG', 'BRAIN_TEST_METRICS_LOG', 'BRAIN_TEST_FILE_DIR']) delete env[key];
  try {
    await promisify(execFile)(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'tooling/test-db/test/fixtures/ownership/vitest.config.ts'], { cwd: root, env, timeout: 120000 });
    const result = JSON.parse(await readFile(output, 'utf8')) as { runId: string; fileId: string; container: string };
    const base = join(root, '.brain-test-runs', result.runId);
    expect(await readFile(join(base, result.fileId, 'shared-db.jsonl'), 'utf8')).toContain('acquired');
    const groups = (await readFile(join(base, result.fileId, 'processes.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as { state: string; token: string });
    expect(groups.some(group => group.state === 'gone')).toBe(true);
    expect(JSON.parse(await readFile(join(root, '.brain-test-runs', `${result.runId}.json`), 'utf8')).state).toBe('completed');
    await expect(promisify(execFile)('docker', ['inspect', result.container])).rejects.toThrow(/no such/i);
  } finally { await rm(dir, { recursive: true, force: true }); }
}, 150000);
