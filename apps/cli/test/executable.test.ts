import { chmod, mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { resolveExecutable, type ExecutablePort } from 'second_brain';
import { memorySettingsStore } from 'second_brain/testing';
import { codexPathCheck, codexRuntimeEnvironment, detectCodexPath, executableEnvironment, executableSettingValidator, systemExecutablePort } from '../src/runtime/executable.js';
import { tempHomes } from './temp-home.js';
const homes = tempHomes(); afterEach(() => homes.cleanup());
async function fake(home: string, name = 'codex', body = 'printf "codex-cli 1.0.0\\n"') {
  const file = join(home,name); await writeFile(file, `#!/bin/sh\n${body}\n`); await chmod(file,0o700); return file;
}
it('최소 PATH에서 로그인 셸로 얻은 절대 경로를 검증한다', async () => {
  const home = await homes.create('brain-exec-'), path = await fake(home);
  const shell = await fake(home,'login-shell',`[ "$1" = '-lc' ] || exit 9\nprintf '%s\\n' '${path}'`);
  const port = systemExecutablePort({ HOME:home, SHELL:shell, PATH:'/usr/bin:/bin' });
  expect(await resolveExecutable(port,'codex')).toMatchObject({ok:true,path,source:'login'});
});
it('후보 위치와 npm 전역 prefix를 OS별로 조합한다', async () => {
  const run = vi.fn(async () => '/synthetic/npm-prefix\n');
  const port = systemExecutablePort({HOME:'/synthetic/home',SHELL:'/bin/sh'},'darwin',run);
  expect(await port.candidatePaths('codex')).toEqual(expect.arrayContaining(['/opt/homebrew/bin/codex','/usr/local/bin/codex','/synthetic/home/.local/bin/codex','/synthetic/npm-prefix/bin/codex']));
  const windows = systemExecutablePort({USERPROFILE:'C:\\Synthetic',APPDATA:'C:\\Synthetic\\AppData\\Roaming',SystemRoot:'C:\\Windows'},'win32',vi.fn(async()=> 'C:\\Tools\\codex.cmd\r\n'));
  expect(await windows.loginPaths('codex')).toEqual(['C:\\Tools\\codex.cmd']);
  expect(await windows.candidatePaths('codex')).toContain('C:\\Synthetic\\AppData\\Roaming\\npm\\codex.cmd');
});
it('실제 후보 가짜 파일을 검증하고 실행 불가와 버전 실패를 구별한다', async () => {
  const home = await homes.create('brain-exec-'); await mkdir(join(home,'.local/bin'),{recursive:true});
  const path = await fake(join(home,'.local/bin'));
  const port = systemExecutablePort({HOME:home, SHELL:'/bin/sh',PATH:'/usr/bin:/bin'},'linux',async () => 'synthetic');
  const isolated: ExecutablePort = { ...port, loginPaths:async()=>[], inspect: p=> p.startsWith(home) ? port.inspect(p) : Promise.resolve('not-executable') };
  expect(await resolveExecutable(isolated,'codex')).toMatchObject({ok:true,path,source:'candidate'});
  await chmod(path,0o600); expect(await port.inspect(path)).toBe('not-executable');
  await chmod(path,0o700); await writeFile(path,'#!/bin/sh\nexit 7\n');
  expect(await systemExecutablePort({PATH:'/usr/bin:/bin'}).inspect(path)).toBe('version-failed');
});
it('가짜 버전 응답만 확인해 최초 저장하고 기존 경로를 보존한다', async () => {
  const home = await homes.create('brain-exec-'), path = await fake(home);
  const store = memorySettingsStore();
  const port: ExecutablePort = {...systemExecutablePort({PATH:'/usr/bin:/bin'}),loginPaths:vi.fn(async()=>[path]),candidatePaths:async()=>[]};
  expect(await detectCodexPath(store,{},port)).toContain('저장했습니다');
  expect(await store.getSetting({userId:null,key:'agent.codex_path'})).toMatchObject({setting:{value:path}});
  await store.setSetting({userId:null,key:'agent.codex_path',value:'/chosen/codex',updatedAt:new Date()});
  vi.mocked(port.loginPaths).mockClear(); expect(await detectCodexPath(store,{},port)).toContain('유지'); expect(port.loginPaths).not.toHaveBeenCalled();
  expect(await store.getSetting({userId:null,key:'agent.codex_path'})).toMatchObject({setting:{value:'/chosen/codex'}});
});
it('doctor는 미설정·실행 불가·버전 실패를 경고하고 유효한 경로를 통과시킨다', async () => {
  const home = await homes.create('brain-exec-'), path = await fake(home), store = memorySettingsStore();
  const check = codexPathCheck(store,systemExecutablePort({PATH:'/usr/bin:/bin'}));
  expect(await check.run()).toMatchObject({status:'warn',code:'ANALYSIS_AGENT_NOT_FOUND',detail:expect.stringContaining('저장되지')});
  await store.setSetting({userId:null,key:'agent.codex_path',value:path,updatedAt:new Date()});
  expect(await check.run()).toMatchObject({status:'ok'});
  await chmod(path,0o600); expect(await check.run()).toMatchObject({status:'warn',detail:expect.stringContaining('not-executable')});
  await chmod(path,0o700); await writeFile(path,'#!/bin/sh\nexit 7\n');
  expect(await check.run()).toMatchObject({status:'warn',detail:expect.stringContaining('version-failed')});
});
it('설정 validator는 실행 가능한 절대 경로와 버전 응답을 요구한다', async () => {
  const home = await homes.create('brain-exec-'), path = await fake(home);
  const validate = executableSettingValidator({PATH:'/usr/bin:/bin'});
  expect(await validate(path)).toEqual({ok:true,value:await realpath(path)}); expect(await validate('codex')).toMatchObject({ok:false});
  await writeFile(path,'#!/bin/sh\nexit 9\n'); expect(await validate(path)).toMatchObject({ok:false});
  expect(executableEnvironment({PATH:'/usr/bin:/bin'}).PATH).toContain('/usr/bin:/bin');
});

it('symlink 뒤의 ..가 가리키는 실제 파일을 검증하고 저장한다', async () => {
  const home = await homes.create('brain-exec-symlink-');
  await mkdir(join(home,'releases/bin'),{recursive:true});
  const expected = await fake(join(home,'releases'));
  await symlink(join(home,'releases/bin'),join(home,'current'));
  await fake(home,'codex','exit 77');
  const value = `${home}/current/../codex`;
  expect(await executableSettingValidator({PATH:'/usr/bin:/bin'})(value)).toEqual({ok:true,value:await realpath(expected)});
});
it.each(['DB_LOCKED','DB_UNAVAILABLE'] as const)('감독자 설정 조회 %s를 미설정으로 바꾸지 않는다', async code => {
  const result = await codexRuntimeEnvironment({async getSettings() { return {ok:false,code,message:'synthetic'}; }},{});
  expect(result).toMatchObject({ok:false,code});
});

it('Claude launcher를 유지하고 symlink 업데이트와 provider 식별을 검증한다', async () => {
  const home = await homes.create('brain-claude-');
  const first = await fake(home, 'claude-v1', 'printf "2.1.290 (Claude Code)\\n"');
  const launcher = join(home, 'claude'); await symlink(first, launcher);
  const validate = executableSettingValidator({PATH:'/usr/bin:/bin'});
  expect(await validate(launcher, 'agent.claude_path')).toEqual({ok:true,value:launcher});
  const second = await fake(home, 'claude-v2', 'printf "2.1.291 (Claude Code)\\n"');
  const { unlink } = await import('node:fs/promises');
  await unlink(launcher); await symlink(second, launcher); await unlink(first);
  expect(await validate(launcher, 'agent.claude_path')).toEqual({ok:true,value:launcher});
  await writeFile(second, '#!/bin/sh\nprintf "codex 1.0\\n"\n');
  expect(await validate(launcher, 'agent.claude_path')).toMatchObject({ok:false,message:expect.stringContaining('agent.claude_path')});
});

it('빈 명시 경로는 자동 탐지로 fallback하지 않는다', async () => {
  const loginPaths = vi.fn(async () => ['/synthetic/claude']);
  const port: ExecutablePort = {loginPaths,candidatePaths:async()=>[],inspect:async()=> 'ok'};
  expect(await resolveExecutable(port,'claude','')).toMatchObject({ok:false,reason:'invalid-path',message:expect.stringContaining('agent.claude_path')});
  expect(loginPaths).not.toHaveBeenCalled();
});

it('선택된 provider 경로와 intake Codex 경로를 snapshot과 분리한다', async () => {
  const { analysisRuntimeEnvironment, agentPathCheck, detectAgentPath } = await import('../src/runtime/executable.js');
  const home = await homes.create('brain-provider-'), path = await fake(home, 'claude', 'printf "2.1.290 (Claude Code)\\n"');
  const store = memorySettingsStore();
  const port: ExecutablePort = {...systemExecutablePort({PATH:'/usr/bin:/bin'}),loginPaths:async()=>[path],candidatePaths:async()=>[]};
  expect(await detectAgentPath(store, {}, 'claude', port)).toContain('agent.claude_path');
  expect(await agentPathCheck(store,port,'claude').run()).toMatchObject({status:'ok'});
  await store.setSetting({userId:null,key:'agent.codex_path',value:'/synthetic/missing',updatedAt:new Date()});
  expect(await analysisRuntimeEnvironment(store,{},'claude',port)).toEqual({ok:true,env:{BRAIN_ANALYSIS_AGENT:'claude',BRAIN_ANALYSIS_EXECUTABLE:path}});
  await store.setSetting({userId:null,key:'agent.claude_path',value:'',updatedAt:new Date()});
  expect(await analysisRuntimeEnvironment(store,{},'claude',port)).toEqual({ok:true,env:{BRAIN_ANALYSIS_AGENT:'claude'}});
});

it('Codex 경로도 Claude 또는 모호한 wrapper의 버전 응답을 거부한다', async () => {
  const home = await homes.create('brain-codex-identity-');
  const path = await fake(home,'wrong-provider','printf "2.1.290 (Claude Code)\\n"');
  const validate = executableSettingValidator({PATH:'/usr/bin:/bin'});
  expect(await validate(path,'agent.codex_path')).toMatchObject({ok:false});
  await writeFile(path, '#!/bin/sh\nprintf "arbitrary-wrapper 1.0\\n"\n');
  expect(await validate(path,'agent.codex_path')).toMatchObject({ok:false});
});
