import { binaryCompare } from './compare.js';
export type AnalysisScope = 'day' | '7d' | '30d' | 'all';
export interface InputAnalysisRecord {
  id: string; reportDate: string; scope: AnalysisScope; source: 'core' | 'legacy'; revision: number; createdAt: string;
  reportLocation?: import('../../domain/file.js').FileLocation | null;
  summary: unknown; judgments: unknown; evidence: unknown; nextChecks: unknown; reportFileId?: string | null; reportMd?: string | null;
}
export interface Evaluation { report_date: string; scope: AnalysisScope; summary: unknown; judgments: unknown; evidence: unknown; next_checks: unknown }
function compareInstants(a: string, b: string): number {
  const left = Date.parse(a), right = Date.parse(b);
  return Number.isFinite(left) && Number.isFinite(right) ? left - right : binaryCompare(a,b);
}
function selectUnique(records: readonly InputAnalysisRecord[]): InputAnalysisRecord[] {
  const ordered = [...records].sort((a, b) => Number(b.source === 'core') - Number(a.source === 'core') || b.revision - a.revision || compareInstants(b.createdAt,a.createdAt) || binaryCompare(a.id,b.id));
  const selected = new Map<string, InputAnalysisRecord>();
  for (const row of ordered) { const key = `${row.reportDate}:${row.scope}`; if (!selected.has(key)) selected.set(key, row); }
  return [...selected.values()];
}
export function evaluation(record: InputAnalysisRecord): Evaluation {
  return { report_date: record.reportDate, scope: record.scope, summary: record.summary, judgments: record.judgments, evidence: record.evidence, next_checks: record.nextChecks };
}
export function selectPredecessors(records: readonly InputAnalysisRecord[], scope: AnalysisScope, start: string, end: string): { evaluations: InputAnalysisRecord[]; previous: InputAnalysisRecord | null } {
  const rows = selectUnique(records);
  const previous = rows.filter(r => r.scope === scope && r.reportDate < end).sort((a, b) => binaryCompare(b.reportDate,a.reportDate))[0] ?? null;
  let evaluations: InputAnalysisRecord[] = [];
  if (scope === '7d') evaluations = rows.filter(r => r.scope === 'day' && r.reportDate >= start && r.reportDate <= end).sort((a, b) => binaryCompare(a.reportDate,b.reportDate));
  if (scope === '30d') evaluations = rows.filter(r => r.scope === '7d' && r.reportDate <= end).sort((a, b) => binaryCompare(b.reportDate,a.reportDate)).slice(0, 5);
  if (scope === 'all') {
    const months = new Map<string, InputAnalysisRecord>();
    for (const row of rows.filter(r => r.scope === '30d' && r.reportDate <= end).sort((a, b) => binaryCompare(a.reportDate,b.reportDate))) months.set(row.reportDate.slice(0, 7), row);
    evaluations = [...months.values()];
  }
  return { evaluations, previous };
}
export function selectDayPrevious(records: readonly InputAnalysisRecord[], yesterday: string, scope: 'day' | '7d'): InputAnalysisRecord | null {
  return selectUnique(records).find(r => r.reportDate === yesterday && r.scope === scope) ?? null;
}
