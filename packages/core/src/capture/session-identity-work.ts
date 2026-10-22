import { parseSessionToken } from '../domain/session-token.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { Parser } from '../ports/parser.js';
import type { RepositoryInspector } from '../ports/repository.js';
import type { SessionStore, WorkStore } from '../ports/store.js';
import type { TranscriptFolder, TranscriptReader } from '../ports/transcript.js';
import type { WorkHandler, WorkHandlerResult } from '../queue/drain.js';
import { checkoutFor, firstCwd, locateTranscript } from '../sessions/ingest.js';
import { about } from './session-ingest-work.js';

export const SESSION_IDENTITY_KIND = 'session_identity';
/** Internal work failure, deliberately outside the command error-code table. */
export const REPOSITORY_UNANSWERED = 'REPOSITORY_UNANSWERED';

export interface SessionIdentityWorkDependencies {
  store: Pick<SessionStore, 'findSession' | 'fillSessionTags'> & Pick<WorkStore, 'resolveFailures'>;
  parsers: readonly Parser[];
  transcripts: TranscriptReader;
  transcriptFolders: readonly TranscriptFolder[];
  repositories: RepositoryInspector;
  clock: Clock;
  idGen: IdGen;
}

/** Re-read the original evidence: stored message rows intentionally omit cwd. */
export function sessionIdentityHandler(deps: SessionIdentityWorkDependencies): WorkHandler {
  return async (item) => {
    const { store, clock } = deps;
    const success = async (): Promise<WorkHandlerResult> => {
      await store.resolveFailures({
        targetKind: 'session', targetId: item.targetId,
        stage: SESSION_IDENTITY_KIND, now: clock.now(),
      });
      return { ok: true };
    };
    const failure = async (result: { code: string; message: string }): Promise<WorkHandlerResult> => ({
      ok: false, ...result,
      ...(result.code === 'TRANSCRIPT_UNREADABLE' ? { retryable: false } : {}),
      ...(await about(store, item.targetId)),
    });

    const token = parseSessionToken(item.targetId);
    if (!token.ok) return failure({ code: 'USAGE', message: token.message });
    const found = await store.findSession(token.key);
    if (!found.ok) return failure(found);
    if (found.session === null ||
        found.session.projectId !== null || found.session.worktreeId !== null) return success();

    const parser = deps.parsers.find((candidate) => candidate.harness === token.key.harness);
    if (parser === undefined) {
      return failure({ code: 'USAGE', message: `"${token.key.harness}" 하네스를 읽을 파서가 없습니다` });
    }
    const located = await locateTranscript(deps.transcriptFolders, token.key);
    let cwd = found.session.firstCwd;
    if (located.ok) {
      const read = await deps.transcripts.read(located.path);
      if (read.ok) {
        const parsed = parser.parse(read.content, null);
        if (!parsed.ok) return failure(parsed);
        // A transcript with no cwd line keeps the stored evidence; with neither
        // there is nothing to ask, which closes the work as story 20 did.
        cwd = parsed.startCwd ?? firstCwd(parsed.messages) ?? cwd;
        if (cwd === null) return success();
      } else if (cwd === null) return failure(read);
    } else if (cwd === null) return failure(located);
    if (cwd === null) return success();
    const asked = await checkoutFor(deps.repositories, deps.idGen, cwd);
    if (asked.unknown !== null) {
      return failure({
        code: REPOSITORY_UNANSWERED,
        message: `저장소 정체성을 확인하지 못했습니다 (${asked.unknown.reason}): ${asked.unknown.message}`,
      });
    }
    const filled = await store.fillSessionTags({
      key: token.key, checkout: asked.checkout, tagSource: asked.tagSource, firstCwd: cwd,
    });
    if (!filled.ok) return failure(filled);
    return success();
  };
}
