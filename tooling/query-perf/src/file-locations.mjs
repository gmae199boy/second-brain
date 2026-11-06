import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { median, hash, sanitize } from './core.mjs';
import { checkoutRevision, artifactFingerprint, runnerFingerprint } from './revision.mjs';
import { fixture, stamp, id, fileId, expected, expectedLocation, listExpected, matrixInputs, matrixOracle } from './file-location-fixture.mjs';

const processes=()=>sanitize(execFileSync('ps',['-A','-o','pid=,comm='],{encoding:'utf8'}));
const normalize=x=>JSON.parse(JSON.stringify(x));
async function snapshot(client) {
 const files=(await client.query('select to_jsonb(f) as row from brain.files f order by id')).rows.map(r=>r.row);
 const locations=(await client.query("select to_jsonb(l) - 'deleted_at' as row from brain.file_locations l order by id")).rows.map(r=>r.row);
 return {files:{count:files.length,hash:hash(files)},locations:{count:locations.length,hash:hash(locations)}};
}
const countContract = (kind,queries) => {
 const patterns=kind==='mark'?[/^begin$/i,/^\s*update\s+brain\.file_locations\b/i,/^\s*select\s+deleted_at\b/i,/^commit$/i]:[/^\s*select\s+id,\s*file_id\b/i];
 return queries.length===patterns.length && queries.every((q,i)=>patterns[i].test(q.text));
};
export async function run(opts, internal={}) {
 const raw={scenario:'file-locations',failed:true,startedAt:new Date().toISOString(),fixture:{...fixture,rows:internal.rows??fixture.rows},runs:[],events:[],resources:{database:null,createAttempted:false,created:false,deleted:false}};
 const name=`qp_${randomBytes(10).toString('hex')}`; raw.resources.database=name;
 let admin,client,probe,store,failure; const socketErrors=[];
 const watch=(c,label)=>{c.on('error',e=>socketErrors.push(new Error(`${label}: ${e.message}`)));return c;};
 try {
  if(!Number.isSafeInteger(raw.fixture.rows)||raw.fixture.rows<20||raw.fixture.rows>fixture.rows) throw Error('invalid fixture rows');
  const checkout=resolve(opts.checkout), require=createRequire(resolve(checkout,'packages/postgres/package.json'));
  const {Client}=require('pg');
  const api=await import(pathToFileURL(resolve(checkout,'packages/postgres/dist/index.js')).href);
  const url=new URL(opts.databaseUrl); url.pathname='/'+name;
  admin=watch(new Client({connectionString:opts.databaseUrl,connectionTimeoutMillis:10000,query_timeout:121000,statement_timeout:120000}),'admin');
  await admin.connect();
  const source=resolve(checkout,'packages/postgres/dist/attachments.js');
  raw.artifacts={...artifactFingerprint(checkout),runner:runnerFingerprint(),functionSha256:createHash('sha256').update(readFileSync(source)).digest('hex')};
  raw.checkoutRevision=checkoutRevision(checkout);
  const environment=raw.environment={node:process.version,platform:process.platform,arch:process.arch,cpus:os.cpus().length,pid:process.pid,loadAverageStart:os.loadavg(),processesStart:processes()};
  environment.postgres=(await admin.query('select version() as v')).rows[0].v;
  raw.resources.createAttempted=true; await admin.query(`create database "${name}"`); raw.resources.created=true;
  const prepared=await api.prepareDatabase({databaseUrl:url.toString(),databaseName:name,appPassword:'query-perf-only',maintenancePassword:'query-perf-only'}); if(!prepared.ok) throw Error(prepared.message);
  const migrated=await api.runMigrations({databaseUrl:url.toString(),clock:{now:()=>new Date(stamp)}}); if(!migrated.ok) throw Error(JSON.stringify(migrated));
  client=watch(new Client({connectionString:url.toString(),connectionTimeoutMillis:10000,query_timeout:120000}),'fixture'); await client.connect();
  // Both tables are generated deterministically; no operational data is used.
  await client.query(`insert into brain.files(id,content_hash,size_bytes,first_seen_at)
    select ('abcdef01-0000-0000-0000-' || lpad(to_hex(n),12,'0'))::uuid, 'sha256:' || lpad(to_hex(n),64,'0'), 1, $1 from generate_series(1,$2::integer) n`,[stamp,raw.fixture.rows]);
  await client.query(`insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at)
    select ('abcdef00-0000-0000-0000-' || lpad(to_hex(n),12,'0'))::uuid, ('abcdef01-0000-0000-0000-' || lpad(to_hex(case when n<=12 then $2::integer - ((n-1)/2) else n end),12,'0'))::uuid, 'local', case when n<=12 then (case when n%2=0 then 'z/' else 'a/' end) || n else 'synthetic/' || n end, case when n<=12 and n%2=0 then 'external' else 'brain' end, $1 from generate_series(1,$2::integer) n`,[stamp,raw.fixture.rows]);
  await client.query('analyze brain.file_locations');
  const dir=resolve(checkout,'packages/postgres/migrations');
  const manifest=readdirSync(dir).filter(n=>/^\d{4}_.+\.sql$/.test(n)).sort().map(name=>({owner:'core',version:Number(name.slice(0,4)),name,checksum:createHash('sha256').update(readFileSync(resolve(dir,name))).digest('hex')}));
  const applied=(await client.query("select owner,version,name,checksum from brain.schema_migrations where owner='core' order by version")).rows;
  raw.migrations={manifest,manifestHash:hash(manifest),applied,appliedHash:hash(applied)};
  if(hash(manifest)!==hash(applied)) throw Error('migration manifest mismatch');
  raw.before=await snapshot(client);
  const appUrl=new URL(url); appUrl.username='brain_app'; appUrl.password='query-perf-only'; appUrl.searchParams.delete('user'); appUrl.searchParams.delete('password');
  // Match createPool's store timeout, timezone and role settings. Connect is
  // inside the guarded scope, including failure before connection succeeds.
  const settings={connectionTimeoutMillis:10000,query_timeout:121000,options:'-c lock_timeout=10000 -c statement_timeout=120000 -c timezone=UTC'};
  environment.diagnosticTimeouts={connectMs:10000,queryMs:121000,statementMs:120000,lockMs:10000};
  probe=watch(new Client({connectionString:internal.probeUrl??appUrl.toString(),...settings}),'diagnostic');
  await probe.connect();
  const mode=(await probe.query("select current_user as role, current_setting('session_replication_role') as replication, current_setting('timezone') as timezone, current_setting('lock_timeout') as lock_timeout, current_setting('statement_timeout') as statement_timeout")).rows[0];
  environment.diagnostic=mode;
  if(mode.role!=='brain_app'||mode.replication!=='origin'||mode.timezone!=='UTC'||mode.lock_timeout!=='10s'||mode.statement_timeout!=='2min') throw Error('invalid diagnostic session');
  environment.measurementRole=mode.role; environment.replicationRole=mode.replication;
  store=api.postgresStore({databaseUrl:appUrl.toString(),connectTimeoutMs:10000,queryTimeoutMs:120000});
  raw.fixtureHash=hash(raw.fixture); const runs=raw.runs;
  if(internal.afterFixture) await internal.afterFixture({client,probe,name,raw});
  for(const kind of ['read','list','mark']) {
   const samplesMs=[],sqlCounts=[],observations=[], diagnostics=[]; let statements;
   const run={kind,samplesMs,sqlCounts,observations,diagnostics}; runs.push(run);
   for(let i=0;i<4;i++) {
    const n=raw.fixture.rows-i;
    const before=normalize((await client.query('select id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt" from brain.file_locations where id=$1',[id(n)])).rows[0]);
    if(hash(before)!==hash(expectedLocation(n))) throw Error(`unexpected initial row ${kind}/${i}`);
    const queries=[], original=Client.prototype.query;
    Client.prototype.query=function(...args){const text=typeof args[0]==='string'?args[0]:args[0]?.text; queries.push({text,values:args[1]??args[0]?.values??[]}); return original.apply(this,args);};
    const event={kind,iteration:i,n,before,queries}; raw.events.push(event);
    let result,elapsedMs;
    try {const start=performance.now(); result=await (kind==='read'?store.readFileLocation(id(n)):kind==='list'?store.listFileLocations(fileId(n)):store.markFileLocationDeleted({id:id(n),deletedAt:new Date(stamp)})); elapsedMs=performance.now()-start;} finally {Client.prototype.query=original;}
    Object.assign(event,{result:normalize(result),elapsedMs});
    const after=normalize((await client.query('select id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt" from brain.file_locations where id=$1',[id(n)])).rows[0]);
    event.after=after;
    const actual=normalize(result), oracle=kind==='list'?{ok:true,locations:listExpected(n,raw.fixture.rows)}:expected(kind,n), expectedAfter=expectedLocation(n,kind==='mark'?stamp:null);
    if(hash(actual)!==hash(oracle)||hash(after)!==hash(expectedAfter)) throw Error(`oracle mismatch ${kind}/${i}: ${JSON.stringify({actual,oracle,before,after,expectedAfter})}`);
    if(!countContract(kind,queries)) throw Error(`unexpected SQL contract ${kind}/${i}`);
    const selected=queries.filter(q=>kind==='mark'?(/^\s*update\s+brain\.file_locations/i.test(q.text)||/^\s*select\s+deleted_at/i.test(q.text)):/^\s*select\s+id,\s*file_id/i.test(q.text));
    if(selected.length!==(kind==='mark'?2:1)) throw Error(`missing traced SQL ${kind}`);
    if(i===0) statements=selected.map(statement=>({...statement,values:statement.values.map(v=>v===id(n)?id(raw.fixture.rows-4):v===fileId(n)?fileId(raw.fixture.rows-4):v)}));
    else {samplesMs.push(elapsedMs);sqlCounts.push(queries.length); observations.push({n,result:actual,before,after});}
    if(internal.afterSample) await internal.afterSample({kind,iteration:i,raw});
   }
   run.medianMs=median(samplesMs);
   // Each plan is captured on the production-equivalent connection in its own
   // transaction so an UPDATE cannot affect the subsequent diagnostic SELECT.
   for(const statement of statements) {
    const diagnostic={sql:statement.text,values:statement.values}; diagnostics.push(diagnostic);
    await probe.query('begin');
    try {diagnostic.explain=(await probe.query('explain (analyze, buffers, format json) '+statement.text,statement.values)).rows[0]['QUERY PLAN'];}
    finally {await probe.query('rollback');}
   }
  }
  if(internal.afterDiagnostics) await internal.afterDiagnostics({client,probe,raw});
  const matrix=[], target=raw.fixture.rows-6; raw.matrix=matrix;
  for(const input of matrixInputs(target)) {
   const before=normalize((await client.query('select id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt" from brain.file_locations where id=$1',[id(target)])).rows[0]);
   const read=normalize(await store.readFileLocation(input.loc));
   const list=normalize(await store.listFileLocations(input.file));
   const first=normalize(await store.markFileLocationDeleted({id:input.loc,deletedAt:new Date(stamp)}));
   const repeated=normalize(await store.markFileLocationDeleted({id:input.loc,deletedAt:new Date(stamp)}));
   const invalid=normalize(await store.markFileLocationDeleted({id:input.loc,deletedAt:new Date(NaN)}));
   const after=normalize((await client.query('select id, file_id as "fileId", store_kind as "storeKind", locator, ownership, deleted_at as "deletedAt" from brain.file_locations where id=$1',[id(target)])).rows[0]);
   matrix.push({name:input.name,read,list,first,repeated,invalid,before,after});
  }
  if(hash(matrix)!==hash(matrixOracle(raw.fixture.rows))) throw Error('matrix oracle mismatch');
  raw.after=await snapshot(client);
  if(hash(raw.before)!==hash(raw.after)) throw Error('unexpected full table changes');
  const changed=(await client.query('select id, deleted_at as "deletedAt" from brain.file_locations where deleted_at is not null order by id')).rows.map(normalize);
  const expectedChanged=[...Array.from({length:4},(_,i)=>({id:id(raw.fixture.rows-i),deletedAt:stamp})),{id:id(target),deletedAt:stamp}].sort((a,b)=>a.id.localeCompare(b.id));
  if(hash(changed)!==hash(expectedChanged)) throw Error('unexpected changed rows');
  raw.changed=changed; raw.failed=false;
 } catch(e) {failure=e;}
 const errors=[];
 for(const [label,fn] of [['store',async()=>{if(store) await store.close();}],['diagnostic',async()=>{if(probe) await probe.end();}],['client',async()=>{if(client) await client.end();}],['database',async()=>{if(raw.resources.created){await admin.query(`drop database "${name}" with (force)`);raw.resources.deleted=true;}}],['admin',async()=>{if(admin) await admin.end();}]]) try {await fn();} catch(e) {errors.push(new Error(`${label}: ${e.message}`));}
 raw.finishedAt=new Date().toISOString();
 if(raw.environment) { raw.environment.loadAverageEnd=os.loadavg(); try {raw.environment.processesEnd=processes();} catch(e) {errors.push(e);} }
 const all=[...(failure?[failure]:[]),...socketErrors,...errors];
 if(all.length) {
  raw.failed=true; raw.errors=all.map(e=>({message:sanitize(e.message),...(e.code?{code:e.code}:{})}));
  const error=new Error(`file-locations runner failed: ${raw.errors.map(e=>e.message).join('; ')}`);
  error.raw=raw; error.resources=raw.resources; throw error;
 }
 return raw;
}
