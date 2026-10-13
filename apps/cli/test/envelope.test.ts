// The offset in `now` comes from the local zone, so pin the zone before the
// first `Date` is built. Node re-reads `TZ` on each conversion, which is what
// makes the snapshot below exact rather than machine-dependent.
process.env.TZ = 'Asia/Seoul';

import { describe, expect, it } from 'vitest';
import { fixedClock, steppingClock } from 'second_brain/testing';
import { errorEnvelope, isoWithOffset, okEnvelope } from '../src/envelope.js';

const INSTANT = new Date('2026-01-02T03:04:05.678Z');

describe('the ok envelope', () => {
  it('matches the shape of the Conventions table, at the instant of the clock', () => {
    expect(okEnvelope(fixedClock(INSTANT), { checks: [] })).toEqual({
      ok: true,
      now: '2026-01-02T12:04:05.678+09:00',
      data: { checks: [] },
      warnings: [],
    });
  });

  it('carries the warning codes it was given', () => {
    const envelope = okEnvelope(fixedClock(INSTANT), null, ['DB_UNAVAILABLE', 'SCHEMA_MISMATCH']);

    expect(envelope.warnings).toEqual(['DB_UNAVAILABLE', 'SCHEMA_MISMATCH']);
    expect(envelope.error).toBeUndefined();
  });

  it('copies the warnings, so the caller cannot change a sent envelope', () => {
    const warnings: ('SPOOLED' | 'UNINDEXED')[] = ['SPOOLED'];
    const envelope = okEnvelope(fixedClock(INSTANT), null, warnings);

    warnings.push('UNINDEXED');

    expect(envelope.warnings).toEqual(['SPOOLED']);
  });
});

describe('the error envelope', () => {
  it('matches the shape of the Conventions table and carries no data', () => {
    expect(errorEnvelope(fixedClock(INSTANT), 'CONFIG_MISSING', 'no config.toml')).toEqual({
      ok: false,
      now: '2026-01-02T12:04:05.678+09:00',
      warnings: [],
      error: { code: 'CONFIG_MISSING', message: 'no config.toml' },
    });
  });

  it('still reports the warnings collected before the failure', () => {
    const envelope = errorEnvelope(fixedClock(INSTANT), 'SCHEMA_MISMATCH', 'at 2, expected 1', [
      'CONFIG_UNKNOWN_KEY',
      'SCHEMA_MISMATCH',
    ]);

    expect(envelope.warnings).toEqual(['CONFIG_UNKNOWN_KEY', 'SCHEMA_MISMATCH']);
    expect(envelope.data).toBeUndefined();
  });
});

describe('the envelope time', () => {
  it('comes from the clock, never from the system clock', () => {
    const clock = steppingClock(INSTANT, 1000);

    expect(okEnvelope(clock, null).now).toBe('2026-01-02T12:04:05.678+09:00');
    expect(okEnvelope(clock, null).now).toBe('2026-01-02T12:04:06.678+09:00');
  });

  it('is an ISO-8601 instant with the offset, that parses back to the same time', () => {
    for (const instant of [INSTANT, new Date('1999-12-31T23:59:59.001Z'), new Date(0)]) {
      const formatted = isoWithOffset(instant);

      expect(formatted).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/);
      expect(new Date(formatted).getTime()).toBe(instant.getTime());
    }
  });
});
