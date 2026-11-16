import childProcess from 'node:child_process';
import { promisify } from 'node:util';

// Capture before the file guard is installed. This capability accepts no command,
// arguments or environment from callers and is used only for process observation.
const observe = promisify(childProcess.execFile);
export async function fixedProcessSnapshot(): Promise<string> {
  return (await observe('/bin/ps', ['-A', '-o', 'pid=,ppid=,pgid=,lstart=,%cpu=,time=,stat='], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, timeout: 5000, maxBuffer: 4 * 1024 * 1024 })).stdout;
}
