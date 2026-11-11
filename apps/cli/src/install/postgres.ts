import { trackedExec } from '../runtime/process-registry.js';
import { cp, lstat, mkdir, writeFile, readFile, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { v7 } from 'uuid';
import { quiesceExtension, validInstallProgress, type ExtensionInstallProgress, type StoredExtensionInstallProgress, type Clock } from 'second_brain';
import { homeResources } from '../config/resources.js';
import { postgresSecrets } from '../config/codec.js';
import { installedExtensionMigrations, packageDigest } from '../runtime/extensions.js';
import { containerState, volumeOwner } from '../runtime/orbstack.js';
import { commandEnv, composeArgs, systemCommandRunner, type CommandRunner } from '../runtime/command-runner.js';
import { withInstallerHomeLock } from '../runtime/install-lock.js';
import { readBuildIdentity, readInstalled } from './installed.js';
import { systemTimer } from '../runtime/clock.js';
import { withOfflineRuntime } from './offline.js';
import { runtimeFencePath, withRuntimeFence } from './runtime-fence.js';
import { STAGED_PROMOTION_PROTOCOL } from './promotion-protocol.js';
const runningBuild = readBuildIdentity();
export interface PostgresInstallReport { project: string; volume: string; port: number; schema_version: number; applied: readonly string[]; owner_created: boolean; owner_name: string; compose_started: boolean; offline_confirmation?: { home: string; previous_commit: string; target_commit: string; method: 'operator' | 'automatic'; evidence?: { daemon_fenced: boolean; install_locked: boolean; runtime_roles: string[]; runtime_backends: number; previous_processes: number } }; legacy_sqlite_path?: string | null; import?: import('second_brain').BrainDrainReport | null }
export interface OfflineVerificationRequest { home: string; previousCommit: string; targetCommit: string; verificationId: string; legacySchema?: number }
type InstallOptions = { home: string; urlEnv: string; env: NodeJS.ProcessEnv; clock: Clock; runner?: CommandRunner; secrets?: { adminUrl: string; appPassword: string }; databaseName?: string; observeOffline?: (request: OfflineVerificationRequest) => Promise<unknown> };

/** Called only after the installer has validated and fenced its transition. */
async function promoteStagedApp(home: string, env: NodeJS.ProcessEnv, promotionOwner?: string): Promise<void> {
  const requested = env.SECOND_BRAIN_STAGED_APP; if (!requested) return;
  const root = resolve(home), stage = resolve(requested), app = join(root, 'app'), next = join(root, '.app-next'), previous = join(root, '.app-previous'), marker = join(root, '.app-promotion.json');
  if (dirname(stage) !== root || !/^\.app-stage-[0-9a-f-]{36}$/.test(stage.slice(root.length + 1))) throw new Error('대상 app 경로가 올바르지 않습니다');
  const owner = env.SECOND_BRAIN_INSTALL_LOCK_OWNER;
  if (!owner || !owner.startsWith(`${process.ppid} `) || owner !== await readFile(join(root, 'install.lock/owner'), 'utf8')) throw new Error('대상 app의 설치 잠금 소유권이 없습니다');
  const stageStat = await lstat(stage); if (!stageStat.isDirectory() || stageStat.isSymbolicLink()) throw new Error('대상 app이 실제 폴더가 아닙니다');
  const exists = async (path: string) => { try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; } };
  if (await exists(next)) throw new Error('중단된 app 전환을 먼저 복구하세요');
  const targetBuild = await readFile(join(stage, 'apps/cli/dist/build.json'), 'utf8');
  const target = JSON.parse(targetBuild) as { commit?: unknown; staged_promotion?: unknown };
  if (target.staged_promotion !== STAGED_PROMOTION_PROTOCOL) throw new Error('대상 app의 승격 지원을 확인할 수 없습니다');
  if (typeof target.commit !== 'string' || !/^[0-9a-f]{40}$/.test(target.commit)) throw new Error('대상 app 신원을 확인할 수 없습니다');
  const expectedHead = env.SECOND_BRAIN_PREVIOUS_APP_HEAD;
  if (await exists(app)) {
    if (!expectedHead || !/^[0-9a-f]{40}$/.test(expectedHead)) throw new Error('기존 app 신원을 확인할 수 없습니다');
    const git = (command: string, args: string[]) => trackedExec(home, command, args);
    const [head, status] = await Promise.all([git('git',['-C',app,'rev-parse','HEAD']), git('git',['-C',app,'status','--porcelain'])]);
    if (head.stdout.trim() !== expectedHead || status.stdout.trim() !== '') throw new Error('준비 중 기존 app이 바뀌었습니다. 변경을 보존하고 다시 실행하세요');
  } else if (expectedHead) throw new Error('준비 중 기존 app이 사라졌습니다');
  const markerExists = await exists(marker), previousExists = await exists(previous);
  if (previousExists && !markerExists) throw new Error('소유자를 확인할 수 없는 이전 app을 보존하고 복구하세요');
  if (markerExists) {
    const record = JSON.parse(await readFile(marker, 'utf8')) as { target?: unknown; hadPrevious?: unknown; owner?: unknown; previousHead?: unknown };
    if (typeof record.owner !== 'string' || !/^\d+ [0-9a-f-]{36}\n$/.test(record.owner) || (promotionOwner !== undefined && record.owner !== promotionOwner)) throw new Error('중단된 app 전환의 소유자가 불명확합니다');
    if (record.target !== target.commit || typeof record.hadPrevious !== 'boolean' || record.hadPrevious !== previousExists) throw new Error('중단된 app 전환의 신원이 다릅니다');
    // A failed attempt may have promoted this same build already. Its journal
    // remains authoritative; never replace the only previous app on retry.
    const active = await readFile(join(app, 'apps/cli/dist/build.json'), 'utf8');
    if (active !== targetBuild) throw new Error('중단된 app 전환의 대상이 다릅니다. 기존 app을 보존하고 복구하세요');
    return;
  }
  await cp(stage, next, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true });
  await writeFile(marker, JSON.stringify({ target: target.commit, hadPrevious: await exists(app), owner, previousHead: expectedHead || null }), { flag: 'wx', mode: 0o600 });
  let hadApp = false;
  try { await rename(app, previous); hadApp = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try { await rename(next, app); }
  catch (error) { if (hadApp) await rename(previous, app); throw error; }
}
export type PostgresInstallResult = { ok: true; report: PostgresInstallReport } | { ok: false; code: string; message: string };
export function renderPostgresCompose(home: string): string {
  const r = homeResources(home);
  return `name: ${r.project}
services:
  postgres:
    image: postgres:18
    environment:
      POSTGRES_PASSWORD: \${BRAIN_POSTGRES_PASSWORD:?BRAIN_POSTGRES_PASSWORD is required}
    ports:
      - "127.0.0.1:${r.port}:5432"
    volumes:
      - data:/var/lib/postgresql
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 1s
      timeout: 3s
      retries: 60
volumes:
  data:
    name: ${r.volume}
`;
}
/** A bootstrap must not migrate an installed tree while an extension
 * transition or its database fence may describe different bytes. */
export async function extensionMigrationSafety(home: string, names: readonly string[], store: Pick<import('second_brain').ExtensionStore, 'readExtensionQuiesce'>): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
  const files = await readdir(join(home, 'extensions')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
  if (files.some(file => /^\.transition-[a-z][a-z0-9_]*\.json$/.test(file))) return { ok: false, code: 'DB_LOCKED', message: '중단된 확장 설치를 같은 패키지로 복구한 뒤 다시 실행하세요' };
  for (const name of names) {
    const gate = await store.readExtensionQuiesce(name); if (!gate.ok) return gate;
    if (gate.owner !== null) return { ok: false, code: 'DB_LOCKED', message: '정지된 확장 설치를 복구한 뒤 다시 실행하세요' };
  }
  return { ok: true };
}
export async function installPostgres(options: InstallOptions): Promise<PostgresInstallResult> {
  return withInstallerHomeLock(options.home, options.env, () => installPostgresLocked(options));
}
async function installPostgresLocked(options: InstallOptions): Promise<PostgresInstallResult> {
  const { home, urlEnv, env, clock } = options;
  const resources = homeResources(home);
  try {
    const runner = options.runner ?? systemCommandRunner;
    const owner = await volumeOwner({ home, env, runner });
    if (!owner.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: owner.message };
    if (owner.exists && owner.owner !== resources.project) return { ok: false, code: 'DB_UNAVAILABLE', message: `볼륨 ${resources.volume}은 다른 project ${owner.owner ?? '(라벨 없음)'}의 것입니다. 아무것도 지우지 않았습니다` };
    const secrets = options.secrets ?? await postgresSecrets(home, resources.port, urlEnv);
    const composePath = join(home, 'postgres', 'compose.yaml');
    const content = renderPostgresCompose(home);
    const unchanged = await readFile(composePath, 'utf8').then(value => value === content, () => false);
    const state = await containerState({ home, env, runner });
    await mkdir(join(home, 'postgres'), { recursive: true, mode: 0o700 });
    if (!unchanged) await writeFile(composePath, content, { mode: 0o600 });
    const composeStarted = !unchanged || !state.ok;
    if (composeStarted) {
      const started = await runner({ command: 'docker', args: composeArgs(home, ['up', '-d', '--wait']),
        env: commandEnv({ ...env, BRAIN_POSTGRES_PASSWORD: decodeURIComponent(new URL(secrets.adminUrl).password) }), timeoutMs: 120_000 });
      if (!started.ok) return { ok: false, code: 'DB_UNAVAILABLE', message: /port is already allocated|address already in use/i.test(started.stderr)
        ? `PostgreSQL 포트 ${resources.port}를 이미 사용 중입니다. 사용하는 프로그램을 확인하세요`
        : `PostgreSQL 컨테이너를 시작하지 못했습니다. OrbStack 상태를 확인하세요\n${(started.stderr || started.stdout || started.message).slice(-2000)}` };
    }
    const { prepareDatabase, runMigrations, postgresStore, inspectExtensionFence, inspectLegacyExtensionPrerequisites, withExtensionInstallLock } = await import('second_brain/postgres');
    const targetName = options.databaseName ?? 'brain';
    if (!/^[a-z][a-z0-9_]*$/.test(targetName)) return { ok: false, code: 'DB_UNAVAILABLE', message: '잘못된 데이터베이스 이름입니다' };
    const targetUrl = new URL(secrets.adminUrl); targetUrl.pathname = `/${targetName}`;
    const existing = await inspectExtensionFence(targetUrl.toString());
    const store = postgresStore({ databaseUrl: targetUrl.toString() });
    try {
      const recover = '새 실행을 차단하고 이전 설치·데몬·확장 명령과 모든 자식이 종료됐는지 확인하세요. 기존 설치 core와 호환 패키지를 복원하고 중단된 확장 설치를 복구한 뒤 같은 core로 다시 실행하세요. 다른 소유자의 정지 기록은 지우지 마세요.';
      const locked = (message: string): PostgresInstallResult => ({ ok: false, code: 'DB_LOCKED', message: `${message} ${recover}` });
      const transitionFiles = await readdir(join(home, 'extensions')).catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; });
      if (transitionFiles.some(file => /^\.transition-[a-z][a-z0-9_]*\.json$/.test(file))) return locked('중단된 확장 전환이 있습니다.');
      const build = await runningBuild;
      const installed = await readInstalled(home);
      const legacy = !!installed && installed.schema_version >= 11 && installed.schema_version < 35 && !!installed.commit && !!build?.commit && installed.commit !== build.commit;
      if (existing.names.length) {
        const disk = await readBuildIdentity();
        // A different installed build may still be executing code that does not
        // honor this fence. Do not infer its safety from the new schema alone.
        if (!build?.commit || !build.version || !disk?.commit || disk.commit !== build.commit || disk.version !== build.version || disk.schema_version !== build.schema_version || !installed?.commit || (installed.schema_version < 35 && !legacy) || (!existing.fenceReady && !legacy)) return locked('기존 실행 core의 신원 또는 정지 지원을 확인할 수 없습니다.');
      }
      if (existing.names.length && installed && installed.schema_version >= 16 && !existing.progressReady) return locked('확장 진행 기록 표를 확인할 수 없습니다.');
      const readProgress = async () => {
        const records = new Map<string, StoredExtensionInstallProgress | null>();
        for (const name of existing.names) {
          const item = existing.progressReady ? await store.getExtensionInstallProgress(name) : { ok: true as const, journal: null };
          if (!item.ok || (item.journal && (!validInstallProgress(item.journal.progress) || item.journal.progress.name !== name || !Number.isSafeInteger(item.journal.revision) || item.journal.revision < 1))) throw new Error('invalid progress');
          records.set(name, item.journal);
        }
        return records;
      };
      let records: Map<string, StoredExtensionInstallProgress | null>;
      const allowed = new Set<string>();
      try {
        records = await readProgress();
        for (const name of existing.names) {
          const progress = records.get(name)?.progress;
          if (progress?.replacement) {
            if (!existing.fenceReady) throw new Error('missing gate');
            const gate = await store.readExtensionQuiesce(name);
            if (!gate.ok || gate.owner !== progress.replacement.owner) throw new Error('gate mismatch');
            allowed.add(name);
          }
          if (legacy) allowed.add(name);
        }
      } catch { return locked('확장 진행 기록 또는 정지 소유권을 확인할 수 없습니다.'); }
      let owners: Awaited<ReturnType<typeof installedExtensionMigrations>>;
      try { owners = await installedExtensionMigrations(home, existing.names, build?.version, allowed, build?.schema_version); }
      catch { return locked('확장 manifest 또는 대상 core 호환성을 확인할 수 없습니다.'); }
      if (owners.some(o => o.replacement && records.get(o.owner)?.progress.transition)) return locked('중단된 확장 전환이 있습니다.');
      const validReplacementIdentity = async () => {
        for (const item of owners.filter(o => o.replacement)) {
          const registry = await store.getExtension(item.owner);
          if (!registry.ok || !registry.extension || registry.extension.version !== item.version) return false;
        }
        return true;
      };
      const journalPath = join(home, 'run', 'bootstrap-extension-migrations.json');
      type Journal = { commit: string; names: string[]; owner: string; promotionOwner?: string; previousHead?: string; offlineConfirmation?: NonNullable<PostgresInstallReport['offline_confirmation']> & { at: string } };
      let journal: Journal | null = null;
      try { journal = JSON.parse(await readFile(journalPath, 'utf8')) as Journal; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return locked('core 확장 정지 기록을 읽을 수 없습니다.'); }
      if (journal && (!build?.commit || journal.commit !== build.commit || !Array.isArray(journal.names) || JSON.stringify(journal.names) !== JSON.stringify(existing.names) || typeof journal.owner !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(journal.owner))) return locked('core 확장 정지 기록의 신원이 다릅니다.');
      if (!existing.fenceReady && existing.gateNames.length) return locked('정지 표와 migration 기록이 일치하지 않습니다.');
      if (existing.gateNames.some(name => !journal?.names.includes(name) && !records.get(name)?.progress.replacement)) return locked('다른 설치의 확장 정지가 있습니다.');
      let runtimeRoles: string[] = [];
      let recheckOffline = async () => {};
      const migrate = async (): Promise<PostgresInstallResult> => {
        await recheckOffline();
        if (existing.names.length) {
          const disk = await readBuildIdentity();
          if (!disk || disk.commit !== build?.commit || disk.version !== build.version || disk.schema_version !== build.schema_version) return locked('대기 중 대상 core 신원이 바뀌었습니다.');
        }
        if (!await validReplacementIdentity()) return locked('확장 설치 신원을 확인할 수 없습니다.');
        try {
          const currentRecords = await readProgress();
          if (JSON.stringify([...currentRecords]) !== JSON.stringify([...records])) return locked('확장 진행 기록이 바뀌었습니다.');
        } catch { return locked('확장 진행 기록을 확인할 수 없습니다.'); }
        const checkLegacy = async (): Promise<string | null> => {
          let facts: Awaited<ReturnType<typeof inspectLegacyExtensionPrerequisites>>;
          try { facts = await inspectLegacyExtensionPrerequisites(targetUrl.toString()); }
          catch { return '옛 schema의 확장 전제를 읽을 수 없습니다.'; }
          if (JSON.stringify(facts.map(f => f.name)) !== JSON.stringify(existing.names)) return '등록 확장 목록이 바뀌었습니다.';
          for (const f of facts) {
            if (f.enabled) return `확장 ${f.name}이 활성 상태입니다. 비활성화하세요.`;
            if (!f.held) return `확장 ${f.name}의 보류 그룹이 없습니다. 보류하세요.`;
            if (f.unheld_schedules || f.unheld_work) return `확장 ${f.name}에 보류되지 않은 예약 또는 미완료 일감이 있습니다. 보류하세요.`;
            if (f.running || f.open_attempts) return `확장 ${f.name}에 실행 중인 일감 또는 열린 attempt가 있습니다. 종료를 확인하세요.`;
          }
          return null;
        };
        if (legacy) {
          const problem = await checkLegacy(); if (problem) return locked(problem);
          const coreHistory = await runMigrations({ databaseUrl: targetUrl.toString(), clock, validateOnly: true });
          if (!coreHistory.ok) return coreHistory;
          if (coreHistory.to < installed!.schema_version) return locked('core migration 이력이 설치 기록보다 뒤에 있습니다.');
          const history = await runMigrations({ databaseUrl: targetUrl.toString(), clock, owners, validateOnly: true });
          if (!history.ok) return owners.some(o => o.replacement) ? locked('확장 migration 이력을 확인할 수 없습니다.') : history;
        }
        if (!legacy) {
          const replacements = owners.filter(o => o.replacement);
          if (replacements.length) {
            const history = await runMigrations({ databaseUrl: targetUrl.toString(), clock, owners: replacements, validateOnly: true });
            if (!history.ok) return owners.some(o => o.replacement) ? locked('확장 migration 이력을 확인할 수 없습니다.') : history;
          }
        }
        const gateOwners: (string | null)[] = [];
        for (const name of existing.fenceReady ? existing.names : []) {
          const state = await store.readExtensionQuiesce(name); if (!state.ok) return state;
          if (state.owner && state.owner !== journal?.owner && state.owner !== records.get(name)?.progress.replacement?.owner) return locked('다른 설치의 확장 정지가 있습니다.');
          gateOwners.push(state.owner);
        }
        let offlineConfirmation: PostgresInstallReport['offline_confirmation'];
        if (installed?.commit && build?.commit && installed.commit !== build.commit) {
          const { realpath } = await import('node:fs/promises'); const canonicalHome = await realpath(home);
          const homeOwner = await readFile(join(home, 'install.lock/owner'), 'utf8');
          const daemonOwner = await readFile(join(home, 'run/daemon.pid'), 'utf8');
          const journalBefore = await readFile(journalPath, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
          const manifests = await Promise.all(existing.names.map(name => readFile(join(home, 'extensions', name, 'manifest.json'), 'utf8')));
          // 관측 seam은 입력을 승인으로 해석하지 않는다. 운영 경로에는 관측자를 넣지 않는다.
          await options.observeOffline?.({ home: canonicalHome, previousCommit: installed.commit, targetCommit: build.commit, verificationId: randomUUID(), ...(legacy ? { legacySchema: installed.schema_version } : {}) });
          const [again, disk, current, homeLock, daemonLock, currentManifests, gateStates, files, journalAfter] = await Promise.all([readInstalled(home), readBuildIdentity(), inspectExtensionFence(targetUrl.toString()), readFile(join(home, 'install.lock/owner'), 'utf8').catch(() => ''), readFile(join(home, 'run/daemon.pid'), 'utf8').catch(() => ''), Promise.all(existing.names.map(name => readFile(join(home, 'extensions', name, 'manifest.json'), 'utf8'))), Promise.all((existing.fenceReady ? existing.names : []).map(name => store.readExtensionQuiesce(name))), readdir(join(home, 'extensions')).catch(error => { if (error.code === 'ENOENT') return []; throw error; }), readFile(journalPath, 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; })]);
          if (JSON.stringify(again) !== JSON.stringify(installed) || !disk || disk.commit !== build.commit || disk.version !== build.version || disk.schema_version !== build.schema_version || current.fenceReady !== existing.fenceReady || current.progressReady !== existing.progressReady || JSON.stringify(current.names) !== JSON.stringify(existing.names) || JSON.stringify([...current.gateNames].sort()) !== JSON.stringify([...existing.gateNames].sort()) || homeLock !== homeOwner || daemonLock !== daemonOwner || journalAfter !== journalBefore || JSON.stringify(currentManifests) !== JSON.stringify(manifests) || gateStates.some((state, index) => !state.ok || state.owner !== gateOwners[index]) || files.some(file => /^\.transition-[a-z][a-z0-9_]*\.json$/.test(file))) return locked('확인 중 설치 신원 또는 정지 상태가 바뀌었습니다.');
          try {
            const currentRecords = await readProgress();
            if (JSON.stringify([...currentRecords]) !== JSON.stringify([...records])) throw new Error('progress changed');
            owners = await installedExtensionMigrations(home, existing.names, build.version, allowed, build.schema_version);
            if (owners.some(o => o.replacement && currentRecords.get(o.owner)?.progress.transition)) throw new Error('transition');
          }
          catch { return locked('확인 중 확장 패키지 또는 대상 core 호환성이 바뀌었습니다.'); }
          if (!await validReplacementIdentity()) return locked('확인 중 확장 설치 신원이 바뀌었습니다.');
          if (legacy) {
            const problem = await checkLegacy(); if (problem) return locked(`확인 중 전제가 바뀌었습니다. ${problem}`);
            const coreHistory = await runMigrations({ databaseUrl: targetUrl.toString(), clock, validateOnly: true });
            if (!coreHistory.ok) return coreHistory;
            if (coreHistory.to < installed!.schema_version) return locked('core migration 이력이 설치 기록보다 뒤에 있습니다.');
            const history = await runMigrations({ databaseUrl: targetUrl.toString(), clock, owners, validateOnly: true });
            if (!history.ok) return owners.some(o => o.replacement) ? locked('확장 migration 이력을 확인할 수 없습니다.') : history;
          }
          if (!legacy) {
            const replacements = owners.filter(o => o.replacement);
            if (replacements.length) {
              const history = await runMigrations({ databaseUrl: targetUrl.toString(), clock, owners: replacements, validateOnly: true });
              if (!history.ok) return locked('확인 중 확장 migration 이력을 확인할 수 없습니다.');
            }
          }
          await recheckOffline();
          offlineConfirmation = { home: canonicalHome, previous_commit: installed.commit, target_commit: build.commit, method: 'automatic', evidence: { daemon_fenced: true, install_locked: true, runtime_roles: runtimeRoles, runtime_backends: 0, previous_processes: 0 } };
        }
        if ((existing.names.length || offlineConfirmation) && !journal) {
          journal = { commit: build!.commit!, names: existing.names, owner: randomUUID() };
        }
        // This is an audit fact, never a reusable authorization. Every retry
        // revalidates while the entry locks are held.
        if (journal && env.SECOND_BRAIN_STAGED_APP) {
          const marker = await readFile(join(home, '.app-promotion.json'), 'utf8').catch(error => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; });
          if (marker === null) { journal.promotionOwner = env.SECOND_BRAIN_INSTALL_LOCK_OWNER; journal.previousHead = env.SECOND_BRAIN_PREVIOUS_APP_HEAD; }
          else {
            let record: { owner?: unknown; previousHead?: unknown }; try { record = JSON.parse(marker) as typeof record; } catch { return locked('중단된 app 전환 기록을 읽을 수 없습니다.'); }
            if (typeof record.owner !== 'string' || record.owner !== journal.promotionOwner || record.previousHead !== journal.previousHead) return locked('중단된 app 전환 소유권 또는 신원이 다릅니다.');
          }
        }
        if (journal && offlineConfirmation) journal.offlineConfirmation = { ...offlineConfirmation, at: clock.now().toISOString() };
        if (journal && (offlineConfirmation || !existing.gateNames.length)) {
          await mkdir(join(home, 'run'), { recursive: true, mode: 0o700 });
          const temp = `${journalPath}.${randomUUID()}`;
          try { await writeFile(temp, JSON.stringify(journal), { flag: 'wx', mode: 0o600 }); await rename(temp, journalPath); } finally { await rm(temp, { force: true }); }
        }
        for (const name of legacy ? [] : existing.names.filter(name => !records.get(name)?.progress.replacement)) {
          const stopped = await quiesceExtension(store, systemTimer, { name, owner: journal!.owner, now: clock.now(), refuseRunning: true });
          if (!stopped.ok) return stopped;
        }
        await promoteStagedApp(home, env, journal?.promotionOwner);
        const prepared = await prepareDatabase({ databaseUrl: secrets.adminUrl, appPassword: secrets.appPassword, ...(options.databaseName === undefined ? {} : { databaseName: options.databaseName }) });
        if (!prepared.ok) return { ...prepared, message: `${prepared.message}\n기존 볼륨의 비밀번호를 확인하세요` };
        const migrated = await runMigrations({ databaseUrl: prepared.databaseUrl, clock, coreMaxVersion: 31 });
        if (!migrated.ok) return migrated;
        const owner = await store.ensureSelfUser({ id: v7(), name: userInfo().username, createdAt: clock.now() });
        if (!owner.ok) return owner;
        let bridgeApplied: string[] = [];
        if (legacy) {
          const bridge = await runMigrations({ databaseUrl: prepared.databaseUrl, clock, coreMaxVersion: 35 });
          if (!bridge.ok) return bridge;
          bridgeApplied = bridge.applied;
          for (const name of existing.names.filter(name => !records.get(name)?.progress.replacement)) {
            const stopped = await quiesceExtension(store, systemTimer, { name, owner: journal!.owner, now: clock.now(), refuseRunning: true });
            if (!stopped.ok) return stopped;
          }
        }
        const completed = await runMigrations({ databaseUrl: prepared.databaseUrl, clock });
        if (!completed.ok) return completed;
        const applied = [...migrated.applied, ...bridgeApplied, ...completed.applied];
        const applicableOwners = owners.filter(o => !o.replacement);
        if (applicableOwners.length) {
          const extensions = await runMigrations({ databaseUrl: prepared.databaseUrl, clock, owners: applicableOwners });
          if (!extensions.ok) return extensions;
          applied.push(...extensions.applied);
        }
        for (const replacement of owners.filter(o => o.replacement)) {
          const previous = records.get(replacement.owner);
          if (previous?.progress.replacement) continue;
          const registry = await store.getExtension(replacement.owner);
          if (!registry.ok || !registry.extension) return locked('확장 등록 정보를 확인할 수 없습니다.');
          const progress: ExtensionInstallProgress = previous?.progress ?? { name: replacement.owner, packageDigest: await packageDigest(join(home, 'extensions', replacement.owner), ''), result: null, failedStage: null, lastFailure: null, stages: {}, authWorkId: null, scheduleIds: [] };
          const saved = await store.writeExtensionInstallProgress({ expectedRevision: previous?.revision ?? null, progress: { ...progress, replacement: { owner: journal!.owner, fromVersion: registry.extension.version, at: clock.now().toISOString() } } });
          if (!saved.ok) return saved;
          if (!saved.written) return locked('확장 진행 기록이 바뀌었습니다.');
        }
        for (const name of existing.names.filter(name => !owners.some(o => o.owner === name && o.replacement))) {
          const released = await store.endExtensionQuiesce({ name, owner: journal!.owner });
          if (!released.ok) return released;
          if (!released.released) return locked('확장 정지 소유권이 바뀌었습니다.');
        }
        if (offlineConfirmation) await writeFile(join(home, 'run/last-core-update.json'), JSON.stringify({ ...offlineConfirmation, at: clock.now().toISOString() }), { mode: 0o600 });
        if (journal && !env.SECOND_BRAIN_STAGED_APP) await rm(journalPath, { force: true });
        return { ok: true, report: { ...resources, schema_version: completed.to, applied, owner_created: owner.created, owner_name: owner.user.name, compose_started: composeStarted, ...(offlineConfirmation ? { offline_confirmation: offlineConfirmation } : {}) } };
      };
      const lockAll = (index: number): Promise<PostgresInstallResult> => index === existing.names.length ? migrate() : withExtensionInstallLock(targetUrl.toString(), existing.names[index]!, () => lockAll(index + 1));
      const interruptedRuntime = await readFile(runtimeFencePath(home)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
      const differentCore = !!installed?.commit && installed.commit !== build?.commit;
      if (!existing.names.length && !differentCore && !interruptedRuntime) return await lockAll(0);
      try {
        return await withOfflineRuntime({ home, env, clock, commit: build?.commit ?? null, readGroups: async () => (await import('second_brain/postgres')).runtimeProcessGroups(targetUrl.toString()) }, async recheck => { recheckOffline = recheck; return !differentCore && !interruptedRuntime ? lockAll(0) : withRuntimeFence(home, targetUrl.toString(), async state => {
          runtimeRoles = state.roles.map(role => role.name);
          return lockAll(0);
        }, { targetCommit: build?.commit ?? null, groups: await (await import('second_brain/postgres')).runtimeProcessGroups(targetUrl.toString()) }); });
      } catch (error) { return locked(error instanceof Error ? error.message : '자동 정지 검증에 실패했습니다.'); }
    } finally { await store.close(); }
  } catch (error) { return { ok: false, code: 'DB_UNAVAILABLE', message: `PostgreSQL 설치에 실패했습니다: ${error instanceof Error ? error.message : String(error)}` }; }
}
