import { expect, it, vi } from 'vitest';
import { contentHashOfBytes, driveBrainLocator, driveLocalDeleteHandler, migrateFileToDrive, type DriveMigrationStore, type DriveUploadStore, type FileStore, type WorkItem } from '../src/index.js';
import { memoryFileStore, memorySchemaStore, memorySettingsStore, sequenceIdGen } from '../src/testing/index.js';

const bytes=Uint8Array.of(1,2,3), hash=contentHashOfBytes(bytes), now=new Date('2026-01-01T00:00:00Z');
async function fixture(days?:string) {
  const local=memoryFileStore(), initial=await local.put(bytes); if (!initial.ok) throw Error('local put');
  const locator=driveBrainLocator(hash.slice(7),bytes), location={storeKind:'drive' as const,ownership:'brain' as const,locator};
  let remote: Uint8Array=bytes.slice(); let marked=false;
  const drive:FileStore={
    async put() {return {ok:true,contentHash:hash,sizeBytes:bytes.length,location};},
    async get() {return {ok:true,bytes:remote};},
    async getBounded(_location,maxBytes) {return remote.length>maxBytes?{ok:false,code:'TOO_LARGE',message:'상한 초과'}:{ok:true,bytes:remote.slice()};},
    async exists() {return {ok:true,exists:true};}, async url() {return {ok:true,url:'https://example.invalid'};},
    async delete() {return {ok:true,deleted:true};},
  };
  const uploads:DriveUploadStore={
    async read() {return {ok:true,upload:{rootFolderId:'root',contentHash:hash,remoteId:'id',state:'uploaded',createdAt:now,submissionId:null,sessionUri:null,confirmedOffset:0}};},
    async save() {throw Error('not used by orchestrator');},
    async start() {throw Error('not used by orchestrator');},
    async checkpoint() {throw Error('not used by orchestrator');},
    async checkDelete() {throw Error('not used by orchestrator');},
    async beginDelete() {throw Error('not used by orchestrator');},
    async submitDelete() {throw Error('not used by orchestrator');},
    async markDeleted() {throw Error('not used by orchestrator');},
    async cancelReserved() {throw Error('not used by orchestrator');},
    async confirmRedacted() {throw Error('not used by orchestrator');},
  };
  const commit=vi.fn<DriveMigrationStore['commitDriveMigration']>(async()=>({ok:true,state:'committed',locationId:'drive-id'}));
  const store:DriveMigrationStore={
    async renewDriveMigration(){return {ok:true,renewed:true};},
    async withDriveLocalDelete(_input,run) { return {ok:true,value:await run()}; },
    async readDriveCandidate() {return {ok:true,candidate:{fileId:'file',contentHash:hash,sizeBytes:bytes.length,homeId:'local-id',home:initial.location,redacted:false}};},
    async beginDriveMigration() {return {ok:true,state:'ready',locationId:'drive-id'};},
    async readDriveIntent() {return {ok:true,intent:null};},
    async readDriveLocationRoot() {return {ok:true,rootFolderId:'root'};},
    async readDriveLocatorRoot() {return {ok:true,rootFolderId:'root'};},
    async ensureDriveRedaction() {return {ok:true,queued:true};},
    commitDriveMigration:commit,
    async readDriveRetention() {return {ok:true,retention:{local:initial.location,localId:'local-id',remote:location,rootFolderId:'root',contentHash:hash,sizeBytes:bytes.length,dueAt:now,redacted:false,eligible:true,deleted:marked}};},
  };
  const settingsStore={...memorySettingsStore(),...memorySchemaStore({version:1}),async readSelfUser(){return {ok:true as const,user:{id:'user',name:'fixture',isSelf:true,createdAt:now,submissionId:null,sessionUri:null,confirmedOffset:0}};}};
  if (days !== undefined) await settingsStore.setSetting({userId:'user',key:'drive.keep_local_days',value:days,updatedAt:now});
  const settings={store:settingsStore,schemaVersions:{core:1},clock:{now:()=>now}};
  const deps={store,uploads,local,drive,settings,rootFolderId:'root',clock:{now:()=>now},idGen:sequenceIdGen({timestampMs:now.getTime()})};
  return {deps,commit,local,location,initial,setRemote:(value:Uint8Array)=>{remote=value;},marker:{async markFileLocationDeleted(){marked=true;return {ok:true as const,deletedAt:now,marked:true};}}};
}
it.each([['0',0],['30',30],[undefined,30]] as const)('uses retention %s to compute due atomically',async(days,daysExpected)=>{
  const f=await fixture(days); expect(await migrateFileToDrive(f.deps,'file')).toMatchObject({ok:true,state:'committed'});
  expect(f.commit).toHaveBeenCalledWith(expect.objectContaining({verifiedAt:now,dueAt:new Date(now.getTime()+daysExpected*86_400_000),expectedHomeId:'local-id'}));
});
it('does not publish a mismatched remote copy',async()=>{
  const f=await fixture(); f.setRemote(Uint8Array.of(99));
  expect(await migrateFileToDrive(f.deps,'file')).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'}); expect(f.commit).not.toHaveBeenCalled();
});
it('retention deletion rechecks remote hash and preserves local bytes on mismatch or loss',async()=>{
  const f=await fixture(), handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker},local:f.local,drive:f.deps.drive,rootFolderId:'root',clock:{now:()=>now}});
  const item={id:'work',targetId:'local-id',claimedBy:'worker',claimedAt:now,attempts:1} as WorkItem;
  f.setRemote(Uint8Array.of(99)); expect(await handler(item)).toMatchObject({ok:false,retryable:true});
  expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:true});
  f.setRemote(bytes); expect(await handler(item)).toEqual({ok:true}); expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:false});
  expect(await handler(item)).toEqual({ok:true});
});

it('does not remove a copy before due or when the configured root changed',async()=>{
  const f=await fixture();
  const future=new Date(now.getTime()+86_400_000);
  const delayed={...f.deps.store,async readDriveRetention(){return {ok:true as const,retention:{local:f.initial.location,localId:'local-id',remote:f.location,rootFolderId:'root',contentHash:hash,sizeBytes:bytes.length,dueAt:future,redacted:false,eligible:true,deleted:false}};}};
  const handler=driveLocalDeleteHandler({store:{...delayed,...f.marker},local:f.local,drive:f.deps.drive,rootFolderId:'root',clock:{now:()=>now}});
  expect(await handler({targetId:'local-id'} as WorkItem)).toMatchObject({ok:false,retryAfter:future});
  const wrongRoot=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker},local:f.local,drive:f.deps.drive,rootFolderId:'other',clock:{now:()=>now}});
  expect(await wrongRoot({targetId:'local-id'} as WorkItem)).toMatchObject({ok:false,retryable:true});
  expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:true});
});

it('a missing remote copy cannot trigger retention deletion',async()=>{
  const f=await fixture();
  const gone={...f.deps.drive,async getBounded(){return {ok:false as const,code:'FILE_NOT_FOUND' as const,message:'missing'};}};
  const handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker},local:f.local,drive:gone,rootFolderId:'root',clock:{now:()=>now}});
  expect(await handler({targetId:'local-id'} as WorkItem)).toMatchObject({ok:false,retryable:true});
  expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:true});
});

it('keeps an uncertain redacted upload retryable when Drive is unavailable or the ID is not yet visible',async()=>{
  const f=await fixture();
  const intent={rootFolderId:'root',contentHash:hash,locator:f.location.locator,locationId:'drive-id',redacted:true};
  const redacted={...f.deps.store,async readDriveCandidate(){return {ok:true as const,candidate:{fileId:'file',contentHash:hash,sizeBytes:bytes.length,homeId:'local-id',home:f.initial.location,redacted:true}};},async readDriveIntent(){return {ok:true as const,intent};}};
  const uploads={...f.deps.uploads,async read(){return {ok:true as const,upload:{rootFolderId:'root',contentHash:hash,remoteId:'id',state:'submitting' as const,createdAt:now,submissionId:null,sessionUri:null,confirmedOffset:0}};}};
  const gone={...f.deps.drive,async exists(){return {ok:true as const,exists:false};}};
  const result=await migrateFileToDrive({...f.deps,store:redacted,uploads,drive:gone},'file');
  expect(result).toMatchObject({ok:false,code:'FILES_UNAVAILABLE',retryable:true});
  expect(f.commit).not.toHaveBeenCalled();
});

it('resolves retention failures after deletion and on already deleted retry',async()=>{
  const f=await fixture(), resolveFailures=vi.fn(async()=>({ok:true as const,resolved:1}));
  const handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker,resolveFailures},local:f.local,drive:f.deps.drive,rootFolderId:'root',clock:{now:()=>now}});
  const item={id:'work',targetId:'local-id',claimedBy:'worker',claimedAt:now,attempts:1} as WorkItem;
  expect(await handler(item)).toEqual({ok:true}); expect(await handler(item)).toEqual({ok:true});
  expect(resolveFailures).toHaveBeenCalledTimes(2);
  expect(resolveFailures).toHaveBeenCalledWith({targetKind:'file_location',targetId:'local-id',stage:'drive_local_delete',now});
});

it('does not delete after the cross-process barrier rejects a stale claim',async()=>{
  const f=await fixture();let deleted=false;
  const handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker,async withDriveLocalDelete(){return {ok:false as const,code:'DB_LOCKED' as const,message:'연결이 끊겼습니다'};}},local:{async delete(){deleted=true;return {ok:true as const,deleted:true};}},drive:f.deps.drive,rootFolderId:'root',clock:{now:()=>now}});
  expect(await handler({id:'work',targetId:'local-id',claimedBy:'worker',claimedAt:now,attempts:1} as WorkItem)).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(deleted).toBe(false);
});

it('propagates Drive auth and Retry-After into migration and retention work',async()=>{
  const f=await fixture(),due=new Date(now.getTime()+120_000);
  const auth={...f.deps.drive,async put(){return {ok:false as const,code:'FILES_UNAVAILABLE' as const,driveCode:'AUTH_REQUIRED' as const,message:'재동의 필요'};}};
  expect(await migrateFileToDrive({...f.deps,drive:auth},'file')).toMatchObject({ok:false,code:'AUTH_REQUIRED',retryable:false});
  const limited={...f.deps.drive,async getBounded(){return {ok:false as const,code:'FILES_UNAVAILABLE' as const,driveCode:'TEMPORARY' as const,message:'잠시 후 재시도',retryAfter:due};}};
  const handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker},local:f.local,drive:limited,rootFolderId:'root',clock:{now:()=>now}});
  expect(await handler({id:'work',targetId:'local-id',claimedBy:'worker',claimedAt:now,attempts:1} as WorkItem)).toMatchObject({ok:false,code:'TEMPORARY',retryable:true,retryAfter:due});
});

it.each(['pending','reject'] as const)('a %s progress observer cannot block chunk cancellation',async mode=>{
 const {driveMigrationHandler}=await import('../src/index.js');const f=await fixture();let active=true,sent=0;const observed:string[]=[];
 const store={...f.deps.store,async renewDriveMigration(){return {ok:true as const,renewed:active};}};
 const drive={...f.deps.drive,async put(_bytes:Uint8Array,control?:{continueUpload:()=>Promise<boolean>;onChunk?:(count:number)=>Promise<void>}){if(!control||!await control.continueUpload())return {ok:false as const,code:'FILES_UNAVAILABLE' as const,message:'cancelled'};sent++;await control.onChunk?.(1);if(!await control.continueUpload())return {ok:false as const,code:'FILES_UNAVAILABLE' as const,message:'cancelled'};sent++;return {ok:true as const,contentHash:hash,sizeBytes:bytes.length,location:f.location};}};
 const handler=driveMigrationHandler({...f.deps,store,drive,onProgress:event=>{observed.push(event.message??'');active=false;return mode==='pending'?new Promise<void>(()=>{}):Promise.reject(Error('observer'));}});
 expect(await handler({id:'work',kind:'drive_migrate',targetKind:'file',targetId:'file',claimedBy:'worker',claimedAt:now,attempts:1,cancelRequestedAt:null} as WorkItem)).toMatchObject({ok:false});expect(sent).toBe(1);expect(observed).toEqual(['upload_chunk 1']);
});

it.each(['DB_UNAVAILABLE','DB_LOCKED'] as const)('renewal %s keeps queue release policy and does not record a file failure',async code=>{
 for(const boundary of ['upload','commit'] as const){
  const {driveMigrationHandler,drainQueue}=await import('../src/index.js');const {memoryStore,memorySpool,sampleWorkInput}=await import('../src/testing/index.js');const f=await fixture(),queue=memoryStore(),ids=sequenceIdGen({timestampMs:now.getTime(),start:700});
  await queue.addWork(sampleWorkInput({id:'work',kind:'drive_migrate',targetKind:'file',targetId:'file',createdAt:now,nextAttemptAt:now}));let renewals=0;
  const store={...f.deps.store,async renewDriveMigration(){renewals++;return boundary==='commit'&&renewals===1?{ok:true as const,renewed:true}:{ok:false as const,code,message:'synthetic secret'};}};
  const drive={...f.deps.drive,async put(_b:Uint8Array,control?:{continueUpload:()=>Promise<boolean>}){if(!control||!await control.continueUpload())return {ok:false as const,code:'FILES_UNAVAILABLE' as const,message:'transport'};return {ok:true as const,contentHash:hash,sizeBytes:bytes.length,location:f.location};}};
  const report=await drainQueue({store:queue,spool:memorySpool(),clock:{now:()=>now},idGen:ids},{budgetMs:1000,handlers:{drive_migrate:driveMigrationHandler({...f.deps,store,drive})}});
  expect(report).toMatchObject({released:1,failed:0,stopped:'unwritable',code});expect(queue.snapshot().workItems[0]).toMatchObject({attempts:0,completedAt:null,claimedBy:null});expect(queue.snapshot().failures).toHaveLength(0);expect(f.commit).not.toHaveBeenCalled();
 }
});

it('same upload observer recovers for the next work after a timeout',async()=>{
 const {driveMigrationHandler}=await import('../src/index.js');const f=await fixture(),events:string[]=[];let first=true;
 const handler=driveMigrationHandler({...f.deps,onProgress:event=>{events.push(event.message??'');if(first){first=false;return new Promise<void>(()=>{});}},drive:{...f.deps.drive,async put(_bytes,control){await control?.onChunk?.(1);await control?.onChunk?.(2);return {ok:true,contentHash:hash,sizeBytes:bytes.length,location:f.location};}}});
 const work={id:'work',kind:'drive_migrate',targetKind:'file',targetId:'file',claimedBy:'worker',claimedAt:now,attempts:1,cancelRequestedAt:null} as WorkItem;
 expect(await handler(work)).toEqual({ok:true});expect(await handler({...work,id:'next'})).toEqual({ok:true});expect(events).toEqual(['upload_chunk 1','upload_chunk 1','upload_chunk 2']);
});

it.each(['independent','home','redacted'] as const)('bounded %s remote verification refuses excess before commit or cleanup',async mode=>{
 const f=await fixture();let bound=-1,cleanup=0;const drive={...f.deps.drive,async getBounded(_location:import('../src/index.js').FileLocation,maxBytes:number){bound=maxBytes;return {ok:false as const,code:'TOO_LARGE' as const,message:'synthetic excess'};}};
 const base=await f.deps.store.readDriveCandidate('file');if(!base.ok||!base.candidate)throw Error('candidate');const candidate={...base.candidate,...(mode==='home'?{home:f.location,homeId:'drive-id'}:{}),...(mode==='redacted'?{redacted:true}:{})};
 const store={...f.deps.store,async readDriveCandidate(){return {ok:true as const,candidate};},async readDriveLocationRoot(){return {ok:true as const,rootFolderId:'root'};},async readDriveIntent(){return {ok:true as const,intent:{rootFolderId:'root',contentHash:hash,locator:f.location.locator,locationId:'drive-id',redacted:true}};},async ensureDriveRedaction(){cleanup++;return {ok:true as const,queued:true};}};
 const uploads=mode==='redacted'?{...f.deps.uploads,async read(){return {ok:true as const,upload:{rootFolderId:'root',contentHash:hash,remoteId:'id',state:'submitting' as const,createdAt:now,submissionId:'submission',sessionUri:null,confirmedOffset:0}};}}:f.deps.uploads;
 expect(await migrateFileToDrive({...f.deps,store,drive,uploads},'file')).toMatchObject({ok:false});expect(bound).toBe(bytes.length);expect(f.commit).not.toHaveBeenCalled();expect(cleanup).toBe(0);
});
