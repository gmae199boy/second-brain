/**
 * The assertions the contract cases use. They exist because Core may not
 * depend on anything, vitest included (AD-1): a case throws, and whatever
 * runner the adapter uses reports the throw as a failing test.
 */

/** What a violated contract throws. */
export class ContractViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractViolation';
  }
}

/** Fail the case outright. */
export function fail(message: string): never {
  throw new ContractViolation(message);
}

export function assertTrue(condition: boolean, message: string): void {
  if (!condition) fail(message);
}

/** Deep equality for the plain data the ports exchange. */
export function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (!deepEqual(actual, expected)) {
    fail(`${message}\n  expected: ${describeValue(expected)}\n  actual:   ${describeValue(actual)}`);
  }
}

export function assertNotEqual(actual: unknown, unexpected: unknown, message: string): void {
  if (deepEqual(actual, unexpected)) {
    fail(`${message}\n  both sides were: ${describeValue(actual)}`);
  }
}

/** Narrow a result of the `{ ok }` shape to its success branch. */
export function assertOk<T extends { ok: boolean }>(
  result: T,
  message: string,
): asserts result is Extract<T, { ok: true }> {
  if (!result.ok) {
    fail(`${message}: expected a successful result, got ${describeValue(result)}`);
  }
}

/** Narrow a result of the `{ ok }` shape to its failure branch. */
export function assertNotOk<T extends { ok: boolean }>(
  result: T,
  message: string,
): asserts result is Extract<T, { ok: false }> {
  if (result.ok) {
    fail(`${message}: expected a failing result, got ${describeValue(result)}`);
  }
}

export function assertNonEmptyString(value: unknown, message: string): void {
  if (typeof value !== 'string' || value === '') {
    fail(`${message}: expected a non-empty string, got ${describeValue(value)}`);
  }
}

export function assertInteger(value: unknown, message: string): void {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    fail(`${message}: expected an integer, got ${describeValue(value)}`);
  }
}

export function assertFiniteNumber(value: unknown, message: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail(`${message}: expected a finite number, got ${describeValue(value)}`);
  }
}

export function assertValidDate(value: unknown, message: string): void {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    fail(`${message}: expected a valid Date, got ${describeValue(value)}`);
  }
}

/**
 * Structural equality over primitives, `Date`s, arrays and plain objects, the
 * only shapes that cross a port. `NaN` equals `NaN` so a numeric comparison
 * never passes by accident.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left === 'number' && typeof right === 'number') {
    return Number.isNaN(left) && Number.isNaN(right);
  }
  if (typeof left !== 'object' || typeof right !== 'object') return false;
  if (left === null || right === null) return false;

  if (left instanceof Date || right instanceof Date) {
    if (!(left instanceof Date) || !(right instanceof Date)) return false;
    // Through the number branch, so two Invalid Dates compare equal and a
    // deterministic parser that emits one is not called non-deterministic.
    return deepEqual(left.getTime(), right.getTime());
  }

  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    const leftItems = left as readonly unknown[];
    const rightItems = right as readonly unknown[];
    if (leftItems.length !== rightItems.length) return false;
    return leftItems.every((item, index) => deepEqual(item, rightItems[index]));
  }

  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  if (!deepEqual(leftKeys, rightKeys)) return false;
  return leftKeys.every((key) => deepEqual(leftRecord[key], rightRecord[key]));
}

/** One short line for a value, for the message of a failing case. */
export function describeValue(value: unknown): string {
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return 'a function';
  try {
    const text = JSON.stringify(value, (_key, inner: unknown) =>
      inner instanceof Date ? inner.toISOString() : inner,
    );
    return text ?? String(value);
  } catch {
    return String(value);
  }
}
