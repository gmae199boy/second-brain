export type RemoteError = {ok:false;code:'UNREACHABLE'|'TEMPORARY'|'TOO_LARGE'|'CHANGED'|'AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'DB_UNAVAILABLE'|'DB_LOCKED'|'AUTH_SESSION_CHANGED';message:string;retryAfter?:Date};
export const SOURCE_DOCS_MAX_BYTES=10_000_000;
export type RemoteResult<T> = ({ok:true}&T)|RemoteError;
export interface RemoteSourceItem { id:string;name:string;mimeType:string;version:string;sizeBytes:number|null; parents?:string[]; createdTime?:string; trashed?:boolean; shortcutTargetId?:string;shortcutTargetMimeType?:string }
export interface SourceRemote {
  changes?(input:{pageToken:string}):Promise<RemoteResult<{changes:{remoteId:string;removed:boolean;item?:RemoteSourceItem}[];nextPageToken:string|null;newStartPageToken:string|null}>>;
  startToken():Promise<RemoteResult<{token:string}>>;
  list(input:{parentId:string;pageToken?:string}):Promise<RemoteResult<{items:RemoteSourceItem[];nextPageToken:string|null;incomplete:boolean}>>;
  metadata(id:string):Promise<RemoteResult<{item:RemoteSourceItem}>>;
  download(input:{id:string;docs:boolean;maxBytes:number}):Promise<RemoteResult<{bytes:Uint8Array}>>;
}
export interface SourceTemp {
  /** Caller reserves the key under a source or extraction claim before writing bytes. */
  write(key:string,bytes:Uint8Array):Promise<{ok:true}|{ok:false;message:string}>;
  read(key:string,maxBytes:number):Promise<{ok:true;bytes:Uint8Array}|{ok:false;message:string;code?:'TOO_LARGE'}>;
  remove(key:string):Promise<void>;
  /** Unknown or open DB bindings are preserved. */
  cleanup(inspect:(key:string)=>Promise<'open'|'closed'|'unknown'|'preparing'>):Promise<void>;
}
