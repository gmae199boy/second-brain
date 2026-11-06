import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { median, hash, sanitize } from './core.mjs';
import { checkoutRevision, artifactFingerprint, runnerFingerprint } from './revision.mjs';

const session='019a0000-0000-7000-8000-000000000101', work='019a0000-0000-7000-8000-000000000102';
const configId='019a0000-0000-7000-8000-000000000003', owner='query-perf', rows=100000, body='x'.repeat(1024);
const md5=s=>createHash('md5').update(s).digest('hex');
const uuid=s=>{const h=md5(s); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;};
const stable=v=>Array.isArray(v)?v.map(stable):v!==null&&typeof v==='object'?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([k,x])=>[k,stable(x)])):v;
const measure=a=>({samplesMs:a,medianMs:median(a)});
function expectedMessages(size) {
 const result=[];
 for(let group=0;group<size/20;group++) {
  const at=new Date(Date.UTC(2026,0,1,0,0,group));
  const ids=Array.from({length:20},(_,j)=>uuid(`msg${group*20+j+1}`)).sort();
  for(const id of ids) result.push({id,occurredAt:at,body});
 }
 return result;
}
// Each 20-message timestamp group exceeds target; overlap retains the whole preceding group.
function expectedChunks(messages) {
 const chunks=[];
 for(let i=0;i<messages.length;i+=20) {
  const selected=messages.slice(Math.max(0,i-20),i+20);
  chunks.push({id:uuid(`chunk${i/20}`),fromAt:selected[0].occurredAt,toAt:selected.at(-1).occurredAt,part:0,body:selected.map(m=>m.body).join('\n')});
 }
 return chunks;
}
async function fixture(client, size) {
 await client.query(`set session_replication_role=replica;
 insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','snapshot','019a0000-0000-7000-8000-000000000100','synthetic','2026-01-01','import');
 insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,claimed_at,claim_expires_at,claimed_by) values ('${work}','conversation_chunk','core','session','${session}','2026-01-01','2026-01-01','2026-01-01','2099-01-01','${owner}');
 insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) select md5('msg'||i)::uuid,'${session}',i::text,'user',repeat('x',1024),'2026-01-01T00:00:00Z'::timestamptz + ((i-1)/20)*interval '1 second' from generate_series(1,${size}) i;
 set session_replication_role=origin; analyze brain.messages;`);
}
export function traced(Client, action, probe, observer, probePid, now = () => performance.now()) {
 const original=Client.prototype.query; const spans=[]; let txStart,lockStart,lockHeld,transaction, snapshotSql, wait, waitConfirmed=false;
 Client.prototype.query=function(...args) {
  const q=typeof args[0]==='string'?args[0]:args[0]?.text;
  const values=Array.isArray(args[1])?args[1]:(args[0]?.values??[]); const lower=(q??'').trim().toLowerCase(); const start=now();
  const promise=original.apply(this,args);
  if(!promise||typeof promise.then!=='function') throw Error('query tracing requires promise API');
  return promise.then(async value=>{const end=now();
   if(lower==='begin') txStart=end;
   if(lower.includes('pg_advisory_xact_lock')) { lockStart=end; if(probe) {
    const started=now(); let acquired=false;
    wait=original.call(probe,'select pg_advisory_xact_lock(hashtextextended($1, 0))',['synthetic:snapshot']).then(()=>{acquired=true; return now()-started;}); void wait.catch(()=>{});
    for(let attempt=0;attempt<500;attempt++) {
     const state=await original.call(observer,"select exists(select 1 from pg_locks where pid=$1 and locktype='advisory' and not granted) as waiting",[probePid]);
     if(state.rows[0].waiting) { waitConfirmed=true; break; }
     if(acquired) break;
     await new Promise(resolve=>setTimeout(resolve,10));
    }
    if(!waitConfirmed) throw Error('advisory probe wait was not observed');
   } }
   if(lower.startsWith('select id, occurred_at, body, body_raw from brain.messages')) snapshotSql={text:q,values};
   if(lower==='commit') { if(txStart!==undefined) transaction=end-txStart; if(lockStart!==undefined) lockHeld=end-lockStart; }
   spans.push({kind:lower.startsWith('select id, occurred_at, body, body_raw')?'messages':lower.includes('pg_advisory_xact_lock')?'advisory':lower.includes('from brain.chunks')?'chunks':lower==='begin'||lower==='commit'?lower:'other',ms:end-start}); return value;
  });
 };
 return Promise.resolve().then(action).then(async result=>({result,transaction,lockHeld,spans,snapshotSql,waitMs:wait?await wait:undefined,waitConfirmed,probePid})).finally(()=>{Client.prototype.query=original;});
}
export async function samples(action) {
 const values=[]; for(let i=0;i<4;i++) { const value=await action(i); if(i>0) values.push(value); } return values;
}
function requireOk(result) {
 if(!result.ok) { const error=new Error(result.message ?? 'store operation failed'); error.code=result.code; throw error; }
 return result;
}
export async function run(opts, internal = {}) {
 const size=internal.rows ?? rows; if(!Number.isSafeInteger(size)||size<20||size%20!==0) throw Error('invalid fixture size');
 const checkout=resolve(opts.checkout), api=await import(pathToFileURL(resolve(checkout,'packages/postgres/dist/index.js')).href), core=await import(pathToFileURL(resolve(checkout,'packages/core/dist/index.js')).href);
 const {Client}=createRequire(resolve(checkout,'packages/postgres/package.json'))('pg');
 const admin=new Client({connectionString:opts.databaseUrl,connectionTimeoutMillis:10000,query_timeout:120000});
 const name=`qp_${randomBytes(10).toString('hex')}`, url=new URL(opts.databaseUrl); url.pathname='/'+name;
 let created=false, deleted=false, client, probe, store, output, failure; const socketErrors=[];
 const watch=(connection,label)=>{ connection.on('error', error=>socketErrors.push(new Error(`${label} connection error: ${error.message}`,{cause:error}))); return connection; };
 watch(admin,'admin');
 try {
  await admin.connect();
  const revision=checkoutRevision(checkout), artifacts={...artifactFingerprint(checkout),runner:runnerFingerprint()};
  const environment={node:process.version,postgres:(await admin.query('select version() as v')).rows[0].v,cpus:os.cpus().length,loadAverageStart:os.loadavg(),platform:process.platform,arch:process.arch};
  await admin.query(`create database "${name}"`); created=true;
  const prepared=await api.prepareDatabase({databaseUrl:url.toString(),databaseName:name,appPassword:'query-perf-only',maintenancePassword:'query-perf-only'}); if(!prepared.ok) throw Error(prepared.message);
  const migrated=await api.runMigrations({databaseUrl:url.toString(),clock:{now:()=>new Date('2026-01-01T00:00:00Z')}}); if(!migrated.ok) throw Error(JSON.stringify(migrated));
  client=watch(new Client({connectionString:url.toString(),connectionTimeoutMillis:10000,query_timeout:120000}),'fixture'); await client.connect(); await fixture(client,size);
  probe=watch(new Client({connectionString:url.toString(),connectionTimeoutMillis:10000,query_timeout:120000}),'probe'); await probe.connect(); const probePid=(await probe.query('select pg_backend_pid() as pid')).rows[0].pid;
  store=api.postgresStore({databaseUrl:url.toString(),queryTimeoutMs:0,lockTimeoutMs:0});
  const messages=expectedMessages(size), expected=expectedChunks(messages);
  const config=(await client.query('select chunk_params from brain.index_configs where id=$1',[configId])).rows[0].chunk_params;
  const jsonStart=performance.now(), json=JSON.stringify([stable(config),messages.map(m=>[m.id,m.occurredAt.toISOString(),m.body])]), serializationMs=performance.now()-jsonStart;
  const hashStart=performance.now(), fingerprint='sha256:'+createHash('sha256').update(json).digest('hex'), nativeHashMs=performance.now()-hashStart;
  const coreStart=performance.now(), coreFingerprint=core.conversationFingerprint(config,messages), coreFingerprintMs=performance.now()-coreStart;
  if(coreFingerprint!==fingerprint) throw Error('core fingerprint oracle mismatch');
  const wantedHash=hash(expected), messagesHash=hash(messages), configHash=hash(stable(config));
  // Product chunker output is checked against independently constructed fixture chunks before any timing.
  const productChunks=core.chunkConversation(messages,config).map((chunk,i)=>({id:uuid(`chunk${i}`),fromAt:chunk.fromAt,toAt:chunk.toAt,part:chunk.part,body:chunk.body}));
  if(hash(productChunks)!==wantedHash) throw Error('independent chunk oracle mismatch');
  if(internal.beforeOracleRead) await internal.beforeOracleRead({client});
  const read=await store.readConversationSnapshot(session); requireOk(read); if(!read.snapshot||read.snapshot.fingerprint!==fingerprint||hash(read.snapshot.messages)!==messagesHash||hash(stable(read.snapshot.config))!==configHash) throw Error('independent snapshot oracle mismatch');
  const input={sessionId:session,workId:work,claimedBy:owner,now:new Date('2026-01-01'),fingerprint,chunks:productChunks};
  const seed=await store.commitConversationChunks(input); requireOk(seed); if(!seed.committed) throw Error('initial chunk commit failed');
  const readTimes=[],commitTimes=[],lockTimes=[],waitTimes=[],readWall=[],commitWall=[],readQueries=[],commitQueries=[]; let captured;
  if(internal.afterFixture) await internal.afterFixture({name,client,probe});
  const startedAt=new Date().toISOString(), cpu=process.cpuUsage();
  await samples(async()=> {
   let t=performance.now(); let readTransaction, readSpans, rw;
   {
    const r=await traced(Client,()=>store.readConversationSnapshot(session)); rw=performance.now()-t;
    requireOk(r.result); if(!r.result.snapshot||r.result.snapshot.fingerprint!==fingerprint||hash(r.result.snapshot.messages)!==messagesHash||!r.transaction||!r.snapshotSql) throw Error('read measurement mismatch');
    readTransaction=r.transaction; readSpans=r.spans;
   }
   t=performance.now(); const c=await traced(Client,()=>store.commitConversationChunks(input)); const cw=performance.now()-t;
   requireOk(c.result); if(!c.result.committed||!c.transaction||!c.lockHeld||!c.snapshotSql) throw Error('commit measurement mismatch');
   captured=c.snapshotSql; return {readTransaction,readSpans,rw,commitTransaction:c.transaction,lockHeld:c.lockHeld,commitSpans:c.spans,cw};
  }).then(values=>{for(const v of values) {readTimes.push(v.readTransaction);commitTimes.push(v.commitTransaction);lockTimes.push(v.lockHeld);readWall.push(v.rw);commitWall.push(v.cw);readQueries.push(v.readSpans);commitQueries.push(v.commitSpans);}});
  const diagnosticStartedAt=new Date().toISOString();
  const diagnostics=await samples(async()=>{
   const t=performance.now(); const c=await traced(Client,()=>store.commitConversationChunks(input),probe,client,probePid);
   requireOk(c.result); if(!c.result.committed||!c.waitMs||!c.waitConfirmed) throw Error('advisory diagnostic mismatch');
   return {waitMs:c.waitMs,elapsedMs:performance.now()-t};
  });
  for(const d of diagnostics) waitTimes.push(d.waitMs);
  const diagnosticFinishedAt=new Date().toISOString();
  const cpuUsage=process.cpuUsage(cpu);
  const resultChunks=(await client.query('select id,from_at as "fromAt",to_at as "toAt",part,body from brain.chunks where session_id=$1 order by from_at,to_at,part',[session])).rows;
  if(hash(resultChunks)!==wantedHash) throw Error('stored chunks oracle mismatch');
  const plan=(await client.query('explain (analyze, buffers, format json) '+captured.text,captured.values)).rows[0]['QUERY PLAN'];
  const initialTimes=[],changedTimes=[];
  const changedExpected=expected.map((chunk,i)=>i===0?{...chunk,id:uuid('changed0'),body:chunk.body+' changed'}:chunk);
  const changedHash=hash(changedExpected);
  await samples(async()=> {
   await client.query('delete from brain.chunks where session_id=$1',[session]);
   const initial=await traced(Client,()=>store.commitConversationChunks(input));
   requireOk(initial.result); if(!initial.result.committed||!initial.transaction) throw Error('initial write failed');
   const initialRows=(await client.query('select id,from_at as "fromAt",to_at as "toAt",part,body from brain.chunks where session_id=$1 order by from_at,to_at,part',[session])).rows;
   if(hash(initialRows)!==wantedHash) throw Error('initial write oracle mismatch');
   const changed=await traced(Client,()=>store.commitConversationChunks({...input,chunks:changedExpected}));
   requireOk(changed.result); if(!changed.result.committed||!changed.transaction) throw Error('changed write failed');
   const changedRows=(await client.query('select id,from_at as "fromAt",to_at as "toAt",part,body from brain.chunks where session_id=$1 order by from_at,to_at,part',[session])).rows;
   if(hash(changedRows)!==changedHash) throw Error('changed write oracle mismatch');
   return {initial:initial.transaction,changed:changed.transaction};
  }).then(values=>{for(const value of values) {initialTimes.push(value.initial);changedTimes.push(value.changed);}});
  const restored=await store.commitConversationChunks(input); requireOk(restored); if(!restored.committed) throw Error('restore failed');
  const added={id:uuid('stale-message'),occurredAt:new Date('2030-01-01T00:00:00Z'),body:'stale synthetic message'};
  await client.query('insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ($1,$2,$3,$4,$5,$6)',[added.id,session,'stale-message','user',added.body,added.occurredAt]);
  const staleMessages=[...messages,added];
  const staleFingerprint='sha256:'+createHash('sha256').update(JSON.stringify([stable(config),staleMessages.map(m=>[m.id,m.occurredAt.toISOString(),m.body])])).digest('hex');
  const reread=await store.readConversationSnapshot(session); requireOk(reread);
  if(staleFingerprint===fingerprint||!reread.snapshot||reread.snapshot.fingerprint!==staleFingerprint||hash(reread.snapshot.messages)!==hash(staleMessages)) throw Error('stale snapshot oracle mismatch');
  const stale=await store.commitConversationChunks(input); requireOk(stale); if(stale.committed) throw Error('stale commit accepted');
  const after=(await client.query('select id,from_at as "fromAt",to_at as "toAt",part,body from brain.chunks where session_id=$1 order by from_at,to_at,part',[session])).rows;
  if(hash(after)!==wantedHash) throw Error('stale commit changed chunks');
  output={scenario:'session-snapshot',checkoutRevision:revision,artifacts,fixture:{rows:size,bodyBytes:1024,groupSize:20,chunkCount:expected.length},environment:{...environment,loadAverageEnd:os.loadavg()},startedAt,finishedAt:new Date().toISOString(),results:{rowCount:messages.length,fingerprint,staleFingerprint,chunksHash:wantedHash,changedChunksHash:changedHash,configHash,messagesHash,staleCommitted:false,oracleMatch:true},measurements:{readTransaction:measure(readTimes),commitTransaction:measure(commitTimes),lockHeld:measure(lockTimes),initialWrite:measure(initialTimes),changedWrite:measure(changedTimes),advisoryWait:measure(waitTimes),readWall:measure(readWall),commitWall:measure(commitWall),readQueries,commitQueries,probe:{pid:probePid,confirmedWaits:waitTimes.length,sampleCount:diagnostics.length,startedAt:diagnosticStartedAt,finishedAt:diagnosticFinishedAt,elapsedMs:diagnostics.map(d=>d.elapsedMs)},diagnostic:{serializationMs,nativeHashMs,coreFingerprintMs,description:'separate full JSON, native hash and core fingerprint calls; not transaction phase timings'},cpuUsage,maxRssKiB:process.resourceUsage().maxRSS},explain:plan};
 } catch(error) { failure=error; }
 const errors=[]; for(const [label,fn] of [['store',async()=>{if(store) await store.close();}],['probe',async()=>{if(probe) await probe.end();}],['client',async()=>{if(client) await client.end();}],['database',async()=>{if(created) {if(internal.beforeDrop) await internal.beforeDrop({name}); await admin.query(`drop database "${name}" with (force)`); deleted=true;}}],['admin',async()=>admin.end()]]) {try{await fn();}catch(e){errors.push(new Error(`${label}: ${e.message}`,{cause:e}));}}
 const all=[...(failure?[failure]:[]),...socketErrors,...errors];
 const resources={database:name,created,deleted};
 if(all.length) { const sanitized=all.map(e=>{const safeError=new Error(sanitize(e.message)); if(e.code) safeError.code=e.code; return safeError;}); const error=new AggregateError(sanitized, `snapshot runner failed; database=${name} created=${created} deleted=${deleted}: `+sanitized.map(e=>e.code?`${e.code}: ${e.message}`:e.message).join('; ')); error.resources=resources; throw error; }
 output.resources=resources;
 return output;
}
