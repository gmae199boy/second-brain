import type { Clock, Timer } from '../ports/clock.js';
import type { ProcessInspector, ProcessLauncher, ProcessSpec } from '../ports/process.js';
import { createAbiRun, createAbiStderr, decodeAbiEnv, type AbiRunVerdict } from '../process-abi/codec.js';
import { cleanProcessGroup } from '../queue/process-cleanup.js';
export async function runExtensionCheck(options: {
  launcher: ProcessLauncher; inspector: ProcessInspector; clock: Clock; timer: Timer; spec: ProcessSpec; timeoutMs?: number;
}): Promise<AbiRunVerdict> {
  const run = createAbiRun(), stderr = createAbiStderr();
  const invalid = decodeAbiEnv(options.spec.env);
  if (!invalid.ok) return { outcome: 'failed', code: invalid.code, message: invalid.reason, usage: null };
  let started;
  try { started = await options.launcher.start(options.spec); }
  catch { return { outcome: 'failed', code: 'PROCESS_START_FAILED', message: '연결 확인 프로세스를 시작하지 못했습니다', usage: null }; }
  if (!started.ok) return { outcome: 'failed', code: 'PROCESS_START_FAILED', message: '연결 확인 프로세스를 시작하지 못했습니다', usage: null };
  const handle = started.handle;
  const boot = await options.inspector.bootTime(), at = await options.inspector.startedAt(handle.pid);
  const identity = { pgid: handle.pid, osBootAt: boot.state === 'found' ? boot.value : null, osStartedAt: at.state === 'found' ? at.value : null };
  const consume = async (stream: AsyncIterable<string>, feed: (chunk: string) => unknown) => {
    try { for await (const chunk of stream) feed(chunk); }
    catch { run.fail('ABI_OUTPUT_UNREADABLE', '연결 확인 출력을 읽지 못했습니다'); }
  };
  const output = Promise.all([consume(handle.stdout, chunk => run.feed(chunk)), consume(handle.stderr, chunk => stderr.feed(chunk))]);
  const timeout = new AbortController();
  let exit: { code: number | null; signal: string | null } = { code: null, signal: null };
  try {
    const result = await Promise.race([
      handle.exited.then(value => ({ type: 'exit' as const, value })),
      options.timer.sleep(options.timeoutMs ?? 60_000, timeout.signal).then(() => ({ type: 'timeout' as const })),
    ]);
    if (result.type === 'timeout') run.fail('PROCESS_STALLED', '연결 확인 시간이 초과되었습니다');
    else exit = result.value;
    const cleaned = await cleanProcessGroup({ ...options, identity, handle, graceMs: 1000, confirmMs: 1000 });
    if (cleaned !== 'died') run.fail('PROCESS_DIED', '연결 확인 프로세스 그룹의 종료를 확인하지 못했습니다');
  } finally {
    timeout.abort();
    const drain = new AbortController();
    await Promise.race([output, options.timer.sleep(1000, drain.signal)]);
    drain.abort();
    handle.closeOutput();
    await output;
  }
  run.end();
  // Stderr is bounded and masked by the shared ABI collector; the verdict is
  // determined solely by the protocol and exit, never by a textual summary.
  stderr.value();
  return run.verdict(exit);
}
