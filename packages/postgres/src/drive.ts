import type { DriveBarrier } from './drive-barrier.js';
import { sql, type Kysely } from 'kysely';
import { type DriveMigrationStore, type DriveUpload, type DriveUploadStore, isDriveBrainLocator, workKindPolicy, type DriveDeleteFence } from '@second-brain/core';
import { databaseFailure, type PgConnect, type PgSchema } from './connect.js';
import { withWrite } from './write.js';
import { ensureWork } from './work.js';
import { lockDriveRetention, currentDriveRetentionDays } from './drive-retention.js';

type UploadRow = {root_folder_id:string; content_hash:string; remote_id:string; state:'reserved'|'submitting'|'uploaded'|'cancelled'; submission_id:string|null; created_at:string; session_uri:string|null; confirmed_offset:string|number; deleted_at:string|null;delete_intent_at:string|null;delete_submitted_at:string|null};
const upload = (r:UploadRow):DriveUpload => ({rootFolderId:r.root_folder_id,contentHash:r.content_hash,remoteId:r.remote_id,state:r.state,createdAt:new Date(r.created_at),submissionId:r.submission_id,sessionUri:r.session_uri,confirmedOffset:Number(r.confirmed_offset),deletedAt:r.deleted_at===null?null:new Date(r.deleted_at),deleteIntentAt:r.delete_intent_at===null?null:new Date(r.delete_intent_at),deleteSubmittedAt:r.delete_submitted_at===null?null:new Date(r.delete_submitted_at)});
const bad = (message:string) => ({ok:false as const,code:'DB_UNAVAILABLE' as const,message});
class MigrationClaimExpired extends Error {}
async function deleteFenceValid(db:Kysely<PgSchema>,f:DriveDeleteFence|undefined,root:string,hash:string):Promise<boolean>{
 if(!f)return true;
 const source=await sql`select id from brain.sources where id::text=${f.sourceId} and kind='drive' and connected and generation=${f.generation} and account=${f.account} for share`.execute(db);if(!source.rows.length)return false;
 const settings=await sql<{key:string;value:string}>`select a.key,a.value from brain.settings a join brain.users u on u.id=a.user_id where u.is_self=1 and a.key in ('drive.account_id','drive.root_folder_id') order by a.key for share of a`.execute(db);if(!settings.rows.some(x=>x.key==='drive.account_id'&&x.value===f.account)||!settings.rows.some(x=>x.key==='drive.root_folder_id'&&x.value===root))return false;
 const work=await sql`select id from brain.work_items where id::text=${f.workId} and kind='blob_delete' and target_kind='file_location' and target_id=${f.locationId} and claimed_by=${f.claimedBy} and claimed_at=${f.claimedAt.toISOString()}::timestamptz and attempts=${f.attempts} and completed_at is null and cancel_requested_at is null for update`.execute(db);if(!work.rows.length)return false;
 const now=f.nowAtLock?.()??f.now;const active=await sql`select 1 from brain.work_items w join brain.file_locations l on l.id::text=w.target_id join brain.files x on x.id=l.file_id join brain.drive_location_roots r on r.location_id=l.id where w.id::text=${f.workId} and w.claim_expires_at>${now.toISOString()}::timestamptz and l.deleted_at is null and l.store_kind='drive' and l.ownership='brain' and x.content_hash=${hash} and r.content_hash=${hash} and r.root_folder_id=${root} and exists(select 1 from brain.settings a join brain.users u on u.id=a.user_id where u.is_self=1 and a.key='drive.account_id' and a.value=${f.account})`.execute(db);return active.rows.length===1;
}

export function postgresDriveStore(connect:PgConnect, barrier:DriveBarrier): DriveMigrationStore & {driveUploads:DriveUploadStore} {
  const driveUploads:DriveUploadStore = {
    async read({rootFolderId,contentHash}) {
      const c=connect(); if (!c.ok) return {ok:false,message:c.message};
      try { const row=(await sql<UploadRow>`select * from brain.drive_uploads where root_folder_id=${rootFolderId} and content_hash=${contentHash}`.execute(c.connection.db)).rows[0]; return {ok:true,upload:row ? upload(row) : null}; }
      catch(error) { return {ok:false,message:databaseFailure(error).message}; }
    },
    async start(input) {
      const c=connect(); if (!c.ok) return {ok:false,message:c.message};
      const r=await withWrite(c.connection,async db=>{
        const file=(await sql<{redacted:boolean}>`select redacted_at is not null as redacted from brain.files where content_hash=${input.contentHash} for no key update`.execute(db)).rows[0];
        if (file?.redacted) throw new Error('가린 파일의 업로드는 금지됩니다');
        const changed=await sql`update brain.drive_uploads set state='submitting', submission_id=${input.submissionId}::uuid where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='reserved' returning remote_id`.execute(db);
        const row=(await sql<UploadRow>`select * from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash}`.execute(db)).rows[0];
        if (!row || row.remote_id !== input.remoteId) throw new Error('업로드 매핑이 바뀌었습니다');
        return {claimed:changed.rows.length===1,upload:upload(row)};
      });
      return r.ok ? {ok:true,...r.value} : {ok:false,message:r.message};
    },
    async checkpoint(input) {
      const c=connect(); if (!c.ok) return {ok:false,message:c.message};
      const r=await withWrite(c.connection,async db=>{
        const file=(await sql<{redacted:boolean}>`select redacted_at is not null as redacted from brain.files where content_hash=${input.contentHash} for no key update`.execute(db)).rows[0];
        if(file?.redacted) throw new Error('가린 파일의 업로드는 금지됩니다');
        const row=(await sql<UploadRow>`update brain.drive_uploads set session_uri=${input.sessionUri},confirmed_offset=${input.confirmedOffset} where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and submission_id::text=${input.submissionId} and state='submitting' and session_uri is not distinct from ${input.expectedSessionUri} and confirmed_offset=${input.expectedOffset} returning *`.execute(db)).rows[0];
        return row ? upload(row) : null;
      });
      return r.ok ? {ok:true,upload:r.value} : {ok:false,message:r.message};
    },
    async checkDelete(input) {const c=connect();if(!c.ok)return {ok:false,message:c.message};const r=await withWrite(c.connection,async db=>await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash));return r.ok?{ok:true,allowed:r.value}:{ok:false,message:r.message};},
    async beginDelete(input) {
      const c=connect();if(!c.ok)return {ok:false,message:c.message};const r=await withWrite(c.connection,async db=>{if(!await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash))return null;const f=input.fence;const row=(await sql<UploadRow>`update brain.drive_uploads set delete_intent_at=coalesce(delete_intent_at,${input.at.toISOString()}::timestamptz),delete_source_id=case when delete_intent_at is null then ${f?.sourceId??null}::uuid else delete_source_id end,delete_generation=case when delete_intent_at is null then ${f?.generation??null} else delete_generation end,delete_account=case when delete_intent_at is null then ${f?.account??null} else delete_account end where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='uploaded' and deleted_at is null and (delete_intent_at is null or (delete_source_id is not distinct from ${f?.sourceId??null}::uuid and delete_generation is not distinct from ${f?.generation??null} and delete_account is not distinct from ${f?.account??null})) returning *`.execute(db)).rows[0];return row?upload(row):null;});return r.ok?{ok:true,upload:r.value}:{ok:false,message:r.message};
    },
    async submitDelete(input) {
      const c=connect();if(!c.ok)return {ok:false,message:c.message};let expired=false;
      const r=await withWrite(c.connection,async db=>{
        if(!await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash))return null;
        const f=input.fence;
        const locked=await sql`select remote_id from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='uploaded' and delete_intent_at is not null and deleted_at is null and delete_source_id is not distinct from ${f?.sourceId??null}::uuid and delete_generation is not distinct from ${f?.generation??null} and delete_account is not distinct from ${f?.account??null} for update`.execute(db);
        if(!locked.rows.length)return null;
        if(!await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash))return null;
        const row=(await sql<UploadRow>`update brain.drive_uploads set delete_submitted_at=coalesce(delete_submitted_at,${input.at.toISOString()}::timestamptz) where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='uploaded' and delete_intent_at is not null and deleted_at is null and delete_source_id is not distinct from ${f?.sourceId??null}::uuid and delete_generation is not distinct from ${f?.generation??null} and delete_account is not distinct from ${f?.account??null} returning *`.execute(db)).rows[0];
        if(!await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash)){expired=true;throw new MigrationClaimExpired();}
        return row?upload(row):null;
      });if(expired)return {ok:true,upload:null};return r.ok?{ok:true,upload:r.value}:{ok:false,message:r.message};
    },
    async markDeleted(input) {
      const c=connect();if(!c.ok)return {ok:false,message:c.message};let expired=false;const r=await withWrite(c.connection,async db=>{if(!await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash))return null;const f=input.fence;const row=(await sql<UploadRow>`update brain.drive_uploads set deleted_at=coalesce(deleted_at,${input.at.toISOString()}::timestamptz) where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='uploaded' and delete_submitted_at is not null and delete_source_id is not distinct from ${f?.sourceId??null}::uuid and delete_generation is not distinct from ${f?.generation??null} and delete_account is not distinct from ${f?.account??null} returning *`.execute(db)).rows[0];if(!await deleteFenceValid(db,input.fence,input.rootFolderId,input.contentHash)){expired=true;throw new MigrationClaimExpired();}return row?upload(row):null;});if(expired)return {ok:true,upload:null};return r.ok?{ok:true,upload:r.value}:{ok:false,message:r.message};
    },
    async confirmRedacted(input) {
      const c=connect();if(!c.ok)return {ok:false,message:c.message};let expired=false;
      const r=await withWrite(c.connection,async db=>{
        if(input.sourceFence){const f=input.sourceFence;const source=await sql`select 1 from brain.sources where id::text=${f.sourceId} and kind='drive' and connected and generation=${f.generation} for share`.execute(db);if(!source.rows.length)return null;}
        if(input.claim){const claim=input.claim;const owned=await sql`select 1 from brain.work_items where id::text=${claim.workId} and kind='drive_migrate' and target_kind='file' and target_id=${input.fileId} and completed_at is null and cancel_requested_at is null and claimed_by=${claim.claimedBy} and claimed_at=${claim.claimedAt.toISOString()}::timestamptz and attempts=${claim.attempts} for update`.execute(db);if(!owned.rows.length)return null;}
        const check=async()=>{const claim=input.claim;if(!claim)return;const now=claim.nowAtLock?.()??claim.now;const valid=await sql`select 1 from brain.work_items where id::text=${claim.workId} and claimed_by=${claim.claimedBy} and claimed_at=${claim.claimedAt.toISOString()}::timestamptz and attempts=${claim.attempts} and completed_at is null and cancel_requested_at is null and claim_expires_at>${now.toISOString()}::timestamptz`.execute(db);if(!valid.rows.length){expired=true;throw new MigrationClaimExpired();}};
        const file=(await sql<{redacted:boolean;hash:string}>`select redacted_at is not null as redacted,content_hash as hash from brain.files where id::text=${input.fileId} for no key update`.execute(db)).rows[0];
        if(!file?.redacted||file.hash!==input.contentHash)throw new Error('가린 원본의 식별이 다릅니다');
        const intent=(await sql`select 1 from brain.drive_migration_intents where file_id::text=${input.fileId} and root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash}`.execute(db)).rows[0];if(!intent)throw new Error('가린 이전 의도가 없습니다');
        const locked=(await sql<UploadRow>`select * from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and submission_id::text=${input.submissionId} for update`.execute(db)).rows[0];await check();if(!locked)return null;
        const row=(await sql<UploadRow>`update brain.drive_uploads set state='uploaded',completed_at=${input.at.toISOString()}::timestamptz where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and submission_id::text=${input.submissionId} and state='submitting' returning *`.execute(db)).rows[0];await check();return row?upload(row):locked.state==='uploaded'?upload(locked):null;
      });if(expired)return {ok:true,upload:null};return r.ok?{ok:true,upload:r.value}:{ok:false,message:r.message};
    },
    async cancelReserved(input) {
      const c=connect(); if (!c.ok) return {ok:false,message:c.message};
      const r=await withWrite(c.connection,async db=>{
        const file=(await sql<{redacted:boolean}>`select redacted_at is not null as redacted from brain.files where content_hash=${input.contentHash} for no key update`.execute(db)).rows[0];
        if (!file?.redacted) throw new Error('가리지 않은 예약을 취소할 수 없습니다');
        await sql`update brain.drive_uploads set state='cancelled' where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and state='reserved'`.execute(db);
        const row=(await sql<UploadRow>`select * from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash}`.execute(db)).rows[0];
        return row ? upload(row) : null;
      });
      return r.ok ? {ok:true,upload:r.value} : {ok:false,message:r.message};
    },
    async save(input) {
      const c=connect(); if (!c.ok) return {ok:false,message:c.message};
      const r=await withWrite(c.connection,async db=>{
        if (input.state === 'reserved' || input.state === 'uploaded') {
          const file=(await sql<{redacted:boolean}>`select redacted_at is not null as redacted from brain.files where content_hash=${input.contentHash} for no key update`.execute(db)).rows[0];
          if (file?.redacted) throw new Error('가린 파일은 Drive에 업로드할 수 없습니다');
        }
        await sql`insert into brain.drive_uploads(root_folder_id,content_hash,remote_id,state,created_at)
          values (${input.rootFolderId},${input.contentHash},${input.remoteId},'reserved',${input.at.toISOString()})
          on conflict (root_folder_id,content_hash) do nothing`.execute(db);
        if (input.state === 'uploaded') await sql`update brain.drive_uploads set state='uploaded', completed_at=${input.at.toISOString()} where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and submission_id::text=${input.submissionId ?? ''} and state='submitting'`.execute(db);
        const row=(await sql<UploadRow>`select * from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash}`.execute(db)).rows[0];
        if (!row) throw new Error('Drive 매핑을 저장하지 못했습니다');
        return upload(row);
      });
      return r.ok ? {ok:true,upload:r.value} : {ok:false,message:r.message};
    },
  };
  return {driveUploads,
    async renewDriveMigration(input) {
      const c=connect();if(!c.ok)return bad(c.message);
      const result=await withWrite(c.connection,async db=>{
        if(input.sourceFence){const f=input.sourceFence;const valid=await sql`select id from brain.sources where id::text=${f.sourceId} and kind='drive' and connected and generation=${f.generation} for share`.execute(db);if(!valid.rows.length)return false;}
        const locked=await sql`select id from brain.work_items where id::text=${input.workId} for update`.execute(db);if(!locked.rows.length)return false;
        const checkedAt=input.nowAtLock?.()??input.now;const now=checkedAt.toISOString(),expiry=new Date(checkedAt.getTime()+workKindPolicy('drive_migrate').claimForMs).toISOString();
        const updated=await sql`update brain.work_items set claim_expires_at=greatest(claim_expires_at,${expiry}::timestamptz) where id::text=${input.workId} and kind='drive_migrate' and target_kind='file' and target_id=${input.fileId} and claimed_by=${input.claimedBy} and claimed_at=${input.claimedAt.toISOString()}::timestamptz and attempts=${input.attempts} and completed_at is null and cancel_requested_at is null and claim_expires_at>${now}::timestamptz returning id`.execute(db);return updated.rows.length===1;
      });return result.ok?{ok:true,renewed:result.value}:result;
    },
    async withDriveLocalDelete(input,run) {
      const result=await barrier(async client=>{
        const pending=await client.query('select work_id from brain.drive_delete_barriers limit 1');
        if(pending.rowCount) return {ok:false as const,code:'DB_LOCKED' as const,message:'이전 로컬 삭제 결과를 확인해야 합니다'};
        const checkedAt=input.nowAtBarrier?.()??input.now;
        if(!Number.isFinite(checkedAt.getTime()))return {ok:false as const,code:'DB_LOCKED' as const,message:'삭제 청구 시각이 유효하지 않습니다'};
        const valid=await client.query(`select 1 from brain.work_items where id::text=$1 and kind='drive_local_delete' and target_kind='file_location' and target_id=$6 and completed_at is null and cancel_requested_at is null and claimed_by=$2 and claimed_at=$3::timestamptz and attempts=$4 and claim_expires_at>$5::timestamptz and not exists(select 1 from brain.sources where kind='drive' and not connected) and ($7::text is null or exists(select 1 from brain.sources where id::text=$7 and kind='drive' and connected and generation=$8))`,[input.workId,input.claimedBy,input.claimedAt.toISOString(),input.attempts,checkedAt.toISOString(),input.localLocationId,input.sourceFence?.sourceId??null,input.sourceFence?.generation??null]);
        if(!valid.rowCount)return {ok:false as const,code:'DB_LOCKED' as const,message:'삭제 청구 또는 Drive 연결이 유효하지 않습니다'};
        await client.query('insert into brain.drive_delete_barriers(work_id,created_at) values ($1::uuid,$2::timestamptz)',[input.workId,checkedAt.toISOString()]);
        const value=await run();
        await client.query('delete from brain.drive_delete_barriers where work_id=$1::uuid',[input.workId]);
        return {ok:true as const,value};
      });
      return result.ok?result.value:result;
    },
    async readDriveCandidate(fileId) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try {
        const row=(await sql<{id:string;content_hash:string;size_bytes:number;home_id:string;store_kind:'local'|'drive';locator:string;ownership:'brain'|'external';redacted:boolean}>`
          select f.id,f.content_hash,f.size_bytes,l.id as home_id,l.store_kind,l.locator,l.ownership,(f.redacted_at is not null) as redacted
          from brain.files f join brain.file_locations l on l.id=f.home_location_id where f.id::text=${fileId}`.execute(c.connection.db)).rows[0];
        return {ok:true,candidate:row ? {fileId:row.id,contentHash:row.content_hash,sizeBytes:row.size_bytes,homeId:row.home_id,home:{storeKind:row.store_kind,locator:row.locator,ownership:row.ownership},redacted:row.redacted} : null};
      } catch(error) {return databaseFailure(error);}
    },
    async beginDriveMigration(input) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try {
        if (!isDriveBrainLocator(input.locator) || input.contentHash !== `sha256:${input.locator.slice(0,64)}`) return bad('이전 위치가 올바르지 않습니다');
        const r=await withWrite(c.connection,async db=>{
          const f=(await sql<{home:string|null;hash:string;redacted:boolean}>`select home_location_id::text as home,content_hash as hash,(redacted_at is not null) as redacted from brain.files where id::text=${input.fileId} for no key update`.execute(db)).rows[0];
          if (!f || f.home !== input.expectedHomeId || f.hash !== input.contentHash) return {state:'changed' as const};
          if (f.redacted) return {state:'redacted' as const};
          const local=(await sql`select id from brain.file_locations where id::text=${input.expectedHomeId} and file_id::text=${input.fileId} and store_kind='local' and ownership='brain' and deleted_at is null`.execute(db)).rows[0];
          if (!local) return {state:'changed' as const};
          await sql`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at)
            values (${input.locationId}::uuid,${input.fileId}::uuid,'drive',${input.locator},'brain',${input.at.toISOString()}) on conflict(file_id,store_kind,locator) do nothing`.execute(db);
          const loc=(await sql<{id:string;ownership:string;deleted_at:string|null}>`select id,ownership,deleted_at from brain.file_locations where file_id=${input.fileId}::uuid and store_kind='drive' and locator=${input.locator} for update`.execute(db)).rows[0];
          if (!loc || loc.ownership !== 'brain' || loc.deleted_at !== null) throw new Error('이전 위치를 예약할 수 없습니다');
          await sql`insert into brain.drive_location_roots(location_id,root_folder_id,content_hash) values (${loc.id}::uuid,${input.rootFolderId},${input.contentHash}) on conflict(location_id) do nothing`.execute(db);
          const binding=(await sql<{root_folder_id:string;content_hash:string}>`select root_folder_id,content_hash from brain.drive_location_roots where location_id=${loc.id}::uuid`.execute(db)).rows[0];
          if (!binding || binding.root_folder_id !== input.rootFolderId || binding.content_hash !== input.contentHash) throw new Error('Drive 위치가 다른 루트에 속합니다');
          await sql`insert into brain.drive_migration_intents(file_id,root_folder_id,content_hash,expected_home_id,location_id,locator,created_at,state)
            values (${input.fileId}::uuid,${input.rootFolderId},${input.contentHash},${input.expectedHomeId}::uuid,${loc.id}::uuid,${input.locator},${input.at.toISOString()},'active') on conflict(file_id) do nothing`.execute(db);
          const intent=(await sql<{root_folder_id:string;content_hash:string;expected_home_id:string;location_id:string;locator:string}>`select root_folder_id,content_hash,expected_home_id,location_id,locator from brain.drive_migration_intents where file_id=${input.fileId}::uuid`.execute(db)).rows[0];
          if (!intent || intent.root_folder_id !== input.rootFolderId || intent.content_hash !== input.contentHash || intent.location_id !== loc.id || intent.locator !== input.locator) throw new Error('이전 의도가 충돌합니다');
          if (intent.expected_home_id !== input.expectedHomeId) await sql`update brain.drive_migration_intents set expected_home_id=${input.expectedHomeId}::uuid,state='active' where file_id=${input.fileId}::uuid`.execute(db);
          await ensureWork(db,{id:input.workId,kind:'drive_migrate',targetKind:'file',targetId:input.fileId,createdAt:input.at,nextAttemptAt:input.at});
          return {state:'ready' as const,locationId:loc.id};
        });
        return r.ok ? {ok:true,...r.value} : r;
      } catch(error) {return databaseFailure(error);}
    },
    async ensureDriveRedaction(input) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try {
        const r=await withWrite(c.connection,async db=>{
          const file=(await sql<{redacted:boolean}>`select redacted_at is not null as redacted from brain.files where id::text=${input.fileId} for no key update`.execute(db)).rows[0];
          if (!file?.redacted) throw new Error('가려진 파일이 아닙니다');
          const intent=(await sql<{location_id:string;deleted_at:string|null}>`select i.location_id,l.deleted_at from brain.drive_migration_intents i join brain.file_locations l on l.id=i.location_id where i.file_id=${input.fileId}::uuid and i.root_folder_id=${input.rootFolderId}`.execute(db)).rows[0];
          if (!intent) throw new Error('가린 이전 의도가 없습니다');
          if (intent.deleted_at !== null) return {queued:false};
          const result=await ensureWork(db,{id:input.workId,kind:'blob_delete',targetKind:'file_location',targetId:intent.location_id,createdAt:input.at,nextAttemptAt:input.at});
          return {queued:result.created};
        });
        return r.ok ? {ok:true,...r.value} : r;
      } catch(error) {return databaseFailure(error);}
    },
    async readDriveLocatorRoot(locator) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try { const rows=(await sql<{root_folder_id:string}>`select b.root_folder_id from brain.drive_location_roots b join brain.file_locations l on l.id=b.location_id where l.store_kind='drive' and l.ownership='brain' and l.locator=${locator}`.execute(c.connection.db)).rows; return {ok:true,rootFolderId:rows.length===1 ? rows[0]!.root_folder_id : null}; }
      catch(error) {return databaseFailure(error);}
    },
    async readDriveLocationRoot(locationId) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try { const row=(await sql<{root_folder_id:string}>`select root_folder_id from brain.drive_location_roots where location_id::text=${locationId}`.execute(c.connection.db)).rows[0]; return {ok:true,rootFolderId:row?.root_folder_id ?? null}; }
      catch(error) {return databaseFailure(error);}
    },
    async readDriveIntent(fileId) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try {
        const row=(await sql<{root_folder_id:string;content_hash:string;locator:string;location_id:string;redacted:boolean}>`select i.root_folder_id,i.content_hash,i.locator,i.location_id,(f.redacted_at is not null) as redacted from brain.drive_migration_intents i join brain.files f on f.id=i.file_id where i.file_id::text=${fileId}`.execute(c.connection.db)).rows[0];
        return {ok:true,intent:row ? {rootFolderId:row.root_folder_id,contentHash:row.content_hash,locator:row.locator,locationId:row.location_id,redacted:row.redacted} : null};
      } catch(error) {return databaseFailure(error);}
    },
    async commitDriveMigration(input) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try {
        if (!isDriveBrainLocator(input.locator) || input.contentHash !== `sha256:${input.locator.slice(0,64)}` || input.dueAt.getTime() < input.verifiedAt.getTime()) return bad('이전 확정 입력이 올바르지 않습니다');
        const verified=input.verifiedAt.toISOString();
        let claimExpired=false;
        const r=await withWrite(c.connection,async db=>{
          if(!await lockDriveRetention(db))return {state:'locked' as const};
          if(input.sourceFence){const active=await sql`select id from brain.sources where id::text=${input.sourceFence.sourceId} and generation=${input.sourceFence.generation} and connected for share`.execute(db);if(!active.rows.length)return {state:'changed' as const};}
          if(input.migrationClaim){const claim=input.migrationClaim;const owned=await sql`select id from brain.work_items where id::text=${claim.workId} and kind='drive_migrate' and target_kind='file' and target_id=${input.fileId} and claimed_by=${claim.claimedBy} and claimed_at=${claim.claimedAt.toISOString()}::timestamptz and attempts=${claim.attempts} and completed_at is null and cancel_requested_at is null for update`.execute(db);if(!owned.rows.length)return {state:'changed' as const};}
          const checkClaim=async()=>{const claim=input.migrationClaim;if(!claim)return;const now=claim.nowAtLock?.()??claim.now;const valid=await sql`select id from brain.work_items where id::text=${claim.workId} and claimed_by=${claim.claimedBy} and claimed_at=${claim.claimedAt.toISOString()}::timestamptz and attempts=${claim.attempts} and completed_at is null and cancel_requested_at is null and claim_expires_at>${now.toISOString()}::timestamptz`.execute(db);if(!valid.rows.length){claimExpired=true;throw new MigrationClaimExpired();}};
          await checkClaim();
          const days=await currentDriveRetentionDays(db);
          const due=new Date(input.verifiedAt.getTime()+days*86_400_000).toISOString();
          const f=(await sql<{home:string|null;hash:string;redacted:boolean}>`select home_location_id::text as home,content_hash as hash,(redacted_at is not null) as redacted from brain.files where id::text=${input.fileId} for no key update`.execute(db)).rows[0];
          await checkClaim();
          if (!f || f.hash !== input.contentHash) return {state:'changed' as const};
          if (f.redacted) {
            const mapping=(await sql`select remote_id from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='uploaded'`.execute(db)).rows[0];
            if (!mapping) throw new Error('가린 업로드 매핑이 없습니다');
            await sql`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at,uploaded_at,remote_checksum)
              values (${input.locationId}::uuid,${input.fileId}::uuid,'drive',${input.locator},'brain',${verified},${verified},${input.contentHash}) on conflict(file_id,store_kind,locator) do nothing`.execute(db);
            const loc=(await sql<{id:string;ownership:string;deleted_at:string|null}>`select id,ownership,deleted_at from brain.file_locations where file_id=${input.fileId}::uuid and store_kind='drive' and locator=${input.locator} for update`.execute(db)).rows[0];
            if (!loc || loc.ownership !== 'brain') throw new Error('가린 Drive 위치가 올바르지 않습니다');
            if (loc.deleted_at === null) await ensureWork(db,{id:input.workId,kind:'blob_delete',targetKind:'file_location',targetId:loc.id,createdAt:input.verifiedAt,nextAttemptAt:input.verifiedAt});
            await checkClaim();
            return {state:'redacted' as const};
          }
          if (f.home !== input.expectedHomeId) {
            await sql`update brain.drive_migration_intents set state='stale' where file_id=${input.fileId}::uuid`.execute(db);
            return {state:'changed' as const};
          }
          const local=(await sql`select id from brain.file_locations where id::text=${input.expectedHomeId} and file_id::text=${input.fileId} and store_kind='local' and ownership='brain' and deleted_at is null`.execute(db)).rows[0];
          const mapping=(await sql<{completed_at:string}>`select completed_at from brain.drive_uploads where root_folder_id=${input.rootFolderId} and content_hash=${input.contentHash} and remote_id=${input.remoteId} and state='uploaded'`.execute(db)).rows[0];
          if (!local || !mapping) return {state:'changed' as const};
          await sql`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at,uploaded_at,remote_checksum,verified_at)
            values (${input.locationId}::uuid,${input.fileId}::uuid,'drive',${input.locator},'brain',${verified},${verified},${input.contentHash},${verified})
            on conflict(file_id,store_kind,locator) do nothing`.execute(db);
          const loc=(await sql<{id:string;verified_at:string|null;deleted_at:string|null;ownership:string}>`select id,verified_at,deleted_at,ownership from brain.file_locations where file_id::text=${input.fileId} and store_kind='drive' and locator=${input.locator} for update`.execute(db)).rows[0];
          if (!loc || loc.deleted_at !== null || loc.ownership !== 'brain') throw new Error('Drive 위치를 사용할 수 없습니다');
          if (loc.verified_at !== null && new Date(loc.verified_at).getTime() !== input.verifiedAt.getTime()) throw new Error('이미 검증된 위치는 다시 전환할 수 없습니다');
          const binding=(await sql<{root_folder_id:string;content_hash:string}>`select root_folder_id,content_hash from brain.drive_location_roots where location_id=${loc.id}::uuid`.execute(db)).rows[0];
          if (!binding || binding.root_folder_id !== input.rootFolderId || binding.content_hash !== input.contentHash) throw new Error('Drive 위치 루트가 다릅니다');
          if (loc.verified_at === null) await sql`update brain.file_locations set uploaded_at=${mapping.completed_at},remote_checksum=${input.contentHash},verified_at=${verified} where id=${loc.id}::uuid`.execute(db);
          const at = verified;
          const actualDue = due;
          await sql`insert into brain.drive_retention(local_location_id,drive_location_id,root_folder_id,content_hash,verified_at,due_at)
            values (${input.expectedHomeId}::uuid,${loc.id}::uuid,${input.rootFolderId},${input.contentHash},${at},${actualDue}) on conflict(local_location_id) do nothing`.execute(db);
          const retention=(await sql<{drive_location_id:string;root_folder_id:string;content_hash:string;due_at:string}>`select drive_location_id,root_folder_id,content_hash,due_at from brain.drive_retention where local_location_id=${input.expectedHomeId}::uuid`.execute(db)).rows[0];
          if (!retention || retention.drive_location_id !== loc.id || retention.root_folder_id !== input.rootFolderId || retention.content_hash !== input.contentHash) throw new Error('보관 삭제 대상이 충돌합니다');
          await sql`update brain.drive_migration_intents set state='committed' where file_id=${input.fileId}::uuid`.execute(db);
          await sql`update brain.files set home_location_id=${loc.id}::uuid where id=${input.fileId}::uuid`.execute(db);
          await ensureWork(db,{id:input.workId,kind:'drive_local_delete',targetKind:'file_location',targetId:input.expectedHomeId,createdAt:new Date(at),nextAttemptAt:new Date(retention.due_at)});
          await checkClaim();
          return {state:'committed' as const,locationId:loc.id};
        });
        if(claimExpired)return {ok:true,state:'changed'};
        if(!r.ok)return r;
        if(r.value.state==='locked')return {ok:false,code:'DB_LOCKED',message:'이전 로컬 삭제 결과를 확인해야 합니다'};
        return {ok:true,...r.value};
      } catch(error) {return databaseFailure(error);}
    },
    async readDriveRetention(localLocationId) {
      const c=connect(); if (!c.ok) return bad(c.message);
      try {
        const row=(await sql<{local_locator:string;remote_locator:string;root_folder_id:string;due_at:string;hash:string;size_bytes:string|number;redacted:boolean;eligible:boolean;deleted:boolean}>`
          select l.locator as local_locator,d.locator as remote_locator,r.root_folder_id,greatest(r.due_at,r.verified_at + coalesce((select value::integer from brain.settings where key='drive.keep_local_days' and (user_id is null or user_id=(select id from brain.users where is_self=1 limit 1)) order by user_id nulls last limit 1),30) * interval '1 day') as due_at,r.content_hash as hash,(f.redacted_at is not null) as redacted,
            (f.home_location_id=d.id and d.verified_at is not null and d.deleted_at is null and l.file_id=d.file_id and l.store_kind='local' and l.ownership='brain' and d.store_kind='drive' and d.ownership='brain' and u.state='uploaded') as eligible,
            (l.deleted_at is not null) as deleted, f.size_bytes
          from brain.drive_retention r join brain.file_locations l on l.id=r.local_location_id
          join brain.file_locations d on d.id=r.drive_location_id join brain.files f on f.id=l.file_id
          join brain.drive_uploads u on u.root_folder_id=r.root_folder_id and u.content_hash=r.content_hash
          where l.id::text=${localLocationId}`.execute(c.connection.db)).rows[0];
        return {ok:true,retention:row ? {local:{storeKind:'local',ownership:'brain',locator:row.local_locator},localId:localLocationId,remote:{storeKind:'drive',ownership:'brain',locator:row.remote_locator},rootFolderId:row.root_folder_id,contentHash:row.hash,sizeBytes:Number(row.size_bytes),dueAt:new Date(row.due_at),redacted:row.redacted,eligible:row.eligible,deleted:row.deleted} : null};
      } catch(error) {return databaseFailure(error);}
    },
  };
}
