/** The immutable daily analysis v1 output contract. */
export interface DailyAnalysisOutput {
  status: 'ok' | 'failed';
  summary: string;
  report_md: string;
  judgments: string[];
  evidence: string[];
  next_checks: string[];
}

function validString(value: unknown): value is string {
  return typeof value === 'string' && !value.includes('\u0000') && value.isWellFormed();
}

export function isDailyAnalysisOutput(value: unknown): value is DailyAnalysisOutput {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  const keys = ['status', 'summary', 'report_md', 'judgments', 'evidence', 'next_checks'];
  if (Object.keys(row).length !== keys.length || !keys.every(key => Object.hasOwn(row, key))) return false;
  if (row.status !== 'ok' && row.status !== 'failed') return false;
  if (!validString(row.summary) || !validString(row.report_md)) return false;
  return [row.judgments, row.evidence, row.next_checks].every(
    field => Array.isArray(field) && field.every(validString),
  );
}
