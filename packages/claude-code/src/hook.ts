import type { ReadHookInputResult } from '@second-brain/core';

/**
 * Read what Claude Code puts on a hook's stdin.
 *
 * Every hook event gets one JSON object, and the two fields this needs are in
 * all of them: `session_id`, the editor's own id for the conversation, and
 * `transcript_path`, the JSON Lines file it is appending to. Everything else in
 * there — the event name, the cwd, the permission mode, whatever the event
 * itself carries — is another story's (2.7, 2.8).
 *
 * The name of the harness is deliberately not read from the payload, because
 * the payload does not carry one: `brain sessions ingest <harness>` takes it as
 * a positional argument, and that word is what chose this function.
 *
 * Nothing here throws. A hook runs on the critical path of a turn, and a
 * payload that is empty, truncated or from some other tool is a `USAGE` the
 * caller reports in one line (AD-6, Conventions).
 */
export function readClaudeCodeHookInput(stdin: string): ReadHookInputResult {
  if (stdin.trim() === '') {
    return {
      ok: false,
      code: 'USAGE',
      message:
        'nothing arrived on stdin. `sessions ingest claude-code` reads the JSON payload a Claude Code hook writes there.',
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return {
      ok: false,
      code: 'USAGE',
      message: `the hook payload on stdin is not JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      code: 'USAGE',
      message: 'the hook payload on stdin is JSON but not an object',
    };
  }

  const record = payload as Record<string, unknown>;
  const harnessSessionId = asString(record['session_id']);
  const transcriptPath = asString(record['transcript_path']);
  const missing = [
    harnessSessionId === undefined ? 'session_id' : '',
    transcriptPath === undefined ? 'transcript_path' : '',
  ].filter((name) => name !== '');
  if (harnessSessionId === undefined || transcriptPath === undefined) {
    return {
      ok: false,
      code: 'USAGE',
      message: `the hook payload is missing ${missing.join(' and ')}, which every Claude Code hook event carries`,
    };
  }

  return { ok: true, input: { harnessSessionId, transcriptPath } };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
