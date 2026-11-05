import { validateSchema } from '../../../apps/cli/src/runtime/json-schema.js';
const decodeExtensionManifest = (text: string) => decodeManifest(text, validateSchema);
import { expect, it } from 'vitest';
import { decodeExtensionManifest as decodeManifest, isExtensionName, installExtension, extensionStatus, runExtensionCheck, decodeAbiEnv } from '../src/index.js';
import { fakeCron, fakeProcessInspector, fakeProcessLauncher, fixedClock, manualTime, memoryStore, sequenceIdGen } from '../src/testing/index.js';
import type { ExtensionRuntime, ProcessLauncher } from '../src/index.js';
const now = new Date('2026-10-29T00:00:00Z');
const manifest = { name: 'testext', version: '0.1.0', core: 1, abi: 1, migrations: 'migrations', connection_check: { runtime: 'node', entry: 'bin/check.mjs' } };
const env = { BRAIN_ABI_VERSION: '1', BRAIN_DATABASE_URL: 'postgres://brain_app:secret@localhost/brain', BRAIN_WORK_ID: '00000000-0000-7000-8000-000000000001', BRAIN_ATTEMPT_TOKEN: '00000000-0000-7000-8000-000000000002', BRAIN_WORK_KIND: 'testext.connection_check', BRAIN_TARGET_KIND: 'extension', BRAIN_TARGET_ID: 'testext', BRAIN_RUN_GENERATION: '1' };
function setup(options: { missingSelf?: boolean; text?: string; found?: boolean; output?: string; code?: number; migrationFailure?: boolean } = {}) {
  const fake = fakeProcessLauncher(); let placed = 0, migrated = 0;
  const launcher: ProcessLauncher = { async start(spec) {
    const result = await fake.start(spec);
    if (result.ok) { const child = fake.processes.at(-1)!; child.write(options.output ?? '{"abi":1,"type":"result","summary":"anything"}\n'); child.exit(options.code ?? 0); }
    return result;
  } };
  const time = manualTime(now);
  const runtime: ExtensionRuntime = {
    validateSchema, launcher, inspector: fakeProcessInspector(fake), timer: time.timer, databaseUrl: () => env.BRAIN_DATABASE_URL,
    packages: {
      async resolve() { return options.found === false ? { ok: false } : { ok: true, dir: '/packages/testext', manifestText: options.text ?? JSON.stringify(manifest) }; },
      async place() { placed++; return '/installed/testext'; },
    },
    migrator: { async apply(owner, directory) {
      migrated++; expect(owner).toBe('testext'); expect(directory).toBe('/installed/testext/migrations');
      return options.migrationFailure ? { ok: false, code: 'MIGRATION_FAILED', message: 'SQL 오류' } : { ok: true, from: 0, to: 0, applied: ['0001_testext.sql'] };
    } },
  };
  const deps = { cron: fakeCron, store: memoryStore(), clock: fixedClock(now), idGen: sequenceIdGen({ timestampMs: now.getTime() }), extensions: runtime };
  if (!options.missingSelf) void deps.store.ensureSelfUser({ id: '019a0000-0000-7000-8000-000000000001', name: 'synthetic', createdAt: now });
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
  expect(await extensionStatus(deps, { name: 'testext' })).toEqual({ ok: true, name: 'testext', extension: null, pythonEnvironment: null, progress: null });
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
  { output: '{"abi":1,"type":"error","code":"REFUSED","retryable":false,"message":"연결 거절"}\n', code: 0, expected: 'EXTENSION_WORKER_ERROR' },
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
  expect(result).toMatchObject({ ok: false, code: 'EXTENSION_CHECK_FAILED', extension: { connectionStatus: 'failed', connectionCode: 'EXTENSION_WORKER_ERROR' } });
  const status = await extensionStatus(deps, { name: 'testext' });
  expect(status.ok).toBe(true);
  if (!status.ok) throw new Error('연결 기록 조회 실패');
  expect(status.extension?.connectionMessage).toBe('확장 실행에 실패했습니다');
  expect(status.extension?.connectionMessage).not.toContain('private-password');
  expect(status.extension?.connectionMessage).not.toContain('\u0000');
});
it('uses a fixed message for absent ABI error messages', async () => {
  const { deps } = setup({ output: '{"abi":1,"type":"error","code":"REFUSED","retryable":false}\n' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CHECK_FAILED', extension: { connectionMessage: '확장 실행에 실패했습니다' } });
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

it('projects untrusted connection diagnostics before storing them', async () => {
  const secret = 'SYNTHETIC_SECRET_ABC123';
  const { deps, fake } = setup({ output: JSON.stringify({ abi: 1, type: 'error', code: secret, retryable: false, message: `escaped ${secret}` }) + '\n' });
  const result = await installExtension(deps, { name: 'testext' });
  expect(result).toMatchObject({ ok: false, extension: { connectionCode: 'EXTENSION_WORKER_ERROR', connectionMessage: '확장 실행에 실패했습니다' } });
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(JSON.parse(fake.specs[0]!.env['BRAIN_SETTINGS_SNAPSHOT']!)).toEqual({ version: 1, extension: 'testext', user_id: '019a0000-0000-7000-8000-000000000001', values: {} });
});
it('rejects a missing protected snapshot before starting the connection child', async () => {
  const time = manualTime(now), fake = fakeProcessLauncher(), inspector = fakeProcessInspector(fake);
  const result = await runExtensionCheck({ ...time, launcher: fake, inspector, spec: { command: 'node', args: [], env }, protection: { extension: 'testext', declarations: {}, errorCodes: [] } });
  expect(result).toMatchObject({ outcome: 'failed', code: 'EXTENSION_CONFIG_INVALID', retryable: false });
  expect(fake.specs).toEqual([]);
});

it('rejects a required connection secret without starting a child', async () => {
  const text = JSON.stringify({ ...manifest, settings: [{ key: 'testext.token', type: 'string', secret: true, required: ['connect'] }] });
  const { deps, fake } = setup({ text });
  deps.extensions.readSecrets = async () => ({});
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CONFIG_INVALID', retryable: false });
  expect(fake.specs).toEqual([]);
});
it('resolves declared connection settings from a single read and does not expose secret values', async () => {
  const text = JSON.stringify({ ...manifest, settings: [{ key: 'testext.token', type: 'string', secret: true, required: ['connect'] }, { key: 'testext.limit', type: 'number', default: '10', required: ['work'] }], error_codes: ['REFUSED'] });
  const { deps, fake } = setup({ text });
  deps.extensions.readSecrets = async () => ({ REF: '  synthetic-secret  ' });
  await deps.store.setSetting({ userId: null, key: 'testext.token', value: 'REF', updatedAt: now });
  const result = await installExtension(deps, { name: 'testext' });
  expect(result.ok).toBe(true);
  expect(JSON.parse(fake.specs[0]!.env.BRAIN_SETTINGS_SNAPSHOT!)).toEqual({ version: 1, extension: 'testext', user_id: '019a0000-0000-7000-8000-000000000001', values: { 'testext.token': '  synthetic-secret  ', 'testext.limit': 10 } });
  expect(JSON.stringify(result)).not.toContain('synthetic-secret');
  expect(fake.specs[0]!.args.join(' ')).not.toContain('synthetic-secret');
});
it.each([
  [{ key: 'other.token', type: 'string', required: [] }],
  [{ key: 'testext.token', type: 'number', secret: true, required: [] }],
  [{ key: 'testext.token', type: 'string', secret: true, default: 'bad-name', required: [] }],
  [{ key: 'testext.x', type: 'boolean', default: 'yes', required: [] }],
])('rejects invalid setting declarations %j', settings => {
  expect(decodeExtensionManifest(JSON.stringify({ ...manifest, settings })).ok).toBe(false);
});

it('matches the distributed manifest fixture verdicts', async () => {
  const { readFile } = await import('node:fs/promises');
  const fixtures = JSON.parse(await readFile(new URL('../fixtures/extensions/v1/manifests.json', import.meta.url), 'utf8'));
  for (const fixture of fixtures) expect(decodeExtensionManifest(JSON.stringify(fixture.manifest)).ok, fixture.name).toBe(fixture.expect === 'valid');
});

it('registers only manifest work and auth kinds for supervised enqueue', async () => {
  const work = { kind: 'testext.sync', execution: 'supervised', runtime: 'node', entry: 'sync.mjs' };
  const auth = { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'login.mjs' };
  const { deps } = setup({ text: JSON.stringify({ ...manifest, work: [work], auth, raw_views: ['samples'], default_schedules: [{ kind: work.kind, target_kind: 'account', target_id: 'default', local_time: '09:00' }] }) });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_LOGIN_REQUIRED' });
  for (const [kind, expected] of [['testext.sync', 'supervised'], ['testext.login', 'supervised'], ['other.job', 'core']] as const) {
    const result = await deps.store.addWork({ id: deps.idGen.next(), kind, targetKind: 'account', targetId: 'a', createdAt: now, nextAttemptAt: now });
    expect(result.ok && result.item.executionClass).toBe(expected);
  }
});

it('validates distributed manifest fixtures against the JSON schema', async () => {
  const { readFile } = await import('node:fs/promises');
  const { Ajv2020 } = await import('ajv/dist/2020.js');
  const schema = JSON.parse(await readFile(new URL('../schemas/extensions/v1/manifest.schema.json', import.meta.url), 'utf8'));
  const fixtures = JSON.parse(await readFile(new URL('../fixtures/extensions/v1/manifests.json', import.meta.url), 'utf8'));
  const validate = new Ajv2020({ strict: false }).compile(schema);
  for (const fixture of fixtures) {
    const structural = Boolean(validate(fixture.manifest));
    expect(structural && decodeExtensionManifest(JSON.stringify(fixture.manifest)).ok, fixture.name).toBe(fixture.expect === 'valid');
    if (fixture.expect === 'valid') expect(structural, fixture.name).toBe(true);
  }
});

it.each(['PROCESS_DIED', 'ABI_EXIT_FAILED'] as const)('projects undeclared worker error %s in a connection check', async code => {
  const { deps } = setup({ output: JSON.stringify({ abi: 1, type: 'error', code, retryable: true }) + '\n' });
  const verdict = await runExtensionCheck({ ...deps.extensions, clock: deps.clock, spec: { command: 'node', args: [], env: { ...env, BRAIN_SETTINGS_SNAPSHOT: '{"version":1,"extension":"testext","user_id":"019a0000-0000-7000-8000-000000000001","values":{}}' } }, protection: { extension: 'testext', declarations: {}, errorCodes: [] } });
  expect(verdict).toMatchObject({ outcome: 'failed', code: 'EXTENSION_WORKER_ERROR', retryable: true });
});

it('마이그레이션 전에 Python을 준비하고 실패 시 기존 레지스트리 사실을 보존한다', async () => {
  const { deps, fake, writes } = setup({ text: JSON.stringify({ ...manifest, connection_check: { runtime: 'python', entry: 'check.py' } }) });
  await deps.store.recordExtensionInstall({ name: 'testext', version: 'old', now });
  await deps.store.recordExtensionConnection({ name: 'testext', status: 'connected', checkedAt: now, code: null, message: null });
  let rolledBack = false;
  deps.extensions.packages.rollback = async () => { rolledBack = true; };
  deps.extensions.preparePython = async () => ({ ok: false, code: 'EXTENSION_PYTHON_SYNC_FAILED', message: 'Python 환경을 설치하지 못했습니다' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_PYTHON_SYNC_FAILED', extension: { version: 'old', connectionStatus: 'connected' }, pythonEnvironment: { status: 'failed', code: 'EXTENSION_PYTHON_SYNC_FAILED' } });
  expect(rolledBack).toBe(true); expect(writes().migrated).toBe(0); expect(fake.specs).toEqual([]);
});
it('Node 명령에는 Python을 준비하지 않는다', async () => {
  const { deps } = setup();
  deps.extensions.preparePython = async () => { throw new Error('예상하지 못한 호출'); };
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: true });
});

it('Python 환경 사실을 기록할 수 없으면 DB 오류를 반환하고 복원한다', async () => {
  const { deps, fake, writes } = setup({ text: JSON.stringify({ ...manifest, connection_check: { runtime: 'python', entry: 'check.py' } }) });
  let rolledBack = false;
  deps.extensions.packages.rollback = async () => { rolledBack = true; };
  deps.extensions.preparePython = async () => ({ ok: true });
  deps.store.recordExtensionPythonEnvironment = async () => ({ ok: false, code: 'DB_UNAVAILABLE', message: 'DB 오류' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(rolledBack).toBe(true); expect(writes().migrated).toBe(0); expect(fake.specs).toEqual([]);
});

it('SDK 취소 신호가 이미 온 경우 패키지를 배치하지 않고 취소 사실을 남긴다', async () => {
  const { deps, writes } = setup();
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  const controller = new AbortController(); controller.abort();
  expect(await installExtension(deps, { name: 'testext', signal: controller.signal })).toMatchObject({ ok: false, code: 'EXTENSION_INSTALL_CANCELLED' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 });
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { result: 'cancelled' } } });
});

it('예약 기능이 없는 SDK 실행 환경은 예약 성공을 기록하지 않는다', async () => {
  const work = { kind: 'testext.sync', execution: 'supervised', runtime: 'node', entry: 'sync.mjs' };
  const { deps } = setup({ text: JSON.stringify({ ...manifest, work: [work], default_schedules: [{ kind: work.kind, target_kind: 'account', target_id: 'default', local_time: '09:00' }] }) });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.extensions.schedulerReady = async () => true;
  const withoutScheduler = { ...deps, store: { ...deps.store, addSchedule: undefined }, readTimeZone: async () => ({ ok: true as const, value: 'Asia/Seoul' }) };
  expect(await installExtension(withoutScheduler, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_SCHEDULER_UNAVAILABLE' });
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { result: 'scheduler_unavailable' } } });
});

it('SDK 실행 중 취소는 자식 그룹 종료를 확인하고 앞 단계 성공을 보존한다', async () => {
  const { deps } = setup(); const controller = new AbortController();
  const fake = fakeProcessLauncher(); const inspector = fakeProcessInspector(fake);
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.extensions.launcher = { async start(spec) { const child = await fake.start(spec); controller.abort(); return child; } };
  deps.extensions.inspector = inspector;
  expect(await installExtension(deps, { name: 'testext', signal: controller.signal })).toMatchObject({ ok: false, code: 'EXTENSION_INSTALL_CANCELLED' });
  expect(fake.processes[0]?.ended).toBe(true);
  expect(inspector.signals).toMatchObject([{ signal: 'SIGTERM' }]);
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { result: 'cancelled', stages: { package: { status: 'succeeded' }, migration: { status: 'succeeded' } } } } });
});

it('설치 journal 쓰기가 실패하면 성공을 보고하거나 DDL을 실행하지 않는다', async () => {
  const { deps, writes } = setup(); let rolledBack = false;
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.extensions.packages.rollback = async () => { rolledBack = true; };
  const store = { ...deps.store, async writeExtensionInstallProgress() { return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '시험 저장 실패' }; } };
  expect(await installExtension({ ...deps, store }, { name: 'testext' })).toMatchObject({ ok: false, code: 'DB_UNAVAILABLE' });
  expect(writes()).toEqual({ placed: 1, migrated: 0 }); expect(rolledBack).toBe(true);
  expect(await deps.store.getExtension('testext')).toEqual({ ok: true, extension: null });
});

it('사전 검사 실패는 기존 완료 단계와 인증·예약 식별자를 보존한다', async () => {
  const { deps } = setup({ found: false });
  const id = '00000000-0000-7000-8000-000000000001';
  const progress = { name: 'testext', packageDigest: 'a'.repeat(64), result: 'login_required' as const, failedStage: null, lastFailure: null,
    stages: { package: { status: 'succeeded' as const, code: null, at: now.toISOString() } }, authWorkId: id, scheduleIds: [id] };
  expect(await deps.store.writeExtensionInstallProgress({ expectedRevision: null, progress })).toMatchObject({ ok: true, written: true });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_NOT_FOUND' });
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { ...progress, result: 'failed', failedStage: 'package', lastFailure: { stage: 'package', code: 'EXTENSION_NOT_FOUND' } } } });
});

it.each(['manifest', 'tree'] as const)('사전 %s 검사 실패도 기존 journal을 보존한다', async kind => {
  const { deps } = setup({ ...(kind === 'manifest' ? { text: '{' } : {}) });
  const id = '00000000-0000-7000-8000-000000000001';
  const progress = { name: 'testext', packageDigest: 'a'.repeat(64), result: 'login_required' as const, failedStage: null, lastFailure: null,
    stages: { package: { status: 'succeeded' as const, code: null, at: now.toISOString() } }, authWorkId: id, scheduleIds: [id] };
  await deps.store.writeExtensionInstallProgress({ expectedRevision: null, progress });
  if (kind === 'tree') deps.extensions.packages.inspect = async () => { throw new Error('원문 진단'); };
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  const read = await deps.store.getExtensionInstallProgress('testext');
  expect(read).toMatchObject({ ok: true, journal: { progress: { ...progress, result: 'failed', failedStage: 'package', lastFailure: { stage: 'package', code: 'EXTENSION_INVALID' } } } });
  expect(JSON.stringify(read)).not.toContain('원문 진단');
});

it.each(['add', 'lookup', 'save'] as const)('인증 %s 직후 SDK 취소는 일감 종료를 확인한다', async boundary => {
  const auth = { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'login.mjs' };
  const { deps } = setup({ text: JSON.stringify({ ...manifest, auth }) });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  const controller = new AbortController(); const original = deps.store;
  const store = { ...original,
    async addWork(input: Parameters<typeof original.addWork>[0]) { const result = await original.addWork(input); if (boundary === 'add') controller.abort(); return result; },
    async getWork(id: string) { const result = await original.getWork(id); if (boundary === 'lookup') controller.abort(); return result; },
    async writeExtensionInstallProgress(input: Parameters<typeof original.writeExtensionInstallProgress>[0]) { const result = await original.writeExtensionInstallProgress(input); if (boundary === 'save' && input.progress.authWorkId) controller.abort(); return result; },
  };
  const result = await installExtension({ ...deps, store }, { name: 'testext', signal: controller.signal });
  expect(result).toMatchObject({ ok: false, code: 'EXTENSION_INSTALL_CANCELLED' });
  const journal = await original.getExtensionInstallProgress('testext'); expect(journal.ok && journal.journal?.progress.result).toBe('cancelled');
  if (journal.ok && journal.journal?.progress.authWorkId) {
    const work = await original.getWork(journal.journal.progress.authWorkId);
    expect(work).toMatchObject({ ok: true, entry: { item: { outcome: 'cancelled', currentAttemptToken: null } } });
  }
});

it('인증 자식 종료가 미확정이면 취소 완료로 기록하지 않는다', async () => {
  const auth = { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'login.mjs' };
  const { deps } = setup({ text: JSON.stringify({ ...manifest, auth }) });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.extensions.timer = { async sleep() {} };
  const controller = new AbortController(); const original = deps.store;
  const store = { ...original,
    async addWork(input: Parameters<typeof original.addWork>[0]) { const result = await original.addWork(input); controller.abort(); return result; },
    async requestWorkCancel() { return { ok: true as const, state: 'requested' as const }; },
  };
  const result = await installExtension({ ...deps, store }, { name: 'testext', signal: controller.signal });
  expect(result).toMatchObject({ ok: false, code: 'EXTENSION_CANCEL_UNCONFIRMED' });
  expect(await original.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { result: 'login_required', stages: { login: { status: 'pending' } } } } });
});

it('선언된 수동 일감만 큐에 넣고 비활성을 우회하지 않으며 열린 대상을 합친다', async () => {
  const { deps } = setup();
  const work = { kind: 'testext.import_preflight', execution: 'supervised', runtime: 'node', entry: 'job.mjs', manual: 'import-preflight' };
  deps.extensions.installedManifest = async () => JSON.stringify({ ...manifest, work: [work] });
  await deps.store.recordExtensionInstall({ name: 'testext', version: manifest.version, now, workKinds: [work.kind] });
  const { runExtension } = await import('../src/extensions/run.js');
  const first = await runExtension(deps, { name: 'testext', job: 'import-preflight' });
  const second = await runExtension(deps, { name: 'testext', job: 'import-preflight' });
  expect(first).toMatchObject({ ok: true, created: true, status: 'queued' });
  expect(second).toMatchObject({ ok: true, created: false, workId: first.ok ? first.workId : '' });
  const item = first.ok && await deps.store.getWork(first.workId);
  expect(item && item.ok && item.entry?.item).toMatchObject({ executionClass: 'supervised', holdGroup: 'extension:testext', targetId: 'default' });
  expect(await runExtension(deps, { name: 'testext', job: 'other' })).toMatchObject({ ok: false });
  expect(await runExtension(deps, { name: 'testext', job: 'import-preflight', target: '../bad' })).toMatchObject({ ok: false });
  await deps.store.setExtensionEnabled({ name: 'testext', enabled: false, now });
  expect(await runExtension(deps, { name: 'testext', job: 'import-preflight' })).toMatchObject({ ok: false });
});

it('성공한 일감의 선언된 안전 공개 보고만 허용한다', async () => {
  const { deps } = setup();
  const work = { kind: 'testext.report', execution: 'supervised', runtime: 'node', entry: 'job.mjs', manual: 'report', public_report: { counts: ['rows'], checks: ['ready'] } };
  deps.extensions.installedManifest = async () => JSON.stringify({ ...manifest, work: [work] });
  await deps.store.recordExtensionInstall({ name: 'testext', version: manifest.version, now, workKinds: [work.kind] });
  const original = deps.store.getWork;
  deps.store.getWork = async id => { const result = await original(id); if (result.ok && result.entry) { result.entry.item.completedAt = now; result.entry.item.outcome = 'succeeded'; } return result; };
  const { runExtension } = await import('../src/extensions/run.js');
  let report: unknown = { counts: { rows: 2 }, checks: { ready: true } };
  deps.extensions.readPublicReport = async () => report;
  expect(await runExtension(deps, { name: 'testext', job: 'report', waitMs: 0 })).toMatchObject({ ok: true, status: 'completed', report });
  const successfulGetWork = deps.store.getWork;
  deps.store.getWork = async id => { const result = await successfulGetWork(id); if (result.ok && result.entry) { result.entry.item.outcome = 'failed'; result.entry.latestAttempt = { errorCode: 'EXTENSION_REPORT_NOT_READY' } as typeof result.entry.latestAttempt; } return result; };
  expect(await runExtension(deps, { name: 'testext', job: 'report', waitMs: 0 })).toMatchObject({ ok: false, report: { checks: { ready: true } } });
  deps.store.getWork = successfulGetWork;
  for (report of [{ counts: { rows: -1 }, checks: { ready: true } }, { counts: { rows: 1, secret: 1 }, checks: { ready: true } }, { counts: { rows: 1 }, checks: { ready: 'yes' } }, { counts: { rows: 1 }, checks: { ready: true }, secret: 'x' }]) {
    expect(await runExtension(deps, { name: 'testext', job: 'report', waitMs: 0 })).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  }
});

it('보고 대기 예산에 주입된 시계와 타이머를 사용한다', async () => {
  const { deps } = setup(); const time = manualTime(now);
  const work = { kind: 'testext.report', execution: 'supervised', runtime: 'node', entry: 'job.mjs', manual: 'report', public_report: { counts: [], checks: [] } };
  deps.extensions.installedManifest = async () => JSON.stringify({ ...manifest, work: [work] });
  deps.extensions.readPublicReport = async () => { throw new Error('아직 완료되지 않음'); };
  deps.extensions.timer = time.timer;
  await deps.store.recordExtensionInstall({ name: 'testext', version: manifest.version, now, workKinds: [work.kind] });
  const { runExtension } = await import('../src/extensions/run.js');
  const pending = runExtension({ ...deps, clock: time.clock }, { name: 'testext', job: 'report', waitMs: 100 });
  for (let i = 0; i < 20; i++) await Promise.resolve();
  time.advance(100);
  expect(await pending).toMatchObject({ ok: true, status: 'queued' });
});

it('설치 잠금 예외를 경로 없는 고정 저장소 오류로 반환한다', async () => {
  const { deps } = setup();
  deps.extensions.installedManifest = async () => JSON.stringify(manifest);
  deps.extensions.withInstallLock = async () => { throw new Error('private-path-canary'); };
  const { runExtension } = await import('../src/extensions/run.js');
  const result = await runExtension(deps, { name: 'testext', job: 'report' });
  expect(result).toEqual({ ok: false, code: 'DB_UNAVAILABLE', message: '확장 설치 잠금을 확보하지 못했습니다' });
  expect(JSON.stringify(result)).not.toContain('private-path-canary');
});

it('제거된 검증 스냅샷 선언을 거부한다', () => {
  const work = { kind: 'testext.verify', execution: 'supervised', runtime: 'python', entry: 'verify.py' };
  expect(decodeExtensionManifest(JSON.stringify({ ...manifest, work: [{ ...work, verification_snapshot: true }] })).ok).toBe(false);
  expect(decodeExtensionManifest(JSON.stringify({ ...manifest, work: [{ ...work, runtime: 'node', verification_snapshot: true }] })).ok).toBe(false);
  for (const value of [false, 'true', null, 1]) expect(decodeExtensionManifest(JSON.stringify({ ...manifest, work: [{ ...work, verification_snapshot: value }] })).ok).toBe(false);
});

it('requires declared, non-cyclic followup work', () => {
  const first={kind:'testext.collect',execution:'supervised',runtime:'python',entry:'src/collect.py',followup:'testext.artifacts'};
  const second={kind:'testext.artifacts',execution:'supervised',runtime:'python',entry:'src/artifacts.py'};
  expect(decodeExtensionManifest(JSON.stringify({...manifest,work:[first,second]})).ok).toBe(true);
  expect(decodeExtensionManifest(JSON.stringify({...manifest,work:[first]})).ok).toBe(false);
  expect(decodeExtensionManifest(JSON.stringify({...manifest,work:[first,{...second,followup:first.kind}]})).ok).toBe(false);
});

it('validates read-only command declarations before installing the extension', async () => {
  const command = { name: 'echo-stats', runtime: 'node', entry: 'bin/echo.mjs', description: '통계를 반환합니다', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 1000, risk: 'read' };
  expect(decodeExtensionManifest(JSON.stringify({ ...manifest, commands: [command] })).ok).toBe(true);
  for (const invalid of [
    { ...manifest, commands: [{ ...command, risk: 'write' }] },
    { ...manifest, commands: [command, command] },
    { ...manifest, commands: [{ ...command, name: 'echo_stats' }] },
    { ...manifest, commands: [{ ...command, input_schema: { type: 'nonsense' } }] },
    { ...manifest, commands: [{ ...command, entry: '../outside' }] },
    { ...manifest, name: 'test_ext', commands: [command] },
  ]) {
    expect(decodeExtensionManifest(JSON.stringify(invalid))).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  }
  const { deps, writes } = setup({ text: JSON.stringify({ ...manifest, commands: [{ ...command, risk: 'write' }] }) });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
  expect(writes()).toEqual({ placed: 0, migrated: 0 });
});

it('kills and reaps a live command leader if group inspection or signalling fails', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const { sampleSelfUserInput } = await import('../src/testing/index.js');
  const { deps } = setup();
  const launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  inspector.signalFailure = true;
  const command = { name: 'echo-stats', runtime: 'node', entry: 'bin/echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 15, risk: 'read' };
  await deps.store.ensureSelfUser(sampleSelfUserInput());
  await deps.store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now });
  Object.assign(deps.extensions, {
    launcher, inspector, installedDirectory: () => '/installed/testext', installedManifest: async () => JSON.stringify({ ...manifest, commands: [command] }),
    validateValue: () => true,
    timer: { sleep: (ms: number, signal: AbortSignal) => new Promise<void>(resolve => { const id = setTimeout(resolve, ms); signal.addEventListener('abort', () => { clearTimeout(id); resolve(); }, { once: true }); }) },
  });
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo-stats', input: {} })).toMatchObject({ ok: false, code: 'EXTENSION_COMMAND_CLEANUP_FAILED' });
  expect(launcher.processes[0]?.signals).toContain('SIGKILL');
  expect(launcher.processes[0]?.leaderExited).toBe(true);
});

it('prepares Python for command-only usage before migration and propagates failure', async () => {
  const command = { name: 'echo', runtime: 'python', entry: 'echo.py', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 100, risk: 'read' };
  const { deps, writes } = setup({ text: JSON.stringify({ ...manifest, commands: [command] }) });
  deps.extensions.preparePython = async () => ({ ok: false, code: 'EXTENSION_PYTHON_SYNC_FAILED', message: '실패' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_PYTHON_SYNC_FAILED' });
  expect(writes().migrated).toBe(0);
});

it('rechecks activation after discovery and never starts a stale command', async () => {
  const { executeExtensionCommand, extensionCommands } = await import('../src/extensions/commands.js');
  const { sampleSelfUserInput } = await import('../src/testing/index.js');
  const { deps, fake } = setup();
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 100, risk: 'read' };
  await deps.store.ensureSelfUser(sampleSelfUserInput()); await deps.store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now });
  Object.assign(deps.extensions, { installedDirectory: () => '/installed/testext', installedManifest: async () => JSON.stringify({ ...manifest, commands: [command] }), validateValue: () => true });
  const registry = await extensionCommands(deps); expect(registry.ok && registry.commands).toHaveLength(1);
  await deps.store.setExtensionEnabled({ name: 'testext', enabled: false, now });
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} })).toMatchObject({ ok: false, code: 'EXTENSION_COMMAND_UNAVAILABLE' });
  expect(fake.specs).toHaveLength(0);
});

it('honors pre-cancellation and bounds installation lock wait', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const { deps, fake } = setup();
  Object.assign(deps.extensions, { installedDirectory: () => '/installed/testext', installedManifest: async () => '{}', validateValue: () => true });
  const controller = new AbortController(); controller.abort();
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {}, signal: controller.signal })).toMatchObject({ ok: false, code: 'EXTENSION_COMMAND_TIMEOUT' });
  deps.extensions.timer = { sleep: async (ms, signal) => { if (ms === 30000 && !signal.aborted) return; await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }); }); } };
  deps.extensions.withInstallLock = async (_name, _run, signal) => { await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal?.addEventListener('abort', () => resolve(), { once: true }); }); throw new Error('cancelled'); };
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} })).toMatchObject({ ok: false, code: 'EXTENSION_COMMAND_TIMEOUT' });
  expect(fake.specs).toHaveLength(0);
});

it('counts slow process observation against timeout and cleans the leader', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const { sampleSelfUserInput } = await import('../src/testing/index.js');
  const { deps } = setup(); const launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const bootTime = inspector.bootTime; let observations = 0;
  inspector.bootTime = async () => ++observations === 1 ? new Promise(() => {}) : bootTime();
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 20, risk: 'read' };
  await deps.store.ensureSelfUser(sampleSelfUserInput()); await deps.store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now });
  const time = manualTime(now); deps.clock = time.clock;
  Object.assign(deps.extensions, { launcher, inspector, installedDirectory: () => '/installed/testext', installedManifest: async () => JSON.stringify({ ...manifest, commands: [command] }), validateValue: () => true, timer: time.timer });
  const pending = executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} });
  for (let i = 0; i < 100 && !launcher.processes.length; i++) await Promise.resolve();
  expect(launcher.processes).toHaveLength(1); for (let i = 0; i < 20; i++) await Promise.resolve();
  time.advance(19); for (let i = 0; i < 20; i++) await Promise.resolve(); expect(launcher.processes[0]?.leaderExited).toBe(false);
  let settled = false; void pending.then(() => { settled = true; });
  time.advance(1); for (let i = 0; i < 1000 && !settled; i++) await Promise.resolve();
  expect(settled).toBe(true);
  expect(time.clock.now().getTime()).toBe(now.getTime() + 20);
  expect(await pending).toMatchObject({ ok: false, code: 'EXTENSION_COMMAND_TIMEOUT' });
  expect(launcher.processes[0]?.leaderExited).toBe(true);
}, 5000);

it('returns EXTENSION_INVALID rather than throwing on a deeply nested schema', () => {
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 100, risk: 'read' };
  const text = JSON.stringify({ ...manifest, commands: [command] }).replace('"input_schema":{"type":"object"}', `"input_schema":${'{"type":"object","properties":{"x":'.repeat(15000)}{}${'}}'.repeat(15000)}`);
  expect(decodeExtensionManifest(text)).toMatchObject({ ok: false, code: 'EXTENSION_INVALID' });
});

it('serializes disable with preparation and the start of a command', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const { setExtensionEnabled } = await import('../src/extensions/status.js');
  const { sampleSelfUserInput } = await import('../src/testing/index.js');
  const { deps } = setup(); const launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 1000, risk: 'read' };
  await deps.store.ensureSelfUser(sampleSelfUserInput()); await deps.store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now });
  let releasePreparation!: () => void, prepared!: () => void;
  const preparing = new Promise<void>(resolve => { prepared = resolve; });
  const gate = new Promise<void>(resolve => { releasePreparation = resolve; });
  let tail: Promise<void> = Promise.resolve();
  const lock = async <T>(_name: string, run: () => Promise<T>): Promise<T> => {
    const prior = tail; let release!: () => void; tail = new Promise<void>(resolve => { release = resolve; });
    await prior; try { return await run(); } finally { release(); }
  };
  const events: string[] = [];
  const wrappedLauncher: ProcessLauncher = { async start(spec) { events.push('start'); const result = await launcher.start(spec); if (result.ok) { const child = launcher.processes.at(-1)!; child.write('{}'); child.exit(0); } return result; } };
  Object.assign(deps.extensions, { withCommandLock: lock, withInstallLock: lock, launcher: wrappedLauncher, inspector, installedDirectory: () => '/installed/testext', installedManifest: async () => JSON.stringify({ ...manifest, commands: [command] }), validateValue: () => true,
    databaseUrl: async () => { prepared(); await gate; return 'postgres://fixture'; } });
  const execution = executeExtensionCommand(deps, { name:'testext', command:'echo', input:{} }); await preparing;
  let disabled = false;
  const disable = setExtensionEnabled(deps, { name:'testext', enabled:false }).then(result => { disabled = true; events.push('disabled'); return result; });
  for (let i=0;i<50;i++) await Promise.resolve(); expect(disabled).toBe(false); expect(launcher.specs).toHaveLength(0);
  releasePreparation(); expect(await execution).toMatchObject({ ok:true }); expect(await disable).toMatchObject({ ok:true, enabled:false });
  expect(events).toEqual(['start', 'disabled']);
  expect(await executeExtensionCommand(deps, { name:'testext', command:'echo', input:{} })).toMatchObject({ ok:false, code:'EXTENSION_COMMAND_UNAVAILABLE' });
  expect(launcher.specs).toHaveLength(1);
});

it('rejects nonfinite SDK input and output even with loose object schemas', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const { sampleSelfUserInput } = await import('../src/testing/index.js');
  const { deps } = setup(); const launcher = fakeProcessLauncher(), inspector = fakeProcessInspector(launcher);
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type:'object' }, output_schema: { type:'object' }, timeout_ms: 1000, risk:'read' };
  await deps.store.ensureSelfUser(sampleSelfUserInput()); await deps.store.recordExtensionInstall({ name:'testext', version:'0.1.0', now });
  const wrappedLauncher: ProcessLauncher = { async start(spec) { const result = await launcher.start(spec); if (result.ok) { const child = launcher.processes.at(-1)!; child.write('{"nested":{"value":1e400}}'); child.exit(0); } return result; } };
  Object.assign(deps.extensions, { launcher: wrappedLauncher, inspector, installedDirectory: () => '/installed/testext', installedManifest: async () => JSON.stringify({ ...manifest, commands:[command] }), validateValue: () => true });
  expect(await executeExtensionCommand(deps, { name:'testext', command:'echo', input:{ value:Infinity } })).toMatchObject({ ok:false, code:'EXTENSION_COMMAND_INPUT_INVALID' });
  expect(launcher.specs).toHaveLength(0);
  expect(await executeExtensionCommand(deps, { name:'testext', command:'echo', input:{} })).toMatchObject({ ok:false, code:'EXTENSION_COMMAND_OUTPUT_INVALID' });
});

it('refuses an installation check without self before launching a child', async () => {
  const { deps, fake } = setup({ missingSelf: true });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'USER_MISSING' });
  expect(fake.specs).toEqual([]);
});

it('reinstallation preserves changed settings and inserts newly declared defaults', async () => {
  const first = { ...manifest, settings: [{ key: 'testext.old', type: 'string', required: [], default: 'original' }] };
  const { deps } = setup({ text: JSON.stringify(first) });
  deps.extensions.readSecrets = async () => ({});
  expect((await installExtension(deps, { name: 'testext' })).ok).toBe(true);
  const userId = '019a0000-0000-7000-8000-000000000001';
  await deps.store.setSetting({ userId, key: 'testext.old', value: 'changed', updatedAt: now });
  deps.extensions.packages.resolve = async () => ({ ok: true, dir: '/packages/testext', manifestText: JSON.stringify({ ...first, settings: [...first.settings, { key: 'testext.new', type: 'string', required: [], default: 'new' }] }) });
  expect((await installExtension(deps, { name: 'testext' })).ok).toBe(true);
  expect(await deps.store.getSetting({ userId, key: 'testext.old' })).toMatchObject({ setting: { value: 'changed' } });
  expect(await deps.store.getSetting({ userId, key: 'testext.new' })).toMatchObject({ setting: { value: 'new' } });
});

it('missing self before auth records login failure without enqueuing or launching', async () => {
  const text = JSON.stringify({ ...manifest, auth: { kind: 'testext.login', execution: 'supervised', runtime: 'node', entry: 'login.mjs' } });
  const { deps, fake } = setup({ text, missingSelf: true });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'USER_MISSING' });
  expect(deps.store.snapshot().workItems).toEqual([]); expect(fake.specs).toEqual([]);
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { failedStage: 'login', stages: { login: { status: 'failed', code: 'USER_MISSING' } } } } });
});

it('records configuration failure when default insertion fails', async () => {
  const text = JSON.stringify({ ...manifest, settings: [{ key: 'testext.value', type: 'string', required: [], default: 'value' }] });
  const { deps } = setup({ text });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.store.insertSetting = async () => ({ ok: false, code: 'DB_LOCKED', message: 'locked' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { failedStage: 'configuration', stages: { configuration: { status: 'failed', code: 'DB_LOCKED' } } } } });
});

it('records configuration failure when self lookup fails', async () => {
  const { deps } = setup();
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.store.readSelfUser = async () => ({ ok: false, code: 'DB_LOCKED', message: 'locked' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'DB_LOCKED' });
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { failedStage: 'configuration', stages: { configuration: { status: 'failed', code: 'DB_LOCKED' } } } } });
});

it.each(['DB_LOCKED', 'DB_UNAVAILABLE'] as const)('self lookup %s stops installation without starting a child', async code => {
  const { deps, fake } = setup();
  deps.store.readSelfUser = async () => ({ ok: false, code, message: 'self lookup failed' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code, message: 'self lookup failed' });
  expect(fake.specs).toEqual([]);
});

it('records configuration failure when scoped settings lookup fails', async () => {
  const text = JSON.stringify({ ...manifest, settings: [{ key: 'testext.value', type: 'string', required: [] }] });
  const { deps } = setup({ text });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.extensions.readSecrets = async () => ({});
  deps.store.getSettings = async () => ({ ok: false, code: 'DB_LOCKED', message: 'locked' });
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'DB_LOCKED', message: '확장 설정을 읽을 수 없습니다' });
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { failedStage: 'configuration', stages: { configuration: { status: 'failed', code: 'DB_LOCKED' } } } } });
});
it('manifest cron·legacy·키 중복과 놓친 회차 정책을 검증한다', () => {
 const work={kind:'testext.sync',execution:'supervised',runtime:'node',entry:'sync.mjs'};
 const base={...manifest,work:[work]}, schedule={kind:'testext.sync',target_kind:'account',target_id:'default'};
 for(const entry of [{...schedule,local_time:'09:00'},{...schedule,key:'weekly',cron:'0 9 * * 5',time_zone:'Asia/Seoul'}]) expect(decodeExtensionManifest(JSON.stringify({...base,default_schedules:[entry]})).ok).toBe(true);
 for(const entries of [[schedule],[{...schedule,cron:'0 9 * * *',local_time:'09:00'}],[{...schedule,cron:'0 0 9 * * *'}],[{...schedule,local_time:'09:00'},{...schedule,key:'testext.sync:account:default',cron:'0 9 * * *'}]])expect(decodeExtensionManifest(JSON.stringify({...base,default_schedules:entries})).ok).toBe(false);
 expect(decodeExtensionManifest(JSON.stringify({...base,work:[{...work,missed:'later'}]})).ok).toBe(false);
});
it('유효하지 않은 cron 또는 시간대는 복사와 마이그레이션 전에 거부한다',async()=>{
 const work={kind:'testext.sync',execution:'supervised',runtime:'node',entry:'sync.mjs'};
 for(const schedule of [{kind:'testext.sync',target_kind:'account',target_id:'a',cron:'99 9 * * *'}, {kind:'testext.sync',target_kind:'account',target_id:'a',cron:'0 9 * * *',time_zone:'Invalid/Zone'}]) {
  const {deps,writes}=setup({text:JSON.stringify({...manifest,work:[work],default_schedules:[schedule]})});
  expect(await installExtension(deps,{name:'testext'})).toMatchObject({ok:false,code:'EXTENSION_INVALID'});expect(writes()).toEqual({placed:0,migrated:0});
 }
});

it.each(['digest', 'migration', 'activate', 'registry', 'commit', 'release'] as const)('recovers a fenced transition after injected %s failure', async failure => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const { extensionTransitions } = await import('../../../apps/cli/src/runtime/extension-transition.js');
  const home = await mkdtemp(join(tmpdir(), 'brain-transition-install-'));
  try {
    const source = join(home, 'packages', 'testext'), target = join(home, 'extensions', 'testext');
    await mkdir(source, { recursive: true }); await writeFile(join(source, 'code'), 'new');
    const { deps } = setup(); const real = extensionTransitions(home), events: string[] = [];
    let injected = false;
    const stop = (point: string) => { if (point === failure && !injected) { injected = true; throw new Error('injected'); } };
    const originalRecord = deps.store.recordExtensionInstall.bind(deps.store);
    deps.store.recordExtensionInstall = async input => { events.push('registry'); stop('registry'); return originalRecord(input); };
    const originalRelease = deps.store.endExtensionQuiesce.bind(deps.store);
    deps.store.endExtensionQuiesce = async input => { events.push('release'); stop('release'); return originalRelease(input); };
    deps.extensions.packages = {
      async resolve() { return { ok: true, dir: source, manifestText: JSON.stringify(manifest) }; },
      async place() { throw new Error('legacy path'); },
      async inspect(_name, dir) {
        const installed = await readFile(join(target, 'code'), 'utf8').then(() => 'a'.repeat(64), () => null);
        await readFile(join(dir, 'code'));
        const corruptStage = failure === 'digest' && dir.endsWith('/new') && !injected;
        if (corruptStage) injected = true;
        return { digest: (corruptStage ? 'b' : 'a').repeat(64), installedDigest: installed, sameBase: false, installedDir: target };
      },
      transition: {
        ...real,
        async activate(name, owner) { events.push('activate'); stop('activate'); return real.activate(name, owner); },
        async commit(name, owner) { events.push('commit'); stop('commit'); return real.commit(name, owner); },
      },
    };
    deps.extensions.migrator = { async apply() {
      events.push('migration');
      if (failure === 'migration' && !injected) { injected = true; return { ok: false, code: 'MIGRATION_FAILED', message: 'synthetic' }; }
      return { ok: true, from: 0, to: 1, applied: [] };
    } };
    const first = await installExtension(deps, { name: 'testext' }); expect(first.ok).toBe(false);
    const gate = await deps.store.readExtensionQuiesce('testext'); expect(gate).toMatchObject({ ok: true, owner: expect.any(String) });
    const resumed = await installExtension(deps, { name: 'testext' }); expect(resumed.ok).toBe(true);
    expect(await deps.store.readExtensionQuiesce('testext')).toMatchObject({ ok: true, owner: null });
    expect(await readFile(join(target, 'code'), 'utf8')).toBe('new');
    expect(events.indexOf('migration')).toBeLessThan(events.indexOf('activate'));
    expect(events.lastIndexOf('registry')).toBeLessThan(events.lastIndexOf('release'));
    expect(await real.read('testext')).toBeNull();
  } finally { await rm(home, { recursive: true, force: true }); }
});

it.each(['before', 'during', 'after-result'] as const)('외부 snapshot %s 취소는 구조화된 취소와 정리를 반환한다', async phase => {
  const { deps, writes } = setup(); const controller = new AbortController(); let calls = 0, cleaned = 0, locks = 0;
  deps.extensions.packages.checkCore = async () => {};
  deps.extensions.packages.prepareExternal = async (_path, options) => {
    calls++; expect(options?.signal).toBe(controller.signal);
    if (phase === 'during') { controller.abort(); throw new Error('cancelled'); }
    if (phase === 'after-result') controller.abort();
    return { name: 'testext', dir: '/snapshot', manifestText: JSON.stringify(manifest), digest: 'a'.repeat(64), async cleanup() { cleaned++; } };
  };
  deps.extensions.withHomeInstallLock = async run => { locks++; return run(); };
  if (phase === 'before') controller.abort();
  expect(await installExtension(deps, { packagePath: '/synthetic', signal: controller.signal })).toMatchObject({ ok: false, code: 'EXTENSION_INSTALL_CANCELLED' });
  expect(calls).toBe(phase === 'before' ? 0 : 1); expect(cleaned).toBe(phase === 'after-result' ? 1 : 0); expect(locks).toBe(0); expect(writes()).toEqual({ placed: 0, migrated: 0 });
});

it('preserves consumer-specific snapshot errors and required keys', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 100, risk: 'read' };
  const settings = [{ key: 'testext.required', type: 'string', required: ['connect', 'work'] }];
  const text = JSON.stringify({ ...manifest, settings, commands: [command] });
  const { deps, fake } = setup({ text, output: '{"answer":42}' });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  deps.extensions.readSecrets = async () => ({});
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CONFIG_INVALID' });
  expect(fake.specs).toHaveLength(0);
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { failedStage: 'configuration', stages: { configuration: { status: 'failed', code: 'EXTENSION_CONFIG_INVALID' } } } } });
  await deps.store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now });
  Object.assign(deps.extensions, { installedDirectory: () => '/installed/testext', installedManifest: async () => text, validateValue: () => true });
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} })).toEqual({ ok: true, data: { answer: 42 } });
  expect(JSON.parse(fake.specs[0]!.stdin!)).toMatchObject({ user_id: '019a0000-0000-7000-8000-000000000001', settings: {}, input: {} });
  fake.specs.length = 0;
  deps.store.getSettings = async () => ({ ok: false, code: 'DB_LOCKED', message: 'locked' });
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} })).toMatchObject({ ok: false, code: 'DB_LOCKED', message: 'locked' });
  expect(fake.specs).toHaveLength(0);
  deps.extensions.readSecrets = undefined;
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} })).toMatchObject({ ok: false, code: 'EXTENSION_CONFIG_INVALID', message: '확장 명령을 실행할 수 없습니다' });
  expect(fake.specs).toHaveLength(0);
});

it.each(['capability', 'secret'] as const)('installation records %s configuration failure before launching', async failure => {
  const text = JSON.stringify({ ...manifest, settings: [{ key: 'testext.token', type: 'string', secret: true, required: [] }] });
  const { deps, fake } = setup({ text });
  deps.extensions.packages.inspect = async () => ({ digest: 'a'.repeat(64), installedDigest: null, sameBase: false, installedDir: '/installed/testext' });
  if (failure === 'secret') deps.extensions.readSecrets = async () => { throw new Error('synthetic'); };
  expect(await installExtension(deps, { name: 'testext' })).toMatchObject({ ok: false, code: 'EXTENSION_CONFIG_INVALID' });
  expect(fake.specs).toEqual([]);
  expect(await deps.store.getExtensionInstallProgress('testext')).toMatchObject({ ok: true, journal: { progress: { failedStage: 'configuration', stages: { configuration: { status: 'failed', code: 'EXTENSION_CONFIG_INVALID' } } } } });
});

it('command propagates invalid secret snapshot without launching', async () => {
  const { executeExtensionCommand } = await import('../src/extensions/commands.js');
  const command = { name: 'echo', runtime: 'node', entry: 'echo.mjs', description: '조회', input_schema: { type: 'object' }, output_schema: { type: 'object' }, timeout_ms: 100, risk: 'read' };
  const text = JSON.stringify({ ...manifest, commands: [command], settings: [{ key: 'testext.token', type: 'string', secret: true, required: [] }] });
  const { deps, fake } = setup();
  await deps.store.recordExtensionInstall({ name: 'testext', version: '0.1.0', now });
  await deps.store.setSetting({ userId: '019a0000-0000-7000-8000-000000000001', key: 'testext.token', value: 'REF', updatedAt: now });
  Object.assign(deps.extensions, { installedDirectory: () => '/installed/testext', installedManifest: async () => text, validateValue: () => true, readSecrets: async () => ({}) });
  expect(await executeExtensionCommand(deps, { name: 'testext', command: 'echo', input: {} })).toEqual({ ok: false, code: 'EXTENSION_CONFIG_INVALID', retryable: false, message: '확장 설정을 확인하세요' });
  expect(fake.specs).toEqual([]);
});

it('validates a user string target setting and the capability allowlist', () => {
  const work = [{kind:'testext.sync', execution:'supervised', runtime:'node', entry:'bin/work.mjs'}];
  const setting = {key:'testext.account', type:'string', scope:'user', required:[]};
  const schedule = {kind:'testext.sync', target_kind:'account', target_id:'unselected', target_setting:'testext.account', cron:'0 11 * * *', time_zone:'Asia/Seoul'};
  const candidate = {...manifest, work, settings:[setting], default_schedules:[schedule], requires:['channel.send']};
  expect(decodeExtensionManifest(JSON.stringify(candidate)).ok).toBe(true);
  for (const changed of [
    {...candidate, requires:['channel.send','channel.send']}, {...candidate, requires:['other.capability']},
    {...candidate, settings:[]}, {...candidate, settings:[{...setting,type:'number'}]},
    {...candidate, settings:[{...setting,scope:'global'}]}, {...candidate, settings:[{...setting,secret:true}]},
    {...candidate, default_schedules:[{...schedule,target_setting:'other.account'}]},
  ]) expect(decodeExtensionManifest(JSON.stringify(changed)).ok).toBe(false);
});

it('installs target-setting schedules without overwriting a previously installed key', async () => {
  const work={kind:'testext.sync',execution:'supervised',runtime:'node',entry:'bin/work.mjs'};
  const text=JSON.stringify({...manifest,work:[work],settings:[{key:'testext.account',type:'string',scope:'user',required:[]}],requires:['channel.send'],default_schedules:[{key:'daily',kind:work.kind,target_kind:'account',target_id:'unselected',target_setting:'testext.account',cron:'0 11 * * *',time_zone:'Asia/Seoul'}]});
  const {deps}=setup({text});
  deps.extensions.schedulerReady=async()=>true;
  const installed=await installExtension({...deps,readTimeZone:async()=>({ok:true as const,value:'Asia/Seoul'})},{name:'testext'});
  expect(installed.ok).toBe(true);
  const user='019a0000-0000-7000-8000-000000000001';
  expect(await deps.store.findScheduleByKey({extension:'testext',scheduleKey:'daily',userId:user})).toMatchObject({ok:true,schedule:{targetSetting:'testext.account'}});
});

it('requires a valid same-target same-zone predecessor schedule key', () => {
  const work=['collect','report'].map(name=>({kind:`testext.${name}`,execution:'supervised',runtime:'node',entry:'bin/work.mjs'}));
  const settings=[{key:'testext.account',type:'string',scope:'user',required:[]}];
  const base={target_kind:'account',target_id:'unselected',target_setting:'testext.account',time_zone:'Asia/Seoul'};
  const parent={...base,key:'collect',kind:'testext.collect',cron:'0 11 * * *'};
  const child={...base,key:'report',kind:'testext.report',cron:'30 11 * * *',after_schedule:'collect'};
  const valid={...manifest,work,settings,default_schedules:[parent,child]};
  expect(decodeExtensionManifest(JSON.stringify(valid)).ok).toBe(true);
  for(const bad of [{...child,after_schedule:'missing'},{...child,after_schedule:'report'},{...child,time_zone:'UTC'},{...child,target_kind:'other'}, {...child,target_setting:undefined}])
    expect(decodeExtensionManifest(JSON.stringify({...valid,default_schedules:[parent,bad]})).ok).toBe(false);
});
