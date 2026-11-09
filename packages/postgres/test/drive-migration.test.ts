import { afterEach, expect, it } from 'vitest';
import { once } from 'node:events';
import { planFileRedaction } from '@second-brain/core';
import { sequenceIdGen } from '@second-brain/core/testing';
import { EXPECTED_SCHEMA_VERSIONS, postgresStore } from '../src/index.js';
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
async function redact(s:ReturnType<typeof postgresStore>) {
  const idGen=sequenceIdGen({timestampMs:at.getTime(),start:200});
  expect(await s.redactFile({fileId,plan:current=>planFileRedaction(current,{clock:{now:()=>at},idGen})})).toMatchObject({ok:true});
}
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
    const deps={store,uploads:store.driveUploads,local:localStore as unknown as import('@second-brain/core').FileStore,drive,settings:{store,schemaVersions:EXPECTED_SCHEMA_VERSIONS,clock},rootFolderId:'root',clock,idGen:ids};
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

it('lost upload response after redaction remains uncertain until verified recovery deletes the reserved remote',async()=>{
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
  const deps={store,uploads:store.driveUploads,local:{} as import('@second-brain/core').FileStore,drive,settings:{store,schemaVersions:EXPECTED_SCHEMA_VERSIONS,clock},rootFolderId:'root',clock,idGen:ids};
  const original=[...server.files.values()][0]!;server.files.delete(original.id);
  expect(await driveMigrationHandler(deps)({targetId:f} as import('@second-brain/core').WorkItem)).toMatchObject({ok:false,retryable:true});
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash:h})).toMatchObject({ok:true,upload:{state:'submitting'}});
  expect(await store.readFileLocation(remote)).toMatchObject({ok:true,location:{deletedAt:null}});
  server.files.set(original.id,{...original,bytes:Buffer.from('wrong')});
  expect(await driveMigrationHandler(deps)({targetId:f} as import('@second-brain/core').WorkItem)).toMatchObject({ok:false,retryable:true});
  server.files.set(original.id,original);
  expect(await driveMigrationHandler(deps)({targetId:f} as import('@second-brain/core').WorkItem)).toEqual({ok:true});
  expect(await deletion(blob)).toEqual({ok:true});expect(server.files.size).toBe(0);
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash:h})).toMatchObject({ok:true,upload:{state:'uploaded',remoteId:original.id}});
  expect(await db.rows(`select home_location_id,redacted_at from brain.files where id='${f}'`)).toMatchObject([{home_location_id:local,redacted_at:at}]);
  expect(await db.rows(`select verified_at from brain.file_locations where id='${remote}'`)).toEqual([{verified_at:null}]);
  expect(await db.rows(`select * from brain.drive_retention where local_location_id='${local}'`)).toEqual([]);
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
    const handler=driveLocalDeleteHandler({store:{withDriveLocalDelete:s.withDriveLocalDelete,async readDriveRetention(){return {ok:true,retention:{local,localId:'local',remote,rootFolderId:'root',contentHash:contentHashOfBytes(bytes),sizeBytes:bytes.length,dueAt:at,redacted:false,eligible:true,deleted:false}};},async markFileLocationDeleted(){throw Error('must not mark');}},local:{async delete(){deletes++;await rm(file);return {ok:true,deleted:true};}},drive:{async getBounded(){enter();await hold;return {ok:true,bytes};}},rootFolderId:'root',clock:{now:()=>at}});
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

it('resumable checkpoint uses submission and session CAS and preserves identity',async()=>{
  const {store}=await fixture();
  await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});
  await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId});
  const base={rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId};
  expect(await store.driveUploads.checkpoint({...base,expectedSessionUri:null,expectedOffset:0,sessionUri:'synthetic-session',confirmedOffset:0})).toMatchObject({ok:true,upload:{remoteId:'remote-id',sessionUri:'synthetic-session',confirmedOffset:0}});
  expect(await store.driveUploads.checkpoint({...base,expectedSessionUri:'synthetic-session',expectedOffset:0,sessionUri:'synthetic-session',confirmedOffset:10})).toMatchObject({ok:true,upload:{confirmedOffset:10}});
  expect(await store.driveUploads.checkpoint({...base,expectedSessionUri:'synthetic-session',expectedOffset:0,sessionUri:'synthetic-session',confirmedOffset:20})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.checkpoint({...base,expectedSessionUri:'synthetic-session',expectedOffset:10,sessionUri:'synthetic-session',confirmedOffset:2})).toMatchObject({ok:false});
  expect(await store.driveUploads.checkpoint({...base,expectedSessionUri:'synthetic-session',expectedOffset:10,sessionUri:'replacement',confirmedOffset:0})).toMatchObject({ok:true,upload:{remoteId:'remote-id',confirmedOffset:0}});
});

it('retention setting recomputes open work and does not revive cancelled work',async()=>{
  const {db,store}=await fixture();await begin(store);await reserve(store);await store.commitDriveMigration(input);
  const user='019a0000-0000-7000-8000-000000000109';
  await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','fixture',1,'2026-01-01Z')`);
  expect(await store.setSetting({userId:user,key:'drive.keep_local_days',value:'10',updatedAt:at})).toMatchObject({ok:true});
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:new Date(at.getTime()+10*86400000)}});
  await db.query(`update brain.work_items set completed_at='2026-01-03Z',outcome='cancelled' where id='${workId}'`);
  expect(await store.setSetting({userId:user,key:'drive.keep_local_days',value:'40',updatedAt:at})).toMatchObject({ok:true});
  expect(await db.rows(`select outcome,completed_at from brain.work_items where id='${workId}'`)).toMatchObject([{outcome:'cancelled',completed_at:new Date('2026-01-03Z')}]);
});

it('cancelled or redacted upload cannot acquire a resumable checkpoint',async()=>{
  const {db,store}=await fixture();
  await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});
  await redact(store);
  expect(await store.driveUploads.cancelReserved({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'cancelled'}});
  const checkpoint={rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId,expectedSessionUri:null,expectedOffset:0,sessionUri:'synthetic-session',confirmedOffset:0};
  expect(await store.driveUploads.checkpoint(checkpoint)).toMatchObject({ok:false});
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'cancelled',sessionUri:null}});
});

it('retention live setting shortens and extends due and stale refresh uses final DB value',async()=>{
  const {db,store}=await fixture();const user='019a0000-0000-7000-8000-000000000119';
  await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z')`);
  await begin(store);await reserve(store);expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'committed'});
  for(const days of [10,40]){
    expect(await store.setSetting({userId:user,key:'drive.keep_local_days',value:String(days),updatedAt:at})).toMatchObject({ok:true});
    const due=new Date(at.getTime()+days*86_400_000);
    expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:due}});
    expect(await db.rows(`select next_attempt_at from brain.work_items where id='${workId}'`)).toEqual([{next_attempt_at:due}]);
  }
  expect(await store.refreshDriveRetention()).toEqual({ok:true});
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:new Date(at.getTime()+40*86_400_000)}});
});

it('concurrent retention settings converge due and queue to last committed DB value',async()=>{
  const {db,store}=await fixture(),other=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>other.close());
  const user='019a0000-0000-7000-8000-000000000120';await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z')`);
  await begin(store);await reserve(store);await store.commitDriveMigration(input);
  const writes=await Promise.all([store,other].map((s,i)=>s.setSetting({userId:user,key:'drive.keep_local_days',value:i?'40':'10',updatedAt:at})));
  expect(writes).toEqual([{ok:true},{ok:true}]);const current=await store.getSetting({userId:user,key:'drive.keep_local_days'});if(!current.ok||!current.setting)throw Error('setting missing');
  const due=new Date(at.getTime()+Number(current.setting.value)*86_400_000);
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:due}});
  expect(await db.rows(`select next_attempt_at from brain.work_items where id='${workId}'`)).toEqual([{next_attempt_at:due}]);
});

it('retention extension waits for the same delete barrier and commit uses live setting',async()=>{
  const {db,store}=await fixture(),other=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>other.close());
  const user='019a0000-0000-7000-8000-000000000121';await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z')`);
  await begin(store);await reserve(store);await store.commitDriveMigration(input);
  await db.query(`update brain.work_items set claimed_by='worker',claimed_at='2026-01-02T03:04:05Z',claim_expires_at='2026-01-03Z',attempts=1 where id='${workId}'`);
  let enter!:()=>void,release!:()=>void;const entered=new Promise<void>(r=>{enter=r;}),hold=new Promise<void>(r=>{release=r;});
  const deleting=store.withDriveLocalDelete({workId,localLocationId:localId,claimedBy:'worker',claimedAt:at,attempts:1,now:at},async()=>{enter();await hold;return true;});
  try{await entered;const changing=other.setSetting({userId:user,key:'drive.keep_local_days',value:'40',updatedAt:at});await waitForAdvisoryWaiter(db);release();expect(await deleting).toMatchObject({ok:true,value:true});expect(await changing).toEqual({ok:true});}finally{release();}
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:new Date(at.getTime()+40*86_400_000)}});
});

it('uncertain delete marker blocks retention setting and refresh without changing due',async()=>{
  const {db,store}=await fixture();const user='019a0000-0000-7000-8000-000000000122';await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z')`);
  await begin(store);await reserve(store);await store.commitDriveMigration(input);
  await db.query(`insert into brain.drive_delete_barriers(work_id,created_at) values ('${workId}','2026-01-02Z')`);
  expect(await store.setSetting({userId:user,key:'drive.keep_local_days',value:'10',updatedAt:at})).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await store.refreshDriveRetention()).toMatchObject({ok:false,code:'DB_LOCKED'});
  expect(await store.getSetting({userId:user,key:'drive.keep_local_days'})).toMatchObject({ok:true,setting:null});
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:input.dueAt}});
});

it('disconnect cancellation stays terminal through later retention setting changes',async()=>{
  const {db,store}=await fixture();const user='019a0000-0000-7000-8000-000000000123',source='019a0000-0000-7000-8000-000000000124';
  await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z')`);
  await store.ensureSource({id:source,kind:'drive',account:'cancel-retention',rootId:'root'});await begin(store);await reserve(store);await store.commitDriveMigration(input);
  expect(await store.disconnectSource({id:source,now:at})).toMatchObject({ok:true});
  const before=await db.rows(`select completed_at,outcome,next_attempt_at from brain.work_items where id='${workId}'`);
  expect(before).toMatchObject([{outcome:'cancelled'}]);expect(await store.setSetting({userId:user,key:'drive.keep_local_days',value:'10',updatedAt:at})).toEqual({ok:true});
  expect(await db.rows(`select completed_at,outcome,next_attempt_at from brain.work_items where id='${workId}'`)).toEqual(before);
});

it('migration commit ignores stale requested due and uses current DB setting',async()=>{
  const {db,store}=await fixture();const user='019a0000-0000-7000-8000-000000000125';await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01Z')`);
  await begin(store);await reserve(store);expect(await store.setSetting({userId:user,key:'drive.keep_local_days',value:'40',updatedAt:at})).toEqual({ok:true});
  expect(await store.commitDriveMigration(input)).toMatchObject({ok:true,state:'committed'});
  expect(await store.readDriveRetention(localId)).toMatchObject({ok:true,retention:{dueAt:new Date(at.getTime()+40*86_400_000)}});
});

it('resumable_half_restart_and_lost_completion persists identity and resumes in a fresh process',async()=>{
  const {fork}=await import('node:child_process');const {fileURLToPath}=await import('node:url');const {contentHashOfBytes}=await import('@second-brain/core');
  const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js');
  const {db,store}=await fixture(),server=await fakeDrive();cleanup.push(()=>server.close());const bytes=new Uint8Array(20*1024*1024);bytes.fill(37);const contentHash=contentHashOfBytes(bytes);
  const child=fork(fileURLToPath(new URL('./fixtures/drive-resumable-crash-child.mjs',import.meta.url)),[],{env:{...process.env,BRAIN_TEST_DRIVE_RESUME:JSON.stringify({url:db.appUrl,baseUrl:server.baseUrl,driveModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/drive-file-store.js',import.meta.url)),now:at.toISOString()})},stdio:['ignore','ignore','inherit','ipc']});
  const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});
  try{
    expect(await Promise.race([once(child,'message').then(([m])=>m),closed.then(result=>{throw Error(`child exited before synthetic barrier: ${JSON.stringify(result)}`);})])).toBe('half-accepted');
    expect(child.kill('SIGKILL')).toBe(true);expect(await closed).toMatchObject({signal:'SIGKILL'});
    const prior=await store.driveUploads.read({rootFolderId:'root',contentHash});if(!prior.ok||!prior.upload)throw Error('upload mapping missing');
    expect(prior.upload).toMatchObject({state:'submitting',confirmedOffset:5*1024*1024});
    server.loseNextUploadResponse=true;
    const resumed=fork(fileURLToPath(new URL('./fixtures/drive-resumable-crash-child.mjs',import.meta.url)),[],{env:{...process.env,BRAIN_TEST_DRIVE_RESUME:JSON.stringify({url:db.appUrl,baseUrl:server.baseUrl,driveModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/drive-file-store.js',import.meta.url)),now:at.toISOString(),resume:true})},stdio:['ignore','ignore','inherit','ipc']});
    const resumedClosed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{resumed.once('error',reject);resumed.once('close',(code,signal)=>resolve({code,signal}));});
    try {expect(await Promise.race([once(resumed,'message').then(([m])=>m),resumedClosed.then(result=>{throw Error(`resume child exited before result: ${JSON.stringify(result)}`);})])).toMatchObject({first:false,second:true,contentHash});expect(await resumedClosed).toMatchObject({code:0});}finally{if(resumed.exitCode===null&&resumed.signalCode===null)resumed.kill('SIGKILL');await resumedClosed;}
    expect(server.statusQueries).toBeGreaterThanOrEqual(1);const final=await store.driveUploads.read({rootFolderId:'root',contentHash});expect(final).toMatchObject({ok:true,upload:{remoteId:prior.upload.remoteId,state:'uploaded'}});expect(server.files.size).toBe(1);
    expect(server.chunkRanges).toEqual(['bytes 0-5242879/20971520','bytes 5242880-10485759/20971520','bytes 10485760-15728639/20971520','bytes 15728640-20971519/20971520']);
  }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');await closed;}
},30000);

it('migration commit refuses stale claim and disconnected source generation',async()=>{
  const {db,store}=await fixture();const source='019a0000-0000-7000-8000-000000000901',migration='019a0000-0000-7000-8000-000000000105';
  await store.ensureSource({id:source,kind:'drive',account:'synthetic-fence',rootId:'watch'});await begin(store);await reserve(store);
  await db.query(`update brain.work_items set claimed_by='worker',claimed_at='2026-01-02T03:04:05Z',claim_expires_at='2026-01-03Z',attempts=1 where id='${migration}'`);
  const sourceFence={sourceId:source,generation:1},migrationClaim={workId:migration,claimedBy:'worker',claimedAt:at,attempts:1,now:at};
  expect(await store.commitDriveMigration({...input,sourceFence,migrationClaim:{...migrationClaim,attempts:2}})).toMatchObject({ok:true,state:'changed'});
  expect(await store.disconnectSource({id:source,now:at})).toMatchObject({ok:true});
  expect(await store.commitDriveMigration({...input,sourceFence,migrationClaim})).toMatchObject({ok:true,state:'changed'});
  expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);expect(await db.rows('select * from brain.drive_retention')).toEqual([]);
});

it('acknowledged remote deletion tombstone is durable and identity fenced',async()=>{
  const {store}=await fixture();await reserve(store);
  expect(await store.driveUploads.markDeleted({rootFolderId:'root',contentHash:hash,remoteId:'wrong',at})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'uploaded',deletedAt:null}});
  expect(await store.driveUploads.markDeleted({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.submitDelete({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.beginDelete({rootFolderId:'root',contentHash:hash,remoteId:'wrong',at})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.beginDelete({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at})).toMatchObject({ok:true,upload:{deleteIntentAt:at}});
  expect(await store.driveUploads.submitDelete({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at})).toMatchObject({ok:true,upload:{deleteSubmittedAt:at}});
  expect(await store.driveUploads.markDeleted({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at})).toMatchObject({ok:true,upload:{deletedAt:at}});
  expect(await store.driveUploads.markDeleted({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at:new Date(at.getTime()+1000)})).toMatchObject({ok:true,upload:{deletedAt:at}});
});

it('local delete barrier rejects cancelled claims, changed generation and expiry while waiting',async()=>{
  const {db,store}=await fixture();const source='019a0000-0000-7000-8000-000000000126';
  const created=await store.ensureSource({id:source,kind:'drive',account:'synthetic-fence',rootId:'root'});if(!created.ok)throw Error('source missing');
  await begin(store);await reserve(store);await store.commitDriveMigration(input);
  await db.query(`update brain.work_items set claimed_by='worker',claimed_at='2026-01-02T03:04:05Z',claim_expires_at='2026-01-03Z',attempts=1 where id='${workId}'`);
  const claim={workId,localLocationId:localId,claimedBy:'worker',claimedAt:at,attempts:1,now:at};let called=false;
  const run=async()=>{called=true;};
  expect(await store.withDriveLocalDelete({...claim,sourceFence:{sourceId:source,generation:created.source.generation+1}},run)).toMatchObject({ok:false});
  expect(await store.withDriveLocalDelete({...claim,nowAtBarrier:()=>new Date('2026-01-04Z')},run)).toMatchObject({ok:false});
  await db.query(`update brain.work_items set cancel_requested_at='2026-01-02Z' where id='${workId}'`);
  expect(await store.withDriveLocalDelete(claim,run)).toMatchObject({ok:false});expect(called).toBe(false);
});

it('redacted upload recovery CAS requires the bound redacted file and original submission',async()=>{
  const {db,store}=await fixture();await begin(store);
  expect(await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at})).toMatchObject({ok:true});
  expect(await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId})).toMatchObject({ok:true});
  const recovery={fileId,rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId,at};
  expect(await store.driveUploads.confirmRedacted(recovery)).toMatchObject({ok:false});
  await redact(store);
  expect(await store.driveUploads.confirmRedacted({...recovery,submissionId:'019a0000-0000-7000-8000-000000000999'})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.confirmRedacted({...recovery,remoteId:'different-id'})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.confirmRedacted({...recovery,claim:{workId,claimedBy:'stale',claimedAt:at,attempts:1,now:at}})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.confirmRedacted({...recovery,sourceFence:{sourceId:'019a0000-0000-7000-8000-000000000999',generation:1}})).toEqual({ok:true,upload:null});
  expect(await store.driveUploads.confirmRedacted(recovery)).toMatchObject({ok:true,upload:{state:'uploaded',remoteId:'remote-id',submissionId}});
  expect(await store.driveUploads.confirmRedacted(recovery)).toMatchObject({ok:true,upload:{state:'uploaded'}});
  expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);
});

it('migration claim contract renews only the live owner and connected generation',async()=>{
 const {driveMigrationClaimContract}=await import('@second-brain/core/testing');const {db,store}=await fixture();const source='019a0000-0000-7000-8000-000000000a21',work='019a0000-0000-7000-8000-000000000a22';
 await store.ensureSource({id:source,kind:'drive',account:'renew-claim',rootId:'root'});await db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${work}','drive_migrate','core','file','${fileId}','2026-01-02T03:04:05Z','2026-01-02T03:04:05Z','worker','2026-01-02T03:04:05Z','2026-01-02T03:14:05Z',1)`);
 await driveMigrationClaimContract(store,{workId:work,fileId,claimedBy:'worker',claimedAt:at,attempts:1,sourceFence:{sourceId:source,generation:1}});
 const input={workId:work,fileId,claimedBy:'worker',claimedAt:at,attempts:1,now:new Date(at.getTime()+18*60_000),sourceFence:{sourceId:source,generation:1}};
 await db.query(`update brain.work_items set cancel_requested_at='2026-01-02Z' where id='${work}'`);expect(await store.renewDriveMigration(input)).toEqual({ok:true,renewed:false});
 await db.query(`update brain.work_items set cancel_requested_at=null where id='${work}';update brain.sources set connected=false where id='${source}'`);expect(await store.renewDriveMigration(input)).toEqual({ok:true,renewed:false});
});

it.each(['retention','file'] as const)('migration commit rolls back when claim expires while waiting on %s lock',async lock=>{
 const {db,store}=await fixture();await begin(store);await reserve(store);const migration='019a0000-0000-7000-8000-000000000105';
 await db.query(`update brain.work_items set claimed_by='worker',claimed_at='2026-01-02T03:04:05Z',claim_expires_at='2026-01-02T03:14:05Z',attempts=1 where id='${migration}'`);
 const pg=(await import('pg')).default,blocker=new pg.Client({connectionString:db.url});await blocker.connect();await blocker.query('begin');
 if(lock==='retention')await blocker.query("select pg_advisory_xact_lock(hashtextextended('brain:drive-delete-disconnect',0))");else await blocker.query('select id from brain.files where id=$1::uuid for update',[fileId]);
 let now=at;const pending=store.commitDriveMigration({...input,migrationClaim:{workId:migration,claimedBy:'worker',claimedAt:at,attempts:1,now:at,nowAtLock:()=>now}});
 try {
  if(lock==='retention')await waitForAdvisoryWaiter(db);else {let waiting=false;for(let i=0;i<100;i++){const rows=await db.rows<{count:number}>("select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%brain.files%' and query like '%no key update%'");if(rows[0]?.count){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}if(!waiting)throw Error('commit did not reach file lock');}
  now=new Date('2026-01-02T03:14:06Z');await blocker.query('commit');expect(await pending).toMatchObject({ok:true,state:'changed'});
  expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);expect(await db.rows('select * from brain.drive_retention')).toEqual([]);expect(await db.rows("select id from brain.work_items where kind='drive_local_delete'")).toEqual([]);
 } finally {await blocker.query('rollback').catch(()=>{});await blocker.end();await pending;}
},30000);

it.each(['file','upload'] as const)('redacted confirmation rolls back when claim expires while waiting for %s lock',async lock=>{
 const {db,store}=await fixture();await begin(store);await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId});
 await redact(store);const migration='019a0000-0000-7000-8000-000000000105';
 await db.query(`update brain.work_items set claimed_by='worker',claimed_at='2026-01-02T03:04:05Z',claim_expires_at='2026-01-02T03:14:05Z',attempts=1 where id='${migration}'`);
 const cleanupBefore=await db.rows("select id from brain.work_items where kind in ('blob_delete','drive_local_delete') order by id");
 const pg=(await import('pg')).default,blocker=new pg.Client({connectionString:db.url});await blocker.connect();await blocker.query('begin');if(lock==='file')await blocker.query('select id from brain.files where id=$1::uuid for update',[fileId]);else await blocker.query('select remote_id from brain.drive_uploads where root_folder_id=$1 and content_hash=$2 for update',['root',hash]);
 let now=at;const pending=store.driveUploads.confirmRedacted({fileId,rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId,at,claim:{workId:migration,claimedBy:'worker',claimedAt:at,attempts:1,now:at,nowAtLock:()=>now}});
 try{let waiting=false;for(let i=0;i<100;i++){const rows=await db.rows<{count:number}>(lock==='file'?"select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%brain.files%' and query like '%no key update%'":"select count(*)::int as count from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%brain.drive_uploads%' and query like '%for update%'");if(rows[0]?.count){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}if(!waiting)throw Error('confirmation did not reach target lock');now=new Date('2026-01-02T03:14:06Z');await blocker.query('commit');expect(await pending).toEqual({ok:true,upload:null});expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'submitting'}});expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);expect(await db.rows("select id from brain.work_items where kind in ('blob_delete','drive_local_delete') order by id")).toEqual(cleanupBefore);
 }finally{await blocker.query('rollback').catch(()=>{});await blocker.end();await pending;}
},30000);

it('unacknowledged deletion remains uncertain after a new Postgres store and Drive adapter',async()=>{
 const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js');const {driveFileStore}=await import('../../../apps/cli/src/runtime/drive-file-store.js');const {contentHashOfBytes}=await import('@second-brain/core');
 const db=await database();cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());const clock={now:()=>at},bytes=Uint8Array.of(61,62),hashValue=contentHashOfBytes(bytes);
 const initial=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});const put=await initial.put(bytes);if(!put.ok)throw Error('put');
 const lost=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock,fetch:async(input,init)=>{const response=await fetch(input,init);if(init?.method==='DELETE')throw Error('synthetic lost response');return response;}});
 expect(await lost.delete(put.location)).toMatchObject({ok:false});const before=await store.driveUploads.read({rootFolderId:'root',contentHash:hashValue});expect(before).toMatchObject({ok:true,upload:{deleteIntentAt:at,deleteSubmittedAt:at,deletedAt:null}});
 const fresh=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>fresh.close());const resumed=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:fresh.driveUploads,clock});expect(await resumed.delete(put.location)).toMatchObject({ok:false});expect(await fresh.driveUploads.read({rootFolderId:'root',contentHash:hashValue})).toMatchObject({ok:true,upload:{deletedAt:null}});
});

it('redacted confirmation rolls back its upload CAS if the claim expires after the write',async()=>{
 const {db,store}=await fixture();await begin(store);await store.driveUploads.save({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',state:'reserved',at});await store.driveUploads.start({rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId});
 await redact(store);const migration='019a0000-0000-7000-8000-000000000105';
 await db.query(`update brain.work_items set claimed_by='worker',claimed_at='2026-01-02T03:04:05Z',claim_expires_at='2026-01-02T03:14:05Z',attempts=1 where id='${migration}'`);
 const cleanupBefore=await db.rows("select id from brain.work_items where kind in ('blob_delete','drive_local_delete') order by id");
 let checks=0;expect(await store.driveUploads.confirmRedacted({fileId,rootFolderId:'root',contentHash:hash,remoteId:'remote-id',submissionId,at,claim:{workId:migration,claimedBy:'worker',claimedAt:at,attempts:1,now:at,nowAtLock:()=>++checks===1?at:new Date('2026-01-02T03:14:06Z')}})).toEqual({ok:true,upload:null});
 expect(checks).toBe(2);expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hash})).toMatchObject({ok:true,upload:{state:'submitting'}});expect(await db.rows(`select home_location_id from brain.files where id='${fileId}'`)).toEqual([{home_location_id:localId}]);expect(await db.rows("select id from brain.work_items where kind in ('blob_delete','drive_local_delete') order by id")).toEqual(cleanupBefore);
});

it('Postgres upload store follows the deletion journal contract',async()=>{
 const {driveDeleteContract}=await import('@second-brain/core/testing');const {store}=await fixture();await reserve(store);await driveDeleteContract(store.driveUploads,{rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at});
});

it('handler process resumes a reclaimed fenced upload from the server offset',async()=>{
 const {fork}=await import('node:child_process'),{fileURLToPath}=await import('node:url'),{randomUUID}=await import('node:crypto');const {contentHashOfBytes}=await import('@second-brain/core');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js');
 const db=await database();cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());await store.ensureSelfUser(sampleSelfUserInput());
 const bytes=new Uint8Array(20*1024*1024);bytes.fill(37);const contentHash=contentHashOfBytes(bytes),file=randomUUID(),local=randomUUID(),source=randomUUID(),work=randomUUID();
 await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${contentHash}',${bytes.length},'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${local}','${file}','local','synthetic','brain','2026-01-01Z');update brain.files set home_location_id='${local}' where id='${file}';insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at) values ('${work}','drive_migrate','core','file','${file}','2026-01-02T03:04:05Z','2026-01-02T03:04:05Z')`);await store.ensureSource({id:source,kind:'drive',account:'handler-crash',rootId:'root'});
 const modulePath=fileURLToPath(new URL('../../../apps/cli/dist/runtime/drive-file-store.js',import.meta.url)),childPath=fileURLToPath(new URL('./fixtures/drive-handler-resume-child.mjs',import.meta.url));
 const spawn=(mode:string,generation:number,time:Date,item?:unknown)=>{const child=fork(childPath,[],{env:{...process.env,BRAIN_TEST_HANDLER_RESUME:JSON.stringify({url:db.appUrl,baseUrl:server.baseUrl,driveModule:modulePath,sourceId:source,mode,generation,now:time.toISOString(),item})},stdio:['ignore','ignore','inherit','ipc']});const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});return {child,closed};};
 const first=spawn('first',1,at);try{
  const message=await Promise.race([once(first.child,'message').then(([m])=>m as {event:string;item:unknown}),first.closed.then(result=>{throw Error(`first exited: ${JSON.stringify(result)}`);})]);expect(message.event).toBe('half-accepted');expect(first.child.kill('SIGKILL')).toBe(true);expect(await first.closed).toMatchObject({signal:'SIGKILL'});
  const before=await store.driveUploads.read({rootFolderId:'root',contentHash});if(!before.ok||!before.upload)throw Error('missing upload');expect(before.upload).toMatchObject({state:'submitting',confirmedOffset:5*1024*1024});
  await db.query(`update brain.sources set generation=2 where id='${source}'`);const later=new Date(at.getTime()+601000),requests=server.requests.length;
  const resumed=spawn('resume',2,later);try{
   const reclaimed=await Promise.race([once(resumed.child,'message').then(([m])=>m),resumed.closed.then(x=>{throw Error(`reclaim exited: ${JSON.stringify(x)}`);})]);expect(reclaimed).toMatchObject({event:'reclaimed',item:{id:work,attempts:2}});
   const stale=spawn('stale',1,later,message.item);try{const result=await Promise.race([once(stale.child,'message').then(([m])=>m),stale.closed.then(x=>{throw Error(`stale exited: ${JSON.stringify(x)}`);})]);expect(result).toMatchObject({event:'stale-result',result:{ok:false}});expect(await stale.closed).toMatchObject({code:0});expect(server.requests.length).toBe(requests);expect(await db.rows(`select home_location_id from brain.files where id='${file}'`)).toEqual([{home_location_id:local}]);expect(await store.driveUploads.read({rootFolderId:'root',contentHash})).toMatchObject({ok:true,upload:{state:'submitting',remoteId:before.upload.remoteId,sessionUri:before.upload.sessionUri}});}finally{if(stale.child.exitCode===null&&stale.child.signalCode===null)stale.child.kill('SIGKILL');await stale.closed;}
   const finished=once(resumed.child,'message');resumed.child.send('continue');const result=await Promise.race([finished.then(([m])=>m),resumed.closed.then(x=>{throw Error(`resume exited: ${JSON.stringify(x)}`);})]);expect(result).toMatchObject({event:'finished',report:{completed:1,failed:0}});expect(await resumed.closed).toMatchObject({code:0});
  }finally{if(resumed.child.exitCode===null&&resumed.child.signalCode===null)resumed.child.kill('SIGKILL');await resumed.closed;}
  expect(server.statusQueries).toBeGreaterThanOrEqual(1);expect(server.chunkRanges).toEqual(['bytes 0-5242879/20971520','bytes 5242880-10485759/20971520','bytes 10485760-15728639/20971520','bytes 15728640-20971519/20971520']);expect(server.files.size).toBe(1);
  expect(await store.driveUploads.read({rootFolderId:'root',contentHash})).toMatchObject({ok:true,upload:{remoteId:before.upload.remoteId,sessionUri:before.upload.sessionUri,state:'uploaded'}});expect(await db.rows(`select f.home_location_id=l.id as migrated from brain.files f join brain.file_locations l on l.id=f.home_location_id where f.id='${file}' and l.store_kind='drive'`)).toEqual([{migrated:true}]);expect(await db.rows(`select kind,target_id from brain.work_items where kind='drive_local_delete' and target_id='${local}'`)).toHaveLength(1);
 }finally{if(first.child.exitCode===null&&first.child.signalCode===null)first.child.kill('SIGKILL');await first.closed;}
},30000);

it.each(['claim','generation'] as const)('handler process independently fences stale %s before remote transfer or commit',async changed=>{
 const {fork}=await import('node:child_process'),{fileURLToPath}=await import('node:url'),{randomUUID}=await import('node:crypto');const {contentHashOfBytes}=await import('@second-brain/core');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js');
 const db=await database();cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());await store.ensureSelfUser(sampleSelfUserInput());const bytes=new Uint8Array(20*1024*1024);bytes.fill(37);const contentHash=contentHashOfBytes(bytes),file=randomUUID(),local=randomUUID(),source=randomUUID(),work=randomUUID();
 await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${contentHash}',${bytes.length},'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${local}','${file}','local','synthetic','brain','2026-01-01Z');update brain.files set home_location_id='${local}' where id='${file}';insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at) values ('${work}','drive_migrate','core','file','${file}','2026-01-02T03:04:05Z','2026-01-02T03:04:05Z')`);await store.ensureSource({id:source,kind:'drive',account:`fence-${changed}`,rootId:'root'});
 const modulePath=fileURLToPath(new URL('../../../apps/cli/dist/runtime/drive-file-store.js',import.meta.url)),childPath=fileURLToPath(new URL('./fixtures/drive-handler-resume-child.mjs',import.meta.url));const spawn=(mode:string,time:Date,item?:unknown)=>{const child=fork(childPath,[],{env:{...process.env,BRAIN_TEST_HANDLER_RESUME:JSON.stringify({url:db.appUrl,baseUrl:server.baseUrl,driveModule:modulePath,sourceId:source,mode,generation:1,now:time.toISOString(),item})},stdio:['ignore','ignore','inherit','ipc']});const closed=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((resolve,reject)=>{child.once('error',reject);child.once('close',(code,signal)=>resolve({code,signal}));});return {child,closed};};
 const first=spawn('first',at);try{const received=await Promise.race([once(first.child,'message').then(([m])=>m as {event:string;item:unknown}),first.closed.then(x=>{throw Error(`first exited ${JSON.stringify(x)}`);})]);expect(received.event).toBe('half-accepted');first.child.kill('SIGKILL');await first.closed;const before=await store.driveUploads.read({rootFolderId:'root',contentHash});if(!before.ok||!before.upload)throw Error('mapping');
  const later=new Date(at.getTime()+601000);if(changed==='claim'){const reclaimed=await store.claimWork({now:later,kinds:['drive_migrate'],claimedBy:'replacement'});expect(reclaimed).toMatchObject({ok:true,item:{id:work,attempts:2}});}else await db.query(`update brain.sources set generation=2 where id='${source}'`);
  const count=server.requests.length,stale=spawn('stale',changed==='claim'?later:at,received.item);try{const result=await Promise.race([once(stale.child,'message').then(([m])=>m),stale.closed.then(x=>{throw Error(`stale exited ${JSON.stringify(x)}`);})]);expect(result).toMatchObject({event:'stale-result',result:{ok:false}});expect(await stale.closed).toMatchObject({code:0});expect(server.requests.length).toBe(count);expect(await store.driveUploads.read({rootFolderId:'root',contentHash})).toMatchObject({ok:true,upload:{state:'submitting',remoteId:before.upload.remoteId,confirmedOffset:before.upload.confirmedOffset,sessionUri:before.upload.sessionUri}});expect(await db.rows(`select home_location_id from brain.files where id='${file}'`)).toEqual([{home_location_id:local}]);expect(await db.rows(`select id from brain.work_items where kind='drive_local_delete' and target_id='${local}'`)).toEqual([]);}finally{if(stale.child.exitCode===null&&stale.child.signalCode===null)stale.child.kill('SIGKILL');await stale.closed;}
 }finally{if(first.child.exitCode===null&&first.child.signalCode===null)first.child.kill('SIGKILL');await first.closed;}
},30000);

it.each(['generation','account','root','cancel','expiry'] as const)('DELETE acknowledgement is fenced after %s changes',async changed=>{
 const {sampleSelfUserInput}=await import('@second-brain/core/testing');const {db,store}=await fixture(),source='019a0000-0000-7000-8000-000000000b01',job='019a0000-0000-7000-8000-000000000b02';await store.ensureSelfUser(sampleSelfUserInput());await store.ensureSource({id:source,kind:'drive',account:'account',rootId:'watch'});await begin(store);await reserve(store);
 await db.query(`insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','account','2026-01-01Z' from brain.users where is_self=1;insert into brain.settings(user_id,key,value,updated_at) select id,'drive.root_folder_id','root','2026-01-01Z' from brain.users where is_self=1;insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${job}','blob_delete','core','file_location','${remoteId}','2026-01-01Z','2026-01-01Z','worker','2026-01-02T03:04:05Z','2026-01-03Z',1)`);
 const identity={rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at,fence:{sourceId:source,generation:1,account:'account',locationId:remoteId,workId:job,claimedBy:'worker',claimedAt:at,attempts:1,now:at}};
 expect(await store.driveUploads.beginDelete(identity)).toMatchObject({ok:true,upload:{deleteIntentAt:at}});expect(await store.driveUploads.submitDelete(identity)).toMatchObject({ok:true,upload:{deleteSubmittedAt:at}});
 if(changed==='generation')await db.query(`update brain.sources set generation=2 where id='${source}'`);if(changed==='account')await db.query("update brain.settings set value='other' where key='drive.account_id'");if(changed==='root')await db.query("update brain.settings set value='other' where key='drive.root_folder_id'");if(changed==='cancel')await db.query(`update brain.work_items set cancel_requested_at='2026-01-02Z' where id='${job}'`);
 const input=changed==='expiry'?{...identity,fence:{...identity.fence,nowAtLock:()=>new Date('2026-01-04Z')}}:identity;expect(await store.driveUploads.markDeleted(input)).toEqual({ok:true,upload:null});expect(await store.driveUploads.read(identity)).toMatchObject({ok:true,upload:{deletedAt:null}});expect(await store.readFileLocation(remoteId)).toMatchObject({ok:true,location:{deletedAt:null}});
});

it('actual DELETE ACK is persisted only while its account, root, source and blob claim remain current',async()=>{
 const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js'),{driveFileStore}=await import('../../../apps/cli/src/runtime/drive-file-store.js'),{contentHashOfBytes}=await import('@second-brain/core'),{sampleSelfUserInput}=await import('@second-brain/core/testing');const {randomUUID}=await import('node:crypto');const db=await database();cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());await store.ensureSelfUser(sampleSelfUserInput());const source=randomUUID(),file=randomUUID(),location=randomUUID(),work=randomUUID(),bytes=Uint8Array.of(90,91),hashValue=contentHashOfBytes(bytes),clock={now:()=>at};await store.ensureSource({id:source,kind:'drive',account:'account',rootId:'watch'});
 const plain=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});const put=await plain.put(bytes);if(!put.ok)throw Error('put');await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${hashValue}',2,'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${location}','${file}','drive','${put.location.locator}','brain','2026-01-01Z');insert into brain.drive_location_roots(location_id,root_folder_id,content_hash) values ('${location}','root','${hashValue}');insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','account','2026-01-01Z' from brain.users where is_self=1;insert into brain.settings(user_id,key,value,updated_at) select id,'drive.root_folder_id','root','2026-01-01Z' from brain.users where is_self=1;insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${work}','blob_delete','core','file_location','${location}','2026-01-01Z','2026-01-01Z','worker','2026-01-02T03:04:05Z','2026-01-03Z',1)`);
 const control={workId:work,locationId:location,claimedBy:'worker',claimedAt:at,attempts:1};const fenced=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock,deleteSourceFence:{sourceId:source,generation:1,account:'account'},fetch:async(input,init)=>{const response=await fetch(input,init);if(init?.method==='DELETE')await db.query(`update brain.sources set generation=2 where id='${source}'`);return response;}});
 expect(await fenced.delete(put.location,control)).toMatchObject({ok:false});expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hashValue})).toMatchObject({ok:true,upload:{deleteIntentAt:at,deleteSubmittedAt:at,deletedAt:null}});expect(await store.readFileLocation(location)).toMatchObject({ok:true,location:{deletedAt:null}});expect(await fenced.delete(put.location,control)).toMatchObject({ok:false});
});

it('observed DELETE ACK remains durable across a new adapter and Postgres connection',async()=>{
 const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js'),{driveFileStore}=await import('../../../apps/cli/src/runtime/drive-file-store.js'),{contentHashOfBytes}=await import('@second-brain/core');const db=await database();cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());const clock={now:()=>at},bytes=Uint8Array.of(93),hashValue=contentHashOfBytes(bytes),plain=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});const put=await plain.put(bytes);if(!put.ok)throw Error('put');let lose=true;
 const wrapped={...store.driveUploads,async markDeleted(i:Parameters<typeof store.driveUploads.markDeleted>[0]){const result=await store.driveUploads.markDeleted(i);if(lose){lose=false;return {ok:false as const,message:'synthetic lost acknowledgement'};}return result;}};const first=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:wrapped,clock});expect(await first.delete(put.location)).toMatchObject({ok:false});expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hashValue})).toMatchObject({ok:true,upload:{deletedAt:at}});
 const fresh=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>fresh.close());const restarted=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:fresh.driveUploads,clock});expect(await restarted.delete(put.location)).toEqual({ok:true,deleted:false});expect(server.requests.filter(r=>r.method==='DELETE')).toHaveLength(1);
});

it('DELETE submission rechecks claim after the upload row lock and sends no HTTP DELETE when it expires',async()=>{
 const {fakeDrive}=await import('../../../apps/cli/test/fixtures/fake-drive.js'),{driveFileStore}=await import('../../../apps/cli/src/runtime/drive-file-store.js'),{contentHashOfBytes}=await import('@second-brain/core'),{sampleSelfUserInput}=await import('@second-brain/core/testing');const {randomUUID}=await import('node:crypto');
 const db=await database();cleanup.push(()=>db.drop());const server=await fakeDrive();cleanup.push(()=>server.close());const store=postgresStore({databaseUrl:db.appUrl});cleanup.push(()=>store.close());await store.ensureSelfUser(sampleSelfUserInput());const source=randomUUID(),file=randomUUID(),location=randomUUID(),work=randomUUID(),bytes=Uint8Array.of(95,96),hashValue=contentHashOfBytes(bytes);let current=at;const clock={now:()=>current};await store.ensureSource({id:source,kind:'drive',account:'account',rootId:'watch'});
 const plain=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});const put=await plain.put(bytes);if(!put.ok)throw Error('put');await db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${hashValue}',2,'2026-01-01Z');insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${location}','${file}','drive','${put.location.locator}','brain','2026-01-01Z');insert into brain.drive_location_roots(location_id,root_folder_id,content_hash) values ('${location}','root','${hashValue}');insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','account','2026-01-01Z' from brain.users where is_self=1;insert into brain.settings(user_id,key,value,updated_at) select id,'drive.root_folder_id','root','2026-01-01Z' from brain.users where is_self=1;insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${work}','blob_delete','core','file_location','${location}','2026-01-01Z','2026-01-01Z','worker','2026-01-02T03:04:05Z','2026-01-02T03:14:05Z',1)`);
 const pg=(await import('pg')).default,blocker=new pg.Client({connectionString:db.url});await blocker.connect();await blocker.query('begin');let locked!:()=>void;const entered=new Promise<void>(resolve=>{locked=resolve;});
 const uploads={...store.driveUploads,async beginDelete(input:Parameters<typeof store.driveUploads.beginDelete>[0]){const result=await store.driveUploads.beginDelete(input);await blocker.query('select remote_id from brain.drive_uploads where root_folder_id=$1 and content_hash=$2 for update',['root',hashValue]);locked();return result;}};
 const adapter=driveFileStore({rootFolderId:'root',baseUrl:server.baseUrl,uploads,clock,deleteSourceFence:{sourceId:source,generation:1,account:'account'}});const pending=adapter.delete(put.location,{workId:work,locationId:location,claimedBy:'worker',claimedAt:at,attempts:1});
 try{await entered;let waiting=false;for(let i=0;i<100;i++){const rows=await db.rows<{n:number}>("select count(*)::int as n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%brain.drive_uploads%' and query like '%for update%'");if(rows[0]?.n){waiting=true;break;}await new Promise(resolve=>setTimeout(resolve,20));}if(!waiting)throw Error('submit did not wait on upload row');current=new Date('2026-01-02T03:14:06Z');await blocker.query('commit');expect(await pending).toMatchObject({ok:false});expect(server.requests.filter(r=>r.method==='DELETE')).toHaveLength(0);expect(await store.driveUploads.read({rootFolderId:'root',contentHash:hashValue})).toMatchObject({ok:true,upload:{deleteSubmittedAt:null,deletedAt:null}});expect(await store.readFileLocation(location)).toMatchObject({ok:true,location:{deletedAt:null}});
 }finally{await blocker.query('rollback').catch(()=>{});await blocker.end();await pending;}
},30000);

it('DELETE submission rolls back its journal if claim expires after its update',async()=>{
 const {sampleSelfUserInput}=await import('@second-brain/core/testing');const {db,store}=await fixture(),source='019a0000-0000-7000-8000-000000000c01',job='019a0000-0000-7000-8000-000000000c02';await store.ensureSelfUser(sampleSelfUserInput());await store.ensureSource({id:source,kind:'drive',account:'account',rootId:'watch'});await begin(store);await reserve(store);
 await db.query(`insert into brain.settings(user_id,key,value,updated_at) select id,'drive.account_id','account','2026-01-01Z' from brain.users where is_self=1;insert into brain.settings(user_id,key,value,updated_at) select id,'drive.root_folder_id','root','2026-01-01Z' from brain.users where is_self=1;insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at,attempts) values ('${job}','blob_delete','core','file_location','${remoteId}','2026-01-01Z','2026-01-01Z','worker','2026-01-02T03:04:05Z','2026-01-02T03:14:05Z',1)`);
 const identity={rootFolderId:'root',contentHash:hash,remoteId:'remote-id',at,fence:{sourceId:source,generation:1,account:'account',locationId:remoteId,workId:job,claimedBy:'worker',claimedAt:at,attempts:1,now:at}};expect(await store.driveUploads.beginDelete(identity)).toMatchObject({ok:true,upload:{deleteIntentAt:at}});let checks=0;
 expect(await store.driveUploads.submitDelete({...identity,fence:{...identity.fence,nowAtLock:()=>++checks<3?at:new Date('2026-01-02T03:14:06Z')}})).toEqual({ok:true,upload:null});expect(checks).toBe(3);expect(await store.driveUploads.read(identity)).toMatchObject({ok:true,upload:{deleteSubmittedAt:null,deletedAt:null}});
});
