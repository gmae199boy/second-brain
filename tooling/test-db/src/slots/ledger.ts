import { randomBytes } from 'node:crypto';
import { mkdir, rename, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixedProcessSnapshot } from './internal-ps.js';
import { parseProcesses } from './processes.js';

export interface Identity { pid: number; started: string }
export type Liveness = 'alive' | 'dead' | 'unknown';
export type Lookup = (pid: number) => Promise<string | null>;
export const lookupProcess: Lookup = async pid => {
  const rows = parseProcesses(await fixedProcessSnapshot());
  return rows.find(row => row.pid === pid)?.started ?? null;
};
export async function liveness(identity: Identity, lookup: Lookup = lookupProcess): Promise<Liveness> {
  try { const started = await lookup(identity.pid); return started === null || started !== identity.started ? 'dead' : 'alive'; } catch { return 'unknown'; }
}
export interface Ledger { runId: string; kind?: 'coordinator' | 'direct' | 'typescript'; state?: 'running' | 'completed'; coordinator: Identity; slots: unknown[]; files: unknown[]; resources: unknown[]; cleanup: unknown[]; [key: string]: unknown }
export function ledgerPath(repo: string, runId: string): string { if (!/^[a-zA-Z0-9_-]+$/.test(runId)) throw new Error('invalid run ID'); return join(repo, '.brain-test-runs', `${runId}.json`); }
export async function writeLedger(repo: string, ledger: Ledger): Promise<void> {
  const path = ledgerPath(repo, ledger.runId), temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  await mkdir(join(repo, '.brain-test-runs'), { recursive: true });
  await writeFile(temp, JSON.stringify(ledger, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  await rename(temp, path);
}
export async function readLedger(repo: string, runId: string): Promise<Ledger> { return JSON.parse(await readFile(ledgerPath(repo, runId), 'utf8')) as Ledger; }
