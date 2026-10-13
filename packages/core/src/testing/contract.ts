/**
 * A contract is data, not a test file: Core may not depend on a test runner
 * (AD-1). Each adapter plugs the cases into its own runner, for example
 *
 * ```ts
 * import { sessionStoreContract } from '@second-brain/core/testing';
 * for (const c of sessionStoreContract()) it(c.name, () => c.run(makeStore));
 * ```
 *
 * `run` throws a `ContractViolation` when the subject breaks the contract.
 */
export interface ContractCase<T> {
  /** Stable, neutral name; the runner uses it as the test name. */
  readonly name: string;
  /** Run the case against subjects the factory makes. */
  run(make: SubjectFactory<T>): Promise<void>;
}

/**
 * Makes a fresh subject. Cases call it once, or more when they need two
 * independent subjects, and every call must hand back unused state.
 */
export type SubjectFactory<T> = () => Promise<T>;

/** Build a case. Keeps the cases below to one line of ceremony. */
export function contractCase<T>(
  name: string,
  run: (make: SubjectFactory<T>) => Promise<void>,
): ContractCase<T> {
  return { name, run };
}

/**
 * Borrow one subject and release it, whatever the case does with it. Subjects
 * that have a `close` are closed; the ones that hold nothing (a parser, a
 * clock) need no teardown. A `close` that throws fails the case too, unless the
 * case was already failing, whose error is the more interesting one.
 */
export async function withSubject<T>(
  make: SubjectFactory<T>,
  use: (subject: T) => Promise<void>,
): Promise<void> {
  const subject = await make();
  let used = false;
  try {
    await use(subject);
    used = true;
  } finally {
    const closing = close(subject);
    if (used) {
      await closing;
    } else {
      await closing.catch(() => undefined);
    }
  }
}

async function close(subject: unknown): Promise<void> {
  if (typeof subject !== 'object' || subject === null) return;
  const closer = (subject as { close?: unknown }).close;
  if (typeof closer !== 'function') return;
  await (closer as () => unknown).call(subject);
}
