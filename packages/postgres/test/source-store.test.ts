import { afterEach, it } from 'vitest';
import { sourceStoreContract } from '@second-brain/core/testing';
import { subject } from './fixture.js';
const sourceId='019a0000-0000-7000-8000-000000000001', workId='019a0000-0000-7000-8000-000000000005';
const claim={workId,claimedBy:'worker',claimedAt:new Date('2026-01-01T00:00:00Z'),attempts:0,now:new Date('2026-01-01T00:00:00Z')};
const cleanup:(()=>Promise<void>)[]=[];afterEach(async()=>{for(const f of cleanup.splice(0))await f();});
for(const test of sourceStoreContract()) it(test.name,()=>test.run(async()=>{const s=await subject();cleanup.push(()=>s.close());await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-01T00:10:00Z')`);return {store:s,claim};}));

it('fences handoff and publication and preserves open attempt observation',async()=>{
  const s=await subject();cleanup.push(()=>s.close());
  const file='019a0000-0000-7000-8000-000000000011', sourceFile='019a0000-0000-7000-8000-000000000012', scan='019a0000-0000-7000-8000-000000000013', work='019a0000-0000-7000-8000-000000000014', extraction='019a0000-0000-7000-8000-000000000015';
  const hash='sha256:'+'a'.repeat(64);
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
  const {expect}=await import('vitest');
  expect((await s.ensureSource({id:sourceId,kind:'drive',account:'a',rootId:'root'})).ok).toBe(true);
  expect((await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim})).ok).toBe(true);
  expect((await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id:sourceFile,remoteId:'r',name:'n',path:'p',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3}})).ok).toBe(true);
  expect(await s.handoffSourceFile({sourceId,generation:1,sourceFileId:sourceFile,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:3,workId:work,claim:{...claim,claimedBy:'other'}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
  expect(await s.handoffSourceFile({sourceId,generation:1,sourceFileId:sourceFile,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:3,workId:work,claim})).toMatchObject({ok:true,fileId:file,workId:work});
  await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${work}'`);
  expect(await s.bindSourceAttempt({sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',tempKey:'owned/key',extractionId:extraction,claim:{workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now}})).toMatchObject({ok:true});
  expect(await s.readSourceAttempt('owned/key')).toMatchObject({ok:true,binding:{open:true,fileId:file}});
  expect(await s.publishSourceFile({sourceId,generation:1,sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:{workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now}})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
  const begun=await s.beginExtraction({id:extraction,fileId:file,extractorVersion:'test',startedAt:claim.now,claim:{workItemId:work,claimedBy:'extractor'}});expect(begun.ok).toBe(true);
  expect(await s.appendExtractionChunks({extractionId:extraction,chunks:[{id:'019a0000-0000-7000-8000-000000000016',ordinal:0,body:'abc',page:null,chunkLocator:{type:'text',start:0,end:3}}]})).toMatchObject({ok:true});
  const publish={sourceId,generation:1,sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok' as const,mediaType:'text/plain',indexConfigId:null},claim:{workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now}};
  const snapshot=async()=>({file:await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`),extraction:await s.db.rows(`select finished_at,status from brain.document_extractions where id='${extraction}'`),chunks:await s.db.rows(`select id,body from brain.document_chunks where extraction_id='${extraction}'`),source:await s.db.rows(`select file_id,index_status,completed_version,completed_hash from brain.source_files where id='${sourceFile}'`),publication:await s.db.rows(`select * from brain.source_work_publications where work_id='${work}'`)});
  const before=await snapshot();
  await s.db.query(`update brain.source_files set remote_version='v2',index_status='pending' where id='${sourceFile}'`);
  const changedBefore=await snapshot();expect(await s.publishSourceFile(publish)).toMatchObject({ok:false,code:'SOURCE_CHANGED'});expect(await snapshot()).toEqual(changedBefore);
  await s.db.query(`update brain.source_files set remote_version='v1' where id='${sourceFile}'`);
  expect(await s.publishSourceFile({...publish,claim:{...publish.claim,now:new Date('2026-01-02T00:00:00Z')}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
  expect(await snapshot()).toEqual(before);
  await s.db.query(`create function brain.test_reject_source_publish() returns trigger language plpgsql as $$ begin raise exception 'synthetic late source update failure'; end $$; create trigger test_reject_source_publish before update on brain.source_files for each row execute function brain.test_reject_source_publish()`);
  expect(await s.publishSourceFile(publish)).toMatchObject({ok:false});
  expect(await snapshot()).toEqual(before);
  await s.db.query('drop trigger test_reject_source_publish on brain.source_files; drop function brain.test_reject_source_publish()');
  expect(await s.publishSourceFile({sourceId,generation:1,sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:{workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now}})).toMatchObject({ok:true});
  expect(await s.listSourceEntries(sourceId)).toMatchObject({ok:true,entries:[{fileId:file,indexStatus:'indexed',completedVersion:'v1',completedHash:hash}]});
  await s.db.query(`begin; set local brain.redacting='on'; update brain.files set redacted_at='2026-01-01Z' where id='${file}'; commit`);
  expect(await s.publishSourceFile({sourceId,generation:1,sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:{workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now}})).toMatchObject({ok:false,code:'FILE_REDACTED'});
  expect(await s.readSourceAttempt('owned/key')).toMatchObject({ok:true,binding:{open:true}});
});

it('enforces one source per account and requires explicit source state values',async()=>{
  const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());
  const first=await s.ensureSource({id:sourceId,kind:'drive',account:'same-account',rootId:'root-a'});
  expect(first).toMatchObject({ok:true,source:{id:sourceId,rootId:'root-a',generation:1,cursor:null}});
  expect(await s.ensureSource({id:'019a0000-0000-7000-8000-000000000019',kind:'drive',account:'same-account',rootId:'root-b'})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
  expect(await s.db.rows("select id::text,root_id,generation,cursor from brain.sources where account='same-account'")).toEqual([{id:sourceId,root_id:'root-a',generation:1,cursor:null}]);
  const columns=await s.db.rows<{column_name:string;column_default:string|null}>("select column_name,column_default from information_schema.columns where table_schema='brain' and ((table_name='sources' and column_name='generation') or (table_name='source_files' and column_name in ('index_status','unreachable','unreachable_at'))) order by column_name");
  expect(columns).toEqual([{column_name:'generation',column_default:null},{column_name:'index_status',column_default:null},{column_name:'unreachable',column_default:null},{column_name:'unreachable_at',column_default:null}]);
  const pg=(await import('pg')).default;const admin=new pg.Client({connectionString:s.db.url});await admin.connect();
  try {
    await expect(admin.query("insert into brain.sources(id,kind,account,root_id,generation) values ('019a0000-0000-7000-8000-000000000019','drive','same-account','root-b',1)")).rejects.toMatchObject({code:'23505'});
    await expect(admin.query("insert into brain.sources(id,kind,account,root_id) values ('019a0000-0000-7000-8000-000000000020','drive','different','root')")).rejects.toMatchObject({code:'23502'});
    await expect(admin.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version) values ('019a0000-0000-7000-8000-000000000021','${sourceId}','r','n','p','text/plain','v')`)).rejects.toMatchObject({code:'23502'});
    await expect(admin.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,index_status,unreachable,unreachable_at) values ('019a0000-0000-7000-8000-000000000021','${sourceId}','r','n','p','text/plain','v','pending',true,null)`)).rejects.toMatchObject({code:'23514'});
  } finally {await admin.end();}
});

it('source bytes use file extraction claim and atomic generation without a brain home',async()=>{
  const {expect}=await import('vitest');const {sourceSyncHandler,documentExtractHandler}=await import('@second-brain/core');const {sequenceIdGen}=await import('@second-brain/core/testing');
  const s=await subject();cleanup.push(()=>s.close());const ids=sequenceIdGen({timestampMs:claim.now.getTime(),start:500}),clock={now:()=>claim.now};
  const sync={id:workId,kind:'source_sync',executionClass:'core' as const,currentAttemptToken:null,serializationKey:null,holdGroup:null,targetKind:'source',targetId:sourceId,createdAt:claim.now,attempts:0,nextAttemptAt:claim.now,claimedAt:claim.now,claimExpiresAt:new Date('2026-01-02T00:00:00Z'),claimedBy:'worker',lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null};
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
  await s.ensureSource({id:sourceId,kind:'drive',account:'fixture',rootId:'root'});
  const bytes=new TextEncoder().encode('합성 본문 두글자'), remoteItem={id:'remote',name:'a.txt',mimeType:'text/plain',version:'v1',sizeBytes:bytes.length};
  const remote:import('@second-brain/core').SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[remoteItem],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:remoteItem};},async download(){return {ok:true,bytes};}};
  expect(await sourceSyncHandler({store:s,remote,clock,idGen:ids})(sync)).toEqual({ok:true});
  const entries=await s.listSourceEntries(sourceId);if(!entries.ok)throw Error(entries.message);const e=entries.entries[0]!;
  const handoffRows=await s.db.rows<{file_id:string;work_id:string}>('select file_id,work_id from brain.source_handoffs');const h=handoffRows[0]!;
  await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${h.work_id}'`);
  const extraction={...sync,id:h.work_id,kind:'document_extract',targetKind:'file',targetId:h.file_id,claimedBy:'extractor'};
  const data=new Map<string,Uint8Array>();const temp:import('@second-brain/core').SourceTemp={async write(key,value){data.set(key,value);return {ok:true};},async read(key){const value=data.get(key);return value?{ok:true,bytes:value}:{ok:false,message:'missing'};},async remove(key){data.delete(key);},async cleanup(inspect){for(const key of data.keys())if(await inspect(key)==='closed')data.delete(key);}};
  const handler=documentExtractHandler({store:s,files:{async get(){throw Error('external bytes must not use FileStore');}},source:{store:s,remote,temp},clock,idGen:ids});
  expect(await handler(extraction)).toEqual({ok:true});expect(data.size).toBe(1);expect(await s.completeWork({id:h.work_id,claimedBy:'extractor',now:claim.now})).toMatchObject({ok:true,outcome:'done'});const {cleanupSourceTemps}=await import('@second-brain/core');await cleanupSourceTemps(temp,s,clock);expect(data.size).toBe(0);
  const after=await s.listSourceEntries(sourceId);expect(after).toMatchObject({ok:true,entries:[{id:e.id,fileId:h.file_id,indexStatus:'indexed',completedVersion:'v1'}]});
  expect(await s.db.rows(`select home_location_id, current_extraction_id from brain.files where id='${h.file_id}'`)).toMatchObject([{home_location_id:null,current_extraction_id:expect.any(String)}]);
  expect(await s.db.rows(`select body from brain.document_chunks where extraction_id=(select current_extraction_id from brain.files where id='${h.file_id}')`)).toMatchObject([{body:'합성 본문 두글자'}]);
});

it('a missing source preserves a shared file while another source remains reachable',async()=>{
  const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());
  const second='019a0000-0000-7000-8000-000000000031',file='019a0000-0000-7000-8000-000000000032',one='019a0000-0000-7000-8000-000000000033',two='019a0000-0000-7000-8000-000000000034',scan='019a0000-0000-7000-8000-000000000035';
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
  await s.ensureSource({id:sourceId,kind:'drive',account:'a',rootId:'root'});await s.ensureSource({id:second,kind:'drive',account:'b',rootId:'root'});
  await s.db.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','sha256:${'f'.repeat(64)}',1,'2026-01-01Z'); insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ('${one}','${sourceId}','a','a','','text/plain','1','${file}','indexed',false),('${two}','${second}','b','b','','text/plain','1','${file}','indexed',false)`);
  expect(await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim})).toMatchObject({ok:true});expect(await s.finishSourceScan({sourceId,generation:1,scanId:scan,claim})).toMatchObject({ok:true});
  expect(await s.db.rows(`select source_unreachable_at from brain.files where id='${file}'`)).toEqual([{source_unreachable_at:null}]);expect(await s.db.rows(`select unreachable from brain.source_files where id='${one}'`)).toEqual([{unreachable:true}]);expect(await s.db.rows(`select unreachable from brain.source_files where id='${two}'`)).toEqual([{unreachable:false}]);
});

it('indexes source references and literal name and path searches',async()=>{
  const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());
  const indexes=await s.db.rows<{indexname:string}>("select indexname from pg_indexes where schemaname='brain' and indexname in ('source_files_file_id_idx','source_handoffs_file_id_idx','source_files_name_trgm_idx','source_files_path_trgm_idx') order by indexname");
  expect(indexes.map(x=>x.indexname)).toEqual(['source_files_file_id_idx','source_files_name_trgm_idx','source_files_path_trgm_idx','source_handoffs_file_id_idx']);
  const pg=(await import('pg')).default;const client=new pg.Client({connectionString:s.db.url});await client.connect();
  try {
    await client.query('set enable_seqscan=off');
    for(const [query,index] of [["select * from brain.source_files where file_id='019a0000-0000-7000-8000-000000000011'",'source_files_file_id_idx'],["select * from brain.source_handoffs where file_id='019a0000-0000-7000-8000-000000000011'",'source_handoffs_file_id_idx'],["select * from brain.source_files where lower(name) like '%synthetic%'",'source_files_name_trgm_idx'],["select * from brain.source_files where lower(path) like '%synthetic%'",'source_files_path_trgm_idx']] as const){
      const plan=await client.query(`explain (format json) ${query}`);expect(JSON.stringify(plan.rows)).toContain(index);
    }
  } finally {await client.end();}
});

it('renews real source claims across 600 seconds and refuses expiration and replacement',async()=>{
  const {expect}=await import('vitest');const {sourceSyncHandler}=await import('@second-brain/core');const {sequenceIdGen}=await import('@second-brain/core/testing');
  const s=await subject();cleanup.push(()=>s.close());let time=claim.now.getTime(),page=0;const clock={now:()=>new Date(time)};
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-01T00:10:00Z')`);
  await s.ensureSource({id:sourceId,kind:'drive',account:'lease',rootId:'root'});
  const work:import('@second-brain/core').WorkItem={id:workId,kind:'source_sync',executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,targetKind:'source',targetId:sourceId,createdAt:claim.now,attempts:0,nextAttemptAt:claim.now,claimedAt:claim.now,claimExpiresAt:new Date(time+600_000),claimedBy:'worker',lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null};
  const remote:import('@second-brain/core').SourceRemote={async startToken(){return {ok:true,token:'token'};},async list(){time+=300_000;page++;return {ok:true,items:[],nextPageToken:page<4?String(page):null,incomplete:false};},async metadata(){throw Error('unused');},async download(){throw Error('unused');}};
  expect(await sourceSyncHandler({store:s,remote,clock,idGen:sequenceIdGen({timestampMs:time,start:600})})(work)).toEqual({ok:true});
  expect(time-claim.now.getTime()).toBe(1_200_000);expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{cursor:'token'}});
  const rows=await s.db.rows<{claim_expires_at:Date|string;claimed_by:string;attempts:number}> (`select claim_expires_at,claimed_by,attempts from brain.work_items where id='${workId}'`);const expires=new Date(rows[0]!.claim_expires_at).getTime();expect(expires).toBe(time+600_000);expect(rows[0]).toMatchObject({claimed_by:'worker',attempts:0});
  expect(await s.renewSourceClaim({sourceId,claim:{...claim,now:new Date(expires)}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
  expect(new Date((await s.db.rows<{claim_expires_at:Date|string}>(`select claim_expires_at from brain.work_items where id='${workId}'`))[0]!.claim_expires_at).getTime()).toBe(expires);
  await s.db.query(`update brain.work_items set claimed_by='replacement' where id='${workId}'`);
  expect(await s.renewSourceClaim({sourceId,claim:{...claim,now:new Date(time)}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
  await s.db.query(`update brain.work_items set claimed_by='worker',completed_at='2026-01-01T00:20:00Z',outcome='succeeded' where id='${workId}'`);
  expect(await s.renewSourceClaim({sourceId,claim:{...claim,now:new Date(time)}})).toMatchObject({ok:false,code:'CLAIM_LOST'});
});

for(const first of ['publish','handoff'] as const) it(`serializes ${first} first across the shared-file publication barrier`,async()=>{
  const {expect}=await import('vitest');const pg=(await import('pg')).default;const s=await subject();const {postgresStore}=await import('../src/index.js');const firstStore=postgresStore({databaseUrl:s.db.appUrl,applicationName:'handoff-race-first',lockTimeoutMs:15000,queryTimeoutMs:20000}),secondStore=postgresStore({databaseUrl:s.db.appUrl,applicationName:'handoff-race-second',lockTimeoutMs:15000,queryTimeoutMs:20000});cleanup.push(async()=>{await firstStore.close();await secondStore.close();await s.close();});
  const file='019a0000-0000-7000-8000-000000000071',one='019a0000-0000-7000-8000-000000000072',two='019a0000-0000-7000-8000-000000000073',three='019a0000-0000-7000-8000-000000000074',scan='019a0000-0000-7000-8000-000000000075',work='019a0000-0000-7000-8000-000000000076',extraction='019a0000-0000-7000-8000-000000000077',extra='019a0000-0000-7000-8000-000000000078',hash='sha256:'+'b'.repeat(64);
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
  await s.ensureSource({id:sourceId,kind:'drive',account:'race',rootId:'root'});await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim});
  for(const id of [one,two,three])expect(await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id,remoteId:id,name:id,path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:1}})).toMatchObject({ok:true});
  const initial={sourceId,generation:1,sourceFileId:one,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:1,workId:work,claim};
  expect(await s.handoffSourceFile(initial)).toMatchObject({ok:true,workId:work});await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${work}'`);
  const extractClaim={workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now};
  expect(await s.bindSourceAttempt({sourceFileId:one,fileId:file,remoteVersion:'v1',tempKey:'race/one',extractionId:extraction,claim:extractClaim})).toMatchObject({ok:true});
  expect(await s.beginExtraction({id:extraction,fileId:file,extractorVersion:'test',startedAt:claim.now,claim:{workItemId:work,claimedBy:'extractor'}})).toMatchObject({ok:true});
  const publish={sourceId,generation:1,sourceFileId:one,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok' as const,mediaType:'text/plain',indexConfigId:null},claim:extractClaim};
  const late={...initial,sourceFileId:two,workId:extra};
  const admin=new pg.Client({connectionString:s.db.url});await admin.connect();
  try {
    const trigger=first==='publish'?`before update on brain.source_files for each row when (new.id='${one}'::uuid and new.index_status='indexed')`:`before insert on brain.source_handoffs for each row when (new.source_file_id='${two}'::uuid)`;
    await admin.query(`create function brain.test_source_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(420425); return new; end $$; create trigger test_source_barrier ${trigger} execute function brain.test_source_barrier()`);
    await admin.query('select pg_advisory_lock(420425)');
    const waitBlocked=async(name:string)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const result=await admin.query('select pid,cardinality(pg_blocking_pids(pid)) as blockers from pg_stat_activity where datname=current_database() and application_name=$1',[name]);if(result.rows[0]?.blockers>0)return result.rows[0].pid as number;await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`expected blocked backend ${name}`);};
    const firstPromise=first==='publish'?firstStore.publishSourceFile(publish):firstStore.handoffSourceFile(late);const firstPid=await waitBlocked('handoff-race-first');
    const secondPromise=first==='publish'?secondStore.handoffSourceFile(late):secondStore.publishSourceFile(publish);const secondPid=await waitBlocked('handoff-race-second');expect(firstPid).not.toBe(secondPid);
    await admin.query('select pg_advisory_unlock(420425)');expect(await firstPromise).toMatchObject({ok:true});expect(await secondPromise).toMatchObject({ok:true});
    expect(await s.listSourceEntries(sourceId)).toMatchObject({ok:true,entries:expect.arrayContaining([expect.objectContaining({id:one,fileId:file,indexStatus:'indexed',completedVersion:'v1',completedHash:hash}),expect.objectContaining({id:two,fileId:file,indexStatus:'indexed',completedVersion:'v1',completedHash:hash})])});
    expect(await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`)).toEqual([{current_extraction_id:extraction}]);expect(await s.db.rows(`select file_id,extraction_id,content_hash from brain.source_work_publications where work_id='${work}'`)).toEqual([{file_id:file,extraction_id:extraction,content_hash:hash}]);
    expect(await s.handoffSourceFile(late)).toMatchObject({ok:true,fileId:file,workId:work});
    await admin.query('drop trigger test_source_barrier on brain.'+(first==='publish'?'source_files':'source_handoffs'));await admin.query('drop function brain.test_source_barrier()');
    await s.db.query(`update brain.source_files set remote_version='v2',index_status='pending' where id='${two}'`);
    expect(await s.handoffSourceFile(late)).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
    expect(await s.handoffSourceFile({...late,sourceFileId:three,generation:2})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
    const replacement='019a0000-0000-7000-8000-000000000079';
    expect(await s.beginExtraction({id:replacement,fileId:file,extractorVersion:'replacement',startedAt:claim.now,claim:{workItemId:work,claimedBy:'extractor'}})).toMatchObject({ok:true});
    expect(await s.finishExtraction({extractionId:replacement,finishedAt:claim.now,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null}})).toMatchObject({ok:true,current:true});
    expect(await s.handoffSourceFile({...late,sourceFileId:three})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
    expect(await s.completeWork({id:work,claimedBy:'extractor',now:claim.now})).toMatchObject({ok:true,outcome:'done'});
    expect(await s.handoffSourceFile({...late,sourceFileId:three})).toMatchObject({ok:true,workId:extra});
    await s.db.query(`begin; set local brain.redacting='on'; update brain.files set redacted_at='2026-01-01Z' where id='${file}'; commit`);
    expect(await s.handoffSourceFile({...late,sourceFileId:three})).toMatchObject({ok:false,code:'FILE_REDACTED'});
    expect(await s.listSourceEntries(sourceId)).toMatchObject({ok:true,entries:expect.arrayContaining([expect.objectContaining({id:two,remoteVersion:'v2',indexStatus:'pending'}),expect.objectContaining({id:three,indexStatus:'failed',completedVersion:null})])});
  } finally {await admin.query('select pg_advisory_unlock_all()');await admin.end();}
},30000);

it('planner uses source lookup indexes with 20000 synthetic handoffs and normal cost settings',async()=>{
 const {expect}=await import('vitest');const pg=(await import('pg')).default;const s=await subject();cleanup.push(()=>s.close());await s.ensureSource({id:sourceId,kind:'drive',account:'planner',rootId:'root'});
 const client=new pg.Client({connectionString:s.db.url});await client.connect();
 try {
  await client.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at) select ('00000000-0000-4000-8001-'||lpad(to_hex(n),12,'0'))::uuid,'sha256:'||lpad(to_hex(n),64,'0'),1,'2026-01-01Z' from generate_series(1,1000) n`);
  await client.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at) select 'core', ('00000000-0000-4000-8003-'||lpad(to_hex(n),12,'0'))::uuid,'document_extract','file',('00000000-0000-4000-8001-'||lpad(to_hex(n),12,'0')),'2026-01-01Z','2026-01-01Z' from generate_series(1,1000) n`);
  await client.query(`insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) select ('00000000-0000-4000-8002-'||lpad(to_hex(n),12,'0'))::uuid,'${sourceId}'::uuid,n::text,case when n=17 then 'rareuniquenameword' else 'document-'||n||repeat('x',400) end,case when n=17 then 'rareuniquepathword' else 'folder-'||n||repeat('y',400) end,'text/plain','v1',('00000000-0000-4000-8001-'||lpad(to_hex((n%1000)+1),12,'0'))::uuid,'pending',false from generate_series(1,20000) n`);
  await client.query(`insert into brain.source_handoffs(source_file_id,file_id,remote_version,content_hash,source_generation,work_id) select sf.id,sf.file_id,'v1',f.content_hash,1,w.id from brain.source_files sf join brain.files f on f.id=sf.file_id join brain.work_items w on w.kind='document_extract' and w.target_id=sf.file_id::text where sf.source_id='${sourceId}'::uuid`);
  await client.query('analyze brain.source_files');await client.query('analyze brain.source_handoffs');
  expect((await client.query('select count(*)::int as n from brain.source_handoffs')).rows[0].n).toBe(20000);
  // Production list and publication update shapes, including their joins and
  // predicates, rather than a stand-alone synthetic file_id lookup.
  const file='00000000-0000-4000-8001-000000000012',work='00000000-0000-4000-8003-000000000012';
  const listQuery=`select h.source_file_id,s.id,s.generation,sf.remote_id,sf.mime_type,h.remote_version,h.work_id,st.temp_key from brain.source_handoffs h join brain.source_files sf on sf.id=h.source_file_id join brain.sources s on s.id=sf.source_id left join lateral (select temp_key from brain.source_staged_bytes st where st.ready and st.source_file_id=h.source_file_id and st.file_id=h.file_id and st.work_id=h.work_id and st.remote_version=h.remote_version and st.content_hash=h.content_hash and st.source_generation=h.source_generation order by temp_key limit 1) st on true where h.file_id=$1::uuid and h.source_generation=s.generation and h.remote_version=sf.remote_version and not sf.unreachable order by h.source_file_id`;
  const updateQuery=`update brain.source_files sf set file_id=$1::uuid,index_status='indexed',completed_version=h.remote_version,completed_hash=h.content_hash from brain.source_handoffs h join brain.sources s on s.id=(select source_id from brain.source_files where id=h.source_file_id) where sf.id=h.source_file_id and h.file_id=$1::uuid and h.work_id::text=$2 and h.content_hash=$3 and h.source_generation=s.generation and sf.remote_version=h.remote_version and not sf.unreachable`;
  for(const [query,params] of [[listQuery,[file]],[updateQuery,[file,work,'sha256:'+'0'.repeat(64)]]] as const){const plan=await client.query(`explain (format json) ${query}`,[...params]);expect(JSON.stringify(plan.rows)).toContain('source_handoffs_file_id_idx');}
  const candidateQuery=`select sf.id from brain.source_files sf join brain.sources s on s.id=sf.source_id join brain.source_handoffs h on h.source_file_id=sf.id join brain.source_attempts a on a.source_file_id=sf.id and a.work_id=h.work_id where sf.id::text=$1 and s.id::text=$2 and s.generation=$3 and sf.remote_version=$4 and not sf.unreachable and h.file_id=$5::uuid and h.remote_version=$4 and h.content_hash=$6 and h.source_generation=s.generation and h.work_id::text=$7 and a.file_id=h.file_id and a.remote_version=h.remote_version and a.extraction_id::text=$8 and a.claimed_by=$9 and a.claimed_at=$10 and a.attempts=$11 for update of h,a`;
  const candidate=await client.query(`explain (format json) ${candidateQuery}`,['00000000-0000-4000-8002-000000000012',sourceId,1,'v1',file,'sha256:'+'0'.repeat(64),work,'019a0000-0000-7000-8000-000000000015','worker','2026-01-01Z',0]);expect(JSON.stringify(candidate.rows)).toContain('source_handoffs');
  for(const [query,index] of [["select * from brain.source_files where file_id='00000000-0000-4000-8001-000000000012'",'source_files_file_id_idx'],["select * from brain.source_handoffs where file_id='00000000-0000-4000-8001-000000000012'",'source_handoffs_file_id_idx'],["select * from brain.source_files where lower(name) like '%rareuniquenameword%'",'source_files_name_trgm_idx'],["select * from brain.source_files where lower(path) like '%rareuniquepathword%'",'source_files_path_trgm_idx']] as const){const plan=await client.query(`explain (format json) ${query}`);expect(JSON.stringify(plan.rows)).toContain(index);}
 } finally {await client.end();}
},30000);

it('preserves a preparing source temp until its fenced handoff becomes ready',async()=>{
 const {expect}=await import('vitest');const {sourceSyncHandler,cleanupSourceTemps}=await import('@second-brain/core');const {sequenceIdGen}=await import('@second-brain/core/testing');const s=await subject();cleanup.push(()=>s.close());
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);await s.ensureSource({id:sourceId,kind:'drive',account:'staging',rootId:'root'});
 const item:import('@second-brain/core').WorkItem={id:workId,kind:'source_sync',executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,targetKind:'source',targetId:sourceId,createdAt:claim.now,attempts:0,nextAttemptAt:claim.now,claimedAt:claim.now,claimExpiresAt:new Date('2026-01-02Z'),claimedBy:'worker',lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null};
 const bytes=new Uint8Array([97,98,99]),remoteItem={id:'remote',name:'a.txt',mimeType:'text/plain',version:'v1',sizeBytes:3};let downloads=0;
 const remote:import('@second-brain/core').SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[remoteItem],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:remoteItem};},async download(){downloads++;return {ok:true,bytes};}};
 let entered!:()=>void,release!:()=>void;const enteredPromise=new Promise<void>(r=>{entered=r;}),barrier=new Promise<void>(r=>{release=r;}),data=new Map<string,Uint8Array>();
 const temp:import('@second-brain/core').SourceTemp={async write(key,value){data.set(key,value);entered();await barrier;return {ok:true};},async read(key){const b=data.get(key);return b?{ok:true,bytes:b}:{ok:false,message:'missing'};},async remove(key){data.delete(key);},async cleanup(inspect){for(const key of data.keys())if(await inspect(key)==='closed')data.delete(key);}};
 const run=sourceSyncHandler({store:s,remote,temp,clock:{now:()=>claim.now},idGen:sequenceIdGen({timestampMs:claim.now.getTime(),start:900})})(item);
 try {await enteredPromise;const key=[...data.keys()][0]!;expect(await s.readSourceAttempt(key)).toMatchObject({ok:true,binding:{open:true,fileId:null}});expect(await s.db.rows('select ready from brain.source_staged_bytes')).toEqual([{ready:false}]);expect(await s.db.rows('select * from brain.source_handoffs')).toEqual([]);expect(await s.claimSourceWork({sourceId,syncWorkId:workId,now:claim.now,claimedBy:'other'})).toEqual({ok:true,item:null});await cleanupSourceTemps(temp,s);expect(data.has(key)).toBe(true);await cleanupSourceTemps(temp,{async readSourceAttempt(){return {ok:false,code:'DB_UNAVAILABLE',message:'unknown'};}});expect(data.has(key)).toBe(true);release();expect(await run).toEqual({ok:true});expect(downloads).toBe(1);expect(await s.db.rows('select ready from brain.source_staged_bytes')).toEqual([{ready:true}]);const handoff=await s.db.rows<{file_id:string}>('select file_id from brain.source_handoffs');expect(await s.listSourceHandoffs(handoff[0]!.file_id)).toMatchObject({ok:true,handoffs:[{tempKey:key}]});}finally{release();await run;}
});

for(const mode of ['unreachable','temporary','unsupported','brain'] as const)it(`shared file uses valid fallback and settles all current source entries: ${mode}`,async()=>{
 const {expect}=await import('vitest');const {createHash}=await import('node:crypto');const {documentExtractHandler}=await import('@second-brain/core');const {sequenceIdGen}=await import('@second-brain/core/testing');const s=await subject();cleanup.push(()=>s.close());
 const ids=sequenceIdGen({timestampMs:claim.now.getTime(),start:3000}),scan=ids.next(),one=ids.next(),two=ids.next(),file=ids.next(),work=ids.next();const bytes=mode==='unsupported'?new Uint8Array([0,1,2]):new TextEncoder().encode('synthetic shared document');const hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);await s.ensureSource({id:sourceId,kind:'drive',account:'fallback',rootId:'root'});await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim});
 for(const [id,remoteId] of [[one,'a'],[two,'b']] as const){await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id,remoteId,name:`${remoteId}.txt`,path:'',mimeType:'text/plain',remoteVersion:'1',sizeBytes:bytes.length}});expect(await s.handoffSourceFile({sourceId,generation:1,sourceFileId:id,remoteVersion:'1',fileId:file,contentHash:hash,sizeBytes:bytes.length,workId:work,claim})).toMatchObject({ok:true,fileId:file,workId:work});}
 if(mode==='brain'){const location=ids.next();await s.db.query(`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${location}','${file}','local','synthetic','brain','2026-01-01Z');update brain.files set home_location_id='${location}' where id='${file}'`);}
 await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${work}'`);
 const item:import('@second-brain/core').WorkItem={id:work,kind:'document_extract',executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,targetKind:'file',targetId:file,createdAt:claim.now,attempts:0,nextAttemptAt:claim.now,claimedAt:claim.now,claimExpiresAt:new Date('2026-01-02Z'),claimedBy:'extractor',lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null};
 const remote:import('@second-brain/core').SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){throw Error('unused');},async metadata(id){if(mode==='brain'||(id==='a'&&(mode==='unreachable'||mode==='temporary')))return {ok:false,code:mode==='unreachable'?'UNREACHABLE':'TEMPORARY',message:'synthetic'};return {ok:true,item:{id,name:id,mimeType:'text/plain',version:'1',sizeBytes:bytes.length}};},async download(){return {ok:true,bytes};}};
 const temp:import('@second-brain/core').SourceTemp={async write(){return {ok:true};},async read(){return {ok:false,message:'missing'};},async remove(){},async cleanup(){}};
 let localReads=0;const handler=documentExtractHandler({store:s,files:{async get(){localReads++;return {ok:true,bytes};}},source:{store:s,remote,temp},clock:{now:()=>claim.now},idGen:ids});expect(await handler(item)).toEqual({ok:true});
 const entries=await s.listSourceEntries(sourceId);if(!entries.ok)throw Error(entries.message);const first=entries.entries.find(e=>e.id===one)!,second=entries.entries.find(e=>e.id===two)!;
 if(mode==='unreachable'){expect(first.unreachable).toBe(true);expect(second.indexStatus).toBe('indexed');}else if(mode==='temporary'){expect(first.indexStatus).toBe('indexed');expect(second.indexStatus).toBe('indexed');}else if(mode==='unsupported'){expect(first.indexStatus).toBe('unsupported');expect(second.indexStatus).toBe('unsupported');}else{expect(localReads).toBe(1);expect(first.indexStatus).toBe('failed');expect(second.indexStatus).toBe('failed');expect(await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`)).toMatchObject([{current_extraction_id:expect.any(String)}]);}
});

it('terminal recovery closes only its exactly bound extraction and preserves live and unknown ownership',async()=>{
 const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());const file='019a0000-0000-7000-8000-000000000081',sf='019a0000-0000-7000-8000-000000000082',scan='019a0000-0000-7000-8000-000000000083',work='019a0000-0000-7000-8000-000000000084',extraction='019a0000-0000-7000-8000-000000000085',tempKey='019a0000-0000-7000-8000-000000000086',otherFile='019a0000-0000-7000-8000-000000000087',otherWork='019a0000-0000-7000-8000-000000000088',otherExtraction='019a0000-0000-7000-8000-000000000089',hash='sha256:'+'e'.repeat(64);
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);await s.ensureSource({id:sourceId,kind:'drive',account:'recovery',rootId:'root'});await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim});await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id:sf,remoteId:'r',name:'n',path:'',mimeType:'text/plain',remoteVersion:'v',sizeBytes:1}});
 const prepared={sourceId,generation:1,sourceFileId:sf,remoteVersion:'v',contentHash:hash,tempKey,claim};expect(await s.prepareSourceBytes(prepared)).toMatchObject({ok:true});expect(await s.handoffSourceFile({...prepared,fileId:file,sizeBytes:1,workId:work})).toMatchObject({ok:true});
 await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${work}';insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${otherFile}','sha256:${'f'.repeat(64)}',1,'2026-01-01Z');insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${otherWork}','document_extract','file','${otherFile}','2026-01-01Z','2026-01-01Z','other','2026-01-01Z','2026-01-02Z')`);
 const owner={workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now};expect(await s.bindSourceAttempt({sourceFileId:sf,fileId:file,remoteVersion:'v',tempKey,extractionId:extraction,claim:owner})).toMatchObject({ok:true});expect(await s.beginExtraction({id:extraction,fileId:file,extractorVersion:'t',startedAt:claim.now,claim:{workItemId:work,claimedBy:'extractor'}})).toMatchObject({ok:true});expect(await s.beginExtraction({id:otherExtraction,fileId:otherFile,extractorVersion:'t',startedAt:claim.now,claim:{workItemId:otherWork,claimedBy:'other'}})).toMatchObject({ok:true});
 expect(await s.finishSourceAttempt({fileId:file,extractionId:extraction,claim:{...owner,attempts:1},outcome:{status:'failed',failedStage:'read',error:'no',mediaType:null}})).toMatchObject({ok:false,code:'CLAIM_LOST'});expect(await s.recoverSourceAttempt(tempKey,claim.now)).toMatchObject({ok:true,binding:{open:true}});expect(await s.recoverSourceAttempt('unknown',claim.now)).toEqual({ok:true,binding:null});
 expect(await s.completeWork({id:work,claimedBy:'extractor',now:claim.now})).toMatchObject({ok:true,outcome:'done'});expect(await s.recoverSourceAttempt(tempKey,claim.now)).toMatchObject({ok:true,binding:{open:false}});
 expect(await s.db.rows(`select status from brain.document_extractions where id='${extraction}'`)).toEqual([{status:'failed'}]);expect(await s.db.rows(`select status from brain.document_extractions where id='${otherExtraction}'`)).toEqual([{status:null}]);
});

for(const [scanAction,first] of [['observe','observe'],['observe','publish'],['finish','finish'],['finish','publish']] as const)it(`scan ${scanAction} and publish use source-first locks with timeout and retry: ${first} first`,async()=>{
 const {expect}=await import('vitest');const {postgresStore}=await import('../src/index.js');const pg=(await import('pg')).default;
 const s=await subject();const a=postgresStore({databaseUrl:s.db.appUrl,applicationName:'source-race-first',lockTimeoutMs:20000,queryTimeoutMs:25000}),b=postgresStore({databaseUrl:s.db.appUrl,applicationName:'source-race-second',lockTimeoutMs:first==='finish'?5000:600,queryTimeoutMs:first==='finish'?7000:2000});cleanup.push(async()=>{await a.close();await b.close();await s.close();});
 const admin=new pg.Client({connectionString:s.db.url});await admin.connect();const probe=new pg.Client({connectionString:s.db.url,application_name:'source-race-probe'});await probe.connect();const sf='019a0000-0000-7000-8000-000000000092',file='019a0000-0000-7000-8000-000000000093',scan='019a0000-0000-7000-8000-000000000094',work='019a0000-0000-7000-8000-000000000095',extraction='019a0000-0000-7000-8000-000000000096',hash='sha256:'+'9'.repeat(64);
 try {
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
  expect(await s.ensureSource({id:sourceId,kind:'drive',account:'scan-publish',rootId:'root'})).toMatchObject({ok:true});expect(await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim})).toMatchObject({ok:true});
  const observed={sourceId,generation:1,scanId:scan,claim,entry:{id:sf,remoteId:'r',name:'initial',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3}};
  expect(await s.observeSourceEntry(observed)).toMatchObject({ok:true});expect(await s.handoffSourceFile({sourceId,generation:1,sourceFileId:sf,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:3,workId:work,claim})).toMatchObject({ok:true});
  await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${work}'`);
  const extractClaim={workId:work,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now};expect(await s.bindSourceAttempt({sourceFileId:sf,fileId:file,remoteVersion:'v1',tempKey:'scan-race',extractionId:extraction,claim:extractClaim})).toMatchObject({ok:true});expect(await s.beginExtraction({id:extraction,fileId:file,extractorVersion:'race',startedAt:claim.now,claim:{workItemId:work,claimedBy:'extractor'}})).toMatchObject({ok:true});
  const publish={sourceId,generation:1,sourceFileId:sf,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok' as const,mediaType:'text/plain',indexConfigId:null},claim:extractClaim};const observe={...observed,entry:{...observed.entry,name:'observed'}};
  const snapshot=async()=>({source:(await admin.query('select file_id,index_status,completed_version,completed_hash,name from brain.source_files where id=$1',[sf])).rows,file:(await admin.query('select current_extraction_id from brain.files where id=$1',[file])).rows,extraction:(await admin.query('select status,finished_at from brain.document_extractions where id=$1',[extraction])).rows,publication:(await admin.query('select * from brain.source_work_publications where work_id=$1',[work])).rows});
  const barrierTable=first==='finish'?'sources':'source_files',barrierId=first==='finish'?sourceId:sf;
  await admin.query(`create function brain.test_scan_publish_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(420426); return new; end $$; create trigger test_scan_publish_barrier before update on brain.${barrierTable} for each row when (new.id='${barrierId}'::uuid) execute function brain.test_scan_publish_barrier()`);await admin.query('select pg_advisory_lock(420426)');
  const scanWith=(store:typeof a)=>scanAction==='observe'?store.observeSourceEntry(observe):store.finishSourceScan({sourceId,generation:1,scanId:scan,claim});
  const before=await snapshot();const running=first==='publish'?a.publishSourceFile(publish):scanWith(a);
  const waitBlocked=async(name:string)=>{const deadline=Date.now()+5000;while(Date.now()<deadline){const x=await admin.query('select pid,cardinality(pg_blocking_pids(pid)) as blockers from pg_stat_activity where datname=current_database() and application_name=$1',[name]);if(x.rows[0]?.blockers>0)return x.rows[0].pid as number;await new Promise(resolve=>setTimeout(resolve,10));}throw Error(`missing blocked backend ${name}`);};
  const firstPid=await waitBlocked('source-race-first');
  if(first==='finish'){
   // The finish trigger has the source row but has not reached source_files.
   // Prove both facts on a separate backend before starting the publisher.
   await probe.query('begin');try{await expect(probe.query('select id from brain.sources where id=$1::uuid for update nowait',[sourceId])).rejects.toMatchObject({code:'55P03'});}finally{await probe.query('rollback');}
   await probe.query('begin');try{expect((await probe.query('select id from brain.source_files where id=$1::uuid for update nowait',[sf])).rows).toHaveLength(1);}finally{await probe.query('rollback');}
  }
  const competing=first==='publish'?scanWith(b):b.publishSourceFile(publish);const secondPid=await waitBlocked('source-race-second');expect(firstPid).not.toBe(secondPid);
  if(first==='finish'){
   const probePid=(await probe.query('select pg_backend_pid() as pid')).rows[0].pid as number;expect(new Set([firstPid,secondPid,probePid]).size).toBe(3);
   const blocked=await admin.query('select state,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1',[secondPid]);expect(blocked.rows[0]).toMatchObject({state:'active',blockers:expect.arrayContaining([firstPid])});
   // A source_file-first publisher would hold this very row while waiting for
   // the source; NOWAIT would raise 55P03 before its timeout rolls it back.
   await probe.query('begin');try{expect((await probe.query('select id from brain.source_files where id=$1::uuid for update nowait',[sf])).rows).toHaveLength(1);}finally{await probe.query('rollback');}
   const stillBlocked=await admin.query('select state,pg_blocking_pids(pid) as blockers from pg_stat_activity where pid=$1',[secondPid]);expect(stillBlocked.rows[0]).toMatchObject({state:'active',blockers:expect.arrayContaining([firstPid])});
  }
  expect(await competing).toMatchObject({ok:false,code:'DB_LOCKED'});expect(await snapshot()).toEqual(before);
  await admin.query('select pg_advisory_unlock(420426)');expect(await running).toMatchObject({ok:true});expect(await (first==='publish'?scanWith(b):b.publishSourceFile(publish))).toMatchObject({ok:true});
  const final=await snapshot();expect(final.source).toMatchObject([{file_id:file,index_status:'indexed',completed_version:'v1',completed_hash:hash,name:scanAction==='observe'?'observed':'initial'}]);expect(final.file).toMatchObject([{current_extraction_id:extraction}]);expect(final.extraction).toMatchObject([{status:'ok'}]);expect(final.publication).toMatchObject([{file_id:file,extraction_id:extraction,content_hash:hash}]);
  expect(await s.listSourceHandoffs(file)).toMatchObject({ok:true,handoffs:[{sourceFileId:sf}]});for(const bad of [file.toUpperCase(),file.replaceAll('-',''),'invalid'])expect(await s.listSourceHandoffs(bad)).toEqual({ok:true,handoffs:[]});
 } finally {await admin.query('select pg_advisory_unlock_all()');await probe.end();await admin.end();}
},40000);

/** Two real work claims for one immutable content hash, with one successful generation. */
async function twoGenerationFixture(stage:boolean){
 const {expect}=await import('vitest');const {createHash}=await import('node:crypto');const s=await subject();cleanup.push(()=>s.close());
 const sf='019a0000-0000-7000-8000-0000000000a1',file='019a0000-0000-7000-8000-0000000000a2',scan='019a0000-0000-7000-8000-0000000000a3',oldWork='019a0000-0000-7000-8000-0000000000a4',newWork='019a0000-0000-7000-8000-0000000000a5',oldExtraction='019a0000-0000-7000-8000-0000000000a6',stageKey='019a0000-0000-7000-8000-0000000000a7';
 const bytes=new TextEncoder().encode('원래 합성 본문 검색'),hash='sha256:'+createHash('sha256').update(bytes).digest('hex');
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
 expect(await s.ensureSource({id:sourceId,kind:'drive',account:'two-generations',rootId:'root'})).toMatchObject({ok:true});expect(await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim})).toMatchObject({ok:true});expect(await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id:sf,remoteId:'remote',name:'doc.txt',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:bytes.length}})).toMatchObject({ok:true});
 const base={sourceId,generation:1,sourceFileId:sf,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:bytes.length,claim};expect(await s.handoffSourceFile({...base,workId:oldWork})).toMatchObject({ok:true,workId:oldWork});
 await s.db.query(`update brain.work_items set claimed_by='old',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${oldWork}'`);const oldClaim={workId:oldWork,claimedBy:'old',claimedAt:claim.now,attempts:0,now:claim.now};
 expect(await s.bindSourceAttempt({sourceFileId:sf,fileId:file,remoteVersion:'v1',tempKey:'old-owned',extractionId:oldExtraction,claim:oldClaim})).toMatchObject({ok:true});expect(await s.beginExtraction({id:oldExtraction,fileId:file,extractorVersion:'old',startedAt:claim.now,claim:{workItemId:oldWork,claimedBy:'old'}})).toMatchObject({ok:true});
 expect(await s.appendExtractionChunks({extractionId:oldExtraction,chunks:[{id:'019a0000-0000-7000-8000-0000000000a8',ordinal:0,body:'원래 합성 본문 검색',page:null,chunkLocator:{type:'text',start:0,end:11}}]})).toMatchObject({ok:true});
 expect(await s.publishSourceFile({...base,extractionId:oldExtraction,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:oldClaim})).toMatchObject({ok:true});expect(await s.completeWork({id:oldWork,claimedBy:'old',now:claim.now})).toMatchObject({ok:true,outcome:'done'});
 if(stage)expect(await s.prepareSourceBytes({sourceId,generation:1,sourceFileId:sf,remoteVersion:'v1',contentHash:hash,tempKey:stageKey,claim})).toMatchObject({ok:true});
 expect(await s.handoffSourceFile({...base,workId:newWork,...(stage?{tempKey:stageKey}:{})})).toMatchObject({ok:true,workId:newWork});await s.db.query(`update brain.work_items set claimed_by='new',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${newWork}'`);
 const newClaim={workId:newWork,claimedBy:'new',claimedAt:claim.now,attempts:0,now:claim.now};
 return {s,sf,file,hash,bytes,oldWork,newWork,oldExtraction,newClaim,stageKey,base};
}

for(const mode of ['ready','download'] as const)it(`handler rejects post-extraction remote version change with identical bytes: ${mode}`,async()=>{
 const {expect}=await import('vitest');const {documentExtractHandler}=await import('@second-brain/core');const {sequenceIdGen}=await import('@second-brain/core/testing');const f=await twoGenerationFixture(mode==='ready'),{s,sf,file,hash,bytes,oldExtraction,newWork,newClaim,stageKey}=f;
 const events:string[]=[],data=new Map<string,Uint8Array>();if(mode==='ready')data.set(stageKey,bytes);
 const remote:import('@second-brain/core').SourceRemote={async startToken(){throw Error('unused');},async list(){throw Error('unused');},async metadata(id){const version=events.includes('chunks')?'v2':'v1';events.push(`metadata:${version}`);return {ok:true,item:{id,name:'doc.txt',mimeType:'text/plain',version,sizeBytes:bytes.length}};},async download(){events.push('download');return {ok:true,bytes};}};
 const temp:import('@second-brain/core').SourceTemp={async write(key,value){data.set(key,value);return {ok:true};},async read(key){events.push('ready-read');const value=data.get(key);return value?{ok:true,bytes:value}:{ok:false,message:'missing'};},async remove(key){data.delete(key);},async cleanup(){}};
 const instrumented={...s,async appendExtractionChunks(input:Parameters<typeof s.appendExtractionChunks>[0]){const result=await s.appendExtractionChunks(input);if(result.ok&&input.chunks.length)events.push('chunks');return result;}};
 const item:import('@second-brain/core').WorkItem={id:newWork,kind:'document_extract',executionClass:'core',currentAttemptToken:null,serializationKey:null,holdGroup:null,targetKind:'file',targetId:file,createdAt:claim.now,attempts:0,nextAttemptAt:claim.now,claimedAt:claim.now,claimExpiresAt:new Date('2026-01-02Z'),claimedBy:'new',lastError:null,completedAt:null,outcome:null,cancelRequestedAt:null,scheduledOccurrences:null};
 const before={file:await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`),old:await s.db.rows(`select id,status,finished_at from brain.document_extractions where id='${oldExtraction}'`),chunks:await s.db.rows(`select id,body,chunk_locator from brain.document_chunks where extraction_id='${oldExtraction}' order by ordinal`),source:await s.db.rows(`select file_id,completed_version,completed_hash from brain.source_files where id='${sf}'`)};
 const handler=documentExtractHandler({store:instrumented,files:{async get(){throw Error('unexpected brain read');}},source:{store:s,remote,temp},clock:{now:()=>claim.now},idGen:sequenceIdGen({timestampMs:claim.now.getTime(),start:7000})});expect(await handler(item)).toMatchObject({ok:false,code:'SOURCE_CHANGED',retryable:true});
 expect(events).toEqual(['metadata:v1',mode==='ready'?'ready-read':'download','chunks','metadata:v2']);expect(await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`)).toEqual(before.file);expect(await s.db.rows(`select id,status,finished_at from brain.document_extractions where id='${oldExtraction}'`)).toEqual(before.old);expect(await s.db.rows(`select id,body,chunk_locator from brain.document_chunks where extraction_id='${oldExtraction}' order by ordinal`)).toEqual(before.chunks);expect(await s.db.rows(`select file_id,completed_version,completed_hash from brain.source_files where id='${sf}'`)).toEqual(before.source);expect(before.source).toMatchObject([{completed_version:'v1',completed_hash:hash}]);expect(await s.db.rows(`select * from brain.source_work_publications where work_id='${newWork}'`)).toEqual([]);expect(await s.db.rows(`select completed_at from brain.work_items where id='${newWork}'`)).toEqual([{completed_at:null}]);void newClaim;
});

it('source publication late update failure rolls back old and new generations, chunks, pointer and fingerprints',async()=>{
 const {expect}=await import('vitest');const f=await twoGenerationFixture(false),{s,sf,file,hash,oldExtraction,newWork,newClaim,base}=f;const next='019a0000-0000-7000-8000-0000000000a9';
 expect(await s.bindSourceAttempt({sourceFileId:sf,fileId:file,remoteVersion:'v1',tempKey:'next-owned',extractionId:next,claim:newClaim})).toMatchObject({ok:true});expect(await s.beginExtraction({id:next,fileId:file,extractorVersion:'next',startedAt:claim.now,claim:{workItemId:newWork,claimedBy:'new'}})).toMatchObject({ok:true});expect(await s.appendExtractionChunks({extractionId:next,chunks:[{id:'019a0000-0000-7000-8000-0000000000aa',ordinal:0,body:'새 합성 본문',page:null,chunkLocator:{type:'text',start:0,end:7}}]})).toMatchObject({ok:true});
 const snapshot=async()=>({file:await s.db.rows(`select id,current_extraction_id,content_hash from brain.files where id='${file}'`),extractions:await s.db.rows(`select id,status,finished_at,attempt from brain.document_extractions where file_id='${file}' order by id`),chunks:await s.db.rows(`select id,extraction_id,ordinal,body from brain.document_chunks where extraction_id in ('${oldExtraction}','${next}') order by id`),source:await s.db.rows(`select id,file_id,index_status,completed_version,completed_hash from brain.source_files where id='${sf}'`),publications:await s.db.rows(`select work_id,file_id,extraction_id,content_hash from brain.source_work_publications where file_id='${file}' order by work_id`)});
 const before=await snapshot();expect(before.file).toMatchObject([{current_extraction_id:oldExtraction,content_hash:hash}]);expect(before.extractions).toHaveLength(2);expect(before.chunks).toHaveLength(2);expect(before.publications).toMatchObject([{extraction_id:oldExtraction}]);
 await s.db.query(`create function brain.test_reject_replacement() returns trigger language plpgsql as $$ begin raise exception 'reject source publication'; end $$; create trigger test_reject_replacement before update on brain.source_files for each row when (new.id='${sf}'::uuid and new.index_status='indexed') execute function brain.test_reject_replacement()`);
 try{expect(await s.publishSourceFile({...base,extractionId:next,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:newClaim})).toMatchObject({ok:false});expect(await snapshot()).toEqual(before);expect(await s.db.rows(`select * from brain.source_work_publications where work_id='${newWork}'`)).toEqual([]);}finally{await s.db.query('drop trigger test_reject_replacement on brain.source_files; drop function brain.test_reject_replacement()');}
});

it('disconnect persists, cancels queued sync and prevents new or late claims',async()=>{
  const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());
  await s.ensureSource({id:sourceId,kind:'drive',account:'disconnect',rootId:'root'});
  expect(await s.addWork({id:workId,kind:'source_sync',targetKind:'source',targetId:sourceId,createdAt:claim.now,nextAttemptAt:claim.now})).toMatchObject({ok:true});
  expect(await s.disconnectSource({id:sourceId,now:claim.now})).toMatchObject({ok:true,source:{connected:false,generation:2}});
  expect(await s.readWorkItem(workId)).toMatchObject({outcome:'cancelled'});
  expect(await s.claimWork({kinds:['source_sync'],now:claim.now,claimedBy:'other'})).toMatchObject({ok:true,item:null});
  expect(await s.addWork({id:'019a0000-0000-7000-8000-000000000006',kind:'source_sync',targetKind:'source',targetId:sourceId,createdAt:claim.now,nextAttemptAt:claim.now})).toMatchObject({ok:false});
  expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{connected:false,generation:2}});
  expect(await s.connectSource({id:sourceId})).toMatchObject({ok:true,source:{connected:true,generation:3}});
});

it('disconnect fences staged bytes and handoff and preserves a shared accessible source',async()=>{
  const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());
  const second='019a0000-0000-7000-8000-000000000081',file='019a0000-0000-7000-8000-000000000082',one='019a0000-0000-7000-8000-000000000083',two='019a0000-0000-7000-8000-000000000084',scan='019a0000-0000-7000-8000-000000000085',extractWork='019a0000-0000-7000-8000-000000000086';const hash='sha256:'+'e'.repeat(64);
  await s.ensureSource({id:sourceId,kind:'drive',account:'first',rootId:'watch-a'});await s.ensureSource({id:second,kind:'drive',account:'second',rootId:'watch-b'});
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z'); insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${file}','${hash}',3,'2026-01-01Z'); insert into brain.source_files(id,source_id,remote_id,name,path,mime_type,remote_version,file_id,index_status,unreachable) values ('${one}','${sourceId}','a','a','','text/plain','v','${file}','indexed',false),('${two}','${second}','b','b','','text/plain','v','${file}','indexed',false)`);
  expect(await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim})).toMatchObject({ok:true});
  expect(await s.disconnectSource({id:sourceId,now:claim.now})).toMatchObject({ok:true});
  expect(await s.prepareSourceBytes({sourceId,generation:1,sourceFileId:one,remoteVersion:'v',contentHash:hash,tempKey:'late',claim})).toMatchObject({ok:false});
  expect(await s.handoffSourceFile({sourceId,generation:1,sourceFileId:one,remoteVersion:'v',contentHash:hash,fileId:file,sizeBytes:3,workId:extractWork,claim})).toMatchObject({ok:false});
  expect(await s.db.rows(`select source_unreachable_at from brain.files where id='${file}'`)).toEqual([{source_unreachable_at:null}]);
  expect(await s.listSourceEntries(second)).toMatchObject({ok:true,entries:[{unreachable:false}]});
});

it('rejects a late extraction publish after disconnect without changing the current document',async()=>{
  const {expect}=await import('vitest');const s=await subject();cleanup.push(()=>s.close());
  const file='019a0000-0000-7000-8000-000000000091',sourceFile='019a0000-0000-7000-8000-000000000092',scan='019a0000-0000-7000-8000-000000000093',extractWork='019a0000-0000-7000-8000-000000000094',extraction='019a0000-0000-7000-8000-000000000095',hash='sha256:'+'d'.repeat(64);
  await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
  await s.ensureSource({id:sourceId,kind:'drive',account:'publish-disconnect',rootId:'root'});await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim});
  await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id:sourceFile,remoteId:'r',name:'n',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:3}});
  await s.handoffSourceFile({sourceId,generation:1,sourceFileId:sourceFile,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:3,workId:extractWork,claim});
  await s.db.query(`update brain.work_items set claimed_by='extractor',claimed_at='2026-01-01Z',claim_expires_at='2026-01-02Z' where id='${extractWork}'`);
  const ec={workId:extractWork,claimedBy:'extractor',claimedAt:claim.now,attempts:0,now:claim.now};
  expect(await s.bindSourceAttempt({sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',tempKey:'late',extractionId:extraction,claim:ec})).toMatchObject({ok:true});
  expect(await s.beginExtraction({id:extraction,fileId:file,extractorVersion:'test',startedAt:claim.now,claim:{workItemId:extractWork,claimedBy:'extractor'}})).toMatchObject({ok:true});
  expect(await s.disconnectSource({id:sourceId,now:claim.now})).toMatchObject({ok:true});
  expect(await s.publishSourceFile({sourceId,generation:1,sourceFileId:sourceFile,fileId:file,remoteVersion:'v1',contentHash:hash,extractionId:extraction,outcome:{status:'ok',mediaType:'text/plain',indexConfigId:null},claim:ec})).toMatchObject({ok:false,code:'SOURCE_CHANGED'});
  expect(await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`)).toEqual([{current_extraction_id:null}]);
});

it('atomically changes watched folders, fences a running scan and keeps the account connected',async()=>{
 const {expect}=await import('vitest');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const s=await subject();cleanup.push(()=>s.close());const self=sampleSelfUserInput();await s.ensureSelfUser(self);
 await s.ensureSource({id:sourceId,kind:'drive',account:'synthetic',rootId:'brain-root'});
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
 expect(await s.updateSourceFolders({id:sourceId,userId:self.id,folderId:'folder-a',add:true,now:claim.now})).toMatchObject({ok:true,folders:['folder-a']});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{connected:true,generation:2,rootId:'brain-root'}});expect(await s.readWorkItem(workId)).toMatchObject({outcome:'cancelled'});
 expect(await s.beginSourceScan({sourceId,generation:1,scanId:'019a0000-0000-7000-8000-000000000099',startToken:'late',claim})).toMatchObject({ok:false});
 expect(await s.updateSourceFolders({id:sourceId,userId:self.id,folderId:'folder-a',add:false,now:claim.now})).toMatchObject({ok:true,folders:[]});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{connected:true,generation:3}});
});

it('disconnect during extraction chunk writing rejects late publication and retains prior current state',async()=>{
 const {expect}=await import('vitest');const {contentHashOfBytes,documentExtractHandler}=await import('@second-brain/core');const {sequenceIdGen}=await import('@second-brain/core/testing');const s=await subject();cleanup.push(()=>s.close());
 const ids=sequenceIdGen({timestampMs:claim.now.getTime(),start:7500}),scan=ids.next(),sf=ids.next(),file=ids.next(),extractWork=ids.next();const bytes=new TextEncoder().encode('합성 본문 중단 경계'),hash=contentHashOfBytes(bytes);
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
 await s.ensureSource({id:sourceId,kind:'drive',account:'extract-barrier',rootId:'root'});await s.beginSourceScan({sourceId,generation:1,scanId:scan,startToken:'t',claim});await s.observeSourceEntry({sourceId,generation:1,scanId:scan,claim,entry:{id:sf,remoteId:'remote',name:'a.txt',path:'',mimeType:'text/plain',remoteVersion:'v1',sizeBytes:bytes.length}});
 expect(await s.handoffSourceFile({sourceId,generation:1,sourceFileId:sf,remoteVersion:'v1',fileId:file,contentHash:hash,sizeBytes:bytes.length,workId:extractWork,claim})).toMatchObject({ok:true});
 const picked=await s.claimWork({now:claim.now,claimedBy:'extractor',kinds:['document_extract']});if(!picked.ok||!picked.item)throw Error('synthetic claim unavailable');
 let entered!:()=>void,release!:()=>void;const ready=new Promise<void>(r=>{entered=r;}),hold=new Promise<void>(r=>{release=r;});
 const wrapped={...s,async appendExtractionChunks(input:Parameters<typeof s.appendExtractionChunks>[0]){const result=await s.appendExtractionChunks(input);entered();await hold;return result;}};
 const remote:import('@second-brain/core').SourceRemote={async startToken(){return {ok:true,token:'t'};},async list(){return {ok:true,items:[],nextPageToken:null,incomplete:false};},async metadata(){return {ok:true,item:{id:'remote',name:'a.txt',mimeType:'text/plain',version:'v1',sizeBytes:bytes.length}};},async download(){return {ok:true,bytes};}};
 const temp:import('@second-brain/core').SourceTemp={async write(){return {ok:true};},async read(){return {ok:false,message:'not staged'};},async remove(){},async cleanup(){}};
 const handler=documentExtractHandler({store:wrapped,files:{async get(){throw Error('external source must not read local');}},source:{store:s,remote,temp},clock:{now:()=>claim.now},idGen:ids});const running=handler(picked.item);
 try {await ready;expect(await s.disconnectSource({id:sourceId,now:claim.now})).toMatchObject({ok:true});release();expect(await running).toMatchObject({ok:false,code:'SOURCE_CHANGED'});expect(await s.db.rows(`select current_extraction_id from brain.files where id='${file}'`)).toEqual([{current_extraction_id:null}]);expect(await s.db.rows(`select * from brain.source_work_publications where work_id='${extractWork}'`)).toEqual([]);}
 finally {release();await running;}
},120000);

it('rolls back watch configuration and the generation fence together on failure, and ignores equivalent values',async()=>{
 const {expect}=await import('vitest');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const s=await subject();cleanup.push(()=>s.close());const self=sampleSelfUserInput();await s.ensureSelfUser(self);
 await s.ensureSource({id:sourceId,kind:'drive',account:'config-atomic',rootId:'root'});
 await s.db.query(`insert into brain.work_items(execution_class,id,kind,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('core','${workId}','source_sync','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
 await s.db.query("create function brain.test_watch_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic failure'; end $$; create trigger test_watch_failure before update on brain.sources for each row execute function brain.test_watch_failure()");
 const input={userId:self.id,key:'drive.watch_folders',value:'[\"a\"]',updatedAt:claim.now};
 expect(await s.setSetting(input)).toMatchObject({ok:false});
 expect(await s.getSetting({userId:self.id,key:input.key})).toMatchObject({ok:true,setting:null});
 expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:1}});expect(await s.readWorkItem(workId)).toMatchObject({completedAt:null});
 await s.db.query('drop trigger test_watch_failure on brain.sources; drop function brain.test_watch_failure()');
 expect(await s.setSetting(input)).toMatchObject({ok:true});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:2}});expect(await s.readWorkItem(workId)).toMatchObject({outcome:'cancelled'});
 const before=await s.db.rows<{id:string;kind:string;target_kind:string;target_id:string;next_attempt_at:Date}>("select id::text,kind,target_kind,target_id,next_attempt_at from brain.work_items where completed_at is null");expect(before).toHaveLength(1);expect(before[0]).toMatchObject({kind:'source_sync',target_kind:'source',target_id:sourceId,next_attempt_at:claim.now});expect(before[0]!.id).not.toBe(workId);
 expect(await s.setSetting({...input,updatedAt:new Date(claim.now.getTime()+1000)})).toMatchObject({ok:true});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:2}});expect(await s.db.rows('select id::text,kind,target_kind,target_id,next_attempt_at from brain.work_items where completed_at is null')).toEqual(before);
 expect(await s.claimWork({now:claim.now,claimedBy:'replacement',kinds:['source_sync']})).toMatchObject({ok:true,item:{id:before[0]!.id,targetKind:'source',targetId:sourceId}});
});

it('locks the source before the schedule when firing races a disconnect transaction',async()=>{
 const {expect}=await import('vitest');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const pg=(await import('pg')).default;const s=await subject();cleanup.push(()=>s.close());const self=sampleSelfUserInput();await s.ensureSelfUser(self);await s.ensureSource({id:sourceId,kind:'drive',account:'lock-order',rootId:'root'});
 const scheduleId='019a0000-0000-7000-8000-000000000071';const at=claim.now;
 expect(await s.addSchedule({id:scheduleId,kind:'source_sync',holdGroup:null,targetKind:'source',targetId:sourceId,triggerKind:'interval',cronExpr:null,runAt:null,timeZone:null,timeZoneSource:null,intervalSeconds:60,extension:null,scheduleKey:'drive-lock-order',userId:self.id,enabled:true,removedAt:null,nextRunAt:at,lastRunAt:null,createdAt:at})).toMatchObject({ok:true});
 const {postgresStore}=await import('../src/index.js');const firingStore=postgresStore({databaseUrl:s.db.appUrl,applicationName:'source-lock-order-test'});
 const client=new pg.Client({connectionString:s.db.url});const observer=new pg.Client({connectionString:s.db.url});await client.connect();await observer.connect();
 try{
 const expected=await s.readSchedule({id:scheduleId});expect(expected).toMatchObject({ok:true,schedule:{kind:'source_sync',targetKind:'source',targetId:sourceId,triggerKind:'interval',timeZone:null,cronExpr:null,nextRunAt:at,enabled:true}});
 const privileges=await client.query("select has_table_privilege('brain_app','brain.extension_quiesce','DELETE') as gate, has_table_privilege('brain_app','brain.sources','UPDATE') as source");expect(privileges.rows[0]).toEqual({gate:true,source:true});
  await client.query('begin');await client.query("set local lock_timeout='2s'");await client.query('select id from brain.sources where id=$1 for update',[sourceId]);const blocker=(await client.query('select pg_backend_pid() as pid')).rows[0].pid as number;
  const observe=async()=>Boolean((await observer.query("select exists(select 1 from pg_stat_activity a where a.datname=current_database() and a.application_name='source-lock-order-test' and a.wait_event_type='Lock' and $1=any(pg_blocking_pids(a.pid))) as waiting",[blocker])).rows[0].waiting);
  expect(await observe()).toBe(false);
  let early:unknown;const firing=firingStore.fireSchedule({scheduleId,expectedTriggerKind:'interval',expectedTimeZone:null,expectedCronExpr:null,expectedNextRunAt:at,nextRunAt:new Date(at.getTime()+60000),now:at,occurrences:[{occurrenceAt:at,status:'pending'}],work:{id:workId,kind:'source_sync',targetKind:'source',targetId:sourceId,createdAt:at,nextAttemptAt:at}}).then(result=>{early=result;return result;});
  // Observe the other backend actually waiting on the source before taking schedule.
  let waiting=false;for(let n=0;n<100&&!waiting&&early===undefined;n++){waiting=await observe();if(!waiting)await new Promise(r=>setTimeout(r,10));}expect(waiting,`fireSchedule ended before source lock barrier: ${JSON.stringify(early)}`).toBe(true);
  await client.query('update brain.schedules set enabled=false where id=$1',[scheduleId]);await client.query('update brain.sources set connected=false,generation=generation+1 where id=$1',[sourceId]);await client.query('commit');
  expect(await firing).toMatchObject({ok:true,fired:false});expect(await s.readWorkItem(workId)).toBeNull();
 }finally{await client.query('rollback').catch(()=>{});await firingStore.close();await observer.end();await client.end();}
});

it('uses inherited watch folders, commits explicit empty overrides and rolls back enqueue failure',async()=>{
 const {expect}=await import('vitest');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const {setSetting}=await import('@second-brain/core');const {CORE_SCHEMA_VERSION}=await import('../src/index.js');const s=await subject();cleanup.push(()=>s.close());const self=sampleSelfUserInput();await s.ensureSelfUser(self);await s.ensureSource({id:sourceId,kind:'drive',account:'inherited',rootId:'root'});
 await s.db.query(`insert into brain.settings(user_id,key,value,updated_at) values (null,'drive.watch_folders','["a"]','2025-01-01Z'); insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_by,claimed_at,claim_expires_at) values ('${workId}','source_sync','core','source','${sourceId}','2026-01-01Z','2026-01-01Z','worker','2026-01-01Z','2026-01-02Z')`);
 await s.db.query("create function brain.test_reject_enqueue() returns trigger language plpgsql as $$ begin if new.kind='source_sync' then raise exception 'synthetic enqueue failure'; end if; return new; end $$; create trigger test_reject_enqueue before insert on brain.work_items for each row execute function brain.test_reject_enqueue()");
 const deps={store:s,clock:{now:()=>claim.now},schemaVersions:{core:CORE_SCHEMA_VERSION}};
 expect(await setSetting(deps,{key:'drive.watch_folders',value:'[]'})).toMatchObject({ok:false});expect(await s.db.rows("select user_id,value from brain.settings where key='drive.watch_folders'")).toEqual([{user_id:null,value:'["a"]'}]);expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:1}});expect(await s.readWorkItem(workId)).toMatchObject({completedAt:null});
 expect(await s.updateSourceFolders({id:sourceId,userId:self.id,folderId:'a',add:false,now:claim.now})).toMatchObject({ok:false});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:1}});expect(await s.readWorkItem(workId)).toMatchObject({completedAt:null});
 await s.db.query('drop trigger test_reject_enqueue on brain.work_items; drop function brain.test_reject_enqueue()');
 expect(await setSetting(deps,{key:'drive.watch_folders',value:'[]'})).toMatchObject({ok:true,source:'db',value:'[]',updatedAt:claim.now});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:2}});expect(await s.readWorkItem(workId)).toMatchObject({outcome:'cancelled'});
 const own=await s.db.rows("select value from brain.settings where user_id is not null and key='drive.watch_folders'");expect(own).toEqual([{value:'[]'}]);
 const open=await s.db.rows<{id:string;target_kind:string;target_id:string;next_attempt_at:Date}>("select id::text,target_kind,target_id,next_attempt_at from brain.work_items where kind='source_sync' and completed_at is null");expect(open).toHaveLength(1);expect(open[0]).toMatchObject({target_kind:'source',target_id:sourceId,next_attempt_at:claim.now});expect(open[0]!.id).not.toBe(workId);
 expect(await setSetting({...deps,clock:{now:()=>new Date(claim.now.getTime()+1000)}},{key:'drive.watch_folders',value:'[ ]'})).toMatchObject({ok:true,source:'db',value:'[]',updatedAt:claim.now});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:2}});expect(await s.claimWork({now:claim.now,claimedBy:'next',kinds:['source_sync']})).toMatchObject({ok:true,item:{id:open[0]!.id}});
});

it('folder mutations start from global fallback and enqueue the replacement atomically',async()=>{
 const {expect}=await import('vitest');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const s=await subject();cleanup.push(()=>s.close());const self=sampleSelfUserInput();await s.ensureSelfUser(self);await s.ensureSource({id:sourceId,kind:'drive',account:'folder-inherited',rootId:'root'});await s.db.query("insert into brain.settings(user_id,key,value,updated_at) values (null,'drive.watch_folders','[\"a\",\"b\"]','2025-01-01Z')");
 expect(await s.updateSourceFolders({id:sourceId,userId:self.id,folderId:'a',add:false,now:claim.now})).toMatchObject({ok:true,changed:true,folders:['b']});expect(await s.db.rows("select value from brain.settings where user_id is not null and key='drive.watch_folders'")).toEqual([{value:'[\"b\"]'}]);
 const open=await s.db.rows<{id:string}>("select id::text from brain.work_items where kind='source_sync' and completed_at is null");expect(open).toHaveLength(1);expect(await s.updateSourceFolders({id:sourceId,userId:self.id,folderId:'a',add:false,now:claim.now})).toMatchObject({ok:true,changed:false,folders:['b']});expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:2}});expect(await s.claimWork({now:claim.now,kinds:['source_sync'],claimedBy:'next'})).toMatchObject({ok:true,item:{id:open[0]!.id}});
});

it('persists a self override equal to normalized global watch values without changing generation or work',async()=>{
 const {expect}=await import('vitest');const {sampleSelfUserInput}=await import('@second-brain/core/testing');const {setSetting}=await import('@second-brain/core');const {CORE_SCHEMA_VERSION}=await import('../src/index.js');const s=await subject();cleanup.push(()=>s.close());const self=sampleSelfUserInput();await s.ensureSelfUser(self);await s.ensureSource({id:sourceId,kind:'drive',account:'same-fallback',rootId:'root'});await s.db.query("insert into brain.settings(user_id,key,value,updated_at) values (null,'drive.watch_folders','[\"b\",\"a\",\"a\"]','2025-01-01Z')");
 const deps={store:s,clock:{now:()=>claim.now},schemaVersions:{core:CORE_SCHEMA_VERSION}};expect(await setSetting(deps,{key:'drive.watch_folders',value:'[\"a\",\"b\"]'})).toMatchObject({ok:true,source:'db',updatedAt:claim.now,value:'[\"a\",\"b\"]'});expect(await s.db.rows("select value from brain.settings where user_id is not null and key='drive.watch_folders'")).toEqual([{value:'[\"a\",\"b\"]'}]);expect(await s.readSource(sourceId)).toMatchObject({ok:true,source:{generation:1}});expect(await s.db.rows("select id from brain.work_items where kind='source_sync'")).toEqual([]);
});
