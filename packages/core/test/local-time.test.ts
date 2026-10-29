import { expect, it } from 'vitest';
import { addLocalDays, dailyOccurrenceDates, isLocalTime, localDateOf, nextDailyOccurrence, occurrenceAt } from '../src/local-time.js';

it('uses local calendar dates and validates HH:MM', () => {
  expect(localDateOf(new Date('2026-10-28T15:00:00Z'), 'Asia/Seoul')).toBe('2026-10-29');
  expect(addLocalDays('2026-12-31', 1)).toBe('2027-01-01');
  expect(addLocalDays('2028-02-28', 1)).toBe('2028-02-29');
  for (const value of ['00:00', '11:00', '23:59']) expect(isLocalTime(value)).toBe(true);
  for (const value of ['24:00', '9:00', '12:60', '11:00\n', '']) expect(isLocalTime(value)).toBe(false);
});
it('maps Seoul wall time and finds the strictly next occurrence at boundaries', () => {
  const at = new Date('2026-10-29T02:00:00Z');
  expect(occurrenceAt('2026-10-29', '11:00', 'Asia/Seoul')).toEqual(at);
  expect(nextDailyOccurrence(new Date(at.getTime() - 1), '11:00', 'Asia/Seoul')).toEqual(at);
  for (const after of [at, new Date(at.getTime() + 1)])
    expect(nextDailyOccurrence(after, '11:00', 'Asia/Seoul')).toEqual(new Date('2026-10-30T02:00:00Z'));
  expect(dailyOccurrenceDates(at, new Date('2026-11-01T03:00:00Z'), '11:00', 'Asia/Seoul')).toEqual({ from: '2026-10-29', to: '2026-11-01' });
  expect(dailyOccurrenceDates(new Date(at.getTime() + 1), new Date(at.getTime() + 2), '11:00', 'Asia/Seoul')).toBeNull();
});
it('chooses the first valid instant after a New York gap', () => {
  expect(occurrenceAt('2026-03-08', '02:30', 'America/New_York')).toEqual(new Date('2026-03-08T07:00:00Z'));
  expect(nextDailyOccurrence(new Date('2026-03-08T07:00:00Z'), '02:30', 'America/New_York')).toEqual(new Date('2026-03-09T06:30:00Z'));
});
it('chooses the first fold instant and skips its second occurrence', () => {
  expect(occurrenceAt('2026-11-01', '01:30', 'America/New_York')).toEqual(new Date('2026-11-01T05:30:00Z'));
  for (const after of ['2026-11-01T05:30:00Z', '2026-11-01T06:00:00Z', '2026-11-01T06:30:00Z'])
    expect(nextDailyOccurrence(new Date(after), '01:30', 'America/New_York')).toEqual(new Date('2026-11-02T06:30:00Z'));
});
it.each([
  ['2026-10-04', '02:15', '2026-10-03T15:30:00Z', '2026-10-04T15:15:00Z'],
  ['2026-04-05', '01:45', '2026-04-04T14:45:00Z', '2026-04-05T15:15:00Z'],
])('uses the first instant of the Lord Howe half-hour gap/fold on %s', (date, time, instant, following) => {
  const zone = 'Australia/Lord_Howe'; const at = new Date(instant);
  const before = new Date(at.getTime() - 1); const after = new Date(at.getTime() + 1);
  expect(occurrenceAt(date, time, zone)).toEqual(at);
  expect(nextDailyOccurrence(before, time, zone)).toEqual(at);
  expect(nextDailyOccurrence(at, time, zone)).toEqual(new Date(following));
  expect(nextDailyOccurrence(after, time, zone)).toEqual(new Date(following));
  expect(dailyOccurrenceDates(before, before, time, zone)).toBeNull();
  expect(dailyOccurrenceDates(at, at, time, zone)).toEqual({ from: date, to: date });
  expect(dailyOccurrenceDates(after, new Date(new Date(following).getTime() - 1), time, zone)).toBeNull();
  expect(dailyOccurrenceDates(at, new Date(following), time, zone)).toEqual({ from: date, to: addLocalDays(date, 1) });
});
it('maps the skipped Apia date to the first valid instant and respects recurrence boundaries', () => {
  const zone = 'Pacific/Apia'; const at = new Date('2011-12-30T10:00:00Z');
  const before = new Date(at.getTime() - 1); const after = new Date(at.getTime() + 1);
  const following = new Date('2011-12-30T21:00:00Z');
  expect(localDateOf(before, zone)).toBe('2011-12-29');
  expect(localDateOf(at, zone)).toBe('2011-12-31');
  for (const time of ['00:00', '11:00', '23:59'])
    expect(occurrenceAt('2011-12-30', time, zone)).toEqual(at);
  expect(nextDailyOccurrence(before, '11:00', zone)).toEqual(at);
  expect(nextDailyOccurrence(at, '11:00', zone)).toEqual(following);
  expect(nextDailyOccurrence(after, '11:00', zone)).toEqual(following);
  expect(dailyOccurrenceDates(before, before, '11:00', zone)).toBeNull();
  expect(dailyOccurrenceDates(at, at, '11:00', zone)).toEqual({ from: '2011-12-30', to: '2011-12-30' });
  expect(dailyOccurrenceDates(after, new Date(following.getTime() - 1), '11:00', zone)).toBeNull();
  expect(dailyOccurrenceDates(at, following, '11:00', zone)).toEqual({ from: '2011-12-30', to: '2011-12-31' });
});
