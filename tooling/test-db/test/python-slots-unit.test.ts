import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeLedger } from '../src/slots/ledger.js';
import { aggregateVitest, fileReason, reasonWithCases, parseManifest, selectFiles, summarizeShard, exitStatus, mayRecover, recoverRuns, orderedFiles, parseArgs, takeNext } from '../src/python-slots.js';
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
    const run = async (args: string[]) => { calls.push(args); if (args[0] === 'ps') return { stdout: present ? `${id}\n${foreign}\n` : `${foreign}\n` }; if (args[0] === 'rm') { present = false; return { stdout: '' }; } if (args[0] === 'inspect') throw { code: 1, stderr: `Error: No such object: ${id}` }; throw new Error('unexpected docker'); };
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
