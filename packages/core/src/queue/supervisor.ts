import { failureFingerprint, failureText } from '../domain/failure.js';
import { MAX_WORK_ATTEMPTS, workKindPolicy, workStallWindowMs, SUPERVISOR_POLL_MS, SUPERVISOR_RENEW_EVERY_MS, SUPERVISOR_CANCEL_GRACE_MS, SUPERVISOR_CANCEL_POLL_MS, SUPERVISOR_GROUP_CONFIRM_MS, workExecutionClass, type WorkItem } from '../domain/work-item.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ProcessInspector, ProcessLauncher, ProcessSpec } from '../ports/process.js';
import type { FinishWorkResult, SchemaStore, WorkStore } from '../ports/store.js';
import { createAbiRun, createAbiStderr, type AbiRunVerdict } from '../process-abi/codec.js';
import { checkSchema, type SchemaVersions } from '../schema.js';
import { cleanProcessGroup, inspectGroup, type GroupIdentity } from './process-cleanup.js';
export interface SupervisorOptions {
  store: WorkStore & SchemaStore; launcher: ProcessLauncher; inspector: ProcessInspector;
  clock: Clock; timer: Timer; idGen: IdGen;
  launches: Readonly<Record<string, (item: WorkItem, token: string) => ProcessSpec | null>>;
  signal: AbortSignal; log?: (message: string) => void | Promise<void>; schemaVersions?: SchemaVersions;
  stallWindowMs?: (kind: string) => number;
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
    const run = createAbiRun(), stderr = createAbiStderr();
    const startedAt = clock.now().getTime();
    let endedAt: number | undefined;
    let verdict: AbiRunVerdict;
    let exit = { code: null as number | null, signal: null as string | null };
    let stopped = false;
    let terminationCause: 'exit' | 'cancelled' | 'stalled' | 'protocol' | undefined;
    let sawFinal = false;
    let started: Awaited<ReturnType<ProcessLauncher['start']>>;
    try {
      const spec = launches[item.kind]?.(item, token) ?? null;
      started = spec === null ? { ok: false, message: '일감 실행 명세가 없습니다' } : await launcher.start(spec);
    } catch { started = { ok: false, message: '자식 프로세스를 시작할 수 없습니다' }; }
    if (!started.ok) { run.fail('PROCESS_START_FAILED', started.message); failed = started.message; }
    else {
      const childStartedAt = clock.now().getTime();
      const handle = started.handle;
      let stopResolve!: () => void;
      const stop = new Promise<void>(resolve => { stopResolve = resolve; });
      const terminate = (cause: NonNullable<typeof terminationCause>): void => {
        if (terminationCause !== undefined) return;
        terminationCause = cause; stopResolve();
      };
      const exited = handle.exited.then(value => { endedAt = clock.now().getTime(); terminate('exit'); return value; });
      // Consume stderr while identity/database work is pending so the adapter
      // cannot accumulate an unbounded diagnostic queue behind these awaits.
      const readStderr = (async () => {
        try { for await (const chunk of handle.stderr) stderr.feed(chunk); }
        catch { run.fail('ABI_OUTPUT_UNREADABLE', '자식 프로세스 출력을 읽을 수 없습니다'); failed = '출력 읽기 실패'; terminate('protocol'); }
      })();
      const [boot, start] = await Promise.all([inspector.bootTime(), inspector.startedAt(handle.pid)]);
      const identity: GroupIdentity = { pgid: handle.pid, osBootAt: boot.state === 'found' ? boot.value : null,
        osStartedAt: start.state === 'found' ? start.value : null };
      if (identity.osBootAt === null || identity.osStartedAt === null) await problem('감독자가 자식의 OS 시작 신원을 확인하지 못했습니다');
      const recorded = await store.recordSupervisedProcess({ id: item.id, attemptToken: token, pid: handle.pid, pgid: handle.pid,
        osBootAt: identity.osBootAt, osStartedAt: identity.osStartedAt });
      if (!recorded.ok) await problem(`감독자 프로세스 기록 실패 (${recorded.code})`);
      const watch = new AbortController();
      const abort = (): void => { stopped = true; terminate('cancelled'); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      const poll = (async () => {
        while (!watch.signal.aborted) {
          await timer.sleep(options.cancelPollMs ?? SUPERVISOR_CANCEL_POLL_MS, watch.signal);
          if (watch.signal.aborted) break;
          const open = await store.listOpenSupervisedAttempts();
          if (!open.ok) { await problem(`감독자 취소 요청 조회 실패 (${open.code})`); continue; }
          if (open.attempts.some(a => a.token === token && a.cancelRequested)) { stopped = true; terminate('cancelled'); break; }
        }
      })();
      let lastProgress = childStartedAt;
      const stallWindow = (options.stallWindowMs ?? workStallWindowMs)(item.kind);
      const stall = (async () => {
        while (!watch.signal.aborted) {
          await timer.sleep(Math.max(0, lastProgress + stallWindow - clock.now().getTime()), watch.signal);
          if (watch.signal.aborted || terminationCause !== undefined) break;
          if (clock.now().getTime() - lastProgress >= stallWindow) { terminate('stalled'); break; }
        }
      })();
      let lastRenewed = -Infinity;
      let lastProgressPersisted = -Infinity;
      let readingStopped = false;
      let pendingRenewal: ReturnType<WorkStore['renewSupervisedLease']> | undefined;
      const read = (async () => {
        try {
          for await (const chunk of handle.stdout) {
            if (readingStopped) break;
            const progress = run.feed(chunk);
            if (run.violation) { failed = run.violation.reason; terminate('protocol'); break; }
            for (const event of progress) {
              const now = clock.now();
              if (event.type !== 'heartbeat') lastProgress = now.getTime();
              if (event.type === 'result' || event.type === 'error') sawFinal = true;
              const lastWritten = event.type === 'heartbeat' ? lastRenewed : lastProgressPersisted;
              if (now.getTime() - lastWritten >= (options.renewEveryMs ?? SUPERVISOR_RENEW_EVERY_MS)) {
                pendingRenewal = store.renewSupervisedLease({ id: item.id, attemptToken: token, now, progressAt: event.type === 'heartbeat' ? null : now });
                const renewed = await pendingRenewal;
                pendingRenewal = undefined;
                if (!renewed.ok) await problem(`감독자 임대 갱신 실패 (${renewed.code})`);
                else if (renewed.outcome === 'lost') await problem('감독자가 일감의 시도 토큰을 잃었습니다');
                else {
                  lastRenewed = now.getTime();
                  if (event.type !== 'heartbeat') lastProgressPersisted = now.getTime();
                  await problem();
                }
              }
            }
          }
          if (!readingStopped) { run.end(); if (run.violation) { failed = run.violation.reason; terminate('protocol'); } }
        } catch { run.fail('ABI_OUTPUT_UNREADABLE', '자식 프로세스 출력을 읽을 수 없습니다'); failed = '출력 읽기 실패'; terminate('protocol'); }
      })();
      try {
        await Promise.race([exited, stop]);
        // Always confirm the group before terminal settlement. A cancellation can
        // commit after our last read, including when leader exit wins the race.
        const cleaned = await cleanup(identity, { handle });
        if (cleaned === 'unknown') {
          readingStopped = true;
          await pendingRenewal;
          handle.closeOutput();
          await readStderr;
          const input = { id: item.id, attemptToken: token, now: clock.now(), outcome: 'unknown' as const, elapsedMs: Math.max(0, (endedAt ?? clock.now().getTime()) - startedAt), stderr: stderr.value() };
          pendingSettlement = () => store.settleSupervisedAttempt(input);
          await retrySettlement();
          return;
        }
        exit = await exited;
        // Drain buffered ABI lines, but inherited pipes can outlive both the
        // leader and its original group. Closing them releases the iterator.
        const outputWait = new AbortController();
        try { await Promise.race([Promise.all([read, readStderr]), timer.sleep(options.groupConfirmMs ?? SUPERVISOR_GROUP_CONFIRM_MS, outputWait.signal)]); }
        finally { outputWait.abort(); handle.closeOutput(); }
        await Promise.all([read, readStderr]);
      } finally {
        readingStopped = true; handle.closeOutput();
        watch.abort(); await Promise.all([poll, stall]); signal.removeEventListener('abort', abort);
      }
    }
    verdict = run.verdict(exit);
    failed = verdict.outcome === 'failed' ? verdict.code : undefined;
    const detail = { elapsedMs: Math.max(0, (endedAt ?? clock.now().getTime()) - startedAt), stderr: stderr.value() };
    const now = clock.now();
    // A valid result and exit zero win a cancellation race. Shutdown returns unfinished work.
    if (signal.aborted || (stopped && failed !== undefined)) {
      const input = { id: item.id, attemptToken: token, now, outcome: 'cancelled' as const, ...detail };
      pendingSettlement = () => store.settleSupervisedAttempt(input);
    } else {
      const outcome = verdict.outcome === 'succeeded' ? 'succeeded' as const : terminationCause === 'stalled' && !sawFinal ? 'stalled' as const
        : terminationCause === 'exit' && !sawFinal && verdict.code === 'ABI_EXIT_FAILED' && exit.signal !== null ? 'died' as const : 'failed' as const;
      const code = outcome === 'stalled' ? 'PROCESS_STALLED' : outcome === 'died' ? 'PROCESS_DIED' : verdict.code;
      const retryable = outcome === 'stalled' || outcome === 'died' ? true : verdict.retryable;
      const lastError = failureText(`자식 프로세스 실행 실패 (${code}): ${verdict.message ?? '정상 결과를 받지 못했습니다'}`);
      // A supervised attempt already ran. Even spool-cause worker codes follow
      // the ABI retryable flag and spend an attempt; only core drain releases.
      const decision = outcome === 'succeeded' ? { decision: 'complete' as const }
        : retryable === false || item.attempts >= MAX_WORK_ATTEMPTS ? { decision: 'record' as const }
        : { decision: 'retry' as const, at: new Date(now.getTime() + workKindPolicy(item.kind).transientDelayMs) };
      const input = { id: item.id, attemptToken: token, now, outcome, ...detail,
        ...(verdict.usage === null ? {} : { usage: { inputTokens: verdict.usage.input_tokens, cachedInputTokens: verdict.usage.cached_input_tokens, outputTokens: verdict.usage.output_tokens } }),
        ...(outcome === 'succeeded' ? {} : { lastError }),
        ...(outcome === 'failed' ? { errorCode: verdict.code!, errorRetryable: verdict.retryable! } : {}),
        ...(decision.decision === 'retry' ? { nextAttemptAt: decision.at } : {}),
        ...(decision.decision === 'record' ? { failure: { id: idGen.next(), stage: item.kind,
          fingerprint: failureFingerprint({ stage: item.kind, input: `${item.targetKind}:${item.targetId}`, code: code! }),
          code: code!, message: lastError, occurredAt: now } } : {}) };
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
