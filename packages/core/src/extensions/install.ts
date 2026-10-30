import { failureText } from '../domain/failure.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ExtensionStore } from '../ports/store.js';
import type { ProcessInspector, ProcessLauncher } from '../ports/process.js';
import { PROCESS_ABI_ENV } from '../process-abi/codec.js';
import { decodeExtensionManifest, isExtensionName } from './manifest.js';
import { createExtensionSnapshot } from './snapshot.js';
import type { SettingsStore } from '../ports/store.js';
import { runExtensionCheck } from './check.js';
import { extensionStatus } from './status.js';
export interface ExtensionPackages {
  resolve(name: string): Promise<{ ok: true; dir: string; manifestText: string } | { ok: false }>;
  place(name: string, dir: string): Promise<string>;
  rollback?(name: string): Promise<void>;
}
export interface ExtensionMigrator {
  apply(owner: string, directory: string): Promise<{ ok: true; from: number; to: number; applied: string[] } | { ok: false; code: 'MIGRATION_FAILED' | 'DB_UNAVAILABLE'; message: string; file?: string }>;
}
export interface ExtensionRuntime {
  packages: ExtensionPackages; migrator: ExtensionMigrator; launcher: ProcessLauncher; inspector: ProcessInspector; timer: Timer;
  preparePython?(directory: string): Promise<{ ok: true } | { ok: false; code: 'EXTENSION_PYTHON_PIN_INVALID' | 'EXTENSION_UV_NOT_FOUND' | 'EXTENSION_PYTHON_NOT_FOUND' | 'EXTENSION_PYTHON_SYNC_FAILED' | 'EXTENSION_PYTHON_VERSION_MISMATCH'; message: string }>;
  databaseUrl(): string | Promise<string>;
  readSecrets?(): Promise<Readonly<Record<string, string>>>;
  machineValues?(name: string): Readonly<Record<string, string>>;
}
export interface ExtensionDependencies { store: ExtensionStore & Partial<SettingsStore>; clock: Clock; idGen: IdGen; extensions?: ExtensionRuntime }
export async function installExtension(deps: ExtensionDependencies, { name }: { name: string }) {
  if (!isExtensionName(name)) return { ok: false as const, code: 'EXTENSION_NOT_FOUND' as const, message: '확장 이름이 이름 규칙에 맞지 않습니다' };
  const runtime = deps.extensions;
  if (!runtime) return { ok: false as const, code: 'CONFIG_INVALID' as const, message: '확장 실행 환경이 설정되지 않았습니다' };
  let source: Awaited<ReturnType<ExtensionPackages['resolve']>>;
  try { source = await runtime.packages.resolve(name); }
  catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 패키지의 manifest를 읽지 못했습니다' }; }
  if (!source.ok) return { ok: false as const, code: 'EXTENSION_NOT_FOUND' as const, message: '지정한 확장 패키지가 없습니다' };
  const decoded = decodeExtensionManifest(source.manifestText);
  if (!decoded.ok) return decoded;
  const manifest = decoded.manifest;
  const folderName = source.dir.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  if (manifest.name !== name || folderName !== name) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '요청한 이름과 manifest 및 패키지 폴더 이름이 다릅니다' };
  let installedDir: string;
  try { installedDir = await runtime.packages.place(name, source.dir); }
  catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 패키지를 설치 폴더에 복사하지 못했습니다' }; }
  const needsPython = [manifest.connection_check, ...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])].some(command => command.runtime === 'python');
  if (needsPython) {
    const prepared = runtime.preparePython ? await runtime.preparePython(installedDir) : { ok: false as const, code: 'EXTENSION_UV_NOT_FOUND' as const, message: 'uv를 찾을 수 없습니다' };
    if (!prepared.ok) await runtime.packages.rollback?.(name);
    const recordedEnvironment = await deps.store.recordExtensionPythonEnvironment({ name, status: prepared.ok ? 'succeeded' : 'failed', code: prepared.ok ? null : prepared.code, checkedAt: deps.clock.now() });
    if (!recordedEnvironment.ok) { if (prepared.ok) await runtime.packages.rollback?.(name); return recordedEnvironment; }
    if (!prepared.ok) { const status = await extensionStatus(deps, { name }); return status.ok ? { ...status, ...prepared } : status; }
  }
  const migrated = await runtime.migrator.apply(name, `${installedDir}/${manifest.migrations}`);
  if (!migrated.ok) return migrated;
  const recorded = await deps.store.recordExtensionInstall({ name, version: manifest.version, now: deps.clock.now(), workKinds: [...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])].map(work => work.kind) });
  if (!recorded.ok) return recorded;
  const configFailure = async () => {
    const message = '확장 설정을 확인하세요';
    const recordedFailure = await deps.store.recordExtensionConnection({ name, status: 'failed', checkedAt: deps.clock.now(), code: 'EXTENSION_CONFIG_INVALID', message });
    return recordedFailure.ok ? { ok: false as const, code: 'EXTENSION_CONFIG_INVALID' as const, retryable: false as const, message } : recordedFailure;
  };
  const declarations = manifest.settings ?? [];
  let values: Record<string, string> = {};
  if (declarations.length) {
    if (!deps.store.getSettings || !runtime.readSecrets) return configFailure();
    const read = await deps.store.getSettings({ keys: declarations.map(setting => setting.key) });
    if (!read.ok) return { ok: false as const, code: read.code, message: '확장 설정을 읽을 수 없습니다' };
    values = Object.fromEntries(read.settings.map(setting => [setting.key, setting.value]));
  }
  let secrets: Readonly<Record<string, string>> = {};
  try { if (declarations.some(setting => setting.secret)) secrets = await runtime.readSecrets!(); }
  catch { return configFailure(); }
  const snapshot = createExtensionSnapshot({ extension: name, stage: 'connect', declarations, settings: values, secrets, machine: runtime.machineValues?.(name) ?? {} });
  if (!snapshot.ok) return configFailure();
  let databaseUrl: string;
  try { databaseUrl = await runtime.databaseUrl(); } catch { return configFailure(); }
  const env = {
    [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: databaseUrl,
    [PROCESS_ABI_ENV.workId]: deps.idGen.next(), [PROCESS_ABI_ENV.attemptToken]: deps.idGen.next(),
    [PROCESS_ABI_ENV.workKind]: `${name}.connection_check`, [PROCESS_ABI_ENV.targetKind]: 'extension',
    [PROCESS_ABI_ENV.targetId]: name, [PROCESS_ABI_ENV.runGeneration]: '1',
    BRAIN_SETTINGS_SNAPSHOT: snapshot.serialized,
  };
  const verdict = await runExtensionCheck({ ...runtime, clock: deps.clock, protection: { extension: name, declarations: Object.fromEntries(declarations.map(setting => [setting.key, setting.type])), errorCodes: manifest.error_codes ?? [], required: declarations.filter(setting => setting.required.includes('connect')).map(setting => setting.key), secrets: declarations.filter(setting => setting.secret).map(setting => setting.key) }, spec: { command: manifest.connection_check.runtime === 'python' ? `${installedDir}/.venv/bin/python` : 'node', args: [`${installedDir}/${manifest.connection_check.entry}`], env } });
  const connection = await deps.store.recordExtensionConnection({ name, status: verdict.outcome === 'succeeded' ? 'connected' : 'failed', checkedAt: deps.clock.now(), code: verdict.code ?? null, message: verdict.message === undefined ? null : failureText(verdict.message.replaceAll('\u0000', '\ufffd')) });
  if (!connection.ok) return connection;
  const result = await extensionStatus(deps, { name });
  if (!result.ok) return result;
  return verdict.outcome === 'succeeded' ? result : { ...result, ok: false as const, code: 'EXTENSION_CHECK_FAILED' as const, message: '확장 연결 확인에 실패했습니다' };
}
