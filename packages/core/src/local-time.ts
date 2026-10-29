/** Calendar arithmetic and IANA recurrence rules, independent of the host zone. */
const formatters = new Map<string, Intl.DateTimeFormat>();
function wall(instant: Date, zone: string): string {
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(instant).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
export function isLocalTime(value: string): boolean { return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value); }
export function localDateOf(instant: Date, timeZone: string): string { return wall(instant, timeZone).slice(0, 10); }
export function addLocalDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
function offset(at: number, zone: string): number {
  return Date.parse(`${wall(new Date(at), zone)}Z`) - at;
}
const occurrences = new Map<string, number>();
/** A fold chooses its first instant; a gap chooses the transition itself. */
export function occurrenceAt(date: string, localTime: string, timeZone: string): Date {
  if (!isLocalTime(localTime)) throw new TypeError('잘못된 현지 시각입니다');
  const key = `${date}/${localTime}/${timeZone}`;
  const cached = occurrences.get(key);
  if (cached !== undefined) return new Date(cached);
  const desired = `${date}T${localTime}:00`;
  const nominal = Date.parse(`${desired}Z`);
  const offsets = new Set<number>();
  const transitions: number[] = [];
  let prior = nominal - 48 * 3_600_000;
  let priorOffset = offset(prior, timeZone);
  offsets.add(priorOffset);
  for (let at = prior + 6 * 3_600_000; at <= nominal + 48 * 3_600_000; at += 6 * 3_600_000) {
    const current = offset(at, timeZone); offsets.add(current);
    if (current !== priorOffset) {
      let low = prior; let high = at;
      while (high - low > 1000) {
        const mid = Math.floor((low + high) / 2000) * 1000;
        if (offset(mid, timeZone) === priorOffset) low = mid; else high = mid;
      }
      transitions.push(high);
    }
    prior = at; priorOffset = current;
  }
  const matches = [...offsets].map(value => nominal - value).filter(at => wall(new Date(at), timeZone) === desired);
  const result = matches.length ? Math.min(...matches) : transitions.find(at =>
    wall(new Date(at - 1000), timeZone) < desired && wall(new Date(at), timeZone) > desired);
  if (result === undefined) throw new RangeError('현지 날짜의 발화 시각을 계산할 수 없습니다');
  if (occurrences.size > 4096) occurrences.clear();
  occurrences.set(key, result);
  return new Date(result);
}
export function nextDailyOccurrence(after: Date, localTime: string, timeZone: string): Date {
  let date = addLocalDays(localDateOf(after, timeZone), -1);
  for (;;) {
    const instant = occurrenceAt(date, localTime, timeZone);
    if (instant > after) return instant;
    date = addLocalDays(date, 1);
  }
}
export function dailyOccurrenceDates(fromInstant: Date, through: Date, localTime: string, timeZone: string): { from: string; to: string } | null {
  let date = addLocalDays(localDateOf(fromInstant, timeZone), -1);
  const end = localDateOf(through, timeZone);
  let from: string | null = null; let to: string | null = null;
  while (date <= end) {
    const instant = occurrenceAt(date, localTime, timeZone);
    if (instant >= fromInstant && instant <= through) { from ??= date; to = date; }
    date = addLocalDays(date, 1);
  }
  return from === null || to === null ? null : { from, to };
}
