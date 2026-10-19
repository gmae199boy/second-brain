/**
 * What reading a transcript produced. A file that is not there, or that cannot
 * be read, is a value and not an exception (Conventions): this runs on a
 * harness hook, and a missing transcript must not be the thing that throws.
 *
 * The code is the parser's own `TRANSCRIPT_UNREADABLE`, deliberately: from the
 * caller's side "the file is gone" and "the file is not a transcript" are the
 * same answer — there is nothing to ingest and nothing anybody can do from
 * here — and two codes for it would be two things to handle for no gain.
 *
 * `sizeBytes` and `fingerprint` are what the read saw, not what the folder
 * listing saw a moment earlier: the scan compares a listing against the stored
 * history to decide what to open, but what goes into `transcript_files` has to
 * be the bytes this ingest actually read, or the next scan would believe a file
 * was read further than it was (Boundaries).
 */
export type ReadTranscriptResult =
  | {
      ok: true;
      content: string;
      /** How many bytes were read, which is the file's size at that moment. */
      sizeBytes: number;
      /** `sha256:` of the bytes read, as `transcript_files` stores it (AD-8). */
      fingerprint: string;
    }
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

/**
 * One transcript file a harness folder holds, as the listing reports it.
 *
 * The session id is in here because that is the whole point of a listing: a
 * folder scan has to be able to say which session a file belongs to without
 * opening it, so that a file nothing has changed is never read (Design Notes).
 * How that is worked out is the adapter's — Claude Code names the file after
 * the session — and Core never parses a path.
 *
 * `sizeBytes` and `modifiedAt` are what the filesystem said. Neither is
 * trusted for anything but "has this changed since the last scan": the bytes
 * that get stored come from the read (`ReadTranscriptResult`).
 */
export interface TranscriptListing {
  /** The harness whose folder this came from, the first half of a token (AD-8). */
  harness: string;
  /** The harness's own session id, the second half of a token. */
  harnessSessionId: string;
  /** Where the file is, as `transcript_files.path` stores it. */
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
}

/**
 * What one listing came to. A folder that is not there is an empty list and not
 * a failure — a machine where the harness has never run has no folder — and
 * everything else that stopped the listing is a sentence, because a folder
 * nobody can read is not a state of the brain (NFR-2).
 *
 * No code: the one caller turns this into a doctor `warn` and into a scan that
 * found nothing, and neither of those is helped by a code nobody can act on.
 */
export type ListTranscriptsResult =
  | { ok: true; files: readonly TranscriptListing[] }
  | { ok: false; message: string };

/**
 * One harness's transcript folder, as a port: the drain's scan is what picks up
 * the sessions no hook reported (AD-4, AD-7), and Core has no filesystem to
 * look in (AD-1).
 *
 * It is a port per harness rather than one port that takes a harness, because
 * where a harness keeps its transcripts — and what a file name means there — is
 * that connector's knowledge, and the runtime is what decides which folders
 * exist at all. A build with no folders scans nothing, which is exactly what
 * the capture switch of this story turns on and off (Boundaries).
 */
export interface TranscriptFolder {
  /** Which harness this folder belongs to. */
  readonly harness: string;
  /** Every transcript file of this harness's folder. Never throws. */
  list(): Promise<ListTranscriptsResult>;
}
