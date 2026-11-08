import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { planFileRedaction } from '@second-brain/core';
import { sequenceIdGen } from '@second-brain/core/testing';
import { postgresStore } from '../src/index.js';
import { database } from './fixture.js';

const fileId='019a0000-0000-7000-8000-000000000101', localId='019a0000-0000-7000-8000-000000000102', remoteId='019a0000-0000-7000-8000-000000000103', workId='019a0000-0000-7000-8000-000000000104';
const submissionId='019a0000-0000-7000-8000-000000000106';
const hash='sha256:'+'a'.repeat(64), at=new Date('2026-01-02T03:04:05Z');
const cleanup:(()=>Promise<unknown>)[]=[];
async function waitForAdvisoryWaiter(db: import('@second-brain/test-db').TestDatabase) {
  for (let i=0;i<100;i++) {
    const rows=await db.rows<{count:number}>("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and wait_event='advisory'");
    if (rows[0]?.count) return;
    await new Promise(resolve=>setTimeout(resolve,20));
  }
  throw new Error('disconnect did not reach the advisory lock');
}
afterEach(async()=>{for(const close of cleanup.splice(0).reverse()) await close();});
async function fixture() {
  const db=await database(); cleanup.push(()=>db.drop());
  const store=postgresStore({databaseUrl:db.appUrl}); cleanup.push(()=>store.close());
  await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${fileId}','${hash}',1,'2026-01-01Z');
    insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${localId}','${fileId}','local','aa/aa/${'a'.repeat(64)}','brain','2026-01-01Z');
    update brain.files set home_location_id='${localId}' where id='${fileId}'`);
  return {db,store};
}
const input={fileId,expectedHomeId:localId,contentHash:hash,rootFolderId:'root',remoteId:'remote-id',locationId:remoteId,locator:'a'.repeat(64),workId,verifiedAt:at,dueAt:new Date('2026-02-01T03:04:05Z')};
async function reserve(s:ReturnType<typeof postgresStore>) { await s.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at}); await s.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId}); return s.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'uploaded',at,submissionId}); }
it('concurrent reservation converges to a single immutable remote id',async()=>{
  const {store,db}=await fixture(); const other=postgresStore({databaseUrl:db.appUrl}); cleanup.push(()=>other.close());
  const candidates=await Promise.all([store,other].map((s,i)=>s.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:`id-${i}`,state:'reserved',at})));
  expect(candidates.every(x=>x.ok)).toBe(true);
  if (!candidates[0]?.ok || !candidates[1]?.ok) throw Error('save');
  expect(candidates[0].upload?.remoteId).toEqual(candidates[1].upload?.remoteId);
});
async function begin(s:ReturnType<typeof postgresStore>) {
  return s.beginDriveMigration({fileId,expectedHomeId:localId,contentHash:hash,rootFolderId:'root',locationId:remoteId,locator:'a'.repeat(64),workId:'019a0000-0000-7000-8000-000000000105',at});
}
it('CAS publishes verified home and delayed deletion together',async()=>{
  const {db,store}=await fixture(); await begin(store);
  expect(await db.rows(`select state from brain.drive_migration_intents where file_id='${fileId}'`)).toEqual([{state:'active'}]);
  await reserve(store);
  expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'committed',locationId:remoteId});
  expect(await db.rows(`select f.home_location_id,l.verified_at,r.due_at,w.kind,w.next_attempt_at from brain.files f join brain.file_locations l on l.id=f.home_location_id join brain.drive_retention r on r.drive_location_id=l.id join brain.work_items w on w.target_id=r.local_location_id::text where f.id='${fileId}'`)).toMatchObject([{home_location_id:remoteId,verified_at:at,due_at:input.dueAt,kind:'drive_local_delete',next_attempt_at:input.dueAt}]);
  expect(await db.rows(`select uploaded_at,remote_checksum from brain.file_locations where id='${remoteId}'`)).toEqual([{uploaded_at:at,remote_checksum:hash}]);
  await expect(db.query(`update brain.file_locations set remote_checksum='other' where id='${remoteId}'`)).rejects.toThrow('invariant refused');
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{eligible:true,redacted:false,contentHash:hash}});
  expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'changed'});
});
it('mismatched CAS and late write failure cannot partially publish',async()=>{
  const {db,store}=await fixture(); await reserve(store);
  expect(await store.commitDriveMigration({...input,expectedHomeId:remoteId})).toMatchObject({ok:true,state:'changed'});
  await begin(store);
  await db.query('revoke insert on brain.work_items from brain_app');
  expect(await store.commitDriveMigration(input)).toMatchObject({ok:false});
  expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);
  expect(await db.rows("select id,verified_at,uploaded_at,remote_checksum from brain.file_locations where store_kind='drive'")).toEqual([{id:remoteId,verified_at:null,uploaded_at:null,remote_checksum:null}]);
  expect(await db.rows('select * from brain.drive_retention')).toEqual([]);
});
it('redaction wins CAS and queues only remote redaction cleanup',async()=>{
  const {db,store}=await fixture(); await begin(store); await reserve(store);
  const ids=sequenceIdGen({timestampMs:at.getTime(),start:200});
  expect(await store.redactFile({fileId,plan: current=>planFileRedaction(current,{clock:{now:()=>at},idGen:ids})})).toMatchObject({ok:true});
  expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'redacted'});
  expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);
  expect(await db.rows('select verified_at from brain.file_locations where store_kind=\'drive\'')).toEqual([{verified_at:null}]);
  expect(await db.rows(`select kind,target_id from brain.work_items where kind='blob_delete' and target_id='${remoteId}'`)).toEqual([{kind:'blob_delete',target_id:remoteId}]);
  expect(await db.rows('select * from brain.drive_retention')).toEqual([]);
});

it('SIGKILL after upload and redaction before CAS resumes durable cleanup',async()=>{
  const {fork}=await import('node:child_process');
  const {fileURLToPath}=await import('node:url');
  const {randomUUID}=await import('node:crypto');
  const {contentHashOfBytes,driveMigrationHandler,blobDeleteHandler}=await import('@second-brain/core');
  const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js');
  const {driveFileStore}=await import('../../../apps/cli/src/runtime/drive-file-store.js');
  const {sampleSelfUserInput}=await import('@second-brain/core/testing');
  const db=await database(); cleanup.push(()=>db.drop());
  const server=await fakeDrive(); cleanup.push(()=>server.close());
  const store=postgresStore({databaseUrl:db.appUrl}); cleanup.push(()=>store.close());
  await store.ensureSelfUser(sampleSelfUserInput());
  const bytes=Uint8Array.of(21,22,23), realHash=contentHashOfBytes(bytes), f=randomUUID(), local=randomUUID();
  await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${f}','${realHash}',3,'2026-01-01Z');
    insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${local}','${f}','local','local-fixture','brain','2026-01-01Z');
    update brain.files set home_location_id='${local}' where id='${f}'`);
  const child=fork(fileURLToPath(new URL('./fixtures/drive-crash-child.mjs',import.meta.url)),[],{
    env:{...process.env,BRAIN_TEST_DRIVE_CRASH:JSON.stringify({url:db.appUrl,baseUrl:server.baseUrl,driveModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/drive-file-store.js',import.meta.url)),fileId:f,bytes:[...bytes],now:at.toISOString()})},stdio:['ignore','ignore','inherit','ipc'],
  });
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  try {
    expect(await Promise.race([once(child,'message').then(([message])=>message),closed.then(result=>{throw Error(`drive crash child exited before barrier: ${JSON.stringify(result)}`);})])).toBe('uploaded-before-cas');
    expect(child.kill('SIGKILL')).toBe(true); expect(await closed).toMatchObject({signal:'SIGKILL'});
    expect(server.files.size).toBe(1);
    expect(await db.rows(`select kind,target_id from brain.work_items where kind='drive_migrate' and target_id='${f}'`)).toHaveLength(1);
    const ids=sequenceIdGen({timestampMs:at.getTime(),start:200}), clock={now:()=>at};
    expect(await store.redactFile({fileId:f,plan:current=>planFileRedaction(current,{clock,idGen:ids})})).toMatchObject({ok:true});
    expect(await store.markFileLocationDeleted({id:local,deletedAt:at})).toMatchObject({ok:true});
    const intent=await store.readDriveIntent(f); if (!intent.ok || !intent.intent) throw Error('intent missing');
    const drive=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});
    const localStore={get:async()=>({ok:false as const,code:'FILE_NOT_FOUND' as const,message:'already removed'}),delete:async()=>({ok:true as const,deleted:true})};
    const deps={store,uploads:store.driveUploads,local:localStore as unknown as import('@second-brain/core').FileStore,drive,settings:{store,schemaVersions:{core:43},clock},rootFolderId:'root',clock,idGen:ids};
    const work={targetId:f} as import('@second-brain/core').WorkItem;
    expect(await driveMigrationHandler(deps)(work)).toEqual({ok:true});
    const cleanupDrive=blobDeleteHandler({store,files:localStore,driveFiles:drive,driveRoot:{store,rootFolderId:'root'},clock});
    const blob={targetId:intent.intent.locationId} as import('@second-brain/core').WorkItem;
    expect(await cleanupDrive(blob)).toEqual({ok:true});
    expect(await cleanupDrive(blob)).toEqual({ok:true});
    expect(server.files.size).toBe(0);
    expect(await db.rows(`select home_location_id,redacted_at from brain.files where id='${f}'`)).toMatchObject([{home_location_id:local,redacted_at:at}]);
    expect(await db.rows('select verified_at from brain.file_locations where id=\''+intent.intent.locationId+'\'')).toEqual([{verified_at:null}]);
    expect(await db.rows('select * from brain.drive_retention')).toEqual([]);
  } finally {if (child.exitCode===null && child.signalCode===null) child.kill('SIGKILL'); await closed;}
},30000);

it('lost upload response after redaction stays durably uncertain without marking deletion',async()=>{
  const {randomUUID}=await import('node:crypto');
  const {contentHashOfBytes,driveBrainLocator,driveMigrationHandler,blobDeleteHandler}=await import('@second-brain/core');
  const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js');
  const {driveFileStore}=await import('../../../apps/cli/src/runtime/drive-file-store.js');
  const {db,store}=await fixture();
  const server=await fakeDrive(); cleanup.push(()=>server.close());
  const bytes=Uint8Array.of(31,32,33), h=contentHashOfBytes(bytes), f=randomUUID(), local=randomUUID(), remote=randomUUID(), work=randomUUID();
  await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${f}','${h}',3,'2026-01-01Z');
    insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${local}','${f}','local','synthetic','brain','2026-01-01Z');
    update brain.files set home_location_id='${local}' where id='${f}'`);
  const clock={now:()=>at}, ids=sequenceIdGen({timestampMs:at.getTime(),start:400});
  const locator=driveBrainLocator(h.slice(7),bytes);
  expect(await store.beginDriveMigration({fileId:f,expectedHomeId:local,contentHash:h,rootFolderId:'root',locationId:remote,locator,workId:work,at})).toMatchObject({ok:true,state:'ready'});
  const drive=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});
  server.loseNextUploadResponse=true;
  expect(await drive.put(bytes)).toMatchObject({ok:false});
  expect(server.files.size).toBe(1);
  expect(await store.redactFile({fileId:f,plan:current=>planFileRedaction(current,{clock,idGen:ids})})).toMatchObject({ok:true});
  const deletion=blobDeleteHandler({store,files:{delete:async()=>({ok:true,deleted:true})},driveFiles:drive,driveRoot:{store,rootFolderId:'root'},clock});
  const blob={targetId:remote} as import('@second-brain/core').WorkItem;
  expect(await deletion(blob)).toMatchObject({ok:false,code:'FILES_UNAVAILABLE',retryable:true});
  expect(await store.readFileLocation(remote)).toMatchObject({ok:true,location:{deletedAt:null}});
  const deps={store,uploads:store.driveUploads,local:{} as import('@second-brain/core').FileStore,drive,settings:{store,schemaVersions:{core:43},clock},rootFolderId:'root',clock,idGen:ids};
  expect(await driveMigrationHandler(deps)({targetId:f} as import('@second-brain/core').WorkItem)).toMatchObject({ok:false,retryable:true});
  expect(await deletion(blob)).toMatchObject({ok:false,code:'FILES_UNAVAILABLE',retryable:true});
  expect(server.files.size).toBe(1);
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash:h})).toMatchObject({ok:true,upload:{state:'submitting'}});
  expect(await store.readFileLocation(remote)).toMatchObject({ok:true,location:{deletedAt:null}});
  expect(await store.driveUploads.save({rootFolderId:'root',contentHash:h,remoteId:'new',state:'reserved',at})).toMatchObject({ok:false});
});

it('redaction before ID reservation fences an in-flight uploader without creating a remote identity',async()=>{
  const {db,store}=await fixture();
  expect(await store.beginDriveMigration({fileId,expectedHomeId:localId,contentHash:hash,rootFolderId:'root',locationId:remoteId,locator:'a'.repeat(64),workId,at})).toMatchObject({ok:true,state:'ready'});
  const ids=sequenceIdGen({timestampMs:at.getTime(),start:500});
  expect(await store.redactFile({fileId,plan:current=>planFileRedaction(current,{clock:{now:()=>at},idGen:ids})})).toMatchObject({ok:true});
  expect(await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'late-id',state:'reserved',at})).toMatchObject({ok:false});
  expect(await db.rows('select * from brain.drive_uploads')).toEqual([]);
  expect(await db.rows(`select kind,target_id from brain.work_items where kind='blob_delete' and target_id='${remoteId}'`)).toHaveLength(1);
  expect(await db.rows(`select kind,target_id from brain.work_items where kind='drive_migrate' and target_id='${fileId}'`)).toHaveLength(1);
});

it('POST 이전에 중단된 예약은 가리기 후 취소되고 지연 제출을 거부한다',async()=>{
  const {store}=await fixture(); await begin(store);
  expect(await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at})).toMatchObject({ok:true,upload:{state:'reserved'}});
  const ids=sequenceIdGen({timestampMs:at.getTime(),start:800}), clock={now:()=>at};
  expect(await store.redactFile({fileId,plan:current=>planFileRedaction(current,{clock,idGen:ids})})).toMatchObject({ok:true});
  const cancelled=await store.driveUploads.cancelReserved({rootFolderId:'root',contentHash:hash});
  expect(cancelled).toMatchObject({ok:true,upload:{state:'cancelled'}});
  expect(await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId})).toMatchObject({ok:false});
  expect(await store.readDriveLocationRoot(remoteId)).toEqual({ok:true,rootFolderId:'root'});
});

it('제출된 요청이 보이지 않으면 시간 경과만으로 취소나 삭제 완료로 처리하지 않는다',async()=>{
  const {store}=await fixture(); await begin(store);
  await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});
  expect(await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId})).toMatchObject({ok:true,claimed:true,upload:{state:'submitting'}});
  const ids=sequenceIdGen({timestampMs:at.getTime(),start:900}), clock={now:()=>new Date(at.getTime()+365*86400000)};
  expect(await store.redactFile({fileId,plan:current=>planFileRedaction(current,{clock,idGen:ids})})).toMatchObject({ok:true});
  expect(await store.driveUploads.cancelReserved({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'submitting'}});
  expect(await store.readFileLocation(remoteId)).toMatchObject({ok:true,location:{deletedAt:null}});
});

it('한 root/hash의 제출 권리는 동시에 하나만 부여한다',async()=>{
  const {db,store}=await fixture(); const other=postgresStore({databaseUrl:db.appUrl}); cleanup.push(()=>other.close());
  await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});
  const rights=await Promise.all([store,other].map(s=>s.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId})));
  expect(rights.filter(r=>r.ok && r.claimed)).toHaveLength(1);
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'submitting'}});
});

it('검증보다 앞선 업로드 완료 시각과 원격 해시를 한 번만 채운다',async()=>{
  const {db,store}=await fixture(); await begin(store); await reserve(store);
  const verified=new Date(at.getTime()+5000), dueAt=new Date(verified.getTime()+30*86400000);
  expect(await store.commitDriveMigration({...input,verifiedAt:verified,dueAt})).toMatchObject({ok:true,state:'committed'});
  expect(await db.rows(`select uploaded_at,remote_checksum,verified_at from brain.file_locations where id='${remoteId}'`)).toEqual([{uploaded_at:at,remote_checksum:hash,verified_at:verified}]);
  await expect(db.query(`update brain.file_locations set uploaded_at='2027-01-01Z' where id='${remoteId}'`)).rejects.toThrow('invariant refused');
});

it('제출을 소유하지 않은 토큰은 업로드 완료를 확정하지 못한다',async()=>{
  const {store}=await fixture();
  await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});
  await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId});
  expect(await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'uploaded',at,submissionId:'019a0000-0000-7000-8000-000000000199'})).toMatchObject({ok:true,upload:{state:'submitting'}});
  expect(await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'uploaded',at,submissionId})).toMatchObject({ok:true,upload:{state:'uploaded'}});
});

it('serializes disconnect with an in-flight local-delete barrier and refuses a cancelled late worker',async()=>{
  const {subject}=await import('./fixture.js');const {postgresStore}=await import('../src/index.js');
  const s=await subject();const other=postgresStore({databaseUrl:s.db.appUrl});
  const sourceId='019a0000-0000-7000-8000-000000000071', workId='019a0000-0000-7000-8000-000000000072';
  const at=new Date('2026-01-01T00:00:00Z');
  try {
    await s.ensureSource({id:sourceId,kind:'drive',account:'synthetic-barrier',rootId:'watch-root'});
    await s.db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${workId}','drive_local_delete','core','file_location','local','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z',1)`);
    let entered!:()=>void, release!:()=>void;const started=new Promise<void>(r=>{entered=r;});const hold=new Promise<void>(r=>{release=r;});const order:string[]=[];
    const deleting=s.withDriveLocalDelete({workId,localLocationId:'local',claimedBy:'worker',claimedAt:at,attempts:1,now:at},async()=>{entered();await hold;order.push('delete-finished');return true;});
    await started;const disconnect=other.disconnectSource({id:sourceId,now:at}).then(x=>{order.push('disconnect-finished');return x;});
    await waitForAdvisoryWaiter(s.db);release();expect(await deleting).toMatchObject({ok:true,value:true});expect(await disconnect).toMatchObject({ok:true,source:{connected:false}});expect(order).toEqual(['delete-finished','disconnect-finished']);
    expect(await s.withDriveLocalDelete({workId,localLocationId:'local',claimedBy:'worker',claimedAt:at,attempts:1,now:at},async()=>{throw Error('must not delete');})).toMatchObject({ok:false});
    expect(await s.db.rows(`select outcome from brain.work_items where id='${workId}'`)).toEqual([{outcome:'cancelled'}]);
    expect(await s.db.rows('select * from brain.drive_delete_barriers')).toEqual([]);
  } finally {await other.close();await s.close();}
});

it('retains uncertain deletion marker and refuses disconnect',async()=>{
  const {subject}=await import('./fixture.js');const s=await subject();const sourceId='019a0000-0000-7000-8000-000000000073',workId='019a0000-0000-7000-8000-000000000074';const at=new Date('2026-01-01T00:00:00Z');
  try {
    await s.ensureSource({id:sourceId,kind:'drive',account:'synthetic-uncertain',rootId:'watch-root'});
    await s.db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${workId}','drive_local_delete','core','file_location','local','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z',1)`);
    expect(await s.withDriveLocalDelete({workId,localLocationId:'local',claimedBy:'worker',claimedAt:at,attempts:1,now:at},async()=>{throw Error('synthetic interrupted I/O');})).toMatchObject({ok:false});
    expect(await s.disconnectSource({id:sourceId,now:at})).toMatchObject({ok:false,code:'DB_LOCKED'});
    expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{connected:true}});
    expect(await s.db.rows('select work_id::text from brain.drive_delete_barriers')).toEqual([{work_id:workId}]);
  } finally {await s.close();}
});

it('disconnect completes while remote verification is held and the actual handler preserves the local file',async()=>{
  const {subject}=await import('./fixture.js');const {driveLocalDeleteHandler,contentHashOfBytes}=await import('@second-brain/core');
  const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const s=await subject(),other=postgresStore({databaseUrl:s.db.appUrl}),dir=await mkdtemp(join(tmpdir(),'drive-late-delete-')),file=join(dir,'copy');
  const sourceId='019a0000-0000-7000-8000-000000000077',workId='019a0000-0000-7000-8000-000000000078',at=new Date('2026-01-01T00:00:00Z'),bytes=Uint8Array.of(1,2,3);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),hold=new Promise<void>(r=>{release=r;});let deletes=0;
  try {
    await writeFile(file,bytes);await s.ensureSource({id:sourceId,kind:'drive',account:'late-delete',rootId:'watch-root'});
    await s.db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${workId}','drive_local_delete','core','file_location','local','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z',1)`);
    const local={storeKind:'local' as const,ownership:'brain' as const,locator:'copy'},remote={storeKind:'drive' as const,ownership:'brain' as const,locator:'remote'};
    const handler=driveLocalDeleteHandler({store:{withDriveLocalDelete:s.withDriveLocalDelete,async readDriveRetention(){return {ok:true,retention:{local,localId:'local',remote,rootFolderId:'root',contentHash:contentHashOfBytes(bytes),dueAt:at,redacted:false,eligible:true,deleted:false}};},async markFileLocationDeleted(){throw Error('must not mark');}},local:{async delete(){deletes++;await rm(file);return {ok:true,deleted:true};}},drive:{async get(){enter();await hold;return {ok:true,bytes};}},rootFolderId:'root',clock:{now:()=>at}});
    const running=handler({id:workId,targetId:'local',claimedBy:'worker',claimedAt:at,attempts:1} as import('@second-brain/core').WorkItem);
    await entered;expect(await other.disconnectSource({id:sourceId,now:at})).toMatchObject({ok:true,source:{connected:false}});release();expect(await running).toMatchObject({ok:false});expect(deletes).toBe(0);expect(await readFile(file)).toEqual(Buffer.from(bytes));
    expect(await s.db.rows(`select outcome from brain.work_items where id='${workId}'`)).toEqual([{outcome:'cancelled'}]);
  } finally {release();await other.close();await s.close();await rm(dir,{recursive:true,force:true});}
});

it('a separate process holds the deletion barrier through actual file I/O',async()=>{
  const {subject}=await import('./fixture.js');const {fork}=await import('node:child_process');const {mkdtemp,writeFile,access,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {fileURLToPath}=await import('node:url');
  const s=await subject(),dir=await mkdtemp(join(tmpdir(),'drive-barrier-')),file=join(dir,'owned-copy');const sourceId='019a0000-0000-7000-8000-000000000075',workId='019a0000-0000-7000-8000-000000000076',at=new Date('2026-01-01T00:00:00Z');
  const child=fork(fileURLToPath(new URL('./fixtures/drive-delete-barrier-child.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']});
  try {
    await writeFile(file,'synthetic');await s.ensureSource({id:sourceId,kind:'drive',account:'process-test',rootId:'watch-root'});
    await s.db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${workId}','drive_local_delete','core','file_location','local','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z',1)`);
    const entered=once(child,'message');child.send({url:s.db.appUrl,workId,at:at.toISOString(),file});expect((await entered)[0]).toBe('entered');
    const disconnect=s.disconnectSource({id:sourceId,now:at});const result=once(child,'message');await waitForAdvisoryWaiter(s.db);child.send('release');
    expect((await result)[0]).toMatchObject({result:{ok:true,value:'deleted'}});expect(await disconnect).toMatchObject({ok:true,source:{connected:false}});await expect(access(file)).rejects.toMatchObject({code:'ENOENT'});
  } finally {if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await rm(dir,{recursive:true,force:true});await s.close();}
});

it.each(['killed-worker','lost-session'] as const)('keeps an uncertain deletion marker after %s and preserves unrelated files',async mode=>{
  const {subject}=await import('./fixture.js');const {fork}=await import('node:child_process');const {mkdtemp,writeFile,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');const {fileURLToPath}=await import('node:url');
  const s=await subject(),dir=await mkdtemp(join(tmpdir(),'drive-marker-loss-')),file=join(dir,'owned'),other=join(dir,'other');const sourceId='019a0000-0000-7000-8000-000000000175',work='019a0000-0000-7000-8000-000000000176',time=new Date('2026-01-01T00:00:00Z');
  const child=fork(fileURLToPath(new URL('./fixtures/drive-delete-barrier-child.mjs',import.meta.url)),[],{stdio:['ignore','ignore','pipe','ipc']});
  try {
    await writeFile(file,'synthetic-owned');await writeFile(other,'synthetic-other');await s.ensureSource({id:sourceId,kind:'drive',account:'loss-test',rootId:'root'});
    await s.db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${work}','drive_local_delete','core','file_location','local','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z',1)`);
    const entered=once(child,'message');child.send({url:s.db.appUrl,workId:work,at:time.toISOString(),file});expect((await entered)[0]).toBe('entered');expect(await s.db.rows('select work_id::text from brain.drive_delete_barriers')).toEqual([{work_id:work}]);
    if(mode==='killed-worker') {const closed=once(child,'close');child.kill('SIGKILL');await closed;}
    else {
      const sessions=await s.db.rows<{pid:number}>("select pid from pg_stat_activity where datname=current_database() and usename='brain_app' and query like 'insert into brain.drive_delete_barriers%' and state='idle'");expect(sessions).toHaveLength(1);
      await s.db.query(`select pg_terminate_backend(${sessions[0]!.pid})`);expect(child.exitCode).toBeNull();
    }
    expect(await s.disconnectSource({id:sourceId,now:time})).toMatchObject({ok:false,code:'DB_LOCKED'});
    if(mode==='lost-session'){const result=once(child,'message'),closed=once(child,'close');child.send('release');expect((await result)[0]).toMatchObject({result:{ok:false}});await closed;await expect(readFile(file,'utf8')).rejects.toMatchObject({code:'ENOENT'});}
    expect(await s.db.rows('select work_id::text from brain.drive_delete_barriers')).toEqual([{work_id:work}]);expect(await readFile(other,'utf8')).toBe('synthetic-other');
    if(mode==='killed-worker')expect(await readFile(file,'utf8')).toBe('synthetic-owned');
    // Only an operator who has checked the local result may clear this owned marker.
    const pg=(await import('pg')).default,admin=new pg.Client({connectionString:s.db.url});await admin.connect();try{await admin.query("select pg_advisory_lock(hashtextextended('brain:drive-delete-disconnect',0))");await admin.query('delete from brain.drive_delete_barriers where work_id=$1::uuid',[work]);await admin.query("select pg_advisory_unlock(hashtextextended('brain:drive-delete-disconnect',0))");}finally{await admin.end();}expect(await s.disconnectSource({id:sourceId,now:time})).toMatchObject({ok:true});
  } finally {if(child.exitCode===null&&child.signalCode===null){const closed=once(child,'close');child.kill('SIGKILL');await closed;}await rm(dir,{recursive:true,force:true});await s.close();}
},120000);
