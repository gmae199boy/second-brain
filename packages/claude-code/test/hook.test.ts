import { describe, expect, it } from 'vitest';
import { readClaudeCodeHookInput } from '../src/hook.js';

/**
 * Reading what Claude Code puts on a hook's stdin. The whole of what this has
 * to get right is that nothing it is handed can make it throw: it runs on the
 * critical path of a turn, and a payload from the wrong tool, a truncated one,
 * or none at all is a `USAGE` the caller reports in one line (AD-6).
 */

/** A Stop payload as the editor writes it, with the fields other events share. */
const STOP = {
  session_id: '4f1e7a90-1c2b-4d3e-8f55-000000000000',
  transcript_path: '/demo/.claude/projects/-demo-repo/4f1e7a90.jsonl',
  cwd: '/demo/repo',
  hook_event_name: 'Stop',
  permission_mode: 'default',
  stop_hook_active: false,
};

describe('readClaudeCodeHookInput', () => {
  it('reads the session id and the transcript path, and nothing else', () => {
    const result = readClaudeCodeHookInput(JSON.stringify(STOP));

    expect(result).toEqual({
      ok: true,
      input: {
        harnessSessionId: STOP.session_id,
        transcriptPath: STOP.transcript_path,
      },
    });
  });

  it('reads a payload the editor wrote with a trailing newline', () => {
    const result = readClaudeCodeHookInput(`${JSON.stringify(STOP)}\n`);

    expect(result.ok).toBe(true);
  });

  it.each([
    ['nothing at all', ''],
    ['only whitespace', '  \n'],
    ['text that is not JSON', 'Stop'],
    ['a truncated object', '{"session_id":"abc"'],
    ['JSON that is not an object', '["abc"]'],
    ['an object with neither field', JSON.stringify({ hook_event_name: 'Stop' })],
    ['no session id', JSON.stringify({ transcript_path: '/demo/t.jsonl' })],
    ['an empty session id', JSON.stringify({ ...STOP, session_id: '' })],
    ['a session id that is not a string', JSON.stringify({ ...STOP, session_id: 7 })],
  ])('refuses %s as a USAGE, saying why', (_name, stdin) => {
    const result = readClaudeCodeHookInput(stdin);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('USAGE');
    expect(result.message).not.toBe('');
  });

  it('names the field that was missing, so the line on stderr is worth reading', () => {
    const result = readClaudeCodeHookInput(JSON.stringify({ transcript_path: '/demo/t.jsonl' }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain('session_id');
  });

  it.each([
    ['a payload with no transcript path', JSON.stringify({ session_id: 'abc' })],
    ['a transcript path that is not a string', JSON.stringify({ ...STOP, transcript_path: null })],
    ['an empty transcript path', JSON.stringify({ ...STOP, transcript_path: '' })],
  ])('reads %s as a session with no path, not as a USAGE', (_name, stdin) => {
    // The path is optional: the session id is what a collection needs, and the
    // ingest looks the file up in the editor's folder by session id when no
    // path was given (story 12). Refusing it would turn the one recoverable
    // payload into a `USAGE` the hook could do nothing about.
    const result = readClaudeCodeHookInput(stdin);

    expect(result).toMatchObject({ ok: true, input: { transcriptPath: null } });
  });
});
