/**
 * What reading a transcript produced. A file that is not there, or that cannot
 * be read, is a value and not an exception (Conventions): this runs on a
 * harness hook, and a missing transcript must not be the thing that throws.
 *
 * The code is the parser's own `TRANSCRIPT_UNREADABLE`, deliberately: from the
 * caller's side "the file is gone" and "the file is not a transcript" are the
 * same answer — there is nothing to ingest and nothing anybody can do from
 * here — and two codes for it would be two things to handle for no gain.
 */
export type ReadTranscriptResult =
  | { ok: true; content: string }
  | { ok: false; code: 'TRANSCRIPT_UNREADABLE'; message: string };

/**
 * Reading a transcript, as a port: Core has no filesystem (AD-1), and the read
 * happens outside the write transaction so a slow disk never holds the write
 * lock (AD-7).
 */
export interface TranscriptReader {
  /** The whole file as text. Never throws. */
  read(path: string): Promise<ReadTranscriptResult>;
}
