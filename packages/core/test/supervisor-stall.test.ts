import { expect, it } from 'vitest';
import { runSupervisor, type SupervisorOptions } from '../src/queue/supervisor.js';
import { SUPERVISOR_STALL_WINDOW_MS, workStallWindowMs } from '../src/domain/work-item.js';
import { manualTime } from '../src/testing/fakes/clock.js';
import { fakeProcessLauncher, fakeProcessInspector } from '../src/testing/fakes/process.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
const now = new Date('2026-10-29T00:00:00Z');
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
async function kit(options: { attempts?: number; stallWindowMs?: SupervisorOptions['stallWindowMs']; configure?: (store: ReturnType<typeof memoryStore>) => void } = {}) {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const controller = new AbortController(), idGen = sequenceIdGen({ timestampMs: now.getTime() }), id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  for (let i = 1; i < (options.attempts ?? 1); i++) {
    const attemptToken = idGen.next();
    await store.claimSupervisedWork({ now, claimedBy: idGen.next(), kinds: ['process_probe'], attemptToken });
    await store.finishSupervisedWork({ id, attemptToken, now, outcome: 'failed', nextAttemptAt: now });
  }
  options.configure?.(store);
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher, inspector, idGen, signal: controller.signal,
    ...(options.stallWindowMs === undefined ? {} : { stallWindowMs: options.stallWindowMs }),
    launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) } });
  await flush();
  return { store, time, launcher, inspector, id, controller, running, child: launcher.processes[0]!, stop: async () => { controller.abort(); await running; } };
}
it('heartbeat only stalls after 15 minutes and is claimed again', async () => {
  const k = await kit();
  try {
    for (let minute = 0; minute < 15; minute++) {
      k.child.push('{"abi":1,"type":"heartbeat"}'); await flush();
      expect(k.store.snapshot().workAttempts[0]!.lastProgressAt).toBeNull();
      k.time.advance(60_000); await flush();
    }
    expect(k.child.signals).toEqual(['SIGTERM']);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'stalled', errorCode: null, errorRetryable: null });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: null, nextAttemptAt: new Date(now.getTime() + 1_800_000), lastError: expect.stringContaining('PROCESS_STALLED') });
    k.time.advance(900_000); await flush();
    expect(k.store.snapshot().workAttempts).toHaveLength(2);
    expect(k.launcher.processes).toHaveLength(2);
  } finally { await k.stop(); }
});
it('progress every minute is not stalled', async () => {
  const k = await kit();
  try {
    for (let minute = 0; minute < 30; minute++) { k.child.push('{"abi":1,"type":"progress"}'); await flush(); k.time.advance(60_000); await flush(); }
    expect(k.child.signals).toEqual([]);
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBeNull();
  } finally { await k.stop(); }
});
it('model window is 25 minutes', async () => {
  expect(workStallWindowMs('process_probe')).toBe(SUPERVISOR_STALL_WINDOW_MS.default);
  const k = await kit({ stallWindowMs: () => SUPERVISOR_STALL_WINDOW_MS.model });
  try {
    k.child.push('{"abi":1,"type":"heartbeat"}'); await flush();
    k.time.advance(900_000); await flush(); expect(k.child.ended).toBe(false);
    k.time.advance(599_999); await flush(); expect(k.child.ended).toBe(false);
    k.time.advance(1); await flush(); expect(k.store.snapshot().workAttempts[0]!.outcome).toBe('stalled');
  } finally { await k.stop(); }
});
it('signal death without a final event is died', async () => {
  const k = await kit();
  try {
    k.child.push('{"abi":1,"type":"progress"}'); await flush(); k.child.exit(null, 'SIGKILL'); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'died', errorCode: null });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: null, nextAttemptAt: new Date(now.getTime() + 900_000), lastError: expect.stringContaining('PROCESS_DIED') });
  } finally { await k.stop(); }
});
it('nonzero exit without a final event stays failed', async () => {
  const k = await kit();
  try { k.child.exit(2); await flush(); expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'ABI_EXIT_FAILED', errorRetryable: true }); }
  finally { await k.stop(); }
});
it('tenth signal death is recorded as PROCESS_DIED and is not claimed again', async () => {
  const k = await kit({ attempts: 10 });
  try {
    k.child.exit(null, 'SIGKILL'); await flush();
    expect(k.store.snapshot().workAttempts[9]).toMatchObject({ outcome: 'died', errorCode: null, errorRetryable: null });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ attempts: 10, outcome: 'failed', completedAt: now });
    expect(k.store.snapshot().failures).toMatchObject([{ stage: 'process_probe', code: 'PROCESS_DIED' }]);
    k.time.advance(1_800_000); await flush();
    expect(k.store.snapshot().workAttempts).toHaveLength(10);
    expect(k.launcher.processes).toHaveLength(1);
    expect(k.store.snapshot().failures).toHaveLength(1);
  } finally { await k.stop(); }
});
it.each(['result', 'error'] as const)('late final %s extends the stall deadline and keeps its verdict', async type => {
  const k = await kit();
  try {
    k.time.advance(840_000); await flush();
    k.child.push(JSON.stringify(type === 'result' ? { abi: 1, type } : { abi: 1, type, code: 'GARMIN_AUTH', retryable: false })); await flush();
    expect(k.store.snapshot().workAttempts[0]!.lastProgressAt).toEqual(k.time.clock.now());
    k.time.advance(60_000); await flush();
    expect(k.child.signals).toEqual([]);
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBeNull();
    k.time.advance(60_000); await flush(); k.child.exit(0); await flush();
    expect(k.child.signals).toEqual([]);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject(type === 'result'
      ? { outcome: 'succeeded', errorCode: null, errorRetryable: null }
      : { outcome: 'failed', errorCode: 'GARMIN_AUTH', errorRetryable: false });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: type === 'result' ? 'succeeded' : 'failed', completedAt: k.time.clock.now() });
    if (type === 'error') expect(k.store.snapshot().failures).toMatchObject([{ code: 'GARMIN_AUTH' }]);
    else expect(k.store.snapshot().failures).toEqual([]);
  } finally { await k.stop(); }
});
it('permanent worker error is recorded and closed failed', async () => {
  const k = await kit();
  try {
    k.child.push('{"abi":1,"type":"error","code":"GARMIN_AUTH","retryable":false}'); k.child.exit(2); await flush();
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'failed', completedAt: now });
    expect(k.store.snapshot().failures).toMatchObject([{ stage: 'process_probe', code: 'GARMIN_AUTH', harness: null, sessionId: null }]);
  } finally { await k.stop(); }
});
it('final error then hang keeps the worker classification', async () => {
  const k = await kit();
  try {
    k.child.push('{"abi":1,"type":"error","code":"GARMIN_AUTH","retryable":false}'); await flush();
    k.time.advance(900_000); await flush();
    expect(k.child.signals).toEqual(['SIGTERM']);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'GARMIN_AUTH', errorRetryable: false });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ attempts: 1, completedAt: k.time.clock.now(), outcome: 'failed' });
    expect(k.store.snapshot().failures).toMatchObject([{ stage: 'process_probe', code: 'GARMIN_AUTH' }]);
  } finally { await k.stop(); }
});
it('final result then hang keeps the ABI exit classification', async () => {
  const k = await kit();
  try {
    k.child.push('{"abi":1,"type":"result"}'); await flush();
    k.time.advance(900_000); await flush();
    expect(k.child.signals).toEqual(['SIGTERM']);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'ABI_EXIT_AFTER_RESULT', errorRetryable: false });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: k.time.clock.now(), outcome: 'failed' });
    expect(k.store.snapshot().failures).toMatchObject([{ code: 'ABI_EXIT_AFTER_RESULT' }]);
  } finally { await k.stop(); }
});
it('tenth retryable failure is recorded', async () => {
  const k = await kit({ attempts: 10 });
  try {
    k.child.push('{"abi":1,"type":"error","code":"TEMPORARY","retryable":true}'); k.child.exit(1); await flush();
    expect(k.store.snapshot().workItems[0]).toMatchObject({ attempts: 10, outcome: 'failed', completedAt: now });
    expect(k.store.snapshot().failures).toMatchObject([{ code: 'TEMPORARY' }]);
  } finally { await k.stop(); }
});
it.each(['DB_UNAVAILABLE', 'DB_LOCKED', 'SCHEMA_MISMATCH'])('worker %s with retryable true is retried, not released', async code => {
  const k = await kit();
  try {
    k.child.push(JSON.stringify({ abi: 1, type: 'error', code, retryable: true })); k.child.exit(1); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: code, errorRetryable: true });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ attempts: 1, completedAt: null, outcome: null,
      nextAttemptAt: new Date(now.getTime() + 900_000), lastError: expect.stringContaining(code) });
    expect(k.store.snapshot().failures).toEqual([]);
    k.time.advance(5000); await flush();
    expect(k.store.snapshot().workAttempts).toHaveLength(1);
    k.time.advance(895_000); await flush();
    expect(k.store.snapshot().workItems[0]!.attempts).toBe(2);
    expect(k.store.snapshot().workAttempts).toHaveLength(2);
  } finally { await k.stop(); }
});
it.each(['DB_UNAVAILABLE', 'DB_LOCKED', 'SCHEMA_MISMATCH'])('worker %s with retryable false is recorded and closed failed', async code => {
  const k = await kit();
  try {
    k.child.push(JSON.stringify({ abi: 1, type: 'error', code, retryable: false })); k.child.exit(1); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: code, errorRetryable: false });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ attempts: 1, completedAt: now, outcome: 'failed', lastError: expect.stringContaining(code) });
    expect(k.store.snapshot().failures).toMatchObject([{ stage: 'process_probe', code, harness: null, sessionId: null }]);
    k.time.advance(900_000); await flush();
    expect(k.store.snapshot().workAttempts).toHaveLength(1);
    expect(k.store.snapshot().failures).toHaveLength(1);
  } finally { await k.stop(); }
});
it.each(['DB_UNAVAILABLE', 'DB_LOCKED', 'SCHEMA_MISMATCH'])('tenth retryable worker %s failure is recorded and closed failed', async code => {
  const k = await kit({ attempts: 10 });
  try {
    k.child.push(JSON.stringify({ abi: 1, type: 'error', code, retryable: true })); k.child.exit(1); await flush();
    expect(k.store.snapshot().workAttempts[9]).toMatchObject({ outcome: 'failed', errorCode: code, errorRetryable: true });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ attempts: 10, completedAt: now, outcome: 'failed', lastError: expect.stringContaining(code) });
    expect(k.store.snapshot().failures).toMatchObject([{ stage: 'process_probe', code }]);
    k.time.advance(900_000); await flush();
    expect(k.store.snapshot().workAttempts).toHaveLength(10);
    expect(k.store.snapshot().failures).toHaveLength(1);
  } finally { await k.stop(); }
});
it('tenth stall is recorded as PROCESS_STALLED', async () => {
  const k = await kit({ attempts: 10 });
  try {
    k.time.advance(900_000); await flush();
    expect(k.store.snapshot().workAttempts[9]).toMatchObject({ outcome: 'stalled', errorCode: null });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'failed', completedAt: k.time.clock.now() });
    expect(k.store.snapshot().failures).toMatchObject([{ code: 'PROCESS_STALLED' }]);
  } finally { await k.stop(); }
});
it('result and exit zero win a stall race', async () => {
  const k = await kit();
  try {
    k.child.signalGroup = signal => { k.child.signals.push(signal); k.child.push('{"abi":1,"type":"result"}'); k.child.exit(); };
    k.time.advance(900_000); await flush();
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBe('succeeded');
    expect(k.store.snapshot().workItems[0]!.outcome).toBe('succeeded');
  } finally { await k.stop(); }
});
it('unclear stall cleanup stays unknown', async () => {
  const k = await kit();
  try {
    k.inspector.groups.set(k.child.pid, { state: 'unknown' });
    k.time.advance(900_000); await flush();
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBe('unknown');
    k.time.advance(1_800_000); await flush(); expect(k.store.snapshot().workAttempts).toHaveLength(1);
  } finally { k.child.exit(); await k.stop(); }
});
it('heartbeat renews the lease without moving lastProgressAt', async () => {
  const k = await kit();
  try {
    k.child.push('{"abi":1,"type":"progress"}'); await flush();
    k.time.advance(60_000); k.child.push('{"abi":1,"type":"heartbeat"}'); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ lastProgressAt: now, renewedAt: k.time.clock.now() });
  } finally { await k.stop(); }
});
it('retries a pending permanent failure settlement before claiming more work', async () => {
  let failing = true;
  const k = await kit({ configure(store) {
    const finish = store.finishSupervisedWork.bind(store);
    store.finishSupervisedWork = async input => failing ? { ok: false, code: 'DB_UNAVAILABLE', message: '잠시 실패' } : finish(input);
  } });
  try {
    k.child.push('{"abi":1,"type":"error","code":"PERMANENT","retryable":false}'); k.child.exit(1); await flush();
    expect(k.store.snapshot().failures).toHaveLength(0);
    failing = false;
    k.time.advance(5000); await flush(); expect(k.store.snapshot().failures).toHaveLength(1);
    expect(k.store.snapshot().workItems[0]!.outcome).toBe('failed');
  } finally { failing = false; await k.stop(); }
});

it('preserves both rows when failure recording is unavailable and retries the pending settlement', async () => {
  let failing = true;
  const k = await kit({ configure(store) {
    const record = store.recordFailure.bind(store);
    store.recordFailure = async input => failing ? { ok: false, code: 'DB_UNAVAILABLE', message: '기록 실패' } : record(input);
  } });
  try {
    k.child.push('{"abi":1,"type":"progress"}'); await flush();
    const before = k.store.snapshot();
    k.child.push('{"abi":1,"type":"error","code":"PERMANENT","retryable":false}'); k.child.exit(1); await flush();
    expect(k.store.snapshot()).toEqual(before);
    failing = false;
    k.time.advance(5000); await flush();
    expect(k.store.snapshot().failures).toHaveLength(1);
    expect(k.store.snapshot().workItems[0]!.outcome).toBe('failed');
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBe('failed');
  } finally { failing = false; await k.stop(); }
});
it('starts the stall window when the delayed launcher successfully starts the child', async () => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), controller = new AbortController();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() }); let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await store.addWork({ id: idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, idGen, signal: controller.signal,
    launcher: { async start(spec) { await gate; return launcher.start(spec); } }, inspector: fakeProcessInspector(launcher),
    launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) } });
  try {
    await flush(); time.advance(900_000); release(); await flush();
    expect(launcher.processes[0]!.ended).toBe(false);
    time.advance(899_999); await flush(); expect(launcher.processes[0]!.ended).toBe(false);
    time.advance(1); await flush(); expect(store.snapshot().workAttempts[0]!.outcome).toBe('stalled');
  } finally { release(); controller.abort(); await running; }
});

it.each(['nonzero exit', 'signal death', 'cancellation', 'protocol failure'] as const)('keeps %s when descendant cleanup crosses the stall deadline', async trigger => {
  const k = await kit();
  try {
    // The leader exits promptly, but its descendant survives SIGTERM until
    // the cleanup grace period ends after the original stall deadline.
    k.inspector.groups.set(k.child.pid, { state: 'found', value: [{ pid: k.child.pid + 1, pgid: k.child.pid, startedAt: now }] });
    k.inspector.signalGroup = async (pgid, signal) => {
      k.inspector.signals.push({ pgid, signal });
      if (signal === 'SIGKILL') k.inspector.groups.set(pgid, { state: 'none' });
      if (!k.child.ended) k.child.signalGroup(signal);
      return 'sent';
    };
    if (trigger === 'cancellation') await k.store.requestWorkCancel({ id: k.id, now });
    k.time.advance(899_000); await flush();
    if (trigger === 'nonzero exit') k.child.exit(2);
    else if (trigger === 'signal death') k.child.exit(null, 'SIGKILL');
    else if (trigger === 'protocol failure') k.child.push('invalid');
    await flush();
    expect(k.inspector.signals).toMatchObject([{ signal: 'SIGTERM' }]);
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBeNull();
    k.time.advance(1000); await flush();
    k.time.advance(4000); await flush();
    expect(k.inspector.signals).toMatchObject([{ signal: 'SIGTERM' }, { signal: 'SIGKILL' }]);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({
      outcome: trigger === 'signal death' ? 'died' : trigger === 'cancellation' ? 'cancelled' : 'failed',
      errorCode: trigger === 'nonzero exit' ? 'ABI_EXIT_FAILED' : trigger === 'protocol failure' ? 'ABI_LINE_INVALID' : null,
    });
  } finally { k.child.exit(); await k.stop(); }
});
it('persists repeated progress shortly after heartbeat renewals without heartbeat changing progress', async () => {
  const writes: { now: Date; progressAt: Date | null }[] = [];
  const k = await kit({ configure(store) {
    const renew = store.renewSupervisedLease.bind(store);
    store.renewSupervisedLease = async input => { writes.push({ now: input.now, progressAt: input.progressAt }); return renew(input); };
  } });
  try {
    for (let minute = 0; minute < 20; minute++) {
      const before = k.store.snapshot().workAttempts[0]!.lastProgressAt;
      k.child.push('{"abi":1,"type":"heartbeat"}'); await flush();
      expect(k.store.snapshot().workAttempts[0]!.lastProgressAt).toEqual(before);
      k.time.advance(1000); k.child.push('{"abi":1,"type":"progress"}'); await flush();
      expect(k.store.snapshot().workAttempts[0]!.lastProgressAt).toEqual(k.time.clock.now());
      k.time.advance(59_000); await flush();
    }
    expect(k.child.signals).toEqual([]);
    const heartbeats = writes.filter(write => write.progressAt === null);
    expect(heartbeats.length).toBeGreaterThan(0);
    for (let i = 1; i < heartbeats.length; i++) expect(heartbeats[i]!.now.getTime() - heartbeats[i - 1]!.now.getTime()).toBeGreaterThanOrEqual(60_000);
  } finally { await k.stop(); }
});

it.each(['protocol failure', 'nonzero exit'] as const)('preserves cancellation observed during cleanup after %s', async trigger => {
  const k = await kit();
  try {
    k.inspector.groups.set(k.child.pid, { state: 'found', value: [{ pid: k.child.pid + 1, pgid: k.child.pid, startedAt: now }] });
    k.inspector.signalGroup = async (pgid, signal) => {
      k.inspector.signals.push({ pgid, signal });
      if (signal === 'SIGKILL') k.inspector.groups.set(pgid, { state: 'none' });
      if (!k.child.ended) k.child.signalGroup(signal);
      return 'sent';
    };
    if (trigger === 'protocol failure') k.child.push('invalid');
    else k.child.exit(2);
    await flush();
    expect(k.inspector.signals).toMatchObject([{ signal: 'SIGTERM' }]);
    expect(k.store.snapshot().workAttempts[0]!.outcome).toBeNull();
    await k.store.requestWorkCancel({ id: k.id, now: k.time.clock.now() });
    k.time.advance(1000); await flush(); // Cancellation poll observes the request during grace.
    k.time.advance(4000); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'cancelled', errorCode: null, errorRetryable: null });
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'cancelled', completedAt: k.time.clock.now() });
    expect(k.store.snapshot().failures).toEqual([]);
  } finally { k.child.exit(); await k.stop(); }
});
