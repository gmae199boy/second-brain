import { cp, mkdir, mkdtemp, readFile, rename, rm, lstat, readdir, chmod, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { envFilePath } from '../config/paths.js';
import { fileURLToPath } from 'node:url';
import type { Clock, ExtensionRuntime } from 'second_brain';
import { extensionAdminUrl, resolveStoreUrl, type ReadConfigResult } from '../config/codec.js';
import { prepareExtensionPython } from './extension-python.js';
import { systemTimer } from './clock.js';
import { systemProcessLauncher } from './process-group.js';
import { systemProcessInspector } from './process-inspector.js';

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
async function checkTree(folder: string): Promise<void> {
  const root = await lstat(folder);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('확장 패키지는 실제 폴더여야 합니다');
  for (const entry of await readdir(folder)) {
    const path = join(folder, entry), stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('확장 패키지에 심볼릭 링크를 둘 수 없습니다');
    if (stat.isDirectory()) await checkTree(path);
  }
}
export function extensionRuntime({ home, env, config, clock }: { home: string; env: NodeJS.ProcessEnv; config: ReadConfigResult; clock: Clock }): ExtensionRuntime {
  const pending = new Map<string, { stage: string; target: string; backup: string; moved: boolean }>();
  const databaseUrl = async () => {
    if (!config.ok) throw new Error('설정을 읽을 수 없습니다');
    const url = await resolveStoreUrl(home, config.config.storeUrlEnv, env);
    if (!url) throw new Error('데이터베이스 연결 주소가 없습니다');
    return url;
  };
  return {
    async readSecrets() {
      try { return Object.fromEntries(Object.entries(parseEnv(await readFile(envFilePath(home), 'utf8'))).filter((entry): entry is [string, string] => entry[1] !== undefined)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
    },
    machineValues: name => ({ tokenstore: join(home, 'extensions', name, 'tokenstore') }),
    databaseUrl, preparePython: directory => prepareExtensionPython(directory, env), timer: systemTimer, launcher: { start: spec => systemProcessLauncher.start({ ...spec, command: spec.command === 'node' ? process.execPath : spec.command }) }, inspector: systemProcessInspector,
    packages: {
      async rollback(name) {
        const placement = pending.get(name); if (!placement) return;
        await rm(placement.target, { recursive: true, force: true });
        if (placement.moved) await rename(placement.backup, placement.target);
        await rm(placement.stage, { recursive: true, force: true }); pending.delete(name);
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
        if (pending.has(name)) throw new Error('확장 설치가 이미 진행 중입니다');
        await checkTree(dir);
        const folder = resolve(home, 'extensions');
        await mkdir(folder, { recursive: true, mode: 0o700 }); await chmod(folder, 0o700);
        const stage = await mkdtemp(join(folder, '.install-'));
        const target = join(folder, name), backup = join(stage, 'previous');
        let moved = false;
        try {
          const staged = join(stage, name);
          await cp(dir, staged, { recursive: true, errorOnExist: true, force: false });
          const previousTokenstore = join(target, 'tokenstore');
          let tokenstore: Awaited<ReturnType<typeof lstat>> | undefined;
          try { tokenstore = await lstat(previousTokenstore); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          if (tokenstore) {
            if (tokenstore.isSymbolicLink()) throw new Error('tokenstore에 심볼릭 링크를 둘 수 없습니다');
            if (tokenstore.isDirectory()) await checkTree(previousTokenstore);
            await rm(join(staged, 'tokenstore'), { recursive: true, force: true });
            await cp(previousTokenstore, join(staged, 'tokenstore'), { recursive: true, errorOnExist: true, force: false });
          }
          try { await rename(target, backup); moved = true; }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          try { await rename(staged, target); }
          catch (error) { if (moved) await rename(backup, target); throw error; }
          pending.set(name, { stage, target, backup, moved });
          return target;
        } catch (error) {
          await rm(stage, { recursive: true, force: true });
          throw error;
        }
      },
    },
    migrator: {
      async apply(owner, directory) {
        let result: Awaited<ReturnType<ExtensionRuntime['migrator']['apply']>>;
        try {
          const { runMigrations } = await import('second_brain/postgres');
          result = await runMigrations({ databaseUrl: await extensionAdminUrl(home, await databaseUrl(), env), clock, owners: [{ owner, directory }] });
        } catch { result = { ok: false, code: 'DB_UNAVAILABLE', message: '확장 마이그레이션의 관리 연결을 열지 못했습니다' }; }
        const placement = pending.get(owner);
        if (placement) {
          if (!result.ok) {
            await rm(placement.target, { recursive: true, force: true });
            if (placement.moved) await rename(placement.backup, placement.target);
          }
          await rm(placement.stage, { recursive: true, force: true });
          pending.delete(owner);
        }
        return result;
      },
    },
  };
}
