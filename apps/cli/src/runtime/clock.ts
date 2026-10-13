import type { Clock } from 'second_brain';

/**
 * The Runtime's `Clock`: the one place the system clock is read (AD-1). Every
 * instant it hands out is absolute, and whoever records an event asks for it
 * once and carries that value through, so a spooled record keeps the time it
 * was first given (AD-9, AD-13).
 */
export const systemClock: Clock = {
  now: () => new Date(),
};
