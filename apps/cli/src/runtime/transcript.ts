import { readFile } from 'node:fs/promises';
import type { ReadTranscriptResult, TranscriptReader } from 'second_brain';

/**
 * The Runtime's `TranscriptReader`: the one place a harness transcript is read
 * off the disk (AD-1).
 *
 * A file that is not there, that is a folder, or that this user may not read is
 * a value and not a throw, under the same code the parser uses for content it
 * cannot read: from the caller's side there is nothing to ingest either way,
 * and this runs on a harness hook where a throw would be the brain breaking a
 * turn (AD-6).
 *
 * It reads the whole file. Incremental reads from a stored cursor are story
 * 2.7's; until then a turn costs one read of a file that is, in practice, a few
 * hundred kilobytes.
 */
export function fileTranscriptReader(): TranscriptReader {
  return {
    async read(path: string): Promise<ReadTranscriptResult> {
      try {
        return { ok: true, content: await readFile(path, 'utf8') };
      } catch (error) {
        return { ok: false, code: 'TRANSCRIPT_UNREADABLE', message: describe(error) };
      }
    },
  };
}

/** Whatever went wrong, in one non-empty line (Conventions: no silent failure). */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code: unknown = (error as { code?: unknown }).code;
  const candidates = [error.message, typeof code === 'string' ? code : '', error.name];
  return candidates.find((candidate) => candidate !== '') ?? 'unknown error';
}
