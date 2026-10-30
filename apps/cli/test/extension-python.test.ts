import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
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
  ['동기화 실패', 'sync-fail', '3.12.13', 'EXTENSION_PYTHON_SYNC_FAILED'],
  ['patch 불일치', 'success', '3.12.14', 'EXTENSION_PYTHON_VERSION_MISMATCH'],
])('%s를 고정 코드로 보고한다', async (_label, mode, actual, code) => {
  const dir = await fixture(); const bin = join(dir, 'bin');
  await mkdir(bin); await mkdir(join(dir, '.venv', 'bin'), { recursive: true });
  await writeFile(join(bin, 'uv'), `#!/bin/sh\ncase "$1 $2" in\n'--version ') exit 0;;\n'python find') ${mode === 'find-fail' ? 'exit 1' : 'echo /local/python; exit 0'};;\n'sync --frozen') ${mode === 'sync-fail' ? 'exit 1' : 'exit 0'};;\nesac\nexit 1\n`, { mode: 0o755 });
  await writeFile(join(dir, '.venv', 'bin', 'python'), `#!/bin/sh\necho '${actual}'\n`, { mode: 0o755 });
  expect(await prepareExtensionPython(dir, { PATH: bin })).toMatchObject({ ok: false, code });
});
