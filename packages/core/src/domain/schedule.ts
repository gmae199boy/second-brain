/** Persisted schedule and its trigger. */
export interface Schedule {
  id: string; kind: string; holdGroup: string | null; targetKind: string; targetId: string;
  triggerKind: 'cron' | 'once' | 'interval'; cronExpr: string | null; runAt: Date | null;
  timeZone: string | null; timeZoneSource: 'user' | 'fixed' | null; intervalSeconds: number | null;
  extension: string | null; scheduleKey: string | null; userId: string;
  enabled: boolean; removedAt: Date | null;
  triggerUpdatedAt: Date | null;
  nextRunAt: Date | null; lastRunAt: Date | null; createdAt: Date;
}
export interface ScheduleOccurrence {
  scheduleId: string; occurrenceAt: Date; timeZone: string | null; status: 'pending' | 'claimed' | 'done' | 'skipped' | 'failed';
  workId: string | null; userId: string; recordedAt: Date;
}
