import { expect, it } from 'vitest';
import { parseProcesses, ProcessTracker, SharedProcessSampler, terminateGroup, type ProcessSample } from '../src/slots/processes.js';
const p = (pid: number, ppid: number): ProcessSample => ({ pid, ppid, pgid: 2, started: `start${pid}`, cpu: 2, time: '0:01' });
it('accumulates descendants after reparenting and tracks CPU', () => {
  const tracker = new ProcessTracker(p(1, 0)); tracker.update([p(1, 0), p(2, 1)]); tracker.update([p(2, 0), p(3, 2)]);
  expect([...tracker.descendants.values()].map(x => x.pid)).toEqual([2, 3]); expect(tracker.peakCpu).toBe(4);
  expect(parseProcesses(' 2 1 2 Mon Jan  1 00:00:00 2024 3.0 0:01\n')[0]?.started).toBe('Mon Jan  1 00:00:00 2024');
});
it('escalates and reports unknown identity rather than success', async () => {
  const tracker = new ProcessTracker(p(1, 0)); tracker.update([p(1, 0), p(2, 1)]); const signals: string[] = [];
  const result = await terminateGroup(2, tracker, { sampler: async () => [p(2, 0)], signal: (_pid, sig) => { signals.push(sig); }, now: () => 1, deadlineMs: 0, sleep: async () => {} });
  expect(signals).toEqual(['SIGTERM', 'SIGKILL']); expect(result).toBe('alive');
  expect(await terminateGroup(2, tracker, { sampler: async () => { throw new Error('ps'); }, signal: () => {} })).toBe('unknown');
});

it('shares one sample with every tracker and marks all on failure', async () => {
  let calls = 0;
  const a = new ProcessTracker(p(10, 0)), b = new ProcessTracker(p(20, 0));
  const sampler = new SharedProcessSampler(async () => { calls++; if (calls > 1) throw new Error('ps'); return [p(10, 0), p(11, 10), p(20, 0), p(21, 20)]; });
  sampler.subscribe(a); sampler.subscribe(b); await sampler.sample();
  expect(calls).toBe(1); expect([...a.descendants.values()].map(x => x.pid)).toEqual([11]); expect([...b.descendants.values()].map(x => x.pid)).toEqual([21]);
  await sampler.sample(); expect(a.samplingFailed).toBe(true); expect(b.samplingFailed).toBe(true);
});
it('treats a reused PID as gone and does not signal it', async () => {
  const tracker = new ProcessTracker(p(10, 0)); const signals: number[] = [];
  const reused = { ...p(10, 0), started: 'new' };
  expect(await terminateGroup(2, tracker, { sampler: async () => [reused], signal: pid => { signals.push(pid); } })).toBe('gone');
  expect(signals).toEqual([]);
});
it('signals escaped known descendants individually through TERM and KILL', async () => {
  const tracker = new ProcessTracker(p(10, 0)), child = { ...p(11, 10), pgid: 3 };
  tracker.update([p(10, 0), child]); const signals: [number, string][] = [];
  expect(await terminateGroup(2, tracker, { sampler: async () => [{ ...child, ppid: 1 }], signal: (pid, sig) => { signals.push([pid, sig]); }, now: () => 1, deadlineMs: 0, sleep: async () => {} })).toBe('alive');
  expect(signals).toEqual([[11, 'SIGTERM'], [11, 'SIGKILL']]);
});
it('attempts termination after a past sample failure but cannot confirm gone', async () => {
  const tracker = new ProcessTracker(p(10, 0)); tracker.samplingFailed = true;
  const signals: string[] = []; let count = 0;
  const result = await terminateGroup(2, tracker, { sampler: async () => ++count === 1 ? [p(10, 0)] : [], signal: (_pid, sig) => { signals.push(sig); } });
  expect(signals).toEqual(['SIGTERM']); expect(result).toBe('unknown');
});
