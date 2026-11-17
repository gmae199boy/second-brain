import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TranscriptFolder, TranscriptListing } from '@second-brain/core';
import { CODEX_HARNESS, codexSessionId } from './parser.js';

export interface CodexTranscriptFolderOptions { configDir?: string }

/** The two roots are one logical folder because ingestion locates by session ID. */
export function codexTranscriptFolder(options: CodexTranscriptFolderOptions = {}): TranscriptFolder {
  const home = options.configDir ?? join(homedir(), '.codex');
  return {
    harness: CODEX_HARNESS,
    async list() {
      const files = new Map<string, TranscriptListing>();
      try {
        async function visit(directory: string): Promise<void> {
          let entries;
          try { entries = await readdir(directory, { withFileTypes: true }); }
          catch (error) {
            if (missing(error)) return;
            throw error;
          }
          entries.sort((a, b) => a.name.localeCompare(b.name));
          for (const entry of entries) {
            const path = join(directory, entry.name);
            // Do not traverse links: cycles and external trees are not Codex roots.
            if (entry.isDirectory()) { await visit(path); continue; }
            if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
            try {
              const bytes = await readFile(path);
              const id = codexSessionId(bytes.toString('utf8'));
              if (!id && bytes.toString('utf8').split('\n').slice(0, -1).every(line => line.trim() === '')) continue;
              if (!id) throw new Error(`Codex 메타 ID를 읽을 수 없습니다: ${path}`);
              const info = await stat(path);
              if (!info.isFile()) continue;
              const fingerprint = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
              const prior = files.get(id);
              if (prior && prior.fingerprint !== fingerprint) throw new Error(`Codex 세션 ID가 서로 다른 기록에 중복됩니다: ${id}`);
              if (!prior) files.set(id, { harness: CODEX_HARNESS, harnessSessionId: id, path, sizeBytes: bytes.length, modifiedAt: info.mtime, fingerprint });
            } catch (error) {
              if (missing(error)) continue;
              throw error;
            }
          }
        }
        await visit(join(home, 'sessions'));
        await visit(join(home, 'archived_sessions'));
        return { ok: true, files: [...files.values()] };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function missing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
