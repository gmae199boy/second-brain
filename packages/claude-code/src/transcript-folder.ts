import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  ListTranscriptsResult,
  TranscriptFolder,
  TranscriptListing,
} from '@second-brain/core';
import { CLAUDE_CODE_HARNESS } from './parser.js';

/**
 * Where Claude Code keeps its transcripts, as a `TranscriptFolder` (AD-4).
 *
 * The layout, which is the whole of what this file knows:
 *
 *   <configDir>/projects/<folder per working directory>/<session id>.jsonl
 *
 * The folder name is the working directory with its separators replaced, and
 * this never reads it: the session id is the file name, which is the one thing
 * the listing has to answer with. So a project folder's name can change shape
 * between editor versions without anything here caring.
 *
 * What is deliberately not listed:
 *
 *   * `subagents/` and `tool-results/` under a project folder, and anything
 *     deeper. A delegated run is not a session — the parser reports its final
 *     report as one message of the main conversation (AD-4) — so counting one
 *     as a session would create a session row for a conversation that never
 *     happened (Boundaries).
 *   * anything that is not a regular file whose name ends in `.jsonl`.
 *
 * A missing `projects/` folder is an empty list and not a failure: a machine
 * where Claude Code has never run has no folder, and a brain installed before
 * the editor must not report that as broken.
 */

export interface ClaudeCodeTranscriptFolderOptions {
  /**
   * The editor's configuration folder. The caller resolves it, because where it
   * is — `CLAUDE_CONFIG_DIR` or `~/.claude` — is a fact about the environment
   * and the runtime is what reads environments (AD-1, AD-18).
   */
  configDir?: string;
}

/** The subfolder of `configDir` the transcripts live under. */
const PROJECTS = 'projects';

/** The extension of a transcript, which the session id is the rest of. */
const TRANSCRIPT_SUFFIX = '.jsonl';

/**
 * The folder for one configuration directory.
 *
 * Nothing is read here: the folder is listed by `list`, so building this touches
 * no disk (AD-3) and a brain assembled on a machine with no editor is still a
 * brain that starts.
 */
export function claudeCodeTranscriptFolder(
  options: ClaudeCodeTranscriptFolderOptions = {},
): TranscriptFolder {
  const configDir = options.configDir ?? join(homedir(), '.claude');
  const projects = join(configDir, PROJECTS);

  return {
    harness: CLAUDE_CODE_HARNESS,

    async list(): Promise<ListTranscriptsResult> {
      let folders: string[];
      try {
        const entries = await readdir(projects, { withFileTypes: true });
        folders = entries
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
          .map((entry) => entry.name);
      } catch (error) {
        // No `projects/` is no transcripts, which is the state of a machine
        // where the editor has never run.
        if (isMissing(error)) return { ok: true, files: [] };
        return {
          ok: false,
          message: `${projects}를 읽을 수 없습니다: ${describe(error)}`,
        };
      }

      const files: TranscriptListing[] = [];
      for (const folder of folders) {
        const directory = join(projects, folder);
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch (error) {
          // A folder that has gone away between the two listings is nothing:
          // the editor removes a project folder when its working directory is
          // deleted, and a race with that is not a problem to report.
          //
          // Anything else — a folder this user may not read — is reported, and
          // the whole listing fails with it. That costs the other projects
          // their scan for as long as it lasts, and it is still the right
          // answer: a listing that quietly left those transcripts out would
          // make them invisible to the scan *and* to doctor's uncollected
          // count, which is exactly the silent loss of NFR-2.
          if (isMissing(error)) continue;
          return {
            ok: false,
            message: `${directory}를 읽을 수 없습니다: ${describe(error)}`,
          };
        }

        for (const entry of entries) {
          if (!entry.name.endsWith(TRANSCRIPT_SUFFIX)) continue;
          const harnessSessionId = entry.name.slice(0, -TRANSCRIPT_SUFFIX.length);
          if (harnessSessionId === '') continue;
          const path = join(directory, entry.name);
          // `stat` and not `lstat`, and after the name check: a symbolic link
          // to a transcript is a transcript, and asking the filesystem about a
          // name that was never going to be listed costs a syscall per file.
          let stats;
          try {
            stats = await stat(path);
          } catch {
            // Gone between the listing and the question, or not readable. Not
            // a file to report on, and not a failure of the folder either.
            continue;
          }
          if (!stats.isFile()) continue;
          files.push({
            harness: CLAUDE_CODE_HARNESS,
            harnessSessionId,
            path,
            sizeBytes: stats.size,
            modifiedAt: new Date(stats.mtimeMs),
          });
        }
      }

      return { ok: true, files };
    },
  };
}

/** Whether the filesystem said "there is nothing at that name". */
function isMissing(error: unknown): boolean {
  const code: unknown = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Whatever went wrong, in one non-empty line (Conventions: no silent failure). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [error.message.split('\n')[0] ?? '', typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? '알 수 없는 오류';
}
