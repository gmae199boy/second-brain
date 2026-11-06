// Keep recovery evidence useful without writing connection URLs or home names.
const mask = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s]+/gi, '[REDACTED-URL]').replace(/\/Users\/[^/\s]+/g, '~');

export function serializeError(error, seen = new Set()) {
  if (error !== null && (typeof error === 'object' || typeof error === 'function')) {
    if (seen.has(error)) return { message: '[circular error]' };
    seen.add(error);
    const result = { message: mask(error.message ?? error) };
    if (error instanceof AggregateError) result.errors = Array.from(error.errors, child => serializeError(child, seen));
    if (error.cause !== undefined) result.cause = serializeError(error.cause, seen);
    seen.delete(error);
    return result;
  }
  return { message: mask(error) };
}
