import { execFile } from 'node:child_process';
import type { ProcessGroupMember, ProcessInspector, ProcessObservation } from 'second_brain';
export interface InspectionOutput { code: number | null; stdout: string; stderr: string }
export function inspectionState(output: InspectionOutput): 'found' | 'none' | 'unknown' {
  if (output.code === 1 && output.stdout === '' && output.stderr === '') return 'none';
  return output.code === 0 && output.stderr === '' ? 'found' : 'unknown';
}
export function parseProcessStartedAt(text: string): Date | null {
  if (!/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)\s+(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/.test(text.trim())) return null;
  const parsed = new Date(text.trim());
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}
export function parseBootTime(output: InspectionOutput): ProcessObservation<Date> {
  const state = inspectionState(output);
  if (state !== 'found') return { state };
  const match = /\bsec\s*=\s*(\d+)\s*,/.exec(output.stdout);
  const value = match ? new Date(Number(match[1]) * 1000) : null;
  return value && Number.isFinite(value.getTime()) ? { state: 'found', value } : { state: 'unknown' };
}
export function parseStartedAt(output: InspectionOutput): ProcessObservation<Date> {
  const state = inspectionState(output);
  if (state !== 'found') return { state };
  const value = parseProcessStartedAt(output.stdout);
  return value ? { state: 'found', value } : { state: 'unknown' };
}
export function parseGroupMembers(output: InspectionOutput): ProcessObservation<ProcessGroupMember[]> {
  const state = inspectionState(output);
  if (state !== 'found') return { state };
  const members: ProcessGroupMember[] = [];
  for (const line of output.stdout.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    const startedAt = match ? parseProcessStartedAt(match[3]!) : null;
    if (!match || !startedAt || Number(match[1]) <= 0 || Number(match[2]) <= 0) return { state: 'unknown' };
    members.push({ pid: Number(match[1]), pgid: Number(match[2]), startedAt });
  }
  return { state: 'found', value: members };
}
export function createProcessInspector(paths: { ps?: string; sysctl?: string; timeoutMs?: number } = {}): ProcessInspector {
  async function run(command: string, args: string[]): Promise<InspectionOutput> {
    return new Promise(resolve => {
      execFile(command, args, { env: { ...process.env, LC_ALL: 'C' }, encoding: 'utf8', timeout: paths.timeoutMs ?? 5_000, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
        resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : null, stdout, stderr });
      });
    });
  }
  return {
    async bootTime() { return parseBootTime(await run(paths.sysctl ?? '/usr/sbin/sysctl', ['-n', 'kern.boottime'])); },
    async startedAt(pid) { return parseStartedAt(await run(paths.ps ?? '/bin/ps', ['-o', 'lstart=', '-p', String(pid)])); },
    async groupMembers(pgid) { return parseGroupMembers(await run(paths.ps ?? '/bin/ps', ['-o', 'pid=,pgid=,lstart=', '-g', String(pgid)])); },
    async signalGroup(pgid, signal) {
      try { process.kill(-pgid, signal); return 'sent'; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'none' : 'failed'; }
    },
  };
}
export const systemProcessInspector = createProcessInspector();
