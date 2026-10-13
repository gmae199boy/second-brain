import type { IdGen } from 'second_brain';
import { v7 as uuidV7 } from 'uuid';

/**
 * The Runtime's `IdGen`: UUIDv7, minted by the side that creates the row, so
 * no record ever waits for the database to name it (AD-8). `uuid`'s v7 keeps a
 * counter inside a millisecond, which is what keeps ids made in the same
 * millisecond sorted in creation order.
 */
export function uuidV7IdGen(): IdGen {
  return {
    next: () => uuidV7(),
  };
}
