import type { FileLocation } from '../domain/file.js';
export type FileStoreFailure = { ok:false; code:'FILES_UNAVAILABLE'; message:string; driveCode?:'AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'AUTH_SESSION_CHANGED'|'TEMPORARY'; retryAfter?:Date } | {ok:false;code:'LOCATION_REFUSED';message:string};
export type PutFileResult = { ok: true; contentHash: string; sizeBytes: number; location: FileLocation & { ownership: 'brain' } } | {ok:false;code:'FILES_UNAVAILABLE';message:string;driveCode?:'AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'AUTH_SESSION_CHANGED'|'TEMPORARY';retryAfter?:Date};
export interface FileStore {
  put(bytes: Uint8Array, control?: { continueUpload:()=>Promise<boolean>; onChunk?:(count:number)=>Promise<void> }): Promise<PutFileResult>;
  get(location: FileLocation): Promise<{ ok: true; bytes: Uint8Array } | FileStoreFailure | { ok: false; code: 'FILE_NOT_FOUND'; message: string }>;
  /** Read at most maxBytes; return TOO_LARGE without returning a partial buffer. */
  getBounded(location: FileLocation, maxBytes: number): Promise<{ok:true;bytes:Uint8Array} | FileStoreFailure | {ok:false;code:'FILE_NOT_FOUND';message:string} | {ok:false;code:'TOO_LARGE';message:string}>;
  exists(location: FileLocation): Promise<{ ok: true; exists: boolean } | FileStoreFailure>;
  url(location: FileLocation): Promise<{ ok: true; url: string } | FileStoreFailure>;
  delete(location: FileLocation, control?:{workId:string;locationId:string;claimedBy:string;claimedAt:Date;attempts:number}): Promise<{ ok: true; deleted: boolean } | FileStoreFailure>;
}
