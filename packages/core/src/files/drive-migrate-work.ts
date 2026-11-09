import { workProgress, type WorkProgressSink } from '../queue/progress.js';
import { contentHashOfBytes, driveBrainLocator } from '../domain/file.js';
import type { Clock } from '../ports/clock.js';
import type { FileStore } from '../ports/file-store.js';
import type { IdGen } from '../ports/id-gen.js';
import type { DriveMigrationStore, DriveUploadStore } from '../ports/drive-store.js';
import { getSetting, type SettingsDependencies } from '../settings/index.js';
import type { AttachmentStore, WorkStore } from '../ports/store.js';
import type { WorkHandler } from '../queue/drain.js';

export const DRIVE_LOCAL_DELETE_KIND = 'drive_local_delete';
export const DRIVE_MIGRATE_KIND = 'drive_migrate';
export interface DriveMigrationDependencies {
  store: DriveMigrationStore & Partial<Pick<WorkStore,'resolveFailures'|'getWork'>>;
  uploads: DriveUploadStore;
  local: FileStore;
  drive: FileStore;
  settings: SettingsDependencies;
  rootFolderId: string;
  sourceFence?:{sourceId:string;generation:number};
  onProgress?:WorkProgressSink;
  clock: Clock;
  idGen: IdGen;
}
/** Preserve the transport classification through the generic FileStore port. */
function driveFailure(error:{code:string;message:string;driveCode?:'AUTH_REQUIRED'|'AUTH_LOGIN_REQUIRED'|'AUTH_SESSION_CHANGED'|'TEMPORARY';retryAfter?:Date}) {
  const code=error.driveCode??error.code;
  return {ok:false as const,code,message:'Drive 작업을 완료하지 못했습니다',retryable:code!=='AUTH_REQUIRED'&&code!=='AUTH_LOGIN_REQUIRED',...(error.retryAfter?{retryAfter:error.retryAfter}:{})};
}
/** Upload and verify outside DB writes, then commit one CAS transaction. */
export async function migrateFileToDrive(deps: DriveMigrationDependencies, fileId: string, continueUpload?:()=>Promise<boolean>, migrationClaim?:{workId:string;claimedBy:string;claimedAt:Date;attempts:number;now:Date}) {
  const current=await deps.store.readDriveCandidate(fileId); if (!current.ok) return current;
  const c=current.candidate;
  if (!c) return {ok:false as const,code:'FILE_NOT_FOUND',message:'파일 원본이 없습니다'};
  if (c.redacted) {
    const found=await deps.store.readDriveIntent(fileId); if (!found.ok) return found;
    const intent=found.intent;
    if (!intent) return {ok:true as const,state:'redacted' as const};
    if (intent.rootFolderId !== deps.rootFolderId || intent.contentHash !== c.contentHash) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'가린 이전 의도의 루트가 다릅니다',retryable:true};
    const mapping=await deps.uploads.read({rootFolderId:intent.rootFolderId,contentHash:intent.contentHash});
    if (!mapping.ok) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'가린 업로드 매핑을 읽을 수 없습니다',retryable:true};
    if (mapping.upload?.state === 'reserved') {
      const cancelled=await deps.uploads.cancelReserved({rootFolderId:intent.rootFolderId,contentHash:intent.contentHash});
      if (!cancelled.ok) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'업로드 예약을 취소할 수 없습니다',retryable:true};
      if (cancelled.upload?.state === 'submitting') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'제출된 업로드의 결과를 확인해야 합니다',retryable:true};
      if (cancelled.upload?.state !== 'cancelled' && cancelled.upload?.state !== 'uploaded') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'업로드 상태를 확인할 수 없습니다',retryable:true};
      mapping.upload=cancelled.upload;
    }
    if (mapping.upload?.state === 'submitting') {
      const pending=mapping.upload;
      if (!pending.submissionId) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'제출 식별을 확인할 수 없습니다',retryable:true};
      const observed=await deps.drive.getBounded({storeKind:'drive',ownership:'brain',locator:intent.locator},c.sizeBytes);
      if(!observed.ok || observed.bytes.length!==c.sizeBytes || contentHashOfBytes(observed.bytes)!==c.contentHash) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'가린 원격 사본을 확인하지 못했습니다',retryable:true};
      const confirmed=await deps.uploads.confirmRedacted({fileId,rootFolderId:intent.rootFolderId,contentHash:c.contentHash,remoteId:pending.remoteId,submissionId:pending.submissionId,at:deps.clock.now(),...(deps.sourceFence?{sourceFence:deps.sourceFence}:{}),...(migrationClaim?{claim:{...migrationClaim,now:deps.clock.now(),nowAtLock:()=>deps.clock.now()}}:{})});
      if(!confirmed.ok||confirmed.upload?.state!=='uploaded') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'가린 원격 사본의 정리를 예약할 수 없습니다',retryable:true};
      mapping.upload=confirmed.upload;
    }
    if (!mapping.upload || mapping.upload.state === 'uploaded' || mapping.upload.state === 'cancelled') {
      const cleanup=await deps.store.ensureDriveRedaction({fileId,rootFolderId:intent.rootFolderId,workId:deps.idGen.next(),at:deps.clock.now()});
      return cleanup.ok ? {ok:true as const,state:'redacted' as const} : cleanup;
    }
    // A submitted request without an acknowledged completion may still be
    // processed remotely. Its existence or temporary absence is not a fence.
    return {ok:false as const,code:'FILES_UNAVAILABLE',message:'제출 결과가 불확실하여 Drive 삭제 완료를 보류합니다',retryable:true};
  }
  if (c.home.storeKind === 'drive' && c.home.ownership === 'brain') {
    const root=await deps.store.readDriveLocationRoot(c.homeId);
    if (!root.ok) return root;
    if (root.rootFolderId !== deps.rootFolderId) return {ok:false as const,code:'LOCATION_REFUSED',message:'Drive home의 루트가 다릅니다'};
    const mapping=await deps.uploads.read({rootFolderId:deps.rootFolderId,contentHash:c.contentHash});
    if (!mapping.ok || !mapping.upload || mapping.upload.state !== 'uploaded') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive home의 매핑이 없습니다'};
    const read=await deps.drive.getBounded(c.home,c.sizeBytes);
    if (!read.ok) return driveFailure(read);
    if (read.bytes.length !== c.sizeBytes || contentHashOfBytes(read.bytes) !== c.contentHash) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive home을 확인할 수 없습니다'};
    return {ok:true as const,state:'already' as const};
  }
  if (c.home.storeKind !== 'local' || c.home.ownership !== 'brain') return {ok:false as const,code:'LOCATION_REFUSED',message:'이전할 로컬 Brain 원본이 아닙니다'};
  const retention=await getSetting(deps.settings,{key:'drive.keep_local_days'}); if (!retention.ok) return retention;
  const source=await deps.local.get(c.home); if (!source.ok) return source;
  if (source.bytes.length !== c.sizeBytes || contentHashOfBytes(source.bytes) !== c.contentHash) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'로컬 원본 해시가 다릅니다'};
  const locator=driveBrainLocator(c.contentHash.slice(7),source.bytes);
  const intent=await deps.store.beginDriveMigration({fileId:c.fileId,expectedHomeId:c.homeId,contentHash:c.contentHash,rootFolderId:deps.rootFolderId,locationId:deps.idGen.next(),locator,workId:deps.idGen.next(),at:deps.clock.now()});
  if (!intent.ok) return intent;
  if (intent.state === 'redacted') return {ok:true as const,state:'redacted' as const};
  if (intent.state !== 'ready' || !intent.locationId) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'이전 home이 바뀌어 다시 확인해야 합니다',retryable:true};
  let chunks=0;const progress=workProgress(deps.onProgress);
  const put=await deps.drive.put(source.bytes,continueUpload?{continueUpload,onChunk:async()=>progress('upload_chunk',++chunks)}:undefined); if (!put.ok) return driveFailure(put);
  if (put.location.storeKind !== 'drive' || put.location.ownership !== 'brain' || put.contentHash !== c.contentHash || put.sizeBytes !== c.sizeBytes || put.location.locator !== locator) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive 업로드 결과가 다릅니다'};
  // Adapter validates checksum priority; the independent read also binds bytes to
  // the content hash before the database publishes the location.
  const read=await deps.drive.getBounded(put.location,c.sizeBytes);
  if (!read.ok) return driveFailure(read);
  if (contentHashOfBytes(read.bytes) !== c.contentHash || read.bytes.length !== c.sizeBytes) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive 원본 검증에 실패했습니다'};
  const mapping=await deps.uploads.read({rootFolderId:deps.rootFolderId,contentHash:c.contentHash});
  if (!mapping.ok || !mapping.upload || mapping.upload.state !== 'uploaded') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive 매핑이 없습니다'};
  const at=deps.clock.now(), due=new Date(at.getTime()+Number(retention.value)*86_400_000);
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(due.getTime())) return {ok:false as const,code:'CONFIG_INVALID',message:'보관 만료 시각이 범위를 넘습니다'};
  if(continueUpload&&!await continueUpload())return {ok:false as const,code:'CLAIM_LOST',message:'업로드 작업 청구가 유효하지 않습니다',retryable:true};
  const committed=await deps.store.commitDriveMigration({fileId:c.fileId,expectedHomeId:c.homeId,contentHash:c.contentHash,rootFolderId:deps.rootFolderId,remoteId:mapping.upload.remoteId,locationId:intent.locationId,locator:put.location.locator,workId:deps.idGen.next(),verifiedAt:at,dueAt:due,...(deps.sourceFence?{sourceFence:deps.sourceFence}:{}),...(migrationClaim?{migrationClaim:{...migrationClaim,now:deps.clock.now(),nowAtLock:()=>deps.clock.now()}}:{})});
  if (committed.ok && committed.state === 'changed') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'home이 바뀌어 원격 사본을 보존하고 재시도합니다',retryable:true};
  return committed;
}

/** Replay the persisted intent after a crash, including redaction recovery. */
export function driveMigrationHandler(deps: DriveMigrationDependencies):WorkHandler {
  return async item => {
    let renewalFailure:{ok:false;code:'DB_UNAVAILABLE'|'DB_LOCKED';message:string}|undefined;
    const continueUpload=async()=>{
      if(!item.claimedBy||!item.claimedAt||item.cancelRequestedAt!==null)return false;
      const renewed=await deps.store.renewDriveMigration({workId:item.id,fileId:item.targetId,claimedBy:item.claimedBy,claimedAt:item.claimedAt,attempts:item.attempts,now:deps.clock.now(),nowAtLock:()=>deps.clock.now(),...(deps.sourceFence?{sourceFence:deps.sourceFence}:{})});
      if(!renewed.ok){renewalFailure={ok:false,code:renewed.code,message:'Drive 작업을 완료하지 못했습니다'};return false;}
      return renewed.renewed;
    };
    const migrationClaim=item.claimedBy&&item.claimedAt?{workId:item.id,claimedBy:item.claimedBy,claimedAt:item.claimedAt,attempts:item.attempts,now:deps.clock.now()}:undefined;
    const result=await migrateFileToDrive(deps,item.targetId,continueUpload,migrationClaim);
    if(renewalFailure)return renewalFailure;
    if (!result.ok) return {...result,retryable:'retryable' in result ? result.retryable : result.code!=='AUTH_REQUIRED'&&result.code!=='AUTH_LOGIN_REQUIRED'};
    if (deps.store.resolveFailures) {
      const resolved=await deps.store.resolveFailures({targetKind:'file',targetId:item.targetId,stage:DRIVE_MIGRATE_KIND,now:deps.clock.now()});
      if (!resolved.ok) return resolved;
    }
    return {ok:true};
  };
}

/** Retention jobs never delete the last usable copy, including after retries. */
export function driveLocalDeleteHandler(deps: {store: Pick<DriveMigrationStore,'readDriveRetention'|'withDriveLocalDelete'> & Pick<AttachmentStore,'markFileLocationDeleted'> & Partial<Pick<WorkStore,'resolveFailures'>>; local:Pick<FileStore,'delete'>; drive:Pick<FileStore,'getBounded'>; rootFolderId:string; sourceFence?:{sourceId:string;generation:number}; clock:Clock}):WorkHandler {
  return async item=>{
    const success = async () => {
      if (!deps.store.resolveFailures) return {ok:true as const};
      const resolved = await deps.store.resolveFailures({targetKind:'file_location',targetId:item.targetId,stage:DRIVE_LOCAL_DELETE_KIND,now:deps.clock.now()});
      return resolved.ok ? {ok:true as const} : resolved;
    };
    const result=await deps.store.readDriveRetention(item.targetId); if (!result.ok) return result;
    const r=result.retention;
    if (!r) return {ok:false,code:'FILE_LOCATION_NOT_FOUND',message:'보관 삭제 대상이 없습니다',retryable:false};
    if (r.deleted || r.redacted) return success();
    const now = deps.clock.now();
    if (!Number.isFinite(r.dueAt.getTime()) || !Number.isFinite(now.getTime())) return {ok:false,code:'FILES_UNAVAILABLE',message:'보관 시각을 확인할 수 없습니다',retryable:true};
    if (now.getTime() < r.dueAt.getTime()) return {ok:false,code:'FILES_UNAVAILABLE',message:'보관 기간이 아직 끝나지 않았습니다',retryable:true,retryAfter:r.dueAt};
    if (!r.eligible || r.rootFolderId !== deps.rootFolderId) return {ok:false,code:'FILES_UNAVAILABLE',message:'검증된 Drive home이 아니어서 로컬 사본을 보존합니다',retryable:true};
    const got=await deps.drive.getBounded(r.remote,r.sizeBytes);
    if (!got.ok) return driveFailure(got);
    if (contentHashOfBytes(got.bytes) !== r.contentHash) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 사본을 검증할 수 없어 로컬 사본을 보존합니다',retryable:true};
    if (!item.claimedBy || !item.claimedAt) return {ok:false,code:'CLAIM_LOST',message:'삭제 청구가 없습니다',retryable:false};
    const guarded=await deps.store.withDriveLocalDelete({workId:item.id,localLocationId:item.targetId,claimedBy:item.claimedBy,claimedAt:item.claimedAt,attempts:item.attempts,now:deps.clock.now(),nowAtBarrier:()=>deps.clock.now(),...(deps.sourceFence?{sourceFence:deps.sourceFence}:{})},async()=>{
    // Re-read after external I/O and after acquiring the cross-process barrier.
    const latest=await deps.store.readDriveRetention(item.targetId); if (!latest.ok) return latest;
    const live=latest.retention;
    if (!live || live.redacted || live.deleted) return live?.redacted || live?.deleted ? success() : {ok:false,code:'FILES_UNAVAILABLE',message:'보관 대상이 사라졌습니다',retryable:true};
    const checkedAt=deps.clock.now();
    if (!Number.isFinite(live.dueAt.getTime()) || !Number.isFinite(checkedAt.getTime())) return {ok:false,code:'FILES_UNAVAILABLE',message:'보관 시각을 확인할 수 없습니다',retryable:true};
    if (checkedAt.getTime()<live.dueAt.getTime()) return {ok:false,code:'FILES_UNAVAILABLE',message:'보관 기간이 아직 끝나지 않았습니다',retryable:true,retryAfter:live.dueAt};
    if (!live.eligible || live.rootFolderId !== r.rootFolderId || live.contentHash !== r.contentHash || live.local.locator !== r.local.locator || live.remote.locator !== r.remote.locator) return {ok:false,code:'FILES_UNAVAILABLE',message:'보관 대상이 변경되어 로컬 사본을 보존합니다',retryable:true};
    const deleted=await deps.local.delete(r.local); if (!deleted.ok) return {...deleted,retryable:deleted.code === 'FILES_UNAVAILABLE'};
    const marked=await deps.store.markFileLocationDeleted({id:r.localId,deletedAt:deps.clock.now()});
    return marked.ok ? success() : marked;
    });
    return guarded.ok ? guarded.value : {...guarded,retryable:true};
  };
}
