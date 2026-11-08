import { CASE_SHARD_FILES, shardModeForSource, parseCollectedCases, casePattern, validateShardResult, aggregateShardCases, type CaseStatus, type CaseName } from './slots/case-shards.js';
import { spawn, execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { performance } from 'node:perf_hooks';
import { finished } from 'node:stream/promises';
import pg from 'pg';
import { checkClusterBoundary, createCluster, docker, inspectPort, isNoSuchObject, recoverCluster, removeCluster, type Cluster, type Docker } from './slots/cluster.js';
import { cleanupHookResources } from './slots/hook-compose.js';
import { ledgerPath, liveness, lookupProcess, readLedger, writeLedger, type Ledger, type Liveness, type Lookup } from './slots/ledger.js';
import { ProcessTracker, SharedProcessSampler, terminateGroup, type ProcessSample } from './slots/processes.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const defaultConfig = 'apps/cli/python-test/vitest.config.ts';
const hook = 'tooling/bootstrap/test/hook.test.ts';
export interface Options { config: string; slots: number; files?: string[]; timeout: number; report?: string; metrics: boolean; recover: boolean; runId?: string; order?: string; shardAllowlist?: string }
export function parseArgs(args: string[]): Options {
  const out: Options = { config: defaultConfig, slots: 4, timeout: 1_800_000, metrics: false, recover: false };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (seen.has(arg)) throw new Error(`duplicate option ${arg}`);
    seen.add(arg);
    if (arg === '--metrics') { out.metrics = true; continue; }
    if (arg === '--recover') { out.recover = true; continue; }
    if (arg === '--files') {
      const files: string[] = [];
      while (args[i + 1] && !args[i + 1]!.startsWith('--')) files.push(args[++i]!);
      if (!files.length || new Set(files).size !== files.length) throw new Error('invalid --files');
      out.files = files; continue;
    }
    if (!['--slots', '--file-timeout', '--report', '--run-id', '--order', '--config', '--shard-allowlist'].includes(arg)) throw new Error(`unknown argument ${arg}`);
    const value = args[++i]; if (!value || value.startsWith('--')) throw new Error(`missing value for ${arg}`);
    if (arg === '--slots' || arg === '--file-timeout') {
      if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || (arg === '--file-timeout' && Number(value) > 2_147_483_647)) throw new Error(`invalid ${arg}`);
      if (arg === '--slots') out.slots = Number(value); else out.timeout = Number(value);
    } else if (arg === '--config' || arg === '--shard-allowlist') {
      if (isAbsolute(value) || value.includes(':') || value.includes('\\') || value.split('/').some(part => part === '..' || part === '' || part === '.')) throw new Error('config must be a repository-relative path');
      if (arg === '--config') out.config = value; else out.shardAllowlist = value;
    } else if (arg === '--report') out.report = value;
    else if (arg === '--order') out.order = value;
    else { if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('invalid run ID'); out.runId = value; }
  }
  return out;
}
export function orderedFiles(files: string[], durations: Record<string, number> = {}): string[] {
  return [...files].sort((a, b) => (durations[b] ?? durations[b.split('#')[0]!] ?? 0) - (durations[a] ?? durations[a.split('#')[0]!] ?? 0) || a.localeCompare(b));
}
export function takeNext(queue: string[], quarantined: boolean, stopped: boolean): string | undefined { return quarantined || stopped ? undefined : queue.shift(); }
export function aggregateVitest(value: unknown): { pass: number; fail: number; skip: number } {
  if (!value || typeof value !== 'object') throw new Error('invalid Vitest report');
  const data = value as { numPassedTests?: unknown; numFailedTests?: unknown; numPendingTests?: unknown; numTodoTests?: unknown };
  const vals = [data.numPassedTests, data.numFailedTests, data.numPendingTests, data.numTodoTests ?? 0];
  if (vals.some(v => typeof v !== 'number' || !Number.isInteger(v) || v < 0)) throw new Error('invalid Vitest counts');
  return { pass: vals[0] as number, fail: vals[1] as number, skip: (vals[2] as number) + (vals[3] as number) };
}
export function fileReason(code: number | null, timedOut: boolean, interrupted: boolean): FileResult['reason'] { return timedOut ? 'timeout' : interrupted ? 'signal' : code === 0 ? 'pass' : 'fail'; }
export function reasonWithCases(reason: FileResult['reason'], cases: { fail: number }): FileResult['reason'] { return reason === 'pass' && cases.fail > 0 ? 'fail' : reason; }
export function parseManifest(value: unknown, root: string): string[] {
  if (!Array.isArray(value)) throw new Error('invalid manifest');
  return value.map(item => {
    const path: unknown = typeof item === 'string' ? item : item && typeof item === 'object' ? (item as { file?: unknown }).file : undefined;
    if (typeof path !== 'string' || !path) throw new Error('invalid manifest entry');
    const relative = path.startsWith(root) ? path.slice(root.length).replace(/^\//, '') : path;
    return relative.replace(/^\.\//, '');
  });
}
export function selectFiles(all: string[], selected?: string[]): string[] {
  const files = selected ?? all;
  if (!all.length || !files.length) throw new Error('empty test manifest or selection');
  return files;
}
export function exitStatus(failed: boolean, signal?: NodeJS.Signals): number { return signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : failed ? 1 : 0; }
export function mayRecover(status: Liveness): boolean { return status === 'dead'; }
export function markNotStarted(record: { processState?: string }, pid: number | undefined): boolean {
  if (pid !== undefined) return false;
  record.processState = 'notStarted'; return true;
}
export function metricVanished(error: unknown): boolean {
  const e = error as { code?: unknown; stderr?: unknown; message?: unknown } | null;
  return e?.code === 'ECONNREFUSED' || e?.code === 'ECONNRESET' || (typeof e?.message === 'string' && /connection terminated/i.test(e.message)) || (typeof e?.stderr === 'string' && /\bno such (container|object)\b/i.test(e.stderr));
}
export interface FileResult { file: string; id?: string; selectedCase?: string; filterName?: string; caseStatus?: CaseStatus; port?: number; slot: string; generation: number; start: string; end: string; wallMs: number; exit: number | null; signal: string | null; reason: 'pass' | 'fail' | 'timeout' | 'signal' | 'setup-error'; cases?: { pass: number; fail: number; skip: number }; log: string; cleanup: unknown[]; expectedCases?: number; completedCases?: number; missingCases?: string[]; jobWallSumMs?: number; jobIds?: string[]; logs?: { jobId: string; log: string }[] }
interface RunReport { runId: string; sha: string; start: string; end?: string; wallMs?: number; slots: number; files: FileResult[]; jobs: FileResult[]; quarantine: string[]; recovery: unknown[]; cleanupErrors: string[]; hookCleanup?: unknown[]; policy?: unknown; metrics?: unknown; environment?: unknown; signal?: string }
const reasonSeverity: FileResult['reason'][] = ['pass', 'fail', 'setup-error', 'signal', 'timeout'];
export function summarizeShard(file: string, names: CaseName[], jobs: FileResult[]): FileResult {
  const representative = jobs.reduce<FileResult | undefined>((worst, job) => !worst || reasonSeverity.indexOf(job.reason) > reasonSeverity.indexOf(worst.reason) ? job : worst, undefined);
  const missingCases = names.filter(name => !jobs.some(job => job.selectedCase === name.fullName && job.caseStatus !== undefined)).map(name => name.fullName);
  const statuses = jobs.flatMap(job => job.caseStatus ? [job.caseStatus] : []);
  const cases = { pass: statuses.filter(status => status === 'passed').length, fail: statuses.filter(status => status === 'failed').length, skip: statuses.filter(status => status === 'skipped').length };
  let reason = representative?.reason ?? 'fail';
  if ((missingCases.length || cases.fail) && reason === 'pass') reason = 'fail';
  const starts = jobs.map(job => job.start).filter(Boolean).sort(), ends = jobs.map(job => job.end).filter(Boolean).sort();
  const start = starts[0] ?? '', end = ends.at(-1) ?? '';
  return { file, slot: representative?.slot ?? '', generation: representative?.generation ?? 0, ...(representative?.port === undefined ? {} : { port: representative.port }), start, end, wallMs: start && end ? Math.max(0, Date.parse(end) - Date.parse(start)) : 0, jobWallSumMs: jobs.reduce((sum, job) => sum + job.wallMs, 0), exit: representative?.exit ?? null, signal: representative?.signal ?? null, reason, cases, expectedCases: names.length, completedCases: statuses.length, missingCases, jobIds: jobs.map(job => job.id!).filter(Boolean), logs: jobs.map(job => ({ jobId: job.id ?? job.file, log: job.log })), log: representative?.log ?? '', cleanup: jobs.flatMap(job => job.cleanup) };
}
async function listIds(runId: string, fileId?: string, run: Docker = docker): Promise<string[]> {
  const args = ['ps', '-aq', '--no-trunc', '--filter', `label=brain.test-run=${runId}`];
  if (fileId) args.push('--filter', `label=brain.test-file=${fileId}`);
  const ids = (await run(args)).stdout.split(/\s+/).filter(Boolean);
  if (ids.some(id => !/^[a-f0-9]{64}$/.test(id))) throw new Error('docker returned invalid full ID');
  return ids;
}
export async function recoverRuns(root: string, run: Docker = docker, lookup: Lookup = lookupProcess): Promise<unknown[]> {
  const dir = join(root, '.brain-test-runs'), events: unknown[] = [];
  let entries: string[];
  try { entries = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return events; throw error; }
  for (const entry of entries.filter(e => /^[a-zA-Z0-9_-]+\.json$/.test(e))) {
    const id = entry.slice(0, -5);
    try {
      const ledger = await readLedger(root, id);
      if (ledger.runId !== id || !ledger.coordinator || !Number.isInteger(ledger.coordinator.pid) || typeof ledger.coordinator.started !== 'string') throw new Error('invalid ledger identity');
      if (ledger.kind !== undefined && ledger.kind !== 'direct' && ledger.kind !== 'coordinator') throw new Error('invalid ledger kind');
      if (ledger.state !== undefined && ledger.state !== 'running' && ledger.state !== 'completed') throw new Error('invalid ledger state');
      if (ledger.state === 'completed') { events.push({ runId: id, state: 'completed', removed: [] }); continue; }
      const state = await liveness(ledger.coordinator, lookup);
      const event: { runId: string; state: string; removed: string[]; remaining?: string[]; hookCleanup?: unknown[] } = { runId: id, state, removed: [] }; events.push(event);
      if (!mayRecover(state)) continue;
      for (const slot of ledger.slots) {
        if (!slot || typeof slot !== 'object') continue;
        const recorded = slot as { name?: unknown; slotId?: unknown };
        if (typeof recorded.name !== 'string' || typeof recorded.slotId !== 'string') continue;
        const recovered = await recoverCluster(recorded.name, id, recorded.slotId, run);
        if (recovered && !ledger.resources.some(resource => !!resource && typeof resource === 'object' && (resource as { id?: unknown }).id === recovered)) {
          ledger.resources.push({ type: 'container', id: recovered, name: recorded.name, slotId: recorded.slotId });
          await writeLedger(root, ledger);
        }
      }
      for (const file of ledger.files) {
        if (!file || typeof file !== 'object') continue;
        const record = file as { fileId?: unknown; resourceLog?: unknown };
        if (typeof record.fileId !== 'string' || !/^[a-f0-9]{20}$/.test(record.fileId) || typeof record.resourceLog !== 'string') continue;
        const expected = join(root, '.brain-test-runs', id, record.fileId, 'resources.jsonl');
        if (record.resourceLog !== expected) continue;
        let lines: string;
        try { lines = await readFile(expected, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        const labeled = new Set(await listIds(id, record.fileId, run));
        for (const line of lines.split('\n').filter(Boolean)) {
          const item = JSON.parse(line) as { id?: unknown; name?: unknown; fixturePostgres?: unknown };
          let candidate = typeof item.id === 'string' ? item.id : undefined;
          if (!candidate && item.fixturePostgres === 'creating' && typeof item.name === 'string' && /^brain-fixture-[a-f0-9]{24}$/.test(item.name)) {
            try {
              const inspected = JSON.parse((await run(['inspect', '--format', '{{json .}}', item.name])).stdout) as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> } };
              if (inspected.Name?.replace(/^\//, '') !== item.name || inspected.Config?.Labels?.['brain.test-run'] !== id || inspected.Config?.Labels?.['brain.test-file'] !== record.fileId || inspected.Config?.Labels?.['brain.fixture'] !== item.name.slice('brain-fixture-'.length)) throw new Error('fixture recovery ownership mismatch');
              candidate = inspected.Id;
            } catch (error) { if (!isNoSuchObject(error, item.name)) throw error; }
          }
          if (!candidate || !labeled.has(candidate)) continue;
          if (!ledger.resources.some(resource => !!resource && typeof resource === 'object' && (resource as { id?: unknown }).id === candidate)) ledger.resources.push({ type: 'fixture-container', id: candidate, fileId: record.fileId });
        }
        await writeLedger(root, ledger);
      }
      for (const file of ledger.kind === 'direct' ? [] : ledger.files) {
        if (!file || typeof file !== 'object') throw new Error('invalid recorded child');
        const child = file as { pid?: unknown; pgid?: unknown; started?: unknown; processState?: unknown; descendants?: ProcessSample[] };
        if (child.processState === 'gone' || child.processState === 'notStarted') continue;
        if (!Number.isInteger(child.pid) || !Number.isInteger(child.pgid) || typeof child.started !== 'string') throw new Error('recorded child identity is unknown');
        const tracker = new ProcessTracker({ pid: child.pid as number, started: child.started });
        if (Array.isArray(child.descendants)) for (const descendant of child.descendants) {
          if (!Number.isInteger(descendant.pid) || typeof descendant.started !== 'string') throw new Error('invalid descendant identity');
          tracker.descendants.set(`${descendant.pid}:${descendant.started}`, descendant);
        }
        const state = await terminateGroup(child.pgid as number, tracker, { deadlineMs: 10_000 });
        if (state !== 'gone') throw new Error(`recorded child cleanup ${state}`);
      }
      for (const file of ledger.files) {
        const record = file as { fileId?: unknown; slotId?: unknown; hookResourceLog?: unknown };
        if (record?.slotId !== 'hook') continue;
        if (record.hookResourceLog === undefined) continue;
        if (typeof record.fileId !== 'string' || !/^[a-f0-9]{20}$/.test(record.fileId)) throw new Error('invalid hook file identity');
        const fileDir = join(root, '.brain-test-runs', id, record.fileId), path = join(fileDir, 'hook-resources.jsonl');
        if (record.hookResourceLog !== path) throw new Error('invalid hook resource log path');
        const hookCleanup = await cleanupHookResources(path, fileDir, run);
        (event.hookCleanup ??= []).push({ fileId: record.fileId, hookCleanup });
        ledger.cleanup.push({ hookCleanup, recovery: true }); await writeLedger(root, ledger);
      }
      const ids = await listIds(id, undefined, run);
      const owned = new Set(ledger.resources.flatMap(resource => {
        if (!resource || typeof resource !== 'object') return [];
        const value = (resource as { id?: unknown }).id; return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? [value] : [];
      }));
      if (ledger.kind === 'direct') {
        const fixtures = (await run(['ps', '-aq', '--no-trunc', '--filter', `label=brain.test-run=${id}`, '--filter', 'label=brain.fixture'])).stdout.split(/\s+/).filter(Boolean);
        for (const fixture of fixtures) {
          if (!/^[a-f0-9]{64}$/.test(fixture) || !ids.includes(fixture)) throw new Error('invalid direct fixture ID');
          const info = JSON.parse((await run(['inspect', '--format', '{{json .}}', fixture])).stdout) as { Id?: string; Config?: { Labels?: Record<string, string> } };
          if (info.Id !== fixture || info.Config?.Labels?.['brain.test-run'] !== id || !info.Config?.Labels?.['brain.fixture']) throw new Error('direct fixture ownership mismatch');
          owned.add(fixture);
        }
      }
      for (const container of ids) if (owned.has(container)) { await removeCluster(container, run); event.removed.push(container); }
      event.remaining = await listIds(id, undefined, run);
      if (!event.remaining.length) {
        if (ledger.kind === 'direct') await rm(join(dir, `${id}.lease.json`), { force: true });
        ledger.state = 'completed';
      }
      ledger.cleanup.push({ recovery: event, at: new Date().toISOString() }); await writeLedger(root, ledger);
    } catch (error) { events.push({ runId: id, state: 'error', error: String(error) }); }
  }
  return events;
}
async function manifest(config: string, signal: AbortSignal): Promise<string[]> {
  const env: NodeJS.ProcessEnv = { ...process.env, BRAIN_TEST_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/postgres' };
  delete env.BRAIN_TEST_SLOT_LEASE; delete env.BRAIN_TEST_RUN_ID; delete env.BRAIN_TEST_SLOT_ID; delete env.BRAIN_TEST_FILE_ID;
  const { stdout } = await exec('pnpm', ['exec', 'vitest', 'list', '--config', config, '--filesOnly', '--json'], { cwd: repo, env, maxBuffer: 20_000_000, timeout: 120_000, signal });
  let parsed: unknown;
  try { parsed = JSON.parse(stdout); } catch { throw new Error('invalid manifest JSON'); }
  return parseManifest(parsed, repo);
}
async function fingerprint(): Promise<Record<string, unknown>> {
  const cmd = async (command: string, args: string[]) => { try { return (await exec(command, args, { cwd: repo, timeout: 15_000 })).stdout.trim(); } catch (error) { return { error: String(error) }; } };
  const hash = async (path: string) => { try { return createHash('sha256').update(await readFile(join(repo, path))).digest('hex'); } catch (error) { return { error: String(error) }; } };
  const [sha, pnpm, vitest, python314, python312, pnpmLock, uvLock, image, dockerInfo] = await Promise.all([
    cmd('git', ['rev-parse', 'HEAD']), cmd('pnpm', ['--version']), cmd('pnpm', ['exec', 'vitest', '--version']), cmd('uv', ['python', 'find', '--no-python-downloads', '3.14.10']), cmd('uv', ['python', 'find', '--no-python-downloads', '3.12.13']), hash('pnpm-lock.yaml'), Promise.all(['extensions/garmin/uv.lock', 'plugins/garmin/package/uv.lock', 'apps/cli/test/fixtures/extensions/pyfixture/uv.lock'].map(async path => [path, await hash(path)])), cmd('docker', ['image', 'inspect', '--format', '{{.Id}}', 'postgres:18']), cmd('docker', ['info', '--format', '{{json .}}']),
  ]);
  return { node: process.version, sha, pnpm, vitest, python314, python312, pnpmLock, uvLock, image, dockerInfo };
}
interface Slot { id: string; generation: number; cluster?: Cluster; quarantined: boolean }
async function runCoordinator(options: Options): Promise<number> {
  const begin = performance.now(), start = new Date().toISOString(), runId = options.runId ?? randomBytes(12).toString('hex');
  const runDir = join(repo, '.brain-test-runs', runId), reportPath = options.report ? resolve(options.report) : options.recover ? join(repo, '.brain-test-runs', 'recovery', `${runId}.json`) : join(runDir, 'report.json');
  const report: RunReport = { runId, sha: '', start, slots: options.slots, files: [], jobs: [], quarantine: [], recovery: [], cleanupErrors: [] };
  const display = (value: string) => value.split(homedir()).join('~');
  process.stderr.write(`Python run ${runId}; report: ${display(reportPath)}\n`);
  let signal: NodeJS.Signals | undefined, failed = false, usageError = false, claimed = false;
  let notifySignal!: () => void;
  const interrupted = new Promise<'signal'>(resolvePromise => { notifySignal = () => resolvePromise('signal'); });
  const started = await lookupProcess(process.pid);
  if (!started) throw new Error('coordinator identity unavailable');
  const ledger: Ledger = { runId, kind: 'coordinator', state: 'running', coordinator: { pid: process.pid, started }, slots: [], files: [], resources: [], cleanup: [] };
  const trackers = new Map<number, ProcessTracker>();
  let nodeCpuPeak = 0;
  const processRecords = new Map<number, { descendants?: ProcessSample[] }>();
  const sampler = new SharedProcessSampler(undefined, () => {
    nodeCpuPeak = Math.max(nodeCpuPeak, [...trackers.values()].reduce((total, tracker) => total + tracker.currentCpu, 0));
    for (const [pid, tracker] of trackers) { const record = processRecords.get(pid); if (record) record.descendants = [...tracker.descendants.values()]; }
    if (trackers.size) void save().catch(e => error('process ledger', e));
  });
  const slots: Slot[] = [];
  let ledgerQueue = Promise.resolve();
  const save = () => { ledgerQueue = ledgerQueue.then(() => writeLedger(repo, ledger)); return ledgerQueue; };
  const error = (context: string, reason: unknown) => { failed = true; report.cleanupErrors.push(`${context}: ${String(reason)}`); };
  const manifestAbort = new AbortController();
  const onSignal = (s: NodeJS.Signals) => { signal ??= s; manifestAbort.abort(); notifySignal(); };
  const onInt = () => onSignal('SIGINT'), onTerm = () => onSignal('SIGTERM');
  process.on('SIGINT', onInt); process.on('SIGTERM', onTerm);
  let metricsTimer: ReturnType<typeof setInterval> | undefined;
  let metricsPending: Promise<void> | undefined;
  let metricBusy = false, boundaryInProgress = 0, dockerCpuPeak = 0, pgConnectionsPeak = 0, metricVanishedCount = 0, metricErrors: string[] = [];
  const metricsSample = async () => {
    if (metricBusy || boundaryInProgress) return;
    metricBusy = true;
    try {
      const ids = await listIds(runId);
      if (ids.length) {
        try {
          const output = (await docker(['stats', '--no-stream', '--format', '{{.CPUPerc}}', ...ids])).stdout;
          const values = output.trim().split(/\s+/).filter(Boolean).map(v => Number(v.replace('%', '')));
          if (values.some(v => !Number.isFinite(v))) throw new Error('invalid docker CPU');
          dockerCpuPeak = Math.max(dockerCpuPeak, values.reduce((a, b) => a + b, 0));
        } catch (e) { if (metricVanished(e)) metricVanishedCount++; else metricErrors.push(String(e)); }
      }
      let connections = 0;
      const urls = slots.flatMap(slot => slot.cluster ? [slot.cluster.url] : []);
      const fixtureIds = (await docker(['ps', '-aq', '--no-trunc', '--filter', `label=brain.test-run=${runId}`, '--filter', 'label=brain.fixture'])).stdout.split(/\s+/).filter(Boolean);
      for (const id of fixtureIds) {
        if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('invalid fixture container ID');
        try {
          const info = JSON.parse((await docker(['inspect', '--format', '{{json .}}', id])).stdout) as { Id?: string; State?: { Running?: boolean }; Config?: { Labels?: Record<string, string> }; NetworkSettings?: { Ports?: unknown } };
          if (info.Id !== id || info.Config?.Labels?.['brain.test-run'] !== runId || !info.Config?.Labels?.['brain.fixture']) throw new Error('fixture metrics ownership mismatch');
          if (!info.State?.Running) { metricVanishedCount++; continue; }
          const port = inspectPort(JSON.stringify(info.NetworkSettings?.Ports));
          urls.push(`postgres://postgres:brain-fixture-test@127.0.0.1:${port}/postgres`);
        } catch (e) { if (metricVanished(e)) metricVanishedCount++; else metricErrors.push(String(e)); }
      }
      for (const url of urls) {
        const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000, query_timeout: 1000 });
        try { await client.connect(); const result = await client.query("select count(*)::int as count from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()"); const count = Number(result.rows[0]?.count); if (!Number.isFinite(count)) throw new Error('invalid connection count'); connections += count; }
        catch (e) { if (metricVanished(e)) metricVanishedCount++; else metricErrors.push(String(e)); }
        finally { await client.end().catch(() => {}); }
      }
      pgConnectionsPeak = Math.max(pgConnectionsPeak, connections);
    } catch (e) { if (metricVanished(e)) metricVanishedCount++; else metricErrors.push(String(e)); } finally { metricBusy = false; }
  };
  const create = async (slot: Slot) => {
    ledger.slots.push({ slotId: slot.id, generation: slot.generation, name: `brain-slot-${runId}-${slot.id}-${slot.generation}` }); await save();
    const cluster = await createCluster(runId, slot.id, String(slot.generation));
    slot.cluster = cluster;
    ledger.resources.push({ type: 'container', id: cluster.id, name: cluster.name, slotId: slot.id, port: cluster.port }); await save();
  };
  const dispose = async (slot: Slot) => {
    if (!slot.cluster) return;
    const id = slot.cluster.id;
    try { await removeCluster(id); ledger.cleanup.push({ id, result: 'removed' }); slot.cluster = undefined; await save(); }
    catch (e) { slot.quarantined = true; report.quarantine.push(slot.id); error(`remove ${id}`, e); ledger.cleanup.push({ id, error: String(e) }); await save().catch(() => {}); }
  };
  const shardCases = new Map<string, CaseName[]>();
  const execute = async (id: string, slot: Slot | undefined): Promise<void> => {
    const split = id.indexOf('#'), file = split < 0 ? id : id.slice(0, split), selectedCase = split < 0 ? undefined : id.slice(split + 1);
    const selected = selectedCase === undefined ? undefined : shardCases.get(file)?.find(row => row.fullName === selectedCase);
    const fileId = randomBytes(10).toString('hex'), lane = slot?.id ?? 'hook', gen = slot?.generation ?? 0;
    const fileDir = join(runDir, fileId), resultPath = join(fileDir, 'vitest.json'), logPath = join(fileDir, 'output.log'), leasePath = join(fileDir, 'lease.json'), resourceLog = join(fileDir, 'resources.jsonl'), hookResourceLog = join(fileDir, 'hook-resources.jsonl');
    const result: FileResult = { file, id, ...(selectedCase === undefined ? {} : { selectedCase, filterName: selected?.filterName }), ...(slot?.cluster ? { port: slot.cluster.port } : {}), slot: lane, generation: gen, start: new Date().toISOString(), end: '', wallMs: 0, exit: null, signal: null, reason: 'setup-error', log: join('.brain-test-runs', runId, fileId, 'output.log'), cleanup: [] };
    let fileRecord: { file: string; jobId: string; selectedCase?: CaseName; fileId: string; slotId: string; generation: number; log: string; resourceLog: string; hookResourceLog?: string; pid?: number; pgid?: number; started?: string; processState?: string; descendants?: ProcessSample[] } | undefined;
    const startMs = performance.now(); let timedOut = false, tracker: ProcessTracker | undefined, pid: number | undefined, unsubscribe: (() => void) | undefined, log: ReturnType<typeof createWriteStream> | undefined;
    try {
      await mkdir(fileDir, { recursive: false });
      const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: fileDir, BRAIN_TEST_PG_RESOURCE_LOG: resourceLog, BRAIN_TEST_RUN_ID: runId, BRAIN_TEST_SLOT_ID: lane, BRAIN_TEST_FILE_ID: fileId };
      delete env.BRAIN_TEST_SLOT_LEASE; delete env.BRAIN_TEST_HOOK_RESOURCE_LOG;
      if (slot?.cluster) {
        env.BRAIN_TEST_DATABASE_URL = slot.cluster.url; env.BRAIN_TEST_SLOT_LEASE = leasePath;
        await writeFile(leasePath, JSON.stringify({ runId, slotId: lane, fileId, url: slot.cluster.url, containerId: slot.cluster.id, port: slot.cluster.port }), { flag: 'wx', mode: 0o600 });
      } else { env.BRAIN_TEST_DATABASE_URL = 'postgres://unused:unused@127.0.0.1:1/postgres'; env.BRAIN_TEST_HOOK_RESOURCE_LOG = hookResourceLog; }
      fileRecord = { file, jobId: id, ...(selected ? { selectedCase: selected } : {}), fileId, slotId: lane, generation: gen, log: logPath, resourceLog, ...(slot ? {} : { hookResourceLog }) };
      ledger.files.push(fileRecord); await save();
      log = createWriteStream(logPath, { flags: 'wx' });
      const logDone = finished(log).then(() => undefined, (reason: unknown) => reason);
      const child = spawn('pnpm', ['exec', 'vitest', 'run', '--config', options.config, file, ...(selected === undefined ? [] : ['-t', casePattern(selected.filterName)]), '--reporter=default', '--reporter=json', `--outputFile=${resultPath}`], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
      const completion = new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolvePromise, reject) => { child.once('error', reject); child.once('close', (code, sig) => resolvePromise({ code, sig })); });
      void completion.catch(() => {});
      pid = child.pid;
      if (!pid) throw new Error('child PID unavailable');
      const identity = await lookupProcess(pid);
      if (!identity) throw new Error('child identity unavailable');
      tracker = new ProcessTracker({ pid, started: identity }); trackers.set(pid, tracker); unsubscribe = sampler.subscribe(tracker);
      fileRecord.pid = pid; fileRecord.pgid = pid; fileRecord.started = identity; processRecords.set(pid, fileRecord); await save();
      await sampler.sample();
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<'timeout'>(resolvePromise => { timeoutHandle = setTimeout(() => resolvePromise('timeout'), options.timeout); });
      const outcome = await Promise.race([completion, timeout, interrupted]);
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (outcome === 'timeout' || outcome === 'signal') { timedOut = outcome === 'timeout'; const termination = await terminateGroup(pid, tracker, { deadlineMs: 10_000 }); result.cleanup.push({ processes: termination }); if (termination === 'gone' && fileRecord) { fileRecord.processState = 'gone'; await save(); } if (termination !== 'gone') { error(`${file} descendants`, termination); if (slot) slot.quarantined = true; } }
      const ended = typeof outcome === 'string' ? await Promise.race([completion, new Promise<undefined>(resolvePromise => setTimeout(() => resolvePromise(undefined), 1000))]) : outcome;
      result.exit = ended?.code ?? null; result.signal = ended?.sig ?? null;
      if (typeof outcome !== 'string') { const termination = await terminateGroup(pid, tracker, { deadlineMs: 10_000 }); result.cleanup.push({ processes: termination }); if (termination === 'gone' && fileRecord) { fileRecord.processState = 'gone'; await save(); } if (termination !== 'gone') { if (slot) slot.quarantined = true; error(`${file} descendants`, termination); } }
      log.end();
      const logError = await logDone; if (logError) throw logError;
      result.reason = fileReason(result.exit, timedOut, Boolean(signal));
      try { const data: unknown = JSON.parse(await readFile(resultPath, 'utf8')); if (selectedCase !== undefined) { result.caseStatus = validateShardResult(data, selected!, shardCases.get(file)!); result.cases = aggregateShardCases([result.caseStatus], 1); } else result.cases = aggregateVitest(data); result.reason = reasonWithCases(result.reason, result.cases); }
      catch (e) { if (result.reason === 'pass') { result.reason = 'fail'; error(`${file} report`, e); } }
    } catch (e) {
      error(`${file} setup`, e); result.cleanup.push({ setupError: String(e) });
      if (fileRecord && markNotStarted(fileRecord, pid)) await save().catch(saveError => error(`${file} notStarted ledger`, saveError));
      if (pid && tracker) { const status = await terminateGroup(pid, tracker, { deadlineMs: 10_000 }); result.cleanup.push({ processes: status }); if (status === 'gone' && fileRecord) { fileRecord.processState = 'gone'; await save().catch(() => {}); } if (status !== 'gone' && slot) slot.quarantined = true; }
      else if (pid && slot) slot.quarantined = true;
    } finally {
      if (log && !log.destroyed && !log.writableEnded) log.end();
      if (unsubscribe) unsubscribe(); if (pid) { trackers.delete(pid); processRecords.delete(pid); }
      if (!slot && fileRecord) {
        try { if (pid && fileRecord.processState !== 'gone') throw new Error('hook child termination unconfirmed'); const hookCleanup = await cleanupHookResources(hookResourceLog, fileDir); result.cleanup.push({ hookCleanup }); ledger.cleanup.push({ fileId, hookCleanup }); await save(); }
        catch (e) { result.cleanup.push({ hookCleanupError: String(e) }); ledger.cleanup.push({ fileId, hookCleanupError: String(e) }); error(`${file} hook cleanup`, e); }
      }
      try {
        const fixtures = await listIds(runId, fileId);
        for (const id of fixtures) { ledger.resources.push({ type: 'fixture-container', id, fileId }); await save(); await removeCluster(id); }
        const remaining = await listIds(runId, fileId);
        result.cleanup.push({ fixturesRemoved: fixtures, remaining });
        if (remaining.length) throw new Error(`fixture containers remain: ${remaining.join(', ')}`);
        if (fixtures.length && result.reason === 'pass') { error(`${file} leaked fixture containers`, fixtures.join(',')); result.reason = 'fail'; }
      } catch (e) { error(`${file} fixtures`, e); if (slot) slot.quarantined = true; }
      if (slot?.cluster) {
        boundaryInProgress++;
        while (metricBusy) await new Promise(resolvePromise => setTimeout(resolvePromise, 20));
        try { const boundary = await checkClusterBoundary(slot.cluster.url); result.cleanup.push({ boundary }); if (!boundary.clean) { if (result.reason === 'pass') error(`${file} boundary`, JSON.stringify(boundary)); result.reason = result.reason === 'pass' ? 'fail' : result.reason; } }
        catch (e) { error(`${file} boundary`, e); slot.quarantined = true; }
        finally { boundaryInProgress--; }
      }
      await rm(leasePath, { force: true }).catch(e => { error(`${file} lease`, e); if (slot) slot.quarantined = true; });
      result.end = new Date().toISOString(); result.wallMs = performance.now() - startMs; report.jobs.push(result); if (selectedCase === undefined) report.files.push(result);
      const counts = result.cases ? `${result.cases.pass}/${result.cases.fail}/${result.cases.skip}` : '-/-/-';
      process.stderr.write(`${display(id)} | ${lane} | ${result.reason} | ${result.wallMs.toFixed(0)}ms | pass/fail/skip ${counts}\n`);
      if (result.reason !== 'pass') failed = true;
      if (slot && (result.reason !== 'pass' || slot.quarantined)) { await dispose(slot); if (!slot.quarantined && !signal) slot.generation++; }
      if (slot?.quarantined && !report.quarantine.includes(slot.id)) report.quarantine.push(slot.id);
    }
  };
  try {
    report.recovery = await recoverRuns(repo);
    if (report.recovery.some(item => { const row = item as { state?: string; remaining?: string[] }; return row.state === 'error' || (row.remaining?.length ?? 0) > 0; })) failed = true;
    if (!options.recover) {
      await mkdir(join(repo, '.brain-test-runs'), { recursive: true });
      await mkdir(runDir, { recursive: false });
      await writeFile(ledgerPath(repo, runId), JSON.stringify(ledger) + '\n', { flag: 'wx', mode: 0o600 });
      claimed = true;
      const all = await manifest(options.config, manifestAbort.signal);
      if (new Set(all).size !== all.length) throw new Error('duplicate manifest paths');
      const files = selectFiles(all, options.files);
      const missing = files.filter(file => !all.includes(file));
      if (missing.length) { usageError = true; throw new Error(`unknown files: ${missing.join(', ')}`); }
      const allowlistContent = options.shardAllowlist ? await readFile(join(repo, options.shardAllowlist), 'utf8') : JSON.stringify(CASE_SHARD_FILES);
      const allowlist: unknown = JSON.parse(allowlistContent);
      if (!Array.isArray(allowlist)) throw new Error('invalid shard allowlist');
      const allowed = allowlist.map(item => typeof item === 'string' ? item : item?.file);
      if (allowed.some(path => typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.includes(':') || path.split('/').some((part: string) => !part || part === '.' || part === '..')) || new Set(allowed).size !== allowed.length || allowed.includes(hook)) throw new Error('invalid shard allowlist');
      const policy: { config: string; allowlist: { path: string; sha256: string }; files: string[]; cases: Record<string, CaseName[]>; shardModes: Record<string, { shardMode: 'case' | 'file'; reason: string }>; jobIds: string[]; collection: { status: 'pending' | 'complete' | 'failed'; file?: string; error?: string } } = {
        config: options.config, allowlist: { path: options.shardAllowlist ?? 'CASE_SHARD_FILES', sha256: createHash('sha256').update(allowlistContent).digest('hex') }, files: [...files], cases: {}, shardModes: Object.fromEntries(files.filter(file => !allowed.includes(file)).map(file => [file, { shardMode: 'file', reason: 'not-allowlisted' }])), jobIds: [], collection: { status: 'pending' },
      };
      report.policy = policy; ledger.policy = policy; await save();
      for (const file of files.filter(path => allowed.includes(path))) {
        try {
          const mode = shardModeForSource(await readFile(join(repo, file), 'utf8'));
          policy.shardModes[file] = mode;
          if (mode.shardMode === 'file') {
            process.stderr.write(`${display(file)}: shard disabled (${mode.reason}); running whole file\n`);
            await save();
            continue;
          }
          const id = randomBytes(10).toString('hex'), output = join(runDir, `collect-${id}.json`), log = join(runDir, `collect-${id}.log`), tmp = join(runDir, `collect-${id}`, 'tmp');
          await mkdir(tmp, { recursive: true });
          const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp, BRAIN_TEST_DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/postgres' };
          delete env.BRAIN_TEST_SLOT_LEASE; delete env.BRAIN_TEST_RUN_ID; delete env.BRAIN_TEST_SLOT_ID; delete env.BRAIN_TEST_FILE_ID;
          try {
            const result = await exec('pnpm', ['exec', 'vitest', 'run', '--config', options.config, file, '-t', '(?!)', '--reporter=json', `--outputFile=${output}`], { cwd: repo, env, timeout: 120_000, signal: manifestAbort.signal, maxBuffer: 20_000_000 });
            await writeFile(log, result.stdout + result.stderr);
          } catch (e) { const failure = e as { stdout?: string; stderr?: string }; await writeFile(log, (failure.stdout ?? '') + (failure.stderr ?? '') + String(e)); throw e; }
          finally { try { await rm(tmp, { recursive: true, force: true }); } catch (e) { error(`${file} collection temporary directory cleanup`, e); throw e; } }
          const cases = parseCollectedCases(JSON.parse(await readFile(output, 'utf8')));
          shardCases.set(file, cases); policy.cases[file] = cases; await save();
        } catch (e) {
          policy.collection = { status: 'failed', file, error: String(e) }; await save(); throw e;
        }
      }
      policy.jobIds = files.flatMap(file => shardCases.has(file) ? shardCases.get(file)!.map(name => `${file}#${name.fullName}`) : [file]);
      policy.collection = { status: 'complete' }; await save();
      let durations: Record<string, number> = {};
      if (options.order) {
        const prior = JSON.parse(await readFile(resolve(options.order), 'utf8')) as { files?: { file: string; wallMs: number }[]; jobs?: { id?: string; wallMs: number }[] };
        if (!Array.isArray(prior.files)) throw new Error('invalid order report');
        durations = Object.fromEntries(prior.files.filter(row => typeof row.file === 'string' && typeof row.wallMs === 'number' && Number.isFinite(row.wallMs)).map(row => [row.file, row.wallMs]));
        for (const job of prior.jobs ?? []) if (typeof job.id === 'string' && Number.isFinite(job.wallMs)) durations[job.id] = job.wallMs;
      }
      report.environment = await fingerprint();
      const sha = (report.environment as { sha?: unknown }).sha; report.sha = typeof sha === 'string' ? sha : '';
      const queue = orderedFiles(files.filter(file => file !== hook).flatMap(file => shardCases.has(file) ? shardCases.get(file)!.map(name => `${file}#${name.fullName}`) : [file]), durations);
      sampler.start();
      if (options.metrics) { metricsTimer = setInterval(() => { if (!metricsPending) metricsPending = metricsSample().finally(() => { metricsPending = undefined; }); }, 1000); }
      const workers: Slot[] = Array.from({ length: Math.min(options.slots, queue.length) }, (_, index) => ({ id: `slot${index + 1}`, generation: 0, quarantined: false } satisfies Slot));
      slots.push(...workers);
      await Promise.all([
        ...workers.map(async slot => {
          while (!signal && !slot.quarantined && queue.length) {
            try { if (!slot.cluster) await create(slot); }
            catch (e) { error(`${slot.id} creation`, e); slot.quarantined = true; report.quarantine.push(slot.id); break; }
            if (signal) break;
            const file = takeNext(queue, slot.quarantined, Boolean(signal)); if (!file) break;
            await execute(file, slot);
          }
        }),
        ...(files.includes(hook) ? [(async () => { if (!signal) await execute(hook, undefined); })()] : []),
      ]);
      for (const [file, names] of shardCases) {
        const jobs = report.jobs.filter(row => row.file === file);
        const summary = summarizeShard(file, names, jobs);
        report.files.push(summary);
        const reason = summary.reason;
        if (reason !== 'pass') failed = true;
        process.stderr.write(`${display(file)} | file summary | ${reason} | cases ${jobs.length}/${names.length}\n`);
      }
      if (queue.length) { failed = true; report.cleanupErrors.push(`unassigned files: ${queue.join(', ')}`); }
    }
  } catch (e) { error('coordinator', e); }
  finally {
    if (metricsTimer) clearInterval(metricsTimer);
    await metricsPending;
    sampler.stop();
    for (const slot of slots) await dispose(slot);
    if (claimed) {
      for (const file of ledger.files) {
        const record = file as { fileId?: string; slotId?: string; hookResourceLog?: string; pid?: number; processState?: string };
        if (record.slotId !== 'hook' || !record.fileId || !record.hookResourceLog) continue;
        try { if (record.pid && record.processState !== 'gone') throw new Error('hook child termination unconfirmed'); const hookCleanup = await cleanupHookResources(record.hookResourceLog, join(runDir, record.fileId)); const entry = { fileId: record.fileId, finalHookCleanup: hookCleanup }; ledger.cleanup.push(entry); (report.hookCleanup ??= []).push(entry); }
        catch (e) { error('final hook cleanup', e); ledger.cleanup.push({ fileId: record.fileId, hookCleanupError: String(e) }); }
      }
      try { const remaining = await listIds(runId); ledger.cleanup.push({ finalContainers: remaining }); if (remaining.length) error('remaining run containers', remaining.join(',')); }
      catch (e) { error('verify run containers', e); }
      ledger.cleanup.push({ at: new Date().toISOString(), errors: report.cleanupErrors });
      if (!report.cleanupErrors.length && !report.quarantine.length && ledger.files.every(file => ['gone', 'notStarted'].includes((file as { processState?: string }).processState ?? ''))) ledger.state = 'completed';
      try { await save(); } catch (e) { error('final ledger', e); }
    }
    process.off('SIGINT', onInt); process.off('SIGTERM', onTerm);
    report.end = new Date().toISOString(); report.wallMs = performance.now() - begin;
    if (signal) report.signal = signal;
    if (options.metrics) { report.metrics = { intervalMs: 1000, nodeCpuPeak, nodeCpuScope: 'sum of root and observed descendants percent', dockerCpuPeak, dockerCpuScope: 'sum of run-labeled container percent', pgConnectionsPeak, pgConnectionsScope: 'slot + run-label fixture cluster client backends, hook Compose 제외', vanished: metricVanishedCount, errors: metricErrors }; if (metricErrors.length) failed = true; }
    try { if (claimed || options.recover || options.report) { await mkdir(resolve(reportPath, '..'), { recursive: true }); await writeFile(reportPath, JSON.stringify(report, null, 2).split(homedir()).join('~') + '\n'); } } catch (e) { failed = true; process.stderr.write(`report: ${display(String(e))}\n`); }
    const totals = report.files.reduce((sum, row) => ({ pass: sum.pass + (row.cases?.pass ?? 0), fail: sum.fail + (row.cases?.fail ?? 0), skip: sum.skip + (row.cases?.skip ?? 0) }), { pass: 0, fail: 0, skip: 0 });
    process.stderr.write(`Python run ${runId}: ${failed || signal ? 'failed' : 'passed'}; files ${report.files.length}; pass/fail/skip ${totals.pass}/${totals.fail}/${totals.skip}; ${report.wallMs.toFixed(0)}ms\n`);
    for (const row of report.jobs.filter(row => row.reason !== 'pass')) {
      process.stderr.write(`${display(row.id ?? row.file)}: ${row.reason}; log: ${display(row.log)}\n`);
      try { const content = await readFile(join(repo, row.log), 'utf8'); const lines = content.split(/\r?\n/); if (lines.at(-1) === '') lines.pop(); process.stderr.write(display(lines.slice(-40).join('\n')) + '\n'); }
      catch (e) { process.stderr.write(`log unavailable: ${display(String(e))}\n`); }
    }
    for (const message of report.cleanupErrors) process.stderr.write(`${display(message)}\n`);
  }
  return signal ? exitStatus(true, signal) : usageError ? 2 : exitStatus(failed);
}
export async function main(args: string[]): Promise<number> {
  let options: Options;
  try { options = parseArgs(args); } catch (e) { process.stderr.write(`${String(e)}\n`); return 2; }
  try { return await runCoordinator(options); } catch (e) { process.stderr.write(`${String(e)}\n`); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main(process.argv.slice(2)).then(code => { process.exitCode = code; });
