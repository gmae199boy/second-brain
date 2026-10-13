import { isWarningCode, type DoctorCheck, type WarningCode } from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

/**
 * Core keeps the vector capability under a neutral name; only this output layer
 * and the adapter know it is pgvector here.
 */
const CHECK_IDS: Record<string, string> = { vector: 'pgvector' };

export interface AdminDoctorData {
  checks: DoctorCheck[];
}

/**
 * `brain admin doctor`. A read, so no write guard applies. It translates the
 * report and nothing more (AD-5); which checks exist is Core's business, and
 * story 8 adds the rest of them there.
 */
export const adminDoctor: CommandSpec<AdminDoctorData> = {
  ns: 'admin',
  verb: 'doctor',
  nsDescription: 'administrative commands',
  description: 'check that the brain is reachable and healthy',

  async run(context) {
    const report = await context.brain.admin.doctor();
    const checks = report.checks.map((check) => ({
      ...check,
      id: CHECK_IDS[check.id] ?? check.id,
    }));

    // A failing check that carries one of the shared codes is also a warning:
    // the command ran, and the result is degraded (Conventions, NFR-2).
    const warnings = checks.flatMap((check): WarningCode[] =>
      check.code !== undefined && isWarningCode(check.code) ? [check.code] : [],
    );

    return {
      ok: true,
      data: { checks },
      warnings,
      text: checks.map(formatCheck),
      failed: checks.some((check) => check.status === 'fail'),
    };
  },
};

function formatCheck(check: DoctorCheck): string {
  const parts = [`${check.id}: ${check.status}`];
  if (check.code !== undefined) parts.push(`[${check.code}]`);
  if (check.detail !== undefined && check.detail !== '') parts.push(check.detail);
  return parts.join(' ');
}
