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
    async exists() {return {ok:true,exists:true};}, async url() {return {ok:true,url:'https://example.invalid'};},
    async delete() {return {ok:true,deleted:true};},
  };
  const uploads:DriveUploadStore={
    async read() {return {ok:true,upload:{rootFolderId:'root',contentHash:hash,remoteId:'id',state:'uploaded',createdAt:now}};},
    async save() {throw Error('not used by orchestrator');},
    async start() {throw Error('not used by orchestrator');},
    async cancelReserved() {throw Error('not used by orchestrator');},
  };
  const commit=vi.fn<DriveMigrationStore['commitDriveMigration']>(async()=>({ok:true,state:'committed',locationId:'drive-id'}));
  const store:DriveMigrationStore={
    async readDriveCandidate() {return {ok:true,candidate:{fileId:'file',contentHash:hash,sizeBytes:bytes.length,homeId:'local-id',home:initial.location,redacted:false}};},
    async beginDriveMigration() {return {ok:true,state:'ready',locationId:'drive-id'};},
    async readDriveIntent() {return {ok:true,intent:null};},
    async readDriveLocationRoot() {return {ok:true,rootFolderId:'root'};},
    async readDriveLocatorRoot() {return {ok:true,rootFolderId:'root'};},
    async ensureDriveRedaction() {return {ok:true,queued:true};},
    commitDriveMigration:commit,
    async readDriveRetention() {return {ok:true,retention:{local:initial.location,localId:'local-id',remote:location,rootFolderId:'root',contentHash:hash,dueAt:now,redacted:false,eligible:true,deleted:marked}};},
  };
  const settingsStore={...memorySettingsStore(),...memorySchemaStore({version:1}),async readSelfUser(){return {ok:true as const,user:{id:'user',name:'fixture',isSelf:true,createdAt:now}};}};
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
  const item={targetId:'local-id'} as WorkItem;
  f.setRemote(Uint8Array.of(99)); expect(await handler(item)).toMatchObject({ok:false,retryable:true});
  expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:true});
  f.setRemote(bytes); expect(await handler(item)).toEqual({ok:true}); expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:false});
  expect(await handler(item)).toEqual({ok:true});
});

it('does not remove a copy before due or when the configured root changed',async()=>{
  const f=await fixture();
  const future=new Date(now.getTime()+86_400_000);
  const delayed={...f.deps.store,async readDriveRetention(){return {ok:true as const,retention:{local:f.initial.location,localId:'local-id',remote:f.location,rootFolderId:'root',contentHash:hash,dueAt:future,redacted:false,eligible:true,deleted:false}};}};
  const handler=driveLocalDeleteHandler({store:{...delayed,...f.marker},local:f.local,drive:f.deps.drive,rootFolderId:'root',clock:{now:()=>now}});
  expect(await handler({targetId:'local-id'} as WorkItem)).toMatchObject({ok:false,retryAfter:future});
  const wrongRoot=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker},local:f.local,drive:f.deps.drive,rootFolderId:'other',clock:{now:()=>now}});
  expect(await wrongRoot({targetId:'local-id'} as WorkItem)).toMatchObject({ok:false,retryable:true});
  expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:true});
});

it('a missing remote copy cannot trigger retention deletion',async()=>{
  const f=await fixture();
  const gone={...f.deps.drive,async get(){return {ok:false as const,code:'FILE_NOT_FOUND' as const,message:'missing'};}};
  const handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker},local:f.local,drive:gone,rootFolderId:'root',clock:{now:()=>now}});
  expect(await handler({targetId:'local-id'} as WorkItem)).toMatchObject({ok:false,retryable:true});
  expect(await f.local.exists(f.initial.location)).toEqual({ok:true,exists:true});
});

it('keeps an uncertain redacted upload retryable when Drive is unavailable or the ID is not yet visible',async()=>{
  const f=await fixture();
  const intent={rootFolderId:'root',contentHash:hash,locator:f.location.locator,locationId:'drive-id',redacted:true};
  const redacted={...f.deps.store,async readDriveCandidate(){return {ok:true as const,candidate:{fileId:'file',contentHash:hash,sizeBytes:bytes.length,homeId:'local-id',home:f.initial.location,redacted:true}};},async readDriveIntent(){return {ok:true as const,intent};}};
  const uploads={...f.deps.uploads,async read(){return {ok:true as const,upload:{rootFolderId:'root',contentHash:hash,remoteId:'id',state:'submitting' as const,createdAt:now}};}};
  const gone={...f.deps.drive,async exists(){return {ok:true as const,exists:false};}};
  const result=await migrateFileToDrive({...f.deps,store:redacted,uploads,drive:gone},'file');
  expect(result).toMatchObject({ok:false,code:'FILES_UNAVAILABLE',retryable:true});
  expect(f.commit).not.toHaveBeenCalled();
});

it('resolves retention failures after deletion and on already deleted retry',async()=>{
  const f=await fixture(), resolveFailures=vi.fn(async()=>({ok:true as const,resolved:1}));
  const handler=driveLocalDeleteHandler({store:{...f.deps.store,...f.marker,resolveFailures},local:f.local,drive:f.deps.drive,rootFolderId:'root',clock:{now:()=>now}});
  const item={targetId:'local-id'} as WorkItem;
  expect(await handler(item)).toEqual({ok:true}); expect(await handler(item)).toEqual({ok:true});
  expect(resolveFailures).toHaveBeenCalledTimes(2);
  expect(resolveFailures).toHaveBeenCalledWith({targetKind:'file_location',targetId:'local-id',stage:'drive_local_delete',now});
});
