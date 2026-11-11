import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { tempHomes } from './temp-home.js';
import { writeConfig, readConfig } from '../src/config/codec.js';
import { dispatch } from '../src/dispatch.js';
import { configGetCommand } from '../src/commands/config-get.js';
import { configSetCommand } from '../src/commands/config-set.js';
const homes = tempHomes();
afterEach(() => homes.cleanup());
it('설치 기본 선택은 DB 없이 config로 바뀌고 bootstrap이 읽는 파일 및 다른 키를 보존한다', async () => {
  const home = await homes.create('brain-machine-config-');
  await writeConfig(home, { filesPath: '/tmp/custom-files', extra: { custom: { keep: true } } });
  const secret = 'SYNTHETIC=unchanged\n'; await writeFile(join(home, '.env'), secret);
  const call = async (args: string[]) => {
    let output = '';
    const exit = await dispatch([configGetCommand, configSetCommand], [...args, '--json'], { env: { SECOND_BRAIN_HOME: home }, clock: { now: () => new Date() }, stdout: text => { output += text; }, stderr: () => {} });
    return { exit, result: JSON.parse(output) };
  };
  expect(await call(['config', 'get', 'update.auto'])).toMatchObject({ exit: 0, result: { data: { value: true, scope: 'machine' } } });
  expect(await call(['config', 'set', 'update.auto', 'false'])).toMatchObject({ exit: 0, result: { data: { value: false } } });
  expect(await call(['config', 'get', 'update.auto'])).toMatchObject({ exit: 0, result: { data: { value: false } } });
  expect(await call(['config', 'set', 'mirror.path', '/tmp/changed-mirror'])).toMatchObject({ exit: 0, result: { data: { value: '/tmp/changed-mirror' } } });
  expect(await call(['config', 'get', 'mirror.path'])).toMatchObject({ exit: 0, result: { data: { value: '/tmp/changed-mirror' } } });
  expect(await readConfig(home)).toMatchObject({ ok: true, config: { updateAuto: false, mirrorPath: '/tmp/changed-mirror', filesPath: '/tmp/custom-files' } });
  const before = await readFile(join(home, 'config.toml'), 'utf8'); expect(before).toContain('keep = true');
  for (const [key, value] of [['update.auto', 'yes'], ['mirror.path', 'relative']]) expect(await call(['config', 'set', key!, value!])).toMatchObject({ exit: 2, result: { ok: false } });
  expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(before);
  expect(await readFile(join(home, '.env'), 'utf8')).toBe(secret);
});
it('설치의 설정 읽기·쓰기 사이에 요청한 config 변경은 설치 뒤 적용된다', async () => {
  const { withInstallerHomeLock } = await import('../src/runtime/install-lock.js');
  const { setInstallChoice } = await import('../src/config/codec.js');
  const home = await homes.create('brain-machine-serial-'); await writeConfig(home, { updateAuto: true });
  let mutation: Promise<unknown> | undefined;
  let finished = false;
  await withInstallerHomeLock(home, {}, async () => {
    mutation = setInstallChoice(home, 'update.auto', 'false').then(value => { finished = true; return value; });
    await new Promise(resolve => setTimeout(resolve, 40)); expect(finished).toBe(false);
    // 설치기가 처음 읽은 true로 설정을 기록하는 동안 setter는 잠금 밖에서 기다린다.
    await writeConfig(home, { updateAuto: true });
  });
  expect(await mutation).toEqual({ ok: true });
  expect(await readConfig(home)).toMatchObject({ ok: true, config: { updateAuto: false } });
});
