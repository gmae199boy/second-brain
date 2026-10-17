import { formatSessionToken, type IngestCounts } from 'second_brain';
import type { CommandContext, CommandSpec } from '../dispatch.js';
import type { Harness } from '../harnesses.js';

/**
 * `brain sessions ingest <harness>`: read the transcript of the session a
 * harness hook just reported, and append whatever is new.
 *
 * The harness is a positional argument because the payload does not say which
 * harness wrote it — Claude Code's Stop hook sends a session id and a
 * transcript path and nothing that names the editor — so the word on the
 * command line is what chooses the adapter that reads stdin (AD-4).
 *
 * `hook: true`, so whatever happens the exit code is 0 and a failure is one
 * line on stderr: this is on the critical path of a turn and a broken brain
 * must never break one (AD-6). `writes: true`, so the dispatcher's write guard
 * compares the stored schema version first (AD-20).
 *
 * Nothing in here masks anything: the secrets of a conversation are taken out
 * by Core as the batch is built, so this command only ever sees the count
 * (AD-11). It reports it in the JSON envelope's `inserted.redactions` and
 * nowhere else — text mode prints nothing at all, because this runs after every
 * turn. The count is of body maskings alone: a tool note's target is masked
 * too, and leaves no record to count (Decision 2026-10-18).
 */

export interface SessionsIngestData {
  /** `harness:harness_session_id`, the only session id that travels (AD-8). */
  session: string;
  /** Whether this call is the one that created the session row. */
  created: boolean;
  inserted: IngestCounts;
}

export function sessionsIngestCommand(
  registry: readonly Harness[],
): CommandSpec<SessionsIngestData> {
  return {
    ns: 'sessions',
    verb: 'ingest',
    nsDescription: '하네스가 쓴 것을 읽고 찾습니다',
    usedFor: 'stdin의 페이로드로 하네스 hook이 알린 트랜스크립트를 수집합니다',
    // `stdin` is in here with the argument because the payload is an input a
    // caller has to supply, and the only place it can be supplied is there.
    required: ['harness', 'stdin'],
    examples: ['brain sessions ingest claude-code'],
    output:
      '세션 토큰 `session`, 그 세션을 이 호출이 만들었는지인 `created`, 넣은 건수 `inserted`(메시지 `messages`, 도구 메모 `toolNotes`, 저장 전에 가린 비밀의 기록 `redactions`)',
    risk: 'write',
    hook: true,
    dryRun: false,
    writes: true,
    arguments: ['<harness>'],

    async run(context: CommandContext) {
      const name = context.args[0] ?? '';
      const harness = registry.find((candidate) => candidate.parser.harness === name);
      if (harness === undefined) {
        return {
          ok: false as const,
          code: 'USAGE',
          message: `"${name}"라는 하네스가 없습니다. ${known(registry)}`,
          exit: 2 as const,
        };
      }

      // Read only once a harness has been chosen: the adapter that reads the
      // payload is the one the word named, and an unknown word must not leave
      // a hook waiting on a pipe.
      const payload = harness.readHookInput(await context.stdin());
      if (!payload.ok) {
        return {
          ok: false as const,
          code: payload.code,
          message: payload.message,
          exit: 2 as const,
        };
      }

      const result = await context.brain.sessions.ingest({
        session: formatSessionToken({
          harness: harness.parser.harness,
          harnessSessionId: payload.input.harnessSessionId,
        }),
        transcriptPath: payload.input.transcriptPath,
      });
      if (!result.ok) {
        return { ok: false as const, code: result.code, message: result.message };
      }

      return {
        ok: true as const,
        data: {
          session: result.session,
          created: result.created,
          inserted: result.inserted,
        },
        warnings: result.warnings,
        // Nothing on stdout: this runs after every turn, and a brain that
        // printed a line each time would be a brain in the way (AD-6).
        text: [],
      };
    },
  };
}

/** The names this build accepts, for the `USAGE` message. */
function known(registry: readonly Harness[]): string {
  if (registry.length === 0) return '이 빌드는 어떤 하네스에서도 수집할 수 없습니다.';
  return `아는 하네스: ${registry.map((harness) => harness.parser.harness).join(', ')}.`;
}
