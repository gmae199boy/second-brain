import { checkSchema } from '../schema.js';
import type { HealthStore, SchemaStore, StoreProbe } from '../ports/store.js';

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
 * One check somebody outside Core registered.
 *
 * Which checks exist is Core's business (AD-5), but Core knows nothing about
 * machines: it has no filesystem, no environment and no child processes. So
 * everything a store can answer — the schema version today, spool depth later —
 * is Core's own, and every machine fact — the shim, the node that runs it, the
 * configuration file — is handed in as one of these by the runtime that does
 * have a filesystem. The list is the seam, so adding a check never changes the
 * shape of anything.
 */
export interface DoctorCheckSource {
  /** The id this source answers under, used when `run` throws. */
  id: string;
  /** Never throws, by contract — and a source that does is still only a `fail`. */
  run(): Promise<DoctorCheck>;
}

export interface DoctorOptions {
  /** Schema version this build was made for, for the `schema-version` check. */
  schemaVersion: number;
  /** Checks the runtime registered, run in order after the store's own. */
  checks?: readonly DoctorCheckSource[];
}

/**
 * Report on the brain without throwing. A degraded brain yields failing checks,
 * not an exception: the caller decides the exit code. One check that fails, or
 * that throws, never stops the ones after it — a report that stopped at the
 * first problem would hide every other one.
 *
 * The order is store first, then machine: `db`, the adapter's own probes, the
 * schema version, and then whatever the runtime registered.
 *
 * A store that could not be reached reports the `db` check and no probe and no
 * schema version. It ran no probes, so there is nothing else to say about it,
 * and inventing a row for each capability the adapter might have had would
 * claim knowledge Core does not have — it never learns which capabilities a
 * source offers (AD-10). The registered checks still run: the shim and the node
 * behind it are facts about the machine, and an unreachable database is often
 * exactly when a person needs to know them.
 */
export async function runDoctor(
  store: HealthStore & SchemaStore,
  options: DoctorOptions,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];

  const health = await store.checkHealth();
  if (!health.ok) {
    checks.push({ id: 'db', status: 'fail', code: health.code, detail: health.message });
  } else {
    checks.push({ id: 'db', status: 'ok', detail: health.serverVersion });
    checks.push(...health.source.probes.map(probeCheck));
    checks.push(await schemaCheck(store, options.schemaVersion));
  }

  for (const source of options.checks ?? []) {
    checks.push(await registered(source));
  }

  return { checks };
}

/** One probe as one check. Core passes the adapter's own name through. */
function probeCheck(probe: StoreProbe): DoctorCheck {
  const check: DoctorCheck = { id: probe.id, status: probe.ok ? 'ok' : 'fail' };
  if (probe.detail !== undefined && probe.detail !== '') {
    check.detail = probe.detail;
  }
  return check;
}

/**
 * The stored schema version against the one this build was made for, through
 * the same `checkSchema` the write guard uses (AD-20), so doctor and the guard
 * can never disagree about what counts as a mismatch. A mismatch carries
 * `SCHEMA_MISMATCH`, which is a shared warning code, so the CLI puts it in
 * `warnings[]` as well.
 */
async function schemaCheck(store: SchemaStore, expected: number): Promise<DoctorCheck> {
  const schema = await checkSchema(store, expected);
  if (schema.ok) {
    return { id: 'schema-version', status: 'ok', detail: String(schema.version) };
  }
  return { id: 'schema-version', status: 'fail', code: schema.code, detail: schema.message };
}

/**
 * One registered check. A source that throws is a failed check and nothing
 * more: doctor is the command a person runs when things are already wrong, so
 * it is the last place that may crash.
 */
async function registered(source: DoctorCheckSource): Promise<DoctorCheck> {
  try {
    return await source.run();
  } catch (error) {
    return { id: source.id, status: 'fail', detail: oneLine(error) };
  }
}

/** The first line of whatever went wrong, so a detail stays one line. */
function oneLine(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split('\n')[0]?.trim() ?? 'unknown error';
}
