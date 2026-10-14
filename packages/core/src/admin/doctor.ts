import type { HealthStore, StoreProbe } from '../ports/store.js';

export type DoctorCheckStatus = 'ok' | 'fail' | 'skip';

export interface DoctorCheck {
  /** Stable, neutral identifier for the check. */
  id: string;
  status: DoctorCheckStatus;
  /** Human-readable extra information, when there is any. */
  detail?: string;
  /** Machine-readable code, set only for failures that carry one. */
  code?: string;
}

export interface DoctorReport {
  checks: DoctorCheck[];
}

/**
 * Report on the store without throwing. A degraded store yields failing checks,
 * not an exception: the caller decides the exit code.
 *
 * A store that could not be reached reports the `db` check alone. It ran no
 * probes, so there is nothing else to say about it, and inventing a row for
 * each capability the adapter might have had would claim knowledge Core does
 * not have — it never learns which capabilities a source offers (AD-10).
 * Story 8 reworks which checks exist.
 */
export async function runDoctor(store: HealthStore): Promise<DoctorReport> {
  const health = await store.checkHealth();

  if (!health.ok) {
    return {
      checks: [{ id: 'db', status: 'fail', code: health.code, detail: health.message }],
    };
  }

  return {
    checks: [
      { id: 'db', status: 'ok', detail: health.serverVersion },
      ...health.source.probes.map(probeCheck),
    ],
  };
}

/** One probe as one check. Core passes the adapter's own name through. */
function probeCheck(probe: StoreProbe): DoctorCheck {
  const check: DoctorCheck = { id: probe.id, status: probe.ok ? 'ok' : 'fail' };
  if (probe.detail !== undefined && probe.detail !== '') {
    check.detail = probe.detail;
  }
  return check;
}
