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
        'stdin으로 아무것도 오지 않았습니다. `sessions ingest claude-code`는 Claude Code hook이 그곳에 쓰는 JSON 페이로드를 읽습니다.',
    };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(stdin);
  } catch (error) {
    return {
      ok: false,
      code: 'USAGE',
      message: `stdin의 hook 페이로드가 JSON이 아닙니다: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) {
    return {
      ok: false,
      code: 'USAGE',
      message: 'stdin의 hook 페이로드가 JSON이지만 객체가 아닙니다',
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
      message: `hook 페이로드에 ${missing.join('와 ')}가 없습니다. Claude Code의 모든 hook 이벤트가 담고 있는 값입니다`,
    };
  }

  return { ok: true, input: { harnessSessionId, transcriptPath } };
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
