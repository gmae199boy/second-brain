import { createServer } from 'node:net';
import pg from 'pg';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { runMigrations } from '../src/migrate.js';
import {
  DEFAULT_CHUNK_PARAMS,
  ensureDefaultIndexConfig,
  ensureVectorExtension,
} from '../src/setup.js';

/** Caller-minted ids, in the UUIDv7 shape every row carries (AD-8). */
function id(ordinal: number): string {
  return `01940000-0000-7000-8000-${String(ordinal).padStart(12, '0')}`;
}

const databases: TestDatabase[] = [];

afterAll(async () => {
  await Promise.all(databases.map(async (database) => database.drop()));
});

/** A database with no `vector` extension installed in it. */
async function bareDatabase(): Promise<string> {
  const database = await createTestDatabase({ installVector: false });
  databases.push(database);
  return database.url;
}

/** A database with the extension already installed, as the test image does. */
async function vectorDatabase(): Promise<string> {
  const database = await createTestDatabase({ installVector: true });
  databases.push(database);
  return database.url;
}

/** An empty database with the whole schema applied. */
async function migratedDatabase(): Promise<string> {
  const url = await bareDatabase();
  const applied = await runMigrations({ databaseUrl: url });
  expect(applied.ok).toBe(true);
  return url;
}

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

async function indexConfigRows(
  url: string,
): Promise<{ id: string; kind: string; model: string | null; chunk_params: unknown }[]> {
  return withClient(url, async (client) => {
    const rows = await client.query<{
      id: string;
      kind: string;
      model: string | null;
      dimensions: number | null;
      chunk_params: unknown;
    }>('select id, kind, model, dimensions, chunk_params from index_configs order by id');
    return rows.rows;
  });
}

/** A TCP port nothing listens on, so connecting is refused immediately. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('could not determine the listening port'));
        return;
      }
      resolve(address.port);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `postgres://postgres:postgres@127.0.0.1:${String(port)}/postgres`;
}

describe('ensureVectorExtension', () => {
  it('installs the extension in a database that has none', async () => {
    const url = await bareDatabase();

    const result = await ensureVectorExtension({ databaseUrl: url });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.installed).toMatch(/^\d+\./);
    expect(result.available).toMatch(/^\d+\./);
    expect(result.reason).toBe('');
  });

  it('is a no-op when the extension is already installed', async () => {
    const url = await vectorDatabase();

    const first = await ensureVectorExtension({ databaseUrl: url });
    const again = await ensureVectorExtension({ databaseUrl: url });

    expect(first).toEqual(again);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.installed).not.toBeNull();
  });

  it('reports an unreachable database as a value, not an exception', async () => {
    const result = await ensureVectorExtension({ databaseUrl: await closedUrl() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DB_UNAVAILABLE');
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('ensureDefaultIndexConfig', () => {
  it('creates the one chunk-only row, with the default parameters', async () => {
    const url = await migratedDatabase();

    const result = await ensureDefaultIndexConfig({ databaseUrl: url, id: id(1) });

    expect(result).toEqual({ ok: true, id: id(1), created: true });
    expect(await indexConfigRows(url)).toEqual([
      {
        id: id(1),
        kind: 'chunk',
        model: null,
        dimensions: null,
        chunk_params: DEFAULT_CHUNK_PARAMS,
      },
    ]);
  });

  it('creates no embedding row (AD-15)', async () => {
    const url = await migratedDatabase();
    await ensureDefaultIndexConfig({ databaseUrl: url, id: id(1) });

    const kinds = (await indexConfigRows(url)).map((row) => row.kind);
    expect(kinds).toEqual(['chunk']);
  });

  it('keeps the first row and its id when it runs again with another id', async () => {
    const url = await migratedDatabase();
    await ensureDefaultIndexConfig({ databaseUrl: url, id: id(1) });

    const again = await ensureDefaultIndexConfig({ databaseUrl: url, id: id(2) });

    expect(again).toEqual({ ok: true, id: id(1), created: false });
    expect(await indexConfigRows(url)).toHaveLength(1);
  });

  it('collides on the value of chunk_params, not on the order of its keys', async () => {
    const url = await migratedDatabase();
    // The same three parameters, written back to front: jsonb normalises, so
    // the unique key must see one row here and not two.
    const reordered = JSON.stringify({
      splitMessagesOverChars: DEFAULT_CHUNK_PARAMS.splitMessagesOverChars,
      overlapMessages: DEFAULT_CHUNK_PARAMS.overlapMessages,
      targetChars: DEFAULT_CHUNK_PARAMS.targetChars,
    });
    await withClient(url, async (client) => {
      await client.query(
        `insert into index_configs (id, kind, model, dimensions, chunk_params)
              values ($1, 'chunk', null, null, $2::jsonb)`,
        [id(5), reordered],
      );
    });

    const result = await ensureDefaultIndexConfig({ databaseUrl: url, id: id(6) });

    expect(result).toEqual({ ok: true, id: id(5), created: false });
    expect(await indexConfigRows(url)).toHaveLength(1);
  });

  it('reports an unreachable database as a value, not an exception', async () => {
    const result = await ensureDefaultIndexConfig({
      databaseUrl: await closedUrl(),
      id: id(1),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('DB_UNAVAILABLE');
  });

  it('throws when the id already names a different row, because that is a bug', async () => {
    const url = await migratedDatabase();
    await withClient(url, async (client) => {
      await client.query(
        `insert into index_configs (id, kind, model, dimensions, chunk_params)
              values ($1, 'chunk', null, null, $2::jsonb)`,
        [id(9), JSON.stringify({ ...DEFAULT_CHUNK_PARAMS, targetChars: 900 })],
      );
    });

    await expect(ensureDefaultIndexConfig({ databaseUrl: url, id: id(9) })).rejects.toThrow(
      /already holds a row with id/,
    );
  });
});
