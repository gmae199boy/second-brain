import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** A registry owned by one test file, with explicit lifecycle registration. */
export function tempHomes() {
  const paths: string[] = [];
  return {
    async create(prefix: string): Promise<string> {
      const path = await mkdtemp(join(tmpdir(), prefix));
      paths.push(path);
      return path;
    },
    async cleanup(): Promise<void> {
      await Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    },
  };
}
