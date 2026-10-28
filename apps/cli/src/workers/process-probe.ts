import { setTimeout } from 'node:timers/promises';
import { PROCESS_ABI_ENV, decodeAbiEnv } from 'second_brain';
const env = process.env;
const target = env[PROCESS_ABI_ENV.targetId] ?? '';
const duration = Number(target);
if (!decodeAbiEnv(env).ok ||
    env[PROCESS_ABI_ENV.workKind] !== 'process_probe' || env[PROCESS_ABI_ENV.targetKind] !== 'probe' ||
    !/^\d+$/.test(target) || !Number.isSafeInteger(duration)) {
  console.log(JSON.stringify({ abi: 1, type: 'error', code: 'ABI_ENV_INVALID', retryable: false }));
  process.exitCode = 2;
} else {
  for (let elapsed = 0; elapsed < duration;) {
    const wait = Math.min(1000, duration - elapsed);
    await setTimeout(wait);
    elapsed += wait;
    console.log(JSON.stringify({ abi: 1, type: 'progress', message: `진행 ${elapsed}/${duration}ms` }));
  }
  console.log(JSON.stringify({ abi: 1, type: 'result', summary: `probe ${duration}ms 완료` }));
}
