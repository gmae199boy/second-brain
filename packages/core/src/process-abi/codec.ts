import { utf8Bytes } from '../domain/sha256.js';
import { maskSecrets } from '../domain/secret-patterns.js';
export interface ProcessAbiUsage { input_tokens: number; cached_input_tokens: number; output_tokens: number }
export type ProcessAbiEvent = { abi: 1; type: 'progress'; message?: string } | { abi: 1; type: 'heartbeat' } |
  { abi: 1; type: 'result'; summary?: string; usage?: ProcessAbiUsage } |
  { abi: 1; type: 'error'; code: string; retryable: boolean; message?: string };
export const PROCESS_ABI_EVENT_TYPES = ['progress', 'heartbeat', 'result', 'error'] as const;
export const PROCESS_ABI_MAX_LINE_BYTES = 65536;
export const PROCESS_ABI_STDERR_BUFFER_BYTES = 16384;
export const PROCESS_ABI_STDERR_MAX_BYTES = 4096;
export const PROCESS_ABI_SCHEMA_URL = new URL('../../schemas/process-abi/v1/event.schema.json', import.meta.url);
export const PROCESS_ABI_ENV_SCHEMA_URL = new URL('../../schemas/process-abi/v1/env.schema.json', import.meta.url);
export const PROCESS_ABI_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/events.json', import.meta.url);
export const PROCESS_ABI_ENV_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/env.json', import.meta.url);
export const PROCESS_ABI_RUN_FIXTURES_URL = new URL('../../fixtures/process-abi/v1/runs.json', import.meta.url);
export const PROCESS_ABI_ENV = {
  version: 'BRAIN_ABI_VERSION', databaseUrl: 'BRAIN_DATABASE_URL', workId: 'BRAIN_WORK_ID',
  attemptToken: 'BRAIN_ATTEMPT_TOKEN', workKind: 'BRAIN_WORK_KIND', targetKind: 'BRAIN_TARGET_KIND', targetId: 'BRAIN_TARGET_ID',
  runGeneration: 'BRAIN_RUN_GENERATION',
} as const;
export const PROCESS_ABI_OPTIONAL_ENV = { account: 'BRAIN_ACCOUNT', rangeFrom: 'BRAIN_RANGE_FROM', rangeTo: 'BRAIN_RANGE_TO' } as const;
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
    (from === undefined && to === undefined || typeof from === 'string' && typeof to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(from) && /^\d{4}-\d{2}-\d{2}$/.test(to));
  return valid ? { ok: true } : invalid('프로세스 환경 변수가 올바르지 않습니다', 'ABI_ENV_INVALID');
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
      return false;
    }
    return !final && event.type === 'progress';
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
/** Mask complete lines before retaining a bounded diagnostic tail. */
export function createAbiStderr() {
  let line = '', bytes = 0, pendingHigh = '';
  type MaskedLine = { text: string; bytes: number; next: MaskedLine | null };
  let first: MaskedLine | null = null, last: MaskedLine | null = null, retainedBytes = 0;
  let oversized = false, inPem = false, pemLine = false, beganPem = false;
  // Marker recognition stays bounded even on discarded, oversized lines. The
  // label may be arbitrarily long; only its suffix and closing dashes matter.
  let markerPrefix = '', markerKind: 'BEGIN' | 'END' | undefined;
  let labelTail = '', dashes = 0;
  const append = (masked: string): void => {
    if (!masked) return;
    const entry: MaskedLine = { text: masked, bytes: utf8Bytes(masked).length, next: null };
    if (last) last.next = entry;
    else first = entry;
    last = entry;
    retainedBytes += entry.bytes;
    while (first && retainedBytes > PROCESS_ABI_STDERR_BUFFER_BYTES) {
      retainedBytes -= first.bytes;
      first = first.next;
    }
    if (!first) last = null;
  };
  const maskedLine = (newline: boolean): string => {
    const ending = newline ? '\n' : '';
    if (pemLine) return beganPem ? '[REDACTED:private_key]' + ending : '';
    if (oversized) return '[stderr 줄 생략: 상한 초과]' + ending;
    return maskSecrets(line, 'body').text + ending;
  };
  const marker = (cp: string): void => {
    if (markerKind !== undefined) {
      if (/[A-Z0-9 ]/.test(cp) && dashes === 0) labelTail = (labelTail + cp).slice(-32);
      else if (cp === '-') {
        if (++dashes === 5) {
          if (markerKind === 'BEGIN' && /PRIVATE KEY(?: BLOCK)?$/.test(labelTail)) {
            if (!inPem) beganPem = true;
            inPem = true; pemLine = true;
          } else if (markerKind === 'END') inPem = false;
          markerKind = undefined;
        }
      } else markerKind = undefined;
    }
    markerPrefix = (markerPrefix + cp).slice(-11);
    if (markerPrefix.endsWith('-----BEGIN ')) { markerKind = 'BEGIN'; labelTail = ''; dashes = 0; }
    else if (markerPrefix.endsWith('-----END ')) { markerKind = 'END'; labelTail = ''; dashes = 0; }
  };
  const consume = (raw: string): void => {
    for (const original of raw) {
      const cp = original === '\u0000' ? '\ufffd' : original;
      if (cp === '\n') {
        append(maskedLine(true));
        line = ''; bytes = 0; oversized = false; beganPem = false; pemLine = inPem;
        markerPrefix = ''; markerKind = undefined;
        continue;
      }
      marker(cp);
      if (!oversized) {
        bytes += utf8Bytes(cp).length;
        if (bytes > PROCESS_ABI_MAX_LINE_BYTES) { oversized = true; line = ''; }
        else line += cp;
      }
    }
  };
  return {
    feed(raw: string) {
      raw = pendingHigh + raw; pendingHigh = '';
      if (raw.length && /[\uD800-\uDBFF]/.test(raw.charAt(raw.length - 1))) { pendingHigh = raw.slice(-1); raw = raw.slice(0, -1); }
      consume(raw);
    },
    value(): string | null {
      // value is read at EOF/settlement. Keep snapshots non-destructive for
      // callers that inspect a diagnostic while more output can still arrive.
      let masked = maskedLine(false);
      if (pendingHigh && !pemLine && !oversized) {
        masked = bytes + 3 > PROCESS_ABI_MAX_LINE_BYTES ? '[stderr 줄 생략: 상한 초과]' : maskSecrets(line + pendingHigh, 'body').text;
      }
      if (!(line || oversized || beganPem || pendingHigh)) masked = '';
      let size = retainedBytes + utf8Bytes(masked).length, start = first;
      while (start && size > PROCESS_ABI_STDERR_BUFFER_BYTES) {
        size -= start.bytes;
        start = start.next;
      }
      if (size > PROCESS_ABI_STDERR_BUFFER_BYTES) return null;
      const pieces: string[] = [];
      for (let entry = start; entry; entry = entry.next) pieces.push(entry.text);
      pieces.push(masked);
      return tailUtf8(pieces.join(''), PROCESS_ABI_STDERR_MAX_BYTES) || null;
    },
  };
}
