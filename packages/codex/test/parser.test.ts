import { describe, expect, it } from 'vitest';
import { codexParser, codexSessionId } from '../src/index.js';

const meta = (id = 'parent', sessionId = 'parent') => ({ type: 'session_meta', payload: { id, session_id: sessionId, cwd: '/synthetic/work', git: { branch: 'sample' } } });
const message = (role: string, text: string, timestamp = '2026-01-01T00:00:01Z') => ({ timestamp, type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
const item = (type: string, fields: Record<string, unknown>) => ({ type: 'response_item', payload: { type, ...fields } });
const shellOutput = (code: number, output = '') => `Chunk ID: synthetic123\nWall time: 0.2 seconds\nProcess exited with code ${code}\nFinal output:\n${output}`;
const jsonl = (...rows: unknown[]) => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
const parse = (text: string, cursor?: Parameters<ReturnType<typeof codexParser>['parse']>[1]) => {
  const result = codexParser().parse(text, cursor);
  if (!result.ok) throw new Error(result.message);
  return result;
};

describe('Codex JSONL parser', () => {
  it('uses each file metadata id, rejects missing, empty and conflicting ids, and ignores shared session_id', () => {
    expect(codexSessionId(jsonl(meta('parent'), message('user', 'hello')))).toBe('parent');
    expect(codexSessionId(jsonl(meta('child', 'parent')))).toBe('child');
    expect(codexSessionId(jsonl({ type: 'session_meta', payload: { session_id: 'parent' } }))).toBeNull();
    expect(codexSessionId(jsonl(meta(' ')))).toBeNull();
    expect(codexSessionId(jsonl(meta('a'), meta('b')))).toBeNull();
    expect(codexSessionId(jsonl(meta('a'), meta('a')))).toBe('a');
    expect(codexParser().parse(jsonl(meta('a'), meta('b')))).toMatchObject({ ok: false, code: 'TRANSCRIPT_UNREADABLE' });
    expect(codexSessionId(JSON.stringify(meta('a')))).toBeNull();
  });

  it('keeps response messages once, verbatim and in file order even for equal or reversed timestamps', () => {
    const text = jsonl(meta(), { type: 'turn_context', payload: { model: 'synthetic-model', cwd: '/synthetic/turn' } }, message('user', ' 첫 줄\n둘째 줄 ', '2026-01-01T00:00:02Z'), { type: 'event_msg', payload: { type: 'user_message', message: ' 첫 줄\n둘째 줄 ' } }, message('developer', 'hidden'), message('assistant', 'answer', '2026-01-01T00:00:02Z'), message('user', 'earlier clock', '2026-01-01T00:00:01Z'));
    const result = parse(text);
    expect(result.messages.map(m => m.body)).toEqual([' 첫 줄\n둘째 줄 ', 'answer', 'earlier clock']);
    expect(result.messages[1]).toMatchObject({ role: 'assistant', model: 'synthetic-model', cwd: '/synthetic/turn', gitBranch: 'sample' });
    expect(result.startCwd).toBe('/synthetic/work');
    expect(result.droppedLines['non_conversation']).toBe(4);
    expect(new Set(result.messages.map(m => m.harnessMessageId)).size).toBe(3);
  });

  it('pairs function and custom calls by id, deduplicates calls and ignores orphan or wrong-kind output', () => {
    const result = parse(jsonl(meta(), message('user', 'start'), item('function_call', { call_id: 'one', name: 'shell', arguments: '{"cmd":"hi"}' }), item('function_call', { call_id: 'one', name: 'shell', arguments: 'duplicate' }), item('custom_tool_call', { call_id: 'two', name: 'edit', input: 'patch' }), item('function_call_output', { call_id: 'one', output: shellOutput(0) }), item('custom_tool_call_output', { call_id: 'two', output: { is_error: true } }), item('function_call_output', { call_id: 'orphan', output: 'Exit code: 0' }), item('function_call', { call_id: 'three', name: 'shell', arguments: '{}' }), item('custom_tool_call_output', { call_id: 'three', output: 'Exit code: 0' }), item('function_call_output', { call_id: 'three', output: shellOutput(1) })));
    expect(result.toolNotes.map(n => [n.callId, n.ordinal, n.tool, n.target, n.ok])).toEqual([['one', 0, 'shell', '{"cmd":"hi"}', true], ['two', 1, 'edit', 'patch', false], ['three', 2, 'shell', '{}', false]]);
  });

  it('uses only recognized status metadata and ignores quoted exit-code examples', () => {
    const texts = [
      'Search result: Exit code: 0',
      'Example: Process exited with code 0',
      shellOutput(1, 'Example: Exit code: 0'),
      shellOutput(0, 'A quoted Process exited with code 1'),
      'Process exited with code 0',
    ];
    const rows = texts.flatMap((output, index) => [item('function_call', { call_id: `case-${index}`, name: 'shell', arguments: '{}' }), item('function_call_output', { call_id: `case-${index}`, output })]);
    const result = parse(jsonl(meta(), message('user', 'start'), ...rows));
    expect(result.toolNotes.map(note => note.ok)).toEqual([false, false, false, true, false]);
    const explicit = parse(jsonl(meta(), message('user', 'start'), item('custom_tool_call', { call_id: 'explicit', name: 'edit', input: 'patch' }), item('custom_tool_call_output', { call_id: 'explicit', output: { success: true } })));
    expect(explicit.toolNotes[0]?.ok).toBe(true);
  });

  it('counts damaged lines before the first message on initial and reset reads, but not on cursor resume', () => {
    const initial = jsonl(meta()) + '{broken\n' + jsonl(message('user', 'first'));
    const first = parse(initial);
    expect(first.droppedLines).toEqual({ unreadable: 1, non_conversation: 1 });
    const resumed = parse(initial + jsonl(message('assistant', 'next', '2026-01-01T00:00:02Z')), first.cursor);
    expect(resumed.cursorReset).toBe(false);
    expect(resumed.droppedLines.unreadable).toBe(0);
    const rewritten = initial.replace('first', 'changed');
    const reset = parse(rewritten, first.cursor);
    expect(reset.cursorReset).toBe(true);
    expect(reset.droppedLines).toEqual({ unreadable: 1, non_conversation: 1 });
  });

  it('preserves identical message lines as distinct stable IDs across reparse and append', () => {
    const repeated = message('user', 'same words');
    const initial = jsonl(meta(), repeated, repeated);
    const first = parse(initial);
    const ids = first.messages.map(m => m.harnessMessageId);
    expect(first.messages.map(m => m.body)).toEqual(['same words', 'same words']);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(parse(initial).messages.map(m => m.harnessMessageId)).toEqual(ids);
    expect(parse(initial + jsonl(message('assistant', 'later'))).messages.slice(0, 2).map(m => m.harnessMessageId)).toEqual(ids);
    expect(parse(initial + jsonl(message('assistant', 'later')), first.cursor).messages[0]?.harnessMessageId).toBe(ids[1]);
  });

  it('reconstructs pending calls before the cursor when outputs arrive after intervening messages', () => {
    const before = jsonl(meta(), message('user', 'start'), item('function_call', { call_id: 'late', name: 'shell', arguments: '{}' }), message('assistant', 'continued', '2026-01-01T00:00:02Z'));
    const first = parse(before);
    expect(first.toolNotes).toEqual([]);
    const after = before + jsonl(item('function_call_output', { call_id: 'late', output: shellOutput(0) }));
    const second = parse(after, first.cursor);
    expect(second.cursorReset).toBe(false);
    expect(second.messages.map(m => m.body)).toEqual(['continued']);
    expect(second.toolNotes).toMatchObject([{ harnessMessageId: first.messages[0]!.harnessMessageId, callId: 'late', ordinal: 0, ok: true }]);
    expect(parse(after, second.cursor).toolNotes).toEqual(second.toolNotes);
  });

  it('pairs a late custom output after a newer message using the original call position', () => {
    const before = jsonl(meta(), message('user', 'start'), item('custom_tool_call', { call_id: 'custom-late', name: 'edit', input: 'patch' }), message('assistant', 'waiting', '2026-01-01T00:00:02Z'));
    const first = parse(before);
    const after = before + jsonl(item('custom_tool_call_output', { call_id: 'custom-late', output: { success: true } }));
    expect(first.toolNotes).toEqual([]);
    expect(parse(after, first.cursor).toolNotes).toMatchObject([{ callId: 'custom-late', harnessMessageId: first.messages[0]!.harnessMessageId, ok: true }]);
  });

  it('withholds all unterminated lines, counts complete bad lines, and reads a completed tail on resume', () => {
    const base = jsonl(meta(), message('user', 'first'));
    const tail = JSON.stringify(message('assistant', 'later', '2026-01-01T00:00:02Z'));
    const first = parse(base + tail);
    expect(first.messages.map(m => m.body)).toEqual(['first']);
    expect(first.droppedLines['unreadable']).toBe(0);
    const second = parse(base + tail + '\n{broken\n', first.cursor);
    expect(second.messages.map(m => m.body)).toEqual(['first', 'later']);
    expect(second.droppedLines['unreadable']).toBe(1);
    expect(second.cursor?.lastHarnessMessageId).toBe(second.messages[1]?.harnessMessageId);
  });

  it('resets on rewritten prefix or truncation and retains stable ids across append', () => {
    const original = jsonl(meta(), message('user', 'first'), message('assistant', 'second', '2026-01-01T00:00:02Z'));
    const first = parse(original);
    const appended = parse(original + jsonl(message('user', 'third', '2026-01-01T00:00:03Z')), first.cursor);
    expect(appended.cursorReset).toBe(false);
    expect(appended.messages[0]?.harnessMessageId).toBe(first.messages[1]?.harnessMessageId);
    const rewritten = parse(original.replace('first', 'changed'), first.cursor);
    expect(rewritten.cursorReset).toBe(true);
    expect(rewritten.messages.map(m => m.body)).toEqual(['changed', 'second']);
    expect(parse(jsonl(meta(), message('user', 'first')), first.cursor).cursorReset).toBe(true);
  });

  it('holds unknown results as unsuccessful and attaches calls before the first message with negative ordinals', () => {
    const result = parse(jsonl(meta(), item('custom_tool_call', { call_id: 'early', name: 'edit', input: 'x' }), item('custom_tool_call_output', { call_id: 'early', output: 'opaque output' }), message('user', 'hello')));
    expect(result.toolNotes).toMatchObject([{ ordinal: -1, ok: false, callId: 'early', harnessMessageId: result.messages[0]!.harnessMessageId }]);
  });
});
