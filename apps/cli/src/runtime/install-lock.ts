import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

/** The directory is never automatically reclaimed: installer children may survive. */
export async function withHomeInstallLock<T>(home: string, run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lock = join(home, 'install.lock'), pidFile = join(lock, 'pid'), ownerFile = join(lock, 'owner');
  const owner = `${process.pid} ${randomUUID()}\n`;
  await mkdir(home, { recursive: true, mode: 0o700 });
  let warned = false;
  while (true) {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'EXTENSION_INSTALL_CANCELLED' });
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (!warned) { process.stderr.write('다른 설치가 진행 중이거나 이전 설치 잠금이 남아 기다립니다. 복구하려면 새 설치를 차단하고 이전 설치와 모든 자식의 공유 상태 쓰기 종료를 확인한 뒤 해당 잠금만 제거하고 다시 실행하세요.\n'); warned = true; }
      try { await delay(100, undefined, { signal }); } catch { throw Object.assign(new Error('cancelled'), { code: 'EXTENSION_INSTALL_CANCELLED' }); }
      continue;
    }
    // If either write fails, preserve the ambiguous lock for explicit recovery.
    await writeFile(pidFile, `${process.pid}\n`, { flag: 'wx', mode: 0o600 });
    await writeFile(ownerFile, owner, { flag: 'wx', mode: 0o600 });
    break;
  }
  try {
    if (signal?.aborted) throw Object.assign(new Error('cancelled'), { code: 'EXTENSION_INSTALL_CANCELLED' });
    return await run();
  } finally {
    if (await readFile(ownerFile, 'utf8').catch(() => '') === owner) await rm(lock, { recursive: true, force: true });
  }
}

/** Bootstrap owns the lock until its installer child has exited. */
export async function withInstallerHomeLock<T>(home: string, env: NodeJS.ProcessEnv, run: () => Promise<T>): Promise<T> {
  const inherited = env.SECOND_BRAIN_INSTALL_LOCK_OWNER;
  if (inherited && inherited === await readFile(join(home, 'install.lock', 'owner'), 'utf8').catch(() => '') && inherited.startsWith(`${process.ppid} `)) return run();
  return withHomeInstallLock(home, run);
}
