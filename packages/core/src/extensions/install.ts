import { failureText } from '../domain/failure.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ExtensionStore } from '../ports/store.js';
import type { ProcessInspector, ProcessLauncher } from '../ports/process.js';
import { PROCESS_ABI_ENV } from '../process-abi/codec.js';
import { decodeExtensionManifest, isExtensionName } from './manifest.js';
import { runExtensionCheck } from './check.js';
import { extensionStatus } from './status.js';
export interface ExtensionPackages {
  resolve(name: string): Promise<{ ok: true; dir: string; manifestText: string } | { ok: false }>;
  place(name: string, dir: string): Promise<string>;
}
export interface ExtensionMigrator {
  apply(owner: string, directory: string): Promise<{ ok: true; from: number; to: number; applied: string[] } | { ok: false; code: 'MIGRATION_FAILED' | 'DB_UNAVAILABLE'; message: string; file?: string }>;
}
export interface ExtensionRuntime {
  packages: ExtensionPackages; migrator: ExtensionMigrator; launcher: ProcessLauncher; inspector: ProcessInspector; timer: Timer;
  databaseUrl(): string | Promise<string>;
}
export interface ExtensionDependencies { store: ExtensionStore; clock: Clock; idGen: IdGen; extensions?: ExtensionRuntime }
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
  const migrated = await runtime.migrator.apply(name, `${installedDir}/${manifest.migrations}`);
  if (!migrated.ok) return migrated;
  const recorded = await deps.store.recordExtensionInstall({ name, version: manifest.version, now: deps.clock.now() });
  if (!recorded.ok) return recorded;
  const env = {
    [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: await runtime.databaseUrl(),
    [PROCESS_ABI_ENV.workId]: deps.idGen.next(), [PROCESS_ABI_ENV.attemptToken]: deps.idGen.next(),
    [PROCESS_ABI_ENV.workKind]: `${name}.connection_check`, [PROCESS_ABI_ENV.targetKind]: 'extension',
    [PROCESS_ABI_ENV.targetId]: name, [PROCESS_ABI_ENV.runGeneration]: '1',
  };
  const verdict = await runExtensionCheck({ ...runtime, clock: deps.clock, spec: { command: manifest.connection_check.runtime, args: [`${installedDir}/${manifest.connection_check.entry}`], env } });
  const connection = await deps.store.recordExtensionConnection({ name, status: verdict.outcome === 'succeeded' ? 'connected' : 'failed', checkedAt: deps.clock.now(), code: verdict.code ?? null, message: verdict.message === undefined ? null : failureText(verdict.message.replaceAll('\u0000', '\ufffd')) });
  if (!connection.ok) return connection;
  const result = await extensionStatus(deps, { name });
  if (!result.ok) return result;
  return verdict.outcome === 'succeeded' ? result : { ...result, ok: false as const, code: 'EXTENSION_CHECK_FAILED' as const, message: '확장 연결 확인에 실패했습니다' };
}
