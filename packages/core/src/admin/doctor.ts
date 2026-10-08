import type { Store } from '../ports/store.js';

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
 */
export async function runDoctor(store: Store): Promise<DoctorReport> {
  const health = await store.checkHealth();

  if (!health.ok) {
    return {
      checks: [
        { id: 'db', status: 'fail', code: health.code, detail: health.message },
        { id: 'vector', status: 'skip' },
      ],
    };
  }

  return {
    checks: [
      { id: 'db', status: 'ok', detail: health.serverVersion },
      vectorCheck(health.vector),
    ],
  };
}

function vectorCheck(vector: { available: string | null; installed: string | null }): DoctorCheck {
  if (vector.installed !== null) {
    return { id: 'vector', status: 'ok', detail: vector.installed };
  }
  return {
    id: 'vector',
    status: 'fail',
    detail:
      vector.available !== null
        ? `not installed (available: ${vector.available})`
        : 'not installed (not available on this server)',
  };
}
