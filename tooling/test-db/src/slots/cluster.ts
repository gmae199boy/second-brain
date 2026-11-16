import { ownedDocker } from './owned-command.js';
import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { FixtureTelemetry, inspectOwnedSlot, safeErrorCode } from '../fixture-observability.js';
import { assertUnprotected } from './protected.js';

export type Docker = (args: string[]) => Promise<{ stdout: string }>;
export const docker: Docker = async args => {
  const result = await ownedDocker(args, { timeout: 15_000, maxBuffer: args[0] === 'logs' ? 65536 : 1024 * 1024 });
  return { stdout: args[0] === 'logs' ? result.stdout + result.stderr : result.stdout };
};
export interface Cluster { id: string; name: string; runId: string; slotId: string; port: number; url: string; telemetry?: FixtureTelemetry }
const validId = (id: string) => /^[a-f0-9]{64}$/.test(id);
export function isNoSuchObject(error: unknown, id: string): boolean {
  const e = error as { code?: number; stderr?: string };
  return e.code === 1 && [`error: no such object: ${id}`, `error: no such container: ${id}`].includes((e.stderr ?? '').trim().toLowerCase());
}
export function inspectPort(stdout: string): number {
  const ports = JSON.parse(stdout) as Record<string, { HostIp: string; HostPort: string }[]>;
  const bindings = ports['5432/tcp'];
  if (!bindings || bindings.length !== 1 || bindings[0]?.HostIp !== '127.0.0.1' || !/^\d+$/.test(bindings[0].HostPort)) throw new Error('invalid slot port binding');
  const port = Number(bindings[0].HostPort);
  if (port < 1 || port > 65535 || port === 54329 || port === 54320) throw new Error('forbidden slot port');
  return port;
}
export async function recoverCluster(name: string, runId: string, slotId: string, run: Docker = docker): Promise<string | undefined> {
  assertUnprotected(name, undefined);
  let out: string;
  try { out = (await run(['inspect', '--format', '{{json .}}', name])).stdout; }
  catch (error) { if (isNoSuchObject(error, name)) return undefined; throw error; }
  const item = JSON.parse(out) as { Id: string; Name: string; Config: { Labels: Record<string, string> } };
  assertUnprotected(item.Name, item.Config?.Labels);
  if (!validId(item.Id) || item.Name.replace(/^\//, '') !== name || item.Config.Labels?.['brain.test-run'] !== runId || item.Config.Labels?.['brain.test-slot'] !== slotId) throw new Error('recovered container ownership mismatch');
  return item.Id;
}
export async function removeCluster(id: string, run: Docker = docker, telemetry?: FixtureTelemetry): Promise<void> {
  if (!validId(id)) throw new Error('invalid container ID');
  try { if (telemetry) await telemetry.measure('container-drop', () => run(['rm', '-fv', id])); else await run(['rm', '-fv', id]); } catch (error) { if (!isNoSuchObject(error, id)) throw error; }
  try { await run(['inspect', '--format', '{{.Id}}', id]); } catch (error) { if (isNoSuchObject(error, id)) return; throw error; }
  throw new Error('container still exists after removal');
}
export async function waitForAuthentication(url: string, timeout = 30_000, options: { now?: () => number; sleep?: (ms: number) => Promise<void>; probe?: () => Promise<void> } = {}): Promise<void> {
  const now = options.now ?? Date.now, sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms))), deadline = now() + timeout;
  let lastError: unknown;
  while (now() < deadline) {
    try {
      if (options.probe) await options.probe();
      else {
        const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000, query_timeout: 1000 });
        try { await client.connect(); await client.query('select 1'); } finally { await client.end().catch(() => {}); }
      }
      return;
    } catch (error) { lastError = error; await sleep(250); }
  }
  throw Object.assign(new Error('slot PostgreSQL TCP authentication did not become ready'), { code: safeErrorCode(lastError) });
}
export async function startCluster(id: string, run: Docker = docker): Promise<number> {
  if (!validId(id)) throw new Error('invalid container ID');
  await run(['start', id]);
  return inspectPort((await run(['inspect', '--format', '{{json .NetworkSettings.Ports}}', id])).stdout);
}
export async function createCluster(runId: string, slotId: string, generation: string, options: { docker?: Docker; wait?: (url: string) => Promise<void> } = {}): Promise<Cluster> {
  if (![runId, slotId, generation].every(x => /^[a-zA-Z0-9_-]+$/.test(x))) throw new Error('invalid cluster name component');
  const run = options.docker ?? docker, name = `brain-slot-${runId}-${slotId}-${generation}`;
  let id: string | undefined, port: number | undefined, url: string | undefined;
  const telemetry = new FixtureTelemetry('shared', undefined, { ...process.env, BRAIN_TEST_RUN_ID: runId, BRAIN_TEST_FILE_ID: undefined, BRAIN_TEST_CASE_ID: undefined });
  try {
    id = (await telemetry.measure('container-create', () => run(['create', '--name', name, '--label', `brain.test-run=${runId}`, '--label', `brain.test-slot=${slotId}`, '-e', 'POSTGRES_PASSWORD=brain-slot-test', '--tmpfs', '/var/lib/postgresql', '-p', '127.0.0.1::5432', 'postgres:18']))).stdout.trim();
    if (!validId(id)) { id = undefined; throw new Error('invalid container ID'); }
    port = await telemetry.measure('container-start', () => startCluster(id!, run));
    url = `postgres://postgres:brain-slot-test@127.0.0.1:${port}/postgres`;
    await telemetry.measure('sql-ready', () => (options.wait ?? waitForAuthentication)(url!));
    return { id, name, runId, slotId, port, url, telemetry };
  } catch (error) {
    try {
      id ??= await recoverCluster(name, runId, slotId, run);
      if (id) {
        const started = performance.now();
        try {
          const diagnostic = await inspectOwnedSlot({ id, runId, slotId, port, docker: run, activity: async () => {
            if (!url) return [];
            const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 1000, query_timeout: 1000 });
            try { await client.connect(); return (await client.query("select wait_event_type as type, count(*)::int as count from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() group by wait_event_type")).rows; }
            finally { await client.end().catch(() => {}); }
          } });
          telemetry.emit('readiness-diagnostic', started, error, diagnostic);
        } catch { telemetry.emit('readiness-diagnostic', started, error, { errors: ['diagnostic-unavailable'] }); }
        await removeCluster(id, run, telemetry);
      }
    }
    catch (cleanup) { throw new AggregateError([error, cleanup], 'slot creation and recovery failed'); }
    throw error;
  }
}
export async function removeOwnedCluster(cluster: Cluster, run: Docker = docker, activity?: () => Promise<unknown[]>): Promise<void> {
  const telemetry = cluster.telemetry;
  const diagnose = async (error: unknown, phase: 'pre-drop-diagnostic' | 'readiness-diagnostic') => {
    if (!telemetry) return;
    const started = performance.now();
    try {
      const diagnostic = await inspectOwnedSlot({ id: cluster.id, runId: cluster.runId, slotId: cluster.slotId, port: cluster.port, docker: run, activity: activity ?? (async () => {
        const client = new pg.Client({ connectionString: cluster.url, connectionTimeoutMillis: 1000, query_timeout: 1000 });
        try { await client.connect(); return (await client.query("select wait_event_type as type, count(*)::int as count from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() group by wait_event_type")).rows; }
        finally { await client.end().catch(() => {}); }
      }) });
      telemetry.emit(phase, started, error, diagnostic);
    } catch { telemetry.emit(phase, started, error, { errors: ['diagnostic-unavailable'] }); }
  };
  await diagnose(new Error('pre-drop'), 'pre-drop-diagnostic');
  try { await removeCluster(cluster.id, run, telemetry); }
  catch (error) { await diagnose(error, 'readiness-diagnostic'); throw error; }
}
export interface Boundary { databases: string[]; roles: string[]; connections: number; clean: boolean }
export async function checkClusterBoundary(url: string, query?: (sql: string) => Promise<{ rows: Record<string, unknown>[] }>): Promise<Boundary> {
  const client = query ? undefined : new pg.Client({ connectionString: url, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const q = query ?? (sql => client!.query(sql));
  try {
    if (client) await client.connect();
    const db = await q("select datname from pg_database where datname not in ('postgres','template0','template1')");
    const roles = await q("select rolname from pg_roles where shobj_description(oid, 'pg_authid') like 'second-brain extension:%'");
    const connections = await q("select count(*)::int as count from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid()");
    const databases = db.rows.map(r => String(r.datname)), names = roles.rows.map(r => String(r.rolname)), count = Number(connections.rows[0]?.count);
    if (!Number.isFinite(count)) throw new Error('invalid connection count');
    return { databases, roles: names, connections: count, clean: databases.length === 0 && names.length === 0 && count === 0 };
  } finally { if (client) await client.end(); }
}
