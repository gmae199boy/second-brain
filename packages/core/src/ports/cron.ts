/** Runtime-owned calculator for five-field cron expressions and IANA zones. */
export interface CronCalculator {
  validate(expression: string, timeZone: string): { ok: true } | { ok: false; code: 'SCHEDULE_INVALID'; message: string };
  next(expression: string, timeZone: string, after: Date): Date | null;
}
