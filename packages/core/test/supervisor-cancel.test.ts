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
async function kit(configure?: (store: ReturnType<typeof memoryStore>, inspector: ReturnType<typeof fakeProcessInspector>) => void) {
  const store = memoryStore(); const launcher = fakeProcessLauncher(); const inspector = fakeProcessInspector(launcher);
  const time = manualTime(now); const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const controller = new AbortController(); const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  configure?.(store, inspector);
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, launcher, inspector, ...time, idGen,
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
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher: fakeProcessLauncher(), inspector: fakeProcessInspector(),
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
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher, inspector, idGen,
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
    expect(events).toEqual(['claim', 'finish']);
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: null, currentAttemptToken: expect.any(String) });
    for (let retry = 1; retry <= failures; retry++) {
      k.time.advance(4999); await flush();
      expect(events).toEqual(['claim', ...Array(retry).fill('finish')]);
      k.time.advance(1); await flush();
      expect(events).toEqual(['claim', ...Array(retry + 1).fill('finish'), ...(retry === failures ? ['claim'] : [])]);
      expect(calls[retry]).toBe(calls[0]);
    }
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'succeeded', completedAt: now, currentAttemptToken: null });
  } finally { k.controller.abort(); await k.running; }
});

it.each(['cancelled', 'unknown'] as const)('retries a failed %s settlement without repeating process cleanup', async outcome => {
  const calls: Parameters<ReturnType<typeof memoryStore>['settleSupervisedAttempt']>[0][] = [];
  let claims = 0;
  const k = await kit(store => {
    const settle = store.settleSupervisedAttempt.bind(store);
    const claim = store.claimSupervisedWork.bind(store);
    store.claimSupervisedWork = async input => { claims++; return claim(input); };
    store.settleSupervisedAttempt = async input => {
      calls.push(input);
      return calls.length === 1 ? { ok: false, code: 'DB_LOCKED', message: '일시 잠금' } : settle(input);
    };
  });
  const child = k.launcher.processes[0]!;
  try {
    k.inspector.signalFailure = outcome === 'unknown';
    await k.store.requestWorkCancel({ id: k.id, now });
    k.time.advance(100); await flush();
    expect(calls).toHaveLength(1);
    expect(calls[0]?.outcome).toBe(outcome);
    expect(claims).toBe(1);
    const signals = [...k.inspector.signals];
    k.time.advance(5000); await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toBe(calls[0]);
    expect(k.inspector.signals).toEqual(signals);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome, finishedAt: calls[0]!.now });
    expect(k.store.snapshot().workItems[0]?.currentAttemptToken).toBe(outcome === 'unknown' ? calls[0]!.attemptToken : null);
  } finally { k.controller.abort(); await k.running; if (!child.ended) child.exit(); }
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
