/**
 * One attempt to deliver the start context, successful or not. Written by
 * `context.show`, immutable, and the basis of the doctor's
 * "attempts per session" line (AD-17).
 */
export interface ContextInjection {
  /** UUIDv7 minted by whoever creates the row (AD-8). */
  id: string;
  sessionId: string;
  attemptedAt: Date;
  ok: boolean;
  /** The code that explains a failed or degraded attempt (AD-17, Conventions). */
  code: string | null;
  /** Size of what was delivered, measured in characters, never tokens (AD-17). */
  chars: number;
}
