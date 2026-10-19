/**
 * What a harness hook tells us about the turn that just ended: the session it
 * was, and — when the payload says — where its transcript is. Every
 * harness spells its payload its own way — Claude Code writes JSON on stdin
 * with snake_case keys — so reading it is the connector's job and this is what
 * comes out of it (AD-4).
 *
 * The harness name is not in here: the payload does not carry one, which is
 * why `brain sessions ingest <harness>` takes it as a positional argument and
 * the adapter that reads the payload is chosen by that word.
 */
export interface HookInput {
  /** The harness's own session identifier; the second half of a token (AD-8). */
  harnessSessionId: string;
  /**
   * Where the harness is writing this session's transcript, or `null` when the
   * payload did not say.
   *
   * It is nullable because not every payload carries one, and because a path is
   * no longer the only way to find a transcript: the ingest can look the file up
   * in the harness's folder by session id (`IngestSessionInput.transcriptPath`).
   * So a payload with no path is a payload that still names a session, and
   * refusing it would turn the one recoverable case into a `USAGE`.
   */
  transcriptPath: string | null;
}

/**
 * What reading a hook payload produced. A payload that is empty, not JSON, or
 * missing the session id is a `USAGE`: nothing about the brain is wrong, the
 * call was made wrongly (Conventions).
 */
export type ReadHookInputResult =
  | { ok: true; input: HookInput }
  | { ok: false; code: 'USAGE'; message: string };

/**
 * Reading what the harness put on stdin. A pure function of the text, so the
 * connector needs no process and no stream: whoever owns stdin reads it and
 * passes the string in.
 */
export type HookInputReader = (stdin: string) => ReadHookInputResult;
