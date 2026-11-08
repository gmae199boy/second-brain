import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Identity } from './ledger.js';
export interface LockOwner extends Identity { runId: string; token: string; acquiredAt: string }
export interface Lock { path: string; owner: LockOwner; waitMs: number; release(): Promise<void> }
export async function acquireLock(name: string, identity: Identity, runId: string, options: { directory?: string; timeoutMs?: number; now?: () => number } = {}): Promise<Lock> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error('invalid lock name');
  const directory = options.directory ?? `/tmp/second-brain-test-locks-${process.getuid?.() ?? 'unknown'}`;
  const path = join(directory, `${name}.lock`), ownerPath = `${path}.owner.json`, now = options.now ?? Date.now, start = now();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  // Inherit the hook process group so the coordinator can stop the helper with its hook child.
  const child = spawn('/usr/bin/lockf', ['-k', path, '/bin/sh', '-c', 'printf "acquired\\n"; exec cat >/dev/null'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', output = '';
  child.stderr.setEncoding('utf8'); child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdin.on('error', () => {});
  const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: Error }>(resolve => {
    let spawnError: Error | undefined;
    child.once('error', error => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, error: spawnError }));
  });
  let ready!: () => void;
  const acquired = new Promise<'acquired'>(resolve => { ready = () => resolve('acquired'); });
  child.stdout.setEncoding('utf8'); child.stdout.on('data', chunk => { output += chunk; if (output.split('\n').includes('acquired')) ready(); });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = options.timeoutMs === undefined ? new Promise<never>(() => {}) : new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), options.timeoutMs); });
  const outcome = await Promise.race([acquired, completion, timeout]);
  if (timer) clearTimeout(timer);
  // Close stdin first: if lockf already started the command, cat sees EOF and exits instead of outliving lockf.
  if (outcome === 'timeout') { child.stdin.end(); child.kill('SIGKILL'); await completion; throw new Error('lock wait timed out'); }
  if (outcome !== 'acquired') {
    if ((outcome.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') throw new Error('/usr/bin/lockf is unavailable');
    throw new Error(`lockf exited before acquisition: code=${outcome.code} signal=${outcome.signal} error=${String(outcome.error ?? '')} stderr=${stderr}`);
  }
  const waitMs = now() - start, owner: LockOwner = { ...identity, runId, token: randomBytes(16).toString('hex'), acquiredAt: new Date().toISOString() };
  const temp = `${ownerPath}.${owner.token}.tmp`;
  try { await writeFile(temp, JSON.stringify(owner) + '\n', { flag: 'wx', mode: 0o600 }); await rename(temp, ownerPath); }
  catch (error) { child.stdin.end(); await completion; throw error; }
  finally { await unlink(temp).catch(() => {}); }
  let released: Promise<void> | undefined;
  return { path, owner, waitMs, release() {
    return released ??= (async () => {
      // Remove the owner record while the kernel lock is still held, so it can never be the next owner's file.
      let ownerError: unknown;
      try { const current = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: unknown }; if (current.token === owner.token) await unlink(ownerPath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') ownerError = error; }
      child.stdin.end();
      const result = await completion;
      if (result.code !== 0 || result.error) throw new Error(`lockf release failed: code=${result.code} signal=${result.signal} error=${String(result.error ?? '')} stderr=${stderr}`);
      if (ownerError !== undefined) throw ownerError;
    })();
  } };
}
