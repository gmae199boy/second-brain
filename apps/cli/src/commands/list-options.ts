/** The two paged work views share the same bounds. */
export function listLimit(value: unknown): { ok: true; value?: number } | { ok: false; code: 'USAGE'; message: string; exit: 2 } {
  if (value === undefined) return { ok: true };
  const n = Number(value);
  return /^\d+$/.test(String(value)) && Number.isInteger(n) && n >= 1 && n <= 200 ? { ok: true, value: n } :
    { ok: false, code: 'USAGE', message: '목록 한도는 1~200 정수여야 합니다', exit: 2 as const };
}
export function scheduleIdPreflight(context: { args: readonly string[] }) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(context.args[0] ?? '') ? undefined :
    { ok: false as const, code: 'USAGE', message: '예약 id는 UUID여야 합니다', exit: 2 as const };
}
