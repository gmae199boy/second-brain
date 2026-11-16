import { dropPgHome } from './pg-home.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
      const errors: unknown[] = [];
      for (const path of [...paths]) {
        if (options.skip?.has(path)) continue;
        try { await drop(path); } catch (error) { errors.push(error); continue; }
        try { await rm(path, { recursive: true, force: true }); const index = paths.indexOf(path); if (index >= 0) paths.splice(index, 1); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'temporary home cleanup failed');
      })().finally(() => { cleaning = undefined; });
      return cleaning;
    },
  };
}
