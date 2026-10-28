import { spawn } from 'node:child_process';
import { setTimeout } from 'node:timers/promises';
const plan = JSON.parse(process.env.FAKE_WORKER_PLAN ?? '{}');
if (plan.grandchild) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log(JSON.stringify({ grandchild: child.pid }));
  await new Promise(() => {});
} else {
  for (const entry of plan.lines ?? []) {
    if (typeof entry === 'object') { await setTimeout(entry.delayMs ?? 0); console.log(entry.line); }
    else console.log(entry);
  }
  process.exitCode = plan.code ?? 0;
}
