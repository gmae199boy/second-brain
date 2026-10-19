import type { ParserCursor } from './session.js';

/**
 * A transcript file drain found while scanning a harness folder. Size,
 * fingerprint and cursor only ever move forward (Table Contract).
 */
export interface TranscriptFile {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `path`. */
  harness: string;
  path: string;
  sizeBytes: number;
  /** Fingerprint of the file as last seen. */
  fingerprint: string;
  /** How far this file has been read (AD-4). */
  cursor: ParserCursor | null;
  scannedAt: Date;
}

/**
 * How long a harness keeps a transcript before it is gone for good.
 *
 * Claude Code deletes transcripts after thirty days, which makes it a deadline
 * and not a preference: a session nobody has collected by then is a session that
 * can never be collected. It is a Core constant because the one thing that
 * depends on it is a doctor check, and a number spelled in a check is a number
 * nobody can hold a test against.
 */
export const TRANSCRIPT_RETENTION_DAYS = 30;

/**
 * How long before that deadline doctor starts saying so.
 *
 * Five days: long enough that a person who reads the report once a week still
 * has time to run a drain, and short enough that the line is not permanently on
 * screen for a brain that is simply not configured to scan yet.
 */
export const TRANSCRIPT_DEADLINE_WARN_DAYS = 5;
