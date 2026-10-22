import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  CONTENT_HASH_PREFIX,
  describeError,
  type ReadTranscriptResult,
  type TranscriptReader,
} from 'second_brain';

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
        // The bytes, not the text, and the two facts about them the history
        // keeps: how many there were and what they hash to (Table Contract).
        // Measured on the bytes rather than on the decoded string because that
        // is what the folder listing reports and what the next scan compares
        // against — `content.length` would be code units and would disagree
        // with `stat` for every transcript holding a non-ASCII character.
        const bytes = await readFile(path);
        return {
          ok: true,
          content: bytes.toString('utf8'),
          sizeBytes: bytes.byteLength,
          fingerprint: `${CONTENT_HASH_PREFIX}${createHash('sha256').update(bytes).digest('hex')}`,
        };
      } catch (error) {
        return {
          ok: false,
          code: 'TRANSCRIPT_UNREADABLE',
          message: `트랜스크립트를 읽을 수 없습니다: ${describeError(error)}`,
        };
      }
    },
  };
}
