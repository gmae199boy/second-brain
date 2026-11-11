import { systemClock, systemTimer } from './clock.js';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cleanProcessGroup, type GroupIdentity, type ProcessLauncher } from 'second_brain';
import { systemProcessInspector } from './process-inspector.js';
import { systemProcessLauncher } from './process-group.js';
const registry = (home: string) => join(home, 'run/process-groups');
/** spawn 전 intent를 남긴다. 신원 저장 전에 죽으면 자동 회수하지 않는다. */
export function trackedProcessLauncher(home: string): ProcessLauncher {
  return { async start(spec) {
    const folder = registry(home), path = join(folder, `${randomUUID()}.json`);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await writeFile(path, JSON.stringify({ ownerPid: process.pid, starting: true }), { flag: 'wx', mode: 0o600 });
    const started = await systemProcessLauncher.start(spec);
    if (!started.ok) { await rm(path); return started; }
    try {
    const boot = await systemProcessInspector.bootTime(), at = await systemProcessInspector.startedAt(started.handle.pid);
    const temp = `${path}.tmp`;
    await writeFile(temp, JSON.stringify({ ownerPid: process.pid, pgid: started.handle.pid, osBootAt: boot.state === 'found' ? boot.value : null, osStartedAt: at.state === 'found' ? at.value : null }), { flag: 'wx', mode: 0o600 });
    await rename(temp, path);
    return started;
    } catch (error) { started.handle.signalGroup('SIGKILL'); await started.handle.exited; started.handle.closeOutput(); throw error; }
  } };
}
export async function recordedProcessGroups(home: string): Promise<GroupIdentity[]> {
  const folder = registry(home), files = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const groups: GroupIdentity[] = [];
  for (const name of files) {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error('프로세스 정지 기록이 불완전합니다. 이전 실행과 모든 자식 종료를 확인하고 복구하세요');
    const value = JSON.parse(await readFile(join(folder, name), 'utf8')) as { starting?: boolean; pgid?: number; osBootAt?: string | null; osStartedAt?: string | null };
    if (value.starting || !Number.isSafeInteger(value.pgid) || value.pgid! < 1 || [value.osBootAt, value.osStartedAt].some(at => at !== null && (typeof at !== 'string' || !Number.isFinite(new Date(at).getTime())))) throw new Error('프로세스 그룹의 종료 신원이 불명확합니다. 이전 실행과 모든 자식 종료를 확인하고 복구하세요');
    groups.push({ pgid: value.pgid!, osBootAt: value.osBootAt ? new Date(value.osBootAt) : null, osStartedAt: value.osStartedAt ? new Date(value.osStartedAt) : null });
  }
  return groups;
}
/** 설치기 자식도 같은 영속 그룹 기록을 사용한다. 출력은 호출자에게만 반환한다. */
export async function trackedExec(home: string, command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  const result = await trackedProcessLauncher(home).start({ command, args, env: Object.fromEntries(Object.entries(process.env).filter((pair): pair is [string, string] => pair[1] !== undefined)) });
  if (!result.ok) throw new Error(result.message);
  const consume = async (stream: AsyncIterable<string>) => { let text = ''; for await (const chunk of stream) { text += chunk; if (text.length > 4 * 1024 * 1024) throw new Error('설치기 자식 출력이 너무 큽니다'); } return text; };
  const boot = await systemProcessInspector.bootTime(), at = await systemProcessInspector.startedAt(result.handle.pid);
  const identity = { pgid: result.handle.pid, osBootAt: boot.state === 'found' ? boot.value : null, osStartedAt: at.state === 'found' ? at.value : null };
  const output = [consume(result.handle.stdout), consume(result.handle.stderr)];
  try {
    const [exit, stdout, stderr] = await Promise.all([result.handle.exited, ...output]);
    if ((exit as { code: number | null }).code !== 0) throw new Error('설치기 자식 명령이 실패했습니다');
    return { stdout: stdout as string, stderr: stderr as string };
  } finally {
    const cleaned = await cleanProcessGroup({ inspector: systemProcessInspector, identity, clock: systemClock, timer: systemTimer, handle: result.handle, graceMs: 200, confirmMs: 1000 });
    result.handle.closeOutput();
    await Promise.allSettled(output);
    if (cleaned !== 'died') throw new Error('설치기 자식 그룹의 종료를 확인하지 못했습니다. 프로세스 기록을 보존했습니다');
  }
}
