import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
export const DEFAULT_DAEMON_LABEL = 'io.github.gmae199boy.second-brain.daemon';
/** Every externally named resource has exactly the same home identity. */
export function homeResources(home: string): { project: string; volume: string; port: number; label: string } {
  if (resolve(home) === join(homedir(), '.second_brain')) return {
    project: 'second-brain', volume: 'second-brain-pg', port: 54320, label: DEFAULT_DAEMON_LABEL,
  };
  const hash = createHash('sha256').update(resolve(home)).digest('hex');
  const suffix = hash.slice(0, 12);
  return { project: `second-brain-${suffix}`, volume: `second-brain-pg-${suffix}`,
    port: 20000 + (Number.parseInt(hash.slice(0, 8), 16) % 30000), label: `${DEFAULT_DAEMON_LABEL}.${suffix}` };
}
