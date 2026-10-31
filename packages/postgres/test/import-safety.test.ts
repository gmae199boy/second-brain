import { createHash, randomBytes } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { expect, it } from 'vitest';
import { cleanupImportRequests, drainQueue, importFileHandler, FILE_IMPORT_KIND } from '@second-brain/core';
import { memorySpool, sequenceIdGen } from '@second-brain/core/testing';
import { importStaging } from '../../../apps/cli/src/runtime/import-staging.js';
import { localFileStore } from '../../../apps/cli/src/runtime/file-store.js';
import { provisionExtension, postgresStore } from '../src/index.js';
import { database } from './fixture.js';

it('미완료 공유 locator 보호, unlink 실패 재개, 오염 blob과 만료 청구를 거부한다',async()=>{
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`, role=`brain_ext_${name}`, password=randomBytes(24).toString('hex');
  const home=await mkdtemp(join(tmpdir(),'brain-import-safe-')), dir=join(home,'extensions',name,'staging');
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl}), ids=sequenceIdGen({timestampMs:Date.now()}), spool=memorySpool();
  let at=Date.now(); const clock={now:()=>new Date(at)}, body=Buffer.from('# synthetic safety\n'), hex=createHash('sha256').update(body).digest('hex');
  let ext:pg.Client|undefined;
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    const url=new URL(db.url); url.username=role; url.password=password; ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds values ($1,$2)',[name,`${name}.import`]);
    const producer=ids.next(),token=ids.next();
    await store.addWork({id:producer,kind:`${name}.import`,targetKind:'import',targetId:'test',createdAt:clock.now(),nextAttemptAt:clock.now()});
    await store.claimSupervisedWork({now:clock.now(),claimedBy:'producer',kinds:[`${name}.import`],attemptToken:token});
    await mkdir(dir,{recursive:true});
    const insert=async(key:string,locator:string,hash=hex,size=body.length)=>{
      const id=ids.next(); await ext!.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'d','b',$4,$5,$6,'text/markdown',$7,$8,$9)`,[id,name,key,locator,hash,size,clock.now(),producer,token]); return id;
    };
    const files=localFileStore({root:join(home,'files')}), staging=importStaging(home);
    const run=async()=>drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[FILE_IMPORT_KIND]:importFileHandler(store.imports,staging,files,clock,ids,store,store)}});
    await writeFile(join(dir,'shared.md'),body);
    const first=await insert('one','shared.md'), second=await insert('two','shared.md');
    await cleanupImportRequests(store.imports,staging,clock); expect(await readFile(join(dir,'shared.md'))).toEqual(body);
    const otherStore=postgresStore({databaseUrl:db.appUrl});
    try {
      const attempts=await Promise.all([store.imports.handoffImport({requestId:first,workId:ids.next(),now:clock.now()}),otherStore.imports.handoffImport({requestId:first,workId:ids.next(),now:clock.now()})]);
      expect(attempts).toContainEqual({ok:true,created:true}); expect(attempts).toContainEqual({ok:true,created:false});
      expect((await admin.query('select count(*)::int as n from brain.file_request_handoffs where request_id=$1',[first])).rows[0].n).toBe(1);
      expect((await admin.query("select count(*)::int as n from brain.work_items where kind='file_import' and target_id=$1",[first])).rows[0].n).toBe(1);
    } finally { await otherStore.close(); }
    expect(await run()).toMatchObject({completed:1});
    expect(await readFile(join(dir,'shared.md'))).toEqual(body);
    await store.imports.handoffImport({requestId:second,workId:ids.next(),now:clock.now()});
    // 결과 확정 직후 unlink 실패는 작업 성공과 정리 재발견을 분리한다.
    const broken={...staging,remove:async()=>{throw Error('unlink failed');}};
    const handler=importFileHandler(store.imports,broken,files,clock,ids,store,store);
    expect(await drainQueue({store,clock,idGen:ids,spool},{budgetMs:5000,handlers:{[FILE_IMPORT_KIND]:handler}})).toMatchObject({completed:1});
    expect(await readFile(join(dir,'shared.md'))).toEqual(body);
    expect((await admin.query('select count(*)::int as n from brain.file_import_cleanup where cleaned_at is null')).rows[0].n).toBe(2);
    const cleanupChild=fork(fileURLToPath(new URL('./fixtures/import-crash-child.mjs',import.meta.url)),[],{env:{...process.env,BRAIN_TEST_CRASH_CONFIG:JSON.stringify({phase:'cleanup',home,requestId:first,now:clock.now().toISOString(),url:db.appUrl,stagingModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/import-staging.js',import.meta.url)),fileModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/file-store.js',import.meta.url))})},stdio:['ignore','ignore','inherit','ipc']});
    try {
      expect((await once(cleanupChild,'message'))[0]).toBe('unlinked');
      const closed=once(cleanupChild,'close'); cleanupChild.kill('SIGKILL'); await closed;
    } finally { if(cleanupChild.exitCode===null && cleanupChild.signalCode===null) cleanupChild.kill('SIGKILL'); }
    expect((await admin.query('select count(*)::int as n from brain.file_import_cleanup where cleaned_at is null and deleting_at is not null')).rows[0].n).toBe(2);
    await expect(insert('during-cleanup','shared.md')).rejects.toThrow();
    await cleanupImportRequests(store.imports,staging,clock);
    await expect(readFile(join(dir,'shared.md'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await admin.query('select count(*)::int as n from brain.file_import_cleanup where cleaned_at is not null')).rows[0].n).toBe(2);
    await expect(insert('reuse','shared.md')).rejects.toThrow();
    const badBody=Buffer.from('# corrupted target\n'), badHash=createHash('sha256').update(badBody).digest('hex');
    await writeFile(join(dir,'bad.md'),badBody); const bad=await insert('bad','bad.md',badHash,badBody.length);
    const stored=await files.put(badBody); if(!stored.ok) throw Error('put failed');
    await writeFile(join(home,'files',stored.location.locator),Buffer.alloc(badBody.length,120));
    await store.imports.handoffImport({requestId:bad,workId:ids.next(),now:clock.now()});
    expect(await run()).toMatchObject({failed:1});
    expect((await admin.query('select file_id,error_code from brain.file_request_results where request_id=$1',[bad])).rows).toEqual([{file_id:null,error_code:'IMPORT_FILE_INVALID'}]);
    expect(await readFile(join(dir,'bad.md'))).toEqual(badBody);
    expect((await admin.query('select count(*)::int as n from brain.files where content_hash=$1',['sha256:'+badHash])).rows[0].n).toBe(0);
    await writeFile(join(dir,'mismatch.md'),body); const mismatch=await insert('mismatch','mismatch.md','f'.repeat(64),body.length);
    await store.imports.handoffImport({requestId:mismatch,workId:ids.next(),now:clock.now()}); expect(await run()).toMatchObject({failed:1});
    expect((await admin.query('select file_id,error_code from brain.file_request_results where request_id=$1',[mismatch])).rows).toEqual([{file_id:null,error_code:'IMPORT_FILE_INVALID'}]);
    expect(await readFile(join(dir,'mismatch.md'))).toEqual(body);
    await writeFile(join(dir,'stale.md'),body); const stale=await insert('stale','stale.md');
    const work=ids.next(); await store.imports.handoffImport({requestId:stale,workId:work,now:clock.now()});
    const claim=await store.claimWork({now:clock.now(),claimedBy:'stale',kinds:[FILE_IMPORT_KIND]}); if(!claim.ok || !claim.item?.claimedAt) throw Error('claim missing');
    expect(await store.imports.failImport({requestId:stale,workId:work,claimedBy:'stale',claimedAt:claim.item.claimedAt,claimAttempt:claim.item.attempts-1,code:'IMPORT_FILE_INVALID',now:clock.now()})).toMatchObject({ok:false});
    at+=4_000_000;
    expect(await store.imports.failImport({requestId:stale,workId:work,claimedBy:'stale',claimedAt:claim.item.claimedAt,claimAttempt:claim.item.attempts,code:'IMPORT_FILE_INVALID',now:clock.now()})).toMatchObject({ok:false});
    expect((await admin.query('select count(*)::int as n from brain.file_request_results where request_id=$1',[stale])).rows[0].n).toBe(0);
  } finally {await ext?.end(); await store.close(); await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{}); await admin.end(); await db.drop(); await rm(home,{recursive:true,force:true});}
},30000);
