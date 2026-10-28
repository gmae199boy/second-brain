import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
const plan = JSON.parse(process.env.FAKE_WORKER_PLAN ?? '{}');
if (plan.pidFile || plan.progressEveryMs || plan.ignoreTerm) {
  const record = data => { if (plan.pidFile) appendFileSync(plan.pidFile, JSON.stringify(data) + '\n'); };
  process.on('SIGTERM', () => { record({ term: process.pid }); if (!plan.ignoreTerm) process.exit(0); });
  let child;
  if (plan.grandchild) {
    child = spawn(process.execPath, ['-e', `const fs=require('node:fs'); const plan=JSON.parse(process.env.FAKE_WORKER_PLAN); process.on('SIGTERM',()=>{if(plan.pidFile)fs.appendFileSync(plan.pidFile,JSON.stringify({term:process.pid})+'\\n');if(!plan.ignoreTerm)process.exit(0)}); process.send('ready'); setInterval(()=>{},1000);`],
      { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
    await new Promise(resolve => child.once('message', resolve));
  }
  record({ leader: process.pid, grandchild: child?.pid ?? null });
  if (plan.progressEveryMs) setInterval(() => console.log('{"abi":1,"type":"progress"}'), plan.progressEveryMs);
  await new Promise(() => {});
} else if (plan.grandchild) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  console.log(JSON.stringify({ grandchild: child.pid }));
  await new Promise(() => {});
} else {
  for (const entry of plan.lines ?? []) {
    if (typeof entry === 'object') { await setTimeout(entry.delayMs ?? 0); console.log(entry.line); }
    else console.log(entry);
  }
  if (plan.raw !== undefined) process.stdout.write(plan.raw);
  if (plan.stderr !== undefined) process.stderr.write(plan.stderr);
  if (plan.signal) process.kill(process.pid, plan.signal);
  process.exitCode = plan.code ?? 0;
}
