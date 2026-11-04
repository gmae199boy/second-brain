import { describe, expect, it } from 'vitest';
import { isDailyAnalysisOutput } from '../src/analysis/output-schema.js';

describe('daily analysis v1 output', () => {
  const valid = { status: 'ok', summary: '', report_md: '# Report', judgments: [], evidence: ['synthetic'], next_checks: [] };
  it('accepts the complete v1 shape', () => { expect(isDailyAnalysisOutput(valid)).toBe(true); });
  it('accepts valid surrogate pairs and rejects malformed output strings in every field', () => {
    expect(isDailyAnalysisOutput({ ...valid, summary: '좋음 😀' })).toBe(true);
    for (const value of [{ ...valid, summary: '\u0000' }, { ...valid, judgments: ['\ud800'] }, { ...valid, evidence: ['\udc00'] }, { ...valid, next_checks: ['\u0000'] }]) expect(isDailyAnalysisOutput(value)).toBe(false);
  });
  it('rejects missing, extra, invalid enum, and invalid array values', () => {
    const { summary: _summary, ...missing } = valid;
    for (const value of [missing, { ...valid, extra: true }, { ...valid, status: 'other' }, { ...valid, evidence: [1] }, null]) {
      expect(isDailyAnalysisOutput(value)).toBe(false);
    }
  });
});

import { runDayAnalysis } from '../src/analysis/day.js';
import type { AnalysisStore, ModelRunner } from '../src/ports/analysis.js';
import type { FileStore } from '../src/ports/file-store.js';

it('commits valid output, rejects invalid output and skips existing analysis', async () => {
  const snapshot = { id: 'snapshot', bundleId: 'bundle', localDate: '2026-01-02', timeZone: 'UTC', content: new Uint8Array(), contentSha256: 'a'.repeat(64), createdAt: new Date() };
  let existing = false, commits = 0, puts = 0, runs = 0, exported = '', response = JSON.stringify({ status: 'ok', summary: 's', report_md: 'report', judgments: [], evidence: [], next_checks: [] });
  const store: AnalysisStore = {
    async createAnalysisSnapshot() { return { ok: true }; },
    async readAnalysisSnapshot() { return { ok: true, snapshot }; },
    async findCoreAnalysis() { return { ok: true, analysis: existing ? { id: 'existing', snapshotId: 'snapshot', bundleId: 'bundle', reportDate: '2026-01-02', scope: 'day', revision: 1, agent: 'codex', output: JSON.parse(response), fileId: 'file' } : null }; },
    async readCoreAnalysis() { return { ok: true, analysis: null }; },
    async commitCoreAnalysis(input) { commits++; expect(input.output.report_md).toBe('report'); return { ok: true, id: input.id }; },
  };
  const runner: ModelRunner = { async run() { runs++; return { ok: true, output: response, usage: null }; } };
  const files = { async put() { puts++; return { ok: true, contentHash: 'hash', sizeBytes: 6, location: { storeKind: 'local', ownership: 'brain', locator: 'a' } }; } } as unknown as FileStore;
  const deps = { store, runner, files, idGen: { next: () => 'id' }, now: () => new Date(), writeExport: async (s: string) => { exported = s; }, decodeSnapshot: () => ({ note: 'password: synthetic-secret-123456' }), encodeReport: () => new Uint8Array(), cwd: 'scratch', schemaPath: 'schema', outputPath: 'output', snapshotId: 'snapshot', workId: 'work', attemptToken: 'token' };
  expect(await runDayAnalysis(deps)).toMatchObject({ ok: true }); expect(commits).toBe(1); expect(exported).not.toContain('synthetic-secret-123456');
  store.readAnalysisSnapshot = async () => ({ ok: true, snapshot: null });
  expect(await runDayAnalysis(deps)).toMatchObject({ ok: false, code: 'ANALYSIS_SNAPSHOT_MISSING', retryable: false });
  store.readAnalysisSnapshot = async () => ({ ok: true, snapshot });
  response = '{}'; expect(await runDayAnalysis(deps)).toMatchObject({ ok: false, code: 'ANALYSIS_OUTPUT_INVALID', retryable: false }); expect(commits).toBe(1);
  for (const invalid of ['bad\u0000text', 'bad\ud800text', 'bad\udc00text']) {
    response = JSON.stringify({ status: 'ok', summary: '', report_md: invalid, judgments: [], evidence: [], next_checks: [] });
    expect(await runDayAnalysis(deps)).toMatchObject({ ok: false, code: 'ANALYSIS_OUTPUT_INVALID', retryable: false });
    expect(commits).toBe(1); expect(puts).toBe(1);
  }
  response = JSON.stringify({ status: 'failed', summary: '', report_md: 'report', judgments: [], evidence: [], next_checks: [] });
  expect(await runDayAnalysis(deps)).toMatchObject({ ok: false, code: 'ANALYSIS_OUTPUT_INVALID', retryable: false }); expect(commits).toBe(1); expect(puts).toBe(1);
  response = JSON.stringify({ status: 'ok', summary: '', report_md: 'report', judgments: [], evidence: [], next_checks: [] }); existing = true;
  expect(await runDayAnalysis(deps)).toMatchObject({ ok: true, id: 'existing' }); expect(runs).toBe(6);
});

import { encodeAnalysisExport } from '../src/analysis/export.js';
import { TOOL_NOTE_TARGET_LIMIT } from '../src/output/mask.js';
it('masks tool-note shell values and truncated targets in the actual export', () => {
  const rendered = encodeAnalysisExport({ nested: { toolNotes: [
    { tool: 'Bash', target: 'MY_CREDENTIAL=abc123 node run.js' },
    { tool: 'Bash', target: 'x'.repeat(TOOL_NOTE_TARGET_LIMIT - 8) + ' sk-AAAA' },
  ] } });
  expect(rendered).not.toContain('abc123');
  expect(rendered).toContain('MY_CREDENTIAL');
  expect(rendered).not.toContain('sk-AAAA');
  expect(rendered).toContain('[REDACTED:truncated]');
});

it('masks valid tool notes alongside malformed entries', () => {
  const output = encodeAnalysisExport({ toolNotes: [{ target: 'MY_CREDENTIAL=abc123 node run.js' }, null] });
  expect(output).not.toContain('abc123'); expect(output).toContain('MY_CREDENTIAL');
});
