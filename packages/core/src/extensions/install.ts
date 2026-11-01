import type { ExtensionInstallProgress, InstallStage } from './install-progress.js';
import { failureText } from '../domain/failure.js';
import type { Clock, Timer } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import { ensureDaily, type ReadTimeZone } from '../queue/schedules.js';
import type { ExtensionStore, WorkStore, ScheduleStore } from '../ports/store.js';
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
  rollback?(name: string, preserveInitial?: boolean): Promise<void>;
  inspect?(name: string, dir: string, migrations: string): Promise<{ digest: string; installedDigest: string | null; sameBase: boolean; installedDir: string }>;
  refreshMigrations?(name: string, dir: string, migrations: string): Promise<void>;
}
export interface ExtensionMigrator {
  apply(owner: string, directory: string): Promise<{ ok: true; from: number; to: number; applied: string[] } | { ok: false; code: 'MIGRATION_FAILED' | 'DB_UNAVAILABLE'; message: string; file?: string }>;
}
export interface ExtensionRuntime {
  authorize?(name: string): Promise<{ ok: true } | { ok: false; code: 'AUTH_PEER_UNVERIFIED'; message: string }>;
  installedManifest?(name: string): Promise<string>;
  readPublicReport?(name: string, workId: string): Promise<unknown>;
  schedulerReady?(): Promise<boolean>;
  secureCredentials?(name: string): Promise<void>;
  withInstallLock?<T>(name: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  provision?(name: string): Promise<{ ok: true } | { ok: false; code: 'DB_UNAVAILABLE'; message: string }>;
  packages: ExtensionPackages; migrator: ExtensionMigrator; launcher: ProcessLauncher; inspector: ProcessInspector; timer: Timer;
  preparePython?(directory: string, signal?: AbortSignal): Promise<{ ok: true } | { ok: false; code: 'EXTENSION_INSTALL_CANCELLED' | 'EXTENSION_PYTHON_PIN_INVALID' | 'EXTENSION_UV_NOT_FOUND' | 'EXTENSION_PYTHON_NOT_FOUND' | 'EXTENSION_PYTHON_SYNC_FAILED' | 'EXTENSION_PYTHON_VERSION_MISMATCH'; message: string }>;
  databaseUrl(name: string): string | Promise<string>;
  readSecrets?(): Promise<Readonly<Record<string, string>>>;
  machineValues?(name: string): Readonly<Record<string, string>>;
}
export interface ExtensionDependencies { store: ExtensionStore & Partial<SettingsStore & WorkStore & ScheduleStore>; readTimeZone?: ReadTimeZone; clock: Clock; idGen: IdGen; extensions?: ExtensionRuntime }
export async function installExtension(deps: ExtensionDependencies, { name, signal }: { name: string; signal?: AbortSignal }) {
  if (!isExtensionName(name)) return { ok: false as const, code: 'EXTENSION_NOT_FOUND' as const, message: '확장 이름이 이름 규칙에 맞지 않습니다' };
  const runtime = deps.extensions;
  if (!runtime) return { ok: false as const, code: 'CONFIG_INVALID' as const, message: '확장 실행 환경이 설정되지 않았습니다' };
  const run = async () => {
    const outcome = await installExtensionUnlocked(deps, name, runtime, signal);
    const status = await extensionStatus(deps, { name });
    if (!status.ok) return status;
    return outcome.ok ? status : { ...outcome, status };
  };
  if (runtime.withInstallLock) {
    try { return await runtime.withInstallLock(name, run, signal); }
    catch (error) { if ((error as { code?: string })?.code === 'EXTENSION_INSTALL_CANCELLED') return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치 잠금 대기가 취소되었습니다' }; return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '확장 설치 잠금을 확보하지 못했습니다' }; }
  }
  return run();
}
async function installExtensionUnlocked(deps: ExtensionDependencies, name: string, runtime: ExtensionRuntime, signal?: AbortSignal) {
  const preflightFailure = async (code: 'EXTENSION_NOT_FOUND' | 'EXTENSION_INVALID', message: string) => {
    if (signal?.aborted) return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
    const previous = await deps.store.getExtensionInstallProgress(name); if (!previous.ok) return previous;
    const at = deps.clock.now().toISOString();
    // 기존 설치 시도의 완료 사실과 식별자는 사전 검사 실패로 지우지 않는다.
    const progress: ExtensionInstallProgress = previous.journal
      ? { ...structuredClone(previous.journal.progress), result: 'failed', failedStage: 'package', lastFailure: { stage: 'package', code, at } }
      : { name, packageDigest: '0'.repeat(64), result: 'failed', failedStage: 'package', lastFailure: { stage: 'package', code, at }, stages: { package: { status: 'failed', code, at } }, authWorkId: null, scheduleIds: [] };
    const saved = await deps.store.writeExtensionInstallProgress({ expectedRevision: previous.journal?.revision ?? null, progress });
    if (!saved.ok) return saved;
    return saved.written ? { ok: false as const, code, message } : { ok: false as const, code: 'DB_LOCKED' as const, message: '확장 설치 기록이 동시에 변경되었습니다' };
  };
  let source: Awaited<ReturnType<ExtensionPackages['resolve']>>;
  try { source = await runtime.packages.resolve(name); }
  catch { return preflightFailure('EXTENSION_INVALID', '확장 패키지의 manifest를 읽지 못했습니다'); }
  if (!source.ok) return preflightFailure('EXTENSION_NOT_FOUND', '지정한 확장 패키지가 없습니다');
  const decoded = decodeExtensionManifest(source.manifestText);
  if (!decoded.ok) return preflightFailure('EXTENSION_INVALID', decoded.message);
  const manifest = decoded.manifest;
  const folderName = source.dir.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1);
  if (manifest.name !== name || folderName !== name) return preflightFailure('EXTENSION_INVALID', '요청한 이름과 manifest 및 패키지 폴더 이름이 다릅니다');
  let progress: ExtensionInstallProgress | null = null;
  let revision: number | null = null;
  let inspected: Awaited<ReturnType<NonNullable<ExtensionPackages['inspect']>>> | null = null;
  if (runtime.packages.inspect) {
    try { inspected = await runtime.packages.inspect(name, source.dir, manifest.migrations); }
    catch { return preflightFailure('EXTENSION_INVALID', '확장 패키지를 검사하지 못했습니다'); }
    const existing = await deps.store.getExtensionInstallProgress(name);
    if (!existing.ok) return existing;
    revision = existing.journal?.revision ?? null;
    const previous = existing.journal?.progress;
    const sameInstalled = previous && inspected.installedDigest === previous.packageDigest;
    const correction = sameInstalled && previous.stages.migration?.status === 'failed' && inspected.sameBase && runtime.packages.refreshMigrations;
    if (previous && sameInstalled && (previous.packageDigest === inspected.digest || correction)) {
      progress = structuredClone(previous);
      if (previous.packageDigest !== inspected.digest) {
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
    await runtime.packages.rollback?.(name, true);
    if (progress) { progress.result = 'cancelled'; progress.failedStage = null; const saved = await save(); if (!saved.ok) return saved; }
    return { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' };
  };
  const completed = (stage: InstallStage) => progress?.stages[stage]?.status === 'succeeded' || progress?.stages[stage]?.status === 'skipped';
  const beforePackage = await cancelled(); if (beforePackage) return beforePackage;
  let installedDir: string;
  if (inspected && completed('package')) installedDir = inspected.installedDir;
  else {
    try { installedDir = await runtime.packages.place(name, source.dir); }
    catch { const saved = await mark('package', 'failed', 'EXTENSION_INVALID'); return saved.ok ? { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 패키지를 설치 폴더에 복사하지 못했습니다' } : saved; }
    const saved = await mark('package', 'succeeded'); if (!saved.ok) { await runtime.packages.rollback?.(name); return saved; }
  }
  const afterPackage = await cancelled(); if (afterPackage) return afterPackage;
  const needsPython = [manifest.connection_check, ...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])].some(command => command.runtime === 'python');
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
  const recorded = await deps.store.recordExtensionInstall({ name, version: manifest.version, now: deps.clock.now(), workKinds: [...(manifest.work ?? []), ...(manifest.auth ? [manifest.auth] : [])].map(work => work.kind) });
  if (!recorded.ok) return recorded;
  const afterRegistry = await cancelled(); if (afterRegistry) return afterRegistry;
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
  if (!completed('connection') || !completed('configuration')) {
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
  if (schedules.length === 0) { if (!completed('schedule')) { const saved = await mark('schedule', 'skipped', 'EXTENSION_SCHEDULE_NOT_REQUIRED'); if (!saved.ok) return saved; } }
  else {
    if (!runtime.schedulerReady || !await runtime.schedulerReady() || !deps.readTimeZone || !deps.store.addSchedule || !deps.store.findDailySchedule) {
      return schedulerUnavailable();
    }
    const previousIds = progress?.scheduleIds.slice() ?? [];
    const confirmedIds: string[] = [];
    for (const schedule of schedules) {
      const stopped = await cancelled(); if (stopped) return stopped;
      if (!await runtime.schedulerReady()) return schedulerUnavailable();
      const result = await ensureDaily({ store: deps.store as ScheduleStore & WorkStore, clock: deps.clock, idGen: deps.idGen, readTimeZone: deps.readTimeZone }, { kind: schedule.kind, targetKind: schedule.target_kind, targetId: schedule.target_id, localTime: schedule.local_time });
      if (!result.ok) { if (progress) progress.scheduleIds = confirmedIds; const saved = await mark('schedule', 'failed', result.code); if (!saved.ok) return saved; return result; }
      if (!confirmedIds.includes(result.schedule.id)) confirmedIds.push(result.schedule.id);
      if (progress) {
        const actualIds = [...confirmedIds, ...previousIds.slice(confirmedIds.length)];
        if (JSON.stringify(progress.scheduleIds) !== JSON.stringify(actualIds)) { progress.scheduleIds = actualIds; const saved = await save(); if (!saved.ok) return saved; }
      }
    }
    if (progress) progress.scheduleIds = confirmedIds;
    if (!completed('schedule') || JSON.stringify(previousIds) !== JSON.stringify(confirmedIds)) { const saved = await mark('schedule', 'succeeded'); if (!saved.ok) return saved; }
  }
  const beforeFinish = await cancelled(); if (beforeFinish) return beforeFinish;
  if (progress) { progress.result = 'installed'; progress.failedStage = null; const saved = await save(); if (!saved.ok) return saved; }
  return extensionStatus(deps, { name });
}
