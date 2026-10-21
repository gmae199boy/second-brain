import { checkMessagesRedact, type MessagesRedactInput } from 'second_brain';
import type { CommandContextBase, CommandSpec } from '../dispatch.js';

function inputOf(context: CommandContextBase): MessagesRedactInput {
  return {
    message: context.args[0] ?? '',
    ...(typeof context.options.text === 'string' ? { text: context.options.text } : {}),
    ...(typeof context.options.kind === 'string' ? { kind: context.options.kind } : {}),
    ...(context.options.detected === true ? { detected: true } : {}),
    ...(context.options.yes === true ? { confirm: true } : {}),
  };
}
export const messagesRedactCommand: CommandSpec = {
  ns: 'messages', verb: 'redact', nsDescription: '저장된 메시지를 관리합니다',
  usedFor: '메시지와 도구 메모에서 비밀을 되돌릴 수 없게 가립니다',
  required: ['message'], arguments: ['<message>'],
  examples: ['brain messages redact <message> --detected --yes --json'],
  output: '메시지 id와 본문·도구 메모의 가린 구간 수, 바뀐 메모 수, 지운 조각 수, 패턴 버전을 반환합니다',
  risk: 'destructive', hook: false, dryRun: false, writes: true, drain: false,
  options: [
    { flags: '--text <text>', description: '이 글자의 모든 일치를 가립니다' },
    { flags: '--kind <kind>', description: '글자 가리기의 종류입니다 (기본 manual)' },
    { flags: '--detected', description: '비밀 패턴이 찾는 구간을 가립니다' },
    { flags: '--yes', description: '되돌릴 수 없는 가리기에 동의합니다' },
  ],
  preflight(context) {
    const failure = checkMessagesRedact(inputOf(context));
    return failure === undefined ? undefined : { ok: false, ...failure };
  },
  async run(context) {
    const result = await context.brain.messages.redact(inputOf(context));
    if (!result.ok) return result;
    return { ok: true, data: { message_id: result.messageId, body_spans: result.bodySpans,
      tool_note_spans: result.toolNoteSpans, tool_notes_changed: result.toolNotesChanged,
      chunks_removed: result.chunksRemoved, pattern_version: result.patternVersion },
    text: [`본문 ${String(result.bodySpans)}곳과 도구 메모 ${String(result.toolNoteSpans)}곳을 가리고 조각 ${String(result.chunksRemoved)}건을 지웠습니다.`] };
  },
};
