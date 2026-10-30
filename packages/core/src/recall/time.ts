/** 시간대가 있는 유효한 ISO 시각만 외부 구간과 커서에 받는다. */
export function validRecallTime(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!match) return false;
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year), m = Number(month), d = Number(day);
  if (m < 1 || m > 12 || d < 1 || d > new Date(Date.UTC(y, m, 0)).getUTCDate() || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return false;
  if (zone !== 'Z' && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4, 6)) > 59)) return false;
  return Number.isFinite(Date.parse(value));
}
