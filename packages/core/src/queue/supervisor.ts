import { failureText } from '../domain/failure.js';
import { retryDelayMs, SUPERVISOR_POLL_MS, SUPERVISOR_RENEW_EVERY_MS, SUPERVISOR_CANCEL_GRACE_MS, SUPERVISOR_CANCEL_POLL_MS, SUPERVISOR_GROUP_CONFIRM_MS, workExecutionClass, type WorkItem } from '../domain/work-item.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ProcessInspector, ProcessLauncher, ProcessSpec } from '../ports/process.js';
import type { FinishWorkResult, SchemaStore, WorkStore } from '../ports/store.js';
import { decodeAbiLine } from '../process-abi/codec.js';
import { checkSchema, type SchemaVersions } from '../schema.js';
import { cleanProcessGroup, inspectGroup, type GroupIdentity } from './process-cleanup.js';
export interface SupervisorOptions {
  store: WorkStore & SchemaStore; launcher: ProcessLauncher; inspector: ProcessInspector;
  clock: Clock; timer: Timer; idGen: IdGen;
  launches: Readonly<Record<string, (item: WorkItem, token: string) => ProcessSpec | null>>;
  signal: AbortSignal; log?: (message: string) => void | Promise<void>; schemaVersions?: SchemaVersions;
  pollMs?: number; renewEveryMs?: number; cancelGraceMs?: number; cancelPollMs?: number; groupConfirmMs?: number;
}
/** Every database transaction completes before waiting on a child or signal grace. */
export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const { store, launcher, inspector, clock, timer, idGen, launches, signal } = options;
  const kinds = Object.keys(launches).filter(kind => workExecutionClass(kind) === 'supervised');
  const claimedBy = idGen.next();
  let reconciled = false;
  let pendingSettlement: (() => Promise<FinishWorkResult>) | undefined;
  let lastProblem: string | undefined;
  async function problem(message?: string): Promise<void> {
    if (message !== undefined && message !== lastProblem) await options.log?.(message);
    lastProblem = message;
  }
  async function retrySettlement(): Promise<void> {
    if (!pendingSettlement) return;
    const finished = await pendingSettlement();
    if (!finished.ok) await problem(`감독자 결과 확정 실패 (${finished.code})`);
    else {
      pendingSettlement = undefined;
      if (finished.outcome === 'lost') await problem('감독자가 결과를 확정하기 전에 시도 토큰을 잃었습니다');
      else await problem();
    }
  }
  const cleanup = (identity: GroupIdentity, extra: { handle?: import('../ports/process.js').ProcessHandle } = {}) => cleanProcessGroup({
    inspector, identity, clock, timer, graceMs: options.cancelGraceMs ?? SUPERVISOR_CANCEL_GRACE_MS,
    confirmMs: options.groupConfirmMs ?? SUPERVISOR_GROUP_CONFIRM_MS, ...extra,
  });
  async function reconcile(): Promise<boolean> {
    const open = await store.listOpenSupervisedAttempts();
    if (!open.ok) { await problem(`감독자 이전 시도 조회 실패 (${open.code})`); return false; }
    for (const attempt of open.attempts) {
      if (attempt.incarnation === claimedBy) continue;
      const state = await inspectGroup(inspector, attempt);
      const outcome = state === 'ours' ? await cleanup(attempt) : state;
      const settled = await store.settleSupervisedAttempt({ id: attempt.workItemId, attemptToken: attempt.token, now: clock.now(), outcome });
      if (!settled.ok) { await problem(`감독자 이전 시도 정산 실패 (${settled.code})`); return false; }
    }
    return true;
  }
  async function execute(item: WorkItem, token: string): Promise<void> {
    let failed: string | undefined;
    let result = false;
    let stopped = false;
    const spec = launches[item.kind]?.(item, token) ?? null;
    const started = spec === null ? { ok: false as const, message: '일감 실행 명세가 없습니다' } : await launcher.start(spec);
    if (!started.ok) failed = started.message;
    else {
      const handle = started.handle;
      const exited = handle.exited;
      const [boot, start] = await Promise.all([inspector.bootTime(), inspector.startedAt(handle.pid)]);
      const identity: GroupIdentity = { pgid: handle.pid, osBootAt: boot.state === 'found' ? boot.value : null,
        osStartedAt: start.state === 'found' ? start.value : null };
      if (identity.osBootAt === null || identity.osStartedAt === null) await problem('감독자가 자식의 OS 시작 신원을 확인하지 못했습니다');
      const recorded = await store.recordSupervisedProcess({ id: item.id, attemptToken: token, pid: handle.pid, pgid: handle.pid,
        osBootAt: identity.osBootAt, osStartedAt: identity.osStartedAt });
      if (!recorded.ok) await problem(`감독자 프로세스 기록 실패 (${recorded.code})`);
      const watch = new AbortController();
      let stopResolve!: () => void;
      const stop = new Promise<void>(resolve => { stopResolve = resolve; });
      const abort = (): void => { stopped = true; stopResolve(); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const poll = (async () => {
        while (!watch.signal.aborted) {
          await timer.sleep(options.cancelPollMs ?? SUPERVISOR_CANCEL_POLL_MS, watch.signal);
          if (watch.signal.aborted) break;
          const open = await store.listOpenSupervisedAttempts();
          if (!open.ok) { await problem(`감독자 취소 요청 조회 실패 (${open.code})`); continue; }
          if (open.attempts.some(a => a.token === token && a.cancelRequested)) { stopped = true; stopResolve(); break; }
        }
      })();
      let lastRenewed = -Infinity;
      let readingStopped = false;
      let pendingRenewal: ReturnType<WorkStore['renewSupervisedLease']> | undefined;
      const read = (async () => {
        try {
          for await (const line of handle.lines) {
            if (readingStopped) break;
            const decoded = decodeAbiLine(line);
            if (!decoded.ok) { failed = decoded.reason; stopResolve(); break; }
            if (decoded.event.type === 'result') result = true;
            else {
              const now = clock.now();
              if (now.getTime() - lastRenewed >= (options.renewEveryMs ?? SUPERVISOR_RENEW_EVERY_MS)) {
                pendingRenewal = store.renewSupervisedLease({ id: item.id, attemptToken: token, now, progressAt: now });
                const renewed = await pendingRenewal;
                pendingRenewal = undefined;
                if (!renewed.ok) await problem(`감독자 임대 갱신 실패 (${renewed.code})`);
                else if (renewed.outcome === 'lost') await problem('감독자가 일감의 시도 토큰을 잃었습니다');
                else { lastRenewed = now.getTime(); await problem(); }
              }
            }
          }
        } catch { failed = '자식 프로세스 출력을 읽을 수 없습니다'; stopResolve(); }
      })();
      try {
        await Promise.race([exited, stop]);
        // Always confirm the group before terminal settlement. A cancellation can
        // commit after our last read, including when leader exit wins the race.
        const cleaned = await cleanup(identity, { handle });
        if (cleaned === 'unknown') {
          readingStopped = true;
          await pendingRenewal;
          const input = { id: item.id, attemptToken: token, now: clock.now(), outcome: 'unknown' as const };
          pendingSettlement = () => store.settleSupervisedAttempt(input);
          await retrySettlement();
          return;
        }
        const exit = await exited;
        // Drain buffered ABI lines, but inherited pipes can outlive both the
        // leader and its original group. Closing them releases the iterator.
        const outputWait = new AbortController();
        try { await Promise.race([read, timer.sleep(options.groupConfirmMs ?? SUPERVISOR_GROUP_CONFIRM_MS, outputWait.signal)]); }
        finally { outputWait.abort(); handle.closeOutput(); }
        await read;
        if (exit.code !== 0 || exit.signal !== null) failed ??= '자식 프로세스가 정상 종료하지 않았습니다';
        if (!result) failed ??= '자식 프로세스가 결과 없이 종료했습니다';
      } finally {
        readingStopped = true; handle.closeOutput();
        watch.abort(); await poll; signal.removeEventListener('abort', abort);
      }
    }
    const now = clock.now();
    // A valid result and exit zero win a cancellation race. Shutdown returns unfinished work.
    if (signal.aborted || (stopped && failed !== undefined)) {
      const input = { id: item.id, attemptToken: token, now, outcome: 'cancelled' as const };
      pendingSettlement = () => store.settleSupervisedAttempt(input);
    } else {
      const input = { id: item.id, attemptToken: token, now, outcome: failed === undefined ? 'succeeded' as const : 'failed' as const,
        ...(failed === undefined ? {} : { nextAttemptAt: new Date(now.getTime() + retryDelayMs(item.attempts)), lastError: failureText(failed) }) };
      pendingSettlement = () => store.finishSupervisedWork(input);
    }
    await retrySettlement();
  }
  while (!signal.aborted) {
    try {
      const schema = await checkSchema(store, options.schemaVersions ?? { core: 3 });
      if (!schema.ok) await problem(`감독자 데이터베이스 확인 실패 (${schema.code})`);
      else {
        await retrySettlement();
        if (pendingSettlement) {
          await timer.sleep(options.pollMs ?? SUPERVISOR_POLL_MS, signal);
          continue;
        }
        if (!reconciled) reconciled = await reconcile();
        if (reconciled && !signal.aborted) {
          const token = idGen.next();
          const claimed = await store.claimSupervisedWork({ now: clock.now(), claimedBy, kinds, attemptToken: token });
          if (!claimed.ok) await problem(`감독자 청구 실패 (${claimed.code})`);
          else { await problem(); if (claimed.item !== null) await execute(claimed.item, token); }
        }
      }
    } catch { await problem('감독자 실행 중 오류가 발생했습니다'); }
    if (!signal.aborted) await timer.sleep(options.pollMs ?? SUPERVISOR_POLL_MS, signal);
  }
}
