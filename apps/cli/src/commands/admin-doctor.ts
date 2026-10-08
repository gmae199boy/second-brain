import { createBrain, postgresStore, type DoctorCheck } from 'second_brain';
import { readConfig } from '../config.js';
import { errorEnvelope, okEnvelope } from '../envelope.js';

/**
 * Codes that also belong in `warnings[]` when a check carries them. Story 4
 * owns the full set from the Conventions table.
 */
const WARNING_CODES = new Set(['DB_UNAVAILABLE']);

/**
 * Core keeps the vector capability under a neutral name; only this output layer
 * and the adapter know it is pgvector here.
 */
const CHECK_IDS: Record<string, string> = { vector: 'pgvector' };

export interface AdminDoctorOptions {
  json: boolean;
}

/** Assemble, run, print, close, and hand back the exit code. */
export async function adminDoctor(options: AdminDoctorOptions): Promise<number> {
  const config = readConfig();
  if (!config.ok) {
    const envelope = errorEnvelope(config.code, config.message);
    if (options.json) {
      process.stdout.write(`${JSON.stringify(envelope)}\n`);
    } else {
      process.stderr.write(`${config.code}: ${config.message}\n`);
    }
    return 2;
  }

  const store = postgresStore({
    databaseUrl: config.databaseUrl,
    // Leave room for process startup inside the five seconds doctor is allowed.
    connectTimeoutMs: 4000,
  });
  const brain = createBrain({ store });
  try {
    const report = await brain.admin.doctor();
    const checks = report.checks.map((check) => ({
      ...check,
      id: CHECK_IDS[check.id] ?? check.id,
    }));
    const warnings = checks.flatMap((check) =>
      check.code !== undefined && WARNING_CODES.has(check.code) ? [check.code] : [],
    );

    if (options.json) {
      process.stdout.write(`${JSON.stringify(okEnvelope({ checks }, warnings))}\n`);
    } else {
      for (const check of checks) {
        process.stdout.write(`${formatCheck(check)}\n`);
      }
      for (const warning of warnings) {
        process.stdout.write(`warning: ${warning}\n`);
      }
    }

    return checks.some((check) => check.status === 'fail') ? 1 : 0;
  } finally {
    await brain.close();
  }
}

function formatCheck(check: DoctorCheck): string {
  const parts = [`${check.id}: ${check.status}`];
  if (check.code !== undefined) parts.push(`[${check.code}]`);
  if (check.detail !== undefined && check.detail !== '') parts.push(check.detail);
  return parts.join(' ');
}
