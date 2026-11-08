import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { homeResources } from '../../../apps/cli/src/config/resources.js';
export interface ProbeResult { status: number | null; stdout: string; stderr: string; error?: Error }
export type Probe = (command: string, args: string[], timeout: number) => ProbeResult;
export function recordHookResources(home: string, env: NodeJS.ProcessEnv = process.env, append = appendFileSync): void {
  const path = env.BRAIN_TEST_HOOK_RESOURCE_LOG;
  if (path) { const { project, volume, port } = homeResources(home); append(path, JSON.stringify({ home, project, volume, port }) + '\n', { mode: 0o600 }); }
}
const defaultProbe: Probe = (command, args, timeout) => spawnSync(command, args, { encoding: 'utf8', timeout });

export function hookResourcesAvailable(candidate: string, run: Probe = defaultProbe): boolean {
  const { port, project, volume } = homeResources(candidate);
  const script = `const net = require('node:net'); const server = net.createServer(); server.once('error', e => { console.error(e.code || e.message); process.exit(e.code === 'EADDRINUSE' ? 2 : 1); }); server.listen(Number(process.argv[1]), '127.0.0.1', () => server.close());`;
  const bind = run(process.execPath, ['-e', script, String(port)], 10_000);
  if (bind.error) throw bind.error;
  if (bind.status === 2) return false;
  if (bind.status !== 0) throw new Error(`hook port 검사 실패: ${bind.stderr}`);
  const containers = run('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`], 15_000);
  if (containers.error) throw containers.error;
  if (containers.status !== 0) throw new Error(`hook project 검사 실패: ${containers.stderr}`);
  if (containers.stdout.trim()) return false;
  const inspected = run('docker', ['volume', 'inspect', volume], 15_000);
  if (inspected.error) throw inspected.error;
  if (inspected.status === 0) return false;
  const absent = inspected.stderr.trim().toLowerCase();
  if (inspected.status === 1 && (absent === `error response from daemon: get ${volume}: no such volume` || absent === `error: no such volume: ${volume}`)) return true;
  throw new Error(`hook volume 검사 실패: ${inspected.stderr}`);
}

export function selectHookRoot(create: () => string, check: (home: string) => boolean, remove: (root: string) => void, makeHome: (root: string) => string): { root: string; home: string } {
  for (let attempt = 0; attempt < 5; attempt++) {
    const root = create(), home = makeHome(root);
    try { if (check(home)) return { root, home }; }
    catch (error) { remove(root); throw error; }
    remove(root);
  }
  throw new Error('hook 시험의 포트 또는 Docker 자원이 5회 연속 충돌했습니다');
}
