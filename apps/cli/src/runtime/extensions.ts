import { extensionTransitions } from './extension-transition.js';
import { randomUUID } from 'node:crypto';
import { prepareExtensionPackage, checkPackageCore, checkInstalledCore, digestPackageFiles, needsPython, observePackage, readPackageObservation } from './extension-package.js';
import { withHomeInstallLock } from './install-lock.js';
import { validateSchema, validateValue } from './json-schema.js';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { cp, mkdir, mkdtemp, readFile, rename, rm, lstat, readdir, chmod, realpath, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { envFilePath } from '../config/paths.js';
import { fileURLToPath } from 'node:url';
import { decodeExtensionManifest, decodeRetiredExtensionManifest, isExtensionName, validateMigrationNames, type Clock, type ExtensionRuntime } from 'second_brain';
import { extensionAdminUrl, resolveStoreUrl, ensureExtensionPassword, extensionDatabaseUrl, type ReadConfigResult } from '../config/codec.js';
import { prepareExtensionPython, validatePreparedPython, validatePythonInputs } from './extension-python.js';
import { readBuildIdentity } from '../install/installed.js';
import { daemonLiveness } from '../daemon/liveness.js';
import { readDaemonLock } from '../daemon/lock.js';
import { systemTimer } from './clock.js';
import { systemProcessLauncher } from './process-group.js';
import { systemProcessInspector } from './process-inspector.js';

// Capture at module load, before an install command can wait for the shared
// lock. Never use the post-wait on-disk build as the identity of loaded code.
const runningBuildIdentity = readBuildIdentity();

async function realHome(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    return resolve(path);
  }
}
export async function testExtensionsFolder(home: string, env: NodeJS.ProcessEnv, defaultHome: string): Promise<string | undefined> {
  const [actualHome, actualDefaultHome] = await Promise.all([realHome(home), realHome(defaultHome)]);
  return actualHome === actualDefaultHome ? undefined : env['SECOND_BRAIN_TEST_EXTENSIONS']?.trim() || undefined;
}
// A package is copied as data. Refuse symbolic links so a declared path can
// never escape the package through a link during copying or later execution.
async function checkTree(folder: string, ownedStage = false): Promise<void> {
  const root = await lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('확장 패키지는 실제 폴더여야 합니다');
  for (const entry of await readdir(folder)) {
    const path = join(folder, entry), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('확장 패키지에 심볼릭 링크를 둘 수 없습니다');
    if (ownedStage && entry === '.venv') { if (!stat.isDirectory()) throw new Error('invalid environment'); continue; }
    if (stat.isDirectory()) await checkTree(path);
  }
}
// 생성된 환경과 확장의 영속 상태는 패키지 내용이 아니다.
export async function packageDigest(folder: string, migrations: string, omitMigrations = false): Promise<string> {
  const hash = createHash('sha256');
  async function visit(dir: string, relative: string): Promise<void> {
    for (const name of (await readdir(dir)).sort()) {
      const path = relative ? `${relative}/${name}` : name;
      if (path === '.venv' || path === 'tokenstore' || path === 'staging' || path === 'reports' || name === '__pycache__' || name.endsWith('.pyc') || (omitMigrations && (path === migrations || path.startsWith(`${migrations}/`)))) continue;
      const full = join(dir, name), stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new Error('확장 패키지에 심볼릭 링크를 둘 수 없습니다');
      if (stat.isDirectory()) { hash.update(`d${path.length}:${path}`); await visit(full, path); }
      else if (stat.isFile()) { const bytes = await readFile(full); hash.update(`f${path.length}:${path}:${bytes.length}:`); hash.update(bytes); }
      else throw new Error('확장 패키지에 일반 파일이 아닌 항목이 있습니다');
    }
  }
  await visit(folder, ''); return hash.digest('hex');
}
/** 등록된 확장의 manifest만 읽고 런타임을 준비하지 않는다. */
export async function installedExtensionMigrations(home: string, names: readonly string[], targetVersion?: string, retiredAllowed: ReadonlySet<string> = new Set()): Promise<{ owner: string; directory: string; replacement?: true; version?: string }[]> {
  const folder = join(home, 'extensions');
  const owners: { owner: string; directory: string; replacement?: true; version?: string }[] = [];
  for (const name of [...names].sort()) {
    if (!isExtensionName(name)) throw new Error(`잘못된 확장 폴더: ${name}`);
    const directory = join(folder, name);
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`잘못된 확장 폴더: ${name}`);
    const manifestPath = join(directory, 'manifest.json');
    const manifestStat = await lstat(manifestPath);
    if (!manifestStat.isFile() || manifestStat.isSymbolicLink()) throw new Error(`확장 manifest가 일반 파일이 아닙니다: ${name}`);
    const text = await readFile(manifestPath, 'utf8');
    const current = decodeExtensionManifest(text, validateSchema);
    const retired = !current.ok && retiredAllowed.has(name) ? decodeRetiredExtensionManifest(text, validateSchema) : null;
    const decoded = current.ok ? current : retired;
    if (!decoded?.ok || decoded.manifest.name !== name) throw new Error(`확장 manifest가 올바르지 않습니다: ${name}`);
    const replacement = !current.ok || (retiredAllowed.has(name) && !current.manifest.core_compat);
    if (targetVersion && current.ok && !replacement) {
      if (!current.manifest.core_compat) throw new Error(`대상 core 호환 범위가 없습니다: ${name}`);
      const { compareRelease } = await import('./extension-package.js');
      if (compareRelease(targetVersion, current.manifest.core_compat.min) < 0 || compareRelease(targetVersion, current.manifest.core_compat.max_exclusive) >= 0) throw new Error(`대상 core와 확장이 호환되지 않습니다: ${name}`);
    }
    let path = directory;
    for (const part of decoded.manifest.migrations.split('/')) {
      path = join(path, part);
      const item = await lstat(path);
      if (!item.isDirectory() || item.isSymbolicLink()) throw new Error(`확장 마이그레이션 폴더가 올바르지 않습니다: ${name}`);
    }
    for (const file of await readdir(path)) {
      if (!/^\d{4}_.+\.sql$/.test(file)) continue;
      const item = await lstat(join(path, file));
      if (!item.isFile() || item.isSymbolicLink()) throw new Error(`확장 마이그레이션이 일반 파일이 아닙니다: ${name}/${file}`);
    }
    owners.push({ owner: name, directory: path, ...(replacement ? { replacement: true as const, version: decoded.manifest.version } : {}) });
  }
  return owners;
}
export function extensionRuntime({ home, env, config, clock }: { home: string; env: NodeJS.ProcessEnv; config: ReadConfigResult; clock: Clock }): ExtensionRuntime {
  const transition = extensionTransitions(home);
  const databaseUrl = async () => {
    if (!config.ok) throw new Error('설정을 읽을 수 없습니다');
    const url = await resolveStoreUrl(home, config.config.storeUrlEnv, env);
    if (!url) throw new Error('데이터베이스 연결 주소가 없습니다');
    return url;
  };
  async function safeFile(parts: string[]): Promise<string> {
    let path = home;
    for (const part of parts.slice(0, -1)) {
      path = join(path, part); const stat = await lstat(path);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid extension path');
    }
    const file = await open(join(path, parts[parts.length - 1]!), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { const stat = await file.stat(); if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('invalid extension file'); return await file.readFile('utf8'); }
    finally { await file.close(); }
  }
  return {
    validateSchema, validateValue, installedDirectory: name => join(home, 'extensions', name),
    async installedManifest(name) { if (!isExtensionName(name)) throw new Error('invalid extension'); return safeFile(['extensions', name, 'manifest.json']); },
    // [ASSUMPTION] 공개 보고 파일의 고정 이름은 public.json이다.
    async readPublicReport(name, workId) { if (!isExtensionName(name) || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(workId)) throw new Error('invalid report'); return JSON.parse(await safeFile(['extensions', name, 'reports', workId, 'public.json'])); },
    async secureCredentials() { await chmod(envFilePath(home), 0o600); },
    async schedulerReady() {
      try {
        const live = await daemonLiveness({ home, clock }); if (!live.alive) return false;
        const owner = await readDaemonLock(home); if (!owner || owner.pid !== live.pid) return false;
        const ready = JSON.parse(await readFile(join(home, 'run', 'supervisor-ready.json'), 'utf8')) as { pid?: number; startedAt?: string; at?: string };
        const age = clock.now().getTime() - Date.parse(ready.at ?? '');
        return ready.pid === owner.pid && ready.startedAt === owner.startedAt.toISOString() && Number.isFinite(age) && age >= 0 && age <= 20_000;
      } catch { return false; }
    },
    withHomeInstallLock: (run, signal) => withHomeInstallLock(home, run, signal),
    async withCommandLock(name, run, signal) {
      const { withExtensionInstallLock } = await import('second_brain/postgres');
      return withExtensionInstallLock(await databaseUrl(), name, run, signal, { queryTimeoutMs: 1000 });
    },
    async withInstallLock(name, run, signal) {
      const { withExtensionInstallLock } = await import('second_brain/postgres');
      return withExtensionInstallLock(await databaseUrl(), name, run, signal);
    },
    async provision(name) {
      try {
        const { provisionExtension } = await import('second_brain/postgres');
        const adminUrl = await extensionAdminUrl(home, await databaseUrl(), env);
        await provisionExtension(adminUrl, name, () => ensureExtensionPassword(home, name));
        return { ok: true as const };
      } catch { return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '확장 역할을 준비하지 못했습니다' }; }
    },
    async readSecrets() {
      try { return Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    },
    machineValues: name => ({ tokenstore: join(home, 'extensions', name, 'tokenstore') }),
    databaseUrl: async name => { await chmod(envFilePath(home), 0o600); return extensionDatabaseUrl(home, name, await databaseUrl()); }, preparePython: (directory, signal, resetOwnedStage) => prepareExtensionPython(directory, env, signal, resetOwnedStage), validatePreparedPython: (directory, signal) => validatePreparedPython(directory, env, signal), timer: systemTimer, launcher: { start: spec => systemProcessLauncher.start({ ...spec, command: spec.command === 'node' ? process.execPath : spec.command }) }, inspector: systemProcessInspector,
    packages: {
      prepareExternal: prepareExtensionPackage,
      captureRunningCore: async () => { await runningBuildIdentity; },
      checkCore: async manifest => checkPackageCore(home, manifest, await runningBuildIdentity),
      checkInstalledCore: async () => checkInstalledCore(home, await runningBuildIdentity),
      async preflight(directory, manifest) {
        try {
          await checkTree(directory);
          const migrationDirectory = join(directory, manifest.migrations);
          const stat = await lstat(migrationDirectory); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid migrations directory');
          const names = validateMigrationNames(await readdir(migrationDirectory));
          await Promise.all(names.map(async name => { const item = await lstat(join(migrationDirectory, name)); if (!item.isFile() || item.isSymbolicLink()) throw new Error('invalid migration file'); }));
        } catch { return { ok: false as const, code: 'EXTENSION_INVALID' as const, message: '확장 마이그레이션 파일이 올바르지 않습니다' }; }
        if (needsPython(manifest)) {
          try { await validatePythonInputs(directory); }
          catch { return { ok: false as const, code: 'EXTENSION_PYTHON_PIN_INVALID' as const, message: 'Python 확장 의존 파일이나 버전 지정이 올바르지 않습니다' }; }
        }
        return { ok: true as const };
      },
      observe: observation => observePackage(home, observation),
      readObservation: name => readPackageObservation(home, name),
      async inspect(name, dir, migrations, files, stageOwner) {
        if (stageOwner && dir !== await transition.stagedDirectory(name, stageOwner)) throw new Error('invalid owned stage');
        await checkTree(dir, !!stageOwner);
        const listedDigest = async (root: string) => {
          const bytes = new Map<string, Buffer>();
          for (const path of files!) { const full = join(root, path); const stat = await lstat(full); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('invalid package file'); bytes.set(path, await readFile(full)); }
          return digestPackageFiles(files!, bytes);
        };
        const digest = files ? await listedDigest(dir) : await packageDigest(dir, migrations);
        const target = join(home, 'extensions', name);
        try {
          const installedDigest = files ? await listedDigest(target) : await packageDigest(target, migrations);
          const sameBase = await packageDigest(dir, migrations, true) === await packageDigest(target, migrations, true);
          return { digest, installedDigest, sameBase, installedDir: target };
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { digest, installedDigest: null, sameBase: false, installedDir: target };
          throw error;
        }
      },
      async sameBase(first, second, migrations) { return await packageDigest(first, migrations, true) === await packageDigest(second, migrations, true); },
      async refreshMigrations(name, dir, migrations) {
        const target = join(home, 'extensions', name, migrations);
        const stage = await mkdtemp(join(home, 'extensions', '.migrations-'));
        const staged = join(stage, 'new'), backup = join(stage, 'previous');
        let moved = false;
        try {
          await cp(join(dir, migrations), staged, { recursive: true, errorOnExist: true, force: false });
          await rename(target, backup); moved = true;
          try { await rename(staged, target); } catch (error) { await rename(backup, target); moved = false; throw error; }
        } finally { if (!moved || await lstat(target).then(() => true, () => false)) await rm(stage, { recursive: true, force: true }); }
      },
      transition,
      async rollback(name, preserveInitial = false) {
        const journal = await transition.read(name); if (!journal) return;
        if (preserveInitial && journal.hadPrevious === false && journal.phase === 'active') await transition.commit(name, journal.owner);
        else await transition.rollback(name, journal.owner);
      },
      async finalizePlacement(name) {
        const journal = await transition.read(name); if (journal) await transition.commit(name, journal.owner);
      },
      async resolve(name) {
        const test = await testExtensionsFolder(home, env, join(homedir(), '.second_brain'));
        const roots = [fileURLToPath(new URL('../../extensions/', import.meta.url)), ...(test === undefined ? [] : [test])];
        for (const root of roots) {
          const dir = join(root, name);
          try { return { ok: true, dir, manifestText: await readFile(join(dir, 'manifest.json'), 'utf8') }; }
          catch (error) { if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
        }
        return { ok: false };
      },
      async place(name, dir) {
        await checkTree(dir);
        const existing = await transition.read(name);
        if (existing) throw new Error('미완료 확장 전환을 먼저 복구해야 합니다');
        const owner = randomUUID(), digest = await packageDigest(dir, '');
        await transition.prepare({ name, owner, digest, directory: dir });
        const stage = await transition.stagedDirectory(name, owner);
        if (await packageDigest(stage, '') !== digest) { await transition.rollback(name, owner); throw new Error('확장 패키지 복사 중 내용이 바뀌었습니다'); }
        return transition.activate(name, owner);
      },
    },
    migrator: {
      async validate(owner, directory) {
        try {
          const { runMigrations } = await import('second_brain/postgres');
          const adminUrl = await extensionAdminUrl(home, await databaseUrl(), env);
          return await runMigrations({ databaseUrl: adminUrl, clock, owners: [{ owner, directory }], validateOnly: true });
        } catch { return { ok: false as const, code: 'DB_UNAVAILABLE' as const, message: '확장 마이그레이션의 관리 연결을 열지 못했습니다' }; }
      },
      async apply(owner, directory) {
        let result: Awaited<ReturnType<ExtensionRuntime['migrator']['apply']>>;
        try {
          const { runMigrations } = await import('second_brain/postgres');
          const adminUrl = await extensionAdminUrl(home, await databaseUrl(), env);
          result = await runMigrations({ databaseUrl: adminUrl, clock, owners: [{ owner, directory }] });
        } catch { result = { ok: false, code: 'DB_UNAVAILABLE', message: '확장 마이그레이션의 관리 연결을 열지 못했습니다' }; }
        if (!result.ok) {
          const journal = await transition.read(owner);
          if (journal && journal.hadPrevious) await transition.rollback(owner, journal.owner);
        }
        return result;
      },
    },
  };
}
