import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanProcessGroup } from 'second_brain';
import { systemProcessLauncher } from './process-group.js';
import { systemProcessInspector } from './process-inspector.js';
import { systemClock, systemTimer } from './clock.js';
export type PythonFailureCode = 'EXTENSION_PYTHON_PIN_INVALID' | 'EXTENSION_UV_NOT_FOUND' | 'EXTENSION_PYTHON_NOT_FOUND' | 'EXTENSION_PYTHON_SYNC_FAILED' | 'EXTENSION_PYTHON_VERSION_MISMATCH';
const messages: Record<PythonFailureCode, string> = {
  EXTENSION_PYTHON_PIN_INVALID: 'Python 확장 의존 파일이나 버전 지정이 올바르지 않습니다',
  EXTENSION_UV_NOT_FOUND: 'uv를 찾을 수 없습니다',
  EXTENSION_PYTHON_NOT_FOUND: '지정한 Python을 찾을 수 없습니다',
  EXTENSION_PYTHON_SYNC_FAILED: 'Python 환경을 설치하지 못했습니다',
  EXTENSION_PYTHON_VERSION_MISMATCH: 'Python 환경의 버전이 지정한 버전과 다릅니다',
};
const failure = (code: PythonFailureCode) => ({ ok: false as const, code, message: messages[code] });
async function run(command: string, args: string[], cwd: string, env: Record<string, string>, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new Error('cancelled');
  const started = await systemProcessLauncher.start({ command, args, cwd, env });
  if (!started.ok) throw new Error('start');
  const handle = started.handle;
  const boot = await systemProcessInspector.bootTime(), start = await systemProcessInspector.startedAt(handle.pid);
  const identity = { pgid: handle.pid, osBootAt: boot.state === 'found' ? boot.value : null, osStartedAt: start.state === 'found' ? start.value : null };
  let stdout = '';
  const consume = Promise.all([(async () => { for await (const chunk of handle.stdout) stdout = (stdout + chunk).slice(0, 1048576); })(), (async () => { for await (const _ of handle.stderr) { /* 진단 원문을 저장하지 않는다. */ } })()]);
  let stop!: () => void;
  const aborted = new Promise<'abort'>(resolve => { stop = () => resolve('abort'); });
  signal?.addEventListener('abort', stop, { once: true }); if (signal?.aborted) stop();
  try {
    const result = await Promise.race([handle.exited, aborted]);
    const cleaned = await cleanProcessGroup({ inspector: systemProcessInspector, clock: systemClock, timer: systemTimer, identity, handle, graceMs: 1000, confirmMs: 1000 });
    if (cleaned !== 'died') throw new Error('cleanup-unconfirmed');
    if (result === 'abort') throw new Error('cancelled');
    if (result.code !== 0) throw new Error('exit');
    await consume;
    return stdout;
  } finally {
    signal?.removeEventListener('abort', stop); handle.closeOutput(); await consume.catch(() => {});
  }
}
/** Both preflight and environment setup apply the same pin policy. */
export function validPythonPin(pin: string): boolean {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(pin.trim());
  return !!match && (Number(match[1]) > 3 || (Number(match[1]) === 3 && Number(match[2]) >= 12));
}
export async function validatePythonInputs(directory: string): Promise<string> {
  const names = ['.python-version', 'pyproject.toml', 'uv.lock'];
  await Promise.all(names.map(async name => { if (!(await stat(join(directory, name))).isFile()) throw new Error('missing Python dependency input'); }));
  const pin = (await readFile(join(directory, '.python-version'), 'utf8')).trim();
  if (!validPythonPin(pin)) throw new Error('invalid Python pin');
  return pin;
}
export async function prepareExtensionPython(directory: string, parent: NodeJS.ProcessEnv, signal?: AbortSignal) {
  let pin: string;
  try { pin = await validatePythonInputs(directory); }
  catch { return failure('EXTENSION_PYTHON_PIN_INVALID'); }
  const env = { PATH: parent['PATH'] ?? '', HOME: parent['HOME'] ?? '', UV_PYTHON_DOWNLOADS: 'never' };
  const cancelled = (error: unknown) => signal?.aborted && error instanceof Error && error.message === 'cancelled' ? { ok: false as const, code: 'EXTENSION_INSTALL_CANCELLED' as const, message: '확장 설치가 취소되었습니다' } : undefined;
  try { await run('uv', ['--version'], directory, env, signal); } catch (error) { return cancelled(error) ?? failure('EXTENSION_UV_NOT_FOUND'); }
  let python: string;
  try { python = (await run('uv', ['python', 'find', pin, '--no-python-downloads'], directory, env, signal)).trim(); }
  catch (error) { return cancelled(error) ?? failure('EXTENSION_PYTHON_NOT_FOUND'); }
  try { await run('uv', ['sync', '--frozen', '--no-dev', '--python', python], directory, env, signal); }
  catch (error) { return cancelled(error) ?? failure('EXTENSION_PYTHON_SYNC_FAILED'); }
  try {
    const actual = (await run(join(directory, '.venv', 'bin', 'python'), ['-c', 'import platform; print(platform.python_version())'], directory, env, signal)).trim();
    if (actual !== pin) return failure('EXTENSION_PYTHON_VERSION_MISMATCH');
  } catch (error) { return cancelled(error) ?? failure('EXTENSION_PYTHON_VERSION_MISMATCH'); }
  return { ok: true as const };
}
