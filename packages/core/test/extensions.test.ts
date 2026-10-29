import { expect, it } from 'vitest';
import { decodeExtensionManifest, isExtensionName, installExtension, extensionStatus, runExtensionCheck, decodeAbiEnv } from '../src/index.js';
import { fakeProcessInspector, fakeProcessLauncher, fixedClock, manualTime, memoryStore, sequenceIdGen } from '../src/testing/index.js';
import type { ExtensionRuntime, ProcessLauncher } from '../src/index.js';
const now = new Date('2026-10-29T00:00:00Z');
const manifest = { name: 'testext', version: '0.1.0', core: 1, abi: 1, migrations: 'migrations', connection_check: { runtime: 'node', entry: 'bin/check.mjs' } };
const env = { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://brain_app:secret@localhost/brain', BRAIN_WORK_ID: '00000000-0000-7000-8000-000000000001', BRAIN_ATTEMPT_TOKEN: '00000000-0000-7000-8000-000000000002', BRAIN_WORK_KIND: 'testext.connection_check', BRAIN_TARGET_KIND: 'extension', BRAIN_TARGET_ID: 'testext', BRAIN_RUN_GENERATION: '1' };
function setup(options: { text?: string; found?: boolean; output?: string; code?: number; migrationFailure?: boolean } = {}) {
  const fake = fakeProcessLauncher(); let placed = 0, migrated = 0;
  const launcher: ProcessLauncher = { async start(spec) {
    const result = await fake.start(spec);
    if (result.ok) { const child = fake.processes.at(-1)!; child.write(options.output ?? '{"abi":1,"type":"result","summary":"anything"}\n'); child.exit(options.code ?? 0); }
    return result;
  } };
  const time = manualTime(now);
  const runtime: ExtensionRuntime = {
    launcher, inspector: fakeProcessInspector(fake), timer: time.timer, databaseUrl: () => env.BRAIN_DATABASE_URL,
    packages: {
      async resolve() { return options.found === false ? { ok: false } : { ok: true, dir: '/packages/testext', manifestText: options.text ?? JSON.stringify(manifest) }; },
      async place() { placed++; return '/installed/testext'; },
    },
    migrator: { async apply(owner, directory) {
      migrated++; expect(owner).toBe('testext'); expect(directory).toBe('/installed/testext/migrations');
      return options.migrationFailure ? { ok: false, code: 'MIGRATION_FAILED', message: 'SQL 오류' } : { ok: true, from: 0, to: 0, applied: ['0001_testext.sql'] };
    } },
  };
  const deps = { store: memoryStore(), clock: fixedClock(now), idGen: sequenceIdGen({ timestampMs: now.getTime() }), extensions: runtime };
  return { deps, fake, writes: () => ({ placed, migrated }) };
}
it('accepts the exact minimal manifest and extension names', () => {
  expect(decodeExtensionManifest(JSON.stringify(manifest))).toEqual({ ok: true, manifest });
  expect(isExtensionName('a')).toBe(true); expect(isExtensionName('testext_2')).toBe(true);
});
it.each(['Core', '../x', 'core', 'core_extra', 'brainy', 'public', 'pg_ext', 'a'.repeat(32), 'test-ext'])('rejects reserved or malformed names %s before resolving or writing', async name => {
  const { deps, fake, writes } = setup();
  expect(await installExtension(deps, { name })).toMatchObject({ ok: false, code: 'EXTENSION_NOT_FOUND' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 }); expect(fake.specs).toEqual([]);
});
it.each([
  { ...manifest, extra: true }, { ...manifest, version: '' }, { ...manifest, core: 2 }, { ...manifest, abi: 2 },
  { ...manifest, migrations: '../migrations' }, { ...manifest, migrations: '/tmp/sql' },
  { ...manifest, connection_check: { runtime: 'python', entry: 'check.py' } },
  { ...manifest, connection_check: { runtime: 'node', entry: '../check.mjs' } },
  { ...manifest, connection_check: { runtime: 'node', entry: '/check.mjs' } },
  { ...manifest, connection_check: { runtime: 'node', entry: 'bin/check.mjs', extra: true } },
  { ...manifest, name: 'other' }, { ...manifest, migrations: 'C:\\sql' },
])('rejects an invalid manifest before copying or migrating: %j', async value => {
  const { deps, writes } = setup({ text: JSON.stringify(value) });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 });
});
it.each(['{}', '{', JSON.stringify({ ...manifest, connection_check: null })])('rejects missing fields or malformed JSON %s', text => {
  expect(decodeExtensionManifest(text)).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
});
it('returns not found and does no writes when a package cannot be resolved', async () => {
  const { deps, writes } = setup({ found: false });
  expect(await installExtension(deps, { name: 'nope' })).toMatchObject({ ok: false, code: 'EXTENSION_NOT_FOUND' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 });
});
it('reports an unconfigured runtime and returns missing registry facts without writing', async () => {
  const { deps } = setup();
  expect(await installExtension({ store: deps.store, clock: deps.clock, idGen: deps.idGen }, { name: 'testext' })).toMatchObject({ ok: false, code: 'CONFIG_INVALID' });
  expect(await extensionStatus(deps, { name: 'testext' })).toEqual({ ok: true, name: 'testext', extension: null });
});
it('uses a fresh ABI run and rereads installed connected facts; repeat installation keeps its original time', async () => {
  const { deps, fake } = setup();
  const result = await installExtension(deps, { name: 'testext' });
  expect(result).toMatchObject({ ok: true, extension: { enabled: true, connectionStatus: 'connected', connectionCheckedAt: now } });
  const spec = fake.specs[0]!;
  expect(decodeAbiEnv(spec.env)).toEqual({ ok: true }); expect(spec.args).toEqual(['/installed/testext/bin/check.mjs']); expect(spec.args.join(' ')).not.toContain('secret');
  expect(spec.env.BRAIN_WORK_ID).not.toEqual(spec.env.BRAIN_ATTEMPT_TOKEN);
  expect(await installExtension(deps, { name: 'testext' })).toEqual(result);
  const list = await deps.store.listExtensions(); expect(list).toMatchObject({ ok: true, extensions: [{ name: 'testext' }] });
  expect(await extensionStatus(deps, { name: 'testext' })).toEqual(result);
});
it.each([
  { output: '{"abi":1,"type":"error","code":"REFUSED","retryable":false,"message":"연결 거절"}\n', code: 0, expected: 'REFUSED' },
  { output: '{"abi":1,"type":"result"}\n', code: 1, expected: 'ABI_EXIT_AFTER_RESULT' },
  { output: '', code: 2, expected: 'ABI_EXIT_FAILED' },
])('retains install and activation facts when the check fails: %j', async options => {
  const { deps } = setup(options);
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CHECK_FAILED', extension: { enabled: true, connectionStatus: 'failed', connectionCode: options.expected } });
  expect(await extensionStatus(deps, { name: 'testext' })).toMatchObject({ ok: true, extension: { version: '0.1.0', connectionStatus: 'failed' } });
});
it('propagates migration failure without an installation record', async () => {
  const { deps, fake } = setup({ migrationFailure: true });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'MIGRATION_FAILED' });
  expect(await deps.store.getExtension('testext')).toEqual({ ok: true, extension: null }); expect(fake.specs).toEqual([]);
});
it('cleans the child process group after a timeout and returns a failed ABI verdict', async () => {
  const fake = fakeProcessLauncher(), time = manualTime(now), inspector = fakeProcessInspector(fake);
  const pending = runExtensionCheck({ ...time, launcher: fake, inspector, spec: { command: 'node', args: ['check.mjs'], env }, timeoutMs: 100 });
  for (let i = 0; i < 15; i++) await Promise.resolve();
  time.advance(100);
  expect(await pending).toMatchObject({ outcome: 'failed', code: 'PROCESS_STALLED' });
  expect(inspector.signals).toEqual([{ pgid: 100, signal: 'SIGTERM' }]);
});
it('maps process start failure and invalid ABI environment to failed verdicts', async () => {
  const time = manualTime(now), inspector = fakeProcessInspector();
  const launcher: ProcessLauncher = { async start() { return { ok: false, message: '실행 불가' }; } };
  expect(await runExtensionCheck({ ...time, launcher, inspector, spec: { command: 'missing', args: [], env } })).toMatchObject({ outcome: 'failed', code: 'PROCESS_START_FAILED' });
  expect(await runExtensionCheck({ ...time, launcher, inspector, spec: { command: 'missing', args: [], env: {} } })).toMatchObject({ outcome: 'failed', code: 'ABI_ENV_INVALID' });
});
it('masks and normalizes connection errors before persisting failed facts', async () => {
  const raw = '연결 실패\u0000 postgres://brain_app:private-password@localhost/brain';
  const { deps } = setup({ output: JSON.stringify({ abi: 1, type: 'error', code: 'REFUSED', retryable: false, message: raw }) + '\n' });
  const record = deps.store.recordExtensionConnection;
  deps.store.recordExtensionConnection = async input => {
    if (input.message?.includes('\u0000')) return { ok: false, code: 'DB_UNAVAILABLE', message: 'NUL 거부' };
    return record(input);
  };
  const result = await installExtension(deps, { name: 'testext' });
  expect(result).toMatchObject({ ok: false, code: 'EXTENSION_CHECK_FAILED', extension: { connectionStatus: 'failed', connectionCode: 'REFUSED' } });
  const status = await extensionStatus(deps, { name: 'testext' });
  expect(status.ok).toBe(true);
  if (!status.ok) throw new Error('연결 기록 조회 실패');
  expect(status.extension?.connectionMessage).toContain('\ufffd');
  expect(status.extension?.connectionMessage).not.toContain('private-password');
  expect(status.extension?.connectionMessage).not.toContain('\u0000');
});
it('keeps absent ABI error messages null', async () => {
  const { deps } = setup({ output: '{"abi":1,"type":"error","code":"REFUSED","retryable":false}\n' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CHECK_FAILED', extension: { connectionMessage: null } });
});

it.each(['\u0000', '\u0001', '\t', '\n', '\u001f', '\u007f', '\u0085', '\u009f'])('rejects control characters in versions before any writes: %j', async control => {
  const text = JSON.stringify({ ...manifest, version: `0.1${control}` });
  expect(decodeExtensionManifest(text)).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  const { deps, fake, writes } = setup({ text });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 });
  expect(fake.specs).toEqual([]);
  expect(await deps.store.listExtensions()).toEqual({ ok: true, extensions: [] });
});
it.each(['EACCES', 'EISDIR'])('returns a structured failure without writes when resolving throws %s', async code => {
  const { deps, fake, writes } = setup();
  deps.extensions.packages.resolve = async () => { throw Object.assign(new Error('manifest 읽기 실패'), { code }); };
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 });
  expect(fake.specs).toEqual([]);
  expect(await deps.store.listExtensions()).toEqual({ ok: true, extensions: [] });
});
it('records failed connection facts when a successful child group cleanup is unknown', async () => {
  const { deps, fake } = setup();
  const inspector = fakeProcessInspector(fake);
  inspector.groups.set(100, { state: 'unknown' });
  deps.extensions.inspector = inspector;
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CHECK_FAILED' });
  expect(await extensionStatus(deps, { name: 'testext' })).toMatchObject({ ok: true, extension: { enabled: true, connectionStatus: 'failed', connectionCode: 'PROCESS_DIED' } });
});
