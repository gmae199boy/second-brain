import { dropPgHome } from './pg-home.js';
import { appendFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

// Never record home paths, filenames, contents, or connection strings.
function diagnostic(event: Record<string, unknown>): void {
  try {
    const line = JSON.stringify({ event: 'temp-home-cleanup', ...event }) + '\n';
    if (process.env.BRAIN_TEST_METRICS_LOG) appendFileSync(process.env.BRAIN_TEST_METRICS_LOG, line, { mode: 0o600 });
    else process.stdout.write(line);
  } catch { /* Diagnostics must not prevent cleanup. */ }
}

async function inventory(root: string): Promise<{ files: number; bytes: number; truncated: boolean }> {
  const pending = [root]; let files = 0, bytes = 0, visited = 0, incomplete = false;
  while (pending.length && visited < 10000) {
    const path = pending.pop()!; visited++;
    try {
      const entry = await lstat(path);
      if (entry.isDirectory()) for (const name of await readdir(path)) pending.push(join(path, name));
      else if (entry.isFile()) { files++; bytes += entry.size; }
    } catch { incomplete = true; /* An unreadable entry is not evidence of absence. */ }
  }
  return { files, bytes, truncated: incomplete || pending.length > 0 };
}

/** A registry owned by one test file, with explicit lifecycle registration. */
export function tempHomes(drop = dropPgHome) {
  const paths: string[] = [];
  let cleaning: Promise<void> | undefined;
  return {
    async create(prefix: string): Promise<string> {
      const path = await mkdtemp(join(tmpdir(), prefix));
      paths.push(path);
      return path;
    },
    cleanup(options: { skip?: ReadonlySet<string> } = {}): Promise<void> {
      if (cleaning) return cleaning;
      cleaning = (async () => {
        const results = await Promise.allSettled([...paths].filter(path => !options.skip?.has(path)).map(async (path, home) => {
          const started = performance.now(); let phase = 'database-drop';
          diagnostic({ home, phase, state: 'started' });
          const timer = setTimeout(() => {
            const resources: Record<string, number> = {};
            for (const name of process.getActiveResourcesInfo()) resources[name] = (resources[name] ?? 0) + 1;
            diagnostic({ home, phase, state: 'pending', elapsedMs: Math.round(performance.now() - started), resources });
            void inventory(path).then(summary => diagnostic({ home, phase, state: 'inventory', ...summary }));
          }, 5000);
          timer.unref();
          try {
            await drop(path);
            diagnostic({ home, phase, state: 'finished', elapsedMs: Math.round(performance.now() - started) });
            phase = 'directory-remove';
            diagnostic({ home, phase, state: 'started' });
            await rm(path, { recursive: true, force: true });
            const index = paths.indexOf(path); if (index >= 0) paths.splice(index, 1);
            diagnostic({ home, phase, state: 'finished', elapsedMs: Math.round(performance.now() - started) });
          } catch (error) {
            diagnostic({ home, phase, state: 'failed', elapsedMs: Math.round(performance.now() - started) });
            throw error;
          } finally { clearTimeout(timer); }
        }));
        const errors = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected').map(result => result.reason);
        if (errors.length) throw new AggregateError(errors, 'temporary home cleanup failed');
      })().finally(() => { cleaning = undefined; });
      return cleaning;
    },
  };
}
