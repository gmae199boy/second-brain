import { maskOutputText, maskOutputValue } from '../output/mask.js';

/** 가린 결과의 JSON 코드 포인트 예산. */
export const RECALL_RESULT_BUDGET = 8_000;

export type BudgetResult<T> =
  | { ok: true; data: T[]; omitted: number; truncated: boolean; nextIndex: number | null }
  | { ok: false; code: 'INVALID_ARGUMENT'; message: string };

/**
 * 먼저 가린 뒤 하위 행을 제거하고, 첫 행만 남아도 초과하면 본문을 자른다.
 * target 전용 가리기는 호출자가 이 함수에 전달하기 전에 적용한다.
 * nextIndex는 호출자가 출처 기반 읽기 입력으로 바꾸는 위치다.
 */
export function budgetResults<T>(rows: readonly T[], body: {
  get(row: T): string;
  set(row: T, value: string): T;
}, budget = RECALL_RESULT_BUDGET): BudgetResult<T> {
  const masked = maskOutputValue(rows) as T[];
  const length = (value: readonly T[]) => Array.from(JSON.stringify(value)).length;
  if (!Number.isSafeInteger(budget) || budget < 2) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '결과 예산이 올바르지 않습니다' };
  }
  const data = [...masked];
  while (data.length > 1 && length(data) > budget) data.pop();
  if (length(data) <= budget) {
    return { ok: true, data, omitted: masked.length - data.length, truncated: data.length < masked.length,
      nextIndex: data.length < masked.length ? data.length : null };
  }
  const first = data[0];
  if (first === undefined) return { ok: false, code: 'INVALID_ARGUMENT', message: '결과 출처가 예산을 초과합니다' };
  const chars = Array.from(body.get(first));
  // 가림 표식 내부에서 자르지 않는다.
  const boundaries = new Set<number>();
  const marker = /\[REDACTED:[a-z0-9_]+\]/gu;
  const value = chars.join('');
  for (const match of value.matchAll(marker)) {
    const start = Array.from(value.slice(0, match.index)).length;
    const end = start + Array.from(match[0]).length;
    for (let i = start + 1; i < end; i += 1) boundaries.add(i);
  }
  if (length([body.set(first, '')]) > budget) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: '결과 출처가 예산을 초과합니다' };
  }
  let low = 0, high = chars.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (length([body.set(first, chars.slice(0, mid).join(''))]) <= budget) low = mid;
    else high = mid - 1;
  }
  while (boundaries.has(low)) low -= 1;
  return { ok: true, data: [body.set(first, chars.slice(0, low).join(''))],
    omitted: masked.length - 1, truncated: true, nextIndex: 0 };
}

/** 가린 봉투와 텍스트 메타의 보수적 상한을 함께 계산한다. */
export function boundedResults<T, M>(rows: readonly T[], body: { get(row: T): string; set(row: T, value: string): T }, describe: (result: Extract<BudgetResult<T>, { ok: true }>) => { warnings: readonly ('RESULT_TRUNCATED')[]; meta: M }, text: (rows: readonly T[]) => readonly string[]) {
  let limit = RECALL_RESULT_BUDGET;
  while (limit >= 2) {
    const result = budgetResults(rows, body, limit);
    if (!result.ok) return result;
    const { warnings, meta } = describe(result);
    const next = (meta as { next?: unknown }).next;
    if (next !== undefined && JSON.stringify(next) !== JSON.stringify(maskOutputValue(next))) return { ok: false as const, code: 'INVALID_ARGUMENT' as const, message: '가려진 다음 호출은 실행할 수 없습니다' };
    const envelope = maskOutputValue({ ok: true, now: '2000-01-01T00:00:00.000+00:00', data: result.data, warnings, meta });
    const jsonSize = Array.from(JSON.stringify(envelope)).length + 1;
    const lines = text(result.data).map(line => maskOutputValue(line).replaceAll('\0', '\\u0000'));
    const lineSize = lines.reduce((sum, line) => sum + Array.from(line).length + 1, 0);
    const metadata = maskOutputValue(meta) as { has_more?: boolean; omitted?: { count: number; reason: string }; hint?: string; next?: { ns: string; verb: string; args: Record<string, unknown> } };
    const metaLines: string[] = [];
    if (metadata.has_more !== undefined) metaLines.push(`더 있는 결과: ${metadata.has_more ? '있음' : '없음'}`);
    if (metadata.omitted) metaLines.push(`생략: ${String(metadata.omitted.count)}건 (${metadata.omitted.reason})`);
    if (metadata.hint) metaLines.push(`안내: ${metadata.hint}`);
    if (metadata.next) {
      const { ns, verb, args } = metadata.next;
      const argv = ['brain', ns, verb];
      const positional = ns === 'files' && verb === 'show' ? 'file_id' : 'session';
      if (args[positional] !== undefined) argv.push(String(args[positional]));
      for (const [key, value] of Object.entries(args)) {
        if (key === positional || value === undefined || value === null || value === false) continue;
        const flag = key.replaceAll('_', '-').replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`);
        argv.push(`--${flag}`);
        if (value !== true) for (const item of Array.isArray(value) ? value : [value]) argv.push(String(item));
      }
      const quoted = argv.map(arg => /^[a-zA-Z0-9_./:=@-]+$/u.test(arg) ? arg : "'" + arg.replaceAll("'", "'\\''") + "'").join(' ');
      if (maskOutputText(quoted) !== quoted || quoted.includes('\0')) return { ok: false as const, code: 'INVALID_ARGUMENT' as const, message: '가려진 다음 명령은 실행할 수 없습니다' };
      metaLines.push(`다음: ${quoted}`);
    }
    const metaSize = metaLines.reduce((sum, line) => sum + Array.from(maskOutputText(line).replaceAll('\0', '\\u0000')).length + 1, 0);
    const warningSize = warnings.reduce((sum, warning) => sum + Array.from(`경고: ${warning}\n`).length, 0);
    const excess = Math.max(jsonSize, lineSize + metaSize + warningSize) - RECALL_RESULT_BUDGET;
    if (excess <= 0) return { ok: true as const, data: result.data, warnings, meta };
    limit -= Math.max(1, excess);
  }
  return { ok: false as const, code: 'INVALID_ARGUMENT' as const, message: '출처와 다음 호출이 결과 크기 한도를 초과합니다' };
}
