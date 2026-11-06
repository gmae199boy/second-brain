import { contentHash } from '../domain/sha256.js';
import type { ChunkParams } from '../domain/index-config.js';

/** 원래 JSON 배열과 같은 문자열을 완성된 JSON 토큰 단위로 내보낸다. */
export function* conversationFingerprintJson(
  config: ChunkParams,
  messages: readonly { id: string; occurredAt: Date; body: string }[],
): Generator<string> {
  const ordered = [...messages].sort((a, b) =>
    a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)])) : value;
  // 배열 요소로 직렬화하여 undefined 같은 값도 JSON 배열 규칙을 따른다.
  yield '[' + JSON.stringify([stable(config)]).slice(1, -1) + ',[';
  let first = true;
  for (const m of ordered) {
    if (!first) yield ',';
    first = false;
    yield JSON.stringify([m.id, m.occurredAt.toISOString(), m.body]);
  }
  yield ']]';
}

/** 메시지의 논리 본문과 설정을 함께 지문으로 묶는다. */
export function conversationFingerprint(
  config: ChunkParams,
  messages: readonly { id: string; occurredAt: Date; body: string }[],
): string {
  return contentHash([...conversationFingerprintJson(config, messages)].join(''));
}
