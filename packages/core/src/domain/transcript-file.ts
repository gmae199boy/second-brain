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
