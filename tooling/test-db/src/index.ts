import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync } from 'node:fs';
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

async function createDatabaseAt(adminUrl: string): Promise<TestDatabase> {
  const name = `brain_test_${randomBytes(6).toString('hex')}`;

  await withAdminClient(adminUrl, async (client) => {
    await client.query(`create database "${name}"`);
  });

  const url = replaceDatabase(adminUrl, name);

  let dropped = false;
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
      if (dropped) return;
      await withAdminClient(adminUrl, async (admin) => {
        await admin.query(`drop database if exists "${name}" with (force)`);
      });
      dropped = true;
    },
  };
}

const docker = promisify(execFile);
const dockerCommand = (args: string[]) => docker('docker', args, { timeout: 15_000 });

/** A private cluster for fixtures whose extension roles have fixed names. */
export async function createIsolatedTestDatabase(): Promise<TestDatabase> {
  requireAdminDatabaseUrl();
  const nonce = randomBytes(12).toString('hex');
  const name = `brain-fixture-${nonce}`;
  let id: string | undefined;
  const record = (event: string, port?: number) => {
    const line = JSON.stringify({ fixturePostgres: event, name, id, ...(port ? { port } : {}) });
    if (process.env.BRAIN_TEST_PG_RESOURCE_LOG) appendFileSync(process.env.BRAIN_TEST_PG_RESOURCE_LOG, `${line}\n`);
    else process.stdout.write(`${line}\n`);
  };
  const remove = async () => {
    if (!id) return;
    try { await dockerCommand(['rm', '-f', id]); }
    catch (error) {
      try { await dockerCommand(['inspect', '--format', '{{.Id}}', id]); }
      catch (inspectionError) {
        const inspected = inspectionError as { code?: number; stderr?: string };
        const absent = inspected.code === 1 && [`error: no such object: ${id}`, `error: no such container: ${id}`].includes((inspected.stderr ?? '').trim().toLowerCase());
        if (absent) { record('removed'); id = undefined; return; }
      }
      record('remove-failed'); throw error;
    }
    record('removed');
    id = undefined;
  };
  try {
    const created = await dockerCommand(['create', '--name', name, '--label', `brain.fixture=${nonce}`, '-e', 'POSTGRES_PASSWORD=brain-fixture-test', '--tmpfs', '/var/lib/postgresql', '-p', '127.0.0.1::5432', 'postgres:18']);
    id = created.stdout.trim();
    if (!/^[a-f0-9]{64}$/.test(id)) throw new Error('docker did not return a container ID');
    record('created');
    await dockerCommand(['start', id]);
    const info = await dockerCommand(['inspect', '--format', '{{json .NetworkSettings.Ports}}', id]);
    const ports = JSON.parse(info.stdout) as Record<string, { HostIp: string; HostPort: string }[]>;
    const binding = ports['5432/tcp']?.[0];
    if (!binding || binding.HostIp !== '127.0.0.1' || !/^\d+$/.test(binding.HostPort)) throw new Error('invalid fixture port binding');
    const port = Number(binding.HostPort);
    record('started', port);
    const adminUrl = `postgres://postgres:brain-fixture-test@127.0.0.1:${port}/postgres`;
    const deadline = Date.now() + 30_000;
    let ready = false;
    while (Date.now() < deadline) {
      const client = new pg.Client({ connectionString: adminUrl, connectionTimeoutMillis: 1000, query_timeout: 1000 });
      try { await client.connect(); await client.query('select 1'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 250)); }
      finally { await client.end().catch(() => {}); }
    }
    if (!ready) throw new Error('isolated PostgreSQL TCP authentication did not become ready');
    const db = await createDatabaseAt(adminUrl);
    let removed = false, databaseDropped = false;
    return { ...db, fixtureContainer: { id, name, port }, get fixtureContainerRemoved() { return removed; }, get fixtureDatabaseDropped() { return databaseDropped; }, async drop() {
      if (removed) return;
      let databaseError: unknown;
      try { await db.drop(); databaseDropped = true; } catch (error) { databaseError = error; }
      try { await remove(); removed = true; }
      catch (error) { if (databaseError !== undefined) throw new AggregateError([databaseError, error], 'fixture database and container cleanup failed'); throw error; }
      if (databaseError !== undefined) throw databaseError;
    } };
  } catch (error) {
    if (!id) {
      // A timed-out create may still have created the uniquely named container.
      try {
        const found = await dockerCommand(['inspect', '--format', '{{.Id}}', name]);
        const candidate = found.stdout.trim();
        if (/^[a-f0-9]{64}$/.test(candidate)) { id = candidate; record('created'); }
      } catch (inspectionError) {
        const stderr = (inspectionError as { stderr?: string }).stderr ?? '';
        if (!/no such (object|container)/i.test(stderr)) {
          throw new AggregateError([error, inspectionError], `could not establish whether fixture ${name} was created`);
        }
      }
    }
    await remove();
    throw error;
  }
}

async function withAdminClient(
  adminUrl: string,
  run: (client: pg.Client) => Promise<void>,
): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
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
