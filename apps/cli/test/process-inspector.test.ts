import { expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProcessInspector, parseBootTime, parseGroupMembers, parseStartedAt } from '../src/runtime/process-inspector.js';
const output = { code: 0, stdout: 'Thu Oct 29 05:05:23 2026\n', stderr: '' };
it('parses process identity to seconds and space-padded days', () => {
  expect(parseStartedAt(output)).toEqual({ state: 'found', value: new Date('Thu Oct 29 05:05:23 2026') });
  expect(parseStartedAt({ ...output, stdout: 'Thu Oct  1 05:05:23 2026\n' }).state).toBe('found');
  expect(parseBootTime({ ...output, stdout: '{ sec = 1792884640, usec = 12345 } Thu Oct 29' })).toEqual({ state: 'found', value: new Date(1792884640000) });
  expect(parseGroupMembers({ ...output, stdout: ' 123 123 Thu Oct 29 05:05:23 2026\n 124 123 Thu Oct 29 05:05:24 2026\n' })).toMatchObject({ state: 'found', value: [{ pid: 123, pgid: 123 }, { pid: 124, pgid: 123 }] });
});
it.each([parseStartedAt, parseGroupMembers, parseBootTime])('distinguishes absent from uncertain OS queries', parse => {
  expect(parse({ code: 1, stdout: '', stderr: '' })).toEqual({ state: 'none' });
  for (const bad of [{ code: 1, stdout: '', stderr: 'denied' }, { code: 1, stdout: ' ', stderr: '' }, { code: 2, stdout: '', stderr: '' }, { code: 0, stdout: '', stderr: '' }, { code: null, stdout: '', stderr: '' }]) expect(parse(bad)).toEqual({ state: 'unknown' });
});
it('turns missing executables into unknown observations', async () => {
  const inspector = createProcessInspector({ ps: '/missing/brain-ps', sysctl: '/missing/brain-sysctl' });
  expect(await inspector.startedAt(1)).toEqual({ state: 'unknown' });
  expect(await inspector.groupMembers(1)).toEqual({ state: 'unknown' });
  expect(await inspector.bootTime()).toEqual({ state: 'unknown' });
});
it('kills hung inspection commands at the configured timeout and reports unknown', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'brain-inspector-timeout-'));
  const command = join(directory, 'hung-query');
  try {
    await writeFile(command, `#!${process.execPath}\nprocess.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n`, { mode: 0o700 });
    const inspector = createProcessInspector({ ps: command, sysctl: command, timeoutMs: 100 });
    expect(await inspector.startedAt(1)).toEqual({ state: 'unknown' });
    expect(await inspector.groupMembers(1)).toEqual({ state: 'unknown' });
    expect(await inspector.bootTime()).toEqual({ state: 'unknown' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
