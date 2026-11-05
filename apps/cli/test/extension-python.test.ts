import { mkdtemp, mkdir, writeFile, rm, symlink, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareExtensionPython } from '../src/runtime/extension-python.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture(pin = '3.12.13') {
  const dir = await mkdtemp(join(tmpdir(), 'brain-python-')); directories.push(dir);
  await Promise.all([writeFile(join(dir, '.python-version'), pin), writeFile(join(dir, 'pyproject.toml'), ''), writeFile(join(dir, 'uv.lock'), '')]);
  return dir;
}
it('uv 실행 전에 불완전하거나 patch가 없는 버전 지정을 거부한다', async () => {
  const dir = await fixture('3.12');
  expect(await prepareExtensionPython(dir, { PATH: '' })).toMatchObject({ ok: false, code: 'EXTENSION_PYTHON_PIN_INVALID' });
  await rm(join(dir, 'uv.lock'));
  expect(await prepareExtensionPython(dir, { PATH: '' })).toMatchObject({ ok: false, code: 'EXTENSION_PYTHON_PIN_INVALID' });
});
it('출력을 노출하지 않고 uv 부재를 보고한다', async () => {
  const dir = await fixture();
  const bin = join(dir, 'empty'); await mkdir(bin);
  expect(await prepareExtensionPython(dir, { PATH: bin })).toMatchObject({ ok: false, code: 'EXTENSION_UV_NOT_FOUND' });
});

it.each([
  ['Python 부재', 'find-fail', '3.12.13', 'EXTENSION_PYTHON_NOT_FOUND'],
  ['환경 생성 실패', 'venv-fail', '3.12.13', 'EXTENSION_PYTHON_SYNC_FAILED'],
  ['동기화 실패', 'sync-fail', '3.12.13', 'EXTENSION_PYTHON_SYNC_FAILED'],
  ['patch 불일치', 'success', '3.12.14', 'EXTENSION_PYTHON_VERSION_MISMATCH'],
])('%s를 고정 코드로 보고한다', async (_label, mode, actual, code) => {
  const dir = await fixture(); const bin = join(dir, 'bin');
  await mkdir(bin);
  await writeFile(join(bin, 'uv'), `#!/bin/sh\ncase "$1 $2" in\n'--version ') exit 0;;\n'python find') ${mode === 'find-fail' ? 'exit 1' : 'echo /local/python; exit 0'};;\n'venv --relocatable') ${mode === 'venv-fail' ? 'exit 1' : `/bin/mkdir -p .venv/bin; /bin/echo '#!/bin/sh\necho ${actual}' > .venv/bin/python; /bin/chmod +x .venv/bin/python; exit 0`};;\n'sync --frozen') ${mode === 'sync-fail' ? 'exit 1' : 'exit 0'};;\nesac\nexit 1\n`, { mode: 0o755 });
  expect(await prepareExtensionPython(dir, { PATH: bin })).toMatchObject({ ok: false, code });
});
it('거부해야 할 환경 root symlink를 따라가거나 지우지 않는다', async () => {
  const dir = await fixture(), bin = join(dir, 'bin'), external = join(dir, 'external'); await mkdir(bin); await mkdir(external);
  await writeFile(join(external, 'marker'), 'safe'); await symlink(external, join(dir, '.venv'));
  await writeFile(join(bin, 'uv'), '#!/bin/sh\ncase "$1" in --version) exit 0;; python) echo /synthetic/python; exit 0;; esac\nexit 1\n', { mode: 0o755 });
  expect(await prepareExtensionPython(dir, { PATH: bin }, undefined, true)).toMatchObject({ ok: false, code: 'EXTENSION_PYTHON_SYNC_FAILED' });
  expect(await readFile(join(external, 'marker'), 'utf8')).toBe('safe');
});
it('sync 취소 시 uv 프로세스 그룹 종료를 확인한다', async () => {
  const dir = await fixture(), bin = join(dir, 'bin'), pidFile = join(dir, 'uv-pid'), childFile = join(dir, 'child-pid'), scratchFile = join(dir, 'scratch-path'); await mkdir(bin);
  await writeFile(join(bin, 'uv'), `#!/bin/sh\ncase "$1" in\n--version) exit 0;;\npython) echo /synthetic/python; exit 0;;\nvenv) exit 0;;\nsync) pwd > '${scratchFile}'; echo $$ > '${pidFile}'; /bin/sleep 300 & echo $! > '${childFile}'; wait;;\nesac\n`, { mode: 0o755 });
  const controller = new AbortController(), running = prepareExtensionPython(dir, { PATH: bin }, controller.signal, true);
  await expect.poll(async () => readFile(pidFile, 'utf8').then(Number, () => 0)).toBeGreaterThan(0);
  await expect.poll(async () => readFile(childFile, 'utf8').then(Number, () => 0)).toBeGreaterThan(0);
  const pid = Number(await readFile(pidFile, 'utf8')), child = Number(await readFile(childFile, 'utf8')); controller.abort();
  expect(await running).toMatchObject({ ok: false, code: 'EXTENSION_INSTALL_CANCELLED' });
  expect(() => process.kill(pid, 0)).toThrow();
  expect(() => process.kill(child, 0)).toThrow();
  expect(() => process.kill(-pid, 0)).toThrow();
  await expect(stat((await readFile(scratchFile, 'utf8')).trim())).rejects.toThrow();
  await writeFile(join(bin, 'uv'), `#!/bin/sh
case "$1" in
--version) exit 0;;
python) echo /synthetic/python; exit 0;;
venv) /bin/mkdir -p .venv/bin; /bin/echo '#!/bin/sh
echo 3.12.13' > .venv/bin/python; /bin/chmod +x .venv/bin/python; exit 0;;
sync) pwd > '${scratchFile}'; exit 0;;
esac
`, { mode: 0o755 });
  expect(await prepareExtensionPython(dir, { PATH: bin }, undefined, true)).toEqual({ ok: true });
  await expect(stat((await readFile(scratchFile, 'utf8')).trim())).rejects.toThrow();
});
