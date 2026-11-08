import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';
import { lookupProcess } from '../src/slots/ledger.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const config = 'tooling/test-db/test/fixtures/slot-runner/vitest.config.ts';
const fixture = (name: string) => `tooling/test-db/test/fixtures/slot-runner/${name}.fixture.ts`;
const exec = promisify(execFile);
interface FileRow { file: string; slot: string; generation: number; port?: number; reason: string; log?: string; missingCases?: string[]; completedCases?: number; expectedCases?: number; cases?: { pass: number; fail: number; skip: number }; cleanup: unknown[] }
interface JobRow extends FileRow { id: string; selectedCase?: string; filterName?: string; caseStatus?: string }
interface Report { policy?: { config: string; allowlist: { path: string; sha256: string }; files: string[]; cases: Record<string, { fullName: string; filterName: string }[]>; shardModes: Record<string, { shardMode: string; reason: string }>; collection: { status: string; file?: string; error?: string }; jobIds: string[] }; jobs: JobRow[]; signal?: string; runId: string; files: FileRow[]; cleanupErrors: string[]; quarantine: string[]; recovery: { runId: string; state: string; remaining?: string[] }[]; metrics?: { nodeCpuPeak: number; dockerCpuPeak: number; pgConnectionsPeak: number; errors: string[] } }
const id = () => `integration-${randomBytes(10).toString('hex')}`;
async function containers(runId: string): Promise<string[]> {
  const { stdout } = await exec('docker', ['ps', '-aq', '--no-trunc', '--filter', `label=brain.test-run=${runId}`], { cwd: root, timeout: 15_000 });
  return stdout.trim().split(/\s+/).filter(Boolean);
}
function launch(runId: string, report: string, files: string[], slots = 1, timeout = 30_000, extraEnv: NodeJS.ProcessEnv = {}, order?: string, metrics = false, shardAllowlist?: string) {
  const args = ['tooling/test-db/dist/python-slots.js', '--config', config, '--run-id', runId, '--slots', String(slots), '--file-timeout', String(timeout), '--report', report, ...(order ? ['--order', order] : []), ...(metrics ? ['--metrics'] : []), ...(shardAllowlist ? ['--shard-allowlist', shardAllowlist] : []), '--files', ...files.map(fixture)];
  const env = { ...process.env, ...extraEnv }; delete env.BRAIN_TEST_SLOT_LEASE; delete env.BRAIN_TEST_DATABASE_URL;
  const child = spawn(process.execPath, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; output: string }>((resolve, reject) => { child.once('error', reject); child.once('close', (code, signal) => resolve({ code, signal, output })); });
  return { child, done };
}
it('reports metrics for a held database connection and cleans the run', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-metrics-')), runId = id(), path = join(dir, 'report.json');
  try {
    const result = await launch(runId, path, ['hold-connection'], 1, 30_000, {}, undefined, true).done;
    expect(result.code, result.output).toBe(0);
    const metrics = (await readReport(path)).metrics!;
    for (const value of [metrics.nodeCpuPeak, metrics.dockerCpuPeak, metrics.pgConnectionsPeak]) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); }
    expect(metrics.pgConnectionsPeak).toBeGreaterThanOrEqual(1); expect(metrics.errors).toEqual([]); expect(await containers(runId)).toEqual([]);
  } finally { if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json')); await rm(dir, { recursive: true, force: true }); }
}, 600_000);
async function readReport(path: string): Promise<Report> { return JSON.parse(await readFile(path, 'utf8')) as Report; }
async function waitFor(path: string, done: Promise<unknown>): Promise<void> {
  let ended = false; void done.then(() => { ended = true; }, () => { ended = true; });
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !ended) { try { await readFile(path); return; } catch { await new Promise(resolve => setTimeout(resolve, 200)); } }
  throw new Error(`fixture did not become ready: ${path}`);
}
async function run(files: string[], slots = 1, timeout = 30_000, coordinateSentinel = false) {
  const dir = await mkdtemp(join(tmpdir(), 'slot-integration-')), runId = id(), path = join(dir, 'report.json');
  const order = join(dir, 'order.json');
  await writeFile(order, JSON.stringify({ files: files.map((name, index) => ({ file: fixture(name), wallMs: files.length - index })) }));
  const proc = launch(runId, path, files, slots, timeout, coordinateSentinel ? { BRAIN_SLOT_SENTINEL_MARKER: join(dir, 'sentinel-started') } : {}, order);
  try { const result = await proc.done; const report = await readReport(path); expect(await containers(runId)).toEqual([]); return { ...result, report, runId }; }
  finally {
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}
function row(report: Report, name: string): FileRow {
  const matches = report.files.filter(file => file.file === fixture(name)); expect(matches).toHaveLength(1); return matches[0]!;
}
function expectPorts(report: Report) { for (const file of report.files) { expect(file.port).toBeGreaterThan(0); expect([54329, 54320]).not.toContain(file.port); } }
it('runs concurrent fixtures and reuses clean slots', async () => {
  const result = await run(['pass-a', 'pass-b', 'sentinel', 'concurrent'], 2);
  expect(result.code, result.output).toBe(0); expect(result.report.files).toHaveLength(4);
  for (const name of ['pass-a', 'pass-b', 'sentinel', 'concurrent']) { const file = row(result.report, name); expect(file.reason).toBe('pass'); expect(file.cases?.pass).toBeGreaterThan(0); }
  expect(new Set(result.report.files.map(file => `${file.slot}:${file.generation}`)).size).toBeLessThan(4); expectPorts(result.report);
}, 600_000);
it('keeps failure and runs later files on fresh clusters and another slot', async () => {
  const result = await run(['fail', 'pass-a', 'sentinel', 'pass-b'], 2, 120_000, true);
  expect(result.code, result.output).toBe(1); const failed = row(result.report, 'fail'); expect(failed.reason).toBe('fail'); expect(failed.cases?.fail).toBeGreaterThan(0);
  for (const name of ['sentinel', 'pass-a', 'pass-b']) expect(row(result.report, name).reason).toBe('pass');
  expect(new Set(result.report.files.map(file => file.slot)).size).toBe(2);
  expect(row(result.report, 'sentinel').slot).toBe(failed.slot);
  expect(row(result.report, 'sentinel').generation).toBeGreaterThan(failed.generation);
  expect(row(result.report, 'pass-a').slot).not.toBe(failed.slot);
  const serial = await run(['fail', 'sentinel'], 1);
  expect(serial.code).toBe(1); expect(row(serial.report, 'sentinel').reason).toBe('pass');
  expect(row(serial.report, 'sentinel').slot).toBe(row(serial.report, 'fail').slot);
  expect(row(serial.report, 'sentinel').generation).toBeGreaterThan(row(serial.report, 'fail').generation);
  const fresh = await run(['sentinel']); expect(fresh.code, fresh.output).toBe(0);
}, 600_000);
it('times out, confirms child cleanup and continues with a fresh cluster', async () => {
  // Give Vitest time to start while the fixture itself waits far longer.
  const result = await run(['timeout', 'sentinel'], 1, 30_000);
  expect(result.code, result.output).toBe(1); expect(row(result.report, 'timeout').reason).toBe('timeout');
  expect(JSON.stringify(row(result.report, 'timeout').cleanup)).toContain('"processes":"gone"');
  expect(row(result.report, 'sentinel').reason).toBe('pass'); expect(row(result.report, 'sentinel').generation).toBeGreaterThan(row(result.report, 'timeout').generation);
}, 600_000);
it('discards a cluster with a leaked database and reports the cleanup failure', async () => {
  const result = await run(['leak', 'sentinel']);
  expect(result.code, result.output).toBe(1); expect(result.report.cleanupErrors.length).toBeGreaterThan(0);
  expect(row(result.report, 'sentinel').reason).toBe('pass'); expect(row(result.report, 'sentinel').generation).toBeGreaterThan(row(result.report, 'leak').generation);
}, 600_000);
it('stops a detached descendant or quarantines the slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-child-')), runId = id(), path = join(dir, 'report.json'), pidPath = join(dir, 'pid.json');
  let identity: { pid: number; started: string } | undefined;
  const proc = launch(runId, path, ['hang-child'], 1, 30_000, { BRAIN_SLOT_HANG_PID: pidPath });
  try {
    await waitFor(pidPath, proc.done); identity = JSON.parse(await readFile(pidPath, 'utf8')) as typeof identity;
    const result = await proc.done, report = await readReport(path);
    const alive = identity && await lookupProcess(identity.pid) === identity.started;
    expect(alive).toBe(false);
    if (result.code !== 0) expect(report.quarantine.length).toBeGreaterThan(0);
    expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if (identity && await lookupProcess(identity.pid).catch(() => null) === identity.started) { try { process.kill(identity.pid, 'SIGKILL'); } catch {} }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
async function recover(report: string): Promise<{ code: number | null; report: Report }> {
  const child = spawn(process.execPath, ['tooling/test-db/dist/python-slots.js', '--recover', '--report', report], { cwd: root, stdio: 'ignore' });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('close', value => resolve(value)); });
  return { code, report: await readReport(report) };
}
it.each([['SIGTERM', 143], ['SIGINT', 130]] as const)('handles %s and leaves no owned containers', async (signal, expectedExit) => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-term-')), runId = id(), path = join(dir, 'report.json'), marker = join(dir, 'started');
  const proc = launch(runId, path, ['timeout'], 1, 120_000, { BRAIN_SLOT_STARTED: marker });
  try {
    await waitFor(marker, proc.done); proc.child.kill(signal);
    const result = await proc.done; expect(result.code, result.output).toBe(expectedExit);
    expect((await readReport(path)).signal).toBe(signal); expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
it('recovers a SIGKILL run and a new run succeeds', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-kill-')), runId = id(), path = join(dir, 'report.json'), marker = join(dir, 'started'), recoveryPath = join(dir, 'recovery.json');
  const proc = launch(runId, path, ['timeout'], 1, 120_000, { BRAIN_SLOT_STARTED: marker });
  try {
    await waitFor(marker, proc.done); proc.child.kill('SIGKILL');
    expect((await proc.done).signal).toBe('SIGKILL');
    const result = await recover(recoveryPath);
    expect(result.code).toBe(0); expect(result.report.recovery.some(item => item.runId === runId && item.state === 'dead' && item.remaining?.length === 0)).toBe(true);
    expect(await containers(runId)).toEqual([]);
    const fresh = await run(['sentinel']); expect(fresh.code, fresh.output).toBe(0);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGKILL'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

const shardAllowlist = 'tooling/test-db/test/fixtures/slot-runner/shard-allowlist.json';
const duplicateAllowlist = 'tooling/test-db/test/fixtures/slot-runner/duplicate-shard-allowlist.json';
const caseNames = ['first independent case', 'case (a+b)? [x]', 'expanded case alpha', 'expanded case beta'];
it.each([1, 2])('runs each independent case exactly once with %i slots', async slots => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-shards-')), runId = id(), path = join(dir, 'report.json');
  const proc = launch(runId, path, ['independent-cases', 'sentinel'], slots, 120_000, { BRAIN_SLOT_CASE_MARKER_DIR: dir }, undefined, false, shardAllowlist);
  try {
    const result = await proc.done;
    expect(result.code, result.output).toBe(0);
    const report = await readReport(path);
    const jobs = report.jobs.filter(job => job.file === fixture('independent-cases'));
    expect(jobs).toHaveLength(caseNames.length);
    expect(jobs.map(job => job.id).sort()).toEqual(caseNames.map(name => `${fixture('independent-cases')}#${name}`).sort());
    expect(jobs.map(job => job.caseStatus)).toEqual(caseNames.map(() => 'passed'));
    const markers = (await readFile(join(dir, 'cases.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string);
    expect(markers.sort()).toEqual([...caseNames].sort());
    expect(row(report, 'independent-cases').cases).toEqual({ pass: caseNames.length, fail: 0, skip: 0 });
    expect(row(report, 'independent-cases').reason).toBe('pass');
    expect(row(report, 'sentinel').reason).toBe('pass');
    expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
it('rejects duplicate collected case names before allocating slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-duplicate-')), runId = id(), path = join(dir, 'report.json');
  const proc = launch(runId, path, ['duplicate-cases'], 1, 120_000, {}, undefined, false, duplicateAllowlist);
  try {
    const result = await proc.done;
    expect(result.code, result.output).toBe(1);
    expect(result.output).toContain('empty or duplicate case names');
    const report = await readReport(path);
    expect(report.cleanupErrors.join(' ')).toContain('empty or duplicate case names');
    expect(report.jobs).toEqual([]);
    expect(report.policy?.collection).toMatchObject({ status: 'failed', file: fixture('duplicate-cases'), error: expect.stringContaining('duplicate case names') });
    expect(report.policy?.config).toBe(config); expect(report.policy?.files).toEqual([fixture('duplicate-cases')]); expect(report.policy?.allowlist.path).toBe(duplicateAllowlist);
    const ledger = JSON.parse(await readFile(join(root, '.brain-test-runs', `${runId}.json`), 'utf8')) as { policy: Report['policy'] }; expect(ledger.policy?.collection).toEqual(report.policy?.collection);
    expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

const caseAllowlist = (name: string) => `tooling/test-db/test/fixtures/slot-runner/${name}-shard-allowlist.json`;
function selectedJob(report: Report, file: string, name: string): JobRow {
  const matches = report.jobs.filter(job => job.file === fixture(file) && job.selectedCase === name);
  expect(matches).toHaveLength(1); return matches[0]!;
}
it('preserves mixed shard results and reuses the failed slot for a sentinel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-mixed-')), runId = id(), path = join(dir, 'report.json'), order = join(dir, 'order.json');
  await writeFile(order, JSON.stringify({ files: [], jobs: [
    { id: `${fixture('mixed-cases')}#mixed fail`, wallMs: 100 },
    { id: `${fixture('mixed-cases')}#mixed pass`, wallMs: 90 },
    { id: fixture('sentinel'), wallMs: 80 },
    { id: `${fixture('mixed-cases')}#mixed expanded`, wallMs: 70 },
  ] }));
  const proc = launch(runId, path, ['mixed-cases', 'sentinel'], 2, 120_000, { BRAIN_SLOT_CASE_MARKER_DIR: dir, BRAIN_SLOT_SENTINEL_MARKER: join(dir, 'sentinel-started') }, order, false, caseAllowlist('mixed'));
  try {
    const result = await proc.done; expect(result.code, result.output).toBe(1);
    const report = await readReport(path), failed = selectedJob(report, 'mixed-cases', 'mixed fail'), summary = row(report, 'mixed-cases'), sentinel = row(report, 'sentinel');
    expect(failed.caseStatus).toBe('failed'); expect(selectedJob(report, 'mixed-cases', 'mixed pass').caseStatus).toBe('passed'); expect(selectedJob(report, 'mixed-cases', 'mixed expanded').caseStatus).toBe('passed');
    expect(summary.cases).toEqual({ pass: 2, fail: 1, skip: 0 }); expect(summary.reason).toBe('fail'); expect(summary.missingCases).toEqual([]);
    expect(summary.slot).toBe(failed.slot); expect(summary.generation).toBe(failed.generation); expect(summary.log).toBe(failed.log);
    expect(sentinel.reason).toBe('pass'); expect(sentinel.slot).toBe(failed.slot); expect(sentinel.generation).toBeGreaterThan(failed.generation);
    expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
it('retains a passing case when another shard times out', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-shard-timeout-')), runId = id(), path = join(dir, 'report.json');
  const proc = launch(runId, path, ['timeout-cases'], 2, 30_000, {}, undefined, false, caseAllowlist('timeout'));
  try {
    const result = await proc.done; expect(result.code, result.output).toBe(1);
    const report = await readReport(path), summary = row(report, 'timeout-cases');
    expect(selectedJob(report, 'timeout-cases', 'slow timeout').reason).toBe('timeout');
    expect(selectedJob(report, 'timeout-cases', 'quick pass').caseStatus).toBe('passed');
    expect(summary.reason).toBe('timeout'); expect(summary.cases?.pass).toBe(1); expect(summary.missingCases).toContain('slow timeout');
    expect(summary.completedCases).toBe(1); expect(summary.expectedCases).toBe(2); expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
it('executes nested names once and records the collection policy', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-nested-')), runId = id(), path = join(dir, 'report.json'), allowlist = caseAllowlist('nested');
  const proc = launch(runId, path, ['nested-cases'], 2, 120_000, { BRAIN_SLOT_CASE_MARKER_DIR: dir }, undefined, false, allowlist);
  try {
    const result = await proc.done; expect(result.code, result.output).toBe(0);
    const report = await readReport(path), suffixes = ['case a', 'case p', 'case q'];
    const markers = (await readFile(join(dir, 'nested.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string);
    expect(markers.sort()).toEqual([...suffixes].sort());
    const names = suffixes.map(name => ({ fullName: `outer suite inner (x) ${name}`, filterName: `outer suite > inner (x) > ${name}` }));
    for (const name of names) { const job = selectedJob(report, 'nested-cases', name.fullName); expect(job.filterName).toBe(name.filterName); expect(job.caseStatus).toBe('passed'); }
    expect(row(report, 'nested-cases').cases).toEqual({ pass: 3, fail: 0, skip: 0 });
    const policy = report.policy!;
    expect(policy.config).toBe(config); expect(policy.allowlist.path).toBe(allowlist);
    expect(policy.allowlist.sha256).toBe(createHash('sha256').update(await readFile(join(root, allowlist))).digest('hex'));
    expect(policy.files).toEqual([fixture('nested-cases')]); expect(policy.cases[fixture('nested-cases')]).toEqual(names);
    expect(policy.jobIds.sort()).toEqual(names.map(name => `${fixture('nested-cases')}#${name.fullName}`).sort());
    expect(policy.jobIds).toHaveLength(report.jobs.length); expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
it('runs forbidden conditional skip as a whole file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-shard-skip-')), runId = id(), path = join(dir, 'report.json');
  const proc = launch(runId, path, ['skip-cases'], 1, 120_000, {}, undefined, false, caseAllowlist('skip'));
  try {
    const result = await proc.done; expect(result.code, result.output).toBe(0); expect(result.output).toContain('forbidden-modifier-text');
    const report = await readReport(path); expect(report.jobs).toHaveLength(1); expect(report.jobs[0]?.id).toBe(fixture('skip-cases')); expect(row(report, 'skip-cases').cases).toEqual({ pass: 0, fail: 0, skip: 1 }); expect(report.policy?.shardModes[fixture('skip-cases')]).toEqual({ shardMode: 'file', reason: 'forbidden-modifier-text' }); expect(report.policy?.collection.status).toBe('complete'); expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);

it('runs later shard and sentinel on a fresh generation after timeout', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'slot-timeout-serial-')), runId = id(), path = join(dir, 'report.json'), order = join(dir, 'order.json');
  await writeFile(order, JSON.stringify({ files: [], jobs: [
    { id: `${fixture('timeout-cases')}#slow timeout`, wallMs: 100 },
    { id: `${fixture('timeout-cases')}#quick pass`, wallMs: 90 },
    { id: fixture('sentinel'), wallMs: 80 },
  ] }));
  const proc = launch(runId, path, ['timeout-cases', 'sentinel'], 1, 30_000, { BRAIN_SLOT_CASE_MARKER_DIR: dir, BRAIN_SLOT_SENTINEL_MARKER: join(dir, 'sentinel-ran') }, order, false, caseAllowlist('timeout'));
  try {
    const result = await proc.done; expect(result.code, result.output).toBe(1);
    const report = await readReport(path), slow = selectedJob(report, 'timeout-cases', 'slow timeout'), quick = selectedJob(report, 'timeout-cases', 'quick pass'), sentinel = row(report, 'sentinel');
    expect(slow.reason).toBe('timeout'); expect(quick.caseStatus).toBe('passed'); expect(sentinel.reason).toBe('pass');
    expect(report.jobs.map(job => job.id)).toEqual([slow.id, quick.id, fixture('sentinel')]);
    expect(quick.slot).toBe(slow.slot); expect(quick.generation).toBeGreaterThan(slow.generation);
    expect(sentinel.slot).toBe(slow.slot); expect(sentinel.generation).toBe(quick.generation);
    expect(await readFile(join(dir, 'quick-ran'), 'utf8')).toBe('yes'); expect(await readFile(join(dir, 'sentinel-ran'), 'utf8')).toBe('started');
    expect(await containers(runId)).toEqual([]);
  } finally {
    if (proc.child.exitCode === null && proc.child.signalCode === null) { proc.child.kill('SIGTERM'); await proc.done; }
    if ((await containers(runId)).length) await recover(join(dir, 'cleanup-recovery.json'));
    await rm(dir, { recursive: true, force: true });
  }
}, 600_000);
