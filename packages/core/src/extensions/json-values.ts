/** Detect numbers that JSON.stringify would silently convert to null. */
export function hasOnlyFiniteNumbers(value: unknown): boolean {
  const pending = [value], seen = new WeakSet<object>();
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'number' && !Number.isFinite(item)) return false;
    if (item !== null && typeof item === 'object') {
      if (seen.has(item)) continue;
      seen.add(item);
      for (const value of Object.values(item)) pending.push(value);
    }
  }
  return true;
}
