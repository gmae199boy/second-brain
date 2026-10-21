import { planRedaction } from '../domain/redact-plan.js';
import { SECRET_PATTERN_VERSION } from '../domain/secret-patterns.js';
import { requireConfirmation, type Failure } from '../envelope.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { SessionStore } from '../ports/store.js';

export interface MessagesRedactInput {
  message: string;
  text?: string;
  kind?: string;
  detected?: boolean;
  confirm?: boolean;
}
export interface MessagesRedactData {
  messageId: string;
  bodySpans: number;
  toolNoteSpans: number;
  toolNotesChanged: number;
  chunksRemoved: number;
  patternVersion: string | null;
}
export type MessagesRedactResult = ({ ok: true } & MessagesRedactData) | ({ ok: false } & Failure);

/** Shared CLI preflight and SDK gate: no port has been called at this point. */
export function checkMessagesRedact(input: MessagesRedactInput): Failure | undefined {
  if (typeof input.message !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(input.message)
    || (input.text !== undefined && (typeof input.text !== 'string' || input.text.length === 0))
    || (input.detected !== undefined && typeof input.detected !== 'boolean')
    || (input.confirm !== undefined && typeof input.confirm !== 'boolean')
    || ((input.text !== undefined) === (input.detected === true))
    || (input.kind !== undefined && (input.text === undefined || typeof input.kind !== 'string' || !/^[a-z0-9_]+$/u.test(input.kind)))) {
    return { code: 'USAGE', message: '메시지 UUIDv7과 --text 또는 --detected 중 하나를 주세요. --kind는 --text와 함께 소문자·숫자·밑줄로 지정하세요.' };
  }
  return requireConfirmation({ ns: 'messages', verb: 'redact', args: { ...input } },
    '저장본 가리기에는 명시적인 동의가 필요합니다. --yes로 동의하세요.');
}

export async function redactMessage(
  dependencies: { store: Pick<SessionStore, 'redactMessage'>; clock: Clock; idGen: IdGen },
  input: MessagesRedactInput,
): Promise<MessagesRedactResult> {
  const failure = checkMessagesRedact(input);
  if (failure !== undefined) return { ok: false, ...failure };
  const result = await dependencies.store.redactMessage({ messageId: input.message,
    plan: (current) => planRedaction(current, input.text !== undefined
      ? { mode: 'text', text: input.text, kind: input.kind ?? 'manual' } : { mode: 'detected' },
    { now: () => dependencies.clock.now(), newId: () => dependencies.idGen.next() }),
  });
  if (!result.ok) return result;
  return { ok: true, messageId: input.message, bodySpans: result.bodySpans,
    toolNoteSpans: result.toolNoteSpans, toolNotesChanged: result.toolNotesChanged,
    chunksRemoved: result.chunksRemoved, patternVersion: input.detected === true ? SECRET_PATTERN_VERSION : null };
}
