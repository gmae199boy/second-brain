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
    nsDescription: 'read and search what harnesses wrote',
    description: 'ingest the transcript a harness hook reported, from its payload on stdin',
    hook: true,
    writes: true,
    arguments: ['<harness>'],

    async run(context: CommandContext) {
      const name = context.args[0] ?? '';
      const harness = registry.find((candidate) => candidate.parser.harness === name);
      if (harness === undefined) {
        return {
          ok: false as const,
          code: 'USAGE',
          message: `no harness called "${name}". ${known(registry)}`,
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
  if (registry.length === 0) return 'This build can ingest from no harness.';
  return `Known harnesses: ${registry.map((harness) => harness.parser.harness).join(', ')}.`;
}
