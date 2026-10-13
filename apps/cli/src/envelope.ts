import type { Clock, WarningCode } from 'second_brain';

/**
 * The `--json` response envelope of the Conventions table. Every command gets
 * one from the dispatcher, so no command assembles its own: that is the only
 * way thirty commands keep the same shape.
 */
export interface Envelope<T> {
  ok: boolean;
  /** ISO-8601 with the offset, from the Clock — never from `new Date()` here. */
  now: string;
  data?: T;
  /** Degraded results say so with a code; silence is not an option (NFR-2). */
  warnings: WarningCode[];
  error?: EnvelopeError;
}

export interface EnvelopeError {
  code: string;
  message: string;
}

/** The command ran. Item-level problems travel in `data` and `warnings`. */
export function okEnvelope<T>(
  clock: Clock,
  data: T,
  warnings: readonly WarningCode[] = [],
): Envelope<T> {
  return { ok: true, now: isoWithOffset(clock.now()), data, warnings: [...warnings] };
}

/**
 * The command could not run, or ran and failed outright. No `data`, and the
 * warnings that were already collected still travel: a configuration warning
 * is worth saying even when the command then refused to run.
 */
export function errorEnvelope(
  clock: Clock,
  code: string,
  message: string,
  warnings: readonly WarningCode[] = [],
): Envelope<never> {
  return {
    ok: false,
    now: isoWithOffset(clock.now()),
    warnings: [...warnings],
    error: { code, message },
  };
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
