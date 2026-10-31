import { expect, it } from 'vitest';
import { runSupervisor } from '../src/queue/supervisor.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
import { manualTime } from '../src/testing/fakes/clock.js';
import { fakeProcessInspector, fakeProcessLauncher } from '../src/testing/fakes/process.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import type { ChannelAttemptResult } from '../src/channels/store.js';

const now = new Date('2026-10-31T00:00:00Z');
const flush = async () => { for (let i = 0; i < 200; i++) await Promise.resolve(); };
async function fixture(count: number, holdGroup?: string) {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  await store.ensureChannel({ id: 'channel', kind: 'telegram', botRef: 'bot' });
  await store.ensureChannelConversation({ id: 'conversation', channelId: 'channel', externalRef: 'chat', threadRef: null });
  await store.createChannelRequest({ id: 'request', conversationId: 'conversation', producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
  if (holdGroup) await store.addWork({ id: 'work', kind: 'channel_send', targetKind: 'channel_request', targetId: 'request', holdGroup, createdAt: now, nextAttemptAt: now });
  await store.handoffChannelRequest({ requestId: 'request', workId: 'work', now });
  for (let n = 1; n < count; n++) {
    const attemptToken = idGen.next(); await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['channel_send'], attemptToken });
    await store.finishSupervisedWork({ id: 'work', attemptToken, now, outcome: 'failed', nextAttemptAt: now });
  }
  const controller = new AbortController();
  const inspector = fakeProcessInspector(launcher);
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher, inspector, idGen, signal: controller.signal, pollMs: 10, cancelPollMs: 10, launches: { channel_send: () => ({ command: 'worker', args: [], env: {} }) } });
  await flush();
  const token = store.snapshot().workItems[0]!.currentAttemptToken!;
  const attempt = { requestId: 'request', workItemId: 'work', attemptToken: token, now };
  expect(await store.gateChannelAttempt(attempt)).toEqual({ ok: true, outcome: 'won' });
  return { store, launcher, inspector, time, idGen, attempt, controller, running, async stop() { controller.abort(); await running; } };
}
it.each([
  ['열 번째 저장 성공', 10, { outcome: 'sent', externalMessageId: '42' }, 'succeeded'],
  ['첫 영구 실패', 1, { outcome: 'definite_failed', code: 'http_4xx', retryable: false }, 'failed'],
  ['열 번째 미확정', 10, null, 'failed'],
] as const)('%s은 ABI 출력 전 종료되어도 저장 결과로 정산한다', async (_name, count, result, outcome) => {
  const f = await fixture(count);
  try {
    if (result) expect(await f.store.finishChannelAttempt({ ...f.attempt, result: result as ChannelAttemptResult })).toMatchObject({ outcome: 'done' });
    f.launcher.processes[0]!.exit(null, 'SIGKILL'); await flush();
    expect(f.store.snapshot().workItems[0]).toMatchObject({ outcome, attempts: count });
    const saved = f.store.snapshot().failures;
    expect(saved).toHaveLength(outcome === 'failed' ? 1 : 0);
    if (result === null) expect(await f.store.recoverChannelAttempt(f.attempt)).toEqual({ ok: true, outcome: 'lost' });
    expect(f.launcher.processes).toHaveLength(1);
  } finally { await f.stop(); }
});
it.each([
  ['열 번째 저장 성공', 10, { outcome: 'sent', externalMessageId: '42' }, 'succeeded'],
  ['첫 영구 실패', 1, { outcome: 'definite_failed', code: 'http_4xx', retryable: false }, 'failed'],
  ['열 번째 미확정', 10, null, 'failed'],
] as const)('감독자 재시작은 %s을 저장 결과로 정산한다', async (_name, count, result, outcome) => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  await store.ensureChannel({ id: 'channel', kind: 'telegram', botRef: 'bot' });
  await store.ensureChannelConversation({ id: 'conversation', channelId: 'channel', externalRef: 'chat', threadRef: null });
  await store.createChannelRequest({ id: 'request', conversationId: 'conversation', producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
  await store.handoffChannelRequest({ requestId: 'request', workId: 'work', now });
  for (let n = 1; n <= count; n++) {
    const token = idGen.next(); await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['channel_send'], attemptToken: token });
    if (n < count) await store.finishSupervisedWork({ id: 'work', attemptToken: token, now, outcome: 'failed', nextAttemptAt: now });
    else {
      const attempt = { requestId: 'request', workItemId: 'work', attemptToken: token, now };
      await store.gateChannelAttempt(attempt);
      if (result) await store.finishChannelAttempt({ ...attempt, result: result as ChannelAttemptResult });
    }
  }
  const controller = new AbortController();
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher, inspector: fakeProcessInspector(launcher), idGen, signal: controller.signal, launches: {} });
  try { await flush(); expect(store.snapshot().workItems[0]).toMatchObject({ outcome, attempts: count }); expect(store.snapshot().failures).toHaveLength(outcome === 'failed' ? 1 : 0); expect(launcher.processes).toHaveLength(0); }
  finally { controller.abort(); await running; }
});
it('프로세스 미확인으로 보류한 토큰은 이후 종료가 확인되면 정산한다', async () => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  await store.ensureChannel({ id: 'channel', kind: 'telegram', botRef: 'bot' });
  await store.ensureChannelConversation({ id: 'conversation', channelId: 'channel', externalRef: 'chat', threadRef: null });
  await store.createChannelRequest({ id: 'request', conversationId: 'conversation', producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
  await store.handoffChannelRequest({ requestId: 'request', workId: 'work', now });
  const token = idGen.next(); await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['channel_send'], attemptToken: token });
  await store.gateChannelAttempt({ requestId: 'request', workItemId: 'work', attemptToken: token, now });
  await store.settleSupervisedAttempt({ id: 'work', attemptToken: token, now, outcome: 'unknown' });
  const controller = new AbortController();
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher, inspector: fakeProcessInspector(launcher), idGen, signal: controller.signal, launches: {} });
  try {
    await flush();
    expect(store.snapshot().workItems[0]).toMatchObject({ currentAttemptToken: null, completedAt: null, nextAttemptAt: new Date(now.getTime() + 1000) });
    expect(store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'died', finishedAt: now });
  } finally { controller.abort(); await running; }
});
it('종료가 확인되지 않은 프로세스는 토큰을 보존하며 이후 다시 확인한다', async () => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const idGen = sequenceIdGen({ timestampMs: now.getTime() });
  await store.ensureChannel({ id: 'channel', kind: 'telegram', botRef: 'bot' });
  await store.ensureChannelConversation({ id: 'conversation', channelId: 'channel', externalRef: 'chat', threadRef: null });
  await store.createChannelRequest({ id: 'request', conversationId: 'conversation', producer: 'test', producerResultId: 'result', purpose: 'notice', revision: null, text: 'text', createdAt: now });
  await store.handoffChannelRequest({ requestId: 'request', workId: 'work', now });
  const token = idGen.next(); await store.claimSupervisedWork({ now, claimedBy: 'old', kinds: ['channel_send'], attemptToken: token });
  await store.gateChannelAttempt({ requestId: 'request', workItemId: 'work', attemptToken: token, now });
  await store.recordSupervisedProcess({ id: 'work', attemptToken: token, pid: 123, pgid: 123, osBootAt: now, osStartedAt: now });
  inspector.boot = { state: 'found', value: now };
  inspector.groups.set(123, { state: 'unknown' });
  const controller = new AbortController();
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher, inspector, idGen, signal: controller.signal, launches: {}, pollMs: 10 });
  try {
    await flush(); expect(store.snapshot().workItems[0]?.currentAttemptToken).toBe(token);
    expect(store.snapshot().workAttempts[0]?.outcome).toBe('unknown');
    inspector.groups.set(123, { state: 'none' }); time.advance(10); await flush();
    expect(store.snapshot().workItems[0]?.currentAttemptToken).toBeNull();
    expect(store.snapshot().workAttempts[0]?.outcome).toBe('died');
  } finally { controller.abort(); await running; }
});
it('현재 감독자의 미확인 worker만 재검사하고 다른 실행은 유지한다', async () => {
  const f = await fixture(1);
  try {
    await f.store.createChannelRequest({ id: 'request2', conversationId: 'conversation', producer: 'test', producerResultId: 'result2', purpose: 'notice', revision: null, text: 'text', createdAt: now });
    await f.store.handoffChannelRequest({ requestId: 'request2', workId: 'work2', now });
    f.time.advance(10); await flush(); expect(f.launcher.processes).toHaveLength(2);
    const first = f.launcher.processes[0]!, second = f.launcher.processes[1]!;
    f.inspector.groups.set(first.pid, { state: 'unknown' }); first.exit(null, 'SIGKILL'); await flush();
    expect(f.store.snapshot().workAttempts.find(a => a.token === f.attempt.attemptToken)?.outcome).toBe('unknown');
    expect(second.ended).toBe(false); expect(second.signals).toEqual([]);
    f.inspector.groups.set(first.pid, { state: 'none' }); f.time.advance(10); await flush();
    expect(f.store.snapshot().workAttempts.find(a => a.token === f.attempt.attemptToken)?.outcome).toBe('died');
    expect(f.store.snapshot().workItems.find(w => w.id === 'work')?.currentAttemptToken).toBeNull();
    expect(second.ended).toBe(false); expect(second.signals).toEqual([]); expect(f.launcher.processes).toHaveLength(2);
  } finally { await f.stop(); }
});

it.each(['shutdown', 'hold'] as const)('%s 중 저장 실패의 영구성·대기·소진을 보존한다', async mode => {
  for (const scenario of ['permanent', 'rate_limit', 'tenth_unknown'] as const) {
    const f = await fixture(scenario === 'tenth_unknown' ? 10 : 1, mode === 'hold' ? 'channel-test' : undefined);
    try {
      const result: ChannelAttemptResult | null = scenario === 'permanent' ? { outcome: 'definite_failed', code: 'http_4xx', retryable: false } :
        scenario === 'rate_limit' ? { outcome: 'definite_failed', code: 'http_429', retryable: true, retryAfterMs: 7000 } : null;
      if (result) await f.store.finishChannelAttempt({ ...f.attempt, result });
      if (mode === 'shutdown') { f.controller.abort(); await f.running; }
      else { await f.store.holdWorkGroup({ group: 'channel-test', now }); f.time.advance(10); await flush(); }
      const item = f.store.snapshot().workItems.find(w => w.id === 'work')!;
      expect(item.attempts).toBe(scenario === 'tenth_unknown' ? 10 : 1);
      if (scenario === 'rate_limit') { expect(item.outcome).toBeNull(); expect(item.nextAttemptAt).toEqual(new Date(now.getTime() + (mode === 'hold' ? 7010 : 7000))); }
      else { expect(item.outcome).toBe('failed'); expect(f.store.snapshot().failures).toHaveLength(1); }
      if (mode === 'hold') { await f.store.releaseWorkGroup({ group: 'channel-test' }); f.time.advance(1000); await flush(); expect(f.launcher.processes).toHaveLength(1); }
    } finally { await f.stop(); }
  }
});
it('명시적 일감 취소는 저장된 실패가 있어도 취소로 닫힌다', async () => {
  const f = await fixture(1);
  try {
    await f.store.finishChannelAttempt({ ...f.attempt, result: { outcome: 'definite_failed', code: 'http_4xx', retryable: false } });
    await f.store.requestWorkCancel({ id: 'work', now }); f.time.advance(10); await flush();
    expect(f.store.snapshot().workItems[0]).toMatchObject({ outcome: 'cancelled', attempts: 1 });
    expect(f.store.snapshot().failures).toHaveLength(0);
  } finally { await f.stop(); }
});
