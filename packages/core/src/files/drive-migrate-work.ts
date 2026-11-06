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
  store: DriveMigrationStore & Partial<Pick<WorkStore,'resolveFailures'>>;
  uploads: DriveUploadStore;
  local: FileStore;
  drive: FileStore;
  settings: SettingsDependencies;
  rootFolderId: string;
  clock: Clock;
  idGen: IdGen;
}
/** Upload and verify outside DB writes, then commit one CAS transaction. */
export async function migrateFileToDrive(deps: DriveMigrationDependencies, fileId: string) {
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
    const read=await deps.drive.get(c.home);
    if (!read.ok || read.bytes.length !== c.sizeBytes || contentHashOfBytes(read.bytes) !== c.contentHash) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive home을 확인할 수 없습니다'};
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
  const put=await deps.drive.put(source.bytes); if (!put.ok) return put;
  if (put.location.storeKind !== 'drive' || put.location.ownership !== 'brain' || put.contentHash !== c.contentHash || put.sizeBytes !== c.sizeBytes || put.location.locator !== locator) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive 업로드 결과가 다릅니다'};
  // Adapter validates checksum priority; the independent read also binds bytes to
  // the content hash before the database publishes the location.
  const read=await deps.drive.get(put.location);
  if (!read.ok || contentHashOfBytes(read.bytes) !== c.contentHash || read.bytes.length !== c.sizeBytes) return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive 원본 검증에 실패했습니다'};
  const mapping=await deps.uploads.read({rootFolderId:deps.rootFolderId,contentHash:c.contentHash});
  if (!mapping.ok || !mapping.upload || mapping.upload.state !== 'uploaded') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'Drive 매핑이 없습니다'};
  const at=deps.clock.now(), due=new Date(at.getTime()+Number(retention.value)*86_400_000);
  if (!Number.isFinite(at.getTime()) || !Number.isFinite(due.getTime())) return {ok:false as const,code:'CONFIG_INVALID',message:'보관 만료 시각이 범위를 넘습니다'};
  const committed=await deps.store.commitDriveMigration({fileId:c.fileId,expectedHomeId:c.homeId,contentHash:c.contentHash,rootFolderId:deps.rootFolderId,remoteId:mapping.upload.remoteId,locationId:intent.locationId,locator:put.location.locator,workId:deps.idGen.next(),verifiedAt:at,dueAt:due});
  if (committed.ok && committed.state === 'changed') return {ok:false as const,code:'FILES_UNAVAILABLE',message:'home이 바뀌어 원격 사본을 보존하고 재시도합니다',retryable:true};
  return committed;
}

/** Replay the persisted intent after a crash, including redaction recovery. */
export function driveMigrationHandler(deps: DriveMigrationDependencies):WorkHandler {
  return async item => {
    const result=await migrateFileToDrive(deps,item.targetId);
    if (!result.ok) return {...result,retryable:true};
    if (deps.store.resolveFailures) {
      const resolved=await deps.store.resolveFailures({targetKind:'file',targetId:item.targetId,stage:DRIVE_MIGRATE_KIND,now:deps.clock.now()});
      if (!resolved.ok) return resolved;
    }
    return {ok:true};
  };
}

/** Retention jobs never delete the last usable copy, including after retries. */
export function driveLocalDeleteHandler(deps: {store: Pick<DriveMigrationStore,'readDriveRetention'> & Pick<AttachmentStore,'markFileLocationDeleted'> & Partial<Pick<WorkStore,'resolveFailures'>>; local:Pick<FileStore,'delete'>; drive:Pick<FileStore,'get'>; rootFolderId:string; clock:Clock}):WorkHandler {
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
    const got=await deps.drive.get(r.remote);
    if (!got.ok || contentHashOfBytes(got.bytes) !== r.contentHash) return {ok:false,code:'FILES_UNAVAILABLE',message:'Drive 사본을 검증할 수 없어 로컬 사본을 보존합니다',retryable:true};
    // Re-read after external I/O: a concurrent home switch invalidates this job.
    const latest=await deps.store.readDriveRetention(item.targetId); if (!latest.ok) return latest;
    const live=latest.retention;
    if (!live || live.redacted || live.deleted) return live?.redacted || live?.deleted ? success() : {ok:false,code:'FILES_UNAVAILABLE',message:'보관 대상이 사라졌습니다',retryable:true};
    if (!live.eligible || live.rootFolderId !== r.rootFolderId || live.contentHash !== r.contentHash || live.local.locator !== r.local.locator || live.remote.locator !== r.remote.locator || live.dueAt.getTime() !== r.dueAt.getTime()) return {ok:false,code:'FILES_UNAVAILABLE',message:'보관 대상이 변경되어 로컬 사본을 보존합니다',retryable:true};
    const deleted=await deps.local.delete(r.local); if (!deleted.ok) return {...deleted,retryable:deleted.code === 'FILES_UNAVAILABLE'};
    const marked=await deps.store.markFileLocationDeleted({id:r.localId,deletedAt:deps.clock.now()});
    return marked.ok ? success() : marked;
  };
}
