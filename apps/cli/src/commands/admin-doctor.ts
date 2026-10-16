import {
  isWarningCode,
  type DoctorCheck,
  type DoctorSummary,
  type WarningCode,
} from 'second_brain';
import type { CommandSpec } from '../dispatch.js';

export interface AdminDoctorData {
  checks: DoctorCheck[];
  /**
   * The counts, from Core's report rather than counted again here: a reader
   * that had to add up ten lines to find out whether anything failed is a
   * reader that will miss the one `warn` among them.
   */
  summary: DoctorSummary;
}

/**
 * `brain admin doctor`. A read, so no write guard applies. It translates the
 * report and nothing more (AD-5): which checks exist is Core's business, and
 * which machine facts are checked is `doctor/checks.ts`'s — the dispatcher
 * hands that list to `createBrain`, so nothing about it is decided here.
 *
 * `diagnostic`, because this is the command a person runs when the install is
 * already broken: a missing or unreadable `config.toml` is a failing `config`
 * check and an exit 1, not the exit 2 every other command gets (Decision
 * 2026-10-14).
 */
export const adminDoctor: CommandSpec<AdminDoctorData> = {
  ns: 'admin',
  verb: 'doctor',
  nsDescription: 'administrative commands',
  description: 'check that the brain is reachable and healthy',
  diagnostic: true,

  async run(context) {
    const report = await context.brain.admin.doctor();
    // The adapter's own names, passed through: a second spelling here would be
    // a second thing as far as anyone reading a report is concerned.
    const checks = report.checks;

    // A failing check that carries one of the shared codes is also a warning:
    // the command ran, and the result is degraded (Conventions, NFR-2).
    const warnings = checks.flatMap((check): WarningCode[] =>
      check.code !== undefined && isWarningCode(check.code) ? [check.code] : [],
    );

    return {
      ok: true,
      data: { checks, summary: report.summary },
      warnings,
      // The summary last, so the line that says whether to read the rest is
      // the one still on screen.
      text: [...checks.map(formatCheck), formatSummary(report.summary)],
      // Only `fail` (Conventions): a `warn` is a check that ran and settled
      // nothing, which is worth printing and not worth failing a hook over.
      failed: checks.some((check) => check.status === 'fail'),
    };
  },
};

/** One check as a line. Shared with the installer, for the same reason. */
export function formatCheck(check: DoctorCheck): string {
  const parts = [`${check.id}: ${check.status}`];
  if (check.code !== undefined) parts.push(`[${check.code}]`);
  if (check.detail !== undefined && check.detail !== '') parts.push(check.detail);
  return parts.join(' ');
}

/** The counts as the report's last line, in the Conventions' order. */
function formatSummary(summary: DoctorSummary): string {
  return (
    `summary: ${String(summary.passed)} passed, ${String(summary.warned)} warned, ` +
    `${String(summary.failed)} failed, ${String(summary.skipped)} skipped`
  );
}
