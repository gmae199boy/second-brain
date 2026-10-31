import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { drainQueue, retryFailures, importFileHandler, FILE_IMPORT_KIND, type FileStore } from '@second-brain/core';
import { memorySpool, sequenceIdGen } from '@second-brain/core/testing';
import { importStaging } from '../../../apps/cli/src/runtime/import-staging.js';
import { localFileStore } from '../../../apps/cli/src/runtime/file-store.js';
import { provisionExtension, postgresStore } from '../src/index.js';
import { database } from './fixture.js';

it('파일 저장 10회 실패 뒤 공개 실패와 기존 재시도에서 성공까지 이어진다', async () => {
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`, role=`brain_ext_${name}`, password=randomBytes(24).toString('hex');
  const home=await mkdtemp(join(tmpdir(),'brain-import-retry-')), stagingDir=join(home,'extensions',name,'staging');
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  let ext: pg.Client | undefined;
  const ids=sequenceIdGen({timestampMs:Date.now()}), spool=memorySpool();
  let at=Date.now(); const clock={now:()=>new Date(at)};
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    const url=new URL(db.url); url.username=role; url.password=password; ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds values ($1,$2)',[name,`${name}.import`]);
    const work=ids.next(),token=ids.next(),request=ids.next(), now=clock.now();
    await store.addWork({id:work,kind:`${name}.import`,targetKind:'import',targetId:'test',createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'producer',kinds:[`${name}.import`],attemptToken:token});
    await mkdir(stagingDir,{recursive:true}); const body=Buffer.from('# 합성 문서\n'); await writeFile(join(stagingDir,'document.md'),body);
    await ext.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,'request','dataset','batch','document.md',$3,$4,'text/markdown',$5,$6,$7)`,[request,name,createHash('sha256').update(body).digest('hex'),body.length,now,work,token]);
    expect(await store.imports.handoffImport({requestId:request,workId:ids.next(),now})).toMatchObject({ok:true,created:true});
    const publicStatus=async()=> (await ext!.query('select status,resumable,error_code,file_id from brain.file_request_results_public_v1 where request_id=$1',[request])).rows[0];
    expect(await publicStatus()).toMatchObject({status:'processing',resumable:false});
    let puts=0;
    const real=localFileStore({root:join(home,'files')});
    const files: FileStore={...real,put:async bytes=>{ puts++; return puts<=10 ? {ok:false,code:'FILES_UNAVAILABLE',message:'시험 저장 실패'} : real.put(bytes); }};
    const handler=importFileHandler(store.imports,importStaging(home),files,clock,ids,store,store);
    for (let i=1;i<=10;i++) {
      const result=await drainQueue({store,clock,idGen:ids,spool},{budgetMs:1000,handlers:{[FILE_IMPORT_KIND]:handler}});
      expect(result).toMatchObject(i<10 ? {retried:1,failed:0} : {retried:0,failed:1});
      expect(await readFile(join(stagingDir,'document.md'))).toEqual(body);
      at+=4_000_000;
    }
    expect(await publicStatus()).toMatchObject({status:'failed',resumable:true,error_code:'FILES_UNAVAILABLE',file_id:null});
    expect(await retryFailures({store,clock,idGen:ids},{targetKind:'file_request'})).toMatchObject({ok:true,added:1,skipped:[]});
    expect(await publicStatus()).toMatchObject({status:'processing',resumable:false});
    expect(await drainQueue({store,clock,idGen:ids,spool},{budgetMs:1000,handlers:{[FILE_IMPORT_KIND]:handler}})).toMatchObject({completed:1});
    expect(await publicStatus()).toMatchObject({status:'completed',resumable:false,error_code:null});
    expect(puts).toBe(11);
    expect((await admin.query('select resolved_at from brain.failures where target_id=$1',[request])).rows[0].resolved_at).not.toBeNull();
    await expect(readFile(join(stagingDir,'document.md'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await admin.query('select count(*)::int as n from brain.files')).rows[0].n).toBe(1);
  } finally {
    await ext?.end(); await store.close(); await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{});
    await admin.end(); await db.drop(); await rm(home,{recursive:true,force:true});
  }
});
