import { failureText } from '../domain/failure.js';
import { retryDelayMs, SUPERVISOR_POLL_MS, SUPERVISOR_RENEW_EVERY_MS, workExecutionClass, type WorkItem } from '../domain/work-item.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ProcessLauncher, ProcessSpec } from '../ports/process.js';
import type { SchemaStore, WorkStore } from '../ports/store.js';
import { decodeAbiLine } from '../process-abi/codec.js';
import { checkSchema, type SchemaVersions } from '../schema.js';

export interface SupervisorOptions {
  store: WorkStore & SchemaStore;
  launcher: ProcessLauncher;
  clock: Clock;
  timer: Timer;
  idGen: IdGen;
  launches: Readonly<Record<string, (item: WorkItem, token: string) => ProcessSpec | null>>;
  signal: AbortSignal;
  log?: (message: string) => void | Promise<void>;
  schemaVersions?: SchemaVersions;
  pollMs?: number;
  renewEveryMs?: number;
}
/** Independent of core drain; every database operation finishes before waiting on a child. */
export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const { store, launcher, clock, timer, idGen, launches, signal } = options;
  const kinds = Object.keys(launches).filter((kind) => workExecutionClass(kind) === 'supervised');
  const claimedBy = idGen.next();
  let lastProblem: string | undefined;
  async function problem(message?: string): Promise<void> {
    if (message !== undefined && message !== lastProblem) await options.log?.(message);
    lastProblem = message;
  }
  while (!signal.aborted) {
    try {
      const schema = await checkSchema(store, options.schemaVersions ?? { core: 2 });
      if (!schema.ok) await problem(`감독자 데이터베이스 확인 실패 (${schema.code})`);
      else if (!signal.aborted) {
        const token = idGen.next();
        const claimed = await store.claimSupervisedWork({ now: clock.now(), claimedBy, kinds, attemptToken: token });
        if (!claimed.ok) await problem(`감독자 청구 실패 (${claimed.code})`);
        else {
          await problem();
          if (claimed.item !== null) {
            const item = claimed.item;
            let failed: string | undefined;
            let result = false;
            const spec = launches[item.kind]?.(item, token) ?? null;
            const started = spec === null ? { ok: false as const, message: '일감 실행 명세가 없습니다' } : await launcher.start(spec);
            if (!started.ok) failed = started.message;
            else {
              const handle = started.handle;
              const kill = (): void => { handle.signalGroup('SIGKILL'); };
              signal.addEventListener('abort', kill, { once: true });
              if (signal.aborted) kill();
              // Persist even a short child’s first progress; subsequent writes are throttled.
              let lastRenewed = -Infinity;
              try {
                for await (const line of handle.lines) {
                  if (signal.aborted) break;
                  const decoded = decodeAbiLine(line);
                  if (!decoded.ok) { failed = decoded.reason; kill(); break; }
                  if (decoded.event.type === 'result') result = true;
                  else {
                    const now = clock.now();
                    if (now.getTime() - lastRenewed >= (options.renewEveryMs ?? SUPERVISOR_RENEW_EVERY_MS)) {
                      const renewed = await store.renewSupervisedLease({ id: item.id, attemptToken: token, now, progressAt: now });
                      if (!renewed.ok) await problem(`감독자 임대 갱신 실패 (${renewed.code})`);
                      else if (renewed.outcome === 'lost') await problem('감독자가 일감의 시도 토큰을 잃었습니다');
                      else { lastRenewed = now.getTime(); await problem(); }
                    }
                  }
                }
                const exit = await handle.exited;
                if (exit.code !== 0 || exit.signal !== null) failed ??= '자식 프로세스가 정상 종료하지 않았습니다';
                if (!result) failed ??= '자식 프로세스가 결과 없이 종료했습니다';
              } finally { signal.removeEventListener('abort', kill); }
            }
            if (signal.aborted) return;
            const now = clock.now();
            const finished = await store.finishSupervisedWork({ id: item.id, attemptToken: token, now,
              outcome: failed === undefined ? 'succeeded' : 'failed',
              ...(failed === undefined ? {} : { nextAttemptAt: new Date(now.getTime() + retryDelayMs(item.attempts)), lastError: failureText(failed) }),
            });
            if (!finished.ok) await problem(`감독자 결과 확정 실패 (${finished.code})`);
            else if (finished.outcome === 'lost') await problem('감독자가 결과를 확정하기 전에 시도 토큰을 잃었습니다');
          }
        }
      }
    } catch { await problem('감독자 실행 중 오류가 발생했습니다'); }
    if (!signal.aborted) await timer.sleep(options.pollMs ?? SUPERVISOR_POLL_MS, signal);
  }
}
