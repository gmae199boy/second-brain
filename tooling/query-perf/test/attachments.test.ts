import { describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { createIsolatedTestDatabase } from '../../test-db/src/index.js';
// @ts-expect-error JavaScript runner has no declarations.
import { fixtureSpec, makeAttachments, run, traceQueries, withFixtureReplica } from '../src/attachments.mjs';
// @ts-expect-error JavaScript fixture has no declarations.
import { message } from '../src/attachment-fixture.mjs';
// @ts-expect-error JavaScript helpers have no declarations.
import { compare, hash, parseArgs } from '../src/core.mjs';

const sample=(ratio=1)=>({scenario:'write-attachments',fixture:fixtureSpec,fixtureHash:hash(fixtureSpec),
 checkoutRevision:{sha:'9a9c8d60bc8052851220b9869a737b11aa257f1b',dirty:false,diffSha256:'b'.repeat(64)},
 artifacts:{sha256:'c'.repeat(64),lockSha256:'d'.repeat(64),functionSha256:'e'.repeat(64),runner:{sha256:'f'.repeat(64)}},
 environment:{measurementRole:'brain_app',replicationRole:'origin',node:'node',postgres:'pg',platform:'test',arch:'x',cpus:1,pid:1,processesStart:'1 init',processesEnd:'1 init',loadAverageStart:[0,0,0],loadAverageEnd:[0,0,0]},
 startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:01Z',resources:{database:'qp_'+ '1'.repeat(20),created:true,deleted:true},
 runs:[1,10,100,1000].flatMap(size=>['new','existing','missing'].map(condition=>{
  const input=makeAttachments(size,condition) as Array<{id:string;ordinal:number;sourceKind:string;sourceRef:string;displayName:string;file:null|{id:string;contentHash:string;sizeBytes:number;location:{id:string;storeKind:string;locator:string;ownership:string};external:{id:string;storeKind:string;locator:string;ownership:string}}}>;
  const raw=(text:string)=>text.includes('\u0000')?Buffer.from(text,'utf8').toJSON():null;
  const rows={files:input.flatMap(a=>a.file?[{id:a.file.id,content_hash:a.file.contentHash,size_bytes:a.file.sizeBytes,first_seen_at:'2026-01-01T00:00:00.000Z',home_location_id:a.file.location.id,current_extraction_id:null,redacted_at:null,source_unreachable_at:null}]:[]),
   file_locations:input.flatMap(a=>a.file?[a.file.location,a.file.external].map(l=>({id:l.id,file_id:a.file!.id,store_kind:l.storeKind,locator:l.locator,ownership:l.ownership,first_seen_at:'2026-01-01T00:00:00.000Z',source_modified_at:null,uploaded_at:null,remote_checksum:null,verified_at:null,deleted_at:null})):[]),
   message_attachments:input.map(a=>({id:a.id,message_id:message,ordinal:a.ordinal,source_kind:a.sourceKind,source_ref:a.sourceRef.replaceAll('\u0000','\ufffd'),source_ref_raw:raw(a.sourceRef),display_name:a.displayName.replaceAll('\u0000','\ufffd'),display_name_raw:raw(a.displayName),file_id:a.file?.id??null,status:a.file?'stored':'missing_at_ingest'}))};
  return {size,condition,inputHash:hash(makeAttachments(size,condition)),rows,rowsHash:hash(rows),linked:condition==='existing'?0:size,replayUnchanged:true,
   samplesMs:[100*ratio,100*ratio,100*ratio],medianMs:100*ratio,sqlCounts:[100*ratio,100*ratio,100*ratio],explain:[{Plan:{'Actual Total Time':1,'Shared Hit Blocks':1}}],explainState:{stage:'before-write',rowCounts:{message_attachments:condition==='existing'?size:0,files:condition==='existing'?size:0,file_locations:condition==='existing'?size*2:0}}};
 }))});

describe('attachment comparison',()=>{
 it('accepts exact half at 1000 and 110 percent at small sizes',()=>{
  const change=sample(0.5); for(const r of change.runs) if(r.size<=10) {r.samplesMs=[110,110,110];r.medianMs=110;}
  expect(compare(sample(),change).pass).toBe(true);
 });
 it.each([1,10].flatMap(size=>['new','existing','missing'].map(condition=>[size,condition] as const)))('rejects 111 percent for %s/%s only', (size,condition)=>{
  const change=sample(0.5), row=change.runs.find(r=>r.size===size&&r.condition===condition)!;
  row.samplesMs=[111,111,111]; row.medianMs=111;
  const result=compare(sample(),change); expect(result.pass).toBe(false);
  expect(result.rows.find((r:{condition:string})=>r.condition===`${size}/${condition}`)).toMatchObject({pass:false});
  expect(result.rows.filter((r:{condition:string})=>r.condition!==`${size}/${condition}`).every((r:{pass:boolean})=>r.pass)).toBe(true);
 });
 it('rejects time, SQL and complete row differences',()=>{
  const slow=sample(0.5); slow.runs[9]!.medianMs=51; slow.runs[9]!.samplesMs=[51,51,51]; expect(compare(sample(),slow).pass).toBe(false);
  const queries=sample(0.5); queries.runs[9]!.sqlCounts=[50,50,51]; expect(compare(sample(),queries).pass).toBe(false);
  const changed=sample(0.5); (changed.runs[0]!.rows.message_attachments[0] as object & {extra?:string}).extra='different'; changed.runs[0]!.rowsHash=hash(changed.runs[0]!.rows); expect(compare(sample(),changed).pass).toBe(false);
 });
 it.each(['source_ref_raw','file_id','message_id'] as const)('rejects the same missing %s in both results', field=>{
  const base=sample(), change=sample(0.5);
  for(const value of [base,change]) { delete (value.runs[0]!.rows.message_attachments[0] as Partial<typeof value.runs[0]['rows']['message_attachments'][0]>)[field]; value.runs[0]!.rowsHash=hash(value.runs[0]!.rows); }
  expect(()=>compare(base,change)).toThrow();
 });
 it('rejects missing file and location fields or broken references on both sides',()=>{
  for(const kind of ['file','location','reference']) {
   const base=sample(),change=sample(0.5);
   for(const v of [base,change]) {const rows=v.runs[0]!.rows;
    if(kind==='file') delete (rows.files[0] as Partial<typeof rows.files[0]>).content_hash;
    if(kind==='location') delete (rows.file_locations[0] as Partial<typeof rows.file_locations[0]>).ownership;
    if(kind==='reference') rows.file_locations[0]!.file_id='00000000-0000-0000-0000-000000000000';
    v.runs[0]!.rowsHash=hash(rows);
   } expect(()=>compare(base,change)).toThrow();
  }
 });
 it('rejects wrong diagnostic state or measurement identity',()=>{
  const wrong=sample(); wrong.runs[0]!.explainState.rowCounts.message_attachments=1; expect(()=>compare(sample(),wrong)).toThrow();
  const role=sample(); role.environment.measurementRole='postgres'; expect(()=>compare(sample(),role)).toThrow();
 });
 it.each(['new','existing','missing'])('rejects 1000/%s time or SQL above half', condition=>{
  for(const metric of ['time','sql']) {const change=sample(0.5), r=change.runs.find(v=>v.size===1000&&v.condition===condition)!;
   if(metric==='time') {r.samplesMs=[51,51,51];r.medianMs=51;} else r.sqlCounts=[50,51,50];
   const result=compare(sample(),change); expect(result.pass).toBe(false); expect(result.rows.find((v:{condition:string})=>v.condition===`1000/${condition}`).pass).toBe(false);
   expect(result.rows.filter((v:{condition:string})=>v.condition!==`1000/${condition}`).every((v:{pass:boolean})=>v.pass)).toBe(true);
  }
 });
 it('rejects missing, duplicate, corrupt measurements and wrong provenance',()=>{
  const missing=sample(); missing.runs.pop(); expect(()=>compare(sample(),missing)).toThrow();
  const duplicate=sample(); duplicate.runs.push(duplicate.runs[0]!); expect(()=>compare(sample(),duplicate)).toThrow();
  const invalid=sample(); invalid.runs[0]!.medianMs=1; expect(()=>compare(sample(),invalid)).toThrow();
  const sql=sample(); sql.runs[0]!.sqlCounts=[0,1,1]; expect(()=>compare(sample(),sql)).toThrow();
  const replay=sample(); replay.runs[0]!.replayUnchanged=false; expect(()=>compare(sample(),replay)).toThrow();
  const runner=sample(); runner.artifacts.runner.sha256='1'.repeat(64); expect(()=>compare(sample(),runner)).toThrow();
  const revision=sample(); revision.checkoutRevision.sha='1'.repeat(40); expect(()=>compare(revision,sample())).toThrow();
  const estimate=sample(); estimate.runs[0]!.explain=[{Plan:{} as {'Actual Total Time':number;'Shared Hit Blocks':number}}]; expect(()=>compare(sample(),estimate)).toThrow();
  const notClean=sample(); notClean.resources.deleted=false; expect(()=>compare(sample(),notClean)).toThrow();
 });
 it('parses only the required CLI arguments',()=>{
  const args=['write-attachments','--checkout','.','--database-url','postgres://localhost/x','--out','x'];
  expect(parseArgs(args)).toMatchObject({command:'write-attachments'}); expect(()=>parseArgs([...args,'--out','y'])).toThrow(); expect(()=>parseArgs(args.slice(0,-2))).toThrow();
 });
});
it('traces only action queries and restores instrumentation on failure',async()=>{
 class Fake { query(_q:string) {return Promise.resolve('ok');} }
 const original=Fake.prototype.query, times=[10,20], instance=new Fake();
 const result=await traceQueries(Fake,async()=>{await instance.query('select 1');return 3;},()=>times.shift());
 expect(result).toMatchObject({result:3,elapsedMs:10,queries:[{text:'select 1'}]}); expect(Fake.prototype.query).toBe(original);
 await expect(traceQueries(Fake,async()=>{throw Error('failure');})).rejects.toThrow('failure'); expect(Fake.prototype.query).toBe(original);
 const spy=vi.spyOn(instance,'query'); await instance.query('after'); expect(spy).toHaveBeenCalledOnce(); spy.mockRestore();
});
it('runs actual built function against isolated database and cleans up on injected failure',async()=>{
 const fixture=await createIsolatedTestDatabase(), checkout=resolve(import.meta.dirname,'../../..');
 try {
  const result=await run({checkout,databaseUrl:fixture.url},{sizes:[1,10],afterFixture:async ({client}:{client:{query:(q:string)=>Promise<{rows:{session_replication_role:string}[]}>}})=>{expect((await client.query('show session_replication_role')).rows[0]?.session_replication_role).toBe('origin');}});
  expect(result.environment).toMatchObject({measurementRole:'brain_app',replicationRole:'origin'});
  for(const r of result.runs) expect(r.explainState).toEqual({stage:'before-write',rowCounts:{message_attachments:r.condition==='existing'?r.size:0,files:r.condition==='existing'?r.size:0,file_locations:r.condition==='existing'?r.size*2:0}});
  expect(result.runs).toHaveLength(6); expect(result.runs.every((r:{samplesMs:number[];sqlCounts:number[];replayUnchanged:boolean})=>r.samplesMs.length===3&&r.sqlCounts.length===3&&r.replayUnchanged)).toBe(true);
  expect(result.runs.every((r:{explain:{Plan:Record<string,number>}[]})=>Number.isFinite(r.explain[0]?.Plan['Actual Total Time'])&&Number.isFinite(r.explain[0]?.Plan['Shared Hit Blocks']))).toBe(true);
  expect(result.resources).toMatchObject({created:true,deleted:true});
  await expect(run({checkout,databaseUrl:fixture.url},{sizes:[1],afterFixture:()=>{throw Error('injected');}})).rejects.toMatchObject({resources:{created:true,deleted:true},message:expect.stringContaining('injected')});
 } finally {await fixture.drop();}
},120000);

it('sanitizes refused database connection and reports resource state',async()=>{
 try {
  await run({checkout:resolve(import.meta.dirname,'../../..'),databaseUrl:'postgres://user:secret@127.0.0.1:1/postgres'},{sizes:[1]});
  throw Error('expected connection failure');
 } catch(error) {
  const failure=error as Error & {resources:{created:boolean;deleted:boolean};errors:(Error & {code?:string})[]};
  expect(failure.resources).toMatchObject({created:false,deleted:false});
  expect(failure.errors.some(e=>e.code==='ECONNREFUSED')).toBe(true); expect(failure.message).not.toContain('secret');
 }
});

it('restores origin on fixture reset failure',async()=>{
 const statements:string[]=[];
 const client={query:async (q:string)=>{statements.push(q);}};
 await expect(withFixtureReplica(client,async()=>{throw Error('reset failed');})).rejects.toThrow('reset failed');
 expect(statements).toEqual(['set session_replication_role=replica','set session_replication_role=origin']);
});
it('reports deletion and original failures, closes the fixture connection, and leaves only the named owned DB',async()=>{
 const fixture=await createIsolatedTestDatabase(), checkout=resolve(import.meta.dirname,'../../..');
 let remaining='', observedClient:{query:(q:string)=>Promise<unknown>}|undefined;
 try {
  try {
   await run({checkout,databaseUrl:fixture.url},{sizes:[1],afterFixture:({client}:{client:typeof observedClient})=>{observedClient=client; throw Error('injected work failure');},beforeDrop:({name}:{name:string})=>{remaining=name; throw Error('injected drop failure');}});
   throw Error('expected failure');
  } catch(error) {
   const failure=error as Error & {resources:{database:string;created:boolean;deleted:boolean};errors:Error[]};
   expect(failure.resources).toEqual({database:remaining,created:true,deleted:false}); expect(remaining).toMatch(/^qp_[a-f0-9]{20}$/);
   expect(failure.message).toContain(remaining); expect(failure.errors.map(e=>e.message)).toEqual(expect.arrayContaining([expect.stringContaining('injected work failure'),expect.stringContaining('injected drop failure')]));
   expect(await fixture.rows(`select datname from pg_database where datname='${remaining}'`)).toEqual([{datname:remaining}]);
   expect(observedClient).toBeDefined(); await expect(observedClient!.query('select 1')).rejects.toThrow();
  }
 } finally {if(remaining) await fixture.query(`drop database "${remaining}" with (force)`); await fixture.drop();}
},120000);
it('cancels an advisory lock wait and drops its owned database',async()=>{
 const fixture=await createIsolatedTestDatabase(), checkout=resolve(import.meta.dirname,'../../..');
 try {
  try {
   await run({checkout,databaseUrl:fixture.url},{sizes:[1],timeoutMs:100,afterFixture:async ({client}:{client:{query:(q:string)=>Promise<unknown>}})=>{
    await client.query('begin'); await client.query("select pg_advisory_xact_lock(hashtextextended('synthetic:attachment', 0))");
   }});
   throw Error('expected statement timeout');
  } catch(error) {
   const failure=error as Error & {resources:{database:string;created:boolean;deleted:boolean};errors:(Error & {code?:string})[]};
   expect(failure.errors.some(e=>e.code==='57014')).toBe(true); expect(failure.resources).toMatchObject({created:true,deleted:true});
   expect(await fixture.rows(`select datname from pg_database where datname='${failure.resources.database}'`)).toEqual([]);
  }
 } finally {await fixture.drop();}
},120000);
it('cleans up after measurement pool connection failure',async()=>{
 const fixture=await createIsolatedTestDatabase(), checkout=resolve(import.meta.dirname,'../../..');
 try {
  try {
   await run({checkout,databaseUrl:fixture.url},{sizes:[1],poolConnectionString:'postgres://user:secret@127.0.0.1:1/postgres'});
   throw Error('expected pool failure');
  } catch(error) {
   const failure=error as Error & {resources:{created:boolean;deleted:boolean};errors:(Error & {code?:string})[]};
   expect(failure.resources).toMatchObject({created:true,deleted:true}); expect(failure.errors.some(e=>e.code==='ECONNREFUSED')).toBe(true); expect(failure.message).not.toContain('secret');
  }
 } finally {await fixture.drop();}
},120000);

it('traces only the action inside a real transaction with surrounding sentinels',async()=>{
 const fixture=await createIsolatedTestDatabase(), checkout=resolve(import.meta.dirname,'../../..');
 const {Client}=createRequire(resolve(checkout,'packages/postgres/package.json'))('pg');
 const client=new Client({connectionString:fixture.url,connectionTimeoutMillis:10000,query_timeout:120000});
 try {
  await client.connect(); await client.query('select 101 as sentinel_before'); await client.query('begin');
  await client.query("select pg_advisory_xact_lock(hashtextextended('trace-boundary',0))");
  const traced=await traceQueries(Client,async()=>{await client.query('select 1 as inside_first'); await client.query('select 2 as inside_second');});
  await client.query('commit'); await client.query('select 102 as sentinel_after');
  expect(traced.queries.map((q:{text:string})=>q.text)).toEqual(['select 1 as inside_first','select 2 as inside_second']);
 } finally {await client.end(); await fixture.drop();}
},120000);
