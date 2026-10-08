/**
 * The `--json` response envelope from the Conventions table. Temporary home:
 * story 4 moves it next to the dispatcher and the full warning-code set.
 */
export interface Envelope<T> {
  ok: boolean;
  now: string;
  data?: T;
  warnings: string[];
  error?: EnvelopeError;
}

export interface EnvelopeError {
  code: string;
  message: string;
}

/** The command ran. Item-level problems travel in `data` and `warnings`. */
export function okEnvelope<T>(data: T, warnings: string[] = [], now: Date = new Date()): Envelope<T> {
  return { ok: true, now: isoWithOffset(now), data, warnings };
}

/** The command could not run at all. */
export function errorEnvelope(code: string, message: string, now: Date = new Date()): Envelope<never> {
  return { ok: false, now: isoWithOffset(now), warnings: [], error: { code, message } };
}

/** ISO-8601 with the local UTC offset, as the Conventions table requires. */
export function isoWithOffset(date: Date): string {
  const pad = (value: number, width = 2): string =>
    String(Math.floor(Math.abs(value))).padStart(width, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes < 0 ? '-' : '+';
  return (
    `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `.${pad(date.getMilliseconds(), 3)}` +
    `${sign}${pad(offsetMinutes / 60)}:${pad(offsetMinutes % 60)}`
  );
}
