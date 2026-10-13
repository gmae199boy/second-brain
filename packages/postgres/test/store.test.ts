import { createServer } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { storeContract } from '@second-brain/core/testing';
import { postgresStore } from '../src/store.js';

/** A TCP port nothing listens on, so connecting is refused immediately. */
async function closedPort(): Promise<number> {
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
  return port;
}

// Only the blocks in here need a database, so only they set one up.
describe('postgresStore against a real database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reports the server version and the installed vector extension', async () => {
    const store = postgresStore({ databaseUrl: database.url });
    try {
      const health = await store.checkHealth();

      expect(health.ok).toBe(true);
      if (!health.ok) return;
      expect(health.serverVersion).toMatch(/^\d+/);
      expect(health.vector.installed).toMatch(/^\d+\./);
      expect(health.vector.available).toMatch(/^\d+\./);
    } finally {
      await store.close();
    }
  });

  /**
   * The first adapter to plug into the frame: the cases come from Core as data,
   * and this runner feeds them a real database (AD-10, Conventions on testing).
   */
  describe('and the health contract', () => {
    for (const testCase of storeContract()) {
      it(testCase.name, async () => {
        await testCase.run(async () => postgresStore({ databaseUrl: database.url }));
      });
    }
  });
});

describe('postgresStore against a closed port', () => {
  it('returns DB_UNAVAILABLE as a value, within the connect timeout', async () => {
    const port = await closedPort();
    const store = postgresStore({
      databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    });

    const startedAt = Date.now();
    try {
      const health = await store.checkHealth();
      const elapsed = Date.now() - startedAt;

      expect(health.ok).toBe(false);
      if (health.ok) return;
      expect(health.code).toBe('DB_UNAVAILABLE');
      expect(health.message.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await store.close();
    }
  });
});

// The same contract cases, against an unreachable store: no database needed,
// because the point is that the verdict is still a value (Conventions).
describe('postgresStore satisfies the health contract against a closed port', () => {
  for (const testCase of storeContract()) {
    it(testCase.name, async () => {
      const port = await closedPort();
      await testCase.run(async () =>
        postgresStore({
          databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
        }),
      );
    });
  }
});
