import { describe, expect, it } from 'vitest';
import { contentHash, maskSecrets, planRedaction, SECRET_PATTERN_VERSION, type RedactionCurrent } from '../src/index.js';
import { sampleIngestBatch, sampleSessionId } from '../src/testing/fixtures.js';
import { redactMessage } from '../src/messages/redact.js';

function current(body: string, target?: string): RedactionCurrent {
  const batch = sampleIngestBatch();
  return { message: { ...batch.messages[0]!, sessionId: sampleSessionId, body },
    toolNotes: target === undefined ? [] : [{ ...batch.toolNotes[0]!, sessionId: sampleSessionId, target }] };
}
let sequence = 0;
const dependencies = { now: () => new Date('2026-10-21T00:00:00.000Z'), newId: () => String(sequence++) };
function literal(body: string, text: string) {
  const result = planRedaction(current(body), { mode: 'text', text, kind: 'manual' }, dependencies);
  if ('refused' in result) throw new Error(result.refused);
  return result;
}

describe('redaction planner', () => {
  it('records code point positions and only hashes of the removed text', () => {
    const result = literal('a🙂 hunter2-x b hunter2-x', 'hunter2-x');
    expect(result.body).toBe('a🙂 [REDACTED:manual] b [REDACTED:manual]');
    expect(result.redactions.map(({ start, end, contentHash: hash }) => [start, end, hash]))
      .toEqual([[3, 12, contentHash('hunter2-x')], [15, 24, contentHash('hunter2-x')]]);
    expect(result.redactions.every((row) => row.messageId !== null && row.toolNoteId === null && row.patternVersion === null)).toBe(true);
  });
  it('matches raw and NFC forms, preferring leftmost non-overlapping matches', () => {
    expect(literal('e\u0301 é e\u0301', 'e\u0301').bodySpans).toBe(3);
    expect(literal('ababa', 'aba').body).toBe('[REDACTED:manual]ba');
  });
  it('does not touch any part of existing markers, including crossing matches', () => {
    expect(planRedaction(current('[REDACTED:manual]'), { mode: 'text', text: 'REDACTED', kind: 'manual' }, dependencies))
      .toEqual({ refused: 'REDACT_TEXT_NOT_FOUND' });
    expect(planRedaction(current('x[REDACTED:manual]'), { mode: 'text', text: 'x[', kind: 'manual' }, dependencies))
      .toEqual({ refused: 'REDACT_TEXT_NOT_FOUND' });
  });
  it('plans a second call over the text the first call left', () => {
    const first = literal('hunter2-x next', 'hunter2-x');
    const second = literal(first.body, 'next');
    expect(second.redactions[0]).toMatchObject({ start: 18, end: 22 });
  });
  it('uses detected spans unchanged for both fields and does not apply truncated-tail masking', () => {
    const body = 'api_key=sk-abcdefghijklmnopqrstuvwx';
    const target = 'TOKEN=hunter2-x trailing-token';
    const result = planRedaction(current(body, target), { mode: 'detected' }, dependencies);
    if ('refused' in result) throw new Error('unexpected refusal');
    expect(result.body).toBe(maskSecrets(body, 'body').text);
    expect(result.toolNotes[0]?.target).toBe(maskSecrets(target, 'tool_target').text);
    expect(result.toolNotes[0]?.target).toContain('trailing-token');
    expect(result.redactions.every((row) => row.patternVersion === SECRET_PATTERN_VERSION)).toBe(true);
    expect(result.redactions.some((row) => row.messageId === null && row.toolNoteId !== null)).toBe(true);
    expect(planRedaction(current('ordinary text'), { mode: 'detected' }, dependencies)).toMatchObject({ bodySpans: 0, toolNoteSpans: 0, redactions: [], toolNotes: [] });
  });
});

describe('SDK redaction gate', () => {
  it('validates before confirmation and touches no store until confirmed', async () => {
    let calls = 0;
    const deps = { store: { async redactMessage() { calls++; return { ok: false as const, code: 'MESSAGE_NOT_FOUND' as const, message: '메시지가 없습니다' }; } },
      clock: { now: dependencies.now }, idGen: { next: dependencies.newId } };
    const message = current('').message.id;
    for (const input of [{ message }, { message, text: '' }, { message, text: 'x', detected: true },
      { message, detected: true, kind: 'manual' }, { message, text: 'x', kind: 'Db-Pw' }, { message: 'invalid', detected: true }]) {
      expect(await redactMessage(deps, input)).toMatchObject({ ok: false, code: 'USAGE' });
    }
    expect(await redactMessage(deps, { message, detected: true })).toMatchObject({ ok: false, code: 'CONFIRMATION_REQUIRED', retry: { args: { message, detected: true, confirm: true } } });
    expect(calls).toBe(0);
    expect(await redactMessage(deps, { message, detected: true, confirm: true })).toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    expect(calls).toBe(1);
  });
});
