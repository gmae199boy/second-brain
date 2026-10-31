import type { FileLocation } from '../domain/file.js';
type Failure = { ok: false; code: string; message: string };
export interface ImportRequest { id: string; source: string; locator: string; sha256: string; sizeBytes: number; mediaType: string }
export interface AnalysisArtifact {
  file_request_id: string;
  role: string;
  file_id: string | null;
  error_code: string | null;
}
export interface AnalysisRecord extends Record<string, unknown> {
  artifacts: AnalysisArtifact[];
}
export interface VerificationFile {
  requestId: string; fileId: string | null; expectedHash: string; expectedSize: number; storedHash: string | null; storedSize: number | null; failed: boolean; redacted: boolean; deleted: boolean;
  location: FileLocation | null;
}
export interface ImportVerificationData {
  tables: Record<string, Record<string, unknown>[]>;
  files: VerificationFile[];
}
export interface ImportStore {
  readVerification(input: { source: string; workId: string; token: string; now: Date; rawViews: readonly string[] }): Promise<{ ok: true; data: ImportVerificationData } | Failure>;
  readHealth(): Promise<{ ok: true; rows: Record<string, unknown>[] } | Failure>;
  readAnalyses(): Promise<{ ok: true; rows: AnalysisRecord[] } | Failure>;
  readRaw(input: { source: string; rawViews: readonly string[] }): Promise<{ ok: true; extensionEnabled: boolean; rows: Record<string, unknown>[] } | Failure>;
  listUnhandedImports(): Promise<{ ok: true; ids: string[] } | Failure>;
  listImportCleanups(): Promise<{ ok: true; ids: string[] } | Failure>;
  cleanupImport(input: { requestId: string; now: Date; remove: (source: string, locator: string) => Promise<void> }): Promise<{ ok: true; cleaned: boolean } | Failure>;
  handoffImport(input: { requestId: string; workId: string; now: Date }): Promise<{ ok: true; created: boolean } | Failure>;
  readImport(id: string): Promise<{ ok: true; request: ImportRequest | null; completed: boolean } | Failure>;
  finishImport(input: { requestId: string; workId: string; claimedBy: string; claimedAt: Date; claimAttempt: number; fileId: string; locationId: string; hash: string; size: number; location: FileLocation; now: Date; cleanupDone: boolean }): Promise<{ ok: true; redacted: boolean } | Failure>;
  failImport(input: { requestId: string; workId: string; claimedBy: string; claimedAt: Date; claimAttempt: number; code: string; now: Date }): Promise<{ ok: true } | Failure>;
}
export interface ImportStaging { read(source: string, locator: string, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | Failure>; remove(source: string, locator: string): Promise<void> }
