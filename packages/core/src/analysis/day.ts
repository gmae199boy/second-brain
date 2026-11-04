import type { AnalysisSnapshot, AnalysisStore, ModelRunner, ModelUsage } from '../ports/analysis.js';
import type { FileStore } from '../ports/file-store.js';
import type { IdGen } from '../ports/id-gen.js';
import type { WorkStore } from '../ports/store.js';
import { encodeAnalysisExport } from './export.js';
import { isDailyAnalysisOutput } from './output-schema.js';

export async function enqueueDayAnalysis(deps: { store: AnalysisStore & Pick<WorkStore, 'addWork'>; idGen: IdGen; now: () => Date }, snapshot: AnalysisSnapshot) {
  const created = await deps.store.createAnalysisSnapshot(snapshot);
  if (!created.ok) return created;
  const now = deps.now();
  return deps.store.addWork({ id: deps.idGen.next(), kind: 'health_analysis', targetKind: 'analysis_snapshot', targetId: snapshot.id, createdAt: now, nextAttemptAt: now });
}
export async function runDayAnalysis(deps: { store: AnalysisStore; files: FileStore; runner: ModelRunner; idGen: IdGen; now: () => Date; writeExport: (text: string) => Promise<void>; decodeSnapshot: (bytes: Uint8Array) => unknown; encodeReport: (text: string) => Uint8Array; cwd: string; schemaPath: string; outputPath: string; snapshotId: string; workId: string; attemptToken: string }): Promise<{ ok: true; id: string; usage: ModelUsage | null } | { ok: false; code: string; retryable: boolean }> {
  const found = await deps.store.findCoreAnalysis(deps.snapshotId, 'day', 1);
  if (!found.ok) return { ok: false, code: found.code, retryable: true };
  if (found.analysis) return { ok: true, id: found.analysis.id, usage: null };
  const read = await deps.store.readAnalysisSnapshot(deps.snapshotId);
  if (!read.ok) return { ok: false, code: read.code, retryable: true };
  if (!read.snapshot) return { ok: false, code: 'ANALYSIS_SNAPSHOT_MISSING', retryable: false };
  await deps.writeExport(encodeAnalysisExport(deps.decodeSnapshot(read.snapshot.content)));
  const model = await deps.runner.run({ cwd: deps.cwd, prompt: '$garmin-daily-analysis\n\n입력 폴더(운영 루트 기준 경로):\nexport.json', schemaPath: deps.schemaPath, outputPath: deps.outputPath, effort: 'high', model: null, timeoutMs: 1_200_000 });
  if (!model.ok) return { ok: false, code: model.code, retryable: true };
  let output: unknown;
  try { output = JSON.parse(model.output); } catch { return { ok: false, code: 'ANALYSIS_OUTPUT_INVALID', retryable: false }; }
  if (!isDailyAnalysisOutput(output) || output.status !== 'ok') return { ok: false, code: 'ANALYSIS_OUTPUT_INVALID', retryable: false };
  const file = await deps.files.put(deps.encodeReport(output.report_md));
  if (!file.ok) return { ok: false, code: file.code, retryable: true };
  const committed = await deps.store.commitCoreAnalysis({ id: deps.idGen.next(), fileId: deps.idGen.next(), locationId: deps.idGen.next(), snapshot: read.snapshot, output, agent: 'codex', workId: deps.workId, attemptToken: deps.attemptToken, now: deps.now(), contentHash: file.contentHash, sizeBytes: file.sizeBytes, location: file.location });
  return committed.ok ? { ok: true, id: committed.id, usage: model.usage } : { ok: false, code: committed.code, retryable: true };
}
