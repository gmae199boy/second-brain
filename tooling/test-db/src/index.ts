import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { ownedDocker } from './slots/owned-command.js';
import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { FixtureTelemetry, inspectOwnedFixture, inspectOwnedSlot, registerFixtureDiagnostic, safeErrorCode, testHasFailed, type Phase } from './fixture-observability.js';
import { acquireSlotDatabase, type SlotLease } from './slots/lease.js';
import { checkClusterBoundary } from './slots/cluster.js';
import { assertUnprotected } from './slots/protected.js';
export { validateSlotLease, acquireSlotDatabase, type SlotLease, type LeaseDependencies } from './slots/lease.js';

import { DEFAULT_TEST_DATABASE_URL, TEST_DATABASE_URL_ENV } from './global-setup.js';

// The package boundary is this one entry point (`exports: "."`), so the
// preparation step is re-exported here rather than imported by its path.
export {
  COMPOSE_FILE,
  DEFAULT_TEST_DATABASE_URL,
  TEST_DATABASE_URL_ENV,
  prepareTestDatabase,
  default as setupTestDatabase,
  type CommandResult,
  type CommandRunner,
  type PrepareOptions,
  type Teardown,
} from './global-setup.js';

/**
 * Dev-only helper shared by the integration tests of `@second-brain/postgres`
 * and `apps/cli`. It lives outside the six architecture packages on purpose:
 * it is tooling, not part of the shipped surface.
 */
export interface TestDatabase {
  /** Present only for a fixture-owned disposable PostgreSQL cluster. */
  fixtureContainer?: { id: string; name: string; port: number };
  readonly fixtureContainerRemoved?: boolean;
  readonly fixtureDatabaseDropped?: boolean;
  /** Connection URL of the freshly created, isolated database. */
  url: string;
  /** Runtime role URL; call setup preparation before using it. */
  appUrl: string;
  maintenanceUrl: string;
  /** Run one statement against this database, for arranging state a test needs. */
  query(text: string): Promise<void>;
  /**
   * Run one query and hand back its rows, for a test that has to look at what
   * something else wrote. It exists so a test of a package that does not depend
   * on `pg` — `apps/cli`, for one — does not have to take the dependency on to
   * read a table back.
   */
  rows<T extends pg.QueryResultRow = Record<string, unknown>>(text: string): Promise<T[]>;
  /** Drop the database again. Safe to call once. */
  drop(): Promise<void>;
}

// Only a run that went around the `globalSetup` of `packages/postgres` gets
// this far unprepared — `pnpm test` sets the variable itself. It is left in
// place for that run, which otherwise has nothing to go on.
const MISSING_URL = [
  `${TEST_DATABASE_URL_ENV} is not set, so the Postgres integration tests cannot run.`,
  'These tests use a real database on purpose and are never mocked or skipped.',
  '',
  'Run them through `pnpm test`, which starts the test database itself,',
  'or start it and point the variable at it by hand:',
  '',
  '  docker compose -f compose.test.yaml up -d --wait',
  `  export ${TEST_DATABASE_URL_ENV}=${DEFAULT_TEST_DATABASE_URL}`,
  '',
  'Stop it again when you are done (it keeps no volume, so the data is discarded):',
  '',
  '  docker compose -f compose.test.yaml down',
].join('\n');

/**
 * Read the administrative URL from the environment, or fail loudly with the
 * command that starts the database. Reading happens here, never at import time.
 */
export function requireAdminDatabaseUrl(): string {
  const url = process.env[TEST_DATABASE_URL_ENV]?.trim();
  if (url === undefined || url === '') {
    throw new Error(MISSING_URL);
  }
  return url;
}

/**
 * Create a throwaway `brain_test_<random>` database,  and hand back its URL plus the way to drop it.
 */
export async function createTestDatabase(): Promise<TestDatabase> {
  return createDatabaseAt(requireAdminDatabaseUrl());
}

async function createDatabaseAt(adminUrl: string, telemetry = new FixtureTelemetry('shared'), lease?: SlotLease): Promise<TestDatabase> {
  // Capture the owning file at acquisition; later environment changes must not redirect release.
  const journal = telemetry.backend === 'shared' && process.env.BRAIN_TEST_FILE_DIR
    ? join(process.env.BRAIN_TEST_FILE_DIR, 'shared-db.jsonl') : undefined;
  const recordLease = (state: 'acquired' | 'released') => {
    if (journal) appendFileSync(journal, JSON.stringify({ state, fixtureId: telemetry.fixtureId }) + '\n', { mode: 0o600 });
  };
  recordLease('acquired');
  const name = `brain_test_${randomBytes(6).toString('hex')}`;

  try {
    await withAdminClient(adminUrl, async (client) => {
      await telemetry.measure('database-create', () => client.query(`create database "${name}"`));
    }, telemetry);
  } catch (error) {
    if (lease) await diagnoseSlot(lease, adminUrl, telemetry, error);
    throw error;
  }

  const url = replaceDatabase(adminUrl, name);

  let dropped = false;
  let releaseError: unknown;
  const unregister = lease ? registerFixtureDiagnostic((phase, error) => diagnoseSlot(lease, adminUrl, telemetry, error, phase)) : () => {};
  return {
    url,
    appUrl: (() => { const app = new URL(url); app.username = 'brain_app'; app.password = 'brain-test-app'; return app.toString(); })(),
    maintenanceUrl: (() => { const maintenance = new URL(url); maintenance.username = 'brain_maintenance'; maintenance.password = 'brain-test-maintenance'; return maintenance.toString(); })(),
    async query(text) {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        await client.query(text);
      } finally {
        await client.end();
      }
    },
    async rows<T extends pg.QueryResultRow = Record<string, unknown>>(
      text: string,
    ): Promise<T[]> {
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        return (await client.query<T>(text)).rows;
      } finally {
        await client.end();
      }
    },
    async drop() {
      if (dropped) { if (releaseError !== undefined) throw releaseError; return; }
      if (lease) await diagnoseSlot(lease, adminUrl, telemetry, new Error('pre-drop'), testHasFailed() ? 'test-failure-diagnostic' : 'pre-drop-diagnostic');
      try {
        await telemetry.measure('database-drop', () => withAdminClient(adminUrl, async (admin) => {
          await admin.query(`drop database if exists "${name}" with (force)`);
        }));
      } catch (error) { if (lease) await diagnoseSlot(lease, adminUrl, telemetry, error); throw error; }
      dropped = true; unregister();
      try { recordLease('released'); } catch (error) { releaseError = error; throw error; }
    },
  };
}

const dockerCommand = (args: string[]) => ownedDocker(args, { timeout: 15_000 });
const diagnosticDocker = async (args: string[]) => { const result = await ownedDocker(args, { timeout: 3000, maxBuffer: 65536 }); return { stdout: result.stdout + result.stderr }; };
async function readActivity(adminUrl: string): Promise<unknown[]> {
  const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000, query_timeout: 1000 });
  try { await client.connect(); return (await client.query("select wait_event_type as type, count(*)::int as count from pg_stat_activity where backend_type = 'client backend' and pid <> pg_backend_pid() group by wait_event_type")).rows; }
  finally { await client.end().catch(() => {}); }
}

async function diagnoseSlot(lease: SlotLease, url: string, telemetry: FixtureTelemetry, error: unknown, phase: Phase = 'readiness-diagnostic'): Promise<void> {
  const started = performance.now();
  try {
    const diagnostic = await inspectOwnedSlot({ id: lease.containerId, runId: lease.runId, slotId: lease.slotId, port: lease.port,
      docker: diagnosticDocker, activity: () => readActivity(url) });
    telemetry.emit(phase, started, error, diagnostic);
  } catch { telemetry.emit(phase, started, error, { errors: ['diagnostic-unavailable'] }); }
}

/** Acquire the process-local slot lease or create a fixture-owned cluster. */
export async function acquireTestDatabase(): Promise<TestDatabase> {
  const telemetry = new FixtureTelemetry('shared');
  return acquireSlotDatabase(process.env.BRAIN_TEST_SLOT_LEASE, {
    boundary: async (url, lease) => {
      try { return await telemetry.measure('sql-ready', () => checkClusterBoundary(url)); }
      catch (error) { if (lease) await diagnoseSlot(lease, url, telemetry, error); throw error; }
    },
    create: (url, lease) => createDatabaseAt(url, telemetry, lease), isolated: () => { telemetry.backend = 'isolated'; return createIsolatedTestDatabase(telemetry); },
  });
}

export function fixtureRunLabels(env: NodeJS.ProcessEnv = process.env): string[] {
  const labels: string[] = [];
  for (const [key, name] of [['BRAIN_TEST_RUN_ID', 'brain.test-run'], ['BRAIN_TEST_SLOT_ID', 'brain.test-slot'], ['BRAIN_TEST_FILE_ID', 'brain.test-file']] as const) {
    if (env[key]) labels.push('--label', `${name}=${env[key]}`);
  }
  return labels;
}

export function fixtureDockerCreateArgs(name: string, nonce: string, env: NodeJS.ProcessEnv = process.env): string[] {
  return ['create', '--name', name, '--label', `brain.fixture=${nonce}`, ...fixtureRunLabels(env), '-e', 'POSTGRES_PASSWORD=brain-fixture-test', '--tmpfs', '/var/lib/postgresql', '-p', '127.0.0.1::5432', 'postgres:18'];
}

/** A private cluster for fixtures whose extension roles have fixed names. */
export async function createIsolatedTestDatabase(telemetry = new FixtureTelemetry('isolated')): Promise<TestDatabase> {
  requireAdminDatabaseUrl();
  const nonce = randomBytes(12).toString('hex');
  const name = `brain-fixture-${nonce}`;
  const ownerEnv = { ...process.env }, ownerRunId = ownerEnv.BRAIN_TEST_RUN_ID, ownerFileId = ownerEnv.BRAIN_TEST_FILE_ID;
  let id: string | undefined, port: number | undefined, adminUrl: string | undefined;
  let diagnosedFailure: unknown;
  const diagnose = async (failure: unknown, phase: Phase = 'readiness-diagnostic') => {
    if (!id) return;
    const started = performance.now();
    try {
      const diagnostic = await inspectOwnedFixture({ id, name, nonce, runId: ownerRunId, fileId: ownerFileId, port,
        docker: diagnosticDocker, activity: () => adminUrl ? readActivity(adminUrl) : Promise.resolve([]) });
      telemetry.emit(phase, started, failure, diagnostic);
    } catch { telemetry.emit(phase, started, failure, { errors: ['diagnostic-unavailable'] }); }
    if (phase === 'readiness-diagnostic') diagnosedFailure = failure;
  };
  const record = (event: string, port?: number) => {
    const line = JSON.stringify({ fixturePostgres: event, name, id, ...(port ? { port } : {}) });
    if (process.env.BRAIN_TEST_PG_RESOURCE_LOG) appendFileSync(process.env.BRAIN_TEST_PG_RESOURCE_LOG, `${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  const remove = async () => {
    if (!id) return;
    try { await telemetry.measure('container-drop', () => dockerCommand(['rm', '-fv', id!])); }
    catch (error) {
      try { await dockerCommand(['inspect', '--format', '{{.Id}}', id]); }
      catch (inspectionError) {
        const inspected = inspectionError as { code?: number; stderr?: string };
        const absent = inspected.code === 1 && [`error: no such object: ${id}`, `error: no such container: ${id}`].includes((inspected.stderr ?? '').trim().toLowerCase());
        if (absent) { record('removed'); id = undefined; return; }
      }
      await diagnose(error); record('remove-failed'); throw error;
    }
    record('removed');
    id = undefined;
  };
  try {
    record('creating');
    const created = await telemetry.measure('container-create', () => dockerCommand(fixtureDockerCreateArgs(name, nonce, ownerEnv)));
    id = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('docker did not return a container ID');
    record('created');
    await telemetry.measure('container-start', () => dockerCommand(['start', id!]));
    const info = await dockerCommand(['inspect', '--format', '{{json .NetworkSettings.Ports}}', id]);
    const ports = JSON.parse(info.stdout) as Record<string, { HostIp: string; HostPort: string }[]>;
    const binding = ports['5432/tcp']?.[0];
    if (!binding || binding.HostIp !== '127.0.0.1' || !/^\d+$/.test(binding.HostPort)) throw new Error('invalid fixture port binding');
    port = Number(binding.HostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || [54320, 54329].includes(port)) throw new Error('forbidden fixture port');
    record('started', port);
    adminUrl = `postgres://postgres:brain-fixture-test@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000, readinessStarted = performance.now();
    let ready = false, lastError: unknown;
    while (Date.now() < deadline) {
      const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000, query_timeout: 1000 });
      try { await client.connect(); await client.query('select 1'); ready = true; break; }
      catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 250)); }
      finally { await client.end().catch(() => {}); }
    }
    if (!ready) {
      const failure = Object.assign(new Error('isolated PostgreSQL TCP authentication did not become ready'), { code: safeErrorCode(lastError) });
      telemetry.emit('sql-ready', readinessStarted, failure);
      await diagnose(failure);
      throw failure;
    }
    telemetry.emit('sql-ready', readinessStarted);
    let db: TestDatabase;
    try { db = await createDatabaseAt(adminUrl, telemetry); }
    catch (error) { await diagnose(error); throw error; }
    let removed = false, databaseDropped = false;
    const unregister = registerFixtureDiagnostic((phase, error) => diagnose(error, phase));
    return { ...db, fixtureContainer: { id, name, port }, get fixtureContainerRemoved() { return removed; }, get fixtureDatabaseDropped() { return databaseDropped; }, async drop() {
      if (removed) return;
      await diagnose(new Error('pre-drop'), testHasFailed() ? 'test-failure-diagnostic' : 'pre-drop-diagnostic');
      let databaseError: unknown;
      try { await db.drop(); databaseDropped = true; } catch (error) { databaseError = error; await diagnose(error); }
      try { await remove(); removed = true; unregister(); }
      catch (error) { if (databaseError !== undefined) throw new AggregateError([databaseError, error], 'fixture database and container cleanup failed'); throw error; }
      if (databaseError !== undefined) throw databaseError;
    } };
  } catch (error) {
    if (!id) {
      // A timed-out create may still have created the uniquely named container.
      try {
        const found = await dockerCommand(['inspect', '--format', '{{json .}}', name]);
        const candidate = JSON.parse(found.stdout) as { Id?: string; Name?: string; Config?: { Labels?: Record<string, string> } };
        const labels = candidate.Config?.Labels;
        assertUnprotected(candidate.Name, labels);
        if (!candidate.Id || !/^[a-f0-9]{64}$/.test(candidate.Id) || candidate.Name?.replace(/^\//, '') !== name || labels?.['brain.fixture'] !== nonce || (ownerRunId && labels['brain.test-run'] !== ownerRunId) || (ownerFileId && labels['brain.test-file'] !== ownerFileId)) throw new Error('fixture recovery ownership mismatch');
        id = candidate.Id; record('created');
      } catch (inspectionError) {
        const stderr = (inspectionError as { stderr?: string }).stderr ?? '';
        if (!/no such (object|container)/i.test(stderr)) {
          throw new AggregateError([error, inspectionError], `could not establish whether fixture ${name} was created`);
        }
      }
    }
    if (id && diagnosedFailure !== error) await diagnose(error);
    await remove();
    throw error;
  }
}

async function withAdminClient(
  adminUrl: string,
  run: (client: pg.Client) => Promise<void>,
  telemetry?: FixtureTelemetry,
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  try {
    if (telemetry) await telemetry.measure('sql-ready', async () => { await client.connect(); await client.query('select 1'); });
    else await client.connect();
    await run(client);
  } finally {
    await client.end();
  }
}

function replaceDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}
