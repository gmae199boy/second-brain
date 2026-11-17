import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeLedger } from '../src/slots/ledger.js';
import { aggregateVitest, fileReason, reasonWithCases, parseManifest, selectFiles, summarizeShard, exitStatus, mayRecover, recoverRuns, orderedFiles, parseArgs, takeNext, withoutFileOwnership, coordinatorFileEnv } from '../src/python-slots.js';
it('isolates discovery and coordinator child file environments from their parent', () => {
  const parent = { BRAIN_TEST_RUN_ID: 'parent', BRAIN_TEST_FILE_ID: 'parent', BRAIN_TEST_SLOT_ID: 'parent', BRAIN_TEST_SLOT_LEASE: '/parent/lease', BRAIN_TEST_FILE_DIR: '/parent', BRAIN_TEST_PG_RESOURCE_LOG: '/parent/resources', BRAIN_TEST_HOOK_RESOURCE_LOG: '/parent/hook', BRAIN_TEST_PROCESS_LOG: '/parent/processes', BRAIN_TEST_METRICS_LOG: '/parent/metrics', BRAIN_TEST_CASE_ID: 'parent', KEEP: 'yes' };
  expect(withoutFileOwnership(parent)).toEqual({ KEEP: 'yes' });
  const child = coordinatorFileEnv(parent, 'run', 'file', 'slot', '/child');
  expect(child).toEqual({ KEEP: 'yes', TMPDIR: '/child', BRAIN_TEST_RUN_ID: 'run', BRAIN_TEST_FILE_ID: 'file', BRAIN_TEST_SLOT_ID: 'slot', BRAIN_TEST_FILE_DIR: '/child', BRAIN_TEST_PG_RESOURCE_LOG: '/child/resources.jsonl', BRAIN_TEST_HOOK_RESOURCE_LOG: '/child/hook-resources.jsonl', BRAIN_TEST_PROCESS_LOG: '/child/processes.jsonl', BRAIN_TEST_METRICS_LOG: '/child/fixture-events.jsonl' });
  expect(parent.BRAIN_TEST_FILE_DIR).toBe('/parent');
});
it('parses the Vitest files-only JSON manifest', () => {
  expect(parseManifest([{ file: '/repo/apps/a.test.ts', projectName: 'python' }, { file: './b.test.ts' }, 'c.test.ts'], '/repo/')).toEqual(['apps/a.test.ts', 'b.test.ts', 'c.test.ts']);
  for (const invalid of [{ file: 1 }, {}, null, 5, '']) expect(() => parseManifest([invalid], '/repo/')).toThrow('invalid manifest');
  expect(() => parseManifest({}, '/repo/')).toThrow('invalid manifest');
});
it('parses options and rejects bad values', () => {
  expect(parseArgs([])).toEqual({ config: 'apps/cli/python-test/vitest.config.ts', slots: 4, timeout: 1_800_000, metrics: false, recover: false });
  expect(parseArgs(['--slots', '2', '--files', 'a', 'b', '--file-timeout', '10', '--metrics', '--order', 'prior.json']).files).toEqual(['a', 'b']);
  expect(parseArgs(['--config', 'tooling/example.ts']).config).toBe('tooling/example.ts');
  for (const args of [['--config', '/tmp/config.ts'], ['--config', 'C:/outside.ts'], ['--config', '../config.ts'], ['--config', 'x/../../config.ts'], ['--slots', '0'], ['--unknown'], ['--files'], ['--run-id', '../bad'], ['--slots', '2', '--slots', '3']]) expect(() => parseArgs(args)).toThrow();
});
it('orders by prior wall time then path and leaves work queued when quarantined', () => {
  const queue = orderedFiles(['c', 'a', 'b'], { b: 9, c: 9 });
  expect(queue).toEqual(['b', 'c', 'a']); expect(takeNext(queue, true, false)).toBeUndefined();
  expect(takeNext(queue, false, false)).toBe('b'); expect(takeNext(queue, false, true)).toBeUndefined(); expect(queue).toEqual(['c', 'a']);
});
it('counts Vitest cases and rejects invalid reports', () => {
  expect(aggregateVitest({ numPassedTests: 4, numFailedTests: 2, numPendingTests: 3, numTodoTests: 1 })).toEqual({ pass: 4, fail: 2, skip: 4 });
  expect(() => aggregateVitest({ numPassedTests: 1 })).toThrow();
});
it('distinguishes failure, signals and recoverable dead runs', () => {
  expect(fileReason(0, false, false)).toBe('pass'); expect(fileReason(1, false, false)).toBe('fail'); expect(fileReason(null, true, false)).toBe('timeout'); expect(fileReason(null, false, true)).toBe('signal');
  expect(exitStatus(false)).toBe(0); expect(exitStatus(true)).toBe(1); expect(exitStatus(false, 'SIGINT')).toBe(130); expect(exitStatus(true, 'SIGTERM')).toBe(143);
  expect(mayRecover('dead')).toBe(true); expect(mayRecover('alive')).toBe(false); expect(mayRecover('unknown')).toBe(false);
  const cases = aggregateVitest({ numPassedTests: 1, numFailedTests: 1, numPendingTests: 0 });
  expect(reasonWithCases(fileReason(null, true, false), cases)).toBe('timeout');
  expect(reasonWithCases(fileReason(null, false, true), cases)).toBe('signal');
  expect(reasonWithCases(fileReason(0, false, false), cases)).toBe('fail');
});

it('recovers only recorded IDs with matching run label for a dead coordinator', async () => {
  const root = await mkdtemp(join(tmpdir(), 'slot-recovery-')), id = 'a'.repeat(64), foreign = 'b'.repeat(64);
  const calls: string[][] = []; let present = true;
  try {
    await writeLedger(root, { runId: 'dead', coordinator: { pid: 40, started: 'old' }, slots: [], files: [], resources: [{ id }], cleanup: [] });
    await writeLedger(root, { runId: 'live', coordinator: { pid: 41, started: 'live' }, slots: [], files: [], resources: [{ id: foreign }], cleanup: [] });
    const run = async (args: string[]) => { calls.push(args); if (args[0] === 'ps') return { stdout: present ? `${id}\n${foreign}\n` : `${foreign}\n` }; if (args[0] === 'rm') { present = false; return { stdout: '' }; } if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: id, Name: '/test', Config: { Labels: { 'brain.test-run': 'dead' } } }) }; if (args[0] === 'inspect') throw { code: 1, stderr: `Error: No such object: ${id}` }; throw new Error('unexpected docker'); };
    const result = await recoverRuns(root, run, async pid => pid === 40 ? null : 'live');
    expect(calls.filter(c => c[0] === 'rm').map(c => c[2])).toEqual([id]);
    expect(JSON.stringify(result)).toContain('alive'); expect(JSON.stringify(result)).toContain(foreign);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('distinguishes vanished metric targets from other errors', async () => {
  const { metricVanished } = await import('../src/python-slots.js');
  for (const error of [{ code: 'ECONNREFUSED' }, { code: 'ECONNRESET' }, new Error('Connection terminated unexpectedly'), { stderr: 'Error: No such container: abc' }, { stderr: 'Error: No such object: abc' }]) expect(metricVanished(error)).toBe(true);
  for (const error of [new Error('permission denied'), { code: 'ETIMEDOUT' }, { stderr: 'daemon unavailable' }]) expect(metricVanished(error)).toBe(false);
});
it('records and recovers a child that never started', async () => {
  const { markNotStarted } = await import('../src/python-slots.js');
  const root = await mkdtemp(join(tmpdir(), 'not-started-'));
  try {
    const child: { fileId: string; processState?: string } = { fileId: 'file' };
    expect(markNotStarted(child, undefined)).toBe(true); expect(child.processState).toBe('notStarted');
    expect(markNotStarted({}, 123)).toBe(false);
    await writeLedger(root, { runId: 'run', kind: 'coordinator', state: 'running', coordinator: { pid: 4, started: 'old' }, slots: [], files: [child], resources: [], cleanup: [] });
    const events = await recoverRuns(root, async () => ({ stdout: '' }), async () => null);
    expect(events.some(event => (event as { state: string }).state === 'error')).toBe(false);
    const { readLedger } = await import('../src/slots/ledger.js'); expect((await readLedger(root, 'run')).state).toBe('completed');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('orders case jobs by job time with file time fallback and parses the allowlist path', () => {
  expect(orderedFiles(['a#two', 'b', 'a#one'], { a: 4, 'a#one': 9, b: 5 })).toEqual(['a#one', 'b', 'a#two']);
  expect(parseArgs(['--shard-allowlist', 'fixtures/allowlist.json']).shardAllowlist).toBe('fixtures/allowlist.json');
  expect(() => parseArgs(['--shard-allowlist', '../outside.json'])).toThrow();
});

it('rejects empty manifest and selection and bounds timer duration', () => {
  expect(() => selectFiles([])).toThrow('empty test manifest');
  expect(() => selectFiles(['a'], [])).toThrow('empty test manifest');
  expect(selectFiles(['a'], ['a'])).toEqual(['a']);
  expect(parseArgs(['--file-timeout', '2147483647']).timeout).toBe(2147483647);
  expect(() => parseArgs(['--file-timeout', '2147483648'])).toThrow('invalid --file-timeout');
});
it('preserves completed shard cases, elapsed wall time and the worst job details', () => {
  const names = ['a', 'b', 'c'].map(fullName => ({ fullName, filterName: fullName }));
  const base = { file: 'f', slot: 'slot1', generation: 0, start: '2026-01-01T00:00:02.000Z', end: '2026-01-01T00:00:05.000Z', wallMs: 3000, exit: 0, signal: null, reason: 'pass' as const, log: 'a.log', cleanup: ['a-clean'] };
  const summary = summarizeShard('f', names, [
    { ...base, id: 'f#a', selectedCase: 'a', caseStatus: 'passed' },
    { ...base, id: 'f#b', selectedCase: 'b', caseStatus: 'failed', slot: 'slot2', generation: 2, start: '2026-01-01T00:00:01.000Z', end: '2026-01-01T00:00:06.000Z', wallMs: 5000, exit: 1, reason: 'timeout', signal: 'SIGTERM', log: 'b.log', cleanup: ['b-clean'] },
  ]);
  expect(summary.cases).toEqual({ pass: 1, fail: 1, skip: 0 });
  expect(summary.expectedCases).toBe(3); expect(summary.completedCases).toBe(2); expect(summary.missingCases).toEqual(['c']);
  expect(summary.reason).toBe('timeout'); expect(summary.slot).toBe('slot2'); expect(summary.generation).toBe(2); expect(summary.log).toBe('b.log'); expect(summary.signal).toBe('SIGTERM');
  expect(summary.start).toBe('2026-01-01T00:00:01.000Z'); expect(summary.end).toBe('2026-01-01T00:00:06.000Z'); expect(summary.wallMs).toBe(5000); expect(summary.jobWallSumMs).toBe(8000);
  expect(summary.jobIds).toEqual(['f#a', 'f#b']); expect(summary.logs).toEqual([{ jobId: 'f#a', log: 'a.log' }, { jobId: 'f#b', log: 'b.log' }]); expect(summary.cleanup).toEqual(['a-clean', 'b-clean']);
  const missingResult = summarizeShard('f', names.slice(0, 2), [{ ...base, id: 'f#a', selectedCase: 'a', caseStatus: 'passed' }, { ...base, id: 'f#b', selectedCase: 'b' }]);
  expect(missingResult.cases).toEqual({ pass: 1, fail: 0, skip: 0 }); expect(missingResult.missingCases).toEqual(['b']); expect(missingResult.reason).toBe('fail');
});

it('recovers Docker CPU sampling only from exact inspected absences', async () => {
  const { sampleDockerCpu } = await import('../src/python-slots.js');
  const a = 'a'.repeat(64), b = 'b'.repeat(64), c = 'c'.repeat(64);
  const eof = { code: 1, stderr: 'EOF' };
  const missing = (id: string) => ({ code: 1, stderr: `Error: No such object: ${id}` });
  const runCase = async (states: Record<string, string | object>, retry: string | object = '12.5%\n', ids = [a, b]) => {
    const calls: string[][] = [];
    const result = await sampleDockerCpu(ids, async args => {
      calls.push(args);
      if (args[0] === 'stats') {
        if (calls.filter(call => call[0] === 'stats').length === 1) throw eof;
        if (typeof retry !== 'string') throw retry;
        return { stdout: retry };
      }
      const state = states[args[3]!]!;
      if (typeof state !== 'string') throw state;
      return { stdout: state };
    });
    return { result, calls };
  };
  const present = await runCase({ [a]: a, [b]: b });
  expect(present.result.disposition).toBe('error'); expect(present.result.error).toContain('EOF');
  const gone = await runCase({ [a]: missing(a), [b]: missing(b) });
  expect(gone.result.disposition).toBe('vanished'); expect(gone.result.cpu).toBeUndefined();
  expect(gone.result.record?.missingIds).toEqual([a, b]);
  const recovered = await runCase({ [a]: missing(a), [b]: b });
  expect(recovered.result.disposition).toBe('recovered'); expect(recovered.result.cpu).toBe(12.5);
  expect(recovered.result.record?.recoveryCollection).toBe('succeeded');
  expect(recovered.calls.filter(call => call[0] === 'stats')).toEqual([
    ['stats', '--no-stream', '--format', '{{.CPUPerc}}', a, b],
    ['stats', '--no-stream', '--format', '{{.CPUPerc}}', b],
  ]);
  const failed = await runCase({ [a]: missing(a), [b]: b }, { stderr: 'retry failed' });
  expect(failed.result.disposition).toBe('error'); expect(failed.result.error).toContain('EOF'); expect(failed.result.error).toContain('retry failed');
  expect(failed.result.record?.recoveryCollection).toBe('failed'); expect(failed.calls.filter(call => call[0] === 'stats')).toHaveLength(2);
  for (const output of ['', '  \n ', '12.5%\n']) {
    const malformed = await runCase({ [a]: missing(a), [b]: b, [c]: c }, output, [a, b, c]);
    expect(malformed.result.disposition).toBe('error'); expect(malformed.result.cpu).toBeUndefined();
    expect(malformed.result.error).toContain('EOF'); expect(malformed.result.error).toContain('invalid docker CPU');
    expect(malformed.result.record?.recoveryCollection).toBe('failed');
  }
  for (const code of ['ECONNREFUSED', 'ECONNRESET']) {
    const connection = await runCase({ [a]: missing(a), [b]: Object.assign(new Error(code), { code }) });
    expect(connection.result.disposition).toBe('error'); expect(connection.result.cpu).toBeUndefined();
    expect(connection.result.error).toContain('EOF'); expect(connection.result.error).toContain(code);
  }
  const denied = await runCase({ [a]: missing(a), [b]: { stderr: 'permission denied' } });
  expect(denied.result.disposition).toBe('error'); expect(denied.result.error).toContain('permission denied');
  const mismatch = await runCase({ [a]: missing(a), [b]: a });
  expect(mismatch.result.disposition).toBe('error'); expect(mismatch.result.error).toContain('ID mismatch');
});

it('requires a valid explicit target for recovery', () => {
  expect(() => parseArgs(['--recover'])).toThrow('--recover requires --run-id');
  expect(() => parseArgs(['--recover', '--run-id', '../other'])).toThrow('invalid run ID');
  expect(parseArgs(['--recover', '--run-id', 'target']).runId).toBe('target');
});

it('diagnoses other and unknown ledgers without changing bytes or calling Docker', async () => {
  const { inspectPriorRuns } = await import('../src/python-slots.js');
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'prior-diagnostic-'));
  try {
    await writeLedger(root, { runId: 'other', kind: 'coordinator', state: 'running', coordinator: { pid: 41, started: 'old' }, slots: [], files: [], resources: [], cleanup: [] });
    const path = join(root, '.brain-test-runs', 'other.json'), bad = join(root, '.brain-test-runs', 'unknown.json');
    await writeFile(bad, '{invalid'); const before = await readFile(path); const unknown = await readFile(bad);
    const states = await inspectPriorRuns(root, async () => null);
    expect(states).toEqual(expect.arrayContaining([{ runId: 'other', state: 'dead' }, { runId: 'unknown', state: 'unknown' }]));
    expect(await readFile(path)).toEqual(before); expect(await readFile(bad)).toEqual(unknown);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('recovers only the requested run with owned resources and a reused child PID', async () => {
  const { recoverTarget } = await import('../src/python-slots.js');
  const { readFile, writeFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'target-recovery-')), calls: string[][] = [];
  const target = 'a'.repeat(64), foreign = 'b'.repeat(64), unknownId = 'c'.repeat(64);
  const resources = new Set([target, foreign, unknownId]); const signal = vi.spyOn(process, 'kill');
  try {
    await writeLedger(root, { runId: 'target', kind: 'coordinator', state: 'running', coordinator: { pid: 42, started: 'old' }, slots: [], files: [{ pid: 444, pgid: 444, started: 'original' }], resources: [{ id: target }], cleanup: [] });
    await writeLedger(root, { runId: 'other', kind: 'coordinator', state: 'running', coordinator: { pid: 43, started: 'old' }, slots: [], files: [{ pid: 445, pgid: 445, started: 'foreign' }], resources: [{ id: foreign }], cleanup: [] });
    const other = join(root, '.brain-test-runs', 'other.json'), unknown = join(root, '.brain-test-runs', 'unknown.json');
    await writeFile(unknown, '{unknown'); const before = await readFile(other), unknownBefore = await readFile(unknown);
    const docker = async (args: string[]) => {
      calls.push(args);
      if (args[0] === 'ps') return { stdout: args.includes('label=brain.test-run=target') && resources.has(target) ? target : '' };
      if (args[0] === 'rm') { expect(args[2]).toBe(target); resources.delete(target); return { stdout: target }; }
      if (args[0] === 'inspect' && args[2] === '{{json .}}') return { stdout: JSON.stringify({ Id: target, Name: '/target-container', Config: { Labels: { 'brain.test-run': 'target' } } }) };
      if (args[0] === 'inspect' && !resources.has(target)) throw { code: 1, stderr: `Error: No such object: ${target}` };
      throw new Error('unexpected Docker call');
    };
    const reused = async () => [{ pid: 444, ppid: 1, pgid: 444, started: 'reused', cpu: 0, time: '0' }];
    const events = await recoverTarget(root, 'target', docker, async () => null, reused);
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'target', state: 'dead', removed: [target], remaining: [] })]));
    expect((JSON.parse(await readFile(join(root, '.brain-test-runs', 'target.json'), 'utf8')) as { state: string }).state).toBe('completed');
    expect(await readFile(other)).toEqual(before); expect(await readFile(unknown)).toEqual(unknownBefore);
    expect(resources).toEqual(new Set([foreign, unknownId]));
    expect(calls.some(args => args[0] === 'rm' && args[2] === target)).toBe(true);
    expect(calls.some(args => args[0] === 'inspect' && args[2] === '{{.Id}}' && args[3] === target)).toBe(true);
    expect(calls.every(args => !args.includes('label=brain.test-run=other') && !args.includes('label=brain.test-run=unknown'))).toBe(true); expect(signal).not.toHaveBeenCalled();
  } finally { signal.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it.each([{ pid: 0, started: 'old' }, { pid: -1, started: 'old' }, { pid: 42, started: '' }, { pid: 42, started: '  ' }])('rejects invalid owner identity without side effects: %j', async identity => {
  const { recoverTarget, inspectPriorRuns } = await import('../src/python-slots.js');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'invalid-owner-')), calls: string[][] = [], signal = vi.spyOn(process, 'kill');
  try {
    for (const runId of ['target', 'other']) await writeLedger(root, { runId, kind: 'coordinator', state: 'running', coordinator: identity, slots: [], files: [], resources: [{ id: 'a'.repeat(64) }], cleanup: [] });
    const target = join(root, '.brain-test-runs', 'target.json'), other = join(root, '.brain-test-runs', 'other.json');
    const before = await readFile(target), otherBefore = await readFile(other);
    const docker = async (args: string[]) => { calls.push(args); return { stdout: '' }; };
    await expect(recoverTarget(root, 'target', docker, async () => null)).rejects.toThrow();
    expect(await inspectPriorRuns(root, async () => null)).toEqual(expect.arrayContaining([expect.objectContaining({ runId: 'target', state: 'unknown' })]));
    expect(await readFile(target)).toEqual(before); expect(await readFile(other)).toEqual(otherBefore); expect(calls).toEqual([]); expect(signal).not.toHaveBeenCalled();
  } finally { signal.mockRestore(); await rm(root, { recursive: true, force: true }); }
});

it('rejects missing, completed, live and unknown targets and propagates recovery errors', async () => {
  const { recoverTarget } = await import('../src/python-slots.js');
  const root = await mkdtemp(join(tmpdir(), 'target-rejection-')), calls: string[][] = [];
  const docker = async (args: string[]) => { calls.push(args); throw new Error('synthetic docker failure'); };
  try {
    await expect(recoverTarget(root, '../bad', docker)).rejects.toThrow('invalid recovery run ID');
    await expect(recoverTarget(root, 'missing', docker)).rejects.toThrow();
    await writeLedger(root, { runId: 'target', kind: 'coordinator', state: 'running', coordinator: { pid: 42, started: 'same' }, slots: [], files: [], resources: [], cleanup: [] });
    await expect(recoverTarget(root, 'target', docker, async () => 'same')).rejects.toThrow('unconfirmed');
    await expect(recoverTarget(root, 'target', docker, async () => { throw new Error('unknown'); })).rejects.toThrow('unconfirmed');
    expect(calls).toEqual([]);
    // A reused PID has a different start time; recovery is allowed but errors propagate.
    await expect(recoverTarget(root, 'target', docker, async () => 'reused')).rejects.toThrow('synthetic docker failure');
    await writeLedger(root, { runId: 'target', kind: 'coordinator', state: 'completed', coordinator: { pid: 42, started: 'same' }, slots: [], files: [], resources: [], cleanup: [] });
    await expect(recoverTarget(root, 'target', docker)).rejects.toThrow('not a running ledger');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('reports CLI invalid, missing, live, unknown and cleanup errors as nonzero', async () => {
  const { main } = await import('../src/python-slots.js');
  const { readFile } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'main-recovery-'));
  const docker = async () => { throw new Error('synthetic Docker failure'); };
  const identity = { pid: 424242, started: 'owner' };
  const lookup = async (pid: number) => pid === process.pid ? 'self' : pid === identity.pid ? 'owner' : null;
  const run = async (name: string, args: string[], expectedCode: number, expectedError: RegExp, expectedRunId?: string, get = lookup) => {
    const report = join(root, `${name}.json`);
    await expect(readFile(report, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    const code = await main([...args, '--report', report], { root, docker, lookup: get });
    expect(code).toBe(expectedCode);
    const value = JSON.parse(await readFile(report, 'utf8')) as { runId?: string; cleanupErrors: string[] };
    if (expectedRunId) expect(value.runId).toBe(expectedRunId);
    expect(value.cleanupErrors).toEqual(expect.arrayContaining([expect.stringMatching(expectedError)]));
  };
  try {
    await run('missing-option', ['--recover'], 2, /--recover requires --run-id/);
    await run('invalid-id', ['--recover', '--run-id', '../bad'], 2, /invalid run ID/);
    await run('missing-target', ['--recover', '--run-id', 'missing'], 1, /ENOENT.*missing\.json/, 'missing');
    await writeLedger(root, { runId: 'target', kind: 'coordinator', state: 'running', coordinator: identity, slots: [], files: [], resources: [], cleanup: [] });
    await run('live', ['--recover', '--run-id', 'target'], 1, /target recovery incomplete.*unconfirmed/, 'target');
    await run('unknown', ['--recover', '--run-id', 'target'], 1, /target recovery incomplete.*unconfirmed/, 'target', async pid => { if (pid === process.pid) return 'self'; throw new Error('unknown'); });
    await run('docker-error', ['--recover', '--run-id', 'target'], 1, /target recovery failed.*synthetic Docker failure/, 'target', async pid => pid === process.pid ? 'self' : null);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('runs a selected Python coordinator file while preserving foreign ledger and resources', async () => {
  const { main } = await import('../src/python-slots.js');
  const { lookupProcess } = await import('../src/slots/ledger.js');
  const { mkdir, readFile, writeFile, chmod } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'coordinator-isolation-')), bin = join(root, 'bin');
  const previousPath = process.env.PATH, signal = vi.spyOn(process, 'kill');
  const own = 'a'.repeat(64), foreign = 'b'.repeat(64), unknown = 'c'.repeat(64), resources = new Set([foreign, unknown]);
  const calls: string[][] = [], report = join(root, 'report.json');
  try {
    await mkdir(bin);
    await writeFile(join(bin, 'pnpm'), '#!/bin/sh\nsleep 1\nfor arg in "$@"; do case "$arg" in --outputFile=*) out=${arg#--outputFile=};; esac; done\nprintf \'{"numPassedTests":1,"numFailedTests":0,"numPendingTests":0}\' > "$out"\n');
    await chmod(join(bin, 'pnpm'), 0o755); process.env.PATH = `${bin}:${previousPath ?? ''}`;
    await writeLedger(root, { runId: 'other', kind: 'coordinator', state: 'running', coordinator: { pid: 424242, started: 'foreign' }, slots: [], files: [], resources: [{ id: foreign }], cleanup: [] });
    const other = join(root, '.brain-test-runs', 'other.json'), invalid = join(root, '.brain-test-runs', 'unknown.json');
    await writeFile(invalid, '{invalid'); const before = await readFile(other), invalidBefore = await readFile(invalid);
    const docker = async (args: string[]) => { calls.push(args); if (args[0] === 'ps') return { stdout: '' }; throw new Error('unexpected Docker operation'); };
    const code = await main(['--run-id', 'self', '--config', 'test/config.ts', '--files', 'test/example.test.ts', '--report', report], {
      root, docker, lookup: lookupProcess,
      manifest: async () => ['test/example.test.ts'], fingerprint: async () => ({ sha: 'synthetic' }),
      createCluster: async (runId, slotId) => { resources.add(own); return { id: own, name: 'synthetic', runId, slotId, port: 50001, url: 'postgres://unused:unused@127.0.0.1:1/postgres' }; },
      removeOwnedCluster: async cluster => { expect(cluster.id).toBe(own); resources.delete(own); },
      checkClusterBoundary: async () => ({ databases: [], roles: [], connections: 0, clean: true }),
    });
    expect(code).toBe(0); expect(await readFile(other)).toEqual(before); expect(await readFile(invalid)).toEqual(invalidBefore);
    expect(resources).toEqual(new Set([foreign, unknown])); expect(calls.every(args => !args.includes('label=brain.test-run=other') && !args.includes('label=brain.test-run=unknown'))).toBe(true);
    const ledger = JSON.parse(await readFile(join(root, '.brain-test-runs', 'self.json'), 'utf8')) as { state: string; files: { processState: string }[] };
    expect(ledger.state).toBe('completed'); expect(ledger.files[0]?.processState).toBe('gone');
    expect(JSON.parse(await readFile(report, 'utf8')).files[0].reason).toBe('pass');
    expect(signal.mock.calls.every(([pid]) => Math.abs(pid) !== 424242)).toBe(true);
  } finally { signal.mockRestore(); if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; await rm(root, { recursive: true, force: true }); }
}, 45000);
