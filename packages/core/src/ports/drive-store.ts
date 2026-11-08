/** One durable identity for a Brain root and content hash. */
export interface DriveUpload {
  rootFolderId: string;
  contentHash: string;
  remoteId: string;
  state: 'reserved' | 'submitting' | 'uploaded' | 'cancelled';
  createdAt: Date;
}
export type DriveUploadResult = { ok: true; upload: DriveUpload | null } | { ok: false; message: string };
/**
 * reserve atomically inserts only if absent and always returns the winning ID.
 * uploaded may advance reserved to uploaded only for the same ID; it must not
 * replace an identity. A caller retries the same ID after uncertain HTTP results.
 * Implementations perform only short DB writes, never HTTP inside the transaction.
 */
export interface DriveUploadStore {
  read(input: { rootFolderId: string; contentHash: string }): Promise<DriveUploadResult>;
  save(input: { rootFolderId: string; contentHash: string; remoteId: string; state: 'reserved' | 'uploaded'; at: Date; submissionId?:string }): Promise<DriveUploadResult>;
  start(input:{rootFolderId:string; contentHash:string; remoteId:string; submissionId:string}): Promise<{ok:true; claimed:boolean; upload:DriveUpload} | {ok:false; message:string}>;
  cancelReserved(input:{rootFolderId:string; contentHash:string}): Promise<DriveUploadResult>;
}

import type { FileLocation } from '../domain/file.js';
export interface DriveCandidate { fileId: string; contentHash: string; sizeBytes: number; homeId: string; home: FileLocation; redacted: boolean }
export type DriveStoreFailure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export interface DriveMigrationStore {
  /** Serializes external local deletion against disconnect across processes. */
  withDriveLocalDelete<T>(input:{workId:string;localLocationId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date}, run:()=>Promise<T>):Promise<{ok:true;value:T}|DriveStoreFailure>;
  readDriveCandidate(fileId: string): Promise<{ok: true; candidate: DriveCandidate | null} | DriveStoreFailure>;
  beginDriveMigration(input: {fileId:string; expectedHomeId:string; contentHash:string; rootFolderId:string; locationId:string; locator:string; workId:string; at:Date}): Promise<{ok:true; state:'ready'|'changed'|'redacted'; locationId?:string} | DriveStoreFailure>;
  ensureDriveRedaction(input:{fileId:string; rootFolderId:string; workId:string; at:Date}): Promise<{ok:true; queued:boolean} | DriveStoreFailure>;
  readDriveLocatorRoot(locator:string): Promise<{ok:true; rootFolderId:string|null} | DriveStoreFailure>;
  readDriveLocationRoot(locationId:string): Promise<{ok:true; rootFolderId:string|null} | DriveStoreFailure>;
  readDriveIntent(fileId:string): Promise<{ok:true; intent:{rootFolderId:string; contentHash:string; locator:string; locationId:string; redacted:boolean} | null} | DriveStoreFailure>;
  commitDriveMigration(input: { fileId: string; expectedHomeId: string; contentHash: string; rootFolderId: string; remoteId: string; locationId: string; locator: string; workId: string; verifiedAt: Date; dueAt: Date }): Promise<{ok:true; state:'committed' | 'changed' | 'redacted'; locationId?:string} | DriveStoreFailure>;
  readDriveRetention(localLocationId: string): Promise<{ok:true; retention: { local: FileLocation; localId: string; remote: FileLocation; rootFolderId: string; contentHash: string; dueAt: Date; redacted: boolean; eligible: boolean; deleted: boolean } | null} | DriveStoreFailure>;
}
