export const CASE_SHARD_FILES = [{ file: 'apps/cli/python-test/garmin-report.test.ts', reason: 'Each case owns its extHome, server and database and cleans up in finally; no shared mutable fixture, ordering dependency, or conditional skip.' }];
export type CaseStatus = 'passed' | 'failed' | 'skipped';
export interface CaseName { fullName: string; filterName: string }
type Assertion = CaseName & { status: string };
export function shardModeForSource(source: string): { shardMode: 'case' | 'file'; reason: string } {
  return /\.\s*(?:skip|skipIf|runIf|todo|only|fails)\b/.test(source) ? { shardMode: 'file', reason: 'forbidden-modifier-text' } : { shardMode: 'case', reason: 'allowlisted' };
}
function assertions(value: unknown): Assertion[] {
  const suites = (value as { testResults?: unknown })?.testResults;
  if (!Array.isArray(suites)) throw new Error('invalid case report');
  const rows: Assertion[] = [];
  for (const suite of suites) {
    if (!Array.isArray(suite?.assertionResults)) throw new Error('invalid case report');
    for (const row of suite.assertionResults) {
      if (typeof row?.fullName !== 'string' || !row.fullName.trim() || typeof row.status !== 'string' || !Array.isArray(row.ancestorTitles) || row.ancestorTitles.some((title: unknown) => typeof title !== 'string') || typeof row.title !== 'string' || !row.title.trim()) throw new Error('invalid case name or status');
      rows.push({ fullName: row.fullName, filterName: [...row.ancestorTitles, row.title].join(' > '), status: row.status });
    }
  }
  if (!rows.length || new Set(rows.map(row => row.fullName)).size !== rows.length || new Set(rows.map(row => row.filterName)).size !== rows.length) throw new Error('empty or duplicate case names');
  return rows;
}
export function parseCollectedCases(value: unknown): CaseName[] {
  const rows = assertions(value);
  if (rows.some(row => row.status !== 'skipped')) throw new Error('collection executed a case');
  return rows.map(({ fullName, filterName }) => ({ fullName, filterName }));
}
export function casePattern(name: string): string { return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`; }
export function validateShardResult(value: unknown, selected: CaseName, expected: CaseName[]): CaseStatus {
  const rows = assertions(value);
  if (rows.length !== expected.length || expected.some(name => !rows.some(row => row.fullName === name.fullName && row.filterName === name.filterName))) throw new Error('case report does not match collection');
  const pattern = new RegExp(casePattern(selected.filterName));
  if (expected.filter(name => pattern.test(name.filterName)).length !== 1 || !expected.some(name => name.fullName === selected.fullName && name.filterName === selected.filterName)) throw new Error('invalid case pattern');
  const matches = rows.filter(row => row.fullName === selected.fullName && row.filterName === selected.filterName);
  if (matches.length !== 1 || rows.some(row => row.fullName !== selected.fullName && row.status !== 'skipped')) throw new Error('invalid shard selection');
  const status = matches[0]!.status;
  if (status === 'passed' || status === 'failed') return status;
  throw new Error('selected case did not run');
}
export function aggregateShardCases(statuses: CaseStatus[], expected: number): { pass: number; fail: number; skip: number } {
  if (statuses.length !== expected || expected < 1) throw new Error('case count mismatch');
  return { pass: statuses.filter(s => s === 'passed').length, fail: statuses.filter(s => s === 'failed').length, skip: statuses.filter(s => s === 'skipped').length };
}
