import { access } from 'node:fs/promises';
import type { DoctorCheckSource } from 'second_brain';
import { homeResources } from '../config/resources.js';
import { commandEnv, systemCommandRunner, type CommandRunner } from './command-runner.js';
export type OrbStackResult = { ok: true; detail: string } | { ok: false; reason: 'not-installed' | 'cli-missing' | 'stopped' | 'context' | 'engine' | 'compose'; message: string; hint: string };
export async function probeOrbStack(options: { runner?: CommandRunner; env: NodeJS.ProcessEnv; appExists?: () => Promise<boolean> }): Promise<OrbStackResult> {
  const runner = options.runner ?? systemCommandRunner;
  const run = (command: string, args: string[]) => runner({ command, args, env: commandEnv(options.env), timeoutMs: 5000 });
  const fail = (reason: Extract<OrbStackResult, { ok: false }>['reason'], message: string, hint: string): OrbStackResult => ({ ok: false, reason, message, hint });
  const status = await run('orb', ['status']);
  if (!status.ok && status.code === 'ENOENT') {
    const exists = await (options.appExists ?? (async () => access('/Applications/OrbStack.app').then(() => true, () => false)))();
    return exists ? fail('cli-missing', 'OrbStack CLI가 PATH에 없습니다', 'OrbStack 앱을 열어 CLI를 설치하고 PATH를 확인하세요')
      : fail('not-installed', 'OrbStack이 설치되어 있지 않습니다', '`brew install --cask orbstack` 또는 https://orbstack.dev 에서 설치하세요');
  }
  if (!status.ok || status.stdout.trim() !== 'Running') return fail('stopped', 'OrbStack이 꺼져 있습니다', '`orb start`를 실행하거나 OrbStack 앱을 켜세요');
  const context = await run('docker', ['context', 'show']);
  if (options.env['DOCKER_HOST'] || !context.ok || context.stdout.trim() !== 'orbstack') return fail('context', 'Docker가 OrbStack을 가리키지 않습니다', '`docker context use orbstack`을 실행하고 DOCKER_HOST를 해제하세요');
  const engine = await run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (!engine.ok || !engine.stdout.trim()) return fail('engine', 'OrbStack Docker 엔진에 닿지 못했습니다', 'OrbStack 앱의 실행 상태를 확인하세요');
  if (!(await run('docker', ['compose', 'version'])).ok) return fail('compose', 'Docker Compose를 사용할 수 없습니다', 'OrbStack 앱에서 Docker CLI와 Compose 설치를 확인하세요');
  return { ok: true, detail: 'OrbStack과 Docker Compose가 실행 중입니다' };
}
export async function containerState(options: { home: string; runner?: CommandRunner; env: NodeJS.ProcessEnv }): Promise<{ ok: boolean; detail: string }> {
  const result = await (options.runner ?? systemCommandRunner)({ command: 'docker', args: ['ps', '-a', '--filter', `label=com.docker.compose.project=${homeResources(options.home).project}`, '--format', 'json'], env: commandEnv(options.env), timeoutMs: 5000 });
  if (!result.ok) return { ok: false, detail: 'PostgreSQL 컨테이너 상태를 읽지 못했습니다' };
  try {
    const rows = result.stdout.trim() ? result.stdout.trim().split('\n').flatMap(line => { const row = JSON.parse(line); return Array.isArray(row) ? row : [row]; }) : [];
    const postgres = rows.find(row => /(?:^|,)com\.docker\.compose\.service=postgres(?:,|$)/.test(row.Labels ?? ''));
    return postgres?.State === 'running' && /\(healthy\)/.test(postgres.Status ?? '')
      ? { ok: true, detail: 'PostgreSQL 컨테이너가 실행 중이고 정상입니다' }
      : { ok: false, detail: 'PostgreSQL 컨테이너가 없거나 멈췄거나 정상 상태가 아닙니다. `setup run`을 실행하세요' };
  } catch { return { ok: false, detail: 'PostgreSQL 컨테이너 상태를 해석하지 못했습니다' }; }
}
export async function volumeOwner(options: { home: string; runner?: CommandRunner; env: NodeJS.ProcessEnv }): Promise<{ ok: true; owner: string | null; exists: boolean } | { ok: false; message: string }> {
  const volume = homeResources(options.home).volume;
  const result = await (options.runner ?? systemCommandRunner)({ command: 'docker', args: ['volume', 'inspect', volume], env: commandEnv(options.env), timeoutMs: 5000 });
  if (!result.ok) return /no such volume|not found/i.test(result.stderr + result.stdout + result.message) ? { ok: true, owner: null, exists: false } : { ok: false, message: `볼륨 ${volume}의 소유자를 확인하지 못했습니다` };
  try { const rows = JSON.parse(result.stdout); return { ok: true, exists: true, owner: rows[0]?.Labels?.['com.docker.compose.project'] ?? null }; }
  catch { return { ok: false, message: `볼륨 ${volume}의 소유자 정보를 해석하지 못했습니다` }; }
}
export function postgresPrerequisites(options: { home: string; env: NodeJS.ProcessEnv; runner?: CommandRunner }): DoctorCheckSource[] {
  return [
    { id: 'orbstack', async run() { const result = await probeOrbStack(options); return result.ok ? { id: 'orbstack', status: 'ok', detail: result.detail } : { id: 'orbstack', status: 'fail', code: 'ORBSTACK_UNAVAILABLE', detail: `${result.message}. ${result.hint}` }; } },
    { id: 'container', async run() { const result = await containerState(options); return { id: 'container', status: result.ok ? 'ok' : 'fail', ...(result.ok ? {} : { code: 'DB_UNAVAILABLE' }), detail: result.detail }; } },
  ];
}
