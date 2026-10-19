import type {
  ListTranscriptsResult,
  TranscriptFolder,
  TranscriptListing,
} from '../../ports/transcript.js';

/** What one file of the fake folder is, before the harness is filled in. */
export interface MemoryTranscriptFile {
  harnessSessionId: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
}

export interface MemoryTranscriptFolderOptions {
  /** The harness this folder belongs to. Defaults to the fixtures' `demo`. */
  harness?: string;
  /** What the first `list` answers with. */
  files?: readonly MemoryTranscriptFile[];
  /**
   * Answer every `list` with this instead of the files. The "the folder cannot
   * be read" row of the matrix, which doctor turns into a `warn` and the scan
   * into a sentence — and which cannot be arranged without a filesystem
   * otherwise (AD-1).
   */
  listFailure?: string;
}

export interface MemoryTranscriptFolder extends TranscriptFolder {
  /** Put a file in the folder, or replace one: a transcript grew. */
  write(file: MemoryTranscriptFile): void;
  /** Take a file away: the harness deleted it past its retention. */
  remove(path: string): void;
  /** How many times `list` was asked. A scan must not list twice per drain. */
  lists(): number;
}

/**
 * A `TranscriptFolder` over a list, so the folder scan and doctor's
 * `transcripts` check can be driven without a filesystem (AD-1).
 *
 * It answers with whatever it was given, in the order it was given: the
 * ordering a scan depends on is its own (`modifiedAt`), and a fake that sorted
 * for it would hide a scan that forgot to.
 */
export function memoryTranscriptFolder(
  options: MemoryTranscriptFolderOptions = {},
): MemoryTranscriptFolder {
  const harness = options.harness ?? 'demo';
  const files = new Map<string, MemoryTranscriptFile>(
    (options.files ?? []).map((file) => [file.path, file]),
  );
  let lists = 0;

  return {
    harness,
    async list(): Promise<ListTranscriptsResult> {
      lists += 1;
      if (options.listFailure !== undefined) {
        return { ok: false, message: options.listFailure };
      }
      const listing: TranscriptListing[] = [...files.values()].map((file) => ({
        harness,
        harnessSessionId: file.harnessSessionId,
        path: file.path,
        sizeBytes: file.sizeBytes,
        modifiedAt: file.modifiedAt,
      }));
      return { ok: true, files: listing };
    },
    write(file: MemoryTranscriptFile): void {
      files.set(file.path, file);
    },
    remove(path: string): void {
      files.delete(path);
    },
    lists: () => lists,
  };
}
