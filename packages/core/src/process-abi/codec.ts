import { utf8Bytes } from '../domain/sha256.js';
import { maskSecrets } from '../domain/secret-patterns.js';
export interface ProcessAbiUsage { input_tokens: number; cached_input_tokens: number; output_tokens: number }
export type ProcessAbiEvent = { abi: 1; type: 'progress'; message?: string } | { abi: 1; type: 'heartbeat' } |
  { abi: 1; type: 'result'; summary?: string; usage?: ProcessAbiUsage } |
  { abi: 1; type: 'error'; code: string; retryable: boolean; message?: string };
export const PROCESS_ABI_EVENT_TYPES = ['progress', 'heartbeat', 'result', 'error'] as const;
export const PROCESS_ABI_MAX_LINE_BYTES = 65536;
export const PROCESS_ABI_STDERR_BUFFER_BYTES = 1048576;
export const PROCESS_ABI_STDERR_MAX_BYTES = 4096;
export const PROCESS_ABI_SCHEMA_URL = new URL('../../schemas/process-abi/v1/event.schema.json', import.meta.url);
export const PROCESS_ABI_SNAPSHOT_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/settings-snapshots.json', import.meta.url);
export const PROCESS_ABI_SNAPSHOT_SCHEMA_URL = new URL('../../schemas/process-abi/v1/settings-snapshot.schema.json', import.meta.url);
export const PROCESS_ABI_SNAPSHOT_MAX_BYTES = 16384;
export const PROCESS_ABI_ENV_SCHEMA_URL = new URL('../../schemas/process-abi/v1/env.schema.json', import.meta.url);
export const PROCESS_ABI_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/events.json', import.meta.url);
export const PROCESS_ABI_ENV_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/env.json', import.meta.url);
export const PROCESS_ABI_RUN_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/runs.json', import.meta.url);
export const PROCESS_ABI_ENV = {
  version: 'BRAIN_ABI_VERSION', databaseUrl: 'BRAIN_DATABASE_URL', workId: 'BRAIN_WORK_ID',
  attemptToken: 'BRAIN_ATTEMPT_TOKEN', workKind: 'BRAIN_WORK_KIND', targetKind: 'BRAIN_TARGET_KIND', targetId: 'BRAIN_TARGET_ID',
  runGeneration: 'BRAIN_RUN_GENERATION',
} as const;
export const PROCESS_ABI_OPTIONAL_ENV = { account: 'BRAIN_ACCOUNT', rangeFrom: 'BRAIN_RANGE_FROM', rangeTo: 'BRAIN_RANGE_TO', settingsSnapshot: 'BRAIN_SETTINGS_SNAPSHOT' } as const;
export type AbiFailure = { ok: false; code: string; reason: string };
const invalid = (reason: string, code = 'ABI_LINE_INVALID'): AbiFailure => ({ ok: false, code, reason });
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function only(v: Record<string, unknown>, keys: string[]): boolean { return Object.keys(v).every(k => keys.includes(k)); }
export function decodeAbiLine(line: string): { ok: true; event: ProcessAbiEvent } | AbiFailure {
  let v: unknown;
  try { v = JSON.parse(line); } catch { return invalid('올바른 JSON 줄이 아닙니다'); }
  if (!object(v)) return invalid('이벤트는 객체여야 합니다');
  if (Object.hasOwn(v, 'abi') && v['abi'] !== 1) return invalid('지원하지 않는 ABI 버전입니다', 'ABI_VERSION_UNKNOWN');
  if (v['abi'] !== 1) return invalid('ABI 버전이 없습니다');
  let valid = false;
  switch (v['type']) {
    case 'progress': valid = only(v, ['abi', 'type', 'message']) && (!Object.hasOwn(v, 'message') || typeof v['message'] === 'string'); break;
    case 'heartbeat': valid = only(v, ['abi', 'type']); break;
    case 'result': {
      const u = v['usage'];
      valid = only(v, ['abi', 'type', 'summary', 'usage']) && (!Object.hasOwn(v, 'summary') || typeof v['summary'] === 'string') &&
        (!Object.hasOwn(v, 'usage') || (object(u) && only(u, ['input_tokens', 'cached_input_tokens', 'output_tokens']) &&
          ['input_tokens', 'cached_input_tokens', 'output_tokens'].every(k => Number.isSafeInteger(u[k]) && (u[k] as number) >= 0)));
      break;
    }
    case 'error': valid = only(v, ['abi', 'type', 'code', 'retryable', 'message']) && typeof v['code'] === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(v['code']) && typeof v['retryable'] === 'boolean' && (!Object.hasOwn(v, 'message') || typeof v['message'] === 'string'); break;
  }
  return valid ? { ok: true, event: v as unknown as ProcessAbiEvent } : invalid('이벤트 필드가 올바르지 않습니다');
}
export function decodeAbiEnv(env: Readonly<Record<string, unknown>>): { ok: true } | AbiFailure {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const string = (key: string): string => typeof env[key] === 'string' ? env[key] as string : '';
  const from = env['BRAIN_RANGE_FROM'], to = env['BRAIN_RANGE_TO'];
  const valid = Object.values(PROCESS_ABI_ENV).every(k => string(k).length > 0) && env['BRAIN_ABI_VERSION'] === '1' &&
    /^postgres(?:ql)?:\/\//.test(string('BRAIN_DATABASE_URL')) && uuid.test(string('BRAIN_WORK_ID')) && uuid.test(string('BRAIN_ATTEMPT_TOKEN')) &&
    /^[1-9][0-9]{0,8}$/.test(string('BRAIN_RUN_GENERATION')) &&
    (!Object.hasOwn(env, 'BRAIN_ACCOUNT') || string('BRAIN_ACCOUNT').length > 0) &&
    (!Object.hasOwn(env, 'BRAIN_SETTINGS_SNAPSHOT') || string('BRAIN_SETTINGS_SNAPSHOT').length > 0) &&
    (from === undefined && to === undefined || typeof from === 'string' && typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to));
  return valid ? { ok: true } : invalid('프로세스 환경 변수가 올바르지 않습니다', 'ABI_ENV_INVALID');
}
export interface SettingsSnapshot { version: 1; extension: string; values: Record<string, string | number | boolean> }
/** 직렬화된 객체를 ABI 환경 스키마와 별도로 검증한다. */
export function decodeSettingsSnapshot(raw: unknown, extension: string, declarations: Readonly<Record<string, 'string' | 'number' | 'boolean'>>):
  { ok: true; snapshot: SettingsSnapshot } | AbiFailure {
  const bad = () => invalid('확장 설정 snapshot이 올바르지 않습니다', 'EXTENSION_CONFIG_INVALID');
  if (typeof raw !== 'string' || utf8Bytes(raw).length > PROCESS_ABI_SNAPSHOT_MAX_BYTES) return bad();
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return bad(); }
  if (!object(value) || !only(value, ['version', 'extension', 'values']) || value['version'] !== 1 ||
      value['extension'] !== extension || !/^[a-z][a-z0-9_]{0,30}$/.test(extension) ||
      /^(core|brain|public|pg_)/.test(extension) || !object(value['values'])) return bad();
  for (const [key, item] of Object.entries(value['values'])) {
    if (!key.startsWith(`${extension}.`) || !Object.hasOwn(declarations, key) || typeof item !== declarations[key] ||
        (typeof item === 'number' && !Number.isFinite(item))) return bad();
  }
  return { ok: true, snapshot: value as unknown as SettingsSnapshot };
}
export interface AbiRunVerdict { outcome: 'succeeded' | 'failed'; code?: string; retryable?: boolean; usage: ProcessAbiUsage | null; message?: string }
export function abiRetryable(code: string): boolean { return ['ABI_LINE_TRUNCATED', 'ABI_EXIT_FAILED', 'ABI_OUTPUT_UNREADABLE', 'PROCESS_START_FAILED'].includes(code); }
/** Incremental framing and execution evaluation. The first violation is sticky. */
export function createAbiRun() {
  let line = '', bytes = 0, pendingHigh = '';
  let failure: AbiFailure | undefined;
  let final: Extract<ProcessAbiEvent, { type: 'result' | 'error' }> | undefined;
  let usage: ProcessAbiUsage | null = null;
  const fail = (code: string, reason: string): void => { failure ??= invalid(reason, code); };
  const observe = (event: ProcessAbiEvent): boolean => {
    if (event.type === 'result' || event.type === 'error') {
      if (final) fail('ABI_DUPLICATE_FINAL', '최종 이벤트가 두 번 왔습니다');
      else { final = event; if (event.type === 'result') usage = event.usage ?? null; }
      return !failure;
    }
    return !final;
  };
  const feed = (raw: string): ProcessAbiEvent[] => {
    const progress: ProcessAbiEvent[] = [];
    if (failure) return progress;
    raw = pendingHigh + raw; pendingHigh = '';
    if (raw.length && /[\uD800-\uDBFF]/.test(raw.charAt(raw.length - 1))) { pendingHigh = raw.slice(-1); raw = raw.slice(0, -1); }
    for (const cp of raw) {
      if (cp === '\n') {
        const decoded = decodeAbiLine(line); line = ''; bytes = 0;
        if (!decoded.ok) { failure = decoded; break; }
        if (observe(decoded.event)) progress.push(decoded.event);
        if (failure) break;
      } else {
        bytes += utf8Bytes(cp).length;
        if (bytes > PROCESS_ABI_MAX_LINE_BYTES) { fail('ABI_LINE_TOO_LONG', '출력 줄이 65536바이트를 넘었습니다'); line = ''; break; }
        line += cp;
      }
    }
    return progress;
  };
  return {
    feed, fail,
    get violation() { return failure; },
    get workerError() { return !failure && final?.type === 'error'; },
    end() { if (pendingHigh && bytes + 3 > PROCESS_ABI_MAX_LINE_BYTES) fail('ABI_LINE_TOO_LONG', '출력 줄이 65536바이트를 넘었습니다'); if (line || pendingHigh) fail('ABI_LINE_TRUNCATED', '출력의 마지막 줄이 잘렸습니다'); },
    verdict(exit: { code: number | null; signal: string | null }): AbiRunVerdict {
      if (failure) return { outcome: 'failed', code: failure.code, retryable: abiRetryable(failure.code), usage, message: failure.reason };
      if (final?.type === 'error') return { outcome: 'failed', code: final.code, retryable: final.retryable, usage, ...(final.message === undefined ? {} : { message: final.message }) };
      const clean = exit.code === 0 && exit.signal === null;
      if (final && clean) return { outcome: 'succeeded', usage };
      const code = final ? 'ABI_EXIT_AFTER_RESULT' : clean ? 'ABI_NO_RESULT' : 'ABI_EXIT_FAILED';
      return { outcome: 'failed', code, retryable: abiRetryable(code), usage, message: '자식 프로세스가 정상 결과로 종료하지 않았습니다' };
    },
  };
}
function tailUtf8(text: string, limit: number): string {
  let bytes = 0, start = text.length;
  while (start > 0) {
    let previous = start - 1;
    const low = text.charCodeAt(previous);
    if (low >= 0xdc00 && low <= 0xdfff && previous > 0 && /[\uD800-\uDBFF]/.test(text.charAt(previous - 1))) previous--;
    const size = utf8Bytes(text.slice(previous, start)).length;
    if (bytes + size > limit) break;
    bytes += size; start = previous;
  }
  return text.slice(start);
}
/** Retain at most 1 MiB of raw stderr, then mask the whole context once. */
export function createAbiStderr() {
  let raw = '', bytes = 0, previousHigh = false, overflow = false;
  let cached: string | null | undefined;
  return {
    feed(chunk: string) {
      if (overflow || !chunk) return;
      cached = undefined;
      // Count without allocating an encoded copy of an arbitrarily large chunk.
      // A high surrogate costs three bytes until a following low surrogate adds
      // the fourth byte, including when the pair straddles chunks.
      for (let i = 0; i < chunk.length; i++) {
        const unit = chunk.charCodeAt(i);
        bytes += unit <= 0x7f ? 1 : unit <= 0x7ff ? 2 :
          previousHigh && unit >= 0xdc00 && unit <= 0xdfff ? 1 : 3;
        previousHigh = unit >= 0xd800 && unit <= 0xdbff;
        if (bytes > PROCESS_ABI_STDERR_BUFFER_BYTES) {
          overflow = true;
          raw = '';
          return;
        }
      }
      raw += chunk;
    },
    value(): string | null {
      if (overflow) return '[stderr 생략: 원문 1 MiB 초과]';
      if (cached !== undefined) return cached;
      // PostgreSQL text cannot store NUL. Normalize only after masking the
      // original context and count the replacement within the final byte cap.
      const masked = maskSecrets(raw, 'body').text.replaceAll('\u0000', '\ufffd');
      let tail = tailUtf8(masked, PROCESS_ABI_STDERR_MAX_BYTES);
      const start = masked.length - tail.length;
      if (start > 0 && masked[start - 1] !== '\n') {
        const newline = tail.indexOf('\n');
        tail = newline === -1 ? '' : tail.slice(newline + 1);
      }
      cached = tail || null;
      return cached;
    },
  };
}
