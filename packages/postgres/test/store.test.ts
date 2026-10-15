import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase } from '@second-brain/test-db';
import { schemaStoreContract, storeContract } from '@second-brain/core/testing';
import { postgresStore } from '../src/store.js';
import { SCHEMA_VERSION, runMigrations } from '../src/migrate.js';
import { closedPort } from './closed-port.js';

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
      // The location is printed, so it names the database and not the URL:
      // no password ever reaches a report.
      expect(health.source.location).toContain('/');
      expect(health.source.location).not.toContain('postgres:postgres@');
      expect(health.source.probes.map((probe) => probe.id)).toEqual(['vector']);
      expect(health.source.probes[0]?.ok).toBe(true);
      expect(health.source.probes[0]?.detail).toMatch(/^\d+\./);
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

  it('reports no schema version at all before the first migration ran', async () => {
    const store = postgresStore({ databaseUrl: database.url });
    try {
      // This database was created, not migrated, so `schema_version` is absent:
      // an empty database, which is a value and not an unreachable one.
      const stored = await store.readSchemaVersion();

      expect(stored).toEqual({ ok: true, version: null });
    } finally {
      await store.close();
    }
  });

  /** The same cases against an unmigrated database: the table is simply absent. */
  describe('and the schema contract before any migration', () => {
    for (const testCase of schemaStoreContract()) {
      it(testCase.name, async () => {
        await testCase.run(async () => postgresStore({ databaseUrl: database.url }));
      });
    }
  });
});

describe('postgresStore against a migrated database', () => {
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase();
    const migration = await runMigrations({ databaseUrl: database.url });
    expect(migration.ok).toBe(true);
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('reads the version the migration recorded', async () => {
    const store = postgresStore({ databaseUrl: database.url });
    try {
      const stored = await store.readSchemaVersion();

      expect(stored.ok).toBe(true);
      if (!stored.ok) return;
      expect(stored.version?.version).toBe(SCHEMA_VERSION);
      expect(stored.version?.appliedAt).toBeInstanceOf(Date);
      expect(Number.isNaN(stored.version?.appliedAt.getTime() ?? Number.NaN)).toBe(false);
    } finally {
      await store.close();
    }
  });

  describe('and the schema contract', () => {
    for (const testCase of schemaStoreContract()) {
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

describe('postgresStore reading the schema version of a closed port', () => {
  it('returns DB_UNAVAILABLE as a value, within the connect timeout', async () => {
    const port = await closedPort();
    const store = postgresStore({
      databaseUrl: `postgres://postgres:postgres@127.0.0.1:${port}/postgres`,
    });

    const startedAt = Date.now();
    try {
      const stored = await store.readSchemaVersion();
      const elapsed = Date.now() - startedAt;

      expect(stored.ok).toBe(false);
      if (stored.ok) return;
      expect(stored.code).toBe('DB_UNAVAILABLE');
      expect(stored.message.length).toBeGreaterThan(0);
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

describe('postgresStore satisfies the schema contract against a closed port', () => {
  for (const testCase of schemaStoreContract()) {
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
