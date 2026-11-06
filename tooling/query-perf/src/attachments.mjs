import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { median, hash, sanitize } from './core.mjs';
import { checkoutRevision, artifactFingerprint, runnerFingerprint } from './revision.mjs';

const at='2026-01-01T00:00:00.000Z';
const processes=()=>sanitize(execFileSync('ps',['-A','-o','pid=,comm='],{encoding:'utf8'}));
import { fixtureSpec, makeAttachments, uuid, message, session } from './attachment-fixture.mjs';
export { fixtureSpec, makeAttachments } from './attachment-fixture.mjs';
// The hook observes precisely the SQL issued by writeAttachments, excluding
// BEGIN, advisory lock, COMMIT, fixture setup, replay and EXPLAIN.
export async function traceQueries(Client, action, now=()=>performance.now()) {
 const original=Client.prototype.query, queries=[];
 Client.prototype.query=function(...args) { const q=typeof args[0]==='string'?args[0]:args[0]?.text; queries.push({text:q,values:args[1]??args[0]?.values??[]}); return original.apply(this,args); };
 const start=now();
 try { const result=await action(); return {result,elapsedMs:now()-start,queries}; }
 finally { Client.prototype.query=original; }
}
// Replica mode is restricted to the synthetic fixture connection, and must be
// restored even when initialization or truncation fails.
export async function withFixtureReplica(client, action) {
 await client.query('set session_replication_role=replica');
 try { return await action(); }
 finally { await client.query('set session_replication_role=origin'); }
}
async function snapshot(client) {
 const result={};
 for(const table of ['files','file_locations','message_attachments']) result[table]=(await client.query(`select * from brain.${table} order by id`)).rows;
 return result;
}
export async function run(opts, internal={}) {
 const checkout=resolve(opts.checkout), require=createRequire(resolve(checkout,'packages/postgres/package.json'));
 const {Client,Pool}=require('pg'), {Kysely,PostgresDialect,sql}=require('kysely');
 const file=resolve(checkout,'packages/postgres/dist/attachments.js');
 const {writeAttachments}=await import(pathToFileURL(file).href);
 if(typeof writeAttachments!=='function') throw Error('built writeAttachments missing');
 const api=await import(pathToFileURL(resolve(checkout,'packages/postgres/dist/index.js')).href);
 const admin=new Client({connectionString:opts.databaseUrl,connectionTimeoutMillis:10000,query_timeout:120000});
 const name=`qp_${randomBytes(10).toString('hex')}`, url=new URL(opts.databaseUrl); url.pathname='/'+name;
 let created=false,deleted=false,client,db,output,failure; const socketErrors=[];
 const watch=(connection,label)=>{connection.on('error',e=>socketErrors.push(new Error(`${label}: ${e.message}`,{cause:e})));return connection;}; watch(admin,'admin');
 try {
  await admin.connect();
  const fixture={...fixtureSpec,sizes:internal.sizes??fixtureSpec.sizes};
  if(!fixture.sizes.length || fixture.sizes.some(n=>!fixtureSpec.sizes.includes(n))) throw Error('invalid fixture sizes');
  const revision=checkoutRevision(checkout), artifacts={...artifactFingerprint(checkout),runner:runnerFingerprint(),functionSha256:createHash('sha256').update(readFileSync(file)).digest('hex')};
  const environment={node:process.version,postgres:(await admin.query('select version() as v')).rows[0].v,platform:process.platform,arch:process.arch,cpus:os.cpus().length,loadAverageStart:os.loadavg(),processesStart:processes(),pid:process.pid};
  await admin.query(`create database "${name}"`); created=true;
  const prepared=await api.prepareDatabase({databaseUrl:url.toString(),databaseName:name,appPassword:'query-perf-only',maintenancePassword:'query-perf-only'}); if(!prepared.ok) throw Error(prepared.message);
  const migrated=await api.runMigrations({databaseUrl:url.toString(),clock:{now:()=>new Date(at)}}); if(!migrated.ok) throw Error(JSON.stringify(migrated));
  client=watch(new Client({connectionString:url.toString(),connectionTimeoutMillis:10000,query_timeout:120000}),'fixture'); await client.connect();
  await withFixtureReplica(client,()=>client.query(`insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${session}','synthetic','attachment','${uuid('user')}','synthetic','${at}','import');
   insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${message}','${session}','fixture-message','user','synthetic','${at}');
   `));
  const timeoutMs=internal.timeoutMs??120000;
  if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1) throw Error('invalid statement timeout');
  const appUrl=new URL(url); appUrl.username='brain_app'; appUrl.password='query-perf-only'; appUrl.searchParams.delete('user'); appUrl.searchParams.delete('password');
  const pool=watch(new Pool({connectionString:internal.poolConnectionString??appUrl.toString(),connectionTimeoutMillis:10000,statement_timeout:timeoutMs,query_timeout:timeoutMs+1000}),'pool'); db=new Kysely({dialect:new PostgresDialect({pool})});
  const mode=await sql`select current_user as "role", current_setting('session_replication_role') as replication`.execute(db);
  if(mode.rows[0]?.role!=='brain_app'||mode.rows[0]?.replication!=='origin') throw Error('measurement connection is not brain_app/origin');
  environment.measurementRole=mode.rows[0].role; environment.replicationRole=mode.rows[0].replication;
  const messages=new Map([['fixture-message',message]]), runs=[];
  const startedAt=new Date().toISOString(), cpu=process.cpuUsage();
  if(internal.afterFixture) await internal.afterFixture({client,name});
  for(const size of fixture.sizes) for(const condition of fixture.conditions) {
   const attachments=makeAttachments(size,condition), inputHash=hash(attachments), samplesMs=[],sqlCounts=[]; let expected,explain,linked,diagnosticQuery;
   for(let iteration=0;iteration<4;iteration++) {
    await withFixtureReplica(client,()=>client.query('truncate brain.message_attachments, brain.file_locations, brain.files cascade'));
    const execute=()=>db.transaction().execute(async trx=>{await sql`select pg_advisory_xact_lock(hashtextextended(${'synthetic:attachment'}, 0))`.execute(trx); return writeAttachments(trx,attachments,messages,at);});
    if(condition==='existing' && await execute()!==size) throw Error('fixture seed failed');
    let measurement;
    await db.transaction().execute(async trx=>{
     await sql`select pg_advisory_xact_lock(hashtextextended(${'synthetic:attachment'}, 0))`.execute(trx);
     measurement=await traceQueries(Client,()=>writeAttachments(trx,attachments,messages,at));
    });
    linked=measurement.result;
    if(linked!==(condition==='existing'?0:size)||measurement.queries.length<1||measurement.elapsedMs<=0) throw Error('measurement invariant failed');
    const before=await snapshot(client), replay=await execute(), after=await snapshot(client);
    if(replay!==0||hash(before)!==hash(after)) throw Error('replay changed rows');
    if(before.message_attachments.length!==size || before.files.length!==(condition==='missing'?0:size) || before.file_locations.length!==(condition==='missing'?0:2*size)) throw Error('row count mismatch');
    if(expected && hash(expected)!==hash(before)) throw Error('sample rows differ'); expected=before;
    if(iteration===0) { diagnosticQuery=measurement.queries.find(q=>/^\s*select\b/i.test(q.text)); if(!diagnosticQuery) throw Error('no SELECT to explain'); }
    else {samplesMs.push(measurement.elapsedMs);sqlCounts.push(measurement.queries.length);}
   }
   // Rebuild the same pre-call state for a separate, untimed diagnostic.
   await withFixtureReplica(client,()=>client.query('truncate brain.message_attachments, brain.file_locations, brain.files cascade'));
   const diagnosticExecute=()=>db.transaction().execute(async trx=>{await sql`select pg_advisory_xact_lock(hashtextextended(${'synthetic:attachment'}, 0))`.execute(trx); return writeAttachments(trx,attachments,messages,at);});
   if(condition==='existing' && await diagnosticExecute()!==size) throw Error('diagnostic seed failed');
   const beforeDiagnostic=await snapshot(client);
   const explainState={stage:'before-write',rowCounts:Object.fromEntries(Object.entries(beforeDiagnostic).map(([key,rows])=>[key,rows.length]))};
   explain=(await pool.query('explain (analyze, buffers, format json) '+diagnosticQuery.text,diagnosticQuery.values)).rows[0]['QUERY PLAN'];
   runs.push({size,condition,inputHash,linked,rows:expected,rowsHash:hash(expected),replayUnchanged:true,samplesMs,medianMs:median(samplesMs),sqlCounts,explain,explainState});
  }
  output={scenario:'write-attachments',fixture,fixtureHash:hash(fixture),checkoutRevision:revision,artifacts,environment:{...environment,loadAverageEnd:os.loadavg(),processesEnd:processes()},startedAt,finishedAt:new Date().toISOString(),cpuUsage:process.cpuUsage(cpu),maxRssKiB:process.resourceUsage().maxRSS,runs};
 } catch(e) {failure=e;}
 const errors=[];
 for(const [label,fn] of [['db',async()=>{if(db) await db.destroy();}],['client',async()=>{if(client) await client.end();}],['database',async()=>{if(created){if(internal.beforeDrop) await internal.beforeDrop({name}); await admin.query(`drop database "${name}" with (force)`); deleted=true;}}],['admin',async()=>admin.end()]]) try {await fn();} catch(e) {errors.push(new Error(`${label}: ${e.message}`,{cause:e}));}
 const resources={database:name,created,deleted}, all=[...(failure?[failure]:[]),...socketErrors,...errors];
 if(all.length) {const safe=all.map(e=>{const x=new Error(sanitize(e.message)); if(e.code)x.code=e.code; return x;}); const error=new AggregateError(safe,`attachment runner failed; database=${name} created=${created} deleted=${deleted}: ${safe.map(e=>e.message).join('; ')}`); error.resources=resources; throw error;}
 output.resources=resources; return output;
}
