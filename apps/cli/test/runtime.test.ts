import { describe, expect, it } from 'vitest';
import { clockContract, idGenContract, isUuidV7 } from 'second_brain/testing';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

/**
 * The Runtime side of the frame: the same contract cases Core hands to every
 * adapter, run against the real system clock and the real UUIDv7 generator
 * (AD-1: the implementations live here, the contract lives in Core).
 */
describe('systemClock satisfies the clock contract', () => {
  for (const testCase of clockContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => systemClock);
    });
  }
});

describe('uuidV7IdGen satisfies the id contract', () => {
  for (const testCase of idGenContract()) {
    it(testCase.name, async () => {
      await testCase.run(async () => uuidV7IdGen());
    });
  }

  it('mints a thousand ids inside one millisecond that still sort in order', () => {
    const idGen = uuidV7IdGen();
    const startedAt = Date.now();
    const ids = Array.from({ length: 1000 }, () => idGen.next());
    const elapsed = Date.now() - startedAt;

    expect(ids.every((id) => isUuidV7(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    // The burst is meant to land inside a millisecond or two; the point of the
    // case is that the ordering holds even then.
    expect(elapsed).toBeLessThan(1000);
  });

  it('carries the current time in the timestamp half of the id', () => {
    const before = Date.now();
    const id = uuidV7IdGen().next();
    const after = Date.now();

    const timestamp = Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
    expect(timestamp).toBeGreaterThanOrEqual(before);
    expect(timestamp).toBeLessThanOrEqual(after);
  });
});

describe('systemClock', () => {
  it('reads the system clock when asked, never at import time (AD-3)', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
