import type { ReadTranscriptResult, TranscriptReader } from '../../ports/transcript.js';

export interface MemoryTranscriptReaderOptions {
  /** Path to content. A path that is not in here is reported as unreadable. */
  files?: Readonly<Record<string, string>>;
}

export interface MemoryTranscriptReader extends TranscriptReader {
  /** Every path `read` was asked for, in order. */
  reads(): readonly string[];
  /** Put content at a path, or replace what is there — a transcript grew. */
  write(path: string, content: string): void;
  /** Take a path away, so the next read is `TRANSCRIPT_UNREADABLE`. */
  remove(path: string): void;
}

/**
 * A `TranscriptReader` over a map, so the ingest use case can be driven without
 * a filesystem (AD-1). A path nobody wrote is the "no such file" row of the
 * matrix, and it is a value rather than a throw for the same reason the real
 * one is: this runs on a hook.
 */
export function memoryTranscriptReader(
  options: MemoryTranscriptReaderOptions = {},
): MemoryTranscriptReader {
  const files = new Map<string, string>(Object.entries(options.files ?? {}));
  const asked: string[] = [];

  return {
    async read(path: string): Promise<ReadTranscriptResult> {
      asked.push(path);
      const content = files.get(path);
      if (content === undefined) {
        return {
          ok: false,
          code: 'TRANSCRIPT_UNREADABLE',
          message: `no transcript at ${path}`,
        };
      }
      return { ok: true, content };
    },
    reads: () => [...asked],
    write(path: string, content: string): void {
      files.set(path, content);
    },
    remove(path: string): void {
      files.delete(path);
    },
  };
}
