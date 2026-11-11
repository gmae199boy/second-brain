import { recordedProcessGroups } from '../runtime/process-registry.js';
import { readFile } from 'node:fs/promises';
import { runtimeFencePath } from './runtime-fence.js';
import { systemProcessInspector } from '../runtime/process-inspector.js';
import { inspectGroup, type GroupIdentity } from 'second_brain';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stopDaemon, startDaemon } from '../daemon/control.js';
import { systemLaunchctl, daemonLabel, type Launchctl } from '../daemon/launchd.js';
import { acquireOfflineDaemonFence, readDaemonLock, releaseDaemonLock } from '../daemon/lock.js';
import type { Clock } from 'second_brain';
const execute = promisify(execFile);
interface Row { pid: number; parent: number; group: number; command: string }
/** argv의 줄바꿈을 PID 행으로 오인하지 않도록 숫자 표를 별도로 읽는다. */
export function parseProcessRows(identities: string, commands: string, home: string): Row[] {
  const rows = new Map<number, Row>();
  for (const line of identities.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!match) throw new Error('프로세스 목록을 해석할 수 없습니다');
    rows.set(Number(match[1]), { pid: Number(match[1]), parent: Number(match[2]), group: Number(match[3]), command: '' });
  }
  let current: Row | undefined;
  const seen = new Set<number>();
  for (const line of commands.split('\n')) {
    const match = /^[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)(?:[ \t]+(.*))?$/.exec(line);
    const row = match ? rows.get(Number(match[1])) : undefined;
    if (match && row) {
      if (seen.has(row.pid)) throw new Error('프로세스 인자와 PID 행의 경계가 모호합니다. 다시 갱신하세요');
      seen.add(row.pid);
      if (row.parent !== Number(match[2]) || row.group !== Number(match[3])) throw new Error('프로세스 신원이 조사 중 바뀌었습니다. 다시 갱신하세요');
      current = row; row.command += `\n${match[4] ?? ''}`;
    } else if (match) {
      current = undefined;
      if (line.includes(home)) throw new Error('조사 중 새 Brain 실행이 시작됐습니다. 종료 뒤 다시 갱신하세요');
    } else if (current) current.command += `\n${line}`;
    else if (line.includes(home)) throw new Error('새 Brain 프로세스의 신원을 확인할 수 없습니다');
  }
  return [...rows.values()];
}
/** 명령 본문·환경은 기록하지 않고 관련 pid와 자식만 추적한다. */
export async function homeProcesses(home: string, groups = new Set<number>()): Promise<number[]> {
  const options = { timeout: 5000, maxBuffer: 8 * 1024 * 1024 };
  const identities = await execute('/bin/ps', ['-axo', 'pid=,ppid=,pgid='], options);
  const commands = await execute('/bin/ps', ['-ww', '-axo', 'pid=,ppid=,pgid=,command='], options);
  if (identities.stderr || commands.stderr) throw new Error('프로세스 목록을 확인할 수 없습니다');
  const rows = parseProcessRows(identities.stdout, commands.stdout, home);
  // 옛 core의 직접 명령은 영속 그룹 기록이 없으므로 상속 cwd도 조사한다.
  const cwd = await execute('/usr/sbin/lsof', ['-a', '-u', String(process.getuid?.() ?? ''), '-d', 'cwd', '-Fpn'], { timeout: 5000, maxBuffer: 8 * 1024 * 1024 });
  const cwdOwners = new Set<number>(); let cwdPid = 0;
  for (const line of cwd.stdout.split('\n')) {
    if (/^p\d+$/.test(line)) cwdPid = Number(line.slice(1));
    if (line.startsWith('n')) { const path = line.slice(1); if (path === `${home}/app` || path.startsWith(`${home}/app/`) || path.startsWith(`${home}/extensions/`)) cwdOwners.add(cwdPid); }
  }
  if ([...cwdOwners].some(pid => !rows.some(row => row.pid === pid))) throw new Error('조사 중 새 Brain 프로세스가 생겼습니다. 종료 뒤 다시 갱신하세요');
  const ancestors = new Set<number>();
  let pid = process.pid;
  while (pid > 0 && !ancestors.has(pid)) { ancestors.add(pid); pid = rows.find(row => row.pid === pid)?.parent ?? 0; }
  const found = new Set(rows.filter(row => !ancestors.has(row.pid) && (cwdOwners.has(row.pid) || row.command.includes(`${home}/app/`) || row.command.includes(`${home}/app `) || row.command.includes(`${home}/extensions/`))).map(row => row.pid));
  for (let size = -1; size !== found.size;) { size = found.size; for (const row of rows) if (found.has(row.parent) && !ancestors.has(row.pid)) found.add(row.pid); }
  for (const row of rows) if (found.has(row.pid)) groups.add(row.group);
  for (const row of rows) if (groups.has(row.group) && !ancestors.has(row.pid)) found.add(row.pid);
  return [...found];
}
/** 설치 잠금 아래, launchd를 내린 뒤 자식 종료와 daemon 진입 차단을 확인한다. */
export async function withOfflineRuntime<T>(options: { home: string; env: NodeJS.ProcessEnv; clock: Clock; commit: string | null; launchctl?: Launchctl; platform?: NodeJS.Platform; inspect?: () => Promise<number[]>; readGroups?: () => Promise<GroupIdentity[]> }, run: (recheck: () => Promise<void>) => Promise<T>): Promise<T> {
  const { home, env, clock } = options;
  const platform = options.platform ?? process.platform;
  const launchctl = options.launchctl ?? systemLaunchctl({ env: { ...env, SECOND_BRAIN_HOME: home }, uid: process.getuid?.() });
  const observedGroups = new Set<number>();
  const inspect = options.inspect ?? (() => homeProcesses(home, observedGroups));
  const groups = [...await recordedProcessGroups(home), ...(await options.readGroups?.() ?? [])];
  const verifyGroups = async (identities: GroupIdentity[]) => { for (const identity of identities) if (await inspectGroup(systemProcessInspector, identity) !== 'died') throw new Error('이전 자식 process group의 종료를 확인할 수 없습니다. 종료 뒤 다시 갱신하세요'); };
  const before = await inspect();
  const loaded = platform === 'darwin' && launchctl.uid !== undefined && await launchctl.isLoaded(daemonLabel({ ...env, SECOND_BRAIN_HOME: home }));
  let fence: Awaited<ReturnType<typeof acquireOfflineDaemonFence>> | undefined;
  try {
    await stopDaemon({ home, env: { ...env, SECOND_BRAIN_HOME: home }, clock, platform, launchctl });
    const recheck = async () => {
    const after = await inspect();
    // 부모 종료 뒤 고아가 된 자식도 최초 관측 pid로 검사한다. pid 재사용은 안전 중단한다.
    const alive = before.filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } });
    if (after.length || alive.length) throw new Error('이전 Brain 프로세스 또는 자식이 남아 있습니다. 종료 뒤 다시 갱신하세요');
    await verifyGroups([...groups, ...await recordedProcessGroups(home), ...(await options.readGroups?.() ?? [])]);
    };
    await recheck();
    const oldFence = await readDaemonLock(home);
    if (oldFence) {
      let previous: { installerPid?: unknown; targetCommit?: unknown; groups?: { pgid: number; osBootAt: string | null; osStartedAt: string | null }[] };
      try { previous = JSON.parse(await readFile(runtimeFencePath(home), 'utf8')); }
      catch { throw new Error('이전 daemon fence의 복구 신원을 확인할 수 없습니다. 정지 기록을 보존하세요'); }
      let dead = false;
      try { process.kill(oldFence.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
      if (!dead || oldFence.bootAt.toISOString() !== '9999-01-01T00:00:00.000Z' || oldFence.pid !== previous.installerPid || oldFence.commit !== previous.targetCommit || !Array.isArray(previous.groups)) throw new Error('이전 설치와 자식 종료를 확인한 뒤 daemon fence를 복구하세요. 정지 기록은 보존하세요');
      if (previous.groups.some(group => !Number.isSafeInteger(group.pgid) || group.pgid < 1 || [group.osBootAt, group.osStartedAt].some(value => value !== null && (typeof value !== 'string' || !Number.isFinite(new Date(value).getTime()))))) throw new Error('이전 자식의 정지 신원이 올바르지 않습니다');
      await verifyGroups(previous.groups.map(group => ({ pgid: group.pgid, osBootAt: group.osBootAt ? new Date(group.osBootAt) : null, osStartedAt: group.osStartedAt ? new Date(group.osStartedAt) : null })));
      await releaseDaemonLock(home, oldFence.pid);
    }
    fence = await acquireOfflineDaemonFence({ home, clock, commit: options.commit });
    if (!fence.ok) throw new Error(fence.message);
    return await run(recheck);
  } finally {
    if (fence?.ok) await fence.release();
    if (loaded) await startDaemon({ env: { ...env, SECOND_BRAIN_HOME: home }, launchctl, platform });
  }
}
