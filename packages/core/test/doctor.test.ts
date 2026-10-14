import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { runDoctor, type DoctorCheck, type DoctorCheckSource } from '../src/admin/doctor.js';
import type {
  HealthStore,
  ReadSchemaVersionResult,
  SchemaStore,
  StoreHealth,
  StoreProbe,
} from '../src/ports/store.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';

/** The version these tests call current, so a mismatch is an explicit choice. */
const CURRENT = 2;

/** A reachable store whose source answered with exactly these probes. */
function healthy(...probes: StoreProbe[]): StoreHealth {
  return {
    ok: true,
    serverVersion: '18.1',
    source: { location: 'db.example:5432/brain', probes },
  };
}

interface FakeStore extends HealthStore, SchemaStore {
  closed: () => number;
}

/**
 * A store with both capabilities doctor asks for. The schema half is the fake
 * every schema test uses, so what "a database at version n" means is one thing
 * in this repository and not two.
 */
function fakeStore(
  health: StoreHealth,
  schema: { version?: number | null; result?: ReadSchemaVersionResult } = {},
): FakeStore {
  const schemaStore = memorySchemaStore(
    schema.result !== undefined
      ? { result: schema.result }
      : { version: schema.version === undefined ? CURRENT : schema.version },
  );
  let closes = 0;
  return {
    checkHealth: async () => health,
    readSchemaVersion: () => schemaStore.readSchemaVersion(),
    close: async () => {
      closes += 1;
    },
    closed: () => closes,
  };
}

/** One registered check that answers with whatever it was handed. */
function source(check: DoctorCheck): DoctorCheckSource {
  return { id: check.id, run: async () => check };
}

const OPTIONS = { schemaVersion: CURRENT };

describe('runDoctor', () => {
  it('reports db, vector and the schema version as ok when everything is healthy', async () => {
    const report = await runDoctor(
      fakeStore(healthy({ id: 'vector', ok: true, detail: '0.8.7' })),
      OPTIONS,
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'vector', status: 'ok', detail: '0.8.7' },
      { id: 'schema-version', status: 'ok', detail: '2' },
    ]);
  });

  it('fails the vector check and names the available version when it is not installed', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy({ id: 'vector', ok: false, detail: 'not installed (available: 0.8.7)' }),
      ),
      OPTIONS,
    );

    expect(report.checks[0]).toEqual({ id: 'db', status: 'ok', detail: '18.1' });
    expect(report.checks[1]).toMatchObject({ id: 'vector', status: 'fail' });
    expect(report.checks[1]?.detail).toContain('0.8.7');
    expect(report.checks[1]?.code).toBeUndefined();
  });

  it('reports the db check alone and carries the code when the store is unavailable', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED 127.0.0.1:54329' }),
      OPTIONS,
    );

    // Nothing was probed, so there is no probe to report on — and nothing is
    // known about the schema either, so there is no row claiming otherwise.
    expect(report.checks).toEqual([
      {
        id: 'db',
        status: 'fail',
        code: 'DB_UNAVAILABLE',
        detail: 'connect ECONNREFUSED 127.0.0.1:54329',
      },
    ]);
  });

  it('reports one check per probe, under the names the adapter chose', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy(
          { id: 'wal', ok: true, detail: 'wal' },
          { id: 'fts5-trigram', ok: false, detail: 'no such tokenizer' },
          { id: 'foreign-keys', ok: true },
        ),
      ),
      OPTIONS,
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'wal', status: 'ok', detail: 'wal' },
      { id: 'fts5-trigram', status: 'fail', detail: 'no such tokenizer' },
      { id: 'foreign-keys', status: 'ok' },
      { id: 'schema-version', status: 'ok', detail: '2' },
    ]);
  });

  it('reports db and the schema version alone when a healthy source ran no probes', async () => {
    const report = await runDoctor(fakeStore(healthy()), OPTIONS);

    expect(report.checks.map((check) => check.id)).toEqual(['db', 'schema-version']);
  });

  it('does not throw when the store is unavailable', async () => {
    await expect(
      runDoctor(fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' }), OPTIONS),
    ).resolves.toBeDefined();
  });
});

describe('runDoctor and the schema version', () => {
  it('fails with SCHEMA_MISMATCH and names both versions when they differ', async () => {
    const report = await runDoctor(fakeStore(healthy()), { schemaVersion: 7 });

    const schema = report.checks.find((check) => check.id === 'schema-version');
    expect(schema).toMatchObject({ status: 'fail', code: 'SCHEMA_MISMATCH' });
    expect(schema?.detail).toContain('2');
    expect(schema?.detail).toContain('7');
  });

  it('fails with SCHEMA_MISMATCH when the database holds no version at all', async () => {
    const report = await runDoctor(fakeStore(healthy(), { version: null }), OPTIONS);

    expect(report.checks.find((check) => check.id === 'schema-version')).toMatchObject({
      status: 'fail',
      code: 'SCHEMA_MISMATCH',
    });
  });

  it('carries DB_UNAVAILABLE when the health probe passed but the version could not be read', async () => {
    const report = await runDoctor(
      fakeStore(healthy(), {
        result: { ok: false, code: 'DB_UNAVAILABLE', message: 'applied_at is unreadable' },
      }),
      OPTIONS,
    );

    expect(report.checks.find((check) => check.id === 'schema-version')).toMatchObject({
      status: 'fail',
      code: 'DB_UNAVAILABLE',
    });
  });
});

describe('runDoctor and the checks the runtime registers', () => {
  it('runs them after the store, in the order they were registered', async () => {
    const report = await runDoctor(fakeStore(healthy({ id: 'wal', ok: true })), {
      ...OPTIONS,
      checks: [
        source({ id: 'config', status: 'ok', detail: '/home/me/.second_brain/config.toml' }),
        source({ id: 'shim', status: 'fail', detail: 'no shim' }),
        source({ id: 'node-path', status: 'skip' }),
      ],
    });

    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'wal',
      'schema-version',
      'config',
      'shim',
      'node-path',
    ]);
    expect(report.checks.at(-1)).toEqual({ id: 'node-path', status: 'skip' });
  });

  it('runs them even when the store could not be reached', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' }),
      { ...OPTIONS, checks: [source({ id: 'shim', status: 'ok' })] },
    );

    expect(report.checks.map((check) => check.id)).toEqual(['db', 'shim']);
  });

  it('turns a check that throws into that id failing, and keeps going', async () => {
    const report = await runDoctor(fakeStore(healthy()), {
      ...OPTIONS,
      checks: [
        {
          id: 'shim',
          run: async () => {
            throw new Error('EACCES: permission denied\n    at readFile');
          },
        },
        source({ id: 'node-version', status: 'ok', detail: '24.16.0' }),
      ],
    });

    expect(report.checks.find((check) => check.id === 'shim')).toEqual({
      id: 'shim',
      status: 'fail',
      // One line: the stack is not a detail anybody can act on.
      detail: 'EACCES: permission denied',
    });
    expect(report.checks.at(-1)).toMatchObject({ id: 'node-version', status: 'ok' });
  });

  it('does not throw when a check rejects with something that is not an error', async () => {
    const report = await runDoctor(fakeStore(healthy()), {
      ...OPTIONS,
      checks: [{ id: 'shim', run: async (): Promise<DoctorCheck> => Promise.reject('nope') }],
    });

    expect(report.checks.at(-1)).toEqual({ id: 'shim', status: 'fail', detail: 'nope' });
  });
});

describe('createBrain', () => {
  it('wires doctor to the store, with the schema version and the checks', async () => {
    const store = fakeStore(healthy({ id: 'vector', ok: true, detail: '0.8.7' }));
    const brain = createBrain({
      store,
      schemaVersion: CURRENT,
      checks: [source({ id: 'shim', status: 'ok' })],
    });

    const report = await brain.admin.doctor();
    expect(report.checks.map((check) => check.id)).toEqual([
      'db',
      'vector',
      'schema-version',
      'shim',
    ]);

    await brain.close();
    expect(store.closed()).toBe(1);
  });

  it('registers nothing when no check was handed in', async () => {
    const brain = createBrain({ store: fakeStore(healthy()), schemaVersion: CURRENT });

    const report = await brain.admin.doctor();
    expect(report.checks.map((check) => check.id)).toEqual(['db', 'schema-version']);
  });
});
