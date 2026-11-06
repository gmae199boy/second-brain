import os from 'node:os';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { checkoutRevision, artifactFingerprint, runnerFingerprint } from './revision.mjs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { median, hash, candidateConflict } from './core.mjs';
const pendingRewritten='select 1 from brain.file_requests q where q.source=$1 and q.locator=$2 and not exists (select 1 from brain.file_request_results r where r.request_id=q.id and r.file_id is not null) limit 1';
const summary=p=>({executionTimeMs:p['Execution Time'],sharedHitBlocks:p.Plan['Shared Hit Blocks'],sharedReadBlocks:p.Plan['Shared Read Blocks']});
const fixed="'2026-01-01T00:00:00Z'::timestamptz";
const work="'00000000-0000-0000-0000-000000000001'";
const rewritten=`select c.request_id as id from brain.file_import_cleanup c join brain.file_requests target on target.id=c.request_id where c.cleaned_at is null and not exists (select 1 from brain.file_requests q where q.source=target.source and q.locator=target.locator and not exists (select 1 from brain.file_request_results r where r.request_id=q.id and r.file_id is not null)) order by c.request_id limit 500`;
async function fixture(c,n,condition) {
 await c.query(`set session_replication_role=replica;
 insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at) values(${work},'synthetic','core','synthetic','synthetic',${fixed},${fixed});
 insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values('synthetic','1',${fixed},true,${fixed});
 insert into brain.extension_work_kinds(extension_name,kind) values('synthetic','synthetic');
 insert into brain.work_attempts(token,work_item_id,started_at) values(${work},${work},${fixed});
 update brain.work_items set current_attempt_token=${work},claimed_at=${fixed},claim_expires_at='2099-01-01',claimed_by='synthetic' where id=${work};
 insert into brain.files(id,content_hash,size_bytes,first_seen_at) select md5(i::text)::uuid,'sha256:'||repeat(md5(i::text),2),1,${fixed} from generate_series(1,${n+1000}) i;
 insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) select md5(i::text)::uuid,'synthetic',i::text,'synthetic','synthetic','synthetic/'||i,repeat('a',64),1,'text/plain',${fixed},${work},${work} from generate_series(1,${n}) i;
 insert into brain.file_request_results(request_id,file_id,finished_at) select id,id,${fixed} from brain.file_requests;
 insert into brain.file_import_cleanup(request_id,cleaned_at) select id,${fixed} from brain.file_requests;
 ${condition==='idle'?'':`update brain.file_import_cleanup set cleaned_at=null where request_id in (select id from brain.file_requests order by id limit 100);`}
 ${condition==='shared100'?`update brain.file_requests set locator='shared' where id in (select request_id from brain.file_import_cleanup where cleaned_at is null); update brain.file_request_results set file_id=null,error_code='SYNTHETIC' where request_id=(select request_id from brain.file_import_cleanup where cleaned_at is null order by request_id limit 1);`:''}
 set session_replication_role=origin;`);
}
async function writeBatch(c,n) {
 const samples=[];
 for(let i=0;i<3;i++) { await c.query('begin'); const t=performance.now(); try { await c.query(`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) select md5('write'||i)::uuid,'synthetic','write/'||i::text,'synthetic','synthetic','write/'||i,repeat('a',64),1,'text/plain',${fixed},${work},${work} from generate_series(1,1000) i; insert into brain.file_request_results(request_id,file_id,finished_at) select md5('write'||i)::uuid,md5((${n}+i)::text)::uuid,${fixed} from generate_series(1,1000) i;`); samples.push(performance.now()-t); } finally { await c.query('rollback'); } }
 return {samplesMs:samples,medianMs:median(samples)};
}
export async function run(opts) {
 const checkout=resolve(opts.checkout); const api=await import(pathToFileURL(resolve(checkout,'packages/postgres/dist/index.js')).href);
 const revision=checkoutRevision(checkout);
 const { Client }=createRequire(resolve(checkout,'packages/postgres/package.json'))('pg');
 const artifacts={...artifactFingerprint(checkout),runner:runnerFingerprint()};
 const admin=new Client({connectionString:opts.databaseUrl,connectionTimeoutMillis:10000}); await admin.connect();
 let result, outerError;
 try { result={scenario:'import-cleanup',checkoutSha:revision.sha,checkoutRevision:revision,artifacts,candidate:opts.candidate,queryVariant:opts.queryVariant,startedAt:new Date().toISOString(),environment:{node:process.version,postgres:(await admin.query('select version() as v')).rows[0].v,cpus:os.cpus().length,loadAverageStart:os.loadavg()},runs:[]};
 for(const size of opts.sizes) for(const condition of ['idle','pending100','shared100']) {
  const name=`qp_${randomBytes(10).toString('hex')}`; let created=false, client,store; const url=new URL(opts.databaseUrl); url.pathname='/'+name;
  let failure;
  try {
   await admin.query(`create database "${name}"`); created=true;
   const prepared=await api.prepareDatabase({databaseUrl:url.toString(),databaseName:name,appPassword:'query-perf-only',maintenancePassword:'query-perf-only'}); if(!prepared.ok) throw Error(prepared.message);
   const migrated=await api.runMigrations({databaseUrl:url.toString(),clock:{now:()=>new Date('2026-01-01T00:00:00Z')}}); if(!migrated.ok) throw Error(JSON.stringify(migrated));
   client=new Client({connectionString:url.toString(),connectionTimeoutMillis:10000}); await client.connect(); await fixture(client,size,condition);
   const existing=(await client.query(`select t.relname as table_name, array(select pg_get_indexdef(i.indexrelid,k,true) from generate_series(1,i.indnkeyatts) k order by k) as columns, pg_get_expr(i.indpred,i.indrelid) as predicate from pg_index i join pg_class t on t.oid=i.indrelid where i.indrelid in ('brain.file_requests'::regclass,'brain.file_import_cleanup'::regclass)`)).rows;
   const conflict=candidateConflict(opts.candidate,existing);
   if(conflict) throw Error('candidate index already exists; use a checkout before migration 0039 for candidate comparison');
   if(['locator','both'].includes(opts.candidate)) await client.query('create index perf_requests_source_locator on brain.file_requests(source,locator)');
   if(['open','both'].includes(opts.candidate)) await client.query('create index perf_cleanup_open on brain.file_import_cleanup(request_id) where cleaned_at is null');
   await client.query('analyze'); store=api.postgresStore({databaseUrl:url.toString(),queryTimeoutMs:0});
   let captured, pendingSql, unhandedSql; const original=Client.prototype.query;
   Client.prototype.query=function(...args) { const q=typeof args[0]==='string'?args[0]:args[0]?.text; const call={text:q,values:Array.isArray(args[1])?args[1]:(args[0]?.values??[])}; if(q?.toLowerCase().includes('select c.request_id as id from brain.file_import_cleanup')) captured=call; if(q?.toLowerCase().includes('select 1 from brain.file_requests q left join brain.file_request_results r')) pendingSql=call; if(q?.toLowerCase().includes('select q.id from brain.file_requests q left join brain.file_request_handoffs')) unhandedSql=call; return original.apply(this,args); };
   let samples=[],ids,sql,cleanup,cleanupRewritten,originalDirect,cleanupOriginalDirect,unhanded;
   try {
    const measure=async()=>{ if(opts.queryVariant==='rewritten') return (await client.query(rewritten)).rows.map(r=>r.id); const r=await store.imports.listImportCleanups(); if(!r.ok) throw Error(JSON.stringify(r)); return r.ids; };
    if(opts.queryVariant==='rewritten') { const storeResult=await store.imports.listImportCleanups(); if(!storeResult.ok || !captured) throw Error('store SQL capture failed'); const direct=async()=> (await client.query(captured.text,captured.values)).rows.map(r=>r.id); const originalIds=await direct(); if(hash(originalIds)!==hash(storeResult.ids)) throw Error('original direct mismatch'); const values=[]; for(let i=0;i<3;i++){const t=performance.now(); const current=await direct(); values.push(performance.now()-t); if(hash(current)!==hash(originalIds)) throw Error('original direct unstable');} originalDirect={samplesMs:values,medianMs:median(values),hash:hash(originalIds)}; }
    const warm=await measure(); for(let i=0;i<3;i++) { const t=performance.now(); const next=await measure(); samples.push(performance.now()-t); if(hash(next)!==hash(warm)) throw Error('unstable result'); ids=next; }
    if(originalDirect && originalDirect.hash!==hash(ids)) throw Error('list rewrite mismatch');
    const unhandedOnce=async()=>{const r=await store.imports.listUnhandedImports(); if(!r.ok) throw Error(JSON.stringify(r)); return r.ids;}; const unhandedWarm=await unhandedOnce(); const unhandedSamples=[]; for(let i=0;i<3;i++){const t=performance.now(); const current=await unhandedOnce(); unhandedSamples.push(performance.now()-t); if(hash(current)!==hash(unhandedWarm)) throw Error('unhanded unstable');} if(!unhandedSql) throw Error('unhanded SQL capture failed'); unhanded={samplesMs:unhandedSamples,medianMs:median(unhandedSamples),rowCount:unhandedWarm.length,hash:hash(unhandedWarm)};
    sql=opts.queryVariant==='rewritten'?{text:rewritten,values:[]}:captured; if(!sql) throw Error('store SQL capture failed');
    if(condition==='shared100') {
     const sibling=(await client.query(`select q.id,q.source,q.locator from brain.file_requests q join brain.file_request_results r on r.request_id=q.id where q.locator='shared' and r.file_id is not null and exists (select 1 from brain.file_requests other join brain.file_request_results bad on bad.request_id=other.id where other.source=q.source and other.locator=q.locator and bad.file_id is null) order by q.id limit 1`)).rows[0]; if(!sibling) throw Error('shared pending sibling missing'); const id=sibling.id;
     let removed=false; const cleanupOnce=async()=>{ const r=await store.imports.cleanupImport({requestId:id,now:new Date('2026-01-01T00:00:00Z'),remove:async()=>{removed=true; throw Error('remove called');}}); if(removed || !r.ok || r.cleaned!==false) throw Error('shared cleanup safety failed'); };
     await cleanupOnce(); const cleanupSamples=[]; for(let i=0;i<3;i++) { const t=performance.now(); await cleanupOnce(); cleanupSamples.push(performance.now()-t); }
     if(!pendingSql) throw Error('cleanup SQL capture failed');
     cleanup={samplesMs:cleanupSamples,medianMs:median(cleanupSamples),cleaned:false,removeCalled:false};
    }
   } finally { Client.prototype.query=original; }
   const expected=condition==='pending100'?(await client.query('select md5(i::text)::uuid as id from generate_series(1,$1::int) i order by 1 limit 100',[size])).rows.map(r=>r.id):[]; if(JSON.stringify(ids)!==JSON.stringify(expected)) throw Error(`unexpected ordered result: ${condition}`);
   if(cleanup) { const p=(await client.query('explain (analyze, buffers, format json) '+pendingSql.text,pendingSql.values)).rows[0]['QUERY PLAN'][0]; cleanup.explain=summary(p); cleanup.explainFull=[p];
    if(opts.queryVariant==='rewritten') { const direct=async()=>await client.query(pendingSql.text,pendingSql.values); const originalRows=await direct(); const directSamples=[]; for(let i=0;i<3;i++){const t=performance.now(); const r=await direct(); directSamples.push(performance.now()-t); if((r.rowCount>0)!==(originalRows.rowCount>0)) throw Error('original pending unstable');} cleanupOriginalDirect={samplesMs:directSamples,medianMs:median(directSamples),rowExists:originalRows.rowCount>0}; const measure=async()=>{const rows=await client.query(pendingRewritten,pendingSql.values); if((rows.rowCount>0)!==(originalRows.rowCount>0)) throw Error('pending rewrite mismatch');}; await measure(); const values=[]; for(let i=0;i<3;i++) {const t=performance.now(); await measure(); values.push(performance.now()-t);} const p=(await client.query('explain (analyze, buffers, format json) '+pendingRewritten,pendingSql.values)).rows[0]['QUERY PLAN'][0]; cleanupRewritten={samplesMs:values,medianMs:median(values),rowExists:originalRows.rowCount>0,explain:summary(p),explainFull:[p]}; }
   }
   const plan=(await client.query('explain (analyze, buffers, format json) '+sql.text,sql.values)).rows[0]['QUERY PLAN'][0];
   const unhandedPlan=(await client.query('explain (analyze, buffers, format json) '+unhandedSql.text,unhandedSql.values)).rows[0]['QUERY PLAN'][0]; unhanded.explainFull=[unhandedPlan];
   const indexes=(await client.query("select indexrelid::regclass::text as name, pg_relation_size(indexrelid)::text as bytes, pg_get_indexdef(indexrelid) as definition from pg_index where indrelid in ('brain.file_requests'::regclass,'brain.file_import_cleanup'::regclass) order by 1")).rows;
   const write=await writeBatch(client,size);
   result.runs.push({size,condition,samplesMs:samples,medianMs:median(samples),rowCount:ids.length,hash:hash(ids),explain:summary(plan),explainFull:[plan],write,indexes,unhanded,...(originalDirect?{originalDirect}:{}),...(cleanupOriginalDirect?{cleanupOriginalDirect}:{}),...(cleanup?{cleanup}:{}),...(cleanupRewritten?{cleanupRewritten}:{})});
  } catch(error) { failure=error; }
  const errors=[];
  for(const [label,action] of [['store close',async()=>{if(store) await store.close();}],['client close',async()=>{if(client) await client.end();}],['database drop',async()=>{if(created) await admin.query(`drop database "${name}" with (force)`);}]]) {
   try { await action(); } catch(error) { errors.push(new Error(`${label}${label==='database drop'?` (database ${name} remains)`:''}: ${error.message}`,{cause:error})); }
  }
  if(failure || errors.length) { const all=[...(failure?[failure]:[]),...errors]; throw new AggregateError(all,all.map(e=>e.message).join('; ')); }
 } } catch(error) { outerError=error; }
 const endErrors=[]; try { await admin.end(); } catch(error) { endErrors.push(error); }
 if(outerError || endErrors.length) { const all=[...(outerError?[outerError]:[]),...endErrors]; throw new AggregateError(all,all.map(e=>e.message).join('; ')); }
 result.finishedAt=new Date().toISOString(); result.environment.loadAverageEnd=os.loadavg();
 return result;
}
