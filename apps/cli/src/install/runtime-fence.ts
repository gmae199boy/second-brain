import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { RuntimeFenceState } from 'second_brain/postgres';

export const runtimeFencePath = (home: string) => join(home, 'run/core-update.json');
export interface OfflineFacts { targetCommit: string | null; groups: { pgid: number; osBootAt: Date | null; osStartedAt: Date | null }[] }
export const RUNTIME_FENCE_RECOVERY = 'core 갱신의 런타임 접속 정지 기록이 남았습니다. 기존 설치와 자식이 모두 종료된 뒤 같은 설치기를 다시 실행하면 로그인 상태를 복구합니다. install.lock이 남아 있으면 소유 프로세스와 모든 자식 종료를 확인한 뒤 그 잠금만 복구하세요. 정지 기록은 지우지 마세요';
/** 홈 설치 잠금 아래에서만 호출한다. 비밀은 journal에 기록하지 않는다. */
export async function withRuntimeFence<T>(home: string, databaseUrl: string, run: (state: RuntimeFenceState) => Promise<T>, facts?: OfflineFacts): Promise<T> {
  const path = runtimeFencePath(home);
  const { runtimeDatabaseFence } = await import('second_brain/postgres');
  const db = await runtimeDatabaseFence(databaseUrl);
  try {
    let previous: RuntimeFenceState | undefined;
    try { previous = JSON.parse(await readFile(path, 'utf8')) as RuntimeFenceState; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(RUNTIME_FENCE_RECOVERY); }
    if (previous) { await db.restore(previous); await rm(path); }
    const state = await db.snapshot();
    await mkdir(join(home, 'run'), { recursive: true, mode: 0o700 });
    const temp = `${path}.${randomUUID()}`;
    try { await writeFile(temp, JSON.stringify({ ...state, installerPid: process.pid, ...facts }), { flag: 'wx', mode: 0o600 }); await rename(temp, path); }
    finally { await rm(temp, { force: true }); }
    try { await db.block(state); return await run(state); }
    finally { await db.restore(state); await rm(path); }
  } finally { await db.close(); }
}
