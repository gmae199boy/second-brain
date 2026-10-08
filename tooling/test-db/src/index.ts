import { randomBytes } from 'node:crypto';
import pg from 'pg';

/**
 * Dev-only helper shared by the integration tests of `@second-brain/postgres`
 * and `apps/cli`. It lives outside the six architecture packages on purpose:
 * it is tooling, not part of the shipped surface.
 */
export interface TestDatabaseOptions {
  /** Install the vector extension in the new database. Defaults to `true`. */
  installVector?: boolean;
}

export interface TestDatabase {
  /** Connection URL of the freshly created, vector-enabled database. */
  url: string;
  /** Drop the database again. Safe to call once. */
  drop(): Promise<void>;
}

const MISSING_URL = [
  'BRAIN_TEST_DATABASE_URL is not set, so the Postgres integration tests cannot run.',
  'These tests use a real database on purpose and are never mocked or skipped.',
  '',
  'Start the test database and point the variable at it:',
  '',
  '  docker compose -f compose.test.yaml up -d',
  '  export BRAIN_TEST_DATABASE_URL=postgres://postgres:postgres@localhost:54329/postgres',
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
  const url = process.env.BRAIN_TEST_DATABASE_URL?.trim();
  if (url === undefined || url === '') {
    throw new Error(MISSING_URL);
  }
  return url;
}

/**
 * Create a throwaway `brain_test_<random>` database, with the vector extension
 * installed unless asked otherwise, and hand back its URL plus the way to drop it.
 */
export async function createTestDatabase(options: TestDatabaseOptions = {}): Promise<TestDatabase> {
  const { installVector = true } = options;
  const adminUrl = requireAdminDatabaseUrl();
  const name = `brain_test_${randomBytes(6).toString('hex')}`;

  await withAdminClient(adminUrl, async (client) => {
    await client.query(`create database "${name}"`);
  });

  const url = replaceDatabase(adminUrl, name);
  if (installVector) {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      await client.query('create extension if not exists vector');
    } finally {
      await client.end();
    }
  }

  let dropped = false;
  return {
    url,
    async drop() {
      if (dropped) return;
      await withAdminClient(adminUrl, async (admin) => {
        await admin.query(`drop database if exists "${name}" with (force)`);
      });
      dropped = true;
    },
  };
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
