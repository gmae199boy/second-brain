/**
 * A failure anybody can write through the one failure-recording function. The
 * session key is always known; the Brain-side `sessionId` may not be (AD-12).
 */
export interface Failure {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  /** Key together with `harnessSessionId`, `stage` and `fingerprint`. */
  harness: string;
  harnessSessionId: string;
  /** Which step failed, e.g. the ingest stage that threw. */
  stage: string;
  /** Distinguishes two different failures of the same stage. */
  fingerprint: string;
  sessionId: string | null;
  /** Coded, so a retry can decide what to do (Conventions). */
  code: string;
  message: string;
  occurredAt: Date;
  /** Filled by drain once the work went through (Table Contract). */
  resolvedAt: Date | null;
}
