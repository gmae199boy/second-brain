import type { WorkHandler } from './drain.js';

/** Verify tick → drain in an installed brain (9.8), without side effects. */
export const SCHEDULE_PROBE_KIND = 'schedule_probe';
export const scheduleProbeHandler: WorkHandler = async () => ({ ok: true });
