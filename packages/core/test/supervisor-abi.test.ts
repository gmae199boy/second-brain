import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { runSupervisor } from '../src/queue/supervisor.js';
import { PROCESS_ABI_RUN_FIXTURES_URL } from '../src/process-abi/codec.js';
import { manualTime } from '../src/testing/fakes/clock.js';
import { fakeProcessLauncher, fakeProcessInspector } from '../src/testing/fakes/process.js';
import { memoryStore } from '../src/testing/fakes/store.js';
import { memorySchemaStore } from '../src/testing/fakes/schema-store.js';
import { sequenceIdGen } from '../src/testing/fakes/id-gen.js';
import type { ProcessLauncher, ProcessSpec } from '../src/ports/process.js';
const now = new Date('2026-10-29T00:00:00Z');
const flush = async () => { for (let i = 0; i < 150; i++) await Promise.resolve(); };
async function kit(options: { launcher?: ProcessLauncher; spec?: ProcessSpec | null } = {}) {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), controller = new AbortController();
  const idGen = sequenceIdGen({ timestampMs: now.getTime() }); const id = idGen.next();
  await store.addWork({ id, kind: 'process_probe', targetKind: 'probe', targetId: '10', createdAt: now, nextAttemptAt: now });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher: options.launcher ?? launcher, inspector: fakeProcessInspector(launcher), idGen, signal: controller.signal,
    launches: { process_probe: () => options.spec === undefined ? { command: 'probe', args: [], env: {} } : options.spec } });
  await flush();
  return { store, time, launcher, controller, running, stop: async () => { controller.abort(); await running; } };
}
it('persists every run fixture verdict and usage and applies the work failure policy', async () => {
  const fixtures = JSON.parse(await readFile(PROCESS_ABI_RUN_FIXTURES_URL, 'utf8'));
  for (const fixture of fixtures) {
    const k = await kit();
    try {
      const child = k.launcher.processes[0]!;
      child.writeStderr('diagnostic\n');
      for (const part of fixture.stdout) child.write(typeof part === 'string' ? part : part.repeat.repeat(part.count));
      k.time.advance(250); child.exit(fixture.exit.code, fixture.exit.signal); await flush();
      const attempt = k.store.snapshot().workAttempts[0]!;
      const died = fixture.expect.code === 'ABI_EXIT_FAILED' && fixture.exit.signal !== null;
      expect(attempt, fixture.name).toMatchObject({ outcome: died ? 'died' : fixture.expect.outcome, errorCode: died ? null : fixture.expect.code ?? null,
        errorRetryable: died ? null : fixture.expect.retryable ?? null, elapsedMs: 250, stderr: 'diagnostic\n',
        inputTokens: fixture.expect.usage?.input_tokens ?? null, cachedInputTokens: fixture.expect.usage?.cached_input_tokens ?? null, outputTokens: fixture.expect.usage?.output_tokens ?? null });
      const item = k.store.snapshot().workItems[0]!;
      if (fixture.expect.outcome === 'failed') {
        expect(item.lastError, fixture.name).toContain(died ? 'PROCESS_DIED' : fixture.expect.code);
        if (fixture.expect.retryable) expect(item.nextAttemptAt).toEqual(new Date(now.getTime() + 900_250));
        else expect(item).toMatchObject({ completedAt: new Date(now.getTime() + 250), outcome: 'failed' });
      } else expect(item.completedAt).toEqual(new Date(now.getTime() + 250));
      expect(k.store.snapshot().failures).toHaveLength(fixture.expect.outcome === 'failed' && !fixture.expect.retryable ? 1 : 0);
    } finally { await k.stop(); }
  }
});
it.each(['missing spec', 'spawn failure', 'spawn rejection'])('records PROCESS_START_FAILED for %s', async mode => {
  const k = await kit(mode === 'missing spec' ? { spec: null } : { launcher: { async start() { if (mode === 'spawn rejection') throw new Error('spawn'); return { ok: false, message: '시작 실패' }; } } });
  try { expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'PROCESS_START_FAILED', errorRetryable: true, elapsedMs: 0, stderr: null }); }
  finally { await k.stop(); }
});
it('cleans immediately on an oversized fragment before EOF', async () => {
  const k = await kit();
  try {
    k.launcher.processes[0]!.write('x'.repeat(65537)); await flush();
    expect(k.launcher.processes[0]!.signals).toEqual(['SIGTERM']);
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'ABI_LINE_TOO_LONG' });
  } finally { await k.stop(); }
});
it('cleans a still-live child when stdout closes with a truncated line', async () => {
  const base = fakeProcessLauncher();
  const launcher: ProcessLauncher = { async start(spec) {
    const launched = await base.start(spec);
    if (launched.ok) launched.handle.stdout = { async *[Symbol.asyncIterator]() { yield '{'; } };
    return launched;
  } };
  const store = memoryStore(), time = manualTime(now), controller = new AbortController(), idGen = sequenceIdGen({ timestampMs: now.getTime() });
  await store.addWork({ id: idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher, inspector: fakeProcessInspector(base), idGen, signal: controller.signal, launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) } });
  try {
    await flush();
    expect(base.processes[0]!.signals).toEqual(['SIGTERM']);
    expect(store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'ABI_LINE_TRUNCATED', errorRetryable: true });
  } finally { controller.abort(); await running; }
});
it('records output exceptions as ABI_OUTPUT_UNREADABLE', async () => {
  const base = fakeProcessLauncher();
  const k = await kit({ launcher: { async start(spec) {
    const started = await base.start(spec);
    if (started.ok) started.handle.stdout = { async *[Symbol.asyncIterator]() { throw new Error('pipe failure'); } };
    return started;
  } } });
  // The fake inspector needs to observe this launcher's process as well.
  base.processes[0]!.exit(); await flush();
  try { expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'failed', errorCode: 'ABI_OUTPUT_UNREADABLE', errorRetryable: true }); }
  finally { await k.stop(); }
});
it('masks and bounds stderr while discarding a cut first line', async () => {
  const k = await kit();
  try {
    const child = k.launcher.processes[0]!;
    child.writeStderr('x'.repeat(20000) + '\nTOKEN=secret-value\n' + '한😀\n'.repeat(1200));
    child.push('{"abi":1,"type":"result"}'); child.exit(); await flush();
    const stderr = k.store.snapshot().workAttempts[0]!.stderr!;
    expect(Buffer.byteLength(stderr)).toBeLessThanOrEqual(4096); expect(stderr).not.toContain('secret-value');
    expect(stderr).not.toContain('x'); expect(stderr).not.toContain('\ufffd');
  } finally { await k.stop(); }
});
it('persists cancellation elapsed time and masked stderr', async () => {
  const k = await kit();
  k.launcher.processes[0]!.writeStderr('TOKEN=secret-value\n'); await flush(); k.time.advance(50); await k.stop();
  expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'cancelled', elapsedMs: 50 });
  expect(k.store.snapshot().workAttempts[0]!.stderr).not.toContain('secret-value');
});
it('does not renew for heartbeat or progress after a final event', async () => {
  const k = await kit();
  try {
    const child = k.launcher.processes[0]!;
    child.push('{"abi":1,"type":"result"}'); await flush(); k.time.advance(60_000);
    child.push('{"abi":1,"type":"heartbeat"}'); child.push('{"abi":1,"type":"progress"}'); await flush();
    expect(k.store.snapshot().workAttempts[0]!.renewedAt).toEqual(now); child.exit(); await flush();
  } finally { await k.stop(); }
});
it.each([['identity', 100], ['recording', 100], ['identity', 1100], ['recording', 1100]] as const)('consumes %s-delayed stderr through %i chunks', async (delayed, chunks) => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const controller = new AbortController(), idGen = sequenceIdGen({ timestampMs: now.getTime() });
  let release!: () => void, consumed = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  if (delayed === 'identity') {
    const startedAt = inspector.startedAt.bind(inspector);
    inspector.startedAt = async pid => { await gate; return startedAt(pid); };
  } else {
    const record = store.recordSupervisedProcess.bind(store);
    store.recordSupervisedProcess = async input => { await gate; return record(input); };
  }
  await store.addWork({ id: idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, inspector, idGen, signal: controller.signal,
    launcher: { async start(spec) {
      const started = await launcher.start(spec);
      if (started.ok) {
        const stderr = started.handle.stderr;
        started.handle.stderr = { async *[Symbol.asyncIterator]() { for await (const chunk of stderr) { consumed++; yield chunk; } } };
      }
      return started;
    } }, launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) } });
  try {
    await flush(); const child = launcher.processes[0]!;
    for (let i = 0; i < chunks; i++) child.writeStderr('x'.repeat(1000) + '\n');
    child.writeStderr('TOKEN=secret-value\nlast diagnostic\n');
    await expect.poll(() => consumed).toBe(chunks + 1);
    expect(store.snapshot().workAttempts[0]!.outcome).toBeNull();
    release(); await flush(); child.push('{"abi":1,"type":"result"}'); child.exit(); await flush();
    const attempt = store.snapshot().workAttempts[0]!;
    expect(attempt.outcome).toBe('succeeded');
    if (chunks === 1100) expect(attempt.stderr).toBe('[stderr 생략: 원문 1 MiB 초과]');
    else expect(attempt.stderr).toContain('last diagnostic\n');
    expect(attempt.stderr).not.toContain('secret-value');
    expect(Buffer.byteLength(attempt.stderr!)).toBeLessThanOrEqual(4096);
  } finally { release(); controller.abort(); await running; }
});
it('drains queued stderr before unknown settlement and retains the full masked tail', async () => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const controller = new AbortController(), idGen = sequenceIdGen({ timestampMs: now.getTime() });
  inspector.groupMembers = async () => ({ state: 'unknown' });
  await store.addWork({ id: idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  let closed = false, consumed = 0;
  const running = runSupervisor({ schemaVersions: { core: 3 }, store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, inspector, idGen, signal: controller.signal,
    launcher: { async start(spec) {
      const started = await launcher.start(spec);
      if (started.ok) {
        let release!: () => void;
        const outputClosed = new Promise<void>(resolve => { release = resolve; });
        const close = started.handle.closeOutput.bind(started.handle);
        started.handle.closeOutput = () => { closed = true; close(); release(); };
        started.handle.stderr = { async *[Symbol.asyncIterator]() {
          await outputClosed;
          for (const chunk of ['first diagnostic\n', 'TOKEN=\n\nsecret-value\n', 'last diagnostic\n-----BEGIN PRIVATE KEY-----\nSyntheticPemBody']) { consumed++; yield chunk; }
        } };
        started.handle.stdout = { async *[Symbol.asyncIterator]() { await outputClosed; } };
        launcher.processes[0]!.exit();
      }
      return started;
    } }, launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) } });
  try {
    await flush();
    expect(closed).toBe(true); expect(consumed).toBe(3);
    const attempt = store.snapshot().workAttempts[0]!;
    expect(attempt.outcome).toBe('unknown');
    expect(attempt.stderr).toContain('first diagnostic\n'); expect(attempt.stderr).toContain('last diagnostic\n');
    expect(attempt.stderr).not.toContain('secret-value');
    expect(attempt.stderr).toContain('[REDACTED:private_key]');
    expect(attempt.stderr).not.toContain('SyntheticPemBody');
    expect(inspector.signals).toEqual([]);
    expect(store.snapshot().workItems[0]!.currentAttemptToken).toBe(attempt.token);
  } finally { controller.abort(); await running; }
});

it.each(['closed PEM', 'unterminated PEM', 'oversized line'])('persists masked stderr for %s', async mode => {
  const k = await kit();
  try {
    const child = k.launcher.processes[0]!;
    const body = ('SyntheticPemBody_' + 'Q'.repeat(64) + '\n').repeat(85);
    const raw = mode === 'oversized line' ? 'TOKEN=' + 'x'.repeat(70000) :
      '-----BEGIN RSA PRIVATE KEY-----\n' + body + (mode === 'closed PEM' ? '-----END RSA PRIVATE KEY-----\nTOKEN=' + 'a'.repeat(14500) + '\n' : 'last-secret-fragment');
    for (let i = 0; i < raw.length; i += 97) child.writeStderr(raw.slice(i, i + 97));
    child.push('{"abi":1,"type":"result"}'); child.exit(); await flush();
    await expect.poll(() => k.store.snapshot().workAttempts[0]!.outcome).toBe('succeeded');
    const attempt = k.store.snapshot().workAttempts[0]!;
    expect(attempt.stderr).toBe(mode === 'closed PEM' ? '[REDACTED:private_key]\nTOKEN=[REDACTED:password]\n' :
      mode === 'unterminated PEM' ? '[REDACTED:private_key]' : 'TOKEN=[REDACTED:password]');
    expect(Buffer.byteLength(attempt.stderr!)).toBeLessThanOrEqual(4096);
  } finally { await k.stop(); }
});

it.each(['succeeded', 'failed', 'cancelled'])('persists whole-context masked stderr on %s settlement', async outcome => {
  const k = await kit();
  try {
    const child = k.launcher.processes[0]!;
    for (const chunk of ['TOKEN\n\n=\n\n', 'SyntheticSecret123\n', '-----BEGIN PRIVATE KEY-----\n', 'SyntheticPemBody']) child.writeStderr(chunk);
    await flush();
    if (outcome === 'cancelled') await k.stop();
    else { child.write(outcome === 'failed' ? '{' : '{"abi":1,"type":"result"}\n'); child.exit(); await flush(); }
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome, stderr: 'TOKEN\n\n=\n\n[REDACTED:password]\n[REDACTED:private_key]' });
  } finally { await k.stop(); }
});
it.each([1048576, 1048577])('persists the stderr raw cap verdict for %i bytes and continues consuming', async bytes => {
  const k = await kit();
  try {
    const child = k.launcher.processes[0]!;
    child.writeStderr('x'.repeat(bytes - 18) + '\nTOKEN=secret-end\n');
    child.push('{"abi":1,"type":"result"}'); child.exit(); await flush();
    expect(k.store.snapshot().workAttempts[0]).toMatchObject({ outcome: 'succeeded',
      stderr: bytes === 1048576 ? 'TOKEN=[REDACTED:password]\n' : '[stderr 생략: 원문 1 MiB 초과]' });
  } finally { await k.stop(); }
});

it('retains only the explicitly allowed Garmin result fields', async () => {
  const { publicCollectSummary } = await import('../src/queue/supervisor.js');
  const valid={status:'success',cutoff_ms:123,local_date:'2026-01-01',normalized:1,normalize_failed:0,timezone:'Asia/Seoul',snapshot_id:'00000000-0000-4000-8000-000000000001'};
  expect(publicCollectSummary('garmin.collect',JSON.stringify(valid))).toEqual(valid);
  expect(publicCollectSummary('garmin.collect',JSON.stringify({...valid,health:80}))).toBeUndefined();
  expect(publicCollectSummary('garmin.collect',JSON.stringify({...valid,cutoff_ms:-1}))).toBeUndefined();
  expect(publicCollectSummary('other.work',JSON.stringify(valid))).toBeUndefined();
  expect(publicCollectSummary('garmin.artifacts',JSON.stringify({status:'success',request_id:valid.snapshot_id,revision:'a'.repeat(64)}))).toBeDefined();
  const artifact={status:'success',request_id:valid.snapshot_id,revision:'a'.repeat(64)};
  const graphs={graphs_registered:1,graphs_skipped:2,graphs_failed:1,graphs_failed_names:'52-heart-30d.png'};
  expect(publicCollectSummary('garmin.artifacts',JSON.stringify({...artifact,...graphs}))).toEqual({...artifact,...graphs});
  expect(publicCollectSummary('garmin.artifacts',JSON.stringify({...artifact,...graphs,graphs_failed:0,graphs_failed_names:''}))).toBeDefined();
  for (const invalid of [{...graphs,extra:1}, {...graphs,graphs_registered:-1}, {...graphs,graphs_skipped:61}, {...graphs,graphs_failed_names:'../secret.png'}, {...graphs,graphs_failed:2,graphs_failed_names:'01-x.png,01-x.png'}, {...graphs,graphs_registered:60}, {...graphs,graphs_failed:2}, {...graphs,graphs_failed_names:'x'.repeat(1201)}]) {
    expect(publicCollectSummary('garmin.artifacts',JSON.stringify({...artifact,...invalid}))).toBeUndefined();
  }
  expect(publicCollectSummary('garmin.artifacts',JSON.stringify({...artifact,graphs_failed:0}))).toBeUndefined();
  expect(publicCollectSummary('garmin.collect',JSON.stringify({...valid,...graphs}))).toBeUndefined();
});

it('allows only bounded, generic status and integer counts for public result summaries', async () => {
  const { publicCollectSummary } = await import('../src/queue/supervisor.js');
  for (const status of ['success', 'partial', 'blocked', 'auth_required', 'error', 'noop']) {
    const value = {status, runs: 1, errors: 0};
    expect(publicCollectSummary('example.work', JSON.stringify(value))).toEqual(value);
  }
  for (const value of [
    {status:'private',runs:1,errors:0}, {status:'success',runs:1,errors:0,secret:'x'},
    {status:'success',runs:-1,errors:0}, {status:'success',runs:1.5,errors:0},
    {status:'success',runs:Number.MAX_SAFE_INTEGER+1,errors:0},
    {status:'success',runs:1,errors:'0'}, {status:['success'],runs:1,errors:0},
    {status:'success',runs:1}, {status:'success',runs:1,errors:null},
  ]) expect(publicCollectSummary('example.work', JSON.stringify(value))).toBeUndefined();
  expect(publicCollectSummary('example.work', '{broken')).toBeUndefined();
  expect(publicCollectSummary('example.work', 'x'.repeat(2049))).toBeUndefined();
});

it('수집 backlog는 고정 상태와 명시한 비음수 정수만 공개하고 기존 요약을 보존한다', async () => {
  const {publicCollectSummary}=await import('../src/queue/supervisor.js');
  const value={status:'success',runs:1,errors:0,execution_status:'success',backlog_status:'partial',
    remaining_endpoints:12,remaining_activities:2,remaining_dates:4,unplannable:0,
    deferred_dates:1,deferred_endpoints:3,deferred_first_call:2};
  expect(publicCollectSummary('garmin.collect',JSON.stringify(value))).toEqual(value);
  expect(publicCollectSummary('garmin.collect',JSON.stringify({status:'success',runs:1,errors:0}))).toEqual({status:'success',runs:1,errors:0});
  for(const change of [{health:80},{raw:'private'},{remaining_endpoints:-1},{remaining_dates:'4'},
    {remaining_dates:0.5},{deferred_first_call:true},{runs:-1},{errors:'0'},
    {status:'unknown'},{execution_status:'error'},{backlog_status:'unknown'},{backlog_status:['partial']}])
    expect(publicCollectSummary('garmin.collect',JSON.stringify({...value,...change}))).toBeUndefined();
  const {deferred_dates:removed,...missing}=value;
  expect(removed).toBe(1);
  expect(publicCollectSummary('garmin.collect',JSON.stringify(missing))).toBeUndefined();
  expect(publicCollectSummary('other.work',JSON.stringify(value))).toBeUndefined();
});
