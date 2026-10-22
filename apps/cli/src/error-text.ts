/** The first trimmed line; an empty first line stays empty. */
export function oneLine(text: string): string {
  return text.split('\n')[0]?.trim() ?? '';
}

/** Trim only the message candidate, keeping code and name untouched. */
export function describeErrorLine(error: unknown): string {
  if (!(error instanceof Error)) return oneLine(String(error));
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [oneLine(error.message), typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? '알 수 없는 오류';
}
