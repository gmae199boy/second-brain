import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { homeResources } from '../config/resources.js';
export interface CommandRequest { command: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeoutMs: number }
export type CommandResult = { ok: true; stdout: string; stderr: string } | { ok: false; stdout: string; stderr: string; message: string; code?: string };
export type CommandRunner = (request: CommandRequest) => Promise<CommandResult>;
const execute = promisify(execFile);
export const systemCommandRunner: CommandRunner = async request => {
  try { const result = await execute(request.command, [...request.args], {
    env: request.env, timeout: request.timeoutMs, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024,
  }); return { ok: true, ...result }; }
  catch (error) { const failure = error as Error & { stdout?: string; stderr?: string; code?: string };
    return { ok: false, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '', message: failure.message, ...(typeof failure.code === 'string' ? { code: failure.code } : {}) }; }
};
export function composeArgs(home: string, args: readonly string[]): string[] {
  return ['compose', '-p', homeResources(home).project, '--env-file', join(home, '.env'), '-f', join(home, 'postgres', 'compose.yaml'), ...args];
}
export function fakeCommandRunner(results: readonly CommandResult[]): { runner: CommandRunner; calls: CommandRequest[] } {
  const calls: CommandRequest[] = [];
  return { calls, runner: async request => {
    calls.push(request); const result = results[calls.length - 1];
    if (result === undefined) throw new Error('가짜 명령 결과가 없습니다'); return result;
  } };
}

/** Keep the caller's tools first while making login-installed CLIs available. */
export function commandEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: [env['PATH'], '/usr/local/bin', '/opt/homebrew/bin', ...(env['HOME'] ? [join(env['HOME'], '.orbstack', 'bin')] : [])].filter(Boolean).join(':') };
}
