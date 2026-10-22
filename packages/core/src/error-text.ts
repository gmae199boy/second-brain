/** First message line, preserving empty messages and the original fallback. */
export function errorLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? '알 수 없는 오류';
}

/** Message, code, then name; non-Errors keep their complete string value. */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [error.message, typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? '알 수 없는 오류';
}
