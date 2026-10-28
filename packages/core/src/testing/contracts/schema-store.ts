import type { SchemaVersions } from '../../schema.js';
import type { ReadSchemaVersionsResult, SchemaStore } from '../../ports/store.js';
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
export function schemaStoreContract(highestVersions?: SchemaVersions): ContractCase<SchemaStore>[] {
  return [
    contractCase<SchemaStore>(
      'readSchemaVersions answers with a well formed value instead of throwing',
      async (make) => {
        await withSubject(make, async (store) => {
          assertReadSchemaVersions(await store.readSchemaVersions());
        });
      },
    ),

    contractCase<SchemaStore>('readSchemaVersions can be asked twice', async (make) => {
      await withSubject(make, async (store) => {
        const first = await store.readSchemaVersions();
        const second = await store.readSchemaVersions();
        assertReadSchemaVersions(second);
        assertEqual(
          second.ok,
          first.ok,
          'two schema reads of the same store disagreed about reachability',
        );
        if (first.ok && second.ok) {
          assertEqual(
            JSON.stringify(Object.entries(second.versions).sort(([a], [b]) => a.localeCompare(b))),
            JSON.stringify(Object.entries(first.versions).sort(([a], [b]) => a.localeCompare(b))),
            'reading the schema version twice gave two different versions',
          );
        }
      });
    }),

    ...(highestVersions === undefined ? [] : [
      contractCase<SchemaStore>('readSchemaVersions reports each owner’s highest applied version', async make => {
        await withSubject(make, async store => {
          const read = await store.readSchemaVersions();
          assertTrue(read.ok, 'the seeded schema must be readable');
          if (!read.ok) return;
          for (const [owner, highest] of Object.entries(highestVersions)) {
            assertEqual(read.versions[owner]?.version, highest, `highest version for ${owner}`);
          }
        });
      }),
    ]),

    contractCase<SchemaStore>('close releases the store', async (make) => {
      const store = await make();
      await store.close();
    }),
  ];
}

/** The shape `ReadSchemaVersionsResult` promises, whichever branch comes back. */
export function assertReadSchemaVersions(result: ReadSchemaVersionsResult): void {
  if (result.ok) {
    assertTrue(typeof result.versions === 'object' && result.versions !== null, 'schema versions must be a map');
    for (const [owner, version] of Object.entries(result.versions)) {
      assertNonEmptyString(owner, 'schema owner must have a name');
      assertInteger(version.version, 'the highest stored owner version must be an integer');
      assertTrue(version.version > 0, 'the highest stored owner version must be positive');
      assertValidDate(version.appliedAt, 'an owner version must say when it was applied');
    }
    return;
  }

  if (result.code !== 'DB_UNAVAILABLE' && result.code !== 'DB_LOCKED') {
    fail(`an unreachable store must answer with DB_UNAVAILABLE or DB_LOCKED, got ${result.code}`);
  }
  assertNonEmptyString(result.message, 'a failed schema read must say why');
}
