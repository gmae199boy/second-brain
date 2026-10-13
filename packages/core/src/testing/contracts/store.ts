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
    const { vector } = health;
    assertTrue(
      typeof vector === 'object' && vector !== null,
      'a healthy store must report the vector capability',
    );
    for (const field of ['available', 'installed'] as const) {
      const value = vector[field];
      if (value !== null) {
        assertNonEmptyString(value, `vector.${field} must be a version or null`);
      }
    }
    return;
  }

  if (health.code !== 'DB_UNAVAILABLE') {
    fail(`an unreachable store must answer with DB_UNAVAILABLE, got ${health.code}`);
  }
  assertNonEmptyString(health.message, 'a failed health probe must say why');
}
