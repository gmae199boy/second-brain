import { expect, it } from 'vitest';
import { runSupervisor } from '../src/queue/supervisor.js';
import { inspectGroup, cleanProcessGroup } from '../src/queue/process-cleanup.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
import { fakeProcessInspector, fakeProcessLauncher } from '../src/testing/fakes/process.js';
import { manualTime } from '../src/testing/fakes/clock.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
const now = new Date('2026-10-29T00:00:00Z');
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
async function kit(configure?: (store: ReturnType<typeof memoryStore>, inspector: ReturnType<typeof fakeProcessInspector>) => void, holdGroup?: string) {
  const store = memoryStore(); const launcher = fakeProcessLauncher(); const inspector = fakeProcessInspector(launcher);
  const time = manualTime(now); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const controller = new AbortController(); const id = idGen.next();
  await store.addWork({ id, holdGroup, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  configure?.(store, inspector);
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, launcher, inspector, ...time, idGen,
    signal: controller.signal, cancelGraceMs: 300, cancelPollMs: 100, groupConfirmMs: 200,
    launches: { process_probe: () => ({ command: 'fake', args: [], env: {} }) } });
  await flush(); return { store, launcher, inspector, time, controller, id, running };
}
it.each(['unknown', 'none'] as const)('keeps supervising a child when its spawn start identity is %s', async state => {
  const inspectedPids: number[] = [];
  const k = await kit((_, inspector) => {
    inspector.startedAt = async pid => { inspectedPids.push(pid); return { state }; };
  });
  const child = k.launcher.processes[0]!;
  try {
    expect(inspectedPids).toEqual([child.pid]);
    expect(k.store.snapshot().workAttempts).toMatchObject([{
      pid: child.pid, pgid: child.pid, osStartedAt: null, finishedAt: null, outcome: null,
    }]);
    expect(child.ended).toBe(false);

    k.time.advance(1000);
    child.push('{"abi":1,"type":"progress"}'); await flush();
    expect(k.store.snapshot().workAttempts).toMatchObject([{
      pid: child.pid, pgid: child.pid, osStartedAt: null,
      lastProgressAt: k.time.clock.now(), renewedAt: k.time.clock.now(), finishedAt: null, outcome: null,
    }]);
    expect(child.ended).toBe(false);
    expect(k.store.snapshot().workItems[0]).toMatchObject({
      completedAt: null, claimExpiresAt: new Date(k.time.clock.now().getTime() + 600_000),
    });

    child.push('{"abi":1,"type":"result"}'); child.exit(0); await flush();
    expect(k.store.snapshot().workAttempts).toMatchObject([{
      pid: child.pid, pgid: child.pid, osStartedAt: null, outcome: 'succeeded', finishedAt: k.time.clock.now(),
    }]);
    expect(k.store.snapshot().workItems[0]).toMatchObject({
      outcome: 'succeeded', completedAt: k.time.clock.now(), currentAttemptToken: null, attempts: 1,
    });
    expect(child.signals).toEqual([]);
  } finally { k.controller.abort(); await k.running; }
});
it('polls silent children, sends TERM then KILL after grace, and settles cancellation', async () => {
  const k = await kit(); const child = k.launcher.processes[0]!; child.ignoreTerm = true;
  await k.store.requestWorkCancel({ id: k.id, now });
  k.time.advance(100); await flush(); expect(child.signals).toEqual(['SIGTERM']);
  k.time.advance(299); await flush(); expect(child.signals).toEqual(['SIGTERM']);
  k.time.advance(1); await flush(); expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'cancelled', completedAt: k.time.clock.now(), currentAttemptToken: null });
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('cancelled');
  k.controller.abort(); await k.running;
});
it.each([
  ['unknown', false], ['unknown', true], ['none', false], ['none', true],
] as const)('cancels a live child with %s start identity (ignores TERM: %s)', async (state, ignoreTerm) => {
  const k = await kit((_, inspector) => { inspector.startedAt = async () => ({ state }); });
  const child = k.launcher.processes[0]!; child.ignoreTerm = ignoreTerm;
  try {
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ pid: child.pid, pgid: child.pid, osStartedAt: null });
    expect(child.ended).toBe(false);
    expect(await k.store.requestWorkCancel({ id: k.id, now })).toEqual({ ok: true, state: 'requested' });
    k.time.advance(100); await flush();
    expect(child.signals).toEqual(['SIGTERM']);
    if (ignoreTerm) {
      expect(child.ended).toBe(false);
      k.time.advance(299); await flush(); expect(child.signals).toEqual(['SIGTERM']);
      k.time.advance(1); await flush(); expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    }
    expect(child.ended).toBe(true);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'cancelled', finishedAt: k.time.clock.now() });
    expect(k.store.snapshot().workItems[0]).toMatchObject({
      outcome: 'cancelled', completedAt: k.time.clock.now(), currentAttemptToken: null,
      claimedBy: null, claimExpiresAt: null,
    });
  } finally { if (!child.ended) child.exit(); k.controller.abort(); await k.running; }
});
it.each(['before cancel poll', 'during TERM grace'] as const)('closes requested work on shutdown %s instead of returning it', async phase => {
  const k = await kit(); const child = k.launcher.processes[0]!;
  try {
    child.ignoreTerm = phase === 'during TERM grace';
    expect(await k.store.requestWorkCancel({ id: k.id, now })).toEqual({ ok: true, state: 'requested' });
    if (phase === 'during TERM grace') {
      k.time.advance(100); await flush(); expect(child.signals).toEqual(['SIGTERM']);
      k.time.advance(100); await flush();
    } else expect(child.signals).toEqual([]);
    k.controller.abort(); await flush();
    if (phase === 'during TERM grace') { k.time.advance(200); await flush(); }
    await k.running;
    expect(child.ended).toBe(true);
    expect(child.signals).toEqual(phase === 'during TERM grace' ? ['SIGTERM', 'SIGKILL'] : ['SIGTERM']);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'cancelled', finishedAt: k.time.clock.now() });
    expect(k.store.snapshot().workItems[0]).toMatchObject({
      outcome: 'cancelled', completedAt: k.time.clock.now(), currentAttemptToken: null,
      claimedBy: null, claimExpiresAt: null, attempts: 1,
    });
    expect(await k.store.claimSupervisedWork({ now: new Date(now.getTime() + 600_000),
      kinds: ['process_probe'], claimedBy: 'another-supervisor', attemptToken: 'another-token',
    })).toMatchObject({ ok: true, item: null });
  } finally { if (!child.ended) child.exit(); k.controller.abort(); await k.running; }
});
it('does not KILL a group emptied by TERM and returns shutdown work without spending an attempt', async () => {
  const k = await kit(); k.controller.abort(); await k.running;
  expect(k.launcher.processes[0]!.signals).toEqual(['SIGTERM']);
  expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: null, attempts: 0, currentAttemptToken: null, nextAttemptAt: now });
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('cancelled');
});
it('allows result and exit zero to win a cancellation request race', async () => {
  const k = await kit(); await k.store.requestWorkCancel({ id: k.id, now });
  k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit(); await flush();
  expect(k.store.snapshot().workItems[0]?.outcome).toBe('succeeded');
  k.controller.abort(); await k.running;
});
it.each(['other boot', 'none', 'unknown', 'same leader', 'reused leader', 'leaderless', 'missing identity'] as const)('reconciles group identity: %s', async scenario => {
  const inspector = fakeProcessInspector();
  const identity = { pgid: 123, osBootAt: now, osStartedAt: now };
  const member = { pid: 123, pgid: 123, startedAt: now };
  inspector.groups.set(123, { state: 'found', value: [member] });
  let expected = 'ours';
  if (scenario === 'other boot') { inspector.boot = { state: 'found', value: new Date(0) }; expected = 'died'; }
  if (scenario === 'none') { inspector.groups.set(123, { state: 'none' }); expected = 'died'; }
  if (scenario === 'unknown') { inspector.groups.set(123, { state: 'unknown' }); expected = 'unknown'; }
  if (scenario === 'reused leader') { member.startedAt = new Date(0); expected = 'died'; }
  if (scenario === 'leaderless') member.pid = 124;
  if (scenario === 'missing identity') { identity.osStartedAt = null as unknown as Date; expected = 'unknown'; }
  expect(await inspectGroup(inspector, identity)).toBe(expected);
  expect(inspector.signals).toEqual([]);
});
it('never signals an unknown group after the leader has been reaped', async () => {
  const inspector = fakeProcessInspector(); inspector.groups.set(123, { state: 'unknown' });
  const launcher = fakeProcessLauncher(); const started = await launcher.start({ command: 'fake', args: [], env: {} });
  if (!started.ok) throw new Error('start'); launcher.processes[0]!.exit();
  expect(await cleanProcessGroup({ inspector, identity: { pgid: 123, osBootAt: now, osStartedAt: now }, ...manualTime(now),
    graceMs: 300, confirmMs: 200, handle: started.handle })).toBe('unknown');
  expect(inspector.signals).toEqual([]);
});
it('does not claim until startup reconciliation can list previous attempts', async () => {
  const store = memoryStore(); let reads = 0; let claims = 0;
  const list = store.listOpenSupervisedAttempts.bind(store); const claim = store.claimSupervisedWork.bind(store);
  store.listOpenSupervisedAttempts = async () => ++reads === 1 ? { ok: false, code: 'DB_UNAVAILABLE', message: '실패' } : list();
  store.claimSupervisedWork = async input => { claims++; return claim(input); };
  const controller = new AbortController(); const time = manualTime(now);
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher: fakeProcessLauncher(), inspector: fakeProcessInspector(),
    idGen: sequenceIdGen({ timestampMs: now.getTime() }), signal: controller.signal, launches: {}, pollMs: 10 });
  await flush(); expect(claims).toBe(0); time.advance(10); await flush(); expect(claims).toBe(1);
  controller.abort(); await running;
});
it.each(['died', 'unknown', 'cancelled'] as const)('settles prior incarnation as %s before claiming', async expected => {
  const store = memoryStore(); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const id = idGen.next(); const token = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['process_probe'], attemptToken: token });
  await store.recordSupervisedProcess({ id, attemptToken: token, pid: 123, pgid: 123, osBootAt: now, osStartedAt: now });
  if (expected === 'cancelled') await store.requestWorkCancel({ id, now });
  const inspector = fakeProcessInspector(); if (expected === 'unknown') inspector.groups.set(123, { state: 'unknown' });
  const controller = new AbortController(); const time = manualTime(now); const launcher = fakeProcessLauncher();
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher, inspector, idGen,
    signal: controller.signal, launches: {} });
  await flush(); expect(store.snapshot().workAttempts[0]!.outcome).toBe(expected);
  const item = store.snapshot().workItems[0]!;
  expect(item.currentAttemptToken).toBe(expected === 'unknown' ? token : null);
  if (expected === 'cancelled') expect(item.outcome).toBe('cancelled');
  controller.abort(); await running;
});
it('leaves signal permission failures unknown with the current claim retained', async () => {
  const k = await kit(); k.inspector.signalFailure = true;
  await k.store.requestWorkCancel({ id: k.id, now }); k.time.advance(100); await flush();
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('unknown');
  expect(k.store.snapshot().workItems[0]?.currentAttemptToken).toBeTruthy();
  k.controller.abort(); await k.running; k.launcher.processes[0]!.exit();
});
it('stops progress renewal when an unknown settlement leaves a worker alive', async () => {
  const k = await kit(); const child = k.launcher.processes[0]!;
  k.inspector.signalFailure = true;
  await k.store.requestWorkCancel({ id: k.id, now }); k.time.advance(100); await flush();
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('unknown');
  const before = k.store.snapshot();
  child.push('{"abi":1,"type":"progress"}'); k.time.advance(60000); await flush();
  expect(k.store.snapshot()).toEqual(before); expect(child.ended).toBe(false);
  k.controller.abort(); await k.running; child.exit();
});
it('leaves the attempt unknown when surviving group members cannot be confirmed gone after KILL', async () => {
  const k = await kit(); const child = k.launcher.processes[0]!; child.ignoreTerm = true;
  k.inspector.groups.set(child.pid, { state: 'found', value: [{ pid: child.pid, pgid: child.pid, startedAt: now }] });
  await k.store.requestWorkCancel({ id: k.id, now }); k.time.advance(100); await flush();
  k.time.advance(300); await flush(); expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBeNull();
  k.time.advance(200); await flush(); expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('unknown');
  expect(k.store.snapshot().workItems[0]?.currentAttemptToken).toBeTruthy();
  k.controller.abort(); await k.running;
});
it('recognizes an empty group even when the previous boot identity was unavailable', async () => {
  const inspector = fakeProcessInspector();
  expect(await inspectGroup(inspector, { pgid: 123, osBootAt: null, osStartedAt: null })).toBe('died');
});

it.each([
  ['unknown current boot', true], ['unknown current boot', false],
  ['missing recorded boot', true], ['missing recorded boot', false],
] as const)('keeps a found group unknown with %s (leader present: %s)', async (scenario, leader) => {
  const inspector = fakeProcessInspector();
  if (scenario === 'unknown current boot') inspector.boot = { state: 'unknown' };
  inspector.groups.set(123, { state: 'found', value: [{ pid: leader ? 123 : 124, pgid: 123, startedAt: now }] });
  expect(await inspectGroup(inspector, {
    pgid: 123, osBootAt: scenario === 'missing recorded boot' ? null : now, osStartedAt: now,
  })).toBe('unknown');
  expect(inspector.signals).toEqual([]);
});

it.each([1, 2])('retries the exact finish after %i failures before another claim', async failures => {
  const events: string[] = [];
  const calls: Parameters<ReturnType<typeof memoryStore>['finishSupervisedWork']>[0][] = [];
  const k = await kit(store => {
    const finish = store.finishSupervisedWork.bind(store);
    const claim = store.claimSupervisedWork.bind(store);
    store.claimSupervisedWork = async input => { events.push('claim'); return claim(input); };
    store.finishSupervisedWork = async input => {
      events.push('finish'); calls.push(input);
      return calls.length <= failures ? { ok: false, code: 'DB_UNAVAILABLE', message: '일시 연결 실패' } : finish(input);
    };
  });
  try {
    const child = k.launcher.processes[0]!;
    child.push('{"abi":1,"type":"result"}'); child.exit(0); await flush();
    for (let retry = 0; retry < failures; retry++) { k.time.advance(5000); await flush(); }
    // Capacity filling makes two initial claims; no new claim may appear
    // between the first failed finish and its successful retry.
    expect(events.slice(0, failures + 3)).toEqual(['claim', 'claim', ...Array(failures + 1).fill('finish')]);
    expect(events.slice(failures + 3).every(event => event === 'claim')).toBe(true);
    expect(calls).toHaveLength(failures + 1);
    for (const call of calls) expect(call).toBe(calls[0]);
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'succeeded', completedAt: now, currentAttemptToken: null });
  } finally { k.controller.abort(); await k.running; }
});

it.each(['cancelled', 'unknown'] as const)('retries a failed %s settlement without repeating process cleanup', async outcome => {
  const calls: Parameters<ReturnType<typeof memoryStore>['settleSupervisedAttempt']>[0][] = [];
  let claims = 0;
  let failing = true;
  const k = await kit(store => {
    const settle = store.settleSupervisedAttempt.bind(store);
    const claim = store.claimSupervisedWork.bind(store);
    store.claimSupervisedWork = async input => { claims++; return claim(input); };
    store.settleSupervisedAttempt = async input => {
      calls.push(input);
      return failing ? { ok: false, code: 'DB_LOCKED', message: '일시 잠금' } : settle(input);
    };
  });
  const child = k.launcher.processes[0]!;
  try {
    k.inspector.signalFailure = outcome === 'unknown';
    await k.store.requestWorkCancel({ id: k.id, now });
    k.time.advance(100); await flush();
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]?.outcome).toBe(outcome);
    expect(claims).toBe(2);
    const signals = [...k.inspector.signals];
    failing = false;
    k.time.advance(5000); await flush();
    for (const call of calls) expect(call).toBe(calls[0]);
    expect(k.inspector.signals).toEqual(signals);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome, finishedAt: calls[0]!.now });
    expect(k.store.snapshot().workItems[0]?.currentAttemptToken).toBe(outcome === 'unknown' ? calls[0]!.attemptToken : null);
  } finally { failing = false; k.controller.abort(); await k.running; if (!child.ended) child.exit(); }
});

it.each(['before leader exit', 'during terminal settlement'] as const)('cleans surviving members when cancellation commits %s before the cancel poll observes it', async race => {
  let settleCalls = 0;
  let allowFinish = false;
  const k = await kit(store => {
    const finish = store.finishSupervisedWork.bind(store);
    store.finishSupervisedWork = async input => {
      expect(allowFinish).toBe(true);
      settleCalls++;
      if (race === 'during terminal settlement') await store.requestWorkCancel({ id: input.id, now });
      return finish(input);
    };
  });
  const child = k.launcher.processes[0]!;
  // The leader's independent stdio has closed; its TERM-ignoring descendant survives.
  k.inspector.groups.set(child.pid, { state: 'found', value: [{ pid: child.pid + 1, pgid: child.pid, startedAt: now }] });
  const send = k.inspector.signalGroup.bind(k.inspector);
  k.inspector.signalGroup = async (pgid, signal) => {
    if (signal === 'SIGKILL') { k.inspector.groups.set(pgid, { state: 'none' }); allowFinish = true; }
    return send(pgid, signal);
  };
  if (race === 'before leader exit') await k.store.requestWorkCancel({ id: k.id, now });
  child.exit(2); await flush();
  expect(child.signals).toEqual(['SIGTERM']); expect(settleCalls).toBe(0);
  expect(k.store.snapshot().workItems[0]!.currentAttemptToken).toBeTruthy();
  k.time.advance(300); await flush();
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'cancelled', currentAttemptToken: null });
  k.controller.abort(); await k.running;
});

it('cancels a running attempt of a held group without closing the work', async () => {
  const k = await kit(undefined, 'extension:testext'); const child = k.launcher.processes[0]!; child.ignoreTerm = true;
  try {
    await k.store.holdWorkGroup({ group: 'extension:testext', now });
    k.time.advance(100); await flush(); expect(child.signals).toEqual(['SIGTERM']);
    k.time.advance(300); await flush(); expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('cancelled');
    expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: null, outcome: null, cancelRequestedAt: null,
      currentAttemptToken: null, claimedAt: null, claimedBy: null, attempts: 0 });
    expect(await k.store.claimSupervisedWork({ now: k.time.clock.now(), kinds: ['process_probe'], claimedBy: 'other', attemptToken: 'next' })).toMatchObject({ item: null });
    await k.store.releaseWorkGroup({ group: 'extension:testext' });
    expect(await k.store.claimSupervisedWork({ now: k.time.clock.now(), kinds: ['process_probe'], claimedBy: 'other', attemptToken: 'next' })).toMatchObject({ item: { id: k.id } });
  } finally { k.controller.abort(); await k.running; }
});
it('allows result and exit zero to win a group hold race', async () => {
  const k = await kit(undefined, 'extension:testext');
  try {
    await k.store.holdWorkGroup({ group: 'extension:testext', now });
    k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit(); await flush();
    expect(k.store.snapshot().workItems[0]?.outcome).toBe('succeeded');
  } finally { k.controller.abort(); await k.running; }
});

it.each([
  { attempts: 10, cancelled: false, held: false, outcome: 'failed' },
  { attempts: 3, cancelled: false, held: false, outcome: null },
  { attempts: 10, cancelled: true, held: false, outcome: 'cancelled' },
  { attempts: 10, cancelled: false, held: true, outcome: null },
] as const)('recovers $attempts attempts (cancelled: $cancelled, held: $held)', async scenario => {
  const store = memoryStore(); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: 'recovered', holdGroup: 'recovery', createdAt: now, nextAttemptAt: now });
  for (let count = 1; count <= scenario.attempts; count++) {
    const token = idGen.next();
    await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['process_probe'], attemptToken: token });
    if (count < scenario.attempts) await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome: 'died' });
  }
  if (scenario.cancelled) await store.requestWorkCancel({ id, now });
  if (scenario.held) await store.holdWorkGroup({ group: 'recovery', now });
  const controller = new AbortController(); const time = manualTime(now);
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher: fakeProcessLauncher(), inspector: fakeProcessInspector(), idGen, signal: controller.signal, launches: {} });
  try {
    await flush();
    expect(store.snapshot().workItems[0]).toMatchObject({ outcome: scenario.outcome, currentAttemptToken: null, attempts: scenario.attempts });
    expect(store.snapshot().workAttempts.at(-1)?.outcome).toBe(scenario.cancelled ? 'cancelled' : 'died');
    expect(store.snapshot().failures).toHaveLength(scenario.outcome === 'failed' ? 1 : 0);
    if (scenario.outcome === 'failed') {
      expect(store.snapshot().workItems[0]?.lastError).toContain('PROCESS_DIED');
      expect(store.snapshot().failures[0]).toMatchObject({ code: 'PROCESS_DIED', targetKind: 'probe', targetId: 'recovered', stage: 'process_probe' });
    }
    const claimed = await store.claimSupervisedWork({ now, claimedBy: 'next', kinds: ['process_probe'], attemptToken: idGen.next() });
    expect(claimed).toMatchObject({ ok: true, item: scenario.attempts < 10 ? { id } : null });
  } finally { controller.abort(); await running; }
});

it.each(['identity', 'record', 'poll', 'renew'] as const)('cleans a child after a thrown %s call and blocks claims until settlement succeeds', async phase => {
  let allowSettlement = false; let claims = 0; let settlements = 0;
  const k = await kit((store, inspector) => {
    const claim = store.claimSupervisedWork.bind(store);
    store.claimSupervisedWork = async input => { claims++; return claim(input); };
    const settle = store.settleSupervisedAttempt.bind(store);
    store.settleSupervisedAttempt = async input => {
      settlements++;
      return allowSettlement ? settle(input) : { ok: false, code: 'DB_UNAVAILABLE', message: 'retry' };
    };
    if (phase === 'identity') inspector.startedAt = async () => { throw new Error('identity'); };
    if (phase === 'record') store.recordSupervisedProcess = async () => { throw new Error('record'); };
    if (phase === 'poll') {
      const list = store.listOpenSupervisedAttempts.bind(store); let reads = 0;
      store.listOpenSupervisedAttempts = async () => { if (++reads === 2) throw new Error('poll'); return list(); };
    }
    if (phase === 'renew') store.renewSupervisedLease = async () => { throw new Error('renew'); };
  });
  const child = k.launcher.processes[0]!;
  try {
    if (phase === 'poll') { k.time.advance(100); await flush(); }
    if (phase === 'renew') { child.push('{"abi":1,"type":"progress"}'); await flush(); }
    expect(child.ended).toBe(true); expect(child.signals).toEqual(['SIGTERM']);
    expect(settlements).toBeGreaterThan(0);
    const before = claims;
    k.time.advance(5000); await flush(); expect(claims).toBe(before);
    allowSettlement = true; k.time.advance(5000); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'died', finishedAt: k.time.clock.now() });
    expect(claims).toBeGreaterThan(before);
  } finally { allowSettlement = true; k.controller.abort(); await k.running; }
});

it('retains the token as unknown when exception cleanup itself throws', async () => {
  const k = await kit((store, inspector) => {
    store.recordSupervisedProcess = async () => { throw new Error('record'); };
    inspector.signalGroup = async () => { throw new Error('cleanup'); };
  });
  try {
    expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('unknown');
    expect(k.store.snapshot().workItems[0]?.currentAttemptToken).toBeTruthy();
    expect(k.launcher.processes[0]?.ended).toBe(false);
  } finally { k.launcher.processes[0]!.exit(); k.controller.abort(); await k.running; }
});

it('waits for exception cleanup during shutdown', async () => {
  const k = await kit(store => {
    const list = store.listOpenSupervisedAttempts.bind(store); let reads = 0;
    store.listOpenSupervisedAttempts = async () => { if (++reads === 2) throw new Error('poll'); return list(); };
  });
  const child = k.launcher.processes[0]!; child.ignoreTerm = true;
  let finished = false;
  void k.running.then(() => { finished = true; });
  k.time.advance(100); await flush();
  expect(child.signals).toEqual(['SIGTERM']);
  k.controller.abort(); await flush();
  expect(finished).toBe(false); expect(child.ended).toBe(false);
  k.time.advance(300); await flush(); await k.running;
  expect(child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  expect(child.ended).toBe(true); expect(finished).toBe(true);
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('died');
});

it('blocks new claims while one child needs slow exception cleanup and another finishes', async () => {
  const store = memoryStore(); const launcher = fakeProcessLauncher(); const inspector = fakeProcessInspector(launcher);
  const time = manualTime(now); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const controller = new AbortController();
  const ids = [idGen.next(), idGen.next(), idGen.next()];
  for (const [index, id] of ids.entries()) await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: String(index), createdAt: now, nextAttemptAt: now });
  let claims = 0; let allowSettlement = false;
  const claim = store.claimSupervisedWork.bind(store); const renew = store.renewSupervisedLease.bind(store); const settle = store.settleSupervisedAttempt.bind(store);
  store.claimSupervisedWork = async input => { claims++; return claim(input); };
  store.renewSupervisedLease = async input => { if (input.id === ids[0]) throw new Error('renew'); return renew(input); };
  store.settleSupervisedAttempt = async input => allowSettlement ? settle(input) : { ok: false, code: 'DB_UNAVAILABLE', message: 'retry' };
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher, inspector, idGen, signal: controller.signal, cancelGraceMs: 300, pollMs: 100,
    launches: { process_probe: () => ({ command: 'fake', args: [], env: {} }) } });
  try {
    await flush(); expect(launcher.processes).toHaveLength(2); expect(claims).toBe(2);
    const failed = launcher.processes[0]!; const succeeded = launcher.processes[1]!;
    failed.ignoreTerm = true;
    failed.push('{"abi":1,"type":"progress"}'); await flush();
    expect(failed.signals).toEqual(['SIGTERM']); expect(failed.ended).toBe(false);
    succeeded.push('{"abi":1,"type":"result"}'); succeeded.exit(); await flush();
    expect(store.snapshot().workItems[1]?.outcome).toBe('succeeded');
    expect(claims).toBe(2); expect(launcher.processes).toHaveLength(2);
    time.advance(299); await flush(); expect(claims).toBe(2); expect(failed.ended).toBe(false);
    time.advance(1); await flush();
    expect(failed.signals).toEqual(['SIGTERM', 'SIGKILL']); expect(failed.ended).toBe(true);
    expect(claims).toBe(2); expect(store.snapshot().workAttempts[0]?.outcome).toBe(null);
    allowSettlement = true; time.advance(100); await flush();
    expect(store.snapshot().workAttempts[0]?.outcome).toBe('died'); expect(claims).toBeGreaterThan(2);
    expect(failed.signals).toEqual(['SIGTERM', 'SIGKILL']);
  } finally { allowSettlement = true; controller.abort(); await running; }
});

it('rechecks a group hold before retrying a tenth exception death settlement', async () => {
  const store = memoryStore(); const launcher = fakeProcessLauncher(); const inspector = fakeProcessInspector(launcher);
  const time = manualTime(now); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const controller = new AbortController();
  const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: 'held-retry', holdGroup: 'recovery', createdAt: now, nextAttemptAt: now });
  for (let count = 0; count < 9; count++) {
    const token = idGen.next();
    await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['process_probe'], attemptToken: token });
    await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome: 'died' });
  }
  store.recordSupervisedProcess = async () => { throw new Error('record'); };
  const finish = store.finishSupervisedWork.bind(store); let finishes = 0; let allowSettlement = false;
  store.finishSupervisedWork = async input => {
    finishes++;
    return allowSettlement ? finish(input) : { ok: false, code: 'DB_UNAVAILABLE', message: 'retry' };
  };
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher, inspector, idGen, signal: controller.signal,
    launches: { process_probe: () => ({ command: 'fake', args: [], env: {} }) } });
  try {
    await flush();
    expect(finishes).toBeGreaterThan(0);
    const before = finishes;
    expect(launcher.processes[0]?.ended).toBe(true);
    expect(store.snapshot().workAttempts.at(-1)?.outcome).toBeNull();
    await store.holdWorkGroup({ group: 'recovery', now });
    allowSettlement = true;
    time.advance(5000); await flush();
    expect(store.snapshot().workItems[0]).toMatchObject({ attempts: 10, outcome: null, completedAt: null, currentAttemptToken: null });
    expect(store.snapshot().workAttempts.at(-1)?.outcome).toBe('died');
    expect(store.snapshot().failures).toEqual([]);
    expect(finishes).toBe(before);
    expect(launcher.processes).toHaveLength(1);
  } finally { controller.abort(); await running; }
});

it('keeps tenth recovered work open when its group is held during cleanup', async () => {
  const store = memoryStore(); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: 'held-cleanup', holdGroup: 'recovery', createdAt: now, nextAttemptAt: now });
  let token = '';
  for (let count = 1; count <= 10; count++) {
    token = idGen.next();
    await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['process_probe'], attemptToken: token });
    if (count < 10) await store.settleSupervisedAttempt({ id, attemptToken: token, now, outcome: 'died' });
  }
  await store.recordSupervisedProcess({ id, attemptToken: token, pid: 123, pgid: 123, osBootAt: now, osStartedAt: now });
  const inspector = fakeProcessInspector();
  inspector.groups.set(123, { state: 'found', value: [{ pid: 123, pgid: 123, startedAt: now }] });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  inspector.signalGroup = async (pgid, signal) => {
    inspector.signals.push({ pgid, signal });
    await gate;
    inspector.groups.set(pgid, { state: 'none' });
    return 'sent';
  };
  const controller = new AbortController(); const time = manualTime(now);
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher: fakeProcessLauncher(), inspector, idGen, signal: controller.signal, launches: {} });
  try {
    await flush();
    expect(inspector.signals).toEqual([{ pgid: 123, signal: 'SIGTERM' }]);
    expect(store.snapshot().workAttempts.at(-1)?.outcome).toBeNull();
    expect(await store.holdWorkGroup({ group: 'recovery', now })).toMatchObject({ ok: true });
    release(); await flush();
    expect(store.snapshot().workAttempts.at(-1)?.outcome).toBe('died');
    expect(store.snapshot().workItems[0]).toMatchObject({ attempts: 10, outcome: null, completedAt: null, currentAttemptToken: null });
    expect(store.snapshot().failures).toEqual([]);
    expect(await store.claimSupervisedWork({ now, claimedBy: 'next', kinds: ['process_probe'], attemptToken: idGen.next() }))
      .toMatchObject({ ok: true, item: null });
  } finally { release(); controller.abort(); await running; }
});
