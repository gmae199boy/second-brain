import { setTimeout } from 'node:timers/promises';
import { PROCESS_ABI_ENV } from 'second_brain';
const env = process.env;
const target = env[PROCESS_ABI_ENV.targetId] ?? '';
const duration = Number(target);
if (Object.values(PROCESS_ABI_ENV).some((key) => !env[key]) || env[PROCESS_ABI_ENV.version] !== '1' ||
    env[PROCESS_ABI_ENV.workKind] !== 'process_probe' || env[PROCESS_ABI_ENV.targetKind] !== 'probe' ||
    !/^\d+$/.test(target) || !Number.isSafeInteger(duration)) {
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
