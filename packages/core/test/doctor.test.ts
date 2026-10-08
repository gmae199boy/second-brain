import { describe, expect, it } from 'vitest';
import { createBrain } from '../src/brain.js';
import { runDoctor } from '../src/admin/doctor.js';
import type { Store, StoreHealth } from '../src/ports/store.js';

function fakeStore(health: StoreHealth): Store & { closed: () => number } {
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
      fakeStore({ ok: true, serverVersion: '18.1', vector: { available: '0.8.7', installed: '0.8.7' } }),
    );

    expect(report.checks).toEqual([
      { id: 'db', status: 'ok', detail: '18.1' },
      { id: 'vector', status: 'ok', detail: '0.8.7' },
    ]);
  });

  it('fails the vector check and names the available version when it is not installed', async () => {
    const report = await runDoctor(
      fakeStore({ ok: true, serverVersion: '18.1', vector: { available: '0.8.7', installed: null } }),
    );

    expect(report.checks[0]).toEqual({ id: 'db', status: 'ok', detail: '18.1' });
    expect(report.checks[1]).toMatchObject({ id: 'vector', status: 'fail' });
    expect(report.checks[1]?.detail).toContain('0.8.7');
    expect(report.checks[1]?.code).toBeUndefined();
  });

  it('skips the vector check and carries the code when the store is unavailable', async () => {
    const report = await runDoctor(
      fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'connect ECONNREFUSED 127.0.0.1:54329' }),
    );

    expect(report.checks).toEqual([
      {
        id: 'db',
        status: 'fail',
        code: 'DB_UNAVAILABLE',
        detail: 'connect ECONNREFUSED 127.0.0.1:54329',
      },
      { id: 'vector', status: 'skip' },
    ]);
  });

  it('does not throw when the store is unavailable', async () => {
    await expect(
      runDoctor(fakeStore({ ok: false, code: 'DB_UNAVAILABLE', message: 'down' })),
    ).resolves.toBeDefined();
  });
});

describe('createBrain', () => {
  it('wires doctor to the store and closes it', async () => {
    const store = fakeStore({
      ok: true,
      serverVersion: '18.1',
      vector: { available: '0.8.7', installed: '0.8.7' },
    });
    const brain = createBrain({ store });

    const report = await brain.admin.doctor();
    expect(report.checks.map((check) => check.id)).toEqual(['db', 'vector']);

    await brain.close();
    expect(store.closed()).toBe(1);
  });
});
