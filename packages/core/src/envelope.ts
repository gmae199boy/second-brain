import { errorCodeSpec, type FailureExit, type WarningCode } from './codes.js';
import { maskOutputValue } from './output/mask.js';
import type { Clock } from './ports/clock.js';

/**
 * The response envelope of the Conventions table, as a surface-neutral codec.
 *
 * It lives in Core rather than in the CLI because three surfaces answer with
 * this exact shape — `brain … --json`, the daemon socket and the MCP server —
 * and a second rendering of it is how two of them come to disagree about what
 * an error looks like (AD-5). Nothing here knows about a command line: the one
 * thing only a CLI can render, the argv of `error.retry`, is the CLI's own
 * (`apps/cli/src/envelope.ts`).
 *
 * It is also the `envelope` output codec (AD-11, 마스킹 B): `data`, `warnings`,
 * `meta` and `error` are masked value by value as the envelope is built, so
 * the three surfaces are covered at the one point they share and a new command
 * is covered by existing. `now` is not masked — it is this clock's instant and
 * never a caller's text.
 */

/** A call to one verb, as `error.retry` and `meta.next` name it. */
export interface VerbCall {
  ns: string;
  verb: string;
  /**
   * The verb's own input, by key. Only what the caller actually gave, plus
   * whatever the failure is asking to be added: defaults and output flags are
   * not input, and a secret is never echoed back (Conventions).
   */
  args: Record<string, unknown>;
}

/**
 * A command that did not produce a result, before the envelope fills in what
 * the code already decides. Everything but `code` and `message` is optional,
 * because the code table answers for all of it unless this one failure knows
 * better: an explicit `exit` wins, which is how a failure that has always
 * exited 1 keeps doing so under a code the table puts at 2.
 */
export interface Failure {
  /**
   * SCREAMING_SNAKE. One of `ERROR_CODES` for anything Core or the CLI raises;
   * a connector may name its own (`ports/connector.ts`), which is why this is
   * a string and not the union.
   */
  code: string;
  message: string;
  exit?: FailureExit;
  retryable?: boolean;
  hint?: string;
  /** The same call with the confirmation added, for a gated verb. */
  retry?: VerbCall;
}

/** `error` of the envelope: the failure, with every blank filled in. */
export interface EnvelopeError {
  code: string;
  message: string;
  /** The process exit code this failure ends in. Never 0. */
  exit_code: FailureExit;
  /** Whether running it again can work. Absent means nobody knows. */
  retryable?: boolean;
  hint?: string;
  retry?: VerbCall;
}

/** `meta` of the envelope: what the result is, beside the result itself. */
export interface EnvelopeMeta {
  hint?: string;
  count?: number;
  has_more?: boolean;
  omitted?: { count: number; reason: string };
  /** The call that carries on from here — the next page, the next step. */
  next?: VerbCall;
}

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
  meta?: EnvelopeMeta;
}

/** The command ran. Item-level problems travel in `data` and `warnings`. */
export function okEnvelope<T>(
  clock: Clock,
  data: T,
  warnings: readonly WarningCode[] = [],
  meta?: EnvelopeMeta,
): Envelope<T> {
  const envelope: Envelope<T> = {
    ok: true,
    now: isoWithOffset(clock.now()),
    data: maskOutputValue(data),
    warnings: maskOutputValue([...warnings]),
  };
  if (meta !== undefined) envelope.meta = maskOutputValue(meta);
  return envelope;
}

/**
 * The command could not run, or ran and failed outright. No `data`, and the
 * warnings that were already collected still travel: a configuration warning
 * is worth saying even when the command then refused to run.
 *
 * What the failure left out comes from the code table, so `exit_code` and the
 * hint are the same for a code wherever it is raised. A code the table does not
 * know — a connector's own — exits 1 and carries no hint: inventing one would
 * be this module claiming to know what a connector's failure means.
 */
export function errorEnvelope(
  clock: Clock,
  failure: Failure,
  warnings: readonly WarningCode[] = [],
): Envelope<never> {
  const spec = errorCodeSpec(failure.code);
  const error: EnvelopeError = {
    code: failure.code,
    message: failure.message,
    exit_code: failure.exit ?? spec?.exit ?? 1,
  };

  const retryable = failure.retryable ?? spec?.retryable;
  if (retryable !== undefined) error.retryable = retryable;
  const hint = failure.hint ?? spec?.hint;
  if (hint !== undefined && hint !== '') error.hint = hint;
  if (failure.retry !== undefined) error.retry = failure.retry;

  return {
    ok: false,
    now: isoWithOffset(clock.now()),
    warnings: maskOutputValue([...warnings]),
    // `retry.args` included: that is the caller's own input coming back out.
    error: maskOutputValue(error),
  };
}

/** The key that carries consent through every surface (Conventions). */
export const CONFIRM_ARG = 'confirm';

/**
 * The confirmation gate: `undefined` when this call already carries consent,
 * and the failure to answer with when it does not.
 *
 * It is one function because the shape of that failure — above all `retry`,
 * which is the same call with `confirm: true` added — must be identical for
 * every gated verb (`messages redact`, `files redact`, the data removal of
 * `setup uninstall`, the consent of a non-interactive `setup run`). What is
 * gated, and when, stays with the verb: this decides nothing but the answer.
 *
 * `args` is handed in as the caller actually received it, so `retry` asks for
 * exactly the same command plus the consent — never for a wider or a narrower
 * one, and never for a value the caller did not give.
 */
export function requireConfirmation(call: VerbCall, message?: string): Failure | undefined {
  if (call.args[CONFIRM_ARG] === true) return undefined;
  return {
    code: 'CONFIRMATION_REQUIRED',
    message:
      message ?? `${call.ns} ${call.verb}에는 확인이 필요한데 이 호출은 확인을 주지 않았습니다`,
    // No `exit`, no `retryable` and no `hint`: the code table answers for all
    // three, and a second spelling of them here is a second thing to keep.
    retry: { ns: call.ns, verb: call.verb, args: { ...call.args, [CONFIRM_ARG]: true } },
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
