import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { runDoctor } from '../src/admin/doctor.js';
import type { HealthStore, StoreHealth, StoreProbe } from '../src/ports/store.js';

/** A reachable store whose source answered with exactly these probes. */
function healthy(...probes: StoreProbe[]): StoreHealth {
  return {
    ok: true,
    serverVersion: '18.1',
    source: { location: 'db.example:5432/brain', probes },
  };
}

function fakeStore(health: StoreHealth): HealthStore & { closed: () => number } {
  let closes = 0;
  return {
    checkHealth: async () => health,
    close: async () => {
      closes += 1;
    },
    closed: () => closes,
  };
}

describe('runDoctor', () => {
  it('reports db and vector as ok when the store is healthy', async () => {
    const report = await runDoctor(
      fakeStore(healthy({ id: 'vector', ok: true, detail: '0.8.7' })),
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'vector', status: 'ok', detail: '0.8.7' },
    ]);
  });

  it('fails the vector check and names the available version when it is not installed', async () => {
    const report = await runDoctor(
      fakeStore(
        healthy({ id: 'vector', ok: false, detail: 'not installed (available: 0.8.7)' }),
      ),
    );

    expect(report.checks[0]).toEqual({ id: 'db', status: 'ok', detail: '18.1' });
    expect(report.checks[1]).toMatchObject({ id: 'vector', status: 'fail' });
    expect(report.checks[1]?.detail).toContain('0.8.7');
    expect(report.checks[1]?.code).toBeUndefined();
  });

  it('reports the db check alone and carries the code when the store is unavailable', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED 127.0.0.1:54329' }),
    );

    // Nothing was probed, so there is no probe to report on.
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
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'wal', status: 'ok', detail: 'wal' },
      { id: 'fts5-trigram', status: 'fail', detail: 'no such tokenizer' },
      { id: 'foreign-keys', status: 'ok' },
    ]);
  });

  it('reports the db check alone when a healthy source ran no probes', async () => {
    const report = await runDoctor(fakeStore(healthy()));

    expect(report.checks).toEqual([{ id: 'db', status: 'ok', detail: '18.1' }]);
  });

  it('does not throw when the store is unavailable', async () => {
    await expect(
      runDoctor(fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' })),
    ).resolves.toBeDefined();
  });
});

describe('createBrain', () => {
  it('wires doctor to the store and closes it', async () => {
    const store = fakeStore(healthy({ id: 'vector', ok: true, detail: '0.8.7' }));
    const brain = createBrain({ store });

    const report = await brain.admin.doctor();
    expect(report.checks.map((check) => check.id)).toEqual(['db', 'vector']);

    await brain.close();
    expect(store.closed()).toBe(1);
  });
});
