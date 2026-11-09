import type { DocumentExtractionStatus } from '../domain/document.js';
import type { SourceIndexStatus } from './source-store.js';
export interface DocumentRow {
  kind: 'document'; file_id: string | null; display_name: string; chunk_locator: string | null;
  extraction_id: string | null; report_date: string | null; source: string;
  source_unreachable: boolean; body: string;
  file_status?: DocumentExtractionStatus | 'pending'; names?: string[]; origins?: DocumentOrigin[]; source_file_id?: string; source_path?: string; source_url?: string; index_status?: SourceIndexStatus; current_version?: string; completed_version?: string | null; stale?: boolean; warning?: 'FILE_SOURCE_UNREACHABLE';
}
/** Public origins contain only resolved, masked references; the store never constructs URLs. */
export interface DocumentOrigin { kind: 'location' | 'drive'; display_name: string; source_unreachable: boolean; source_url?: string; source_file_id?: string; source_path?: string; index_status?: SourceIndexStatus; current_version?: string; completed_version?: string | null; stale?: boolean; warning?: 'FILE_SOURCE_UNREACHABLE' }
/** Internal references require validation and resolution before public output. */
export type DocumentSearchOrigin =
  | { kind: 'location'; location_id: string; store_kind: 'local' | 'drive'; locator: string; ownership: 'brain' | 'external'; display_name: string; source_unreachable: boolean }
  | { kind: 'drive'; source_file_id: string; source_remote_id: string; display_name: string; source_path: string; index_status: SourceIndexStatus; source_unreachable: boolean; current_version: string; completed_version: string | null; stale: boolean };
/** remote ID stays internal until validated and converted to a Drive URL. */
export interface DocumentSearchRow extends DocumentRow { ordinal: number | null; ordinals?: number[]; report_provenance?: boolean; source_remote_id?:string; internal_origins?: DocumentSearchOrigin[]; file_status?: DocumentExtractionStatus | 'pending' }
export interface DocumentSearchContext { extraction_id: string; pieces: DocumentPiece[] }
export interface DocumentPiece { ordinal: number; chunk_locator: string; body: string }
export interface DocumentSnapshot {
  redacted: boolean; source_unreachable: boolean; extraction_id: string | null;
  status: DocumentExtractionStatus | 'pending' | null; pieces: DocumentPiece[];
}
export interface SourceDocument {source_file_id:string;file_id:string|null;display_name:string;source_path:string;source_remote_id:string;source:string;index_status:SourceIndexStatus;source_unreachable:boolean;current_version:string;completed_version:string|null;stale:boolean}
export type DocumentStoreError = { ok: false; code: 'DB_UNAVAILABLE' | 'SEARCH_FAILED'; message: string };
export interface DocumentRecallStore {
  searchDocuments(input: { query: string; pattern: string; limit: number }): Promise<{ ok: true; rows: DocumentSearchRow[]; contexts: DocumentSearchContext[] } | DocumentStoreError>;
  readDocument(fileId: string): Promise<{ ok: true; snapshot: DocumentSnapshot | null } | DocumentStoreError>;
  readSourceDocument?(sourceFileId:string):Promise<{ok:true;source:SourceDocument|null}|DocumentStoreError>;
}
