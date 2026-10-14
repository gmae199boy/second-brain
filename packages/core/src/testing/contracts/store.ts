import type { HealthStore, StoreHealth } from '../../ports/store.js';
import {
  assertEqual,
  assertNonEmptyString,
  assertTrue,
  fail,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/**
 * The health capability. Every `Store` adapter passes these, against a live
 * database and against a dead one alike: the point is that the verdict is a
 * value with a known shape, never an exception (AD-10, Conventions).
 */
export function storeContract(): ContractCase<HealthStore>[] {
  return [
    contractCase<HealthStore>(
      'checkHealth answers with a well formed value instead of throwing',
      async (make) => {
        await withSubject(make, async (store) => {
          assertStoreHealth(await store.checkHealth());
        });
      },
    ),

    contractCase<HealthStore>('checkHealth can be asked twice', async (make) => {
      await withSubject(make, async (store) => {
        const first = await store.checkHealth();
        const second = await store.checkHealth();
        assertStoreHealth(second);
        assertEqual(
          second.ok,
          first.ok,
          'two health probes of the same store disagreed about reachability',
        );
      });
    }),

    contractCase<HealthStore>('close releases the store', async (make) => {
      const store = await make();
      await store.close();
    }),
  ];
}

/** The shape `StoreHealth` promises, whichever branch the adapter returns. */
export function assertStoreHealth(health: StoreHealth): void {
  if (health.ok) {
    assertNonEmptyString(health.serverVersion, 'a healthy store must name its server version');
    const { source } = health;
    assertTrue(
      typeof source === 'object' && source !== null,
      'a healthy store must report where its source is',
    );
    assertNonEmptyString(source.location, 'a healthy store must say where its source lives');
    assertTrue(
      Array.isArray(source.probes),
      'a healthy store must report its probes as a list, even an empty one',
    );

    const seen = new Set<string>();
    for (const probe of source.probes) {
      assertNonEmptyString(probe.id, 'every probe must carry a non-empty id');
      assertTrue(!seen.has(probe.id), `two probes share the id ${probe.id}`);
      seen.add(probe.id);
      assertTrue(typeof probe.ok === 'boolean', `probe ${probe.id} must answer with a boolean`);
      if (probe.detail !== undefined) {
        assertNonEmptyString(probe.detail, `probe ${probe.id} must detail something or nothing`);
      }
    }
    return;
  }

  if (health.code !== 'DB_UNAVAILABLE') {
    fail(`an unreachable store must answer with DB_UNAVAILABLE, got ${health.code}`);
  }
  assertNonEmptyString(health.message, 'a failed health probe must say why');
}
