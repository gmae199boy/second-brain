import { describe, expect, it } from 'vitest';
import { BUSY_TIMEOUT_MS } from '../src/busy-timeout.js';
import { INSTANT_PATTERN, formatInstant, parseInstant } from '../src/instant.js';

describe('formatInstant', () => {
  it('spells an instant in the one canonical form', () => {
    expect(formatInstant(new Date(Date.UTC(2026, 9, 14, 1, 2, 3, 4)))).toEqual({
      ok: true,
      value: '2026-10-14T01:02:03.004Z',
    });
  });

  it('is a value, not a throw, for an Invalid Date', () => {
    const formatted = formatInstant(new Date('nonsense'));

    expect(formatted.ok).toBe(false);
    if (formatted.ok) return;
    expect(formatted.code).toBe('INVALID_INSTANT');
    expect(formatted.message.length).toBeGreaterThan(0);
  });

  it('refuses a year that does not fit four digits', () => {
    // `toISOString` spells this `+275760-09-13T…`: 27 characters, which would
    // not sort against the rest of the column.
    const far = new Date(8.64e15);
    expect(far.toISOString()).toHaveLength(27);

    expect(formatInstant(far)).toMatchObject({ ok: false, code: 'INVALID_INSTANT' });
  });
});

describe('parseInstant', () => {
  it('round-trips the canonical form', () => {
    const text = '2026-10-14T01:02:03.004Z';
    const parsed = parseInstant(text);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toBeInstanceOf(Date);
    expect(formatInstant(parsed.value)).toEqual({ ok: true, value: text });
  });

  it.each([
    ['an offset instead of Z', '2026-10-14T10:02:03.004+09:00'],
    ['no milliseconds', '2026-10-14T01:02:03Z'],
    ['a date alone', '2026-10-14'],
    ['a five-digit year', '+275760-09-13T00:00:00.000Z'],
    ['a space instead of T', '2026-10-14 01:02:03.004Z'],
    ['nothing at all', ''],
  ])('refuses %s as a value', (_name, text) => {
    const parsed = parseInstant(text);

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe('INVALID_INSTANT');
    expect(parsed.message.length).toBeGreaterThan(0);
  });

  it('refuses a string that matches the pattern but names no real instant', () => {
    // `new Date` would happily roll this over into another month.
    expect(parseInstant('2026-13-45T00:00:00.000Z')).toMatchObject({
      ok: false,
      code: 'INVALID_INSTANT',
    });
  });

  it('agrees with the exported pattern', () => {
    expect(INSTANT_PATTERN.test('2026-10-14T01:02:03.004Z')).toBe(true);
    expect(INSTANT_PATTERN.test('2026-10-14T01:02:03Z')).toBe(false);
  });
});

describe('BUSY_TIMEOUT_MS', () => {
  it('gives the turn path a shorter budget than the paths nobody waits on', () => {
    expect(BUSY_TIMEOUT_MS.turn).toBeLessThan(BUSY_TIMEOUT_MS.command);
    expect(BUSY_TIMEOUT_MS.turn).toBeLessThan(BUSY_TIMEOUT_MS.drain);
    for (const budget of Object.values(BUSY_TIMEOUT_MS)) {
      expect(Number.isInteger(budget)).toBe(true);
      expect(budget).toBeGreaterThan(0);
    }
  });
});
