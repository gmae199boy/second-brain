import { expect, it, vi } from 'vitest';
import { resolveExecutable, type ExecutablePort } from '../src/executable.js';
function kit() {
  const port: ExecutablePort = { loginPaths: vi.fn(async () => ['/login/codex']), candidatePaths: vi.fn(async () => ['/candidate/codex']), inspect: vi.fn(async () => 'ok' as const) };
  return port;
}
it('설정 절대 경로를 우선하며 다른 설치를 조회하지 않는다', async () => {
  const port = kit();
  expect(await resolveExecutable(port, 'codex', '/configured/codex')).toEqual({ok:true,path:'/configured/codex',source:'configured'});
  expect(port.loginPaths).not.toHaveBeenCalled(); expect(port.candidatePaths).not.toHaveBeenCalled();
});
it.each(['not-executable','version-failed'] as const)('저장 경로의 %s 오류를 감추지 않는다', async reason => {
  const port = kit(); port.inspect = vi.fn(async () => reason);
  expect(await resolveExecutable(port,'codex','/broken/codex')).toMatchObject({ok:false,code:'ANALYSIS_AGENT_NOT_FOUND',reason,message:expect.stringContaining('brain config set agent.codex_path')});
  expect(port.loginPaths).not.toHaveBeenCalled();
});
it('로그인 경로를 후보보다 먼저 검증한다', async () => {
  const port = kit(); expect(await resolveExecutable(port,'codex')).toMatchObject({ok:true,source:'login'});
  expect(port.candidatePaths).not.toHaveBeenCalled();
});
it('로그인 경로가 없거나 실행 불가하면 후보를 탐지한다', async () => {
  const port = kit(); port.inspect = vi.fn(async path => path.startsWith('/candidate') ? 'ok' : 'not-executable');
  expect(await resolveExecutable(port,'codex')).toMatchObject({ok:true,path:'/candidate/codex',source:'candidate'});
});
it('모든 탐지가 실패하면 설정 방법과 미발견 코드를 반환한다', async () => {
  const port = kit(); port.inspect = vi.fn(async () => 'version-failed' as const);
  expect(await resolveExecutable(port,'codex')).toMatchObject({ok:false,code:'ANALYSIS_AGENT_NOT_FOUND',reason:'missing',message:expect.stringContaining('brain config set agent.codex_path')});
});
it('상대 경로와 셸 메타 문자가 있는 이름은 실행하지 않는다', async () => {
  const port = kit();
  expect(await resolveExecutable(port,'codex','relative/codex')).toMatchObject({ok:false,reason:'invalid-path'});
  expect(await resolveExecutable(port,'codex;echo')).toMatchObject({ok:false,reason:'invalid-path'});
  expect(port.inspect).not.toHaveBeenCalled(); expect(port.loginPaths).not.toHaveBeenCalled();
});
