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

/** Explicit time advancement wakes all elapsed or aborted sleeps. */
export function manualTime(start: Date): { clock: Clock; timer: import('../../ports/clock.js').Timer; advance(ms: number): void } {
  let now = start.getTime();
  const pending = new Set<{ at: number; done(): void }>();
  return {
    clock: { now: () => new Date(now) },
    timer: { sleep(ms, signal) {
      if (signal.aborted || ms <= 0) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const entry = { at: now + ms, done() { pending.delete(entry); signal.removeEventListener('abort', entry.done); resolve(); } };
        pending.add(entry);
        signal.addEventListener('abort', entry.done, { once: true });
      });
    } },
    advance(ms) { now += ms; for (const entry of [...pending]) if (entry.at <= now) entry.done(); },
  };
}
