import { expect, it } from 'vitest';
import { runSupervisor } from '../src/queue/supervisor.js';
import { drainQueue } from '../src/queue/drain.js';
import { manualTime } from '../src/testing/fakes/clock.js';
import { fakeProcessLauncher, fakeProcessInspector } from '../src/testing/fakes/process.js';
import { memorySpool } from '../src/testing/fakes/spool.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
import type { ProcessLauncher } from '../src/ports/process.js';
const now = new Date('2026-10-29T00:00:00Z');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function kit(options: { holdGroup?: string; keys?: (string | null)[]; launcher?: ProcessLauncher; configureStore?: (store: ReturnType<typeof memoryStore>) => void; log?: (message: string) => void; protectedLaunches?: Parameters<typeof runSupervisor>[0]['protectedLaunches'] } = {}) {
  const store = memoryStore();
  options.configureStore?.(store);
  const time = manualTime(now);
  const launcher = fakeProcessLauncher();
  const controller = new AbortController();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  const id = idGen.next();
  for (const [index, key] of (options.keys ?? [null]).entries())
    await store.addWork({ id: index === 0 ? id : idGen.next(), serializationKey: key, holdGroup: options.holdGroup, kind: 'process_probe', targetKind: 'probe', targetId: String(700000 + index), createdAt: now, nextAttemptAt: now });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, inspector: fakeProcessInspector(launcher), launcher: options.launcher ?? launcher, idGen,
    ...(options.log === undefined ? {} : { log: options.log }),
    ...(options.protectedLaunches === undefined ? {} : { protectedLaunches: options.protectedLaunches }),
    launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) }, signal: controller.signal });
  await flush();
  return { store, time, launcher, controller, idGen, id, running };
}
it('fails and releases a claim when the launcher cannot start the child', async () => {
  const k = await kit({ launcher: { async start() { return { ok: false, message: '자식을 시작할 수 없습니다' }; } } });
  try {
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', finishedAt: now });
    expect(k.store.snapshot().workItems[0]).toMatchObject({
      claimedAt: null, claimedBy: null, claimExpiresAt: null, currentAttemptToken: null,
      completedAt: null, nextAttemptAt: new Date(now.getTime() + 900_000),
    });
  } finally { k.controller.abort(); await k.running; }
});
it('renews on first progress and throttles further renewal until 60 seconds', async () => {
  const k = await kit();
  const progress = async () => { k.launcher.processes[0]!.push('{"abi":1,"type":"progress"}'); await flush(); };
  try {
    await progress();
    expect(k.store.snapshot().workAttempts[0]?.renewedAt).toEqual(now);
    expect(k.store.snapshot().workItems[0]?.claimExpiresAt).toEqual(new Date(now.getTime() + 600_000));
    k.time.advance(59_000); await progress();
    expect(k.store.snapshot().workAttempts[0]?.renewedAt).toEqual(now);
    expect(k.store.snapshot().workItems[0]?.claimExpiresAt).toEqual(new Date(now.getTime() + 600_000));
    k.time.advance(1000); await progress();
    expect(k.store.snapshot().workAttempts[0]?.renewedAt).toEqual(new Date(now.getTime() + 60_000));
    expect(k.store.snapshot().workItems[0]?.claimExpiresAt).toEqual(new Date(now.getTime() + 660_000));
  } finally { k.controller.abort(); await k.running; }
});
it('logs a recurring renewal failure again after a successful renewal', async () => {
  const logs: string[] = [];
  // Keep capacity full so successful empty claims do not reset the log state.
  const k = await kit({ keys: ['one', 'two'], log: message => { logs.push(message); }, configureStore(store) {
    const renew = store.renewSupervisedLease.bind(store);
    let calls = 0;
    store.renewSupervisedLease = async input => {
      calls++;
      return calls === 2 ? renew(input) : { ok: false, code: 'DB_UNAVAILABLE', message: '연결 실패' };
    };
  } });
  try {
    for (const elapsed of [0, 1000, 60_000, 1000]) {
      k.time.advance(elapsed);
      k.launcher.processes[0]!.push('{"abi":1,"type":"progress"}'); await flush();
    }
    expect(logs).toEqual(['감독자 임대 갱신 실패 (DB_UNAVAILABLE)', '감독자 임대 갱신 실패 (DB_UNAVAILABLE)']);
  } finally { k.controller.abort(); await k.running; }
});
it('renews 700 seconds of progress while core ingestion drains and competing claims stay empty', async () => {
  const k = await kit();
  const checks = new Set([0, 300, 590, 650, 699]);
  for (let second = 0; second <= 700; second++) {
    if (second > 0) k.time.advance(1000);
    if (second % 10 === 0) { k.launcher.processes[0]!.push('{"abi":1,"type":"progress"}'); await flush(); }
    if (checks.has(second)) {
      const input = { now: k.time.clock.now(), claimedBy: 'other', kinds: ['process_probe'] };
      expect(await k.store.claimSupervisedWork({ ...input, attemptToken: k.idGen.next() })).toMatchObject({ ok: true, item: null });
      expect(await k.store.claimWork(input)).toMatchObject({ ok: true, item: null });
    }
    if (second === 650) {
      await k.store.addWork({ id: k.idGen.next(), kind: 'session_ingest', targetKind: 'session', targetId: 'test', createdAt: now, nextAttemptAt: now });
      const report = await drainQueue({ store: k.store, spool: memorySpool(), clock: k.time.clock, idGen: k.idGen }, { budgetMs: 1000, handlers: { session_ingest: async () => ({ ok: true }) } });
      expect(report.completed).toBe(1);
    }
  }
  k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit(); await flush();
  expect(k.store.snapshot().workItems[0]).toMatchObject({ completedAt: k.time.clock.now(), currentAttemptToken: null, attempts: 1 });
  expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'succeeded', finishedAt: k.time.clock.now() });
  k.controller.abort(); await k.running;
});
it.each(['missing result', 'nonzero exit'])('records %s as a permanent failed attempt', async failure => {
  const k = await kit();
  const child = k.launcher.processes[0]!;
  if (failure === 'nonzero exit') child.push('{"abi":1,"type":"result"}');
  child.exit(failure === 'nonzero exit' ? 2 : 0); await flush();
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('failed');
  expect(k.store.snapshot().workItems[0]).toMatchObject({ claimedBy: null, completedAt: now, outcome: 'failed' });
  expect(k.store.snapshot().failures).toHaveLength(1);
  k.controller.abort(); await k.running;
});
it('cleans a live child after an invalid ABI line and records a permanent failure', async () => {
  const k = await kit(); const child = k.launcher.processes[0]!;
  try {
    expect(child.ended).toBe(false);
    child.push('bad'); await flush(); await flush();
    expect(child.signals).toEqual(['SIGTERM']);
    expect(child.ended).toBe(true);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', finishedAt: now });
    expect(k.store.snapshot().workItems[0]).toMatchObject({
      currentAttemptToken: null, claimedBy: null, claimExpiresAt: null,
      completedAt: now, outcome: 'failed',
    });
  } finally { k.controller.abort(); await k.running; }
});
it('terminates and reaps on abort and returns the work', async () => {
  const k = await kit(); k.controller.abort(); await k.running;
  expect(k.launcher.processes[0]?.signals).toEqual(['SIGTERM']);
  expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('cancelled');
});
it('stale token renewal and finish leave both item and complete attempt history untouched', async () => {
  const store = memoryStore(); const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  const id = idGen.next(), a = idGen.next(), b = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  const claim = { now, claimedBy: idGen.next(), kinds: ['process_probe'] };
  await store.claimSupervisedWork({ ...claim, attemptToken: a });
  const later = new Date(now.getTime() + 600001);
  await store.settleSupervisedAttempt({ id, attemptToken: a, now: later, outcome: 'died' });
  await store.claimSupervisedWork({ ...claim, now: later, attemptToken: b });
  const before = store.snapshot();
  expect(await store.renewSupervisedLease({ id, attemptToken: a, now: later, progressAt: later })).toEqual({ ok: true, outcome: 'lost' });
  expect(await store.finishSupervisedWork({ id, attemptToken: a, now: later, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'lost' });
  expect(store.snapshot()).toEqual(before);
  expect(await store.finishSupervisedWork({ id, attemptToken: b, now: later, outcome: 'succeeded' })).toEqual({ ok: true, outcome: 'done' });
});

it('runs two keys at capacity and starts a third only when a slot frees', async () => {
  const k = await kit({ keys: ['one', 'two', 'three'] });
  try {
    expect(k.launcher.processes).toHaveLength(2);
    k.time.advance(5000); await flush();
    expect(k.launcher.processes).toHaveLength(2);
    k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit();
    await flush(); await flush();
    expect(k.launcher.processes).toHaveLength(3);
    expect(k.launcher.processes[1]!.ended).toBe(false);
    expect(k.store.snapshot().workAttempts.map(a => a.outcome)).toEqual(['succeeded', null, null]);
  } finally { k.controller.abort(); await k.running; }
});
it('same-key supervised work waits although capacity is free', async () => {
  const k = await kit({ keys: ['account', 'account'] });
  try {
    expect(k.launcher.processes).toHaveLength(1);
    k.time.advance(5000); await flush();
    expect(k.launcher.processes).toHaveLength(1);
    k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit();
    await flush(); await flush();
    expect(k.launcher.processes).toHaveLength(2);
  } finally { k.controller.abort(); await k.running; }
});
it('core drain completes while supervised capacity is full', async () => {
  const k = await kit({ keys: ['one', 'two'] });
  try {
    expect(k.launcher.processes).toHaveLength(2);
    await k.store.addWork({ id: k.idGen.next(), kind: 'session_ingest', targetKind: 'session', targetId: 'core', createdAt: now, nextAttemptAt: now });
    expect(await drainQueue({ store: k.store, spool: memorySpool(), clock: k.time.clock, idGen: k.idGen }, { budgetMs: 1000, handlers: { session_ingest: async () => ({ ok: true }) } })).toMatchObject({ completed: 1 });
    expect(k.launcher.processes.every(child => !child.ended)).toBe(true);
  } finally { k.controller.abort(); await k.running; }
});
it('abort cleans and settles every running child', async () => {
  const k = await kit({ keys: ['one', 'two', 'three'] });
  expect(k.launcher.processes).toHaveLength(2);
  k.controller.abort(); await k.running;
  expect(k.launcher.processes.map(child => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
  expect(k.store.snapshot().workAttempts.map(a => a.outcome)).toEqual(['cancelled', 'cancelled']);
  expect(k.store.snapshot().workItems.every(item => item.currentAttemptToken === null && item.claimedBy === null)).toBe(true);
});
it('one settlement failure does not stop the other running child', async () => {
  let failing = true;
  let first: string | undefined;
  const k = await kit({ keys: ['one', 'two', 'three'], configureStore(store) {
    const finish = store.finishSupervisedWork.bind(store);
    store.finishSupervisedWork = async input => {
      first ??= input.id;
      return failing && input.id === first ? { ok: false, code: 'DB_UNAVAILABLE', message: 'temporary' } : finish(input);
    };
  } });
  try {
    k.launcher.processes[0]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[0]!.exit(); await flush(); await flush();
    expect(k.launcher.processes).toHaveLength(2);
    k.launcher.processes[1]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[1]!.exit(); await flush(); await flush();
    expect(k.store.snapshot().workAttempts.map(a => a.outcome)).toEqual([null, 'succeeded']);
    expect(k.launcher.processes).toHaveLength(2);
    k.time.advance(5000); await flush();
    expect(k.launcher.processes).toHaveLength(2);
    failing = false; k.time.advance(5000); await flush(); await flush();
    expect(k.launcher.processes).toHaveLength(3);
    expect(k.store.snapshot().workAttempts[0]?.outcome).toBe('succeeded');
  } finally { failing = false; k.controller.abort(); await k.running; }
});

it('returns after abort even when settlement fails for both running children', async () => {
  const k = await kit({ keys: ['one', 'two'], configureStore(store) {
    store.settleSupervisedAttempt = async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: 'offline' });
  } });
  const before = k.store.snapshot().workItems.map(item => item.currentAttemptToken);
  expect(k.launcher.processes).toHaveLength(2);
  k.controller.abort();
  await k.running;
  expect(k.launcher.processes.map(child => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
  expect(k.store.snapshot().workItems.map(item => item.currentAttemptToken)).toEqual(before);
  expect(before.every(token => token !== null)).toBe(true);
  expect(k.store.snapshot().workAttempts).toHaveLength(2);
  for (const attempt of k.store.snapshot().workAttempts) expect(attempt).toMatchObject({ outcome: null, finishedAt: null });
});
it('settles both aborted children on the final retry after each token fails once', async () => {
  const calls = new Map<string, number>();
  const k = await kit({ keys: ['one', 'two'], configureStore(store) {
    const settle = store.settleSupervisedAttempt.bind(store);
    store.settleSupervisedAttempt = async input => {
      const count = (calls.get(input.attemptToken) ?? 0) + 1;
      calls.set(input.attemptToken, count);
      return count === 1 ? { ok: false, code: 'DB_UNAVAILABLE', message: 'offline' } : settle(input);
    };
  } });
  expect(k.launcher.processes).toHaveLength(2);
  const tokens = k.store.snapshot().workAttempts.map(attempt => attempt.token);
  k.controller.abort();
  await k.running;
  expect(tokens.map(token => calls.get(token))).toEqual([2, 2]);
  expect(k.launcher.processes.map(child => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
  expect(k.store.snapshot().workAttempts).toHaveLength(2);
  for (const attempt of k.store.snapshot().workAttempts) expect(attempt).toMatchObject({ outcome: 'cancelled', finishedAt: now });
  for (const item of k.store.snapshot().workItems) expect(item).toMatchObject({
    currentAttemptToken: null, claimedBy: null, claimedAt: null, claimExpiresAt: null,
  });
});
it('a new incarnation settles failed shutdown attempts and runs waiting work with the same keys', async () => {
  let failing = true;
  const k = await kit({ keys: ['one', 'two', 'one', 'two'], configureStore(store) {
    const settle = store.settleSupervisedAttempt.bind(store);
    store.settleSupervisedAttempt = async input => failing
      ? { ok: false, code: 'DB_UNAVAILABLE', message: 'offline' } : settle(input);
  } });
  const before = k.store.snapshot();
  const oldTokens = before.workAttempts.map(attempt => attempt.token);
  const waitingIds = before.workItems.slice(2).map(item => item.id);
  expect(k.launcher.processes).toHaveLength(2);
  k.controller.abort();
  await k.running;
  expect(k.launcher.processes.map(child => ({ ended: child.ended, signals: child.signals }))).toEqual([
    { ended: true, signals: ['SIGTERM'] }, { ended: true, signals: ['SIGTERM'] },
  ]);
  expect(k.store.snapshot().workItems.slice(0, 2).map(item => item.currentAttemptToken)).toEqual(oldTokens);
  expect(k.store.snapshot().workItems.slice(2).map(item => item.currentAttemptToken)).toEqual([null, null]);
  for (const attempt of k.store.snapshot().workAttempts) expect(attempt).toMatchObject({ outcome: null, finishedAt: null });

  failing = false;
  const controller = new AbortController();
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...k.store, ...memorySchemaStore({ version: 3 }) }, ...k.time,
    launcher: k.launcher, inspector: fakeProcessInspector(k.launcher), idGen: k.idGen,
    launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) }, signal: controller.signal });
  try {
    await flush(); await flush();
    const recovered = k.store.snapshot();
    expect(recovered.workAttempts).toHaveLength(4);
    for (const attempt of recovered.workAttempts.slice(0, 2)) expect(attempt).toMatchObject({ outcome: 'died', finishedAt: now });
    for (const item of recovered.workItems.slice(0, 2)) expect(item).toMatchObject({
      currentAttemptToken: null, claimedBy: null, claimedAt: null, claimExpiresAt: null,
    });
    expect(recovered.workAttempts.slice(2).map(attempt => attempt.workItemId)).toEqual(waitingIds);
    for (const attempt of recovered.workAttempts.slice(2)) {
      expect(attempt).toMatchObject({ outcome: null, finishedAt: null });
      expect(oldTokens).not.toContain(attempt.token);
      expect(attempt.incarnation).not.toBe(before.workAttempts[0]!.incarnation);
    }
    expect(k.launcher.processes).toHaveLength(4);
    expect(k.launcher.processes.slice(2).every(child => !child.ended)).toBe(true);
    expect(recovered.workItems.slice(2).map(item => item.serializationKey)).toEqual(['one', 'two']);
    expect(recovered.workItems.slice(2).map(item => item.currentAttemptToken)).toEqual(recovered.workAttempts.slice(2).map(attempt => attempt.token));
  } finally { controller.abort(); await running; }
});
it('logs a recurring claim error after an empty successful claim', async () => {
  const logs: string[] = [];
  let calls = 0;
  const k = await kit({ keys: [], log: message => { logs.push(message); }, configureStore(store) {
    store.claimSupervisedWork = async () => ++calls === 2 ? { ok: true, item: null, attemptToken: null }
      : { ok: false, code: 'DB_UNAVAILABLE', message: 'offline' };
  } });
  try {
    k.time.advance(5000); await flush();
    k.time.advance(5000); await flush();
    expect(calls).toBe(3);
    expect(logs).toEqual(['감독자 청구 실패 (DB_UNAVAILABLE)', '감독자 청구 실패 (DB_UNAVAILABLE)']);
  } finally { k.controller.abort(); await k.running; }
});

it.each(['throw', 'reject'] as const)('continues after log callbacks %s and claims later work', async mode => {
  let logs = 0;
  const k = await kit({ log: () => {
    logs++;
    if (mode === 'throw') throw new Error('log');
    return Promise.reject(new Error('log'));
  }, configureStore: store => {
    store.renewSupervisedLease = async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: 'log this failure' });
  } });
  try {
    const child = k.launcher.processes[0]!;
    child.push('{"abi":1,"type":"progress"}'); await flush();
    expect(logs).toBeGreaterThan(0);
    child.push('{"abi":1,"type":"result"}'); child.exit(); await flush();
    expect(k.store.snapshot().workItems[0]?.outcome).toBe('succeeded');
    await k.store.addWork({ id: k.idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: 'later', createdAt: now, nextAttemptAt: now });
    k.time.advance(5000); await flush();
    expect(k.launcher.processes).toHaveLength(2);
    k.launcher.processes[1]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[1]!.exit(); await flush();
    expect(k.store.snapshot().workItems.every(item => item.outcome === 'succeeded')).toBe(true);
  } finally { k.controller.abort(); await k.running; }
});

const missingSupervisorSchema = (options: Omit<Parameters<typeof runSupervisor>[0], 'schemaVersions'>): void => {
  // @ts-expect-error schema versions must be selected explicitly by the caller.
  void runSupervisor(options);
};
void missingSupervisorSchema;

it('protected preparation rejects missing snapshots before launching', async () => {
  const k = await kit({ protectedLaunches: { process_probe: { extension: 'testext', declarations: {}, errorCodes: [], async prepare() { return { ok: true, spec: { command: 'probe', args: [], env: {} } }; } } } });
  try {
    expect(k.launcher.specs).toEqual([]);
    expect(k.store.snapshot().workItems[0]).toMatchObject({ outcome: 'failed' });
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ errorCode: 'EXTENSION_CONFIG_INVALID', errorRetryable: false });
  } finally { k.controller.abort(); await k.running; }
});
it('protected runs discard arbitrary worker diagnostics before persistence', async () => {
  const secret = 'SYNTHETIC_SECRET_ABC';
  const k = await kit({ protectedLaunches: { process_probe: { extension: 'testext', declarations: {}, errorCodes: [], async prepare(item, token) { return { ok: true, spec: { command: 'probe', args: [], env: { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId, BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: '{"version":1,"extension":"testext","values":{}}' } } }; } } } });
  try {
    const child = k.launcher.processes[0]!;
    child.writeStderr(secret);
    child.push(JSON.stringify({ abi: 1, type: 'error', code: secret, retryable: false, message: secret }));
    child.exit(); await flush();
    const facts = JSON.stringify(k.store.snapshot());
    expect(facts).not.toContain(secret);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ errorCode: 'EXTENSION_WORKER_ERROR', errorRetryable: false, stderr: null });
  } finally { k.controller.abort(); await k.running; }
});

it.each(['cancel', 'hold', 'lost'] as const)('does not launch when ownership changes during preparation: %s', async mode => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let lose = false;
  const k = await kit({ holdGroup: 'extension:testext', configureStore: store => {
    const list = store.listOpenSupervisedAttempts;
    store.listOpenSupervisedAttempts = async () => lose ? { ok: true, attempts: [] } : list();
  }, protectedLaunches: { process_probe: { extension: 'testext', declarations: {}, errorCodes: [], async prepare(item, token) {
    await gate;
    return { ok: true, spec: { command: 'probe', args: [], env: { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId, BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: '{"version":1,"extension":"testext","values":{}}' } } };
  } } } });
  try {
    if (mode === 'cancel') await k.store.requestWorkCancel({ id: k.id, now });
    if (mode === 'hold') await k.store.holdWorkGroup({ group: 'extension:testext', now });
    if (mode === 'lost') lose = true;
    release(); await flush();
    expect(k.launcher.specs).toEqual([]);
  } finally { release(); k.controller.abort(); await k.running; }
});

it('prepares a new immutable snapshot for each retry', async () => {
  let value = 'first';
  const k = await kit({ protectedLaunches: { process_probe: { extension: 'testext', declarations: { 'testext.value': 'string' }, errorCodes: ['TEMPORARY'], async prepare(item, token) {
    return { ok: true, spec: { command: 'probe', args: [], env: { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId, BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: JSON.stringify({ version: 1, extension: 'testext', values: { 'testext.value': value } }) } } };
  } } } });
  try {
    expect(JSON.parse(k.launcher.specs[0]!.env.BRAIN_SETTINGS_SNAPSHOT!).values['testext.value']).toBe('first');
    value = 'second';
    k.launcher.processes[0]!.push('{"abi":1,"type":"error","code":"TEMPORARY","retryable":true}'); k.launcher.processes[0]!.exit(); await flush();
    k.time.advance(900_000); await flush();
    expect(JSON.parse(k.launcher.specs[1]!.env.BRAIN_SETTINGS_SNAPSHOT!).values['testext.value']).toBe('second');
    k.launcher.processes[1]!.push('{"abi":1,"type":"result"}'); k.launcher.processes[1]!.exit(); await flush();
  } finally { k.controller.abort(); await k.running; }
});

it('rejects a syntactically valid snapshot missing a required key before start', async () => {
  const k = await kit({ protectedLaunches: { process_probe: { extension: 'testext', declarations: { 'testext.token': 'string' }, required: ['testext.token'], secrets: ['testext.token'], errorCodes: [], async prepare(item, token) { return { ok: true, spec: { command: 'probe', args: [], env: { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId, BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: '{"version":1,"extension":"testext","values":{}}' } } }; } } } });
  try { expect(k.launcher.specs).toEqual([]); expect(k.store.snapshot().workAttempts[0]).toMatchObject({ errorCode: 'EXTENSION_CONFIG_INVALID', errorRetryable: false }); }
  finally { k.controller.abort(); await k.running; }
});

it.each(['PROCESS_DIED', 'ABI_EXIT_FAILED'] as const)('projects undeclared worker error %s without changing retryability', async code => {
  const k = await kit({ protectedLaunches: { process_probe: { extension: 'testext', declarations: {}, errorCodes: [], async prepare(item, token) { return { ok: true, spec: { command: 'probe', args: [], env: { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://localhost/brain', BRAIN_WORK_ID: item.id, BRAIN_ATTEMPT_TOKEN: token, BRAIN_WORK_KIND: item.kind, BRAIN_TARGET_KIND: item.targetKind, BRAIN_TARGET_ID: item.targetId, BRAIN_RUN_GENERATION: String(item.attempts), BRAIN_SETTINGS_SNAPSHOT: '{"version":1,"extension":"testext","values":{}}' } } }; } } } });
  try {
    k.launcher.processes[0]!.push(JSON.stringify({ abi: 1, type: 'error', code, retryable: true })); k.launcher.processes[0]!.exit(); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ errorCode: 'EXTENSION_WORKER_ERROR', errorRetryable: true });
  } finally { k.controller.abort(); await k.running; }
});
