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
  expect(JSON.parse(fake.specs[0]!.env['BRAIN_SETTINGS_SNAPSHOT']!)).toEqual({ version: 1, extension: 'testext', values: {} });
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
  await deps.store.setSetting({ key: 'testext.token', value: 'REF', updatedAt: now });
  const result = await installExtension(deps, { name: 'testext' });
  expect(result.ok).toBe(true);
  expect(JSON.parse(fake.specs[0]!.env.BRAIN_SETTINGS_SNAPSHOT!)).toEqual({ version: 1, extension: 'testext', values: { 'testext.token': '  synthetic-secret  ', 'testext.limit': 10 } });
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
  const verdict = await runExtensionCheck({ ...deps.extensions, clock: deps.clock, spec: { command: 'node', args: [], env: { ...env, BRAIN_SETTINGS_SNAPSHOT: '{"version":1,"extension":"testext","values":{}}' } }, protection: { extension: 'testext', declarations: {}, errorCodes: [] } });
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
