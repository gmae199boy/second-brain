import {
  formatSessionToken,
  type IngestCounts,
  type IngestSessionInput,
  type IngestSessionResult,
  type WarningCode,
} from 'second_brain';
import type {
  CommandContextBase,
  CommandFailure,
  CommandSpec,
  SpoolCommandContext,
} from '../dispatch.js';
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
 * compares the stored schema version before `run` is called at all (AD-20).
 *
 * `spool`, so a database the guard found out of reach does not cost the turn
 * its conversation: the branch writes "ingest this session again" to the spool
 * and answers `SPOOLED`, with no brain and no store in its hands (AD-9). Both
 * halves read the payload with the same function, because the harness and the
 * session come off stdin either way and a second reading of it would be a
 * second thing to keep right.
 *
 * Nothing in here masks anything, and neither does what it calls: a message
 * body and a tool note target are stored exactly as the harness wrote them.
 * Secrets are masked where text leaves Brain — this command's own `--json`
 * envelope included, since Core masks an envelope as it builds it (마스킹 B,
 * AD-11). Taking a stored secret out of the database is `brain messages
 * redact` (story 2.13) and nothing else.
 */

export interface SessionsIngestData {
  /** `harness:harness_session_id`, the only session id that travels (AD-8). */
  session: string;
  /**
   * The database would not take this turn, so a mark went to the spool and a
   * later drain will ingest the session again (AD-9). The counts below are all
   * zero when it is true: they say what reached the database.
   */
  spooled: boolean;
  /** Whether this call is the one that created the session row. */
  created: boolean;
  inserted: IngestCounts;
  /**
   * How many lines of the transcript the parser walked past, by reason, or
   * `null` for a turn that went to the spool and so parsed nothing.
   *
   * It is `data` and not `meta`: a caller reading this is asking what was
   * collected, and "how much of the file was not" is part of that answer —
   * `unreadable`, the one reason that is a problem, also raises
   * `TRANSCRIPT_LINES_SKIPPED`.
   */
  droppedLines: Readonly<Record<string, number>> | null;
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
      '세션 토큰 `session`, 데이터베이스 대신 spool로 갔는지인 `spooled`, 그 세션을 이 호출이 만들었는지인 `created`, 넣은 건수 `inserted`(메시지 `messages`, 도구 메모 `toolNotes`), 파서가 메시지로 두지 않은 줄 수를 이유별로 담은 `droppedLines`(spool로 갔으면 `null`). 트랜스크립트는 대부분 대화가 아니므로 `droppedLines`는 정상입니다. 읽을 수 없던 줄인 `droppedLines.unreadable`만 `TRANSCRIPT_LINES_SKIPPED` 경고를 함께 냅니다. 본문과 도구 메모 대상은 원문 그대로 저장하고, 비밀은 나갈 때 가립니다. 페이로드에 `transcript_path`가 없으면 그 하네스의 트랜스크립트 폴더에서 `session_id`로 찾습니다',
    risk: 'write',
    hook: true,
    dryRun: false,
    writes: true,
    arguments: ['<harness>'],

    async run(context) {
      const payload = await readPayload(registry, context);
      if (!payload.ok) return payload;

      const result = await context.brain.sessions.ingest(payload.input);
      if (!result.ok) {
        return { ok: false as const, code: result.code, message: result.message };
      }

      return answer(result);
    },

    async spool(context: SpoolCommandContext) {
      const payload = await readPayload(registry, context);
      if (!payload.ok) return payload;

      // The same Core function the use case reaches when a lock stops it
      // mid-ingest, and the only thing this branch can do: there is no brain
      // and no store in `context`, by design (AD-9, Design Notes).
      const result = await context.spoolIngest(payload.input, context.cause);
      if (!result.ok) {
        return { ok: false as const, code: result.code, message: result.message };
      }

      return answer(result);
    },
  };
}

/**
 * What both halves answer with, so one shape cannot drift into two.
 *
 * It takes the success branch of the Core result rather than the data it wants,
 * because the two are the same shape by design: what this command reports *is*
 * what the use case did, and a field added to one has to appear in the other
 * (AD-5).
 */
function answer(result: Extract<IngestSessionResult, { ok: true }>): {
  ok: true;
  data: SessionsIngestData;
  warnings: readonly WarningCode[];
  text: readonly string[];
} {
  return {
    ok: true,
    data: {
      session: result.session,
      spooled: result.spooled,
      created: result.created,
      inserted: result.inserted,
      droppedLines: result.droppedLines,
    },
    warnings: result.warnings,
    // Nothing on stdout: this runs after every turn, and a brain that printed
    // a line each time would be a brain in the way (AD-6).
    text: [],
  };
}

/**
 * The harness this invocation named and the payload on its standard input, as
 * the session and transcript Core takes.
 *
 * Both `run` and `spool` come through here. The two differ in what they do with
 * the result and in nothing else: which harness wrote the payload, and whether
 * the payload is one at all, are facts about the invocation and not about
 * whether the database happens to be reachable.
 */
async function readPayload(
  registry: readonly Harness[],
  context: CommandContextBase,
): Promise<{ ok: true; input: IngestSessionInput } | CommandFailure> {
  const name = context.args[0] ?? '';
  const harness = registry.find((candidate) => candidate.parser.harness === name);
  if (harness === undefined) {
    return {
      ok: false,
      code: 'USAGE',
      message: `"${name}"라는 하네스가 없습니다. ${known(registry)}`,
      exit: 2,
    };
  }

  // Read only once a harness has been chosen: the adapter that reads the
  // payload is the one the word named, and an unknown word must not leave a
  // hook waiting on a pipe.
  const payload = harness.readHookInput(await context.stdin());
  if (!payload.ok) {
    return { ok: false, code: payload.code, message: payload.message, exit: 2 };
  }

  await context.recordHookArrival(harness.parser.harness);

  return {
    ok: true,
    input: {
      session: formatSessionToken({
        harness: harness.parser.harness,
        harnessSessionId: payload.input.harnessSessionId,
      }),
      // The empty string for a payload that named no path, which is what makes
      // the ingest look the file up in the harness's folder by session id: a
      // hook that reported only `session_id` is still a hook worth acting on.
      transcriptPath: payload.input.transcriptPath ?? '',
    },
  };
}

/** The names this build accepts, for the `USAGE` message. */
function known(registry: readonly Harness[]): string {
  if (registry.length === 0) return '이 빌드는 어떤 하네스에서도 수집할 수 없습니다.';
  return `아는 하네스: ${registry.map((harness) => harness.parser.harness).join(', ')}.`;
}
