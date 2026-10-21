import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { lastHookPath } from '../config/paths.js';

/** Diagnostic evidence must never cost the hook its collection. */
export async function recordHookArrival(home: string, harness: string, root?: string): Promise<void> {
  const target = lastHookPath(home, harness);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(temporary, root ? `${root}\n` : '', { mode: 0o600, flag: 'wx' });
    await rename(temporary, target);
  } catch {
    // Best effort: this fact is independent of the database and spool.
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
