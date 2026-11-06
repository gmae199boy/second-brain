import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { conversationFingerprint, conversationFingerprintJson } from '../src/recall/conversation-fingerprint.js';
import { contentHash } from '../src/domain/sha256.js';
import type { ChunkParams } from '../src/domain/index-config.js';

const config = { targetChars: 1200, overlapMessages: 1, splitMessagesOverChars: 2400 };
const a = { id: 'a', occurredAt: new Date('2026-01-01T00:00:00Z'), body: '가\0나' };
const b = { id: 'b', occurredAt: a.occurredAt, body: '다' };

// 원래 구현을 독립적으로 보존한다. 증분 구현을 이용해 기대값을 만들지 않는다.
function original(config: ChunkParams, messages: readonly typeof a[]): string {
  const ordered = [...messages].sort((x, y) => x.occurredAt.getTime() - y.occurredAt.getTime() || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable) : value !== null && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([x], [y]) => x < y ? -1 : x > y ? 1 : 0).map(([k, v]) => [k, stable(v)])) : value;
  return JSON.stringify([stable(config), ordered.map(m => [m.id, m.occurredAt.toISOString(), m.body])]);
}

describe('conversationFingerprint', () => {
  it('동시각 입력 순서에 독립적이고 본문과 설정 변경을 감지한다', () => {
    const fingerprint = conversationFingerprint(config, [a, b]);
    expect(conversationFingerprint(config, [b, a])).toBe(fingerprint);
    expect(conversationFingerprint(config, [{ ...a, body: '가나' }, b])).not.toBe(fingerprint);
    expect(conversationFingerprint({ ...config, targetChars: 1000 }, [a, b])).not.toBe(fingerprint);
    expect(conversationFingerprint(config, [a])).not.toBe(fingerprint);
  });

  it('원형 JSON 및 고정 벡터와 증분 UTF-8 해시가 같다', () => {
    const nested = { ...config, extra: { z: [null, { '10': '열', '2': '둘', a: '\ud800' }], a: '\0' } };
    const cases = [
      { config, messages: [] },
      { config: nested, messages: [b, a, { id: 'c', occurredAt: new Date('2025-12-31T23:59:59Z'), body: '"\\\n\0한글😀\ud800x\udc00' }] },
      { config, messages: [{ ...a, body: '가😀\ud800\0'.repeat(5000) }, b] },
    ];
    for (const input of cases) {
      const before = structuredClone(input);
      const expected = original(input.config, input.messages);
      const tokens = [...conversationFingerprintJson(input.config, input.messages)];
      const native = createHash('sha256');
      for (const token of tokens) native.update(token, 'utf8');
      expect(tokens.join('')).toBe(expected);
      expect(conversationFingerprint(input.config, input.messages)).toBe(contentHash(expected));
      expect(`sha256:${native.digest('hex')}`).toBe(contentHash(expected));
      expect(input).toEqual(before);
    }
    expect(conversationFingerprint(config, [])).toBe('sha256:6343c217d03f174089c923421d87dd8583d6bcc28cfd0dbe150cc5a530e1e748');
  });
});
