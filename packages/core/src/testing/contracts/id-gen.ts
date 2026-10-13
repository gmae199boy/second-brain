import type { IdGen } from '../../ports/id-gen.js';
import { assertEqual, assertTrue, fail } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { isUuidV7 } from '../uuid-v7.js';

/** The burst the contract checks: a thousand ids inside one millisecond. */
const BURST = 1000;

/**
 * The id contract. Ids are UUIDv7 so they are unique without coordination and
 * sort in the order they were created, which is what makes them usable as
 * primary keys the writing side mints (AD-8).
 */
export function idGenContract(): ContractCase<IdGen>[] {
  return [
    contractCase<IdGen>('a thousand ids in a row are all UUIDv7', async (make) => {
      await withSubject(make, async (idGen) => {
        for (const id of take(idGen, BURST)) {
          if (!isUuidV7(id)) {
            fail(`not a canonical UUIDv7: ${id}`);
          }
        }
      });
    }),

    contractCase<IdGen>('a thousand ids in a row are all different', async (make) => {
      await withSubject(make, async (idGen) => {
        const ids = take(idGen, BURST);
        assertEqual(
          new Set(ids).size,
          BURST,
          'the generator repeated an id inside one millisecond',
        );
      });
    }),

    contractCase<IdGen>('ids sort in the order they were made', async (make) => {
      await withSubject(make, async (idGen) => {
        const ids = take(idGen, BURST);
        for (const [position, id] of ids.entries()) {
          const previous = ids[position - 1];
          if (previous === undefined) continue;
          assertTrue(
            previous < id,
            `ids are not monotonic: ${previous} came before ${id}`,
          );
        }
      });
    }),
  ];
}

function take(idGen: IdGen, count: number): string[] {
  return Array.from({ length: count }, () => idGen.next());
}
