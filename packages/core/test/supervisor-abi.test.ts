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
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time,
    launcher: options.launcher ?? launcher, inspector: fakeProcessInspector(launcher), idGen, signal: controller.signal,
    launches: { process_probe: () => options.spec === undefined ? { command: 'probe', args: [], env: {} } : options.spec } });
  await flush();
  return { store, time, launcher, controller, running, stop: async () => { controller.abort(); await running; } };
}
it('persists every run fixture verdict and usage and keeps the existing retry policy', async () => {
  const fixtures = JSON.parse(await readFile(PROCESS_ABI_RUN_FIXTURES_URL, 'utf8'));
  for (const fixture of fixtures) {
    const k = await kit();
    try {
      const child = k.launcher.processes[0]!;
      child.writeStderr('diagnostic\n');
      for (const part of fixture.stdout) child.write(typeof part === 'string' ? part : part.repeat.repeat(part.count));
      k.time.advance(250); child.exit(fixture.exit.code, fixture.exit.signal); await flush();
      const attempt = k.store.snapshot().workAttempts[0]!;
      expect(attempt, fixture.name).toMatchObject({ outcome: fixture.expect.outcome, errorCode: fixture.expect.code ?? null,
        errorRetryable: fixture.expect.retryable ?? null, elapsedMs: 250, stderr: 'diagnostic\n',
        inputTokens: fixture.expect.usage?.input_tokens ?? null, cachedInputTokens: fixture.expect.usage?.cached_input_tokens ?? null, outputTokens: fixture.expect.usage?.output_tokens ?? null });
      const item = k.store.snapshot().workItems[0]!;
      if (fixture.expect.outcome === 'failed') {
        expect(item.lastError, fixture.name).toContain(fixture.expect.code);
        expect(item.nextAttemptAt).toEqual(new Date(now.getTime() + 1250));
      } else expect(item.completedAt).toEqual(new Date(now.getTime() + 250));
      expect(k.store.snapshot().failures).toEqual([]);
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
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, launcher, inspector: fakeProcessInspector(base), idGen, signal: controller.signal, launches: { process_probe: () => ({ command: 'probe', args: [], env: {} }) } });
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
    child.push('{"abi":1,"type":"heartbeat"}'); child.push('{"abi":1,"type":"result"}'); child.push('{"abi":1,"type":"progress"}'); await flush();
    expect(k.store.snapshot().workAttempts[0]!.renewedAt).toBeNull(); child.exit(); await flush();
  } finally { await k.stop(); }
});
it.each(['identity', 'recording'])('consumes bounded stderr while %s is delayed', async delayed => {
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
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, inspector, idGen, signal: controller.signal,
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
    for (let i = 0; i < 100; i++) child.writeStderr('x'.repeat(1000) + '\n');
    child.writeStderr('TOKEN=secret-value\nlast diagnostic\n');
    await expect.poll(() => consumed).toBe(101);
    expect(store.snapshot().workAttempts[0]!.outcome).toBeNull();
    release(); await flush(); child.push('{"abi":1,"type":"result"}'); child.exit(); await flush();
    const attempt = store.snapshot().workAttempts[0]!;
    expect(attempt.outcome).toBe('succeeded');
    expect(attempt.stderr).toContain('last diagnostic\n'); expect(attempt.stderr).not.toContain('secret-value');
    expect(Buffer.byteLength(attempt.stderr!)).toBeLessThanOrEqual(4096);
  } finally { release(); controller.abort(); await running; }
});
it('drains queued stderr before unknown settlement and retains the full masked tail', async () => {
  const store = memoryStore(), time = manualTime(now), launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const controller = new AbortController(), idGen = sequenceIdGen({ timestampMs: now.getTime() });
  inspector.groupMembers = async () => ({ state: 'unknown' });
  await store.addWork({ id: idGen.next(), kind: 'process_probe', targetKind: 'probe', targetId: '1', createdAt: now, nextAttemptAt: now });
  let closed = false, consumed = 0;
  const running = runSupervisor({ store: { ...store, ...memorySchemaStore({ version: 3 }) }, ...time, inspector, idGen, signal: controller.signal,
    launcher: { async start(spec) {
      const started = await launcher.start(spec);
      if (started.ok) {
        let release!: () => void;
        const outputClosed = new Promise<void>(resolve => { release = resolve; });
        const close = started.handle.closeOutput.bind(started.handle);
        started.handle.closeOutput = () => { closed = true; close(); release(); };
        started.handle.stderr = { async *[Symbol.asyncIterator]() {
          await outputClosed;
          for (const chunk of ['first diagnostic\n', 'TOKEN=secret-value\n', 'last diagnostic\n']) { consumed++; yield chunk; }
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
      mode === 'unterminated PEM' ? '[REDACTED:private_key]\n' : '[stderr 줄 생략: 상한 초과]');
    expect(Buffer.byteLength(attempt.stderr!)).toBeLessThanOrEqual(4096);
  } finally { await k.stop(); }
});
