import { resolveSelfUser } from '../users/self.js';
import type { ExtensionInstallProgress, InstallStage } from './install-progress.js';
import { failureText } from '../domain/failure.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import { ensureSchedule, type ReadTimeZone } from '../queue/schedules.js';
import type { ExtensionStore, WorkStore, ScheduleStore, UserStore } from '../ports/store.js';
import type { ProcessInspector, ProcessLauncher } from '../ports/process.js';
import { PROCESS_ABI_ENV } from '../process-abi/codec.js';
import { decodeExtensionManifest, isExtensionName, type ExtensionManifest } from './manifest.js';
import { acquireExtensionSnapshot } from './snapshot.js';
import type { SettingsStore } from '../ports/store.js';
import { runExtensionCheck } from './check.js';
import { extensionStatus } from './status.js';
import { quiesceExtension } from './quiesce.js';
export function comparePackageVersion(a: string, b: string): number | null {
  const valid = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/;
  if (!valid.test(a) || !valid.test(b)) return null;
  const left = a.split('.').map(BigInt), right = b.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) { if (left[i]! < right[i]!) return -1; if (left[i]! > right[i]!) return 1; }
  return 0;
}
export interface ExtensionPackages {
  resolve(name: string): Promise<{ ok: true; dir: string; manifestText: string } | { ok: false }>;
  prepareExternal?(path: string, options?: { signal?: AbortSignal }): Promise<{ name: string; dir: string; manifestText: string; digest: string; cleanup(): Promise<void> }>;
  checkCore?(manifest: ExtensionManifest): Promise<void>;
  checkInstalledCore?(): Promise<void>;
  captureRunningCore?(): Promise<void>;
  preflight?(directory: string, manifest: ExtensionManifest): Promise<{ ok: true } | { ok: false; code: 'EXTENSION_INVALID' | 'EXTENSION_PYTHON_PIN_INVALID'; message: string }>;
  observe?(input: { name: string; version: string; pluginVersion: string; digest: string }): Promise<void>;
  readObservation?(name: string): Promise<{ name: string; version: string; pluginVersion: string; digest: string } | null>;
  /** All transition calls require both installation locks and a caller-owned quiesce gate. */
  transition?: {
    read(name: string): Promise<{ name: string; owner: string; digest: string; phase: 'preparing' | 'prepared' | 'discarding' | 'switching' | 'active' | 'committing' | 'rolling_back' | 'rolled_back'; hadPrevious: boolean | null } | null>;
    prepare(input: { name: string; owner: string; digest: string; directory: string }): Promise<unknown>;
    stagedDirectory(name: string, owner: string): Promise<string>;
    refreshPreparedMigrations(input: { name: string; owner: string; source: string; migrations: string; digest: string; verify(stage: string): Promise<boolean> }): Promise<void>;
    activate(name: string, owner: string): Promise<string>;
    commit(name: string, owner: string): Promise<void>;
    rollback(name: string, owner: string): Promise<void>;
  };
  place(name: string, dir: string): Promise<string>;
  finalizePlacement?(name: string): Promise<void>;
  rollback?(name: string, preserveInitial?: boolean): Promise<void>;
  inspect?(name: string, dir: string, migrations: string, files?: readonly string[], stageOwner?: string): Promise<{ digest: string; installedDigest: string | null; sameBase: boolean; installedDir: string }>;
  refreshMigrations?(name: string, dir: string, migrations: string): Promise<void>;
  sameBase?(first: string, second: string, migrations: string): Promise<boolean>;
}
export interface ExtensionMigrator {
  apply(owner: string, directory: string): Promise<{ ok: true; from: number; to: number; applied: string[] } | { ok: false; code: 'MIGRATION_FAILED' | 'DB_UNAVAILABLE'; message: string; file?: string }>;
}
export interface ExtensionRuntime {
  installedDirectory?(name: string): string;
  validateValue?(schema: Record<string, unknown>, value: unknown): boolean;
  validateSchema?(schema: Record<string, unknown>): boolean;
  installedManifest?(name: string): Promise<string>;
  readPublicReport?(name: string, workId: string): Promise<unknown>;
  schedulerReady?(): Promise<boolean>;
  secureCredentials?(name: string): Promise<void>;
  withCommandLock?<T>(name: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  withHomeInstallLock?<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  withInstallLock?<T>(name: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  provision?(name: string): Promise<{ ok: true } | { ok: false; code: 'DB_UNAVAILABLE'; message: string }>;
  packages: ExtensionPackages; migrator: ExtensionMigrator; launcher: ProcessLauncher; inspector: ProcessInspector; timer: Timer;
  preparePython?(directory: string, signal?: AbortSignal, resetOwnedStage?: boolean): Promise<{ ok: true } | { ok: false; code: 'EXTENSION_INSTALL_CANCELLED' | 'EXTENSION_PYTHON_PIN_INVALID' | 'EXTENSION_UV_NOT_FOUND' | 'EXTENSION_PYTHON_NOT_FOUND' | 'EXTENSION_PYTHON_SYNC_FAILED' | 'EXTENSION_PYTHON_VERSION_MISMATCH'; message: string }>;
  validatePreparedPython?(directory: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; code: 'EXTENSION_INSTALL_CANCELLED' | 'EXTENSION_PYTHON_PIN_INVALID' | 'EXTENSION_UV_NOT_FOUND' | 'EXTENSION_PYTHON_NOT_FOUND' | 'EXTENSION_PYTHON_SYNC_FAILED' | 'EXTENSION_PYTHON_VERSION_MISMATCH'; message: string }>;
  databaseUrl(name: string): string | Promise<string>;
  readSecrets?(): Promise<Readonly<Record<string, string>>>;
  machineValues?(name: string): Readonly<Record<string, string>>;
}
export interface ExtensionDependencies { cron?: import('../ports/cron.js').CronCalculator; store: ExtensionStore & Partial<SettingsStore & WorkStore & ScheduleStore & Pick<UserStore, 'readSelfUser'>>; readTimeZone?: ReadTimeZone; clock: Clock; idGen: IdGen; extensions?: ExtensionRuntime }
export async function installExtension(deps: ExtensionDependencies, input: { name?: string; packagePath?: string; signal?: AbortSignal }) {
  const runtime = deps.extensions;
  if (!runtime) return { ok: false as const, code: 'CONFIG_INVALID' as const, message: '확장 실행 환경이 설정되지 않았습니다' };
  if ((input.name === undefined) === (input.packagePath === undefined) || (input.name !== undefined && !isExtensionName(input.name))) return { ok: false as const, code: 'EXTENSION_NOT_FOUND' as const, message: '확장 이름 또는 패키지 경로 하나가 필요합니다' };
  if (input.packagePath !== undefined && input.signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
  try { await runtime.packages.captureRunningCore?.(); }
  catch { return input.signal?.aborted ? { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' } : { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '실행 중인 core 신원을 확인하지 못했습니다' }; }
  let prepared: Awaited<ReturnType<NonNullable<ExtensionPackages['prepareExternal']>>> | undefined;
  try {
    if (input.packagePath !== undefined) {
      if (!runtime.packages.prepareExternal || !runtime.packages.checkCore) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '패키지 설치를 사용할 수 없습니다' };
      try { prepared = await runtime.packages.prepareExternal(input.packagePath, { signal: input.signal }); }
      catch { return input.signal?.aborted ? { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' } : { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 패키지를 검사하지 못했습니다' }; }
    }
    if (input.packagePath !== undefined && input.signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
    const name = prepared?.name ?? input.name!;
    const run = async () => {
      try { await runtime.packages.checkInstalledCore?.(); }
      catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '설치된 core 신원이 현재 실행 파일과 다릅니다' }; }
      if (prepared) {
        const decoded = decodeExtensionManifest(prepared.manifestText, runtime.validateSchema);
        if (!decoded.ok) return decoded;
        try { await runtime.packages.checkCore!(decoded.manifest); }
        catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '설치된 core 신원 또는 호환 버전이 올바르지 않습니다' }; }
        try { await runtime.packages.observe?.({ name, version: decoded.manifest.version, pluginVersion: decoded.manifest.plugin_version!, digest: prepared.digest }); }
        catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '패키지 관측 기록을 쓸 수 없습니다' }; }
      }
      const outcome = await installExtensionUnlocked(deps, name, runtime, input.signal, prepared);
      const status = await extensionStatus(deps, { name });
      if (!status.ok) return status;
      return outcome.ok ? status : { ...outcome, status };
    };
    const locked = () => runtime.withInstallLock ? runtime.withInstallLock(name, run, input.signal) : run();
    try { return await (runtime.withHomeInstallLock ? runtime.withHomeInstallLock(locked, input.signal) : locked()); }
    catch (error) { if ((error as { code?: string })?.code === 'EXTENSION_INSTALL_CANCELLED') return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치 잠금 대기가 취소되었습니다' }; return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '확장 설치 잠금을 확보하지 못했습니다' }; }
  } finally { await prepared?.cleanup(); }
}
async function installExtensionUnlocked(deps: ExtensionDependencies, name: string, runtime: ExtensionRuntime, signal?: AbortSignal, prepared?: { dir: string; manifestText: string; digest: string }) {
  const preflightFailure = async (code: 'EXTENSION_NOT_FOUND' | 'EXTENSION_INVALID', message: string) => {
    if (signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
    if (code === 'EXTENSION_NOT_FOUND') {
      const previous = await deps.store.getExtensionInstallProgress(name); if (!previous.ok) return previous;
      if (!previous.journal) {
        const at = deps.clock.now().toISOString();
        const progress: ExtensionInstallProgress = { name, packageDigest: '0'.repeat(64), result: 'failed', failedStage: 'package', lastFailure: { stage: 'package', code, at }, stages: { package: { status: 'failed', code, at } }, authWorkId: null, scheduleIds: [] };
        const saved = await deps.store.writeExtensionInstallProgress({ expectedRevision: null, progress }); if (!saved.ok) return saved;
        if (!saved.written) return { ok: false as const, code: 'DB_LOCKED' as const, message: '확장 설치 기록이 동시에 변경되었습니다' };
      }
    }
    return { ok: false as const, code, message };
  };
  let source: Awaited<ReturnType<ExtensionPackages['resolve']>>;
  try { source = prepared ? { ok: true, dir: prepared.dir, manifestText: prepared.manifestText } : await runtime.packages.resolve(name); }
  catch { return preflightFailure('EXTENSION_INVALID', '확장 패키지의 manifest를 읽지 못했습니다'); }
  if (!source.ok) return preflightFailure('EXTENSION_NOT_FOUND', '지정한 확장 패키지가 없습니다');
  const decoded = decodeExtensionManifest(source.manifestText, runtime.validateSchema);
  if (!decoded.ok) return preflightFailure('EXTENSION_INVALID', decoded.message);
  const manifest = decoded.manifest;
  if (runtime.packages.preflight) { const checked = await runtime.packages.preflight(source.dir, manifest); if (!checked.ok) return checked; }
  if (deps.cron && (manifest.default_schedules ?? []).some(schedule => schedule.cron !== undefined && !deps.cron!.validate(schedule.cron, schedule.time_zone ?? 'UTC').ok)) return preflightFailure('EXTENSION_INVALID', '예약 cron 식 또는 시간대가 올바르지 않습니다');
  // Compare before any progress, migration, placement or registry write.
  const installed = await deps.store.getExtension(name);
  if (!installed.ok) return installed;
  if (installed.extension && (prepared || installed.extension.packageDigest !== null)) {
    const comparison = comparePackageVersion(installed.extension.version, manifest.version);
    if (comparison === null) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '설치 버전을 안전하게 비교할 수 없습니다' };
    if (comparison > 0) return { ok: true as const };
    if (comparison === 0 && (prepared === undefined || installed.extension.packageDigest !== prepared.digest)) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '같은 버전의 패키지 내용이 다릅니다' };
  }
  const folderName = source.dir.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  if (manifest.name !== name || (!prepared && folderName !== name)) return preflightFailure('EXTENSION_INVALID', '요청한 이름과 manifest 및 패키지 폴더 이름이 다릅니다');
  let progress: ExtensionInstallProgress | null = null;
  let revision: number | null = null;
  let inspected: Awaited<ReturnType<NonNullable<ExtensionPackages['inspect']>>> | null = null;
  if (runtime.packages.inspect) {
    try { inspected = await runtime.packages.inspect(name, source.dir, manifest.migrations, prepared ? manifest.files : undefined); }
    catch { return preflightFailure('EXTENSION_INVALID', '확장 패키지를 검사하지 못했습니다'); }
    if (prepared && inspected.digest !== prepared.digest) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '검증된 패키지 내용이 바뀌었습니다' };
    const existing = await deps.store.getExtensionInstallProgress(name);
    if (!existing.ok) return existing;
    revision = existing.journal?.revision ?? null;
    const previous = existing.journal?.progress;
    const sameInstalled = previous && inspected.installedDigest === previous.packageDigest;
    const correction = !runtime.packages.transition && sameInstalled && previous.stages.migration?.status === 'failed' && inspected.sameBase && runtime.packages.refreshMigrations;
    if (previous?.transition && previous.packageDigest !== inspected.digest && (prepared || previous.stages.migration?.status !== 'failed' || !runtime.packages.sameBase || !runtime.packages.transition)) return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '중단된 설치와 패키지 내용이 다릅니다. 기존 패키지로 복구하세요' };
    if (previous && ((previous.transition && (previous.packageDigest === inspected.digest || (!prepared && previous.stages.migration?.status === 'failed'))) || (sameInstalled && (previous.packageDigest === inspected.digest || correction)))) {
      progress = structuredClone(previous);
      if (previous.packageDigest !== inspected.digest && !previous.transition) {
        try { await runtime.packages.refreshMigrations!(name, source.dir, manifest.migrations); }
        catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 마이그레이션을 갱신하지 못했습니다' }; }
        progress.packageDigest = inspected.digest;
        delete progress.stages.migration;
      }
    } else {
      progress = { name, packageDigest: inspected.digest, result: null, failedStage: null, lastFailure: previous?.lastFailure ?? null, stages: {}, authWorkId: null, scheduleIds: [] };
    }
  }
  const save = async () => {
    if (!progress) return { ok: true as const };
    const saved = await deps.store.writeExtensionInstallProgress({ expectedRevision: revision, progress });
    if (!saved.ok) return saved;
    if (!saved.written) return { ok: false as const, code: 'DB_LOCKED' as const, message: '확장 설치 기록이 동시에 변경되었습니다' };
    revision = saved.revision;
    return { ok: true as const };
  };
  const mark = async (stage: InstallStage, status: 'succeeded' | 'failed' | 'skipped' | 'pending', code: string | null = null) => {
    if (progress) {
      const at = deps.clock.now().toISOString(); progress.stages[stage] = { status, code, at };
      if (status === 'failed') { progress.result = 'failed'; progress.failedStage = stage; progress.lastFailure = { stage, code: code ?? 'EXTENSION_FAILED', at }; }
      else { progress.result = null; progress.failedStage = null; }
    }
    return save();
  };
  const cancelled = async () => {
    if (!signal?.aborted) return null;
    if (progress?.authWorkId && progress.stages.login?.status !== 'succeeded') {
      if (!deps.store.requestWorkCancel || !deps.store.getWork) return { ok: false as const, code: 'EXTENSION_CANCEL_UNCONFIRMED' as const, message: '인증 취소를 확인할 수 없습니다' };
      const requested = await deps.store.requestWorkCancel({ id: progress.authWorkId, now: deps.clock.now() });
      if (!requested.ok) return requested;
      if (requested.state === 'not_found') return { ok: false as const, code: 'EXTENSION_CANCEL_UNCONFIRMED' as const, message: '인증 일감을 확인할 수 없습니다' };
      let confirmed = false;
      for (let count = 0; count < 150; count++) {
        const read = await deps.store.getWork(progress.authWorkId); if (!read.ok) return read;
        const entry = read.entry;
        if (entry && entry.item.completedAt !== null && entry.item.currentAttemptToken === null && (entry.latestAttempt === null || (entry.latestAttempt.finishedAt !== null && entry.latestAttempt.outcome !== 'unknown'))) {
          if (entry.item.outcome === 'succeeded') { const recorded = await mark('login', 'succeeded'); if (!recorded.ok) return recorded; }
          confirmed = true; break;
        }
        await runtime.timer.sleep(100, new AbortController().signal);
      }
      if (!confirmed) return { ok: false as const, code: 'EXTENSION_CANCEL_UNCONFIRMED' as const, message: '인증 자식의 종료를 확인하지 못했습니다' };
    }
    if (!progress?.transition) await runtime.packages.rollback?.(name, true);
    if (progress) { progress.result = 'cancelled'; progress.failedStage = null; const saved = await save(); if (!saved.ok) return saved; }
    return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
  };
  const completed = (stage: InstallStage) => progress?.stages[stage]?.status === 'succeeded' || progress?.stages[stage]?.status === 'skipped';
  const beforePackage = await cancelled(); if (beforePackage) return beforePackage;
  let installedDir: string;
  const transition = runtime.packages.transition;
  if (transition && progress && !progress.transition) {
    const gate = await deps.store.readExtensionQuiesce(name); if (!gate.ok) return gate;
    if (gate.owner !== null || await transition.read(name)) return { ok: false as const, code: 'DB_LOCKED' as const, message: '소유권을 확인할 수 없는 확장 전환을 복구해야 합니다' };
  }
  if (transition && inspected && progress && !progress.transition && inspected.installedDigest === inspected.digest && completed('package') && completed('migration') && installed.extension?.version === manifest.version) {
    installedDir = inspected.installedDir;
  } else if (transition && inspected && progress) {
    // Persist the owner before setting the gate, so every crash boundary can
    // be resumed without adopting another installer's quiesce token.
    if (!progress.transition) { progress.transition = { owner: deps.idGen.next(), registered: false }; const saved = await save(); if (!saved.ok) return saved; }
    const owner = progress.transition.owner;
    const stopped = await quiesceExtension(deps.store, runtime.timer, { name, owner, now: deps.clock.now(), ...(signal ? { signal } : {}) });
    if (!stopped.ok) return stopped;
    const fail = (message: string) => ({ ok: false as const, code: 'EXTENSION_INVALID' as const, message });
    try {
      let journal = await transition.read(name);
      if (journal && journal.owner !== owner) return fail('중단된 설치 전환의 소유권이 다릅니다');
      if (journal?.phase === 'discarding') {
        // The corrected digest was saved before the old stage was discarded.
        // Do not adopt a different source after the comparison stage is gone.
        if (prepared || progress.stages.migration?.status !== 'failed' || progress.packageDigest !== inspected.digest) return fail('중단된 파일 복구의 패키지 신원이 다릅니다');
        if (progress.stages.environment) { delete progress.stages.environment; const saved = await save(); if (!saved.ok) return saved; }
        await transition.rollback(name, owner); journal = null;
      }
      if (journal?.phase === 'prepared' && progress.packageDigest !== journal.digest && progress.packageDigest !== inspected.digest) return fail('진행 중인 마이그레이션 수정 목표가 다릅니다');
      if (journal && journal.digest !== inspected.digest) {
        if (prepared || progress.stages.migration?.status !== 'failed' || journal.phase !== 'prepared' || !runtime.packages.sameBase) return fail('중단된 설치와 패키지 내용이 다릅니다');
        const oldStage = await transition.stagedDirectory(name, owner);
        if (progress.packageDigest !== journal.digest && progress.packageDigest !== inspected.digest) return fail('진행 중인 마이그레이션 수정 목표가 다릅니다');
        if (!await runtime.packages.sameBase(source.dir, oldStage, manifest.migrations)) return fail('수정된 마이그레이션 외 패키지 내용이 다릅니다');
        const stageCheck = await runtime.packages.inspect!(name, oldStage, manifest.migrations, undefined, owner);
        if (progress.packageDigest === journal.digest) {
          if (stageCheck.digest !== journal.digest) return fail('기존 준비 패키지의 digest가 다릅니다');
          progress.packageDigest = inspected.digest; const saved = await save(); if (!saved.ok) return saved;
        }
        await transition.refreshPreparedMigrations({ name, owner, source: source.dir, migrations: manifest.migrations, digest: inspected.digest,
          verify: async stage => (await runtime.packages.inspect!(name, stage, manifest.migrations, undefined, owner)).digest === inspected.digest });
        journal = await transition.read(name);
      } else if (!journal && progress.packageDigest !== inspected.digest) return fail('기존 설치의 패키지 신원을 확인할 수 없습니다');
      if (journal?.phase === 'rolling_back' || journal?.phase === 'rolled_back') return fail('중단된 파일 복구를 먼저 완료해야 합니다');
      if (!progress.transition.registered) {
        if ((!journal || journal.phase === 'preparing') && progress.stages.environment) { delete progress.stages.environment; const saved = await save(); if (!saved.ok) return saved; }
        if (!journal) { await transition.prepare({ name, owner, digest: inspected.digest, directory: source.dir }); journal = await transition.read(name); }
        if (journal?.phase === 'preparing') { await transition.prepare({ name, owner, digest: inspected.digest, directory: source.dir }); journal = await transition.read(name); }
        if (!journal) return fail('설치 전환 기록이 없습니다');
        if (journal.phase === 'prepared') {
          const stageDir = await transition.stagedDirectory(name, owner);
          const stageCheck = await runtime.packages.inspect!(name, stageDir, manifest.migrations, prepared ? manifest.files : undefined, owner);
          if (stageCheck.digest !== inspected.digest || (prepared && stageCheck.digest !== prepared.digest)) return fail('복사한 확장 패키지의 digest가 다릅니다');
          const beforeEnvironment = await cancelled(); if (beforeEnvironment) return beforeEnvironment;
          const needsPython = [manifest.connection_check, ...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : []), ...(manifest.commands ?? [])].some(command => command.runtime === 'python');
          if (!completed('environment') && needsPython) {
            const envResult = runtime.preparePython ? await runtime.preparePython(stageDir, signal, true) : { ok: false as const, code: 'EXTENSION_UV_NOT_FOUND' as const, message: 'uv를 찾을 수 없습니다' };
            if (!envResult.ok && envResult.code === 'EXTENSION_INSTALL_CANCELLED') { const stopped = await cancelled(); return stopped ?? envResult; }
            const envSaved = await deps.store.recordExtensionPythonEnvironment({ name, status: envResult.ok ? 'succeeded' : 'failed', code: envResult.ok ? null : envResult.code, checkedAt: deps.clock.now() }); if (!envSaved.ok) return envSaved;
            const saved = await mark('environment', envResult.ok ? 'succeeded' : 'failed', envResult.ok ? null : envResult.code); if (!saved.ok) return saved;
            if (!envResult.ok) return envResult;
          } else if (needsPython) {
            const validated = runtime.validatePreparedPython ? await runtime.validatePreparedPython(stageDir, signal) : { ok: false as const, code: 'EXTENSION_PYTHON_VERSION_MISMATCH' as const, message: '준비된 Python 환경을 확인할 수 없습니다' };
            if (!validated.ok) { const stopped = await cancelled(); if (stopped) return stopped; return validated; }
          } else if (!completed('environment')) { const saved = await mark('environment', 'skipped', 'EXTENSION_ENV_NOT_REQUIRED'); if (!saved.ok) return saved; }
          const afterPreparedEnvironment = await cancelled(); if (afterPreparedEnvironment) return afterPreparedEnvironment;
          if (runtime.provision && !completed('role')) {
            const provisioned = await runtime.provision(name);
            const saved = await mark('role', provisioned.ok ? 'succeeded' : 'failed', provisioned.ok ? null : provisioned.code); if (!saved.ok) return saved;
            if (!provisioned.ok) return provisioned;
          }
          // Always re-run the ledger on recovery: individual migrations commit
          // independently and the shared runner enforces applied checksums.
          const migrated = await runtime.migrator.apply(name, `${stageDir}/${manifest.migrations}`);
          const saved = await mark('migration', migrated.ok ? 'succeeded' : 'failed', migrated.ok ? null : migrated.code); if (!saved.ok) return saved;
          if (!migrated.ok) return { ok: false as const, code: migrated.code, message: '확장 마이그레이션을 적용하지 못했습니다' };
          if (signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
        }
        installedDir = await transition.activate(name, owner);
        const active = await runtime.packages.inspect!(name, source.dir, manifest.migrations, prepared ? manifest.files : undefined);
        if (active.installedDigest !== inspected.digest) return fail('전환된 확장 패키지의 digest가 다릅니다');
        if (!completed('package')) { const saved = await mark('package', 'succeeded'); if (!saved.ok) return saved; }
        const needsPython = [manifest.connection_check, ...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : []), ...(manifest.commands ?? [])].some(command => command.runtime === 'python');
        if (!completed('environment') && needsPython) {
          const envResult = runtime.preparePython ? await runtime.preparePython(installedDir, signal) : { ok: false as const, code: 'EXTENSION_UV_NOT_FOUND' as const, message: 'uv를 찾을 수 없습니다' };
          const envSaved = await deps.store.recordExtensionPythonEnvironment({ name, status: envResult.ok ? 'succeeded' : 'failed', code: envResult.ok ? null : envResult.code, checkedAt: deps.clock.now() }); if (!envSaved.ok) return envSaved;
          const saved = await mark('environment', envResult.ok ? 'succeeded' : 'failed', envResult.ok ? null : envResult.code); if (!saved.ok) return saved;
          if (!envResult.ok) return envResult;
        } else if (!needsPython && !completed('environment')) { const saved = await mark('environment', 'skipped', 'EXTENSION_ENV_NOT_REQUIRED'); if (!saved.ok) return saved; }
        if (signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
        const recorded = await deps.store.recordExtensionInstall({ name, version: manifest.version, now: deps.clock.now(), ...(prepared ? { packageIdentity: { digest: prepared.digest, pluginVersion: manifest.plugin_version! } } : {}), workKinds: [...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])].map(work => work.kind), workFollowups: Object.fromEntries((manifest.work ?? []).filter(work => work.followup).map(work => [work.kind, work.followup!])), missedPolicies: Object.fromEntries((manifest.work ?? []).filter(work => work.missed).map(work => [work.kind, work.missed!])) });
        if (!recorded.ok) return recorded;
        progress.transition.registered = true; const saved = await save(); if (!saved.ok) return saved;
      }
      installedDir = inspected.installedDir;
      const confirmed = await deps.store.getExtension(name); if (!confirmed.ok) return confirmed;
      const current = await runtime.packages.inspect!(name, source.dir, manifest.migrations, prepared ? manifest.files : undefined);
      if (current.installedDigest !== inspected.digest || confirmed.extension?.version !== manifest.version || (prepared && confirmed.extension.packageDigest !== prepared.digest)) return fail('registry와 설치 파일이 일치하지 않습니다');
      journal = await transition.read(name);
      if (journal) await transition.commit(name, owner);
      const released = await deps.store.endExtensionQuiesce({ name, owner }); if (!released.ok) return released;
      if (!released.released) return fail('확장 정지 소유권을 해제하지 못했습니다');
      delete progress.transition; const saved = await save(); if (!saved.ok) return saved;
    } catch { return fail('설치 전환을 완료하지 못했습니다. 같은 패키지로 다시 실행하세요'); }
  } else {
  if (inspected && completed('package')) installedDir = inspected.installedDir;
  else {
    try { installedDir = await runtime.packages.place(name, source.dir); }
    catch { const saved = await mark('package', 'failed', 'EXTENSION_INVALID'); return saved.ok ? { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 패키지를 설치 폴더에 복사하지 못했습니다' } : saved; }
    const saved = await mark('package', 'succeeded'); if (!saved.ok) { await runtime.packages.rollback?.(name); return saved; }
  }
  const afterPackage = await cancelled(); if (afterPackage) return afterPackage;
  const needsPython = [manifest.connection_check, ...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : []), ...(manifest.commands ?? [])].some(command => command.runtime === 'python');
  if (!completed('environment') && needsPython) {
    const prepared = runtime.preparePython ? await runtime.preparePython(installedDir, signal) : { ok: false as const, code: 'EXTENSION_UV_NOT_FOUND' as const, message: 'uv를 찾을 수 없습니다' };
    if (!prepared.ok && prepared.code === 'EXTENSION_INSTALL_CANCELLED') { const stopped = await cancelled(); if (stopped) return stopped; }
    if (!prepared.ok) await runtime.packages.rollback?.(name);
    const recordedEnvironment = await deps.store.recordExtensionPythonEnvironment({ name, status: prepared.ok ? 'succeeded' : 'failed', code: prepared.ok ? null : prepared.code, checkedAt: deps.clock.now() });
    if (!recordedEnvironment.ok) { if (prepared.ok) await runtime.packages.rollback?.(name); return recordedEnvironment; }
    const saved = await mark('environment', prepared.ok ? 'succeeded' : 'failed', prepared.ok ? null : prepared.code); if (!saved.ok) return saved;
    if (!prepared.ok) { const status = await extensionStatus(deps, { name }); return status.ok ? { ...status, ...prepared } : status; }
  } else if (!needsPython && !completed('environment')) { const saved = await mark('environment', 'skipped', 'EXTENSION_ENV_NOT_REQUIRED'); if (!saved.ok) return saved; }
  const afterEnvironment = await cancelled(); if (afterEnvironment) return afterEnvironment;
  if (runtime.provision && !completed('role')) {
    const provisioned = await runtime.provision(name);
    if (!provisioned.ok) await runtime.packages.rollback?.(name);
    const saved = await mark('role', provisioned.ok ? 'succeeded' : 'failed', provisioned.ok ? null : provisioned.code); if (!saved.ok) return saved;
    if (!provisioned.ok) return provisioned;
  }
  const afterRole = await cancelled(); if (afterRole) return afterRole;
  if (!completed('migration')) {
    const migrated = await runtime.migrator.apply(name, `${installedDir}/${manifest.migrations}`);
    const saved = await mark('migration', migrated.ok ? 'succeeded' : 'failed', migrated.ok ? null : migrated.code); if (!saved.ok) return saved;
    if (!migrated.ok) return { ok: false as const, code: migrated.code, message: '확장 마이그레이션을 적용하지 못했습니다' };
  }
  const afterMigration = await cancelled(); if (afterMigration) return afterMigration;
  const recorded = await deps.store.recordExtensionInstall({ name, version: manifest.version, now: deps.clock.now(), ...(prepared ? { packageIdentity: { digest: prepared.digest, pluginVersion: manifest.plugin_version! } } : {}), workKinds: [...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])].map(work => work.kind), workFollowups: Object.fromEntries((manifest.work ?? []).filter(work => work.followup).map(work => [work.kind, work.followup!])), missedPolicies: Object.fromEntries((manifest.work ?? []).filter(work => work.missed).map(work => [work.kind, work.missed!])) });
  if (!recorded.ok) return recorded;
  await runtime.packages.finalizePlacement?.(name);
  }
  const afterRegistry = await cancelled(); if (afterRegistry) return afterRegistry;
  const self = deps.store.readSelfUser ? await resolveSelfUser({ readSelfUser: deps.store.readSelfUser.bind(deps.store) }) : { ok: false as const, code: 'USER_MISSING' as const, message: '사용자가 없습니다' };
  if (!self.ok) { const saved = await mark(manifest.auth ? 'login' : 'configuration', 'failed', self.code); return saved.ok ? self : saved; }
  if (!manifest.auth) {
    if (!completed('login')) { const saved = await mark('login', 'skipped', 'EXTENSION_AUTH_NOT_REQUIRED'); if (!saved.ok) return saved; }
  } else if (!completed('login')) {
    if (!progress || !deps.store.getWork || !deps.store.addWork) return { ok: false as const, code: 'EXTENSION_AUTH_FAILED' as const, message: '인증 일감 저장소를 사용할 수 없습니다' };
    let current = progress.authWorkId ? await deps.store.getWork(progress.authWorkId) : null;
    if (current && !current.ok) return current;
    const afterAuthRead = await cancelled(); if (afterAuthRead) return afterAuthRead;
    let entry = current?.ok ? current.entry : null;
    if (entry && (entry.item.kind !== manifest.auth.kind || entry.item.targetKind !== 'extension' || entry.item.targetId !== name)) return { ok: false as const, code: 'EXTENSION_AUTH_FAILED' as const, message: '저장된 인증 일감이 확장과 일치하지 않습니다' };
    if (entry?.item.outcome === 'succeeded') {
      const saved = await mark('login', 'succeeded'); if (!saved.ok) return saved;
    } else {
      const attemptCode = entry?.latestAttempt?.errorCode;
      if (entry?.item.completedAt && entry.item.outcome !== 'cancelled' && attemptCode !== 'LOGIN_REQUIRED' && progress.stages.login?.status !== 'failed') {
        const saved = await mark('login', 'failed', 'EXTENSION_AUTH_FAILED'); if (!saved.ok) return saved;
        return { ok: false as const, code: 'EXTENSION_AUTH_FAILED' as const, message: '확장 인증에 실패했습니다' };
      }
      if (!entry || entry.item.completedAt) {
        const now = deps.clock.now();
        const added = await deps.store.addWork({ id: deps.idGen.next(), kind: manifest.auth.kind, targetKind: 'extension', targetId: name, createdAt: now, nextAttemptAt: now });
        if (!added.ok) return added;
        progress.authWorkId = added.item.id;
        progress.result = 'login_required'; progress.failedStage = null;
        progress.stages.login = { status: 'pending', code: 'LOGIN_REQUIRED', at: deps.clock.now().toISOString() };
        const queued = await save();
        if (!queued.ok) { if (signal?.aborted && deps.store.requestWorkCancel) await deps.store.requestWorkCancel({ id: added.item.id, now: deps.clock.now() }); return queued; }
        const afterAuthAdd = await cancelled(); if (afterAuthAdd) return afterAuthAdd;
        current = await deps.store.getWork(added.item.id); if (!current.ok) return current;
        const afterAuthLookup = await cancelled(); if (afterAuthLookup) return afterAuthLookup;
        entry = current.entry;
      }
      if (entry?.item.outcome === 'succeeded') { const saved = await mark('login', 'succeeded'); if (!saved.ok) return saved; }
      else {
        progress.result = 'login_required'; progress.failedStage = null;
        if (progress.stages.login?.status !== 'pending') progress.stages.login = { status: 'pending', code: 'LOGIN_REQUIRED', at: deps.clock.now().toISOString() };
        const saved = await save(); if (!saved.ok) return saved;
        const afterAuthSave = await cancelled(); if (afterAuthSave) return afterAuthSave;
        return { ok: false as const, code: 'EXTENSION_LOGIN_REQUIRED' as const, message: '확장 인증을 완료한 뒤 설치를 다시 실행하세요' };
      }
    }
  }
  const afterLogin = await cancelled(); if (afterLogin) return afterLogin;
  const configFailure = async () => {
    const message = '확장 설정을 확인하세요';
    const recordedFailure = await deps.store.recordExtensionConnection({ name, status: 'failed', checkedAt: deps.clock.now(), code: 'EXTENSION_CONFIG_INVALID', message });
    const saved = await mark('configuration', 'failed', 'EXTENSION_CONFIG_INVALID');
    if (!saved.ok) return saved;
    return recordedFailure.ok ? { ok: false as const, code: 'EXTENSION_CONFIG_INVALID' as const, retryable: false as const, message } : recordedFailure;
  };
  if (completed('connection')) {
    try { await runtime.secureCredentials?.(name); }
    catch {
      const saved = await mark('configuration', 'failed', 'EXTENSION_CONFIG_INVALID'); if (!saved.ok) return saved;
      return { ok: false as const, code: 'EXTENSION_CONFIG_INVALID' as const, message: '확장 자격 증명을 확인하세요' };
    }
  }
  const declarations = manifest.settings ?? [];

  for (const declaration of declarations) {
    if (declaration.machine || declaration.default === undefined) continue;
    if (!deps.store.insertSetting) return configFailure();
    const inserted = await deps.store.insertSetting({ userId: declaration.scope === 'global' ? null : self.userId, key: declaration.key, value: declaration.default, updatedAt: deps.clock.now() });
    if (!inserted.ok) { const saved = await mark('configuration', 'failed', inserted.code); return saved.ok ? inserted : saved; }
  }
  if (!completed('connection') || !completed('configuration')) {
  const snapshot = await acquireExtensionSnapshot({ extension: name, userId: self.userId, stage: 'connect', declarations, getSettings: deps.store.getSettings?.bind(deps.store), readSecrets: runtime.readSecrets?.bind(runtime), machineValues: () => runtime.machineValues?.(name) ?? {} });
  if (!snapshot.ok) {
    if (snapshot.kind !== 'settings') return configFailure();
    const saved = await mark('configuration', 'failed', snapshot.result.code);
    return saved.ok ? { ok: false as const, code: snapshot.result.code, message: '확장 설정을 읽을 수 없습니다' } : saved;
  }
  if (!completed('configuration')) { const configSaved = await mark('configuration', 'succeeded'); if (!configSaved.ok) return configSaved; }
  if (!completed('connection')) {
  let databaseUrl: string;
  try { databaseUrl = await runtime.databaseUrl(name); } catch { return configFailure(); }
  const env = {
    [PROCESS_ABI_ENV.version]: '1', [PROCESS_ABI_ENV.databaseUrl]: databaseUrl,
    [PROCESS_ABI_ENV.workId]: deps.idGen.next(), [PROCESS_ABI_ENV.attemptToken]: deps.idGen.next(),
    [PROCESS_ABI_ENV.workKind]: `${name}.connection_check`, [PROCESS_ABI_ENV.targetKind]: 'extension',
    [PROCESS_ABI_ENV.targetId]: name, [PROCESS_ABI_ENV.runGeneration]: '1',
    BRAIN_SETTINGS_SNAPSHOT: snapshot.serialized,
  };
  const verdict = await runExtensionCheck({ ...runtime, ...(signal ? { signal } : {}), clock: deps.clock, protection: { extension: name, declarations: Object.fromEntries(declarations.map(setting => [setting.key, setting.type])), errorCodes: manifest.error_codes ?? [], required: declarations.filter(setting => setting.required.includes('connect')).map(setting => setting.key), secrets: declarations.filter(setting => setting.secret).map(setting => setting.key) }, spec: { command: manifest.connection_check.runtime === 'python' ? `${installedDir}/.venv/bin/python` : 'node', args: [`${installedDir}/${manifest.connection_check.entry}`], env } });
  if (verdict.code === 'EXTENSION_INSTALL_CANCELLED') { const stopped = await cancelled(); if (stopped) return stopped; }
  const connection = await deps.store.recordExtensionConnection({ name, status: verdict.outcome === 'succeeded' ? 'connected' : 'failed', checkedAt: deps.clock.now(), code: verdict.code ?? null, message: verdict.message === undefined ? null : failureText(verdict.message.replaceAll('\u0000', '\ufffd')) });
  if (!connection.ok) return connection;
  const connectionSaved = await mark('connection', verdict.outcome === 'succeeded' ? 'succeeded' : 'failed', verdict.outcome === 'succeeded' ? null : 'EXTENSION_CHECK_FAILED'); if (!connectionSaved.ok) return connectionSaved;
  if (progress && verdict.outcome !== 'succeeded') { progress.result = 'connection_failed'; const saved = await save(); if (!saved.ok) return saved; }
  if (verdict.outcome !== 'succeeded') { const result = await extensionStatus(deps, { name }); return result.ok ? { ...result, ok: false as const, code: 'EXTENSION_CHECK_FAILED' as const, message: '확장 연결 확인에 실패했습니다' } : result; }
  }
  }
  const afterConnection = await cancelled(); if (afterConnection) return afterConnection;
  const schedulerUnavailable = async () => {
    const saved = await mark('schedule', 'failed', 'EXTENSION_SCHEDULER_UNAVAILABLE'); if (!saved.ok) return saved;
    if (progress) { progress.result = 'scheduler_unavailable'; const recorded = await save(); if (!recorded.ok) return recorded; }
    return { ok: false as const, code: 'EXTENSION_SCHEDULER_UNAVAILABLE' as const, message: '데몬 감독자 또는 예약 기능이 준비되지 않았습니다' };
  };
  const schedules = manifest.default_schedules ?? [];
  // Even an empty new manifest must disable keys from an older installation.
  if (!deps.store.disableMissingSchedules || (schedules.length > 0 && (!runtime.schedulerReady || !await runtime.schedulerReady() || !deps.readTimeZone || !deps.cron || !deps.store.addSchedule || !deps.store.findScheduleByKey || !deps.store.readSelfUser))) {
    if (schedules.length || progress?.scheduleIds.length) return schedulerUnavailable();
    if (!completed('schedule')) { const saved = await mark('schedule', 'skipped', 'EXTENSION_SCHEDULE_NOT_REQUIRED'); if (!saved.ok) return saved; }
  } else {
    const previousIds = progress?.scheduleIds.slice() ?? [];
    const confirmedIds: string[] = [];
    const keys = schedules.map(schedule => schedule.key ?? `${schedule.kind}:${schedule.target_kind}:${schedule.target_id}`);
    for (const [index, schedule] of schedules.entries()) {
      const stopped = await cancelled(); if (stopped) return stopped;
      if (!runtime.schedulerReady || !await runtime.schedulerReady()) return schedulerUnavailable();
      const result = await ensureSchedule({ store: deps.store as ScheduleStore & WorkStore & Pick<UserStore, 'readSelfUser'>, clock: deps.clock, idGen: deps.idGen, readTimeZone: deps.readTimeZone!, cron: deps.cron! }, { extension:name, scheduleKey:keys[index]!, kind:schedule.kind, targetKind:schedule.target_kind, targetId:schedule.target_id, ...(schedule.target_setting === undefined ? {} : {targetSetting:schedule.target_setting}), ...(schedule.after_schedule === undefined ? {} : {afterSchedule:schedule.after_schedule}), ...(schedule.local_time !== undefined ? {localTime:schedule.local_time} : {cron:schedule.cron!, ...(schedule.time_zone === undefined ? {} : {timeZone:schedule.time_zone})}) });
      if (!result.ok) { if (progress) progress.scheduleIds = confirmedIds; const saved = await mark('schedule', 'failed', result.code); if (!saved.ok) return saved; return result; }
      if (!confirmedIds.includes(result.schedule.id)) confirmedIds.push(result.schedule.id);
      if (progress) {
        const actualIds = [...confirmedIds, ...previousIds.slice(confirmedIds.length)];
        if (JSON.stringify(progress.scheduleIds) !== JSON.stringify(actualIds)) { progress.scheduleIds = actualIds; const saved = await save(); if (!saved.ok) return saved; }
      }
    }
    const disabled = await deps.store.disableMissingSchedules({extension:name,userId:self.userId,keys}); if (!disabled.ok) return disabled;
    const previousDisabled = progress?.disabledScheduleKeys ?? [];
    if (progress) { progress.scheduleIds = confirmedIds; progress.disabledScheduleKeys = disabled.keys; }
    if (!completed('schedule') || JSON.stringify(previousIds) !== JSON.stringify(confirmedIds) || JSON.stringify(previousDisabled) !== JSON.stringify(disabled.keys)) { const saved = await mark('schedule', schedules.length ? 'succeeded' : 'skipped', schedules.length ? null : 'EXTENSION_SCHEDULE_NOT_REQUIRED'); if (!saved.ok) return saved; }
  }
  const beforeFinish = await cancelled(); if (beforeFinish) return beforeFinish;
  if (progress) { progress.result = 'installed'; progress.failedStage = null; const saved = await save(); if (!saved.ok) return saved; }
  return extensionStatus(deps, { name });
}
