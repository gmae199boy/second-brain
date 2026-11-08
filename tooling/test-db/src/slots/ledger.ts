import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export interface Identity { pid: number; started: string }
export type Liveness = 'alive' | 'dead' | 'unknown';
export type Lookup = (pid: number) => Promise<string | null>;
const exec = promisify(execFile);
export const lookupProcess: Lookup = async pid => {
  try { const result = await exec('ps', ['-p', String(pid), '-o', 'lstart='], { env: { ...process.env, LC_ALL: 'C' } }); return result.stdout.trim() || null; }
  catch (e) { const err = e as { code?: number; stdout?: string; stderr?: string }; if (err.code === 1 && !err.stdout?.trim() && !err.stderr?.trim()) return null; throw e; }
};
export async function liveness(identity: Identity, lookup: Lookup = lookupProcess): Promise<Liveness> {
  try { const started = await lookup(identity.pid); return started === null || started !== identity.started ? 'dead' : 'alive'; } catch { return 'unknown'; }
}
export interface Ledger { runId: string; kind?: 'coordinator' | 'direct'; state?: 'running' | 'completed'; coordinator: Identity; slots: unknown[]; files: unknown[]; resources: unknown[]; cleanup: unknown[]; [key: string]: unknown }
export function ledgerPath(repo: string, runId: string): string { if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('invalid run ID'); return join(repo, '.brain-test-runs', `${runId}.json`); }
export async function writeLedger(repo: string, ledger: Ledger): Promise<void> {
  const path = ledgerPath(repo, ledger.runId), temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await mkdir(join(repo, '.brain-test-runs'), { recursive: true });
  await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}
export async function readLedger(repo: string, runId: string): Promise<Ledger> { return JSON.parse(await readFile(ledgerPath(repo, runId), 'utf8')) as Ledger; }
