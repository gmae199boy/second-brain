import type { FileLocation } from '../domain/file.js';
import type { DailyAnalysisOutput } from '../analysis/output-schema.js';
export interface AnalysisSnapshot { id: string; bundleId: string; localDate: string; timeZone: string; content: Uint8Array; contentSha256: string; createdAt: Date }
export interface CoreAnalysis { id: string; snapshotId: string; bundleId: string; reportDate: string; scope: 'day'; revision: number; agent: string; output: DailyAnalysisOutput; fileId: string }
type Failure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export interface AnalysisStore {
  createAnalysisSnapshot(snapshot: AnalysisSnapshot): Promise<{ ok: true } | Failure>;
  readAnalysisSnapshot(id: string): Promise<{ ok: true; snapshot: AnalysisSnapshot | null } | Failure>;
  findCoreAnalysis(snapshotId: string, scope: 'day', revision: number): Promise<{ ok: true; analysis: CoreAnalysis | null } | Failure>;
  readCoreAnalysis(id: string): Promise<{ ok: true; analysis: CoreAnalysis | null } | Failure>;
  commitCoreAnalysis(input: { id: string; fileId: string; locationId: string; snapshot: AnalysisSnapshot; output: DailyAnalysisOutput; agent: string; workId: string; attemptToken: string; now: Date; contentHash: string; sizeBytes: number; location: FileLocation }): Promise<{ ok: true; id: string } | Failure>;
}
export interface ModelUsage { inputTokens: number; cachedInputTokens: number; outputTokens: number }
export interface ModelRunner {
  run(input: { cwd: string; prompt: string; schemaPath: string; outputPath: string; effort: 'high'; model: string | null; timeoutMs: number }): Promise<{ ok: true; output: string; usage: ModelUsage | null } | { ok: false; code: 'ANALYSIS_MODEL_FAILED' }>;
}
