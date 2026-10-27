/** A schedule becomes queue work atomically with advancing its next instant. */
export interface Schedule {
  id: string;
  kind: string;
  targetKind: string;
  targetId: string;
  intervalSeconds: number | null;
  /** Null means a completed one-shot schedule. */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
}
