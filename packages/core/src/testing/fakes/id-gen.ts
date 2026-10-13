import type { IdGen } from '../../ports/id-gen.js';

export interface SequenceIdGenOptions {
  /**
   * The millisecond the ids carry. The fake uses only what the caller gives
   * it: nothing here reads the system clock or any randomness (AD-1).
   */
  timestampMs: number;
  /** First counter value. Defaults to 0. */
  start?: number;
}

/**
 * A deterministic UUIDv7 generator: the timestamp the caller named plus a
 * counter, so ids are unique and sort in the order they were made, which is
 * exactly what `idGenContract` asks of a real one. The counter rolls into the
 * timestamp once it fills its 12 bits, so order holds past 4,096 ids.
 */
export function sequenceIdGen(options: SequenceIdGenOptions): IdGen {
  const { timestampMs, start = 0 } = options;
  let counter = start;

  return {
    next(): string {
      const current = counter;
      counter += 1;

      const timestamp = timestampMs + Math.floor(current / 0x1000);
      const low = current % 0x1000;
      const stamp = hex(timestamp, 12);
      const tail = hex(current, 12);

      return (
        `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7${hex(low, 3)}-8${hex(low, 3)}-${tail}`
      );
    },
  };
}

function hex(value: number, width: number): string {
  return Math.trunc(value).toString(16).padStart(width, '0').slice(-width);
}
