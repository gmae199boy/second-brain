import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { createIsolatedTestDatabase } from '@second-brain/test-db';
import { createBrain, migrateFileToDrive, blobDeleteHandler, DOCUMENT_EXTRACTOR_VERSION, type BrainDependencies } from 'second_brain';
import { sequenceIdGen } from 'second_brain/testing';
import { EXPECTED_SCHEMA_VERSIONS, postgresStore, type PostgresStore } from 'second_brain/postgres';
import { readConfig } from '../src/config/codec.js';
import { brainDependencies } from '../src/assembly.js';
import { dispatch } from '../src/dispatch.js';
import { commands } from '../src/commands/index.js';
import { localFileStore } from '../src/runtime/file-store.js';
import { driveFileStore } from '../src/runtime/drive-file-store.js';
import { fakeDrive, fakeClock } from './fixtures/fake-drive.js';
import { pgHome, pgRunner } from './pg-home.js';

const cleanups:(()=>Promise<unknown>)[]=[];
afterEach(async()=>{for(const close of cleanups.splice(0).reverse()) await close();});
async function fixture(days?:string, bodyOverride?:string) {
  const home=await mkdtemp(join(tmpdir(),'brain-drive-tracer-')); cleanups.push(()=>rm(home,{recursive:true,force:true}));
  const db=await pgHome(home,true,createIsolatedTestDatabase); cleanups.push(()=>db.drop());
  const server=await fakeDrive(); cleanups.push(()=>server.close());
  const store=postgresStore({databaseUrl:db.appUrl}); cleanups.push(()=>store.close());
  const clock=fakeClock('2026-01-01T00:00:00.000Z'), idGen=sequenceIdGen({timestampMs:clock.now().getTime(),start:500});
  const local=localFileStore({root:join(home,'files')});
  const drive=driveFileStore({rootFolderId:'brain-root',baseUrl:server.baseUrl,uploads:store.driveUploads,clock});
  const body=bodyOverride ?? '원본 내용 password=synthetic-secret-123 ✨\n', bytes=new Uint8Array(Buffer.from(body));
  const put=await local.put(bytes); if(!put.ok) throw Error('local put');
  const fileId=idGen.next(), localId=idGen.next(), extractionId=idGen.next(), chunkId=idGen.next();
  const locator=JSON.stringify({type:'text',start:0,end:Array.from(body).length});
  const admin=new pg.Client({connectionString:db.url}); await admin.connect(); cleanups.push(()=>admin.end());
  await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,$3,$4)',[fileId,put.contentHash,bytes.length,clock.now()]);
  await admin.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ($1,$2,'local',$3,'brain',$4)",[localId,fileId,put.location.locator,clock.now()]);
  await admin.query('update brain.files set home_location_id=$1 where id=$2',[localId,fileId]);
  await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,media_type,status,started_at,finished_at) values ($1,$2,$4,1,'text/plain','ok',$3,$3)",[extractionId,fileId,clock.now(),DOCUMENT_EXTRACTOR_VERSION]);
  // Deliberately different DB text: success proves show uses remote bytes.
  await admin.query('insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,$3,$4)',[chunkId,extractionId,'x'.repeat(Array.from(body).length),locator]);
  await admin.query('update brain.files set current_extraction_id=$1 where id=$2',[extractionId,fileId]);
  if(days!==undefined) {const self=await store.readSelfUser(); if(!self.ok || !self.user) throw Error('self missing'); await store.setSetting({userId:self.user.id,key:'drive.keep_local_days',value:days,updatedAt:clock.now()});}
  const env={SECOND_BRAIN_HOME:home,BRAIN_DATABASE_URL:db.appUrl,HOME:home,PATH:process.env.PATH};
  const config=await readConfig(home);
  const integration={store,uploads:store.driveUploads,files:drive,rootFolderId:'brain-root'};
  const dependencies=brainDependencies({home,env,config,store,clock,idGen,schemaVersions:EXPECTED_SCHEMA_VERSIONS,workHandlers:{},driveFactory:()=>integration});
  const brain=createBrain(dependencies);
  const settings={store,schemaVersions:EXPECTED_SCHEMA_VERSIONS,clock};
  const migrate=()=>migrateFileToDrive({store,uploads:store.driveUploads,local,drive,settings,rootFolderId:'brain-root',clock,idGen},fileId);
  async function cliShow(rootFolderId='brain-root') {
    let stdout='',stderr='';
    const driveFactory=(s:Parameters<NonNullable<import('../src/dispatch.js').DispatchRuntime['driveFactory']>>[0]):BrainDependencies['drive']=>{
      const pgStore=s as PostgresStore;
      return {store:pgStore,uploads:pgStore.driveUploads,files:driveFileStore({rootFolderId,baseUrl:server.baseUrl,uploads:pgStore.driveUploads,clock}),rootFolderId};
    };
    const code=await dispatch(commands,['files','show',fileId,'--chunk-locator',locator,'--json'],{env,clock,runner:pgRunner,driveFactory,stdout:text=>{stdout+=text;},stderr:text=>{stderr+=text;}});
    return {code,stdout,stderr};
  }
  return {home,db,server,store,clock,idGen,local,drive,put,body,bytes,fileId,localId,extractionId,locator,brain,migrate,cliShow,settings,dependencies,integration};
}

it('0일 보관: 이전·동일 내용 재이전·실제 drain·Drive 원문 show',async()=>{
  const f=await fixture('0');
  expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  expect(await f.migrate()).toMatchObject({ok:true,state:'already'});
  expect(f.server.files.size).toBe(1);
  const row=await f.db.rows<{store_kind:string;verified_at:Date;due_at:Date;next_attempt_at:Date}>(`select l.store_kind,l.verified_at,r.due_at,w.next_attempt_at from brain.files f join brain.file_locations l on l.id=f.home_location_id join brain.drive_retention r on r.drive_location_id=l.id join brain.work_items w on w.kind='drive_local_delete' and w.target_id=r.local_location_id::text where f.id='${f.fileId}'`);
  expect(row).toMatchObject([{store_kind:'drive',verified_at:f.clock.now(),due_at:f.clock.now(),next_attempt_at:f.clock.now()}]);
  await f.brain.queue.drain({budgetMs:5000});
  expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:false});
  expect(await f.store.readFileLocation(f.localId)).toMatchObject({ok:true,location:{deletedAt:f.clock.now()}});
  const before=f.server.requests.length, result=await f.cliShow();
  expect(result.code).toBe(0); expect(result.stdout).toContain('원본 내용'); expect(result.stdout).toContain('[REDACTED:');
  expect(result.stdout).not.toContain('synthetic-secret-123'); expect(result.stdout).not.toContain('xxxxxxxxxx');
  expect(f.server.requests.slice(before).some(r=>r.method==='GET' && r.path.includes('alt=media'))).toBe(true);
  expect(f.server.requests.some(r=>r.path.startsWith('/drive/v3/files?'))).toBe(false);
  f.server.files.clear(); const unavailable=await f.cliShow(); expect(unavailable.code).not.toBe(0); expect(unavailable.stdout).not.toContain('xxxxxxxxxx');
});

it('기본 30일은 만기 직전 보존하고 도달 뒤 원격 확인 후 지운다',async()=>{
  const f=await fixture(); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  f.clock.set('2026-01-30T23:59:59.999Z'); await f.brain.queue.drain({budgetMs:5000});
  expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:true});
  const before=f.server.requests.length; f.clock.set('2026-01-31T00:00:00.000Z'); await f.brain.queue.drain({budgetMs:5000});
  expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:false});
  expect(f.server.requests.slice(before).some(r=>r.method==='GET' && r.path.includes('alt=media'))).toBe(true);
});

it('체크섬 불일치는 home을 보존하고 원격 소실은 보관 삭제를 막는다',async()=>{
  const bad=await fixture('0'); bad.server.checksum='wrong'; expect(await bad.migrate()).toMatchObject({ok:false});
  expect((await bad.db.rows(`select home_location_id from brain.files where id='${bad.fileId}'`))[0]).toEqual({home_location_id:bad.localId});
  expect(await bad.local.exists(bad.put.location)).toEqual({ok:true,exists:true});
  const gone=await fixture('0'); expect(await gone.migrate()).toMatchObject({ok:true,state:'committed'}); gone.server.files.clear();
  await gone.brain.queue.drain({budgetMs:5000}); expect(await gone.local.exists(gone.put.location)).toEqual({ok:true,exists:true});
});

it('지연 업로드 중 가리면 미확정 원격 파일을 먼저 삭제 완료로 표시하지 않는다',async()=>{
  const f=await fixture('0'); const barrier=f.server.holdNextUpload();
  const migrating=f.migrate();
  try {
    await barrier.entered;
    const competing=await f.migrate(); expect(competing).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
    expect(f.server.requests.filter(r=>r.method==='POST' && r.path.startsWith('/upload/'))).toHaveLength(1);
    const before=await f.db.rows<{id:string}>(`select id from brain.file_locations where file_id='${f.fileId}' and store_kind='drive'`);
    expect(before).toHaveLength(1);
    expect(await f.brain.files.redact({file:f.fileId,confirm:true})).toMatchObject({ok:true});
    await f.brain.queue.drain({budgetMs:5000});
    expect(await f.store.readFileLocation(before[0]!.id)).toMatchObject({ok:true,location:{deletedAt:null}});
    expect((await f.db.rows(`select home_location_id from brain.files where id='${f.fileId}'`))[0]).toEqual({home_location_id:f.localId});
    barrier.release(); await migrating;
    f.clock.set('2026-01-01T00:16:00.000Z'); await f.brain.queue.drain({budgetMs:5000});
    expect(f.server.files.size).toBe(0);
    expect(await f.store.readFileLocation(before[0]!.id)).toMatchObject({ok:true,location:{deletedAt:f.clock.now()}});
    expect(await f.db.rows('select * from brain.drive_retention')).toEqual([]);
  } finally {barrier.release(); await migrating.catch(()=>undefined);}
});

it('동시 이전은 root/hash 매핑과 원격 파일 하나로 수렴한다',async()=>{
  const f=await fixture('30');
  const results=await Promise.all([f.migrate(),f.migrate()]);
  expect(results.some(r=>r.ok && (r.state==='committed'||r.state==='already'))).toBe(true);
  expect(f.server.files.size).toBe(1);
  expect(await f.db.rows('select root_folder_id,content_hash,remote_id from brain.drive_uploads')).toHaveLength(1);
  expect(f.server.requests.some(r=>r.path.startsWith('/drive/v3/files?'))).toBe(false);
});

it('외부 소유 또는 다른 루트로 옮겨진 원격 id는 삭제하지 않는다',async()=>{
  const f=await fixture('30'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  const candidate=await f.store.readDriveCandidate(f.fileId); if(!candidate.ok || !candidate.candidate) throw Error('home missing');
  const location=candidate.candidate.home;
  const file=[...f.server.files.values()][0]; if (!file) throw Error('remote missing'); file.parents=['other-root'];
  const before=f.server.requests.length;
  expect(await f.drive.delete(location)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
  expect(await f.drive.delete({...location,ownership:'external'})).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
  expect(f.server.requests.slice(before).filter(r=>r.method==='DELETE')).toHaveLength(0);
  expect(f.server.files.size).toBe(1);
});

it('Drive 원문을 읽는 중 가리면 대기 중이던 show가 본문을 반환하지 않는다',async()=>{
  const f=await fixture('30'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  const barrier=f.server.holdNextDownload(), pending=f.cliShow();
  try {
    await barrier.entered;
    expect(await f.brain.files.redact({file:f.fileId,confirm:true})).toMatchObject({ok:true});
    barrier.release(); const result=await pending;
    expect(result.code).not.toBe(0); expect(result.stdout).not.toContain('원본 내용');
    expect(result.stdout).not.toContain('synthetic-secret-123');
  } finally {barrier.release(); await pending.catch(()=>undefined);}
});

it('다른 Brain home으로 바뀌면 원격 사본을 보존하고 새 home으로 재개한다',async()=>{
  const f=await fixture('30'), barrier=f.server.holdNextUpload(), pending=f.migrate();
  try {
    await barrier.entered;
    const hex=f.put.contentHash.slice(7), alternate=`${hex.slice(0,2)}/${hex.slice(2,4)}/${hex}.png`, newId=f.idGen.next();
    await mkdir(join(f.home,'files',hex.slice(0,2),hex.slice(2,4)),{recursive:true});
    await writeFile(join(f.home,'files',alternate),f.bytes,{mode:0o600});
    await f.db.query(`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ('${newId}','${f.fileId}','local','${alternate}','brain','2026-01-01Z'); update brain.files set home_location_id='${newId}' where id='${f.fileId}'`);
    barrier.release(); expect(await pending).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
    expect(await f.db.rows(`select state,expected_home_id from brain.drive_migration_intents where file_id='${f.fileId}'`)).toEqual([{state:'stale',expected_home_id:f.localId}]);
    expect(f.server.files.size).toBe(1); expect(await f.db.rows('select * from brain.drive_retention')).toEqual([]);
    expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
    expect(await f.db.rows(`select state,expected_home_id from brain.drive_migration_intents where file_id='${f.fileId}'`)).toEqual([{state:'committed',expected_home_id:newId}]);
    expect(f.server.files.size).toBe(1); expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:true});
  } finally {barrier.release(); await pending.catch(()=>undefined);}
});

it('같은 해시가 두 루트에 있어도 다른 루트로 show하거나 위치 삭제를 완료하지 않는다',async()=>{
  const f=await fixture('30'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  const other=driveFileStore({rootFolderId:'other-root',baseUrl:f.server.baseUrl,uploads:f.store.driveUploads,clock:f.clock});
  expect(await other.put(f.bytes)).toMatchObject({ok:true}); expect(f.server.files.size).toBe(2);
  const before=f.server.requests.length, shown=await f.cliShow('other-root');
  expect(shown.code).not.toBe(0); expect(shown.stdout).not.toContain('원본 내용');
  expect(f.server.requests.slice(before).some(r=>r.path.includes('alt=media'))).toBe(false);
  const intent=await f.store.readDriveIntent(f.fileId); if (!intent.ok || !intent.intent) throw Error('intent missing');
  expect(await f.brain.files.redact({file:f.fileId,confirm:true})).toMatchObject({ok:true});
  const handler=blobDeleteHandler({store:f.store,files:f.local,driveFiles:other,driveRoot:{store:f.store,rootFolderId:'other-root'},clock:f.clock});
  expect(await handler({targetId:intent.intent.locationId} as import('second_brain').WorkItem)).toMatchObject({ok:false,code:'LOCATION_REFUSED'});
  expect(await f.store.readFileLocation(intent.intent.locationId)).toMatchObject({ok:true,location:{deletedAt:null}});
  expect(f.server.files.size).toBe(2);
});

it('두 업로더 중 제출 전 지연된 쪽은 가리기 삭제 뒤에 원격 파일을 다시 만들지 못한다',async()=>{
  const f=await fixture('0');
  let entered!:()=>void, release!:()=>void;
  const reached=new Promise<void>(resolve=>{entered=resolve;}), wait=new Promise<void>(resolve=>{release=resolve;});
  const slowUploads={...f.store.driveUploads,async start(input:Parameters<typeof f.store.driveUploads.start>[0]) {entered(); await wait; return f.store.driveUploads.start(input);}};
  const slowDrive=driveFileStore({rootFolderId:'brain-root',baseUrl:f.server.baseUrl,uploads:slowUploads,clock:f.clock});
  const pending=migrateFileToDrive({store:f.store,uploads:slowUploads,local:f.local,drive:slowDrive,settings:f.settings,rootFolderId:'brain-root',clock:f.clock,idGen:f.idGen},f.fileId);
  try {
    await reached;
    expect(await f.drive.put(f.bytes)).toMatchObject({ok:true}); expect(f.server.files.size).toBe(1);
    expect(await f.brain.files.redact({file:f.fileId,confirm:true})).toMatchObject({ok:true});
    await f.brain.queue.drain({budgetMs:5000}); expect(f.server.files.size).toBe(0);
    const count=f.server.requests.filter(r=>r.method==='POST' && r.path.startsWith('/upload/')).length;
    release(); expect(await pending).toMatchObject({ok:false});
    expect(f.server.files.size).toBe(0);
    expect(f.server.requests.filter(r=>r.method==='POST' && r.path.startsWith('/upload/'))).toHaveLength(count);
  } finally {release(); await pending.catch(()=>undefined);}
});

it('보관 삭제가 원격 GET 중 home 변경을 관찰하면 로컬을 보존한다',async()=>{
  const f=await fixture('30'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  await f.brain.queue.drain({budgetMs:5000});
  const seen:boolean[]=[];
  const observed={...f.store,async readDriveRetention(id:string) {const result=await f.store.readDriveRetention(id); if(result.ok && result.retention) seen.push(result.retention.eligible); return result;}};
  const brain=createBrain({...f.dependencies,drive:{...f.integration,store:observed}});
  f.clock.set('2026-01-31T00:00:00.000Z');
  const barrier=f.server.holdNextDownload(), pending=brain.queue.drain({budgetMs:5000});
  try {
    await barrier.entered; expect(seen).toEqual([true]);
    await f.db.query(`update brain.files set home_location_id='${f.localId}' where id='${f.fileId}'`);
    barrier.release(); await pending; expect(seen).toEqual([true,false]);
    expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:true});
    expect(await f.store.readFileLocation(f.localId)).toMatchObject({ok:true,location:{deletedAt:null}});
  } finally {barrier.release(); await pending.catch(()=>undefined);}
});

it('Drive home을 실제 drain으로 재추출하고 새 세대에 원격 바이트를 기록한다',async()=>{
  const f=await fixture('0'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  await f.brain.queue.drain({budgetMs:5000});
  expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:false});
  const before=f.server.requests.length;
  expect(await f.store.addWork({id:f.idGen.next(),kind:'document_extract',targetKind:'file',targetId:f.fileId,createdAt:f.clock.now(),nextAttemptAt:f.clock.now()})).toMatchObject({ok:true});
  await f.brain.queue.drain({budgetMs:5000});
  const rows=await f.db.rows<{current_extraction_id:string;body:string}>(`select f.current_extraction_id,c.body from brain.files f join brain.document_chunks c on c.extraction_id=f.current_extraction_id where f.id='${f.fileId}' order by c.ordinal`);
  expect(rows.length).toBeGreaterThan(0); expect(rows[0]!.current_extraction_id).not.toBe(f.extractionId);
  expect(rows.map(r=>r.body).join('')).toContain('원본 내용');
  expect(f.server.requests.slice(before).some(r=>r.path.includes('alt=media'))).toBe(true);
});

it('Drive 원문 조각 중첩과 마스킹, next 및 세대 교체를 유지한다',async()=>{
  const body='앞부분 '+ '가'.repeat(9000) + ' password=synthetic-secret-123 끝부분';
  const f=await fixture('30',body);
  const length=Array.from(body).length, loc=(start:number,end:number)=>JSON.stringify({type:'text',start,end});
  const contextId=f.idGen.next();
  await f.db.query(`insert into brain.document_extractions(id,file_id,extractor_version,attempt,media_type,status,started_at,finished_at) values ('${contextId}','${f.fileId}','${DOCUMENT_EXTRACTOR_VERSION}',2,'text/plain','ok','2026-01-01Z','2026-01-01Z')`);
  for (const [ordinal,start,end] of [[0,0,5000],[1,4900,9016],[2,9016,length]] as const) {
    await f.db.query(`insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ('${f.idGen.next()}','${contextId}',${ordinal},'${Array.from(body).slice(start,end).join('')}','${loc(start,end)}')`);
  }
  await f.db.query(`update brain.files set current_extraction_id='${contextId}' where id='${f.fileId}'`);
  const input={file_id:f.fileId,chunk_locator:loc(0,length),before:0,after:0};
  const localFirst=await f.brain.files.show(input); if (!localFirst.ok || !localFirst.meta.next) throw Error('local next missing');
  const localNext=await f.brain.files.show(localFirst.meta.next.args as typeof input);
  expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  const first=await f.brain.files.show(input); if (!first.ok || !first.meta.next) throw Error('next missing');
  expect(first).toEqual(localFirst);
  expect(JSON.stringify(first)).not.toContain('synthetic-secret-123');
  const next=first.meta.next.args as typeof input & {extraction_id:string;offset:number;fingerprint:string};
  const second=await f.brain.files.show(next); expect(second).toEqual(localNext); expect(second.ok).toBe(true);
  expect(JSON.stringify(second)).not.toContain('synthetic-secret-123');
  const collected=[...first.data,...(second.ok ? second.data : [])].map(row=>row.body).join('');
  expect(collected).toContain('앞부분'); expect(collected).toContain('끝부분');
  expect((collected.match(/가/g) ?? [])).toHaveLength(9000);
  const newId=f.idGen.next();
  await f.db.query(`insert into brain.document_extractions(id,file_id,extractor_version,attempt,media_type,status,started_at,finished_at) values ('${newId}','${f.fileId}','${DOCUMENT_EXTRACTOR_VERSION}',3,'text/plain','ok','2026-01-01Z','2026-01-01Z'); insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ('${f.idGen.next()}','${newId}',0,'${'x'.repeat(length)}','${loc(0,length)}'); update brain.files set current_extraction_id='${newId}' where id='${f.fileId}'`);
  expect(await f.brain.files.show(next)).toMatchObject({ok:true,meta:{generation_changed:true,hint:expect.any(String)}});
});


it('Drive GET 중 추출 세대가 바뀌면 이전 세대의 응답을 내보내지 않는다',async()=>{
  const f=await fixture('30'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  const barrier=f.server.holdNextDownload(), pending=f.brain.files.show({file_id:f.fileId,chunk_locator:f.locator});
  try {
    await barrier.entered;
    const newId=f.idGen.next();
    await f.db.query(`insert into brain.document_extractions(id,file_id,extractor_version,attempt,media_type,status,started_at,finished_at) values ('${newId}','${f.fileId}','${DOCUMENT_EXTRACTOR_VERSION}',2,'text/plain','ok','2026-01-01Z','2026-01-01Z'); update brain.files set current_extraction_id='${newId}' where id='${f.fileId}'`);
    barrier.release(); expect(await pending).toMatchObject({ok:false,code:'FILES_UNAVAILABLE'});
  } finally {barrier.release(); await pending.catch(()=>undefined);}
});

it('제출 응답 지연의 시간 제한 뒤 home과 불확실 매핑을 보존한다',async()=>{
  const f=await fixture('0'), barrier=f.server.holdNextUpload();
  const drive=driveFileStore({rootFolderId:'brain-root',baseUrl:f.server.baseUrl,uploads:f.store.driveUploads,clock:f.clock,timeoutMs:30});
  const pending=migrateFileToDrive({store:f.store,uploads:f.store.driveUploads,local:f.local,drive,settings:f.settings,rootFolderId:'brain-root',clock:f.clock,idGen:f.idGen},f.fileId);
  try {
    await barrier.entered; expect(await pending).toMatchObject({ok:false});
    expect(await f.db.rows(`select home_location_id from brain.files where id='${f.fileId}'`)).toEqual([{home_location_id:f.localId}]);
    expect(await f.local.exists(f.put.location)).toEqual({ok:true,exists:true});
    expect(await f.store.driveUploads.read({rootFolderId:'brain-root',contentHash:f.put.contentHash})).toMatchObject({ok:true,upload:{state:'submitting'}});
  } finally {barrier.release(); await pending.catch(()=>undefined);}
});

it('보관 삭제 drain의 성공과 이미 삭제된 재시도는 열린 실패 기록을 해소한다',async()=>{
  const f=await fixture('0'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  const record=()=>f.store.recordFailure({id:f.idGen.next(),targetKind:'file_location',targetId:f.localId,stage:'drive_local_delete',fingerprint:`sha256:${f.idGen.next()}`,harness:null,sessionId:null,code:'FILES_UNAVAILABLE',message:'합성 실패',occurredAt:f.clock.now()});
  expect(await record()).toMatchObject({ok:true}); await f.brain.queue.drain({budgetMs:5000});
  expect(await f.store.listFailures({targetKind:'file_location',stage:'drive_local_delete'})).toMatchObject({ok:true,failures:[]});
  expect(await record()).toMatchObject({ok:true});
  expect(await f.brain.failures.retry({targetKind:'file_location'})).toMatchObject({ok:true,added:1});
  await f.brain.queue.drain({budgetMs:5000});
  expect(await f.store.listFailures({targetKind:'file_location',stage:'drive_local_delete'})).toMatchObject({ok:true,failures:[]});
});

it('일시적인 Drive root DB 오류는 추출 재시도 뒤 복구되며 접근 불가로 기록하지 않는다',async()=>{
  const f=await fixture('30'); expect(await f.migrate()).toMatchObject({ok:true,state:'committed'});
  await f.brain.queue.drain({budgetMs:5000});
  let fail=true;
  const driveStore={...f.store,async readDriveLocatorRoot(locator:string) {
    if(fail) {fail=false; return {ok:false as const,code:'DB_LOCKED' as const,message:'synthetic'};}
    return f.store.readDriveLocatorRoot(locator);
  }};
  const brain=createBrain({...f.dependencies,drive:{...f.integration,store:driveStore}});
  const workId=f.idGen.next();
  expect(await f.store.addWork({id:workId,kind:'document_extract',targetKind:'file',targetId:f.fileId,createdAt:f.clock.now(),nextAttemptAt:f.clock.now()})).toMatchObject({ok:true});
  await brain.queue.drain({budgetMs:5000});
  expect(await f.store.readFileExtractionState(f.fileId)).toMatchObject({ok:true,sourceUnreachableAt:null,currentExtractionId:f.extractionId});
  const jobs=await f.db.rows<{attempts:number;completed_at:Date|null}>(`select attempts,completed_at from brain.work_items where id='${workId}'`);
  expect(jobs).toMatchObject([{attempts:1,completed_at:null}]);
  f.clock.set('2026-01-01T01:00:00.000Z'); await brain.queue.drain({budgetMs:5000});
  const state=await f.store.readFileExtractionState(f.fileId);
  expect(state).toMatchObject({ok:true,sourceUnreachableAt:null});
  if(!state.ok || !state.currentExtractionId) throw Error('extraction missing');
  expect(state.currentExtractionId).not.toBe(f.extractionId);
  const rows=await f.db.rows<{body:string}>(`select body from brain.document_chunks where extraction_id='${state.currentExtractionId}' order by ordinal`);
  expect(rows.map(r=>r.body).join('')).toContain('원본 내용');
  expect(await f.db.rows(`select completed_at from brain.work_items where id='${workId}'`)).toMatchObject([{completed_at:expect.anything()}]);
});
