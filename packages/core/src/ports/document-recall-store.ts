import type { DocumentExtractionStatus } from '../domain/document.js';

export interface DocumentRow {
  kind: 'document'; file_id: string; display_name: string; chunk_locator: string;
  extraction_id: string; report_date: string | null; source: string;
  source_unreachable: boolean; body: string;
}
export interface DocumentSearchRow extends DocumentRow { ordinal: number }
export interface DocumentSearchContext { extraction_id: string; pieces: DocumentPiece[] }
export interface DocumentPiece { ordinal: number; chunk_locator: string; body: string }
export interface DocumentSnapshot {
  redacted: boolean; source_unreachable: boolean; extraction_id: string | null;
  status: DocumentExtractionStatus | 'pending' | null; pieces: DocumentPiece[];
}
export type DocumentStoreError = { ok: false; code: 'DB_UNAVAILABLE' | 'SEARCH_FAILED'; message: string };
export interface DocumentRecallStore {
  searchDocuments(input: { query: string; pattern: string; limit: number }): Promise<{ ok: true; rows: DocumentSearchRow[]; contexts: DocumentSearchContext[] } | DocumentStoreError>;
  readDocument(fileId: string): Promise<{ ok: true; snapshot: DocumentSnapshot | null } | DocumentStoreError>;
}
