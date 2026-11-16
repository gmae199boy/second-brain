import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { createHash, randomBytes } from 'node:crypto';
import type { Docker } from './slots/cluster.js';

export type Phase = 'container-create' | 'container-start' | 'sql-ready' | 'database-create' | 'database-drop' | 'container-drop' | 'readiness-diagnostic' | 'pre-drop-diagnostic' | 'test-failure-diagnostic';
export type Backend = 'shared' | 'isolated';
const safeId = (value: string | undefined, length: number): string | null => {
  if (!value) return null;
  if (new RegExp(`^[a-f0-9]{${length}}$`).test(value)) return value;
  return `hash-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;
};
export function safeErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return null;
  const classes = ['00', '01', '02', '03', '08', '09', '0A', '0B', '0F', '0L', '0P', '0Z', '20', '21', '22', '23', '24', '25', '26', '27', '28', '2B', '2D', '2F', '34', '38', '39', '3B', '3D', '3F', '40', '42', '44', '53', '54', '55', '57', '58', '72', 'F0', 'HV', 'P0', 'XX'];
  return (/^[0-9A-Z]{5}$/.test(code) && classes.includes(code.slice(0, 2))) || ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND'].includes(code) ? code : null;
}
export interface FixtureEvent {
  event: 'test-fixture'; fixtureId: string; backend: Backend; runId: string | null; fileId: string | null; testId: string | null;
  pid: number; utc: string; monotonicMs: number; phase: Phase; elapsedMs: number; outcome: 'ok' | 'error'; errorCode: string | null;
  diagnostic?: SafeDiagnostic;
}
export interface SafeDiagnostic {
  state?: { status: string | null; running: boolean | null; exitCode: number | null };
  logSeverityCounts?: Record<string, number>;
  connections?: number;
  waits?: { type: string; count: number }[];
  errors: string[];
}
export class FixtureTelemetry {
  readonly fixtureId = randomBytes(12).toString('hex');
  private readonly runId: string | null;
  private readonly fileId: string | null;
  private readonly testId: string | null;
  constructor(public backend: Backend, private readonly sink = defaultSink, env: NodeJS.ProcessEnv = process.env) {
    this.runId = safeId(env.BRAIN_TEST_RUN_ID, 24); this.fileId = safeId(env.BRAIN_TEST_FILE_ID, 20);
    this.testId = /^[a-f0-9]{20}$/.test(env.BRAIN_TEST_CASE_ID ?? '') ? env.BRAIN_TEST_CASE_ID! : null;
  }
  emit(phase: Phase, started: number, error?: unknown, diagnostic?: SafeDiagnostic): void {
    try {
      const now = performance.now();
      const event: FixtureEvent = { event: 'test-fixture', fixtureId: this.fixtureId, backend: this.backend, runId: this.runId, fileId: this.fileId, testId: this.testId, pid: process.pid, utc: new Date().toISOString(), monotonicMs: now, phase, elapsedMs: Math.max(0, now - started), outcome: error === undefined ? 'ok' : 'error', errorCode: safeErrorCode(error), ...(diagnostic ? { diagnostic } : {}) };
      this.sink(event);
    } catch { /* Observability must never alter setup or cleanup. */ }
  }
  async measure<T>(phase: Phase, action: () => Promise<T>): Promise<T> {
    const started = performance.now();
    try { const result = await action(); this.emit(phase, started); return result; }
    catch (error) { this.emit(phase, started, error); throw error; }
  }
}
function defaultSink(event: FixtureEvent): void {
  const line = JSON.stringify(event) + '\n';
  if (process.env.BRAIN_TEST_METRICS_LOG) appendFileSync(process.env.BRAIN_TEST_METRICS_LOG, line, { mode: 0o600 });
  else process.stdout.write(line);
}

/** Only aggregate, allowlisted information from an exactly identified fixture. */
type FixtureOwner = { kind: 'fixture'; name: string; nonce: string; runId?: string; fileId?: string };
type SlotOwner = { kind: 'slot'; runId: string; slotId: string };
type DiagnosticOptions = { id: string; port?: number; docker: Docker; activity: () => Promise<unknown[]> };
export async function inspectOwnedFixture(options: DiagnosticOptions & Omit<FixtureOwner, 'kind'>): Promise<SafeDiagnostic> {
  return inspectOwnedPostgres(options, { kind: 'fixture', ...options });
}
export async function inspectOwnedSlot(options: DiagnosticOptions & Omit<SlotOwner, 'kind'>): Promise<SafeDiagnostic> {
  return inspectOwnedPostgres(options, { kind: 'slot', ...options });
}
async function inspectOwnedPostgres(options: DiagnosticOptions, owner: FixtureOwner | SlotOwner): Promise<SafeDiagnostic> {
  const result: SafeDiagnostic = { errors: [] }, { id, port, docker, activity } = options;
  const validOwner = owner.kind === 'fixture'
    ? /^[a-f0-9]{24}$/.test(owner.nonce) && owner.name === `brain-fixture-${owner.nonce}`
    : /^[a-zA-Z0-9_-]+$/.test(owner.runId) && /^[a-zA-Z0-9_-]+$/.test(owner.slotId);
  if (!/^[a-f0-9]{64}$/.test(id) || !validOwner || (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535 || [54320, 54329].includes(port)))) { result.errors.push('invalid-identity'); return result; }
  try {
    const raw = JSON.parse((await docker(['inspect', '--format', '{{json .}}', id])).stdout) as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> }; State?: { Status?: unknown; Running?: unknown; ExitCode?: unknown }; NetworkSettings?: { Ports?: Record<string, { HostIp?: string; HostPort?: string }[]> } };
    const labels = raw.Config?.Labels, bindings = raw.NetworkSettings?.Ports?.['5432/tcp'];
    const actualName = raw.Name?.replace(/^\//, '') ?? '';
    const owned = owner.kind === 'fixture'
      ? actualName === owner.name && labels?.['brain.fixture'] === owner.nonce && (!owner.runId || labels?.['brain.test-run'] === owner.runId) && (!owner.fileId || labels?.['brain.test-file'] === owner.fileId)
      : actualName.startsWith(`brain-slot-${owner.runId}-${owner.slotId}-`) && /^[a-zA-Z0-9_-]+$/.test(actualName.slice(`brain-slot-${owner.runId}-${owner.slotId}-`.length)) && labels?.['brain.test-run'] === owner.runId && labels?.['brain.test-slot'] === owner.slotId;
    if (raw.Id !== id || !owned || (port !== undefined && (bindings?.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1' || Number(bindings[0].HostPort) !== port))) { result.errors.push('ownership-mismatch'); return result; }
    const state = raw.State;
    result.state = { status: typeof state?.Status === 'string' && ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead'].includes(state.Status) ? state.Status : null, running: typeof state?.Running === 'boolean' ? state.Running : null, exitCode: typeof state?.ExitCode === 'number' && Number.isInteger(state.ExitCode) ? state.ExitCode : null };
  } catch { result.errors.push('inspect-failed'); return result; }
  try {
    const logs = (await docker(['logs', '--tail', '50', id])).stdout.slice(-32768);
    const counts: Record<string, number> = {};
    for (const line of logs.split('\n')) {
      const level = line.match(/\b(LOG|FATAL|ERROR|WARNING|PANIC|DETAIL|HINT|STATEMENT):/)?.[1];
      if (level) counts[level] = (counts[level] ?? 0) + 1;
    }
    result.logSeverityCounts = counts;
  } catch { result.errors.push('logs-unavailable'); }
  if (port === undefined) { result.errors.push('port-unavailable'); return result; }
  try {
    const rows = await activity();
    const types = ['Activity', 'BufferPin', 'Client', 'Extension', 'IO', 'IPC', 'Lock', 'LWLock', 'Timeout'];
    let total = 0; const waits: { type: string; count: number }[] = [];
    for (const row of rows.slice(0, 32)) {
      const item = row as { type?: unknown; count?: unknown }, count = Number(item.count);
      if (!Number.isSafeInteger(count) || count < 0 || count > 1_000_000) throw new Error('invalid aggregate');
      total += count;
      if (typeof item.type === 'string' && types.includes(item.type)) waits.push({ type: item.type, count });
    }
    result.connections = total; result.waits = waits;
  } catch { result.errors.push('activity-unavailable'); }
  return result;
}

// The setup hook updates this before each test; callbacks always re-check
// ownership immediately before reading the owned cluster.
const activeDiagnostics = new Set<(phase: Phase, error: unknown) => Promise<void>>();
let failureProbe: (() => boolean) | undefined;
export function setFailureProbe(probe?: () => boolean): void { failureProbe = probe; }
export function testHasFailed(): boolean { try { return failureProbe?.() === true; } catch { return false; } }
export function registerFixtureDiagnostic(callback: (phase: Phase, error: unknown) => Promise<void>): () => void {
  activeDiagnostics.add(callback); return () => { activeDiagnostics.delete(callback); };
}
export async function diagnoseTestFailure(): Promise<void> {
  if (!testHasFailed()) return;
  await Promise.allSettled([...activeDiagnostics].map(callback => callback('test-failure-diagnostic', new Error('test failed'))));
}
