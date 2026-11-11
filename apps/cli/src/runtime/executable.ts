import { userInfo } from 'node:os';
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, normalize, win32 } from 'node:path';
import { promisify } from 'node:util';
import { CODEX_PATH_HINT, resolveExecutable, type DoctorCheckSource, type ExecutablePort, type SettingsStore } from 'second_brain';
const exec = promisify(execFile);
export const EXECUTABLE_TIMEOUT_MS = 3_000;
export type ExecutableRun = (command: string, args: readonly string[], env: NodeJS.ProcessEnv) => Promise<string>;
const systemRun: ExecutableRun = async (command, args, env) => {
  const options = { env, timeout: EXECUTABLE_TIMEOUT_MS, maxBuffer: 64 * 1024, windowsHide: true };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    // npm shim은 cmd.exe가 필요하다. 입력을 고정한 버전 조회만 허용한다.
    if (args.length !== 1 || args[0] !== '--version' || /["%!^\r\n]/.test(command)) throw new Error('invalid version command');
    return (await exec(win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'), ['/d', '/s', '/c', `""${command}" --version"`], { ...options, windowsVerbatimArguments: true })).stdout;
  }
  return (await exec(command, [...args], options)).stdout;
};

/** npm 실행 파일의 env-node shebang도 현재 Brain의 검증된 Node를 찾게 한다. */
export function executableEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...env, PATH: [dirname(process.execPath), env.PATH ?? ''].filter(Boolean).join(delimiter) };
}
function loginShell(env: NodeJS.ProcessEnv): string {
  if (env.SHELL && isAbsolute(env.SHELL)) return env.SHELL;
  try { const shell = userInfo().shell; if (shell && isAbsolute(shell)) return shell; } catch { /* 최소 시스템의 fallback */ }
  return '/bin/sh';
}

/** 셸은 이름 조회에만 쓰며 버전 검증은 절대 경로를 직접 실행한다. */
export function systemExecutablePort(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, run: ExecutableRun = systemRun): ExecutablePort {
  env = executableEnvironment(env);
  const paths = platform === 'win32' ? win32 : { join, isAbsolute, normalize };
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const lines = (value: string) => value.split(/\r?\n/).map(p => p.trim()).filter(p => paths.isAbsolute(p));
  const safeRun = async (command: string, args: readonly string[]) => { try { return await run(command, args, env); } catch { return ''; } };
  return {
    async loginPaths(name) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return [];
      if (platform === 'win32') return lines(await safeRun(paths.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'where.exe'), [name]));
      const shell = loginShell(env);
      return lines(await safeRun(shell, ['-lc', `command -v '${name}'`]));
    },
    async candidatePaths(name) {
      const result: string[] = [];
      const add = (base: string | undefined, ...parts: string[]) => { if (base && paths.isAbsolute(base)) result.push(paths.join(base, ...parts, name)); };
      if (platform === 'win32') {
        return [env.APPDATA && paths.join(env.APPDATA, 'npm'), env.LOCALAPPDATA && paths.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links'), home && paths.join(home, '.local', 'bin')]
          .filter((p): p is string => Boolean(p) && paths.isAbsolute(p!)).flatMap(base => ['.exe', '.cmd', ''].map(suffix => paths.join(base, `${name}${suffix}`)));
      }
      add('/opt/homebrew/bin'); add('/usr/local/bin');
      add(home, '.local', 'bin'); add(home, '.npm-global', 'bin'); add(home, '.npm', 'bin');
      add(env.npm_config_prefix, 'bin'); add(env.NPM_CONFIG_PREFIX, 'bin'); add(env.HOMEBREW_PREFIX, 'bin');
      // 사용자 로그인 셸에서 얻은 npm prefix도 후보이며 PATH 자체를 저장하지 않는다.
      const shell = loginShell(env);
      for (const prefix of lines(await safeRun(shell, ['-lc', 'npm prefix -g']))) add(prefix, 'bin');
      return [...new Set(result.map(p => paths.normalize(p)))];
    },
    async inspect(path) {
      if (!paths.isAbsolute(path)) return 'not-executable';
      try { if (!(await stat(path)).isFile()) return 'not-executable'; await access(path, platform === 'win32' ? constants.F_OK : constants.X_OK); }
      catch { return 'not-executable'; }
      try { return (await run(path, ['--version'], env)).trim() ? 'ok' : 'version-failed'; }
      catch { return 'version-failed'; }
    },
  };
}

export function executableSettingValidator(env: NodeJS.ProcessEnv) {
  return async (value: string) => {
    if (!isAbsolute(value)) return { ok: false as const, message: `Codex 경로는 절대 경로여야 합니다. ${CODEX_PATH_HINT}` };
    let path: string;
    try { path = await realpath(value); } catch { return { ok: false as const, message: `Codex 실행 파일을 확인할 수 없습니다. ${CODEX_PATH_HINT}` }; }
    // 저장할 경로를 먼저 확정한다. symlink 뒤의 ..는 문자열 normalize와 의미가 다르다.
    const result = await resolveExecutable(systemExecutablePort(env), 'codex', path);
    return result.ok ? { ok: true as const, value: result.path } : { ok: false as const, message: result.message };
  };
}
/** insert-if-absent는 명시적인 기존 설정과 병렬 설정 변경을 보존한다. */
export async function detectCodexPath(store: Pick<SettingsStore, 'getSettings' | 'insertSetting'>, env: NodeJS.ProcessEnv, port = systemExecutablePort(env)): Promise<string> {
  const prior = await store.getSettings({ userId: null, keys: ['agent.codex_path'] });
  if (!prior.ok) return `Codex 설정을 조회하지 못했습니다. ${CODEX_PATH_HINT}`;
  if (prior.settings.length) return `Codex 경로 설정을 유지했습니다. brain doctor run으로 확인하세요`;
  const found = await resolveExecutable(port, 'codex');
  if (!found.ok) return found.message;
  const saved = await store.insertSetting({ userId: null, key: 'agent.codex_path', value: found.path, updatedAt: new Date() });
  return saved.ok ? `Codex 실행 파일을 탐지해 agent.codex_path에 저장했습니다 (${found.source})` : `Codex 경로를 저장하지 못했습니다. ${CODEX_PATH_HINT}`;
}
export function codexPathCheck(store: Pick<SettingsStore, 'getSettings'>, port: ExecutablePort): DoctorCheckSource {
  return { id: 'agent-codex-path', async run() {
    const read = await store.getSettings({ userId: null, keys: ['agent.codex_path'] });
    if (!read.ok) return { id: 'agent-codex-path', status: 'warn', code: read.code, detail: `Codex 설정을 읽지 못했습니다. ${CODEX_PATH_HINT}` };
    const path = read.settings[0]?.value;
    if (!path) return { id: 'agent-codex-path', status: 'warn', code: 'ANALYSIS_AGENT_NOT_FOUND', detail: `Codex 경로가 저장되지 않았습니다. ${CODEX_PATH_HINT}` };
    const found = await resolveExecutable(port, 'codex', path);
    return found.ok ? { id: 'agent-codex-path', status: 'ok', detail: '저장된 Codex 실행 경로와 버전을 확인했습니다' } : { id: 'agent-codex-path', status: 'warn', code: found.code, detail: found.message };
  } };
}

/** DB 조회 실패와 실제 미설정을 구별해 감독자의 재시도 의미를 유지한다. */
export async function codexRuntimeEnvironment(store: Pick<SettingsStore, 'getSettings'>, env: NodeJS.ProcessEnv, port = systemExecutablePort(env)) {
  const read = await store.getSettings({ userId: null, keys: ['agent.codex_path'] });
  if (!read.ok) return read;
  const path = read.settings[0]?.value;
  const found = path ? await resolveExecutable(port, 'codex', path) : null;
  const result: Record<string, string> = found?.ok ? { BRAIN_CODEX_PATH: found.path } : {};
  return { ok: true as const, env: result };
}
