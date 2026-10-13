import type { Clock } from '../../ports/clock.js';

/** A clock stuck at one instant. Hands back a fresh `Date` every call. */
export function fixedClock(instant: Date): Clock {
  const time = instant.getTime();
  return { now: () => new Date(time) };
}

/**
 * A clock that steps forward by a fixed amount per call, starting at `start`.
 * Like every fake in here it only ever uses values the caller supplied (AD-1).
 */
export function steppingClock(start: Date, stepMs: number): Clock {
  let time = start.getTime();
  return {
    now(): Date {
      const current = new Date(time);
      time += stepMs;
      return current;
    },
  };
}
