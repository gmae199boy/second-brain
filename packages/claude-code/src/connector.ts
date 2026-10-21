import { randomUUID } from 'node:crypto';
import { chmod, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BRAIN_MARKER, type Connector } from '@second-brain/core';
import { claudeCodeParser } from './parser.js';

/** Claude Code owns its hooks through the plugin; remove only old Brain entries. */
export function claudeCodeConnector(options: { configDir?: string } = {}): Connector {
  const configDir = options.configDir ?? join(homedir(), '.claude');
  const target = join(configDir, 'settings.json');
  const parser = claudeCodeParser();
  return {
    harness: parser.harness,
    label: 'Claude Code',
    parser,
    hookSource: 'plugin',
    async detect() {
      try { return (await stat(configDir)).isDirectory(); } catch { return false; }
    },
    async connect({ pluginRoot }) {
      const warnings = pluginRoot === null ? { warnings: ['PLUGIN_NOT_INSTALLED'] as const } : {};
      const success = (changed: boolean) => ({ ok: true as const, target, changed, ...warnings });
      let temp: string | undefined;
      try {
        let text: string;
        try { text = await readFile(target, 'utf8'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return success(false);
          throw error;
        }
        const settings: unknown = JSON.parse(text);
        if (!record(settings)) throw new Error('설정은 객체여야 합니다');
        if (settings['hooks'] === undefined) return success(false);
        const hooks = settings['hooks'];
        if (!record(hooks)) throw new Error('hooks는 객체여야 합니다');
        // Validate the whole shape before changing anything, including other events.
        for (const groups of Object.values(hooks)) {
          if (!Array.isArray(groups)) throw new Error('이벤트는 배열이어야 합니다');
          for (const group of groups) {
            if (!record(group) || !Array.isArray(group['hooks']) || !group['hooks'].every(record)) {
              throw new Error('hook 그룹을 읽을 수 없습니다');
            }
          }
        }
        let changed = false;
        for (const [event, value] of Object.entries(hooks)) {
          const groups = value as Record<string, unknown>[];
          const kept = groups.filter((group) => {
            const entries = group['hooks'] as Record<string, unknown>[];
            const remaining = entries.filter((entry) => !(entry['type'] === 'command' &&
              typeof entry['command'] === 'string' && entry['command'].trimEnd().endsWith(`# ${BRAIN_MARKER}`)));
            if (remaining.length === entries.length) return true;
            changed = true;
            group['hooks'] = remaining;
            return remaining.length !== 0;
          });
          // Keep pre-existing empty arrays and groups untouched.
          if (kept.length !== groups.length && kept.length === 0) delete hooks[event];
          else hooks[event] = kept;
        }
        if (!changed) return success(false);
        const mode = (await stat(target)).mode & 0o7777;
        temp = `${target}.${randomUUID()}.tmp`;
        await writeFile(temp, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: 'wx' });
        await chmod(temp, mode);
        await rename(temp, target);
        return success(true);
      } catch {
        return { ok: false, code: 'HARNESS_UNREADABLE', message: `${target}의 설정을 읽거나 쓸 수 없습니다. JSON과 hooks 모양, 파일 권한을 확인하세요.` };
      } finally {
        if (temp !== undefined) await unlink(temp).catch(() => {});
      }
    },
  };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
