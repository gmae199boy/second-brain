import os from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { median, hash, sanitize } from './core.mjs';
import { checkoutRevision, artifactFingerprint, runnerFingerprint } from './revision.mjs';
import { inspectMigrationDirectory, schemaEvidenceValid } from './common-search-schema.mjs';
import { prepareProtocol, statistics, diagnostics } from './common-search-protocol.mjs';

const productOptions='-c lock_timeout=0 -c statement_timeout=0 -c timezone=UTC';
const APP_PASSWORD='query-perf-only';
const appUrlFor=databaseUrl=>{const url=new URL(databaseUrl);url.username='brain_app';url.password=APP_PASSWORD;return url.toString();};
const appSettingsSql="select name,setting,unit from pg_settings where name in ('shared_buffers','work_mem','jit','max_parallel_workers_per_gather','effective_cache_size','random_page_cost','seq_page_cost','parallel_setup_cost','parallel_tuple_cost','min_parallel_table_scan_size','min_parallel_index_scan_size','max_parallel_workers','max_worker_processes','server_encoding','TimeZone','lock_timeout','statement_timeout') order by name";
// PostgreSQL 16 removed lc_collate/lc_ctype GUCs; read the database catalog via the app connection.
const localeSql='select datlocprovider as provider, datlocale as locale, datcollversion as version, datcollate as collate, datctype as ctype from pg_database where datname=current_database()';
const wrap=(label,e)=>Object.assign(new Error(`${label}: ${e.message}`,{cause:e}),e.code ? {code:e.code} : {});
const CONFIG='019a0000-0000-7000-8000-000000000003';
const OWNER='019a0000-0000-7000-8000-000000000100';
const LONG_SESSION='019a0000-0000-7000-8000-000000000101';
const AUX_PROJECT='019a0000-0000-7000-8000-000000000201', AUX_WORKTREE='019a0000-0000-7000-8000-000000000202';
const queryByCondition={common:'common',a:'a',missing:'unmatched-synthetic-query-908731'};
const uuid = text => { const s=createHash('md5').update(text).digest('hex'); return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`; };
const metrics = samplesMs => ({samplesMs,medianMs:median(samplesMs)});
const requireOk = r => { if(!r?.ok) { const error=new Error(r?.message ?? 'operation failed'); error.code=r?.code; throw error; } return r; };
const snapshot = () => ({at:new Date().toISOString(),loadAverage:os.loadavg(),processes:processSnapshot()});
const processSnapshot = () => { try { return execFileSync('ps',['-A','-o','pid=,comm='],{encoding:'utf8'}).split('\n').filter(Boolean).map(line=>sanitize(line)); } catch(e) { return [`unavailable: ${sanitize(e.message)}`]; } };

// Independent fixed fixture contract must agree with both checkout API and migrated database.
export async function assertFixtureConfig(client, checkoutConfig) {
 if(checkoutConfig!==CONFIG) throw Error(`common-search fixture config mismatch: expected ${CONFIG}, checkout ${String(checkoutConfig)}`);
 const rows=(await client.query('select id::text, kind from brain.index_configs where id=$1::uuid',[CONFIG])).rows;
 if(rows.length!==1 || rows[0].id!==CONFIG || rows[0].kind!=='chunk') throw Error(`common-search fixture config missing from migrated database: ${CONFIG}`);
}

async function fixture(client, size) {
 await client.query(`set session_replication_role=replica;
 insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source)
 select md5('chunk-session'||i)::uuid,'synthetic','chunk-'||i,'${OWNER}','synthetic','2026-01-01','import' from generate_series(0,19) i;
 insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${LONG_SESSION}','synthetic','long','${OWNER}','synthetic','2026-01-01','import');
 insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body)
 select md5('chunk'||i)::uuid,md5('chunk-session'||((i-1)%20))::uuid,'${CONFIG}', '2026-01-01'::timestamptz+i*interval '1 second','2026-01-01'::timestamptz+i*interval '1 second',0,'common a '||repeat('x',1015) from generate_series(1,${size}) i;
 insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at)
 select md5('message'||i)::uuid,'${LONG_SESSION}',i::text,'user',repeat('x',1024),'2026-01-01'::timestamptz+i*interval '1 second' from generate_series(1,${size}) i;
 insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok)
 select md5('tool'||i)::uuid,'${LONG_SESSION}',i::text,0,'synthetic','common a '||repeat('x',1015),1 from generate_series(1,${size}) i;
 set session_replication_role=origin;`);
}

// Original full scan/ranking SQL, independent of the checkout's search implementation.
function oracleSql(kind) {
 const source=kind==='chunks'
  ? `select c.id,c.body,c.from_at,c.session_id from brain.chunks c where c.index_config_id=$3::uuid and lower(c.body) like lower($1) escape '\\'`
  : `select n.id,n.target as body,m.occurred_at as from_at,n.session_id from brain.tool_notes n left join brain.messages m on m.session_id=n.session_id and m.harness_message_id=n.harness_message_id and m.harness_message_id_raw is not distinct from n.harness_message_id_raw where lower(n.target) like lower($1) escape '\\' and $3::uuid is not null`;
 return `select x.id from (${source}) x join brain.sessions s on s.id=x.session_id order by case when $4::text is not null and s.worktree_id::text=$4 then 0 when $5::text is not null and s.project_id::text=$5 then 1 else 2 end,(length(lower(x.body))-length(replace(lower(x.body),lower($2),''))) desc,x.from_at desc nulls last,x.id asc limit 6`;
}

// Warmup remains outside the three returned measurements.
export async function sampleThree(warm, measure) {
 await warm(); const values=[];
 for(let i=0;i<3;i++) values.push(await measure(i));
 return values;
}

// Store only paths and hashes, never response values or SQL parameters.
function firstDifference(a,b,path='$') {
 if(JSON.stringify(a)===JSON.stringify(b)) return null;
 if(a && b && typeof a==='object' && typeof b==='object') {
  for(const key of new Set([...Object.keys(a),...Object.keys(b)])) {
   if(JSON.stringify(a[key])!==JSON.stringify(b[key])) return firstDifference(a[key],b[key],`${path}.${key}`);
  }
 }
 return path;
}
export function assertEvidence(partial,label,expectedIds,actualIds,expected,actual) {
 if(hash(expected)===hash(actual)) return;
 partial.mismatch={label,expectedIds,actualIds,expectedIdsHash:hash(expectedIds),actualIdsHash:hash(actualIds),expectedHash:hash(expected),actualHash:hash(actual),firstDifference:firstDifference(expected,actual)};
 throw Error(`${label} mismatch`);
}

// Only product calls are traced, not fixture, oracle or EXPLAIN queries.
export async function trace(Client, action) {
 const original=Client.prototype.query, spans=[]; let captured;
 Client.prototype.query=function(...args) {
  const text=typeof args[0]==='string'?args[0]:args[0]?.text;
  const values=Array.isArray(args[1])?args[1]:(args[0]?.values??[]);
  const start=performance.now();
  const promise=original.apply(this,args);
  if(!promise || typeof promise.then!=='function') throw Error('query tracing requires promise API');
  const search=Boolean(text && /from\s+brain\.(chunks|tool_notes)/i.test(text) && /like/i.test(text));
  const record=()=>spans.push({ms:performance.now()-start,sqlSha256:createHash('sha256').update(String(text ?? '').replace(/\s+/g,' ').trim()).digest('hex'),search});
  return promise.then(value=>{record(); if(search) captured={text,values}; return value;},error=>{record(); throw error;});
 };
 try { const result=await action(); return {result,spans,captured}; } finally { Client.prototype.query=original; }
}

export async function run(opts, internal={}) {
 const runStartedAt=new Date().toISOString();
 const size=internal.rows ?? 100000;
 if(!Number.isSafeInteger(size)||size<6) throw Error('invalid common-search fixture size');
 const checkout=resolve(opts.checkout);
 const api=await import(pathToFileURL(resolve(checkout,'packages/postgres/dist/index.js')).href);
 const core=await import(pathToFileURL(resolve(checkout,'packages/core/dist/index.js')).href);
 const {createPool}=await import(pathToFileURL(resolve(checkout,'packages/postgres/dist/connect.js')).href);
 const {Client}=createRequire(resolve(checkout,'packages/postgres/package.json'))('pg');
 const admin=new Client({connectionString:opts.databaseUrl,connectionTimeoutMillis:10000,query_timeout:120000});
 const name=`qp_${randomBytes(10).toString('hex')}`, url=new URL(opts.databaseUrl); url.pathname='/'+name;
 let client,appPool,store,created=false,deleted=false,output,failure; const socketErrors=[],appClientEnds=[];
 const partial={scenario:'common-search',status:'failed',startedAt:runStartedAt,stage:'connect',condition:null,runs:[]};
 const timed=async(stage,action)=>{partial.stage=stage; if(internal.onPhase) internal.onPhase({stage,condition:partial.condition}); const startedAt=new Date().toISOString(); try {return {value:await action(),startedAt,finishedAt:new Date().toISOString()};} catch(e) {partial.activeTiming={startedAt,finishedAt:new Date().toISOString()}; throw e;} };
 const watch=(conn,label)=>{conn.on('error',e=>socketErrors.push(wrap(label,e))); return conn;};
 watch(admin,'admin');
 partial.snapshots={setupStart:snapshot()};
 try {
  await admin.connect();
  const revision=checkoutRevision(checkout), artifacts={...artifactFingerprint(checkout),runner:runnerFingerprint()};
  Object.assign(partial,{checkoutRevision:revision,artifacts,stage:'schema-preflight'});
  const schema=inspectMigrationDirectory(resolve(checkout,'packages/postgres/migrations'),api.CORE_SCHEMA_VERSION); partial.schema=schema;
  partial.stage='environment';
  const identity=hash({hostname:os.hostname(),cpu:os.cpus().map(c=>c.model),memory:os.totalmem()});
  const systemIdentifier=(await admin.query('select system_identifier::text as id from pg_control_system()')).rows[0].id;
  const environment={node:process.version,postgres:(await admin.query('select version() as v')).rows[0].v,platform:process.platform,arch:process.arch,cpus:os.cpus().length,hostIdentity:identity,systemIdentifier}; partial.environment=environment; partial.stage='create-database';
  await admin.query(`create database "${name}"`); created=true;
  if(internal.afterCreate) await internal.afterCreate({admin,name});
  partial.stage='prepare';
  requireOk(await api.prepareDatabase({databaseUrl:url.toString(),databaseName:name,appPassword:'query-perf-only',maintenancePassword:'query-perf-only'}));
  partial.stage='migrate';
  const migrationStartedAt=new Date().toISOString(), migrationStart=performance.now();
  const migrationResult=requireOk(await api.runMigrations({databaseUrl:url.toString(),clock:{now:()=>new Date('2026-01-01T00:00:00Z')}}));
  const migration={startedAt:migrationStartedAt,finishedAt:new Date().toISOString(),ms:performance.now()-migrationStart,value:migrationResult,schema}; partial.migration=migration;
  if(!schemaEvidenceValid(schema,schema.version,migrationResult.to)) throw Error('unexpected checkout schema or migration result');
  client=watch(new Client({connectionString:url.toString(),connectionTimeoutMillis:10000,options:productOptions}),'fixture'); await client.connect();
  partial.stage='app-connect';
  const appUrl=appUrlFor(url.toString()); appPool=watch(createPool({databaseUrl:appUrl,queryTimeoutMs:0,lockTimeoutMs:0}),'app-pool');
  appPool.on('connect',connection=>{ watch(connection,'app-client'); appClientEnds.push(new Promise(resolve=>connection.once('end',resolve))); });
  if(internal.beforeAppConnect) await internal.beforeAppConnect({appPool,admin,name});
  environment.role=(await appPool.query('select current_user,session_user')).rows[0];
  if(environment.role?.current_user!=='brain_app'||environment.role?.session_user!=='brain_app') throw Error('unexpected application role');
  environment.settings=(await appPool.query(appSettingsSql)).rows;
  environment.locale=(await appPool.query(localeSql)).rows[0];
  partial.stage='fixture-config'; await assertFixtureConfig(client,core.CONVERSATION_CHUNK_INDEX_CONFIG_ID);
  partial.stage='fixture'; await fixture(client,size);
  partial.stage='protocol2'; const preparation=await prepareProtocol(client,p=>{partial.preparation=p;});
  partial.statistics=await statistics(client);
  if(partial.statistics.definitions.length!==0 || partial.statistics.distributions.length!==0) throw Error('unexpected schema or expression statistics');
  if(internal.beforeFingerprint) await internal.beforeFingerprint({client});
  const counts=(await client.query(`select (select count(*)::int from brain.chunks) as chunks,(select count(*)::int from brain.tool_notes) as tools,(select count(*)::int from brain.messages) as messages,(select count(*)::int from brain.sessions) as sessions,(select min(octet_length(body))::int from brain.chunks) as min_bytes,(select max(octet_length(target))::int from brain.tool_notes) as max_bytes`)).rows[0];
  if(counts.chunks!==size||counts.tools!==size||counts.messages!==size||counts.sessions!==21||counts.min_bytes!==1024||counts.max_bytes!==1024) throw Error('fixture counts or bytes mismatch');
  // Fingerprint actual rows, not only the fixture recipe or counts; each value is synthetic.
  const fingerprints=(await client.query(`select
    (select md5(string_agg(md5(jsonb_build_array(id,harness,harness_session_id,user_id,machine,started_at,workspace_id,project_id,worktree_id,ingest_source,ended_at,start_source,continued_from_session_id,tag_source,first_cwd,first_cwd_raw)::text),'' order by id)) from brain.sessions) as sessions,
    (select md5(string_agg(md5(jsonb_build_array(id,session_id,index_config_id,from_at,to_at,part,body,body_raw)::text),'' order by id)) from brain.chunks) as chunks,
    (select md5(string_agg(md5(jsonb_build_array(id,session_id,harness_message_id,harness_message_id_raw,ordinal,tool,tool_raw,target,target_raw,ok,call_id,call_id_raw)::text),'' order by id)) from brain.tool_notes) as tools,
    (select md5(string_agg(md5(jsonb_build_array(id,session_id,harness_message_id,harness_message_id_raw,role,model,model_raw,body,body_raw,occurred_at,git_branch,git_branch_raw,is_subagent_report)::text),'' order by id)) from brain.messages) as messages`)).rows[0];
  const fields={sessions:['id','harness','harness_session_id','user_id','machine','started_at','workspace_id','project_id','worktree_id','ingest_source','ended_at','start_source','continued_from_session_id','tag_source','first_cwd','first_cwd_raw'],chunks:['id','session_id','index_config_id','from_at','to_at','part','body','body_raw'],tools:['id','session_id','harness_message_id','harness_message_id_raw','ordinal','tool','tool_raw','target','target_raw','ok','call_id','call_id_raw'],messages:['id','session_id','harness_message_id','harness_message_id_raw','role','model','model_raw','body','body_raw','occurred_at','git_branch','git_branch_raw','is_subagent_report']};
  const fixtureInfo={rows:size,bodyBytes:1024,chunkSessions:20,toolSessions:1,limit:5,recipeVersion:2,fields,sha256:hash({version:2,counts,fingerprints,config:CONFIG})};
  partial.fixture=fixtureInfo;
  store=api.postgresStore({databaseUrl:appUrl,queryTimeoutMs:0,lockTimeoutMs:0});
  if(internal.afterFixture) await internal.afterFixture({name,client});
  partial.snapshots.setupEnd=snapshot();
  partial.snapshots.measurementStart=snapshot();
  const runs=partial.runs, cpu=process.cpuUsage();
  for(const kind of ['chunks','tools']) for(const [condition,query] of Object.entries(queryByCondition)) {
   partial.condition={kind,condition}; partial.stage='oracle';
   const pattern=core.literalLikePattern(query), expected=(await client.query(oracleSql(kind),[pattern,query,CONFIG,null,null])).rows.map(row=>row.id);
   const fixed=condition==='missing'?[]:Array.from({length:6},(_,i)=>uuid(`${kind==='chunks'?'chunk':'tool'}${size-i}`));
   assertEvidence(partial,`${kind}/${condition} fixed oracle`,fixed,expected,fixed,expected);
   const storeInput={kind,query,pattern,limit:6};
   const readIds=r=>r.rows.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id);
   if(internal.beforeStore) await internal.beforeStore({client,kind,condition});
   const originalStore=requireOk(await store.searchRecall(storeInput));
   assertEvidence(partial,`${kind}/${condition} store oracle`,expected,readIds(originalStore),expected,readIds(originalStore));
   if(internal.beforeCore) await internal.beforeCore({client,kind,condition});
   const call=()=>core.searchRecall(store,kind,{query,sources:['synthetic']},store);
   let resultHash;
   const wall=[],storeWall=[],sqlSamples=[],timings={wall:[],diagnostics:[],store:[]}; let captured;
   partial.current={kind,condition,wall,storeWall,sqlSamples,timings,oracleHash:hash(expected),fixedHash:hash(fixed),storeHash:hash(originalStore)};
   const warm=await timed('warmup',call); timings.warmup={startedAt:warm.startedAt,finishedAt:warm.finishedAt};
   requireOk(warm.value); resultHash=hash(warm.value); partial.current.resultHash=resultHash;
   const coreIds=warm.value.data.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id);
   assertEvidence(partial,`${kind}/${condition} core oracle`,expected.slice(0,5),coreIds,{ids:expected.slice(0,5),hasMore:expected.length>5,extensionsArray:true},{ids:coreIds,hasMore:warm.value.meta.has_more,extensionsArray:Array.isArray(warm.value.meta.extensions)});
   for(let i=0;i<3;i++) {
    const measured=await timed('wall',async()=>{const start=performance.now(); const result=await call(); return {result,ms:performance.now()-start};});
    timings.wall.push({startedAt:measured.startedAt,finishedAt:measured.finishedAt});
    requireOk(measured.value.result); assertEvidence(partial,`${kind}/${condition} unstable core result`,warm.value.data.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id),measured.value.result.data.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id),warm.value,measured.value.result);
    wall.push(measured.value.ms);
   }
   for(let i=0;i<3;i++) {
    const diagnostic=await timed('diagnostic',()=>trace(Client,call)); timings.diagnostics.push({startedAt:diagnostic.startedAt,finishedAt:diagnostic.finishedAt});
    const traced=diagnostic.value; requireOk(traced.result); assertEvidence(partial,`${kind}/${condition} unstable diagnostic result`,warm.value.data.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id),traced.result.data.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id),warm.value,traced.result);
    if(!traced.captured) throw Error(`${kind}/${condition} search SQL not captured`);
    captured=traced.captured; sqlSamples.push({count:traced.spans.length,totalMs:traced.spans.reduce((a,b)=>a+b.ms,0),spansMs:traced.spans.map(s=>s.ms),searchMs:traced.spans.filter(s=>s.search).reduce((a,b)=>a+b.ms,0),spans:traced.spans});
   }
   for(let i=0;i<3;i++) {
    const sampled=await timed('store',async()=>{const start=performance.now(); const result=await store.searchRecall(storeInput); return {result,ms:performance.now()-start};});
    timings.store.push({startedAt:sampled.startedAt,finishedAt:sampled.finishedAt}); const sr=requireOk(sampled.value.result); storeWall.push(sampled.value.ms);
    assertEvidence(partial,`${kind}/${condition} unstable store result`,readIds(originalStore),readIds(sr),originalStore,sr);
   }
   const plan=await timed('explain',async()=>(await appPool.query('explain (analyze, buffers, format json) '+captured.text,captured.values)).rows[0]['QUERY PLAN']);
   timings.explain={startedAt:plan.startedAt,finishedAt:plan.finishedAt};
   runs.push({kind,condition,resultHash,storeHash:hash(originalStore),oracleHash:hash(expected),fixedHash:hash(fixed),oracleMatch:true,fixedMatch:true,wall:metrics(wall),storeWall:metrics(storeWall),sqlSamples,explain:plan.value,timings});
   partial.current=null; partial.stage='condition-complete';
   if(internal.afterCondition) await internal.afterCondition({kind,condition,runs});
  }
  partial.snapshots.measurementEnd=snapshot();
  // Auxiliary contract fixture is added only after all six performance conditions.
  partial.stage='auxiliary-fixture'; partial.condition=null;
  await client.query(`set session_replication_role=replica;
    insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source,project_id,worktree_id)
    select md5('aux-session'||i)::uuid,'synthetic','aux-'||i,'${OWNER}','synthetic','2026-01-01','import',case when i<=4 then '${AUX_PROJECT}'::uuid end,case when i<=2 then '${AUX_WORKTREE}'::uuid end from generate_series(1,6) i;
    insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body)
    select md5('aux-chunk'||i)::uuid,md5('aux-session'||i)::uuid,'${CONFIG}','2026-04-01'::timestamptz+i*interval '1 second','2026-04-01'::timestamptz+i*interval '1 second',0,repeat('auxneedle ',i)||'password=synthetic-secret '||repeat('z ',2000) from generate_series(1,6) i;
    insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at)
    select md5('aux-message'||i)::uuid,md5('aux-session'||i)::uuid,'aux','user','synthetic','2026-04-01'::timestamptz+i*interval '1 second' from generate_series(1,6) i;
    insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok)
    select md5('aux-tool'||i)::uuid,md5('aux-session'||i)::uuid,'aux',0,'synthetic',repeat('auxneedle ',i)||'password=synthetic-secret '||repeat('z ',2000),1 from generate_series(1,6) i;
    set session_replication_role=origin; analyze brain.chunks; analyze brain.tool_notes; analyze brain.messages; analyze brain.sessions;`);
  if(internal.beforeAuxiliary) await internal.beforeAuxiliary({client});
  const auxiliary=[]; partial.auxiliary=auxiliary;
  for(const kind of ['chunks','tools']) {
   partial.condition={kind,condition:'auxiliary'}; partial.stage='auxiliary-oracle';
   const query='auxneedle', pattern=core.literalLikePattern(query);
   const expected=(await client.query(oracleSql(kind),[pattern,query,CONFIG,AUX_WORKTREE,AUX_PROJECT])).rows.map(row=>row.id);
   const fixed=[2,1,4,3,6,5].map(i=>uuid(`aux-${kind==='chunks'?'chunk':'tool'}${i}`));
   assertEvidence(partial,`${kind} auxiliary fixed oracle`,fixed,expected,fixed,expected);
   const storeResult=requireOk(await store.searchRecall({kind,query,pattern,limit:6,worktree:AUX_WORKTREE,project:AUX_PROJECT}));
   const auxStoreIds=storeResult.rows.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id);
   assertEvidence(partial,`${kind} auxiliary store oracle`,expected,auxStoreIds,expected,auxStoreIds);
   const result=requireOk(await core.searchRecall(store,kind,{query,worktree:AUX_WORKTREE,project:AUX_PROJECT,sources:['synthetic']},store));
   const envelope={ok:true,now:'2000-01-01T00:00:00.000+00:00',data:result.data,warnings:result.warnings,meta:result.meta};
   const jsonSize=Array.from(JSON.stringify(envelope)).length+1;
   const next=result.meta?.next, ext=result.meta?.extensions;
   const actualAux={ids:result.data.map(row=>kind==='chunks'?row.chunk_id:row.tool_note_id),sizeOk:jsonSize<=8000,truncated:result.warnings.includes('RESULT_TRUNCATED'),hasMore:result.meta.has_more,omitted:result.meta.omitted?.count,reason:result.meta.omitted?.reason,next:next?.ns==='sessions' && next?.verb==='read' && next?.args?.session==='synthetic:aux-1' && next?.args?.from_at==='2026-04-01T00:00:01.000Z',metadata:Array.isArray(ext) && ext.some(e=>e.source==='synthetic' && e.installed===false),masked:Boolean(result.data[0]?.body.includes('[REDACTED:')),secretAbsent:!JSON.stringify(result).includes('synthetic-secret')};
   const expectedAux={ids:[fixed[0]],sizeOk:true,truncated:true,hasMore:true,omitted:4,reason:'결과 크기 한도',next:true,metadata:true,masked:true,secretAbsent:true};
   assertEvidence(partial,`${kind} auxiliary output contract`,[fixed[0]],actualAux.ids,expectedAux,actualAux);
   auxiliary.push({kind,resultHash:hash(result),oracleHash:hash(expected),fixedHash:hash(fixed),truncated:true,masked:true,hasMore:true,omitted:4,nextVerified:true,metadataVerified:true,jsonSize});
  }
  partial.stage='cost-diagnostics'; partial.condition=null;
  const diagnostic=await diagnostics({admin,Client,url:opts.databaseUrl,api,schema,fixture,size,assertConfig:assertFixtureConfig,checkoutConfig:core.CONVERSATION_CHUNK_INDEX_CONFIG_ID,options:productOptions,onDiagnostic:internal.onDiagnostic,onProgress:diagnostic=>{partial.diagnostic=diagnostic;},onResource:resources=>{partial.diagnosticResources=resources;}}); partial.diagnostic=diagnostic;
  partial.stage='complete';
  output={scenario:'common-search',status:'ok',checkoutRevision:revision,artifacts,fixture:fixtureInfo,environment,migration,preparation,statistics:partial.statistics,diagnostic,snapshots:partial.snapshots,startedAt:partial.startedAt,cpuUsage:process.cpuUsage(cpu),maxRssKiB:process.resourceUsage().maxRSS,runs,auxiliary};
 } catch(error) { if(error.preparation && partial.stage!=='cost-diagnostics') partial.preparation=error.preparation; if(error.diagnostic) partial.diagnostic=error.diagnostic; failure=error; }
 const errors=[];
 for(const [label,action] of [['store',async()=>{if(store) await store.close();}],['app-pool',async()=>{if(appPool) {
   // pg-pool can resolve end before its clients' sockets emit end. Keep error
   // observers until actual termination, and bound cleanup before forced DROP.
   let timer;
   try { await Promise.race([Promise.all([Promise.resolve().then(()=>appPool.end()).catch(e=>{errors.push(wrap('app-pool',e));}),...appClientEnds]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('app pool termination timed out')),10000);})]); }
   finally { clearTimeout(timer); }
  }}],['client',async()=>{if(client) await client.end();}],['database',async()=>{if(created){if(internal.beforeDrop) await internal.beforeDrop({name}); await admin.query(`drop database "${name}" with (force)`); deleted=true;}}],['admin',async()=>admin.end()]]) {
  try { await action(); } catch(e) { errors.push(wrap(label,e)); }
 }
 const flatten=error=>[error,...(error instanceof AggregateError?error.errors.flatMap(flatten):[])];
 const resources={database:name,created,deleted}, all=[...(failure?flatten(failure):[]),...socketErrors,...errors];
 if(all.length) { const safe=all.map(e=>{const result=new Error(sanitize(e.message)); if(e.code) result.code=e.code; return result;}); const error=new AggregateError(safe,`common-search failed; database=${name} created=${created} deleted=${deleted}: `+safe.map(e=>e.code?`${e.code}: ${e.message}`:e.message).join('; ')); partial.finishedAt=new Date().toISOString(); partial.resources=resources; partial.errors=safe.map(e=>({message:e.message,...(e.code?{code:e.code}:{})})); error.resources=resources; error.evidence=partial; throw error; }
 output.finishedAt=new Date().toISOString(); output.resources=resources; return output;
}
