import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { BLOB_DELETE_KIND, FILE_IMPORT_KIND, blobDeleteHandler, drainQueue, enqueueDocumentExtractions, importFileHandler, planFileRedaction, type FileStore } from '@second-brain/core';
import { memorySpool, sequenceIdGen } from '@second-brain/core/testing';
import { importStaging } from '../../../apps/cli/src/runtime/import-staging.js';
import { localFileStore } from '../../../apps/cli/src/runtime/file-store.js';
import { provisionExtension, postgresStore } from '../src/index.js';
import { database } from './fixture.js';

async function fixture() {
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`, role=`brain_ext_${name}`, password=randomBytes(24).toString('hex');
  const home=await mkdtemp(join(tmpdir(),'brain-import-mask-')), dir=join(home,'extensions',name,'staging');
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  const ids=sequenceIdGen({timestampMs:Date.now()}), spool=memorySpool(); let at=Date.now(); const clock={now:()=>new Date(at)};
  await admin.connect(); await provisionExtension(db.url,name,password);
  const url=new URL(db.url); url.username=role; url.password=password; const ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
  await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
  await admin.query('insert into brain.extension_work_kinds values ($1,$2)',[name,`${name}.import`]);
  const producer=ids.next(),token=ids.next(),now=clock.now();
  await store.addWork({id:producer,kind:`${name}.import`,targetKind:'import',targetId:'test',createdAt:now,nextAttemptAt:now});
  await store.claimSupervisedWork({now,claimedBy:'producer',kinds:[`${name}.import`],attemptToken:token});
  await mkdir(dir,{recursive:true}); const body=Buffer.from('# 합성 가리기 문서\n'), hash=createHash('sha256').update(body).digest('hex');
  const real=localFileStore({root:join(home,'files')}), staging=importStaging(home);
  async function request(key:string) {
    const id=ids.next(); await writeFile(join(dir,key),body);
    await ext.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'dataset','batch',$3,$4,$5,'text/markdown',$6,$7,$8)`,[id,name,key,hash,body.length,clock.now(),producer,token]);
    expect(await store.imports.handoffImport({requestId:id,workId:ids.next(),now:clock.now()})).toMatchObject({ok:true,created:true}); return id;
  }
  async function drain(files:FileStore) { return drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[FILE_IMPORT_KIND]:importFileHandler(store.imports,staging,files,clock,ids,store,store)}}); }
  async function redact(fileId:string) {
    expect(await store.redactFile({fileId,plan: current=>planFileRedaction(current,{clock,idGen:ids})})).toMatchObject({ok:true});
    expect(await drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[BLOB_DELETE_KIND]:blobDeleteHandler({store,files:real,clock})}})).toMatchObject({stopped:'empty'});
  }
  return {db,store,admin,ext,ids,clock,real,dir,body,request,drain,redact,advance(){at+=4_000_000;},async close(){await ext.end(); await store.close(); await admin.query(`drop owned by "${role}"; drop role "${role}"`); await admin.end(); await db.drop(); await rm(home,{recursive:true,force:true});}};
}

it('이미 가린 내용의 새 요청은 put 없이 가린 파일을 참조한다',async()=>{
  const f=await fixture();
  try {
    await f.request('first.md'); expect(await f.drain(f.real)).toMatchObject({completed:1});
    const before=(await f.admin.query('select id,home_location_id from brain.files')).rows[0];
    const loc=(await f.admin.query('select * from brain.file_locations where id=$1',[before.home_location_id])).rows[0];
    await f.redact(before.id);
    const masked=(await f.admin.query('select redacted_at,home_location_id from brain.files where id=$1',[before.id])).rows[0];
    const deleted=(await f.admin.query('select deleted_at from brain.file_locations where id=$1',[loc.id])).rows[0];
    let puts=0; const guarded:FileStore={...f.real,put:async bytes=>{puts++; return f.real.put(bytes);}};
    await f.request('second.md'); expect(await f.drain(guarded)).toMatchObject({completed:1});
    expect(puts).toBe(0); expect(await f.real.exists({storeKind:'local',locator:loc.locator,ownership:'brain'})).toEqual({ok:true,exists:false});
    expect((await f.admin.query('select redacted_at,home_location_id from brain.files where id=$1',[before.id])).rows[0]).toEqual(masked);
    expect((await f.admin.query('select deleted_at from brain.file_locations where id=$1',[loc.id])).rows[0]).toEqual(deleted);
    expect((await f.admin.query('select distinct file_id from brain.file_request_results')).rows).toEqual([{file_id:before.id}]);
    await enqueueDocumentExtractions({store:f.store,clock:f.clock,idGen:f.ids},{deadline:f.clock.now().getTime()+5000});
    expect((await f.admin.query("select count(*)::int as n from brain.work_items where kind='document_extract'")).rows[0].n).toBe(0);
    expect((await f.admin.query('select count(*)::int as n from brain.document_extractions')).rows[0].n).toBe(0);
  } finally {await f.close();}
});

it('put과 확정 사이 가리기가 끝나고 정리가 실패해도 재시도로 블롭을 제거한다',async()=>{
  const f=await fixture();
  try {
    await f.request('first.md'); await f.drain(f.real);
    const file=(await f.admin.query('select id,home_location_id from brain.files')).rows[0];
    const location=(await f.admin.query('select locator from brain.file_locations where id=$1',[file.home_location_id])).rows[0].locator;
    let puts=0,deletes=0;
    const raced:FileStore={...f.real,
      put:async bytes=>{puts++; await f.redact(file.id); return f.real.put(bytes);},
      delete:async location=>{deletes++; return deletes===1 ? {ok:false,code:'FILES_UNAVAILABLE',message:'시험 정리 실패'} : f.real.delete(location);}};
    await f.request('second.md'); expect(await f.drain(raced)).toMatchObject({retried:1,completed:0});
    expect(await f.real.exists({storeKind:'local',locator:location,ownership:'brain'})).toEqual({ok:true,exists:true});
    expect(await readFile(join(f.dir,'second.md'))).toEqual(f.body);
    f.advance(); expect(await f.drain(raced)).toMatchObject({completed:1});
    expect(puts).toBe(1); expect(deletes).toBe(2);
    expect(await f.real.exists({storeKind:'local',locator:location,ownership:'brain'})).toEqual({ok:true,exists:false});
    expect((await f.admin.query('select count(*)::int as n from brain.file_request_results where file_id=$1',[file.id])).rows[0].n).toBe(2);
  } finally {await f.close();}
});
