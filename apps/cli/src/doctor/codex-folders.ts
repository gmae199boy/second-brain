import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Inspect roots without reading user configuration or installing hooks. */
export async function codexRoots(env: NodeJS.ProcessEnv): Promise<{ home: string; state: 'present' | 'missing' | 'unknown' }> {
  const home = env['CODEX_HOME'] || join(homedir(), '.codex');
  let present = false;
  let unknown = false;
  for (const name of ['sessions', 'archived_sessions']) {
    try {
      const info = await stat(join(home, name));
      if (info.isDirectory()) present = true;
      else unknown = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') unknown = true;
    }
  }
  return { home, state: unknown ? 'unknown' : present ? 'present' : 'missing' };
}

export const codexGuidance = 'Codex는 scan-only입니다. 자동 hook/notify 연결은 없습니다. `brain queue drain` 또는 id와 transcript_path를 stdin으로 전달하는 `brain sessions ingest codex`를 사용하세요.';
