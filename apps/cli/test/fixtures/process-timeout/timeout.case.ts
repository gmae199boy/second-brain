import { writeFile } from 'node:fs/promises';
import { afterEach, expect, it } from 'vitest';
import { OwnedProcesses, closeTestScope } from '../../owned-processes.js';

const scope = new OwnedProcesses();
afterEach(async () => {
  await closeTestScope(scope, [async () => { await writeFile(process.env.PROCESS_CLEANUP_MARKER!, 'fixture dropped'); }]);
});
it('times out after starting a child and grandchild', async () => {
  const script = `const {spawn}=require('node:child_process'); const fs=require('node:fs'); const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); fs.writeFileSync(process.env.PROCESS_PIDS,JSON.stringify([process.ppid,process.pid,c.pid])); setInterval(()=>{},1000);`;
  const child = scope.spawn(process.execPath, ['-e', script], { env: process.env });
  child.stdout.resume(); child.stderr.resume();
  await expect.poll(async () => { try { return await import('node:fs/promises').then(fs => fs.readFile(process.env.PROCESS_PIDS!, 'utf8')); } catch { return ''; } }, { timeout: 1000 }).toMatch(/^\[/);
  await new Promise(() => {});
});
