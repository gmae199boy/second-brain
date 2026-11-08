import type { ExtractionOutcome } from './store.js';
import type { ClaimWorkResult, HasDueWorkResult } from './store.js';
import { workKindPolicy } from '../domain/work-item.js';
export const SOURCE_SYNC_LEASE_MS = workKindPolicy('source_sync').claimForMs;
/** External source state. A source is distinct from a Brain-owned file location. */
export interface Source { id:string; kind:string; account:string; rootId:string; generation:number; cursor:string|null; connected:boolean }
export type SourceIndexStatus = 'pending'|'indexed'|'photo'|'too_large'|'unsupported'|'failed';
export interface SourceEntry { id:string; sourceId:string; remoteId:string; name:string; path:string; mimeType:string; remoteVersion:string; sizeBytes:number|null; fileId:string|null; indexStatus:SourceIndexStatus; unreachable:boolean; unreachableAt:Date|null; completedVersion:string|null; completedHash:string|null; seenScan:string|null }
export interface SourceClaim { workId:string; claimedBy:string; claimedAt:Date; attempts:number; now:Date }
export type SourceError = {ok:false; code:'DB_UNAVAILABLE'|'DB_LOCKED'|'CLAIM_LOST'|'SOURCE_CHANGED'|'FILE_REDACTED'; message:string};
export type SourceResult<T> = ({ok:true} & T) | SourceError;
export interface SourceStore {
  hasDueSourceWork(input:{sourceId:string;syncWorkId:string;now:Date}):Promise<HasDueWorkResult>;
  claimSourceWork(input:{sourceId:string;syncWorkId:string;now:Date;claimedBy:string}):Promise<ClaimWorkResult>;
  readSourceWorkStatus(input:{sourceId:string;syncWorkId:string}):Promise<SourceResult<{complete:boolean}>>;
  /** One source and cursor per kind/account; a conflicting root is refused. Multiple roots need a separate future mapping. */
  ensureSource(input:{id:string;kind:string;account:string;rootId:string}):Promise<SourceResult<{source:Source}>>;
  /** Explicit reactivation never changes source identity or resets its cursor. */
  connectSource(input:{id:string}):Promise<SourceResult<{source:Source}>>;
  /** Fence the source and atomically stop its queued work and schedules. */
  disconnectSource(input:{id:string;now:Date}):Promise<SourceResult<{source:Source}>>;
  removeSource(input:{id:string;now:Date}):Promise<SourceResult<{source:Source}>>;
  invalidateSource(input:{id:string;now:Date}):Promise<SourceResult<object>>;
  updateSourceFolders(input:{id:string;userId:string;folderId:string;add:boolean;now:Date}):Promise<SourceResult<{folders:string[];changed:boolean}>>;
  listSources():Promise<SourceResult<{sources:Source[]}>>;
  readSource(id:string):Promise<SourceResult<{source:Source|null}>>;
  listSourceEntries(sourceId:string):Promise<SourceResult<{entries:SourceEntry[]}>>;
  /** Extend only the original, still-live source_sync claim; never revive an expired claim. */
  renewSourceClaim(input:{sourceId:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  /** Begin only under the source_sync claim. Scan identity fences incomplete listings. */
  beginSourceScan(input:{sourceId:string;generation:number;scanId:string;startToken:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  observeSourceEntry(input:{sourceId:string;generation:number;scanId:string;entry:Omit<SourceEntry,'sourceId'|'fileId'|'indexStatus'|'unreachable'|'unreachableAt'|'completedVersion'|'completedHash'|'seenScan'>;claim:SourceClaim}):Promise<SourceResult<{entry:SourceEntry}>>;
  finishSourceScan(input:{sourceId:string;generation:number;scanId:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  markSourceUnreachable(input:{sourceId:string;generation:number;sourceFileId:string;remoteVersion:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  markSourceFileOutcome(input:{sourceFileId:string;fileId:string;remoteVersion:string;status:'unsupported'|'too_large'|'failed';claim:SourceClaim}):Promise<SourceResult<object>>;
  markSourceFileUnreachable(input:{sourceFileId:string;fileId:string;remoteVersion:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  markSourceEntry(input:{sourceId:string;generation:number;sourceFileId:string;remoteVersion:string;status:'photo'|'too_large'|'unsupported'|'failed';claim:SourceClaim}):Promise<SourceResult<object>>;
  /** Reserve ownership before writing a temp file; a preparing key is never assumed orphaned. */
  prepareSourceBytes(input:{sourceId:string;generation:number;sourceFileId:string;remoteVersion:string;contentHash:string;tempKey:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  /** Stage bytes identity and queue a real file-target extraction, never a home location. */
  handoffSourceFile(input:{sourceId:string;generation:number;sourceFileId:string;remoteVersion:string;fileId:string;contentHash:string;sizeBytes:number;workId:string;tempKey?:string;claim:SourceClaim}):Promise<SourceResult<{fileId:string;workId:string}>>;
  listSourceHandoffs(fileId:string):Promise<SourceResult<{handoffs:{sourceFileId:string;sourceId:string;generation:number;remoteId:string;mimeType:string;remoteVersion:string;workId:string;tempKey?:string}[]}>>;
  bindSourceAttempt(input:{sourceFileId:string;fileId:string;remoteVersion:string;tempKey:string;extractionId:string;claim:SourceClaim}):Promise<SourceResult<object>>;
  finishSourceAttempt(input:{fileId:string;extractionId:string;claim:SourceClaim;outcome:ExtractionOutcome}):Promise<SourceResult<object>>;
  /** A missing or unobservable binding must never be interpreted as safe to delete. */
  readSourceAttempt(tempKey:string):Promise<SourceResult<{binding:{sourceFileId:string;fileId:string|null;workId:string;open:boolean}|null}>>;
  recoverSourceAttempt(tempKey:string,now:Date):Promise<SourceResult<{binding:{sourceFileId:string;fileId:string|null;workId:string;open:boolean;preparing?:boolean}|null}>>;
  publishSourceFile(input:{sourceId:string;generation:number;sourceFileId:string;fileId:string;remoteVersion:string;contentHash:string;extractionId:string;outcome:Extract<ExtractionOutcome,{status:'ok'}>;claim:SourceClaim}):Promise<SourceResult<object>>;
}
