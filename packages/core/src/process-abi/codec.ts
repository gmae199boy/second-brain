export type ProcessAbiEvent = { abi: 1; type: 'progress'; message?: string } | { abi: 1; type: 'result'; summary?: string };
export const PROCESS_ABI_SCHEMA_URL = new URL('../../schemas/process-abi/v1/event.schema.json', import.meta.url);
export const PROCESS_ABI_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/cases.json', import.meta.url);
export const PROCESS_ABI_ENV = {
  version: 'BRAIN_ABI_VERSION', databaseUrl: 'BRAIN_DATABASE_URL', workId: 'BRAIN_WORK_ID',
  attemptToken: 'BRAIN_ATTEMPT_TOKEN', workKind: 'BRAIN_WORK_KIND', targetKind: 'BRAIN_TARGET_KIND', targetId: 'BRAIN_TARGET_ID',
} as const;
export function decodeAbiLine(line: string): { ok: true; event: ProcessAbiEvent } | { ok: false; reason: string } {
  let value: unknown;
  try { value = JSON.parse(line); } catch { return { ok: false, reason: '올바른 JSON 줄이 아닙니다' }; }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, reason: '이벤트는 객체여야 합니다' };
  const v = value as Record<string, unknown>;
  if (v['abi'] !== 1 || (v['type'] !== 'progress' && v['type'] !== 'result')) return { ok: false, reason: '지원하지 않는 ABI 버전 또는 이벤트입니다' };
  const field = v['type'] === 'progress' ? 'message' : 'summary';
  if (Object.keys(v).some((k) => !['abi', 'type', field].includes(k)) || (Object.hasOwn(v, field) && typeof v[field] !== 'string')) return { ok: false, reason: '이벤트 필드가 올바르지 않습니다' };
  return { ok: true, event: v as ProcessAbiEvent };
}
