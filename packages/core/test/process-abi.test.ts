import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { createAbiRun, decodeAbiEnv, decodeAbiLine, PROCESS_ABI_ENV, PROCESS_ABI_EVENT_TYPES, PROCESS_ABI_FIXTURES_URL, PROCESS_ABI_SCHEMA_URL, PROCESS_ABI_ENV_SCHEMA_URL, PROCESS_ABI_ENV_FIXTURES_URL, PROCESS_ABI_RUN_FIXTURES_URL } from '../dist/index.js';
const load = async (url: URL) => JSON.parse(await readFile(url, 'utf8'));
it('every event fixture gets its expected verdict', async () => {
  for (const fixture of await load(PROCESS_ABI_FIXTURES_URL)) {
    const decoded = decodeAbiLine(fixture.line);
    expect(decoded.ok, fixture.name).toBe(fixture.expect === 'valid');
    if (!decoded.ok) expect(decoded.code, fixture.name).toBe(fixture.code);
  }
});
it('every env fixture gets its expected verdict', async () => {
  for (const fixture of await load(PROCESS_ABI_ENV_FIXTURES_URL)) expect(decodeAbiEnv(fixture.env).ok, fixture.name).toBe(fixture.expect === 'valid');
});
it('every run fixture gets its expected verdict', async () => {
  for (const fixture of await load(PROCESS_ABI_RUN_FIXTURES_URL)) {
    const raw = fixture.stdout.map((part: string | { repeat: string; count: number }) => typeof part === 'string' ? part : part.repeat.repeat(part.count)).join('');
    for (const size of [1, 2, 7, 1024, Math.max(1, raw.length)]) {
      const run = createAbiRun();
      for (let i = 0; i < raw.length; i += size) run.feed(raw.slice(i, i + size));
      run.end();
      const { message: _message, ...verdict } = run.verdict(fixture.exit);
      expect(verdict, `${fixture.name}, chunk ${size}`).toEqual(fixture.expect);
    }
  }
});
it('keeps schema branches and required environment names aligned with codec constants', async () => {
  const schema = await load(PROCESS_ABI_SCHEMA_URL), env = await load(PROCESS_ABI_ENV_SCHEMA_URL);
  expect(schema.$schema).toBe('https://json-schema.org/draft/2020-12/schema');
  expect(schema.oneOf.map((branch: any) => branch.properties.type.const)).toEqual(PROCESS_ABI_EVENT_TYPES);
  expect(env.required).toEqual(Object.values(PROCESS_ABI_ENV));
});
it('the core package tarball ships the ABI schemas and fixtures', () => {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' }));
  const files = packed[0].files.map((file: { path: string }) => file.path);
  for (const path of ['schemas/process-abi/v1/event.schema.json', 'schemas/process-abi/v1/env.schema.json', 'schemas/process-abi/v1/README.md', 'fixtures/process-abi/v1/events.json', 'fixtures/process-abi/v1/env.json', 'fixtures/process-abi/v1/runs.json', 'dist/process-abi/codec.js']) expect(files).toContain(path);
  expect(files).not.toContain('fixtures/process-abi/v1/cases.json');
});
it('reports an oversized fragment immediately without waiting for EOF', () => {
  const run = createAbiRun(); run.feed('x'.repeat(65537)); expect(run.violation?.code).toBe('ABI_LINE_TOO_LONG');
});

import { createAbiStderr } from '../src/process-abi/codec.js';
it('masks retained stderr before keeping its final UTF-8 bytes', () => {
  const stderr = createAbiStderr(); stderr.feed('header\nTOKEN=secret-value\n');
  expect(stderr.value()).toContain('header'); expect(stderr.value()).not.toContain('secret-value');
  const many = createAbiStderr(); many.feed('header\n' + '한😀\n'.repeat(2000));
  expect(Buffer.byteLength(many.value()!)).toBeLessThanOrEqual(4096); expect(many.value()).not.toContain('\ufffd');
});
it('discards a cut stderr line and preserves a complete line exactly at the buffer boundary', () => {
  const cut = createAbiStderr(); cut.feed('x'.repeat(20000)); expect(cut.value()).toBeNull();
  cut.feed('\ncomplete\n'); expect(cut.value()).toBe('complete\n');
  const aligned = createAbiStderr(); aligned.feed('discard\n' + 'x'.repeat(16383) + '\n');
  expect(aligned.value()).toBe('x'.repeat(4095) + '\n');
});

it('normalizes NUL stderr before applying the byte cap for PostgreSQL text', () => {
  const stderr = createAbiStderr(); stderr.feed('before\u0000after'); expect(stderr.value()).toBe('before\ufffdafter');
  const bounded = createAbiStderr(); bounded.feed('\u0000'.repeat(2000)); expect(Buffer.byteLength(bounded.value()!)).toBeLessThanOrEqual(4096);
});
