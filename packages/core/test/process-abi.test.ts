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
  for (const path of ['schemas/process-abi/v1/event.schema.json', 'schemas/process-abi/v1/env.schema.json', 'schemas/process-abi/v1/settings-snapshot.schema.json', 'fixtures/process-abi/v1/settings-snapshots.json', 'schemas/process-abi/v1/README.md', 'fixtures/process-abi/v1/events.json', 'fixtures/process-abi/v1/env.json', 'fixtures/process-abi/v1/runs.json', 'dist/process-abi/codec.js', 'schemas/extensions/v1/manifest.schema.json', 'fixtures/extensions/v1/manifests.json', 'fixtures/extensions/v1/check-manifests.py']) expect(files).toContain(path);
  expect(files).not.toContain('fixtures/process-abi/v1/cases.json');
});
it('reports an oversized fragment immediately without waiting for EOF', () => {
  const run = createAbiRun(); run.feed('x'.repeat(65537)); expect(run.violation?.code).toBe('ABI_LINE_TOO_LONG');
});

import { createAbiStderr, PROCESS_ABI_STDERR_BUFFER_BYTES } from '../src/process-abi/codec.js';
it('masks retained stderr before keeping its final UTF-8 bytes', () => {
  const stderr = createAbiStderr(); stderr.feed('header\nTOKEN=secret-value\n');
  expect(stderr.value()).toContain('header'); expect(stderr.value()).not.toContain('secret-value');
  const many = createAbiStderr(); many.feed('header\n' + '한😀\n'.repeat(2000));
  expect(Buffer.byteLength(many.value()!)).toBeLessThanOrEqual(4096); expect(many.value()).not.toContain('\ufffd');
});
it('discards a cut stderr line and preserves a complete line exactly at the buffer boundary', () => {
  const cut = createAbiStderr(); cut.feed('x'.repeat(20000)); expect(cut.value()).toBeNull();
  cut.feed('\ncomplete\n'); expect(cut.value()).toBe('complete\n');
  const aligned = createAbiStderr(); aligned.feed('discard\n' + 'x'.repeat(4095) + '\n');
  expect(aligned.value()).toBe('x'.repeat(4095) + '\n');
});

it('normalizes NUL stderr before applying the byte cap for PostgreSQL text', () => {
  const stderr = createAbiStderr(); stderr.feed('before\u0000after'); expect(stderr.value()).toBe('before\ufffdafter');
  const bounded = createAbiStderr(); bounded.feed('\u0000'.repeat(2000)); expect(bounded.value()).toBeNull();
});

const pemBody = Array.from({ length: 85 }, (_, i) => `SyntheticPemBody${i}_` + 'Q'.repeat(64)).join('\n');
it.each([1, 7, 1024, 100000])('masks PEM before retaining stderr at chunk size %i', size => {
  const raw = 'header\n-----BEGIN RSA PRIVATE KEY-----\n' + pemBody + '\n-----END RSA PRIVATE KEY-----\nTOKEN=' + 'a'.repeat(14500) + '\n';
  const stderr = createAbiStderr();
  for (let i = 0; i < raw.length; i += size) stderr.feed(raw.slice(i, i + size));
  expect(stderr.value()).toBe('header\n[REDACTED:private_key]\nTOKEN=[REDACTED:password]\n');
  expect(Buffer.byteLength(stderr.value()!)).toBeLessThanOrEqual(4096);
});
it('suppresses an unterminated PEM through EOF using the whole original context', () => {
  const stderr = createAbiStderr();
  stderr.feed('before\nprefix -----BEGIN PRIVATE KEY----- suffix\n' + pemBody);
  expect(stderr.value()).toBe('before\nprefix [REDACTED:private_key]');
});
it('masks long assignments before truncation and discards a long non-secret partial line', () => {
  const stderr = createAbiStderr();
  stderr.feed('TOKEN=' + 'x'.repeat(70000));
  expect(stderr.value()).toBe('TOKEN=[REDACTED:password]');
  stderr.feed('more-secret\nTOKEN=another-secret');
  expect(stderr.value()).toBe('TOKEN=[REDACTED:password]\nTOKEN=[REDACTED:password]');
  const plain = createAbiStderr(); plain.feed('x'.repeat(70000));
  expect(plain.value()).toBeNull();
});
it('masks a PEM block with a long body before retaining the diagnostic tail', () => {
  const stderr = createAbiStderr();
  stderr.feed('-----BEGIN PRIVATE KEY-----\n' + 'X'.repeat(70000) + '-----END PRIVATE KEY-----\nafter\n');
  expect(stderr.value()).toBe('[REDACTED:private_key]\nafter\n');
});
it.each([1, 5, 100000])('counts multibyte stderr lines in UTF-8 bytes at chunk size %i', size => {
  for (const [raw, expected] of [
    ['한'.repeat(21845) + 'a', null],
    ['한'.repeat(21845) + 'ab', null],
    ['😀'.repeat(16384) + 'a', null],
  ] as const) {
    const stderr = createAbiStderr();
    for (let i = 0; i < raw.length; i += size) stderr.feed(raw.slice(i, i + size));
    // A line cut by the final 4096-byte boundary is discarded whole.
    expect(stderr.value()).toBe(expected);
  }
});
it('masks a long assignment before the final 4096-byte tail boundary', () => {
  const stderr = createAbiStderr();
  stderr.feed('TOKEN=' + 'z'.repeat(20000));
  expect(stderr.value()).toBe('TOKEN=[REDACTED:password]');
});
it('feeds 64 KiB of newlines into a full stderr tail in under one second', () => {
  const stderr = createAbiStderr();
  stderr.feed('x'.repeat(16383) + '\n');
  const raw = '\n'.repeat(65536);
  const started = performance.now();
  stderr.feed(raw);
  expect(performance.now() - started).toBeLessThan(1000);
  expect(stderr.value()).toBe('\n'.repeat(4096));
});

it.each([1, 7, 1024, 100000])('masks multiline credentials across chunks of %i code units', size => {
  for (const prefix of ['TOKEN=\n', 'Bearer\n', 'password:\n', 'TOKEN=\n\n\n', 'TOKEN\n\n=\n\n', '비밀번호\n:\n']) {
    const raw = prefix + 'SyntheticSecret1234567890\n';
    const stderr = createAbiStderr();
    for (let i = 0; i < raw.length; i += size) stderr.feed(raw.slice(i, i + size));
    expect(stderr.value(), prefix).toContain('[REDACTED:');
    expect(stderr.value(), prefix).not.toContain('SyntheticSecret1234567890');
  }
});
it.each([1, 8192, 1048577])('keeps exactly 1 MiB but discards all original text after overflow at chunk size %i', size => {
  expect(PROCESS_ABI_STDERR_BUFFER_BYTES).toBe(1048576);
  const raw = 'x'.repeat(1048576 - 18) + '\nTOKEN=secret-end\n';
  expect(Buffer.byteLength(raw)).toBe(1048576);
  const stderr = createAbiStderr();
  for (let i = 0; i < raw.length; i += size) stderr.feed(raw.slice(i, i + size));
  expect(stderr.value()).toBe('TOKEN=[REDACTED:password]\n');
  stderr.feed('!');
  expect(stderr.value()).toBe('[stderr 생략: 원문 1 MiB 초과]');
  stderr.feed('\nlast diagnostic\n');
  expect(stderr.value()).toBe('[stderr 생략: 원문 1 MiB 초과]');
});
it('counts raw UTF-8 bytes across surrogate boundaries and keeps snapshots non-destructive', () => {
  const stderr = createAbiStderr();
  stderr.feed('x'.repeat(1048576 - 5) + '\n\ud83d');
  expect(stderr.value()).toBe('\ud83d');
  stderr.feed('\ude00');
  expect(stderr.value()).toBe('😀');
  stderr.feed('!');
  expect(stderr.value()).toBe('[stderr 생략: 원문 1 MiB 초과]');
  const nul = createAbiStderr(); nul.feed('\u0000'.repeat(1048575) + '\n');
  expect(nul.value()).toBeNull();
});
it('keeps a complete final line when the UTF-8 tail starts exactly after a newline', () => {
  const stderr = createAbiStderr();
  stderr.feed('discard\n' + '한😀\n'.repeat(512));
  expect(Buffer.byteLength(stderr.value()!)).toBe(4096);
  expect(stderr.value()).toBe('한😀\n'.repeat(512));
});

it.each([
  ['see http://' + 'a'.repeat(1048000), null],
  ['see http://' + 'a'.repeat(1048000) + '\nhttps://user:pw123@host.example/x\n', 'https://user:[REDACTED:url_credentials]@host.example/x\n'],
  ['x'.repeat(1000000) + '\nhttps://example.com\n', 'https://example.com\n'],
  ['x'.repeat(1000000) + '\nhttps://user:pw123@host.example/x\n', 'https://user:[REDACTED:url_credentials]@host.example/x\n'],
] as const)('masks stderr case %# with a long scheme-character run in under one second', (raw, expected) => {
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1048576);
  const stderr = createAbiStderr();
  stderr.feed(raw);
  const started = performance.now();
  const value = stderr.value();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(value).toBe(expected);
  expect(value ?? '').not.toContain('pw123');
});

it.each([1, 7, 8192, 1048577])('enforces exactly 1 MiB of two- and three-byte UTF-8 at chunk size %i', size => {
  for (const character of ['é', '한']) {
    const ending = '\nTOKEN=secret-end\n';
    const available = 1048576 - Buffer.byteLength(ending);
    const width = Buffer.byteLength(character);
    const raw = character.repeat(Math.floor(available / width)) + 'x'.repeat(available % width) + ending;
    expect(Buffer.byteLength(raw)).toBe(1048576);
    const stderr = createAbiStderr();
    for (let at = 0; at < raw.length; at += size) stderr.feed(raw.slice(at, at + size));
    expect(stderr.value()).toBe('TOKEN=[REDACTED:password]\n');
    stderr.feed('!');
    expect(stderr.value()).toBe('[stderr 생략: 원문 1 MiB 초과]');
    const overflowing = createAbiStderr();
    const over = raw + '!';
    for (let at = 0; at < over.length; at += size) overflowing.feed(over.slice(at, at + size));
    expect(overflowing.value()).toBe('[stderr 생략: 원문 1 MiB 초과]');
  }
});

it.each([
  ['TOKEN=[REDACTED:password]\n'.repeat(38000), 'TOKEN=[REDACTED:password]\n'.repeat(157)],
  ['token=f( '.repeat(100000) + '\nTOKEN=secret-end\n', 'TOKEN=[REDACTED:password]\n'],
  ['token=f('.repeat(50000) + 'x' + ')'.repeat(50000) + '\nTOKEN=secret-end\n', 'TOKEN=[REDACTED:password]\n'],
] as const)('settles stderr adversarial input %# in under one second', (raw, expected) => {
  expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(1048576);
  const stderr = createAbiStderr();
  stderr.feed(raw);
  const started = performance.now();
  const value = stderr.value();
  expect(performance.now() - started).toBeLessThan(1000);
  expect(value).toBe(expected);
  expect(Buffer.byteLength(value!)).toBeLessThanOrEqual(4096);
  expect(stderr.value()).toBe(value);
});

import { decodeSettingsSnapshot, PROCESS_ABI_SNAPSHOT_FIXTURES_URL, PROCESS_ABI_SNAPSHOT_MAX_BYTES } from '../src/process-abi/codec.js';
it('validates snapshot fixtures against declared keys and types', async () => {
  for (const fixture of await load(PROCESS_ABI_SNAPSHOT_FIXTURES_URL)) {
    expect(decodeSettingsSnapshot(fixture.snapshot, 'testext', { 'testext.limit': 'number', 'testext.token': 'string' }).ok, fixture.name).toBe(fixture.expect === 'valid');
  }
});
it('counts snapshot size in UTF-8 bytes', () => {
  const wrap = (value: string) => JSON.stringify({ version: 1, extension: 'testext', user_id: '019a0000-0000-7000-8000-000000000001', values: { 'testext.token': value } });
  const base = Buffer.byteLength(wrap(''));
  const declarations = { 'testext.token': 'string' as const };
  expect(decodeSettingsSnapshot(wrap('x'.repeat(PROCESS_ABI_SNAPSHOT_MAX_BYTES - base)), 'testext', declarations).ok).toBe(true);
  expect(decodeSettingsSnapshot(wrap('x'.repeat(PROCESS_ABI_SNAPSHOT_MAX_BYTES - base - 2) + '한'), 'testext', declarations).ok).toBe(false);
});
it('rejects a non-string snapshot in the ABI environment', async () => {
  const valid = (await load(PROCESS_ABI_ENV_FIXTURES_URL)).find((f: any) => f.expect === 'valid').env;
  expect(decodeAbiEnv({ ...valid, BRAIN_SETTINGS_SNAPSHOT: 1 }).ok).toBe(false);
  expect(decodeAbiEnv({ ...valid, BRAIN_SETTINGS_SNAPSHOT: '' }).ok).toBe(false);
});

it('checks the snapshot environment string and object schema separately', async () => {
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const schema = await load(new URL('../schemas/process-abi/v1/settings-snapshot.schema.json', import.meta.url));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  const fixtures = await load(PROCESS_ABI_SNAPSHOT_FIXTURES_URL);
  for (const fixture of fixtures) {
    let parsed: unknown; try { parsed = JSON.parse(fixture.snapshot); } catch { parsed = null; }
    const structural = validate(parsed);
    const contract = structural && decodeSettingsSnapshot(fixture.snapshot, 'testext', { 'testext.limit': 'number', 'testext.token': 'string' }).ok;
    expect(Boolean(contract), fixture.name).toBe(fixture.expect === 'valid');
  }
});

it('exposes the final result summary only for a valid ABI stream', () => {
  const run = createAbiRun();
  run.feed('{"abi":1,"type":"result","summary":"synthetic"}\n');
  run.end();
  expect(run.verdict({ code: 0, signal: null }).outcome).toBe('succeeded');
  expect(run.resultSummary).toBe('synthetic');
  run.feed('{"abi":1,"type":"result","summary":"duplicate"}\n');
  expect(run.resultSummary).toBeUndefined();
});

it('accepts an optional UUID BRAIN_USER_ID and rejects malformed values', async () => {
  const valid = (await load(PROCESS_ABI_ENV_FIXTURES_URL)).find((f: any) => f.name === 'required').env;
  expect(decodeAbiEnv(valid).ok).toBe(true);
  expect(decodeAbiEnv({ ...valid, BRAIN_USER_ID: '01940000-0000-7000-8000-00000000000a' }).ok).toBe(true);
  for (const value of ['', 'not-a-uuid', 123]) expect(decodeAbiEnv({ ...valid, BRAIN_USER_ID: value })).toMatchObject({ ok: false, code: 'ABI_ENV_INVALID' });
});
