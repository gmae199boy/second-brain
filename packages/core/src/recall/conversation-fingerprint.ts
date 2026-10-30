import { contentHash } from '../domain/sha256.js';
import type { ChunkParams } from '../domain/index-config.js';

/** 메시지의 논리 본문과 설정을 함께 지문으로 묶는다. */
export function conversationFingerprint(
  config: ChunkParams,
  messages: readonly { id: string; occurredAt: Date; body: string }[],
): string {
  const ordered = [...messages].sort((a, b) =>
    a.occurredAt.getTime() - b.occurredAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, stable(v)])) : value;
  return contentHash(JSON.stringify([stable(config), ordered.map(m => [m.id, m.occurredAt.toISOString(), m.body])]));
}
