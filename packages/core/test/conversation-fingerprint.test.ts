import { describe, expect, it } from 'vitest';
import { conversationFingerprint } from '../src/recall/conversation-fingerprint.js';

const config = { targetChars: 1200, overlapMessages: 1, splitMessagesOverChars: 2400 };
const a = { id: 'a', occurredAt: new Date('2026-01-01T00:00:00Z'), body: '가\0나' };
const b = { id: 'b', occurredAt: a.occurredAt, body: '다' };

describe('conversationFingerprint', () => {
  it('동시각 입력 순서에 독립적이고 본문과 설정 변경을 감지한다', () => {
    const fingerprint = conversationFingerprint(config, [a, b]);
    expect(conversationFingerprint(config, [b, a])).toBe(fingerprint);
    expect(conversationFingerprint(config, [{ ...a, body: '가나' }, b])).not.toBe(fingerprint);
    expect(conversationFingerprint({ ...config, targetChars: 1000 }, [a, b])).not.toBe(fingerprint);
    expect(conversationFingerprint(config, [a])).not.toBe(fingerprint);
  });
});
