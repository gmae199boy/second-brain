import { createHash, randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { expect, it } from 'vitest';
import { drainQueue, handoffImportRequests, cleanupImportRequests, importFileHandler, FILE_IMPORT_KIND } from '@second-brain/core';
import { memorySpool, sequenceIdGen } from '@second-brain/core/testing';
import { importStaging } from '../../../apps/cli/src/runtime/import-staging.js';
import { localFileStore } from '../../../apps/cli/src/runtime/file-store.js';
import { provisionExtension, postgresStore } from '../src/index.js';
import { database } from './fixture.js';

it.each(['request','handoff','put','result'] as const)('실제 프로세스 %s 지점 kill 후 하나의 요청·인계·파일로 수렴한다',async phase=>{
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`, role=`brain_ext_${name}`, password=randomBytes(24).toString('hex');
  const home=await mkdtemp(join(tmpdir(),'brain-crash-')), dir=join(home,'extensions',name,'staging');
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  const ids=sequenceIdGen({timestampMs:Date.now()}), spool=memorySpool(); let at=Date.now(); const clock={now:()=>new Date(at)};
  let ext:pg.Client|undefined, child:ChildProcess|undefined, locked=false;
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    const url=new URL(db.url); url.username=role; url.password=password; ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds values ($1,$2)',[name,`${name}.import`]);
    const producer=ids.next(), token=ids.next(), request=ids.next(), body=Buffer.from('# 합성 crash 문서\n'), hash=createHash('sha256').update(body).digest('hex');
    await store.addWork({id:producer,kind:`${name}.import`,targetKind:'import',targetId:'test',createdAt:clock.now(),nextAttemptAt:clock.now()});
    expect(await store.claimSupervisedWork({now:clock.now(),claimedBy:'producer',kinds:[`${name}.import`],attemptToken:token})).toMatchObject({ok:true});
    await mkdir(dir,{recursive:true}); await writeFile(join(dir,'document.md'),body);
    const requestValues=[request,name,hash,body.length,clock.now().toISOString(),producer,token];
    const insert=`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,'crash','d','b','document.md',$3,$4,'text/markdown',$5,$6,$7)`;
    const spawn=async(config:Record<string,unknown>,expected:string)=>{
      const program=fileURLToPath(new URL('./fixtures/import-crash-child.mjs',import.meta.url));
      child=fork(program,[],{env:{...process.env,BRAIN_TEST_CRASH_CONFIG:JSON.stringify({home,root:join(home,'files'),stagingModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/import-staging.js',import.meta.url)),fileModule:fileURLToPath(new URL('../../../apps/cli/dist/runtime/file-store.js',import.meta.url)),...config})},stdio:['ignore','ignore','inherit','ipc']});
      expect((await once(child,'message'))[0]).toBe(expected);
    };
    if(phase==='request') await spawn({phase,url:url.toString(),values:requestValues},'request-committed');
    else {
      await ext.query(insert,requestValues);
      if(phase==='handoff') {
        await admin.query('select pg_advisory_lock(778812345)'); locked=true;
        await admin.query(`create function brain.test_import_barrier() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(778812345); return new; end $$; create trigger test_import_barrier before insert on brain.file_request_handoffs for each row execute function brain.test_import_barrier()`);
        await spawn({phase,url:db.appUrl,requestId:request,workId:ids.next(),now:clock.now().toISOString()},'handoff-started');
        await expect.poll(async()=>Number((await admin.query("select count(*) as n from pg_locks where locktype='advisory' and not granted and objid=778812345")).rows[0].n),{timeout:10000}).toBeGreaterThan(0);
      } else {
        expect(await store.imports.handoffImport({requestId:request,workId:ids.next(),now:clock.now()})).toMatchObject({ok:true,created:true});
        const claim=await store.claimWork({now:clock.now(),claimedBy:'crash',kinds:[FILE_IMPORT_KIND]});
        if (!claim.ok || !claim.item) throw Error('claim missing');
        await spawn({phase,url:db.appUrl,item:claim.item,now:clock.now().toISOString()},phase==='put'?'put-completed':'result-committed');
        expect((await admin.query('select count(*)::int as n from brain.file_request_results')).rows[0].n).toBe(phase==='result'?1:0);
      }
    }
    if (phase!=='result') await cleanupImportRequests(store.imports,importStaging(home),clock);
    expect(await readFile(join(dir,'document.md'))).toEqual(body);
    const closed=once(child!,'close'); child!.kill('SIGKILL'); await closed; child=undefined;
    if(locked){await admin.query('select pg_advisory_unlock(778812345)'); locked=false; await admin.query('drop trigger test_import_barrier on brain.file_request_handoffs; drop function brain.test_import_barrier()');}
    if(phase==='handoff') expect((await admin.query("select count(*)::int as n from brain.work_items where kind='file_import'")).rows[0].n).toBe(0);
    at+=4_000_000;
    await spawn({phase:phase==='result'?'cleanup-recover':'recover',url:db.appUrl,now:clock.now().toISOString()},phase==='result'?'cleanup-recovered':'recovered');
    const recoveryClose=await once(child!,'close'); expect(recoveryClose[0]).toBe(0); child=undefined;
    const files=localFileStore({root:join(home,'files')});
    await expect(readFile(join(dir,'document.md'))).rejects.toMatchObject({code:'ENOENT'});
    expect((await admin.query('select count(*)::int as n from brain.file_requests')).rows[0].n).toBe(1);
    expect((await admin.query('select count(*)::int as n from brain.file_request_handoffs')).rows[0].n).toBe(1);
    expect((await admin.query('select count(*)::int as n from brain.file_request_results where file_id is not null')).rows[0].n).toBe(1);
    expect((await admin.query('select count(*)::int as n from brain.files')).rows[0].n).toBe(1);
    const location=(await admin.query('select locator from brain.file_locations')).rows[0].locator;
    expect(await files.get({storeKind:'local',ownership:'brain',locator:location})).toEqual({ok:true,bytes:new Uint8Array(body)});
  } finally {
    if(child){const closed=once(child,'close'); child.kill('SIGKILL'); await closed;}
    if(locked) await admin.query('select pg_advisory_unlock(778812345)').catch(()=>{});
    await ext?.end(); await store.close(); await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{}); await admin.end(); await db.drop(); await rm(home,{recursive:true,force:true});
  }
},30000);
