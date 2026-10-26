import type { Message } from './message.js';
import type { ToolNote } from './tool-note.js';
import type { Redaction } from './redaction.js';
import { contentHash } from './sha256.js';
import { maskSecrets, SECRET_PATTERN_VERSION, type SecretSpan } from './secret-patterns.js';

export interface RedactionCurrent {
  message: Message;
  toolNotes: readonly ToolNote[];
}
export type RedactionRequest = { mode: 'text'; text: string; kind: string } | { mode: 'detected' };
export interface RedactionPlan {
  body: string;
  toolNotes: { id: string; target: string }[];
  redactions: Redaction[];
  bodySpans: number;
  toolNoteSpans: number;
}
export type RedactionRefusal = { refused: 'REDACT_TEXT_NOT_FOUND' };

/** Positions always describe the current target before this call changes it. */
export function planRedaction(
  current: RedactionCurrent,
  request: RedactionRequest,
  dependencies: { now: () => Date; newId: () => string },
): RedactionPlan | RedactionRefusal {
  const redact = (text: string, field: 'body' | 'tool_target') => request.mode === 'detected'
    ? maskSecrets(text, field) : literal(text, request.text, request.kind);
  const body = redact(current.message.body, 'body');
  const notes = current.toolNotes.map((note) => ({ note, masked: redact(note.target, 'tool_target') }));
  const toolNoteSpans = notes.reduce((sum, entry) => sum + entry.masked.spans.length, 0);
  if (request.mode === 'text' && body.spans.length + toolNoteSpans === 0) {
    return { refused: 'REDACT_TEXT_NOT_FOUND' };
  }
  const records = (spans: readonly SecretSpan[], messageId: string | null, toolNoteId: string | null): Redaction[] =>
    spans.map((span) => ({ id: dependencies.newId(), messageId, toolNoteId, fileId: null,
      start: span.start, end: span.end, kind: span.kind, contentHash: span.removed,
      occurredAt: dependencies.now(), patternVersion: request.mode === 'detected' ? SECRET_PATTERN_VERSION : null }));
  return {
    body: body.text,
    toolNotes: notes.filter((entry) => entry.masked.spans.length > 0)
      .map(({ note, masked }) => ({ id: note.id, target: masked.text })),
    redactions: [...records(body.spans, current.message.id, null),
      ...notes.flatMap(({ note, masked }) => records(masked.spans, null, note.id))],
    bodySpans: body.spans.length, toolNoteSpans,
  };
}

function literal(text: string, needle: string, kind: string): { text: string; spans: SecretSpan[] } {
  if (needle === '') throw new TypeError('가릴 글자는 비어 있을 수 없습니다');
  const chars = Array.from(text);
  const skip = [...text.matchAll(/\[REDACTED:[a-z0-9_]+\]/gu)].map((match) => ({
    start: Array.from(text.slice(0, match.index)).length,
    end: Array.from(text.slice(0, match.index + match[0].length)).length,
  }));
  const needles = [...new Set([needle, needle.normalize('NFC')])].map((value) => Array.from(value));
  const spans: SecretSpan[] = [];
  for (let start = 0; start < chars.length; start += 1) {
    const found = needles.filter((value) => value.every((char, offset) => chars[start + offset] === char))
      .sort((a, b) => b.length - a.length)
      .find((value) => !skip.some((range) => start < range.end && start + value.length > range.start));
    if (found === undefined) continue;
    const end = start + found.length;
    spans.push({ start, end, kind, removed: contentHash(chars.slice(start, end).join('')) });
    start = end - 1;
  }
  for (const span of [...spans].reverse()) chars.splice(span.start, span.end - span.start, `[REDACTED:${kind}]`);
  return { text: chars.join(''), spans };
}
