/** One durable identity for a Brain root and content hash. */
export interface DriveUpload {
  rootFolderId: string;
  contentHash: string;
  remoteId: string;
  state: 'reserved' | 'submitting' | 'uploaded' | 'cancelled';
  createdAt: Date;
  submissionId: string | null;
  sessionUri: string | null;
  confirmedOffset: number;
  deletedAt?: Date | null;
  deleteIntentAt?: Date | null;
  deleteSubmittedAt?: Date | null;
}
export type DriveUploadResult = { ok: true; upload: DriveUpload | null } | { ok: false; message: string };
/**
 * reserve atomically inserts only if absent and always returns the winning ID.
 * uploaded may advance reserved to uploaded only for the same ID; it must not
 * replace an identity. A caller retries the same ID after uncertain HTTP results.
 * Implementations perform only short DB writes, never HTTP inside the transaction.
 */
export interface DriveDeleteFence {sourceId:string;generation:number;account:string;locationId:string;workId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date;nowAtLock?:()=>Date}
export interface DriveUploadStore {
  read(input: { rootFolderId: string; contentHash: string }): Promise<DriveUploadResult>;
  save(input: { rootFolderId: string; contentHash: string; remoteId: string; state: 'reserved' | 'uploaded'; at: Date; submissionId?:string }): Promise<DriveUploadResult>;
  start(input:{rootFolderId:string; contentHash:string; remoteId:string; submissionId:string}): Promise<{ok:true; claimed:boolean; upload:DriveUpload} | {ok:false; message:string}>;
  /** CAS on the session and offset; replace a lost session only after remote verification. */
  checkpoint(input:{rootFolderId:string;contentHash:string;remoteId:string;submissionId:string;expectedSessionUri:string|null;expectedOffset:number;sessionUri:string|null;confirmedOffset:number}): Promise<DriveUploadResult>;
  checkDelete(input:{rootFolderId:string;contentHash:string;remoteId:string;fence?:DriveDeleteFence}):Promise<{ok:true;allowed:boolean}|{ok:false;message:string}>;
  /** Persist verified identity and then the submission boundary before DELETE. */
  beginDelete(input:{rootFolderId:string;contentHash:string;remoteId:string;at:Date;fence?:DriveDeleteFence}):Promise<DriveUploadResult>;
  submitDelete(input:{rootFolderId:string;contentHash:string;remoteId:string;at:Date;fence?:DriveDeleteFence}):Promise<DriveUploadResult>;
  /** Record an acknowledged remote delete; a bare 404 is not acknowledgement. */
  markDeleted(input:{rootFolderId:string;contentHash:string;remoteId:string;at:Date;fence?:DriveDeleteFence}):Promise<DriveUploadResult>;
  cancelReserved(input:{rootFolderId:string; contentHash:string}): Promise<DriveUploadResult>;
  /** Recovery only: a redacted intent whose reserved remote bytes were independently verified. */
  confirmRedacted(input:{fileId:string;rootFolderId:string;contentHash:string;remoteId:string;submissionId:string;at:Date;sourceFence?:{sourceId:string;generation:number};claim?:{workId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date;nowAtLock?:()=>Date}}):Promise<DriveUploadResult>;
}

import type { FileLocation } from '../domain/file.js';
export interface DriveCandidate { fileId: string; contentHash: string; sizeBytes: number; homeId: string; home: FileLocation; redacted: boolean }
export type DriveStoreFailure = { ok: false; code: 'DB_UNAVAILABLE' | 'DB_LOCKED'; message: string };
export interface DriveMigrationStore {
  /** Extend only the same live migration claim and connected source generation. */
  renewDriveMigration(input:{workId:string;fileId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date;nowAtLock?:()=>Date;sourceFence?:{sourceId:string;generation:number}}):Promise<{ok:true;renewed:boolean}|DriveStoreFailure>;
  /** Serializes external local deletion against disconnect across processes. */
  withDriveLocalDelete<T>(input:{workId:string;localLocationId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date;nowAtBarrier?:()=>Date;sourceFence?:{sourceId:string;generation:number}}, run:()=>Promise<T>):Promise<{ok:true;value:T}|DriveStoreFailure>;
  readDriveCandidate(fileId: string): Promise<{ok: true; candidate: DriveCandidate | null} | DriveStoreFailure>;
  beginDriveMigration(input: {fileId:string; expectedHomeId:string; contentHash:string; rootFolderId:string; locationId:string; locator:string; workId:string; at:Date}): Promise<{ok:true; state:'ready'|'changed'|'redacted'; locationId?:string} | DriveStoreFailure>;
  ensureDriveRedaction(input:{fileId:string; rootFolderId:string; workId:string; at:Date}): Promise<{ok:true; queued:boolean} | DriveStoreFailure>;
  readDriveLocatorRoot(locator:string): Promise<{ok:true; rootFolderId:string|null} | DriveStoreFailure>;
  readDriveLocationRoot(locationId:string): Promise<{ok:true; rootFolderId:string|null} | DriveStoreFailure>;
  readDriveIntent(fileId:string): Promise<{ok:true; intent:{rootFolderId:string; contentHash:string; locator:string; locationId:string; redacted:boolean} | null} | DriveStoreFailure>;
  commitDriveMigration(input: { fileId: string; expectedHomeId: string; contentHash: string; rootFolderId: string; remoteId: string; locationId: string; locator: string; workId: string; verifiedAt: Date; dueAt: Date; sourceFence?:{sourceId:string;generation:number}; migrationClaim?:{workId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date;nowAtLock?:()=>Date} }): Promise<{ok:true; state:'committed' | 'changed' | 'redacted'; locationId?:string} | DriveStoreFailure>;
  readDriveRetention(localLocationId: string): Promise<{ok:true; retention: { local: FileLocation; localId: string; remote: FileLocation; rootFolderId: string; contentHash: string; sizeBytes:number; dueAt: Date; redacted: boolean; eligible: boolean; deleted: boolean } | null} | DriveStoreFailure>;
}
