/** 머신 I/O는 어댑터에 맡기고 탐지 순서와 실패 의미를 공유한다. */
export interface ExecutablePort {
  loginPaths(name: string): Promise<readonly string[]>;
  candidatePaths(name: string): Promise<readonly string[]>;
  inspect(path: string, name?: string): Promise<'ok' | 'not-executable' | 'version-failed'>;
}
export type ExecutableResult = { ok: true; path: string; source: 'configured' | 'login' | 'candidate' } |
  { ok: false; code: 'ANALYSIS_AGENT_NOT_FOUND'; reason: 'missing' | 'not-executable' | 'version-failed' | 'invalid-path'; message: string };
export const AGENT_PROVIDERS = ['codex', 'claude'] as const;
export type AgentProvider = typeof AGENT_PROVIDERS[number];
export function agentPathHint(name: string): string { return `brain config set agent.${name}_path <절대경로>로 실행 파일을 설정하세요`; }
export const CODEX_PATH_HINT = 'brain config set agent.codex_path <절대경로>로 실행 파일을 설정하세요';
export function isAbsoluteExecutablePath(path: string): boolean {
  return !/[\x00-\x1f\x7f]/.test(path) && (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]+\\[^\\]+\\/.test(path));
}
export async function resolveExecutable(port: ExecutablePort, name: string, configured?: string): Promise<ExecutableResult> {
  const failure = (reason: Extract<ExecutableResult, {ok:false}>['reason']): ExecutableResult => ({ ok: false, code: 'ANALYSIS_AGENT_NOT_FOUND', reason, message: `분석 실행 파일을 확인할 수 없습니다 (${reason}). ${agentPathHint(name)}` });
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return failure('invalid-path');
  if (configured !== undefined) {
    if (!isAbsoluteExecutablePath(configured)) return failure('invalid-path');
    const checked = await port.inspect(configured, name);
    return checked === 'ok' ? { ok: true, path: configured, source: 'configured' } : failure(checked);
  }
  const seen = new Set<string>();
  for (const [source, paths] of [
    ['login', () => port.loginPaths(name)], ['candidate', () => port.candidatePaths(name)],
  ] as const) {
    for (const path of await paths()) {
      if (seen.has(path) || !isAbsoluteExecutablePath(path)) continue;
      seen.add(path);
      if (await port.inspect(path, name) === 'ok') return { ok: true, path, source };
    }
  }
  return failure('missing');
}
