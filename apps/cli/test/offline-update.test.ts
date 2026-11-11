import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { withOfflineRuntime } from '../src/install/offline.js';
import { daemonPlistPath, type Launchctl } from '../src/daemon/launchd.js';
const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { force: true, recursive: true }))); });
it('정지 검증 실패는 이전 app·완료 기록을 보존하고 기존 daemon을 재개한다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-offline-')); homes.push(home);
  await mkdir(join(home, 'app')); await writeFile(join(home, 'app/sentinel'), '이전 app');
  await writeFile(join(home, 'installed.json'), '이전 완료 기록');
  const env = { HOME: home, SECOND_BRAIN_HOME: home, SECOND_BRAIN_LAUNCH_AGENTS: join(home, 'agents') };
  const plist = daemonPlistPath(env); await mkdir(dirname(plist), { recursive: true }); await writeFile(plist, '이전 daemon');
  const bootout = vi.fn(async (_path: string) => ({ ok: true as const })), bootstrap = vi.fn(async (_path: string) => ({ ok: true as const }));
  let loaded = true;
  const launchctl: Launchctl = { uid: 501, isLoaded: async () => loaded, bootout: async label => { loaded = false; return bootout(label); }, bootstrap: async path => { loaded = true; return bootstrap(path); }, kill: async () => ({ ok: true }) };
  const migrate = vi.fn(async () => true);
  await expect(withOfflineRuntime({ home, env, clock: { now: () => new Date() }, commit: 'a'.repeat(40), platform: 'darwin', launchctl, inspect: async () => [process.pid] }, migrate)).rejects.toThrow('자식');
  expect(migrate).not.toHaveBeenCalled(); expect(bootout).toHaveBeenCalledOnce(); expect(bootstrap).toHaveBeenCalledOnce(); expect(loaded).toBe(true);
  expect(await readFile(join(home, 'app/sentinel'), 'utf8')).toBe('이전 app'); expect(await readFile(join(home, 'installed.json'), 'utf8')).toBe('이전 완료 기록');
});
it('SessionStart의 설치기 자신은 홈 프로세스 검사와 교착하지 않는다', async () => {
  const home = await mkdtemp(join(tmpdir(), 'brain-offline-')); homes.push(home);
  expect(await withOfflineRuntime({ home, env: {}, clock: { now: () => new Date() }, commit: 'a'.repeat(40), platform: 'linux' }, async () => {
    expect(JSON.parse(await readFile(join(home, 'run/daemon.pid'), 'utf8')).pid).toBe(process.pid);
    return '완료';
  })).toBe('완료');
});
it('직접 명령의 영속 기록은 리더가 끝난 뒤 실제 고아 그룹을 거부한다', async () => {
  const { trackedProcessLauncher, recordedProcessGroups } = await import('../src/runtime/process-registry.js');
  const home = await mkdtemp(join(tmpdir(), 'brain-orphan-')); homes.push(home);
  const result = await trackedProcessLauncher(home).start({ command: '/bin/sh', args: ['-c', 'sleep 30 & sleep 1'], env: {} });
  if (!result.ok) throw new Error(result.message);
  const handle = result.handle;
  try {
    await handle.exited;
    expect(await recordedProcessGroups(home)).toHaveLength(1);
    const migrate = vi.fn(async () => true);
    await expect(withOfflineRuntime({ home, env: {}, clock: { now: () => new Date() }, commit: 'a'.repeat(40), platform: 'linux' }, migrate)).rejects.toThrow('process group');
    expect(migrate).not.toHaveBeenCalled();
  } finally { try { process.kill(-handle.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } handle.closeOutput(); await handle.exited; }
});
it('설치기 자식의 출력 제한 실패는 그룹을 정리하고 기록으로 종료를 확인한다', async () => {
  const { trackedExec, recordedProcessGroups } = await import('../src/runtime/process-registry.js');
  const { systemProcessInspector } = await import('../src/runtime/process-inspector.js');
  const { inspectGroup } = await import('second_brain');
  const home = await mkdtemp(join(tmpdir(), 'brain-output-')); homes.push(home);
  await expect(trackedExec(home, process.execPath, ['-e', "process.stdout.write('x'.repeat(5*1024*1024));setInterval(()=>{},1000)"])).rejects.toThrow('출력');
  for (const group of await recordedProcessGroups(home)) expect(await inspectGroup(systemProcessInspector, group)).toBe('died');
});
it('직접 명령은 설치 잠금 아래에서 새 그룹을 시작하지 못한다', async () => {
  const { withHomeInstallLock } = await import('../src/runtime/install-lock.js');
  const { extensionRuntime } = await import('../src/runtime/extensions.js');
  const home = await mkdtemp(join(tmpdir(), 'brain-entry-')); homes.push(home);
  const abort = new AbortController(); let entered = false;
  const runtime = extensionRuntime({ home, env: { SECOND_BRAIN_HOME: home }, config: { ok: false, code: 'CONFIG_MISSING', message: '시험 설정' }, clock: { now: () => new Date() } });
  await withHomeInstallLock(home, async () => {
    const waiting = runtime.withCommandLock!('testext', async () => { entered = true; }, abort.signal);
    const timer = setTimeout(() => abort.abort(), 50);
    try { await expect(waiting).rejects.toMatchObject({ code: 'EXTENSION_INSTALL_CANCELLED' }); }
    finally { clearTimeout(timer); }
  });
  expect(entered).toBe(false);
});
it('줄바꿈 argv와 빈 command는 별도 PID 표로 연결하고 조사 중 바뀐 소유권은 거부한다', async () => {
  const { parseProcessRows } = await import('../src/install/offline.js');
  const home = '/tmp/brain-process-parse';
  const rows = parseProcessRows('10 1 10\n20 10 10\n', `10 1 10 node -e\nconst entry='${home}/extensions/testext/check.js';\n20 10 10\n`, home);
  expect(rows).toEqual([{ pid: 10, parent: 1, group: 10, command: expect.stringContaining(home) }, { pid: 20, parent: 10, group: 10, command: '\n\n' }]);
  expect(() => parseProcessRows('10 1 10\n', '10 2 10 node\n', home)).toThrow('신원');
  expect(() => parseProcessRows('10 1 10\n', `30 1 30 node ${home}/app/bin.js\n`, home)).toThrow('새 Brain');
  expect(() => parseProcessRows('10 1 10\n20 1 20\n', `10 1 10 node -e\n20 1 20 ${home}/extensions/testext/check.js\n20 1 20 unrelated-command\n`, home)).toThrow('경계가 모호');
});
