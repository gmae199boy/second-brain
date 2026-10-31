import type { FileLocation } from '../domain/file.js';
type Failure = { ok: false; code: string; message: string };
export interface ImportRequest { id: string; source: string; locator: string; sha256: string; sizeBytes: number; mediaType: string }
export interface ImportStore {
  readHealth(): Promise<{ ok: true; rows: Record<string, unknown>[] } | Failure>;
  readAnalyses(): Promise<{ ok: true; rows: Record<string, unknown>[] } | Failure>;
  readRaw(input: { source: string; rawViews: readonly string[] }): Promise<{ ok: true; extensionEnabled: boolean; rows: Record<string, unknown>[] } | Failure>;
  listUnhandedImports(): Promise<{ ok: true; ids: string[] } | Failure>;
  handoffImport(input: { requestId: string; workId: string; now: Date }): Promise<{ ok: true; created: boolean } | Failure>;
  readImport(id: string): Promise<{ ok: true; request: ImportRequest | null; completed: boolean } | Failure>;
  finishImport(input: { requestId: string; workId: string; claimedBy: string; fileId: string; locationId: string; hash: string; size: number; location: FileLocation; now: Date; cleanupDone: boolean }): Promise<{ ok: true; redacted: boolean } | Failure>;
  failImport(input: { requestId: string; workId: string; claimedBy: string; code: string; now: Date }): Promise<{ ok: true } | Failure>;
}
export interface ImportStaging { read(source: string, locator: string, maxBytes: number): Promise<{ ok: true; bytes: Uint8Array } | Failure>; remove(source: string, locator: string): Promise<void> }
