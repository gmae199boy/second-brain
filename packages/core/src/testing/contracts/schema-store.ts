import type { ReadSchemaVersionResult, SchemaStore } from '../../ports/store.js';
import {
  assertEqual,
  assertInteger,
  assertNonEmptyString,
  assertTrue,
  assertValidDate,
  fail,
} from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/**
 * The schema-version capability. The write guard of AD-20 runs before every
 * write, so the one thing it may never do is throw: a database that is not
 * there, and a database that holds no version yet, are both values with a known
 * shape. Reading the version must also change nothing, since a read command
 * that happens to ask must stay a read.
 */
export function schemaStoreContract(): ContractCase<SchemaStore>[] {
  return [
    contractCase<SchemaStore>(
      'readSchemaVersion answers with a well formed value instead of throwing',
      async (make) => {
        await withSubject(make, async (store) => {
          assertReadSchemaVersion(await store.readSchemaVersion());
        });
      },
    ),

    contractCase<SchemaStore>('readSchemaVersion can be asked twice', async (make) => {
      await withSubject(make, async (store) => {
        const first = await store.readSchemaVersion();
        const second = await store.readSchemaVersion();
        assertReadSchemaVersion(second);
        assertEqual(
          second.ok,
          first.ok,
          'two schema reads of the same store disagreed about reachability',
        );
        if (first.ok && second.ok) {
          assertEqual(
            second.version?.version ?? null,
            first.version?.version ?? null,
            'reading the schema version twice gave two different versions',
          );
        }
      });
    }),

    contractCase<SchemaStore>('close releases the store', async (make) => {
      const store = await make();
      await store.close();
    }),
  ];
}

/** The shape `ReadSchemaVersionResult` promises, whichever branch comes back. */
export function assertReadSchemaVersion(result: ReadSchemaVersionResult): void {
  if (result.ok) {
    if (result.version === null) return;
    assertTrue(
      typeof result.version === 'object',
      'a stored schema version must be an object or null',
    );
    assertInteger(result.version.version, 'a stored schema version must be an integer');
    assertTrue(
      result.version.version > 0,
      `a stored schema version must be positive, got ${String(result.version.version)}`,
    );
    assertValidDate(result.version.appliedAt, 'a stored schema version must say when it was applied');
    return;
  }

  if (result.code !== 'DB_UNAVAILABLE') {
    fail(`an unreachable store must answer with DB_UNAVAILABLE, got ${result.code}`);
  }
  assertNonEmptyString(result.message, 'a failed schema read must say why');
}
