import { expect, it } from 'vitest';
import { resolve } from 'node:path';
import { CONVERSATION_CHUNK_INDEX_CONFIG_ID } from '../../../packages/core/src/index.js';
import { createPool } from '../../../packages/postgres/src/connect.js';
import { createIsolatedTestDatabase } from '../../test-db/src/index.js';
// @ts-expect-error JavaScript runner has no declarations.
import { run } from '../src/common-search.mjs';
const checkout=resolve(import.meta.dirname,'../../..');
type Failure = Error & {resources:{database:string;created:boolean;deleted:boolean};errors:(Error & {code?:string})[]};

it('small isolated runner checks six oracle results, three samples and owned database cleanup',async()=>{
 const db=await createIsolatedTestDatabase(); const phases:string[]=[];
 try {
  const r=await run({checkout,databaseUrl:db.url},{rows:40,afterFixture:async({client}:{client:{query:(sql:string, values?:unknown[])=>Promise<{rows:unknown[]}>}})=>{
   expect(CONVERSATION_CHUNK_INDEX_CONFIG_ID).toBe('019a0000-0000-7000-8000-000000000003');
   const drive=await client.query("select to_regclass('brain.drive_uploads')::text as uploads, to_regclass('brain.drive_retention')::text as retention, to_regclass('brain.drive_migration_intents')::text as intents, to_regclass('brain.drive_location_roots')::text as roots");
   const sources=await client.query("select to_regclass('brain.sources')::text as sources, to_regclass('brain.source_files')::text as files");
   expect(sources.rows).toEqual([{sources:'brain.sources',files:'brain.source_files'}]);
   expect(drive.rows).toEqual([{uploads:'brain.drive_uploads',retention:'brain.drive_retention',intents:'brain.drive_migration_intents',roots:'brain.drive_location_roots'}]);
   const rows=await client.query("select index_config_id::text as id,count(*)::int as count from brain.chunks group by index_config_id");
   expect(rows.rows).toEqual([{id:'019a0000-0000-7000-8000-000000000003',count:40}]);
   const config=await client.query("select id::text,kind from brain.index_configs where id=$1::uuid",['019a0000-0000-7000-8000-000000000003']);
   expect(config.rows).toEqual([{id:'019a0000-0000-7000-8000-000000000003',kind:'chunk'}]);
  },onPhase:({stage,condition}:{stage:string;condition:{kind:string;condition:string}})=>phases.push(`${condition.kind}/${condition.condition}:${stage}`)});
  expect(r.fixture).toMatchObject({rows:40,bodyBytes:1024,chunkSessions:20,toolSessions:1});
  expect(r.runs.map((x:{kind:string;condition:string})=>`${x.kind}/${x.condition}`)).toEqual(['chunks/common','chunks/a','chunks/missing','tools/common','tools/a','tools/missing']);
  for(const row of r.runs) {
   expect(row).toMatchObject({oracleMatch:true,fixedMatch:true}); expect(row.oracleHash).toBe(row.fixedHash);
   expect(row.sqlSamples.every((sample:{searchMs:number;spans:{search:boolean;sqlSha256:string}[]})=>sample.searchMs>=0 && sample.spans.some(span=>span.search && /^[a-f0-9]{64}$/.test(span.sqlSha256)))).toBe(true);
   expect(row.wall.samplesMs).toHaveLength(3); expect(row.storeWall.samplesMs).toHaveLength(3); expect(row.sqlSamples).toHaveLength(3); expect(row.explain).toBeTruthy();
   expect(row.timings.wall).toHaveLength(3); expect(row.timings.diagnostics).toHaveLength(3); expect(row.timings.store).toHaveLength(3); expect(row.timings.warmup.startedAt).toBeTruthy(); expect(row.timings.explain.finishedAt).toBeTruthy();
  }
  expect(phases.slice(0,11)).toEqual(['chunks/common:warmup',...Array(3).fill('chunks/common:wall'),...Array(3).fill('chunks/common:diagnostic'),...Array(3).fill('chunks/common:store'),'chunks/common:explain']);
  expect(r.environment.role).toEqual({current_user:'brain_app',session_user:'brain_app'});
  for(const prep of [r.preparation,r.diagnostic.cost.setup.preparation]) expect(prep).toMatchObject({protocolVersion:2,readinessCriterion:'vacuum-success-counts-unchanged-pending-zero-if-supported',ready:true,targets:['sessions','messages','chunks','tool_notes']});
  expect(r.preparation.vacuum.map((v:{table:string})=>v.table)).toEqual(['sessions','messages','chunks','tool_notes']);
  expect(r.preparation.pre.tables.map((x:{count:number})=>x.count)).toEqual(r.preparation.post.tables.map((x:{count:number})=>x.count));
  if(r.preparation.support.supported) for(const index of r.preparation.post.indexes) expect(index.pending).toMatchObject({pending_pages:0,pending_tuples:'0'});
  for(const snapshot of [r.preparation.pre,r.preparation.post,r.diagnostic.cost.setup.preparation.pre,r.diagnostic.cost.setup.preparation.post,r.diagnostic.cost.analyze.pre,r.diagnostic.cost.analyze.post]) {
   expect(snapshot.tables.map((x:{count:number})=>x.count)).toEqual([21,40,40,40]);
   expect(snapshot.settings.filter((x:{name:string})=>['TimeZone','lock_timeout','statement_timeout'].includes(x.name)).map((x:{name:string;setting:string})=>[x.name,x.setting]).sort()).toEqual([['TimeZone','UTC'],['lock_timeout','0'],['statement_timeout','0']].sort());
  }
  expect(r.diagnostic.cost.write.before).toEqual({chunks:40,messages:40,tool_notes:40});
  expect(r.diagnostic.cost.write.after).toEqual(r.diagnostic.cost.write.before);
  for(const stat of [r.statistics,r.diagnostic.cost.statisticsBefore,r.diagnostic.cost.statisticsAfter]) expect(stat).toMatchObject({stage:'complete',definitions:[],distributions:[]});
  expect(r.diagnostic.resources).toHaveLength(1); expect(r.diagnostic.resources.every((x:{created:boolean;deleted:boolean})=>x.created && x.deleted)).toBe(true);
  expect(r.diagnostic.cost.write.samplesMs).toHaveLength(3); expect(r.diagnostic.cost.analyze.samplesMs).toHaveLength(3);
  expect(r.migration.value.to).toBe(47); expect(r.diagnostic.cost.setup.migration.to).toBe(47);
  expect(r.migration.schema).toEqual(r.diagnostic.cost.setup.schema); expect(r.migration.schema).toMatchObject({version:47,apiVersion:47}); expect(r.diagnostic.upgrade).toBeUndefined();
  expect(r.auxiliary).toHaveLength(2);
  for(const a of r.auxiliary) expect(a).toMatchObject({truncated:true,masked:true,hasMore:true,omitted:4,nextVerified:true,metadataVerified:true});
  expect(r.environment.locale).toMatchObject({provider:expect.stringMatching(/^[cib]$/),collate:expect.stringMatching(/^.+$/),ctype:expect.stringMatching(/^.+$/)});
  expect(r.fixture).toMatchObject({recipeVersion:2,fields:{sessions:expect.arrayContaining(['worktree_id','tag_source']),chunks:expect.arrayContaining(['to_at','part','body_raw']),tools:expect.arrayContaining(['tool','ordinal','target_raw']),messages:expect.arrayContaining(['harness_message_id_raw','occurred_at'])}});
  const times=[r.startedAt,...['setupStart','setupEnd','measurementStart','measurementEnd'].map(k=>r.snapshots[k].at),r.finishedAt].map(Date.parse);
  expect(times.every((value:number,i:number)=>i===0 || value>=times[i-1]!)).toBe(true);
  expect(r.resources).toMatchObject({created:true,deleted:true});
  expect(await db.rows(`select datname from pg_database where datname='${r.resources.database}'`)).toEqual([]);
 } finally {await db.drop();}
},120000);

it('records fixture and socket failures, removes the owned DB, and preserves a failed drop',async()=>{
 const db=await createIsolatedTestDatabase(); let remaining='';
 try {
  try {
   await run({checkout,databaseUrl:db.url},{rows:40,afterFixture:({client}:{client:{emit:(event:string,error:Error)=>void}})=>{client.emit('error',Object.assign(new Error('synthetic socket'),{code:'ECONNRESET'})); throw new Error('synthetic fixture');}});
   throw new Error('expected failure');
  } catch(error) {
   const failure=error as Failure; expect(failure.message).toContain('synthetic fixture'); expect(failure.errors.some(e=>e.message.includes('synthetic socket') && e.code==='ECONNRESET')).toBe(true);
   expect(failure.resources).toMatchObject({created:true,deleted:true}); expect(await db.rows(`select datname from pg_database where datname='${failure.resources.database}'`)).toEqual([]);
  }
  try {
   await run({checkout,databaseUrl:db.url},{rows:40,afterFixture:()=>{throw new Error('fixture stop');},beforeDrop:()=>{throw Object.assign(new Error('drop failure'),{code:'DROP_FAILED'});}});
   throw new Error('expected drop failure');
  } catch(error) {
   const failure=error as Failure; expect(failure.message).toContain('fixture stop'); expect(failure.message).toContain('drop failure'); expect(failure.errors.some(e=>e.code==='DROP_FAILED')).toBe(true);
   expect(failure.resources).toMatchObject({created:true,deleted:false}); remaining=failure.resources.database;
   expect(await db.rows(`select datname from pg_database where datname='${remaining}'`)).toEqual([{datname:remaining}]);
  }
 } finally {if(remaining) await db.query(`drop database "${remaining}" with (force)`); await db.drop();}
},120000);

it('preserves initial connection refusal and SEARCH_FAILED on product SQL failure',async()=>{
 try {
  await run({checkout,databaseUrl:'postgres://user:secret@127.0.0.1:1/postgres'},{rows:40}); throw new Error('expected refusal');
 } catch(error) {
  const failure=error as Failure; expect(failure.resources).toMatchObject({created:false,deleted:false}); expect(failure.errors.some(e=>e.code==='ECONNREFUSED')).toBe(true); expect(failure.message).not.toContain('secret');
 }
 const db=await createIsolatedTestDatabase();
 try {
  try {
   await run({checkout,databaseUrl:db.url},{rows:40,beforeStore:async({client}:{client:{query:(sql:string)=>Promise<unknown>}})=>{await client.query('drop table brain.chunks cascade');}});
   throw new Error('expected product failure');
  } catch(error) {
   const failure=error as Failure; expect(failure.resources).toMatchObject({created:true,deleted:true}); expect(failure.errors.some(e=>e.code==='SEARCH_FAILED')).toBe(true); expect(failure.message).toContain('SEARCH_FAILED'); expect(failure.message).not.toContain(db.url);
  }
 } finally {await db.drop();}
},120000);

it('preserves sanitized partial provenance and completed conditions after mid-run failure',async()=>{
 const sentinel='synthetic_t60_unique_password_91c42', injectedUrl=`postgres://user:${sentinel}@localhost/db`;
 const db=await createIsolatedTestDatabase();
 try {
  try {
   await run({checkout,databaseUrl:db.url},{rows:40,afterCondition:({runs}:{runs:unknown[]})=>{if(runs.length===1) throw new Error(`synthetic ${injectedUrl}`);}});
   throw new Error('expected mid-run failure');
  } catch(error) {
   const failure=error as Failure & {evidence:{stage:string;condition:{kind:string;condition:string};runs:unknown[];checkoutRevision:unknown;artifacts:unknown;environment:unknown;startedAt:string;finishedAt:string}};
   expect(failure.resources).toMatchObject({created:true,deleted:true}); expect(failure.evidence).toMatchObject({stage:'condition-complete',condition:{kind:'chunks',condition:'common'},runs:[{kind:'chunks',condition:'common'}]});
   expect(failure.evidence.checkoutRevision).toBeTruthy(); expect(failure.evidence.artifacts).toBeTruthy(); expect(failure.evidence.environment).toBeTruthy(); expect(failure.evidence.startedAt).toBeTruthy(); expect(failure.evidence.finishedAt).toBeTruthy();
   expect(JSON.stringify(failure.evidence)).not.toContain(sentinel); expect(JSON.stringify(failure.evidence)).not.toContain(injectedUrl); expect(JSON.stringify(failure.evidence)).not.toContain(db.url); expect(failure.message).toContain('[database-url]');
  }
 } finally {await db.drop();}
},120000);

it('preserves completed sample and current timing on a measured phase failure',async()=>{
 const db=await createIsolatedTestDatabase(); let calls=0;
 try {
  try {
   await run({checkout,databaseUrl:db.url},{rows:40,onPhase:({stage}:{stage:string})=>{if(stage==='wall' && ++calls===2) throw new Error('sample failure');}});
   throw new Error('expected sample failure');
  } catch(error) {
   const failure=error as Failure & {evidence:{stage:string;current:{wall:number[];timings:{wall:unknown[]}}}};
   expect(failure.resources).toMatchObject({created:true,deleted:true}); expect(failure.evidence.stage).toBe('wall');
   expect(failure.evidence.current.wall).toHaveLength(1); expect(failure.evidence.current.timings.wall).toHaveLength(1);
  }
 } finally {await db.drop();}
},120000);

it('uses product settings in the generated database despite different admin defaults',async()=>{
 const db=await createIsolatedTestDatabase();
 const name=new URL(db.url).pathname.slice(1);
 try {
  await db.query(`alter database "${name}" set timezone to 'Pacific/Honolulu'`);
  await db.query(`alter database "${name}" set work_mem to '64MB'`);
  await db.query(`alter database "${name}" set jit to off`);
  const adminSettings=await db.rows<{name:string;setting:string}>("select name,setting from pg_settings where name in ('TimeZone','work_mem','jit')");
  expect(adminSettings).toEqual(expect.arrayContaining([{name:'TimeZone',setting:'Pacific/Honolulu'},{name:'work_mem',setting:'65536'},{name:'jit',setting:'off'}]));
  let productSettings:unknown, fixtureSettings:unknown, productLocale:unknown;
  const r=await run({checkout,databaseUrl:db.url},{rows:40,afterCreate:async({admin,name:generated}:{admin:{query:(sql:string)=>Promise<unknown>};name:string})=>{await admin.query(`alter database "${generated}" set work_mem to '4MB'`); await admin.query(`alter database "${generated}" set jit to on`);},afterFixture:async({name:generated,client}:{name:string;client:{query:(sql:string)=>Promise<{rows:unknown[]}>}})=>{
   const sql="select name,setting,unit from pg_settings where name in ('shared_buffers','work_mem','jit','max_parallel_workers_per_gather','effective_cache_size','random_page_cost','seq_page_cost','parallel_setup_cost','parallel_tuple_cost','min_parallel_table_scan_size','min_parallel_index_scan_size','max_parallel_workers','max_worker_processes','server_encoding','TimeZone','lock_timeout','statement_timeout') order by name";
   fixtureSettings=(await client.query(sql)).rows;
   const url=new URL(db.url); url.pathname='/'+generated; url.username='brain_app'; url.password='query-perf-only';
   const pool=createPool({databaseUrl:url.toString(),queryTimeoutMs:0,lockTimeoutMs:0});
   try {productSettings=(await pool.query(sql)).rows; productLocale=(await pool.query('select datlocprovider as provider, datlocale as locale, datcollversion as version, datcollate as collate, datctype as ctype from pg_database where datname=current_database()')).rows[0];} finally {await pool.end();}
   const times=await client.query("select to_char(from_at at time zone 'UTC','YYYY-MM-DD HH24:MI:SS') as utc from brain.chunks order by from_at limit 1");
   expect(times.rows).toEqual([{utc:'2026-01-01 00:00:01'}]);
  }});
  expect(r.environment.settings).toEqual(productSettings); expect(fixtureSettings).toEqual(productSettings); expect(r.environment.locale).toEqual(productLocale);
  expect(r.environment.settings).toEqual(expect.arrayContaining([{name:'TimeZone',setting:'UTC',unit:null},{name:'lock_timeout',setting:'0',unit:'ms'},{name:'statement_timeout',setting:'0',unit:'ms'}]));
  expect(r.environment.settings).toEqual(expect.arrayContaining([{name:'work_mem',setting:'4096',unit:'kB'},{name:'jit',setting:'on',unit:null}]));
 } finally {await db.drop();}
},120000);


it('retains synthetic expected and actual order on oracle, store, core and auxiliary failures',async()=>{
 const db=await createIsolatedTestDatabase();
 type Client = {query:(sql:string)=>Promise<unknown>};
 try {
  const scenarios=[
   {label:'fixed oracle',options:{afterFixture:async({client}:{client:Client})=>{await client.query("update brain.chunks set body='mismatch' where id=(select id from brain.chunks order by from_at desc limit 1)");}}},
   {label:'store oracle',options:{beforeStore:async({client,kind,condition}:{client:Client;kind:string;condition:string})=>{if(kind==='chunks' && condition==='common') await client.query("update brain.chunks set body='mismatch' where id=(select id from brain.chunks order by from_at desc limit 1)");}}},
   {label:'core oracle',options:{beforeCore:async({client,kind,condition}:{client:Client;kind:string;condition:string})=>{if(kind==='chunks' && condition==='common') await client.query("update brain.chunks set body='mismatch' where id=(select id from brain.chunks order by from_at desc limit 1)");}}},
   {label:'auxiliary fixed oracle',options:{beforeAuxiliary:async({client}:{client:Client})=>{await client.query("update brain.chunks set body='mismatch' where id=md5('aux-chunk2')::uuid");}}},
  ];
  for(const scenario of scenarios) {
   try { await run({checkout,databaseUrl:db.url},{rows:40,...scenario.options}); throw Error('expected mismatch'); }
   catch(error) {
    const failure=error as Failure & {evidence:{mismatch:{label:string;expectedIds:string[];actualIds:string[];expectedHash:string;actualHash:string;firstDifference:string}}};
    expect(failure.evidence.mismatch.label).toContain(scenario.label);
    expect(failure.evidence.mismatch.expectedIds).not.toEqual(failure.evidence.mismatch.actualIds);
    expect(failure.evidence.mismatch.expectedHash).toMatch(/^[a-f0-9]{64}$/);
    expect(failure.evidence.mismatch.actualHash).toMatch(/^[a-f0-9]{64}$/);
    expect(failure.evidence.mismatch.firstDifference).toBeTruthy();
    expect(failure.resources).toMatchObject({created:true,deleted:true});
   }
  }
 } finally {await db.drop();}
},120000);

it('fingerprints a changed synthetic session field before sampling',async()=>{
 const db=await createIsolatedTestDatabase();
 try {
  const original=await run({checkout,databaseUrl:db.url},{rows:40});
  const changed=await run({checkout,databaseUrl:db.url},{rows:40,beforeFingerprint:async({client}:{client:{query:(sql:string)=>Promise<unknown>}})=>{await client.query("update brain.sessions set ended_at='2026-01-02T00:00:00Z' where harness_session_id='chunk-0'");}});
  expect(changed.fixture.sha256).not.toBe(original.fixture.sha256);
 } finally {await db.drop();}
},120000);


it('cleans the cost diagnostic database after a setup failure and preserves ownership evidence',async()=>{
 const target='cost';
 const db=await createIsolatedTestDatabase();
 try {
  try {await run({checkout,databaseUrl:db.url},{rows:40,onDiagnostic:async({label}:{label:string})=>{if(label===target) throw Error('synthetic diagnostic failure');}}); throw Error('expected failure');}
  catch(e) {const failure=e as Failure & {evidence:{diagnosticResources:{label:string;created:boolean;deleted:boolean}[]}}; expect(failure.evidence.diagnosticResources).toMatchObject([{label:'cost',created:true,deleted:true}]); expect(failure.resources).toMatchObject({created:true,deleted:true});}
 } finally {await db.drop();}
},120000);

it('retains cost asynchronous socket error, partial evidence and cleanup',async()=>{
 const target='cost', sentinel='synthetic_t60_unique_password_79f31', injectedUrl=`postgres://user:${sentinel}@host/db`;
 const db=await createIsolatedTestDatabase();
 try {
  try {
   await run({checkout,databaseUrl:db.url},{rows:40,onDiagnostic:({label,client}:{label:string;client:{emit:(event:string,error:Error)=>void}})=>{if(label===target) client.emit('error',Object.assign(new Error(`synthetic socket ${injectedUrl}`),{code:'ECONNRESET'}));}});
   throw Error('expected socket failure');
  } catch(e) {
   const failure=e as Failure & {evidence:{diagnostic:{stage:string;cost:{write:{samplesMs:number[]};statisticsAfter:unknown};resources:{created:boolean;deleted:boolean}[]};errors:{code?:string;message:string}[]}};
   expect(failure.resources).toMatchObject({created:true,deleted:true});
   expect(failure.evidence.diagnostic.resources.every(x=>x.created && x.deleted)).toBe(true);
   expect(failure.evidence.errors.some(x=>x.code==='ECONNRESET')).toBe(true);
   expect(JSON.stringify(failure.evidence)).not.toContain(sentinel);
   expect(JSON.stringify(failure.evidence)).not.toContain(injectedUrl);
   expect(failure.evidence.errors.some(x=>x.code==='ECONNRESET' && x.message.includes('[database-url]'))).toBe(true);
  }
 } finally {await db.drop();}
},120000);

it('retains completed write samples and cleanup when cost ANALYZE fails',async()=>{
 const db=await createIsolatedTestDatabase();
 try {try {await run({checkout,databaseUrl:db.url},{rows:40,onDiagnostic:({label,client}:{label:string;client:{query:(...args:any[])=>Promise<any>}})=>{
  if(label==='cost') {const original=client.query.bind(client); client.query=(...args:any[])=>args[0]==='analyze brain.chunks'?Promise.reject(Object.assign(new Error('synthetic analyze'),{code:'57014'})):original(...args);}
 }});throw Error('expected analyze failure');} catch(e) {
  const failure=e as Failure & {evidence:{diagnostic:{stage:string;cost:{write:{samplesMs:number[]}};resources:{created:boolean;deleted:boolean}[]};errors:{code?:string}[]}};
  expect(failure.evidence.errors.some(x=>x.code==='57014')).toBe(true);expect(failure.evidence.diagnostic.stage).toBe('cost:analyze:warmup');expect(failure.evidence.diagnostic.cost.write.samplesMs).toHaveLength(3);
  expect(failure.evidence.diagnostic.resources.every(x=>x.created && x.deleted)).toBe(true);expect(failure.resources).toMatchObject({created:true,deleted:true});
 }} finally {await db.drop();}
},120000);

it('observes real app login and role-specific settings on the search connection',async()=>{
 const db=await createIsolatedTestDatabase();
 try {
  let adminWorkMem:unknown;
  const r=await run({checkout,databaseUrl:db.url},{rows:40,beforeAppConnect:async({admin,name}:{admin:{query:(sql:string)=>Promise<unknown>};name:string})=>{await admin.query(`alter role brain_app in database "${name}" set work_mem='8MB'`);},afterFixture:async({client}:{client:{query:(sql:string)=>Promise<{rows:unknown[]}>}})=>{adminWorkMem=(await client.query("select setting from pg_settings where name='work_mem'")).rows;}});
  expect(r.environment.role).toEqual({current_user:'brain_app',session_user:'brain_app'});
  expect(r.environment.settings).toContainEqual({name:'work_mem',setting:'8192',unit:'kB'});
  expect(adminWorkMem).not.toEqual([{setting:'8192'}]);
  expect(r.runs.every((x:{oracleMatch:boolean})=>x.oracleMatch)).toBe(true);
 } finally {await db.drop();}
},120000);

it('cleans the main database and records failure when the app pool cannot connect',async()=>{
 const db=await createIsolatedTestDatabase();
 try {try {await run({checkout,databaseUrl:db.url},{rows:40,beforeAppConnect:()=>{throw Object.assign(Error('synthetic app connect failure'),{code:'28P01'});}}); throw Error('expected app failure');}
  catch(e){const failure=e as Failure & {evidence:{stage:string;errors:{code?:string}[]}};expect(failure.resources).toMatchObject({created:true,deleted:true});expect(failure.evidence.stage).toBe('app-connect');expect(failure.evidence.errors.some(x=>x.code==='28P01')).toBe(true);}
 } finally {await db.drop();}
},120000);


it('waits for app client termination before dropping the database and preserves socket errors',async()=>{
 const db=await createIsolatedTestDatabase();
 let releaseApp!:()=>void, observedApp!:()=>void, observedPool!:()=>void;
 let releaseFixture!:()=>void, observedFixture!:()=>void;
 const appGate=new Promise<void>(resolve=>{releaseApp=resolve;});
 const appObserved=new Promise<void>(resolve=>{observedApp=resolve;});
 const poolObserved=new Promise<void>(resolve=>{observedPool=resolve;});
 const fixtureGate=new Promise<void>(resolve=>{releaseFixture=resolve;});
 const fixtureObserved=new Promise<void>(resolve=>{observedFixture=resolve;});
 let appDelivered=false,dropStarted=false;
 let fixtureClient:any,originalFixtureEnd:any,appClient:any,originalEmit:any,appPool:any,originalPoolEnd:any;
 let fixtureClose:Promise<void>|undefined;
 let running:Promise<{value?:unknown;error?:Failure}>|undefined;
 try {
  const current:Promise<{value?:unknown;error?:Failure}>=run({checkout,databaseUrl:db.url},{rows:40,
   beforeAppConnect:({appPool:pool}:{appPool:any})=>{
    appPool=pool; originalPoolEnd=pool.end;
    pool.end=function(...args:unknown[]) {
     return originalPoolEnd.apply(this,args).then((value:unknown)=>{observedPool(); return value;});
    };
    pool.on('connect',(client:any)=>{
     appClient=client; originalEmit=client.emit;
     client.emit=function(event:string,...args:unknown[]) {
      if(event!=='end') return originalEmit.call(this,event,...args);
      client.emit=originalEmit; observedApp();
      void appGate.then(()=>{appDelivered=true; originalEmit.call(client,event,...args);});
      return true;
     };
    });
   },
   afterFixture:({client}:{client:any})=>{
    fixtureClient=client; originalFixtureEnd=client.end;
    client.end=function(...args:unknown[]) {
     if(!fixtureClose) fixtureClose=Promise.resolve(originalFixtureEnd.apply(this,args)).then(()=>{observedFixture(); return fixtureGate;});
     return fixtureClose;
    };
    client.emit('error',Object.assign(Error('synthetic observed socket'),{code:'ECONNRESET'}));
   },
   beforeDrop:()=>{dropStarted=true; expect(appDelivered).toBe(true);},
  }).then((value:unknown)=>({value}), (error:Failure)=>({error}));
  running=current;
  const until=async(gate:Promise<void>)=>{expect(await Promise.race([gate.then(()=> 'gate'),current.then(()=> 'finished')])).toBe('gate');};
  await until(appObserved); await until(poolObserved);
  // Close the actual fixture connection independently, then release its return
  // gate. An implementation waiting only for pool.end can now reach DROP.
  const fixtureResult:Promise<void>=fixtureClient.end();
  await Promise.race([until(fixtureObserved),fixtureResult.then(()=>{throw Error('fixture gate released early');})]);
  releaseFixture();
  await new Promise<void>(resolve=>setImmediate(resolve));
  expect(dropStarted).toBe(false);
  releaseApp();
  const result=await current;
  expect(result.error).toBeDefined();
  expect(result.error!.errors.some(e=>e.code==='ECONNRESET' && e.message.includes('synthetic observed socket'))).toBe(true);
  expect(result.error!.resources).toMatchObject({created:true,deleted:true});
  expect(dropStarted).toBe(true);
 } finally {
  releaseFixture(); releaseApp(); if(running) await running;
  if(appClient && originalEmit) appClient.emit=originalEmit;
  if(appPool && originalPoolEnd) appPool.end=originalPoolEnd;
  if(fixtureClient && originalFixtureEnd) fixtureClient.end=originalFixtureEnd;
  await db.drop();
 }
},120000);

it('reports a bounded app client termination failure and still drops the owned database',async()=>{
 const db=await createIsolatedTestDatabase(); let releaseEnd:(()=>void)|undefined;
 try {
  const result=await run({checkout,databaseUrl:db.url},{rows:40,
   beforeAppConnect:({appPool}:{appPool:{on:(event:string,cb:(client:any)=>void)=>void}})=>{
    appPool.on('connect',client=>{
     const emit=client.emit;
     client.emit=function(event:string,...args:unknown[]) {
      if(event!=='end') return emit.call(this,event,...args);
      client.emit=emit; releaseEnd=()=>{releaseEnd=undefined; emit.call(client,event,...args);}; return true;
     };
    });
   },
   beforeDrop:()=>{releaseEnd?.();},
  }).then((value:unknown)=>({value}),(error:Failure)=>({error}));
  expect(result.error).toBeDefined();
  expect(result.error!.errors.some((e:Error)=>e.message.includes('app pool termination timed out'))).toBe(true);
  expect(result.error!.resources).toMatchObject({created:true,deleted:true});
 } finally {releaseEnd?.(); await db.drop();}
},120000);
