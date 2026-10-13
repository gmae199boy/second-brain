import type { Clock } from '../../ports/clock.js';
import { assertTrue, assertValidDate } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

/**
 * The clock contract. It says only what Core may assume: an absolute instant
 * that never goes backwards, handed over as a value the caller may keep
 * (AD-13).
 */
export function clockContract(): ContractCase<Clock>[] {
  return [
    contractCase<Clock>('now returns a valid absolute instant', async (make) => {
      await withSubject(make, async (clock) => {
        assertValidDate(clock.now(), 'a clock must answer with a Date');
      });
    }),

    contractCase<Clock>('now never goes backwards', async (make) => {
      await withSubject(make, async (clock) => {
        let previous = clock.now().getTime();
        for (let step = 0; step < 100; step += 1) {
          const current = clock.now().getTime();
          assertTrue(
            current >= previous,
            `the clock went backwards: ${String(current)} after ${String(previous)}`,
          );
          previous = current;
        }
      });
    }),

    contractCase<Clock>('each call hands over its own Date', async (make) => {
      await withSubject(make, async (clock) => {
        const first = clock.now();
        const second = clock.now();
        const before = first.getTime();
        // A caller that reads the instant must not be able to move the clock.
        first.setTime(before + 86_400_000);
        assertTrue(
          second.getTime() !== first.getTime() || second !== first,
          'two calls handed over the same mutable Date',
        );
        assertTrue(
          clock.now().getTime() < before + 86_400_000,
          'changing a returned Date changed the clock',
        );
      });
    }),
  ];
}
