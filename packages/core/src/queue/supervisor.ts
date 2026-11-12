import { projectProtectedVerdict, validateProtectedSnapshot } from '../extensions/check.js';
import { failureFingerprint, failureText } from '../domain/failure.js';
import { MAX_WORK_ATTEMPTS, SUPERVISOR_CAPACITY, workKindPolicy, workStallWindowMs, SUPERVISOR_POLL_MS, SUPERVISOR_RENEW_EVERY_MS, SUPERVISOR_CANCEL_GRACE_MS, SUPERVISOR_CANCEL_POLL_MS, SUPERVISOR_GROUP_CONFIRM_MS, workExecutionClass, type WorkItem } from '../domain/work-item.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ProcessInspector, ProcessLauncher, ProcessSpec } from '../ports/process.js';
import type { FinishSupervisedWorkInput, FinishWorkResult, OpenSupervisedAttempt, SchemaStore, WorkStore } from '../ports/store.js';
import type { ChannelStore } from '../channels/store.js';
import { createAbiRun, createAbiStderr, decodeAbiEnv, isAbiUserId, type AbiRunVerdict } from '../process-abi/codec.js';
import { checkSchema, type SchemaVersions } from '../schema.js';
import { cleanProcessGroup, inspectGroup, type GroupIdentity } from './process-cleanup.js';
// Persist only narrowly defined, non-health public Garmin result summaries.
export function publicCollectSummary(kind: string, summary: string | undefined): Record<string, string | number> | undefined {
  if (!summary || summary.length > 2048) return undefined;
  let value: unknown;
  try { value = JSON.parse(summary); } catch { return undefined; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  // General-purpose, fixed-shape result: no arbitrary strings or user data.
  if (Object.keys(v).sort().join(',') === 'errors,runs,status' &&
      typeof v['status'] === 'string' && ['success','partial','blocked','auth_required','error','noop'].includes(v['status']) &&
      ['runs','errors'].every(k => typeof v[k] === 'number' && Number.isSafeInteger(v[k]) && (v[k] as number) >= 0))
    return {status:v['status'],runs:v['runs'] as number,errors:v['errors'] as number};
  // 수집 실행 성공과 남은 backlog는 독립된 공개 집계다. 이 고정 계약만 보존한다.
  const backlogCounts = ['remaining_endpoints','remaining_activities','remaining_dates','unplannable',
    'deferred_dates','deferred_endpoints','deferred_first_call'];
  const backlogKeys = ['status','runs','errors','execution_status','backlog_status',...backlogCounts];
  if (['garmin.collect','garmin.collect_retry','garmin.collect_recent'].includes(kind) &&
      Object.keys(v).sort().join(',') === [...backlogKeys].sort().join(',') &&
      typeof v['status'] === 'string' && ['success','partial','blocked','auth_required','error','noop'].includes(v['status']) &&
      v['execution_status'] === v['status'] && typeof v['backlog_status'] === 'string' && ['partial','complete'].includes(v['backlog_status']) &&
      ['runs','errors',...backlogCounts].every(key => Number.isSafeInteger(v[key]) && (v[key] as number) >= 0))
    return v as Record<string, string | number>;
  if (!['garmin.collect', 'garmin.collect_retry', 'garmin.collect_recent', 'garmin.artifacts'].includes(kind)) return undefined;
  if (kind === 'garmin.artifacts') {
    const keys = Object.keys(v).sort().join(',');
    if (!['request_id,revision,status','graphs_failed,graphs_failed_names,graphs_registered,graphs_skipped,request_id,revision,status'].includes(keys) || v['status'] !== 'success' ||
        typeof v['request_id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v['request_id']) ||
        typeof v['revision'] !== 'string' || !/^[0-9a-f]{64}$/.test(v['revision'])) return undefined;
    const result: Record<string, string | number> = {status:v['status'],request_id:v['request_id'],revision:v['revision']};
    if ('graphs_failed' in v) {
      const registered = v['graphs_registered'], skipped = v['graphs_skipped'], failed = v['graphs_failed'], names = v['graphs_failed_names'];
      if (typeof registered !== 'number' || !Number.isSafeInteger(registered) || registered < 0 || registered > 60 ||
          typeof skipped !== 'number' || !Number.isSafeInteger(skipped) || skipped < 0 || skipped > 60 ||
          typeof failed !== 'number' || !Number.isSafeInteger(failed) || failed < 0 || failed > 60 ||
          typeof names !== 'string' || names.length > 1200 || registered + skipped + failed > 60) return undefined;
      const list = names === '' ? [] : names.split(',');
      if (list.length !== failed || new Set(list).size !== list.length || !list.every(n => /^[0-9]{2}-[a-z0-9-]+\.png$/.test(n))) return undefined;
      Object.assign(result, {graphs_registered:registered,graphs_skipped:skipped,graphs_failed:failed,graphs_failed_names:names});
    }
    return result;
  }
  if (Object.keys(v).sort().join(',') !== 'cutoff_ms,local_date,normalize_failed,normalized,snapshot_id,status,timezone' ||
      !['success', 'noop'].includes(String(v['status'])) || typeof v['local_date'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v['local_date']) ||
      !['cutoff_ms', 'normalized', 'normalize_failed'].every(k => Number.isSafeInteger(v[k]) && (v[k] as number) >= 0) ||
      typeof v['snapshot_id'] !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v['snapshot_id']) ||
      typeof v['timezone'] !== 'string' || v['timezone'].length < 1 || v['timezone'].length > 80 || !/^[A-Za-z0-9_+\-/]+$/.test(v['timezone'])) return undefined;
  return v as Record<string, string | number>;
}

export interface SupervisorOptions {
  store: WorkStore & SchemaStore & Partial<Pick<ChannelStore, 'recoverChannelAttempt'>>; launcher: ProcessLauncher; inspector: ProcessInspector;
  clock: Clock; timer: Timer; idGen: IdGen;
  launches: Readonly<Record<string, (item: WorkItem, token: string) => ProcessSpec | null>>;
  protectedLaunches?: Readonly<Record<string, {
    extension: string; declarations: Readonly<Record<string, 'string' | 'number' | 'boolean'>>; errorCodes: readonly string[]; required?: readonly string[]; secrets?: readonly string[];
    prepare(item: WorkItem, token: string, userId?: string): Promise<{ ok: true; spec: ProcessSpec } | { ok: false; code: 'USER_MISSING' | 'EXTENSION_CONFIG_INVALID' | 'DB_UNAVAILABLE' | 'DB_LOCKED' }>;
  }>>;
  loadProtectedLaunches?: () => Promise<NonNullable<SupervisorOptions['protectedLaunches']>>;
  onReadiness?: (ready: boolean) => void | Promise<void>;
  prepareLaunch?: () => Promise<{ ok: true; userId?: string } | { ok: false; code: 'USER_MISSING' | 'DB_UNAVAILABLE' | 'DB_LOCKED' }>;
  signal: AbortSignal; log?: (message: string) => void | Promise<void>; schemaVersions: SchemaVersions;
  stallWindowMs?: (kind: string) => number;
  pollMs?: number; renewEveryMs?: number; cancelGraceMs?: number; cancelPollMs?: number; groupConfirmMs?: number;
}
/** Every database transaction completes before waiting on a child or signal grace. */
export async function runSupervisor(options: SupervisorOptions): Promise<void> {
  const { store, launcher, inspector, clock, timer, idGen, launches, signal } = options;
  let protectedLaunches = options.protectedLaunches ?? {};
  let kinds: string[] = [];
  const claimedBy = idGen.next();
  let reconciled = false;
  type Execution = { finished?: boolean; pendingSettlement?: () => Promise<FinishWorkResult>; retrying?: Promise<void> };
  const executions = new Set<Execution>();
  const running = new Set<Promise<void>>();
  const uncertainChannelTokens = new Set<string>();
  let lastProblem: string | undefined;
  async function problem(message?: string): Promise<void> {
    try { if (message !== undefined && message !== lastProblem) await options.log?.(message); } catch { /* Logging must never interrupt supervision. */ }
    lastProblem = message;
  }
  async function retrySettlement(execution: Execution): Promise<void> {
    if (execution.retrying) return execution.retrying;
    if (!execution.pendingSettlement) return;
    const settle = execution.pendingSettlement;
    execution.retrying = (async () => {
      const finished = await settle();
      if (!finished.ok) await problem(`감독자 결과 확정 실패 (${finished.code})`);
      else {
        delete execution.pendingSettlement;
        if (execution.finished) executions.delete(execution);
        if (finished.outcome === 'lost') await problem('감독자가 결과를 확정하기 전에 시도 토큰을 잃었습니다');
        else await problem();
      }
    })();
    try { await execution.retrying; } finally { delete execution.retrying; }
  }
  async function retrySettlements(): Promise<void> {
    await Promise.all([...executions].map(async execution => {
      try { await retrySettlement(execution); }
      catch { await problem('감독자 결과 확정 중 오류가 발생했습니다'); }
    }));
  }
  const cleanup = (identity: GroupIdentity, extra: { handle?: import('../ports/process.js').ProcessHandle } = {}) => cleanProcessGroup({
    inspector, identity, clock, timer, graceMs: options.cancelGraceMs ?? SUPERVISOR_CANCEL_GRACE_MS,
    confirmMs: options.groupConfirmMs ?? SUPERVISOR_GROUP_CONFIRM_MS, ...extra,
  });
  function channelSettlement(item: { id: string; targetId: string; targetKind: string; attempts: number; deferred?: boolean; deferredOutcome?: 'cancelled' | 'died' }, input: FinishSupervisedWorkInput): () => Promise<FinishWorkResult> {
    return async () => {
      if (!store.recoverChannelAttempt) return { ok: false, code: 'DB_UNAVAILABLE', message: '채널 시도 결과를 읽을 수 없습니다' };
      const recovered = await store.recoverChannelAttempt({ requestId: item.targetId, workItemId: item.id, attemptToken: input.attemptToken, now: input.now });
      if (!recovered.ok) return recovered;
      if (recovered.outcome === 'lost') return { ok: true, outcome: 'lost' };
      const result = recovered.result;
      const confirmedDead = input.outcome === 'died';
      if (item.deferred && result?.outcome !== 'sent') {
        const open = await store.listOpenSupervisedAttempts();
        if (!open.ok) return open;
        const current = open.attempts.find(attempt => attempt.token === input.attemptToken);
        if (!current) return { ok: true, outcome: 'lost' };
        if (current.cancelRequested || result === null) return store.settleSupervisedAttempt({ id: item.id, attemptToken: input.attemptToken, now: input.now, outcome: current.cancelRequested ? 'cancelled' : item.deferredOutcome ?? 'died', confirmedDead });
      }
      if (result === null) return store.finishSupervisedWork({ ...input, confirmedDead });
      if (result.outcome === 'sent') return store.finishSupervisedWork({ id: item.id, attemptToken: input.attemptToken, now: input.now, outcome: 'succeeded', confirmedDead, elapsedMs: input.elapsedMs, stderr: input.stderr });
      const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(result.code) ? result.code : `CHANNEL_${result.code.toUpperCase()}`;
      const lastError = failureText(`채널 전송 실패 (${code})`);
      const terminal = !result.retryable || item.attempts >= MAX_WORK_ATTEMPTS;
      const nextAttemptAt = new Date(input.now.getTime() + Math.max(workKindPolicy('channel_send').retryDelayMs(item.attempts), result.retryAfterMs ?? 0));
      return store.finishSupervisedWork({ id: item.id, attemptToken: input.attemptToken, now: input.now,
        outcome: input.outcome === 'died' ? 'died' : 'failed', confirmedDead, elapsedMs: input.elapsedMs, stderr: input.stderr, lastError,
        ...(input.outcome === 'died' ? {} : { errorCode: code, errorRetryable: result.retryable }),
        ...(terminal ? { failure: { id: idGen.next(), stage: 'channel_send', fingerprint: failureFingerprint({ stage: 'channel_send', input: `${item.targetKind}:${item.targetId}`, code }), code, message: lastError, occurredAt: input.now } } : { nextAttemptAt }) });
    };
  }
  function lostSettlement(attempt: Pick<OpenSupervisedAttempt, 'workItemId' | 'token' | 'kind' | 'attempts' | 'targetKind' | 'targetId' | 'cancelRequested' | 'held'>,
    outcome: 'died' | 'unknown', detail: { elapsedMs?: number; stderr?: string | null } = {}): () => Promise<FinishWorkResult> {
    const now = clock.now();
    if (outcome === 'died' && attempt.kind === 'channel_send') {
      const code = 'PROCESS_DIED';
      const lastError = failureText(`자식 프로세스 실행 실패 (${code}): 정상 결과를 받지 못했습니다`);
      return channelSettlement({ id: attempt.workItemId, targetId: attempt.targetId, targetKind: attempt.targetKind, attempts: attempt.attempts, deferred: attempt.cancelRequested || attempt.held },
        { id: attempt.workItemId, attemptToken: attempt.token, now, outcome, ...detail, lastError,
          ...(attempt.attempts >= MAX_WORK_ATTEMPTS ? { failure: { id: idGen.next(), stage: attempt.kind,
            fingerprint: failureFingerprint({ stage: attempt.kind, input: `${attempt.targetKind}:${attempt.targetId}`, code }), code, message: lastError, occurredAt: now } }
            : { nextAttemptAt: new Date(now.getTime() + workKindPolicy(attempt.kind).retryDelayMs(attempt.attempts)) }) });
    }
    if (outcome === 'died' && attempt.attempts >= MAX_WORK_ATTEMPTS && !attempt.cancelRequested && !attempt.held) {
      const code = 'PROCESS_DIED';
      const lastError = failureText(`자식 프로세스 실행 실패 (${code}): 정상 결과를 받지 못했습니다`);
      const input = { id: attempt.workItemId, attemptToken: attempt.token, now, outcome, ...detail, lastError,
        failure: { id: idGen.next(), stage: attempt.kind,
          fingerprint: failureFingerprint({ stage: attempt.kind, input: `${attempt.targetKind}:${attempt.targetId}`, code }),
          code, message: lastError, occurredAt: now } };
      return () => store.finishSupervisedWork(input);
    }
    const input = { id: attempt.workItemId, attemptToken: attempt.token, now, outcome, ...detail };
    return () => store.settleSupervisedAttempt(input);
  }
  async function reconcile(): Promise<boolean> {
    const open = await store.listOpenSupervisedAttempts();
    if (!open.ok) { await problem(`감독자 이전 시도 조회 실패 (${open.code})`); return false; }
    for (const attempt of open.attempts) {
      if (attempt.incarnation === claimedBy) continue;
      const state = await inspectGroup(inspector, attempt);
      const outcome = state === 'ours' ? await cleanup(attempt) : state;
      const refreshed = await store.listOpenSupervisedAttempts();
      if (!refreshed.ok) { await problem(`감독자 이전 시도 조회 실패 (${refreshed.code})`); return false; }
      const current = refreshed.attempts.find(a => a.token === attempt.token);
      if (!current) continue;
      const settled = await lostSettlement(current, outcome)();
      if (!settled.ok) { await problem(`감독자 이전 시도 정산 실패 (${settled.code})`); return false; }
      // 채널 프로세스가 불확실하면 토큰을 보유한 채 다음 검사에서 다시 확인한다.
      if (outcome === 'unknown' && current.kind === 'channel_send') return false;
    }
    return true;
  }
  async function recheckUncertainChannels(): Promise<void> {
    if (!uncertainChannelTokens.size) return;
    const open = await store.listOpenSupervisedAttempts();
    if (!open.ok) { await problem(`감독자 이전 시도 조회 실패 (${open.code})`); return; }
    for (const token of uncertainChannelTokens) {
      const attempt = open.attempts.find(row => row.token === token);
      if (!attempt) { uncertainChannelTokens.delete(token); continue; }
      if (await inspectGroup(inspector, attempt) !== 'died') continue;
      const result = await lostSettlement(attempt, 'died')();
      if (!result.ok) { await problem(`감독자 이전 시도 정산 실패 (${result.code})`); continue; }
      uncertainChannelTokens.delete(token);
    }
  }
  async function execute(item: WorkItem, token: string, execution: Execution): Promise<void> {
    let failed: string | undefined;
    const protection = protectedLaunches[item.kind];
    let preparationFailure: { code: string; retryable: boolean } | undefined;
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
      let spec: ProcessSpec | null = null;
      const preflight = await options.prepareLaunch?.();
      if (preflight && !preflight.ok) preparationFailure = { code: preflight.code, retryable: preflight.code !== 'USER_MISSING' };
      else if (protection) {
        const prepared = await protection.prepare(item, token, preflight?.ok ? preflight.userId : undefined);
        if (!prepared.ok) preparationFailure = { code: prepared.code, retryable: prepared.code !== 'EXTENSION_CONFIG_INVALID' && prepared.code !== 'USER_MISSING' };
        else spec = prepared.spec;
      } else spec = launches[item.kind]?.(item, token) ?? null;
      if (spec && preflight?.ok && preflight.userId !== undefined) spec = { ...spec, env: { ...spec.env, BRAIN_USER_ID: preflight.userId } };
      if (spec && protection && (!Object.hasOwn(spec.env, 'BRAIN_SETTINGS_SNAPSHOT') || !decodeAbiEnv(spec.env).ok || !validateProtectedSnapshot(spec.env['BRAIN_SETTINGS_SNAPSHOT'], protection))) {
        preparationFailure = { code: 'EXTENSION_CONFIG_INVALID', retryable: false }; spec = null;
      } else if (spec && !protection && preflight?.ok && preflight.userId !== undefined && !isAbiUserId(spec.env['BRAIN_USER_ID'])) {
        preparationFailure = { code: 'ABI_ENV_INVALID', retryable: false }; spec = null;
      }
      if (spec !== null && !signal.aborted) {
        const open = await store.listOpenSupervisedAttempts();
        if (!open.ok) { preparationFailure = { code: open.code, retryable: true }; spec = null; }
        else {
          const attempt = open.attempts.find(a => a.token === token && a.workItemId === item.id);
          if (!attempt || attempt.cancelRequested || attempt.held) { stopped = true; preparationFailure = undefined; spec = null; }
        }
      }
      if (signal.aborted) { stopped = true; preparationFailure = undefined; spec = null; }
      started = spec === null ? { ok: false, message: '일감 실행 명세가 없습니다' } : await launcher.start(spec);
    } catch { if (protection) preparationFailure = { code: 'EXTENSION_CONFIG_INVALID', retryable: false }; started = { ok: false, message: '자식 프로세스를 시작할 수 없습니다' }; }
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
        try { for await (const chunk of handle.stderr) { if (!protection) stderr.feed(chunk); } }
        catch { run.fail('ABI_OUTPUT_UNREADABLE', '자식 프로세스 출력을 읽을 수 없습니다'); failed = '출력 읽기 실패'; terminate('protocol'); }
      })();
      let identity: GroupIdentity = { pgid: handle.pid, osBootAt: null, osStartedAt: null };
      let stopWatching = async (): Promise<void> => {};
      let stopReading = async (): Promise<void> => { handle.closeOutput(); await readStderr; };
      let supervisionFailed = false;
      const supervisionFailure = (): void => { supervisionFailed = true; terminate('protocol'); };
      try {
        const [boot, start] = await Promise.all([inspector.bootTime(), inspector.startedAt(handle.pid)]);
        identity = { pgid: handle.pid, osBootAt: boot.state === 'found' ? boot.value : null,
          osStartedAt: start.state === 'found' ? start.value : null };
        if (identity.osBootAt === null || identity.osStartedAt === null) await problem('감독자가 자식의 OS 시작 신원을 확인하지 못했습니다');
        const recorded = await store.recordSupervisedProcess({ id: item.id, attemptToken: token, pid: handle.pid, pgid: handle.pid,
          osBootAt: identity.osBootAt, osStartedAt: identity.osStartedAt });
        if (!recorded.ok) await problem(`감독자 프로세스 기록 실패 (${recorded.code})`);
        const watch = new AbortController();
        const watchers: Promise<void>[] = [];
        const abort = (): void => { stopped = true; terminate('cancelled'); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        stopWatching = async () => {
          watch.abort(); signal.removeEventListener('abort', abort);
          await Promise.all(watchers);
        };
        const poll = (async () => {
          while (!watch.signal.aborted) {
            await timer.sleep(options.cancelPollMs ?? SUPERVISOR_CANCEL_POLL_MS, watch.signal);
            if (watch.signal.aborted) break;
            const open = await store.listOpenSupervisedAttempts();
            if (!open.ok) { await problem(`감독자 취소 요청 조회 실패 (${open.code})`); continue; }
            const current = open.attempts.find(a => a.token === token);
            if (!current || current.cancelRequested || current.held) { stopped = true; terminate('cancelled'); break; }
          }
        })();
        watchers.push(poll.catch(supervisionFailure));
        let lastProgress = childStartedAt;
        const stallWindow = (options.stallWindowMs ?? workStallWindowMs)(item.kind);
        const stall = (async () => {
          while (!watch.signal.aborted) {
            await timer.sleep(Math.max(0, lastProgress + stallWindow - clock.now().getTime()), watch.signal);
            if (watch.signal.aborted || terminationCause !== undefined) break;
            if (clock.now().getTime() - lastProgress >= stallWindow) { terminate('stalled'); break; }
          }
        })();
        watchers.push(stall.catch(supervisionFailure));
        let lastRenewed = -Infinity;
        let lastProgressPersisted = -Infinity;
        let readingStopped = false;
        let renewing = false;
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
                  renewing = true;
                  pendingRenewal = store.renewSupervisedLease({ id: item.id, attemptToken: token, now, progressAt: event.type === 'heartbeat' ? null : now });
                  const renewed = await pendingRenewal;
                  pendingRenewal = undefined;
                  renewing = false;
                  if (!renewed.ok) await problem(`감독자 임대 갱신 실패 (${renewed.code})`);
                  else if (renewed.outcome === 'lost') { await problem('감독자가 일감의 시도 토큰을 잃었습니다'); stopped = true; terminate('cancelled'); }
                  else {
                    lastRenewed = now.getTime();
                    if (event.type !== 'heartbeat') lastProgressPersisted = now.getTime();
                    await problem();
                  }
                }
              }
            }
            if (!readingStopped) { run.end(); if (run.violation) { failed = run.violation.reason; terminate('protocol'); } }
          } catch {
            if (renewing) supervisionFailure();
            else { run.fail('ABI_OUTPUT_UNREADABLE', '자식 프로세스 출력을 읽을 수 없습니다'); failed = '출력 읽기 실패'; terminate('protocol'); }
          }
        })();
        stopReading = async () => { readingStopped = true; handle.closeOutput(); await Promise.allSettled([read, readStderr]); };
        try {
          await Promise.race([exited, stop]);
          if (supervisionFailed) throw new Error('supervision failed');
          // Always confirm the group before terminal settlement. A cancellation can
          // commit after our last read, including when leader exit wins the race.
          const cleaned = await cleanup(identity, { handle });
          if (cleaned === 'unknown') {
            readingStopped = true;
            await pendingRenewal;
            handle.closeOutput();
            await readStderr;
            const input = { id: item.id, attemptToken: token, now: clock.now(), outcome: 'unknown' as const, elapsedMs: Math.max(0, (endedAt ?? clock.now().getTime()) - startedAt), stderr: stderr.value() };
            execution.pendingSettlement = async () => {
              const result = await store.settleSupervisedAttempt(input);
              if (item.kind === 'channel_send' && result.ok && result.outcome === 'done') uncertainChannelTokens.add(token);
              return result;
            };
            await retrySettlement(execution);
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
          await stopWatching();
          if (supervisionFailed) throw new Error('supervision failed');
        }
      } catch {
        let recovery: Promise<{ outcome: 'died' | 'unknown'; detail: { elapsedMs: number; stderr: string | null } }> | undefined;
        // Block claims before the first recovery await. Every retry shares the
        // same cleanup, including an in-flight TERM grace period.
        execution.pendingSettlement = async () => {
          recovery ??= (async () => {
            await problem('감독자 실행 중 오류가 발생했습니다');
            await stopWatching();
            let outcome: 'died' | 'unknown' = 'unknown';
            try { outcome = await cleanup(identity, { handle }); } catch { /* Unconfirmed cleanup retains the token. */ }
            await stopReading();
            return { outcome, detail: { elapsedMs: Math.max(0, (endedAt ?? clock.now().getTime()) - startedAt), stderr: stderr.value() } };
          })();
          const { outcome, detail } = await recovery;
          const open = await store.listOpenSupervisedAttempts();
          if (!open.ok) return open;
          const attempt = open.attempts.find(a => a.token === token);
          const settled = await lostSettlement(attempt ?? {
            workItemId: item.id, token, kind: item.kind, attempts: item.attempts,
            targetKind: item.targetKind, targetId: item.targetId, cancelRequested: false, held: false,
          }, outcome, detail)();
          if (item.kind === 'channel_send' && outcome === 'unknown' && settled.ok && settled.outcome === 'done') uncertainChannelTokens.add(token);
          return settled;
        };
        await retrySettlement(execution);
        return;
      }
    }
    verdict = run.verdict(exit);
    if (preparationFailure) verdict = { outcome: 'failed', ...preparationFailure, usage: null, message: preparationFailure.code === 'USER_MISSING' ? 'setup을 실행해 사용자를 확인하세요' : ['DB_LOCKED', 'DB_UNAVAILABLE'].includes(preparationFailure.code) ? '데이터베이스 상태를 확인하세요' : '확장 설정을 확인하세요' };
    else if (protection && verdict.outcome === 'failed') {
      verdict = projectProtectedVerdict(verdict, protection.errorCodes, run.workerError);
    }
    failed = verdict.outcome === 'failed' ? verdict.code : undefined;
    const detail = { elapsedMs: Math.max(0, (endedAt ?? clock.now().getTime()) - startedAt), stderr: stderr.value() };
    const now = clock.now();
    // A valid result and exit zero win a cancellation race. Shutdown returns unfinished work.
    if (signal.aborted || (stopped && failed !== undefined)) {
      const input = { id: item.id, attemptToken: token, now, outcome: 'cancelled' as const, ...detail };
      execution.pendingSettlement = item.kind === 'channel_send'
        ? channelSettlement({ ...item, deferred: true, deferredOutcome: 'cancelled' }, { ...input, outcome: 'died' })
        : () => store.settleSupervisedAttempt(input);
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
      const summary = outcome === 'succeeded' ? publicCollectSummary(item.kind, run.resultSummary) : undefined;
      const input = { id: item.id, attemptToken: token, now, outcome, ...detail,
        ...(summary === undefined ? {} : { resultSummary: summary }),
        ...(verdict.usage === null ? {} : { usage: { inputTokens: verdict.usage.input_tokens, cachedInputTokens: verdict.usage.cached_input_tokens, outputTokens: verdict.usage.output_tokens } }),
        ...(outcome === 'succeeded' ? {} : { lastError }),
        ...(outcome === 'failed' ? { errorCode: verdict.code!, errorRetryable: verdict.retryable! } : {}),
        ...(decision.decision === 'retry' ? { nextAttemptAt: decision.at } : {}),
        ...(decision.decision === 'record' ? { failure: { id: idGen.next(), stage: item.kind,
          fingerprint: failureFingerprint({ stage: item.kind, input: `${item.targetKind}:${item.targetId}`, code: code! }),
          code: code!, message: lastError, occurredAt: now } } : {}) };
      execution.pendingSettlement = item.kind === 'channel_send' ? channelSettlement(item, input) : () => store.finishSupervisedWork(input);
    }
    await retrySettlement(execution);
  }
  async function waitForWork(signal: AbortSignal): Promise<void> {
    const wait = new AbortController();
    const abort = () => wait.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) wait.abort();
    try { await Promise.race([timer.sleep(options.pollMs ?? SUPERVISOR_POLL_MS, wait.signal), ...running]); }
    finally { wait.abort(); signal.removeEventListener('abort', abort); }
  }
  while (!signal.aborted) {
    try {
      let ready = true;
      const schema = await checkSchema(store, options.schemaVersions);
      if (!schema.ok) { ready = false; await problem(`감독자 데이터베이스 확인 실패 (${schema.code})`); }
      else {
        await retrySettlements();
        await recheckUncertainChannels();
        if (options.loadProtectedLaunches) protectedLaunches = await options.loadProtectedLaunches();
        kinds = [...new Set([...Object.keys(launches).filter(kind => workExecutionClass(kind) === 'supervised'), ...Object.keys(protectedLaunches)])];
        if (!reconciled) reconciled = await reconcile();
        if (!reconciled) ready = false;
        while (reconciled && !signal.aborted && running.size < SUPERVISOR_CAPACITY &&
          ![...executions].some(execution => execution.pendingSettlement !== undefined)) {
          const token = idGen.next();
          const claimed = await store.claimSupervisedWork({ now: clock.now(), claimedBy, kinds, attemptToken: token });
          if (!claimed.ok) { ready = false; await problem(`감독자 청구 실패 (${claimed.code})`); break; }
          await problem();
          if (claimed.item === null) break;
          const execution: Execution = {};
          executions.add(execution);
          const task = execute(claimed.item, token, execution)
            .catch(async () => { await problem('감독자 실행 중 오류가 발생했습니다'); })
            .finally(() => { running.delete(task); execution.finished = true; if (!execution.pendingSettlement) executions.delete(execution); });
          running.add(task);
        }
      }
      await options.onReadiness?.(ready && !signal.aborted && lastProblem === undefined && ![...executions].some(execution => execution.pendingSettlement !== undefined));
    } catch { await options.onReadiness?.(false); await problem('감독자 실행 중 오류가 발생했습니다'); }
    if (!signal.aborted) await waitForWork(signal);
  }
  await options.onReadiness?.(false);
  // Every child observes abort independently; wait for all group cleanup before returning.
  await Promise.all([...running]);
  // Retain failed tokens for the next incarnation's reconcile; shutdown must finish.
  await retrySettlements();
}
