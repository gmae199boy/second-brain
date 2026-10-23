import type { FileLocation } from '../domain/file.js';
export type FileStoreFailure = { ok: false; code: 'FILES_UNAVAILABLE' | 'LOCATION_REFUSED'; message: string };
export type PutFileResult = { ok: true; contentHash: string; sizeBytes: number; location: FileLocation & { storeKind: 'local'; ownership: 'brain' } } | { ok: false; code: 'FILES_UNAVAILABLE'; message: string };
export interface FileStore {
  put(bytes: Uint8Array): Promise<PutFileResult>;
  get(location: FileLocation): Promise<{ ok: true; bytes: Uint8Array } | FileStoreFailure | { ok: false; code: 'FILE_NOT_FOUND'; message: string }>;
  exists(location: FileLocation): Promise<{ ok: true; exists: boolean } | FileStoreFailure>;
  url(location: FileLocation): Promise<{ ok: true; url: string } | FileStoreFailure>;
  delete(location: FileLocation): Promise<{ ok: true; deleted: boolean } | FileStoreFailure>;
}
