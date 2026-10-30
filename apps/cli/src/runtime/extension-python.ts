import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
export type PythonFailureCode = 'EXTENSION_PYTHON_PIN_INVALID' | 'EXTENSION_UV_NOT_FOUND' | 'EXTENSION_PYTHON_NOT_FOUND' | 'EXTENSION_PYTHON_SYNC_FAILED' | 'EXTENSION_PYTHON_VERSION_MISMATCH';
const messages: Record<PythonFailureCode, string> = {
  EXTENSION_PYTHON_PIN_INVALID: 'Python 확장 의존 파일이나 버전 지정이 올바르지 않습니다',
  EXTENSION_UV_NOT_FOUND: 'uv를 찾을 수 없습니다',
  EXTENSION_PYTHON_NOT_FOUND: '지정한 Python을 찾을 수 없습니다',
  EXTENSION_PYTHON_SYNC_FAILED: 'Python 환경을 설치하지 못했습니다',
  EXTENSION_PYTHON_VERSION_MISMATCH: 'Python 환경의 버전이 지정한 버전과 다릅니다',
};
const failure = (code: PythonFailureCode) => ({ ok: false as const, code, message: messages[code] });
export async function prepareExtensionPython(directory: string, parent: NodeJS.ProcessEnv) {
  let pin: string;
  try {
    pin = (await readFile(join(directory, '.python-version'), 'utf8')).trim();
    await Promise.all(['pyproject.toml', 'uv.lock'].map(async file => { if (!(await stat(join(directory, file))).isFile()) throw new Error(); }));
  } catch { return failure('EXTENSION_PYTHON_PIN_INVALID'); }
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pin);
  if (!match || Number(match[1]) < 3 || (Number(match[1]) === 3 && Number(match[2]) < 12)) return failure('EXTENSION_PYTHON_PIN_INVALID');
  const env = { PATH: parent['PATH'] ?? '', HOME: parent['HOME'] ?? '', UV_PYTHON_DOWNLOADS: 'never' };
  const options = { cwd: directory, env, maxBuffer: 1024 * 1024 };
  try { await run('uv', ['--version'], options); } catch { return failure('EXTENSION_UV_NOT_FOUND'); }
  let python: string;
  try { python = (await run('uv', ['python', 'find', pin, '--no-python-downloads'], options)).stdout.trim(); }
  catch { return failure('EXTENSION_PYTHON_NOT_FOUND'); }
  try { await run('uv', ['sync', '--frozen', '--no-dev', '--python', python], options); }
  catch { return failure('EXTENSION_PYTHON_SYNC_FAILED'); }
  try {
    const actual = (await run(join(directory, '.venv', 'bin', 'python'), ['-c', 'import platform; print(platform.python_version())'], options)).stdout.trim();
    if (actual !== pin) return failure('EXTENSION_PYTHON_VERSION_MISMATCH');
  } catch { return failure('EXTENSION_PYTHON_VERSION_MISMATCH'); }
  return { ok: true as const };
}
