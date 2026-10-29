/** A schedule becomes queue work atomically with advancing its next instant. */
export interface Schedule {
  id: string;
  kind: string;
  targetKind: string;
  targetId: string;
  /** Daily wall time and the zone used to calculate the next instant. */
  localTime: string | null;
  timeZone: string | null;
  intervalSeconds: number | null;
  /** Null means a completed one-shot schedule. */
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  createdAt: Date;
}
