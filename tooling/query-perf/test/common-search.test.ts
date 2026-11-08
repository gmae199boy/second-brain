import { describe, expect, it, vi } from 'vitest';
import { copyFile, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
// @ts-expect-error JavaScript helper has no declarations.
import { expectedSchema, inspectMigrationDirectory } from '../src/common-search-schema.mjs';
// @ts-expect-error JavaScript CLI has no declarations.
import { main } from '../run.mjs';
// @ts-expect-error JavaScript performance helper has no declarations.
import { compare as rawCompare, parseArgs } from '../src/core.mjs';
// @ts-expect-error JavaScript runner has no declarations.
import { assertEvidence, assertFixtureConfig, sampleThree, trace } from '../src/common-search.mjs';
// @ts-expect-error JavaScript protocol helper has no declarations.
import { prepareProtocol, pendingSupport } from '../src/common-search-protocol.mjs';

const digest = (v: string) => v.repeat(64);
const metric = (n: number) => ({samplesMs:[n-1,n,n+1],medianMs:n});
let tick=0;
const time = () => { const startedAt=new Date(Date.UTC(2026,0,1,0,0,tick++)).toISOString(); return {startedAt,finishedAt:new Date(Date.UTC(2026,0,1,0,0,tick++)).toISOString()}; };
const plan = () => [{Plan:{'Plan Rows':6,'Actual Rows':6,'Actual Total Time':1,'Shared Hit Blocks':2,'Shared Read Blocks':0,'Shared Dirtied Blocks':0,'Shared Written Blocks':0},'Execution Time':1}];
const t0={startedAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-01T00:00:00.000Z',ms:1};
const tc={startedAt:'2026-01-01T00:02:59.500Z',finishedAt:'2026-01-01T00:02:59.500Z',ms:1};
const plus=(iso:string,ms:number)=>new Date(Date.parse(iso)+ms).toISOString();
const targets=['sessions','messages','chunks','tool_notes'];
const gin=()=>[{name:'brain.chunks_body_idx',relname:'chunks_body_idx',table_name:'chunks',reloptions:null},{name:'brain.tool_notes_target_idx',relname:'tool_notes_target_idx',table_name:'tool_notes',reloptions:null}];
const autoNames=['autovacuum','autovacuum_analyze_scale_factor','autovacuum_vacuum_scale_factor','autovacuum_naptime','TimeZone','lock_timeout','statement_timeout'];
const appNames=['shared_buffers','work_mem','jit','max_parallel_workers_per_gather','effective_cache_size','random_page_cost','seq_page_cost','parallel_setup_cost','parallel_tuple_cost','min_parallel_table_scan_size','min_parallel_index_scan_size','max_parallel_workers','max_worker_processes','server_encoding','TimeZone','lock_timeout','statement_timeout'];
const autoSettings=autoNames.map(name=>({name,setting:name==='TimeZone'?'UTC':name.endsWith('timeout')?'0':'1',unit:null}));
const snapshotState=(at:string)=>({at,finishedAt:plus(at,1),tables:targets.map(relname=>({relname,count:relname==='sessions'?21:100000,reloptions:null})),indexes:gin(),settings:structuredClone(autoSettings)});
const prep=(when=t0.startedAt)=>({protocolVersion:2,targets:['sessions','messages','chunks','tool_notes'],command:'VACUUM (ANALYZE)',transaction:'outside',timezone:'UTC',lockTimeout:'0',statementTimeout:'0',readinessCriterion:'vacuum-success-counts-unchanged-pending-zero-if-supported',stage:'complete',support:{supported:false,reason:'0A000'},pre:snapshotState(when),post:snapshotState(plus(when,6)),vacuum:targets.map((table,i)=>({...t0,startedAt:plus(when,2+i),finishedAt:plus(when,2+i),table,success:true})),ready:true});
const instant=(offset:number)=>({...tc,startedAt:plus(tc.startedAt,offset),finishedAt:plus(tc.startedAt,offset)});
const costMetric=(offset:number)=>({warmup:instant(offset),samplesMs:[1,2,3],medianMs:2,samples:[{...instant(offset+10),ms:1},{...instant(offset+20),ms:2},{...instant(offset+30),ms:3}]});
const appRole={current_user:'brain_app',session_user:'brain_app'};
const appSettings=appNames.map(name=>({name,setting:name==='TimeZone'?'UTC':name.endsWith('timeout')?'0':name==='work_mem'?'4096':'1',unit:null})),appLocale={provider:'i',locale:'tr-TR',version:'153.1',collate:'C',ctype:'C'};
const stats=()=>({stage:'complete',definitions:[],distributions:[],bytesKind:'catalog logical tuple bytes; not physical index size'});
const diagnostics=(version:number)=>({startedAt:tc.startedAt,finishedAt:plus(tc.startedAt,260),resources:[{label:'cost',database:'qp_'+ '1'.repeat(20),startedAt:plus(tc.startedAt,50),finishedAt:plus(tc.startedAt,250),created:true,deleted:true}],cost:{setup:{preparation:prep(plus(tc.startedAt,100)),migration:{to:version},schema:expectedSchema(version)},statisticsBefore:stats(),statisticsAfter:stats(),write:{...costMetric(120),sqlCount:5,rowsPerTable:1000,triggerMode:'origin',before:{chunks:100000,messages:100000,tool_notes:100000},after:{chunks:100000,messages:100000,tool_notes:100000},hash:digest('1'),afterHash:digest('1')},analyze:{...costMetric(170),targets:[...targets],sqlCount:4,pre:snapshotState(plus(tc.startedAt,160)),post:snapshotState(plus(tc.startedAt,210))}}});
const fixture = (n=100, version:39|40|41|42=39) => { tick=1; return ({
 scenario:'common-search',status:'ok',migration:{...t0,value:{to:version},schema:expectedSchema(version)},preparation:prep(),statistics:stats(),diagnostic:diagnostics(version),fixture:{rows:100000,bodyBytes:1024,chunkSessions:20,toolSessions:1,limit:5,recipeVersion:2,fields:{sessions:['id']},sha256:digest('a')},
 checkoutRevision:{sha:'d6a0b4b614daa1c321c735a2ca09aab27d78e193',dirty:false,diffSha256:digest('b')},
 artifacts:{sha256:digest('c'),lockSha256:digest('d'),runner:{sha256:digest('e')}},
 environment:{role:{...appRole},node:'node24',postgres:'pg18',platform:'darwin',arch:'arm64',cpus:12,hostIdentity:digest('f'),systemIdentifier:'12345',settings:structuredClone(appSettings),locale:structuredClone(appLocale)},
 snapshots:Object.fromEntries(['setupStart','setupEnd','measurementStart','measurementEnd'].map((k,i)=>[k,{at:i===3?'2026-01-01T00:02:59.000Z':i===0?'2026-01-01T00:00:00.000Z':'2026-01-01T00:00:00.050Z',loadAverage:[0,0,0],processes:[]}])),
 startedAt:'2026-01-01T00:00:00.000Z',finishedAt:'2026-01-01T00:03:00.000Z',resources:{database:'qp_fixture',created:true,deleted:true},
 auxiliary:['chunks','tools'].map(kind=>({kind,resultHash:digest('5'),oracleHash:digest('6'),fixedHash:digest('6'),truncated:true,masked:true,hasMore:true,omitted:4,nextVerified:true,metadataVerified:true,jsonSize:4500})),
 runs:['chunks','tools'].flatMap(kind=>['common','a','missing'].map(condition=>({kind,condition,resultHash:digest('1'),storeHash:digest('2'),oracleHash:digest('3'),fixedHash:digest('3'),oracleMatch:true,fixedMatch:true,wall:metric(n),storeWall:metric(n),sqlSamples:Array.from({length:3},()=>({count:1,totalMs:1,spansMs:[1],searchMs:1,spans:[{ms:1,sqlSha256:digest('8'),search:true}]})),explain:plan(),timings:{warmup:time(),wall:[time(),time(),time()],diagnostics:[time(),time(),time()],store:[time(),time(),time()],explain:time()}})))
}); };
const currentFixture = () => fixture(100,42);
const shifted=(r:ReturnType<typeof fixture>)=>JSON.parse(JSON.stringify(structuredClone(r),(_key,value)=>typeof value==='string' && /^2026-01-01T/.test(value)?new Date(Date.parse(value)+300000).toISOString():value));
const compare=(base:ReturnType<typeof fixture>,change:ReturnType<typeof fixture>)=>rawCompare(base,shifted(change));
const setMetric=(r:ReturnType<typeof fixture>, key:string, n:number)=>{r.runs.find(x=>`${x.kind}/${x.condition}`===key)!.wall=metric(n);};

describe('common-search comparison',()=>{
 it('isolates mutable fixture inputs in either creation order',()=>{
  for(const controlFirst of [true,false]) {
   const first=fixture(), second=fixture(), control=controlFirst?first:second, negative=controlFirst?second:first;
   for(const name of ['work_mem','TimeZone','lock_timeout','statement_timeout']) negative.environment.settings.find(row=>row.name===name)!.setting='changed';
   negative.environment.role.current_user='changed'; negative.diagnostic.cost.analyze.targets.pop();
   expect(control.environment.settings.filter(row=>['work_mem','TimeZone','lock_timeout','statement_timeout'].includes(row.name)).map(({name,setting})=>({name,setting}))).toEqual([
    {name:'work_mem',setting:'4096'},{name:'TimeZone',setting:'UTC'},{name:'lock_timeout',setting:'0'},{name:'statement_timeout',setting:'0'},
   ]);
   expect(control.environment.role).toEqual({current_user:'brain_app',session_user:'brain_app'});
   expect(control.diagnostic.cost.analyze.targets).toEqual(['sessions','messages','chunks','tool_notes']);
   const later=currentFixture(); setMetric(later,'chunks/common',50); setMetric(later,'tools/common',50);
   for(const r of [control,later]) for(const p of [r.preparation,r.diagnostic.cost.setup.preparation]) {
    p.support={supported:true,reason:null as unknown as string};
    for(const state of [p.pre,p.post]) for(const index of state.indexes) Object.assign(index,{pending:{pending_pages:0,pending_tuples:'0'}});
   }
   expect(compare(control,later).pass).toBe(true);
  }
 });
 it('accepts exactly 0.5 for both common conditions and 1.0 for short and missing',()=>{
  const b=fixture(), c=currentFixture(); setMetric(c,'chunks/common',50); setMetric(c,'tools/common',50);
  expect(compare(b,c)).toMatchObject({pass:true,rows:expect.arrayContaining([{condition:'chunks/common',ratio:0.5,limit:0.5,equal:true,pass:true},{condition:'tools/a',ratio:1,limit:1,equal:true,pass:true}])});
 });
 it.each(['chunks/common','tools/common','chunks/a','tools/a','chunks/missing','tools/missing'])('rejects any condition above its boundary: %s',key=>{
  const c=currentFixture(); setMetric(c,'chunks/common',50); setMetric(c,'tools/common',50); setMetric(c,key,key.endsWith('/common')?51:101);
  expect(compare(fixture(),c).pass).toBe(false);
 });
 it('rejects missing, duplicate, extra, or mismatched conditions',()=>{
  const missing=currentFixture(); missing.runs.pop(); expect(()=>compare(fixture(),missing)).toThrow();
  const duplicate=currentFixture(); duplicate.runs[5]=structuredClone(duplicate.runs[0]!); expect(()=>compare(fixture(),duplicate)).toThrow();
  const extra=currentFixture(); extra.runs[0]!.condition='other'; expect(()=>compare(fixture(),extra)).toThrow();
  expect(()=>compare(fixture(),{...currentFixture(),scenario:'import-cleanup'})).toThrow();
 });
 it.each(['resultHash','storeHash','oracleHash','fixedHash'] as const)('rejects changed or invalid %s',key=>{
  const c=currentFixture(); c.runs[0]![key]=digest('4');
  if(key==='oracleHash'||key==='fixedHash') expect(()=>compare(fixture(),c)).toThrow(); else expect(compare(fixture(),c).pass).toBe(false);
  c.runs[0]![key]='bad'; expect(()=>compare(fixture(),c)).toThrow();
 });
 it('rejects missing or invalid samples, forged medians, SQL spans, oracle and cleanup',()=>{
  for(const change of [
   (x:ReturnType<typeof fixture>)=>x.runs[0]!.wall.samplesMs.pop(),
   (x:ReturnType<typeof fixture>)=>{x.runs[0]!.wall.medianMs=2;},
   (x:ReturnType<typeof fixture>)=>{x.runs[0]!.wall.samplesMs[0]=0;},
   (x:ReturnType<typeof fixture>)=>{x.runs[0]!.storeWall.samplesMs[0]=NaN;},
   (x:ReturnType<typeof fixture>)=>{x.runs[0]!.sqlSamples[0]!.totalMs=2;},
   (x:ReturnType<typeof fixture>)=>{x.runs[0]!.fixedMatch=false;},
   (x:ReturnType<typeof fixture>)=>{x.resources.deleted=false;},
  ]) { const c=currentFixture(); change(c); expect(()=>compare(fixture(),c)).toThrow(); }
 });
 it('rejects fixture, revision, artifacts and environment mismatch or absence',()=>{
  for(const change of [
   (x:ReturnType<typeof fixture>)=>{x.fixture.rows=40;},
   (x:ReturnType<typeof fixture>)=>{x.fixture.sha256=digest('f');},
   (x:ReturnType<typeof fixture>)=>{x.checkoutRevision.sha='bad';},
   (x:ReturnType<typeof fixture>)=>{x.artifacts.sha256='';},
   (x:ReturnType<typeof fixture>)=>{x.artifacts.runner.sha256=digest('f');},
   (x:ReturnType<typeof fixture>)=>{x.artifacts.lockSha256=digest('f');},
   (x:ReturnType<typeof fixture>)=>{x.environment.postgres='pg17';},
   (x:ReturnType<typeof fixture>)=>{x.environment.settings.find(row=>row.name==='work_mem')!.setting='99';},
   (x:ReturnType<typeof fixture>)=>{x.snapshots.setupStart!.loadAverage=[];},
  ]) { const c=currentFixture(); change(c); expect(()=>compare(fixture(),c)).toThrow(); }
 });
 it('requires the specified baseline as clean git or archive',()=>{
  const archive=fixture(); archive.checkoutRevision.dirty=null as unknown as boolean; archive.checkoutRevision.diffSha256=null as unknown as string;
  const c=currentFixture(); setMetric(c,'chunks/common',50); setMetric(c,'tools/common',50); expect(compare(archive,c).pass).toBe(true);
  const dirty=fixture(); dirty.checkoutRevision.dirty=true; expect(()=>compare(dirty,c)).toThrow();
  const wrong=fixture(); wrong.checkoutRevision.sha='b'.repeat(40); expect(()=>compare(wrong,c)).toThrow();
 });
 it('rejects incomplete explain evidence and incompatible host or cluster',()=>{
  for(const mutate of [
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.explain=[];},
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.explain[0]!.Plan['Actual Rows']=NaN;},
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.explain[0]!.Plan['Shared Hit Blocks']=NaN;},
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.explain[0]!['Execution Time']=NaN;},
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.timings.wall.pop();},
   (v:ReturnType<typeof fixture>)=>{v.environment.hostIdentity=digest('a');},
   (v:ReturnType<typeof fixture>)=>{v.environment.systemIdentifier='9876';},
   (v:ReturnType<typeof fixture>)=>{v.environment.locale.version='other';},
   (v:ReturnType<typeof fixture>)=>{v.environment.locale.provider='?';},
   (v:ReturnType<typeof fixture>)=>{v.snapshots.measurementStart!.at='2026-01-01T00:03:01.000Z';},
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.sqlSamples[0]!.searchMs=0;},
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.sqlSamples[0]!.spans[0]!.sqlSha256='bad';},
  ]) { const c=currentFixture(); mutate(c); expect(()=>compare(fixture(),c)).toThrow(); }
 });
 it.each(['provider','locale','version','collate','ctype'] as const)('requires and matches app locale %s',key=>{
  for(const which of ['baseline','current'] as const) for(const value of [undefined,'tampered']) {
   const base=fixture(), current=shifted(currentFixture()); const target=which==='baseline'?base.environment.locale:current.environment.locale;
   (target as Record<string,unknown>)[key]=value; expect(()=>rawCompare(base,current)).toThrow();
  }
  if(key==='collate'||key==='ctype') for(const value of ['',null,42]) {const c=shifted(currentFixture());c.environment.locale[key]=value;expect(()=>rawCompare(fixture(),c)).toThrow();}
 });
 it('requires matching auxiliary evidence and actual truncation for both targets',()=>{
  const missing=currentFixture(); missing.auxiliary.pop(); expect(()=>compare(fixture(),missing)).toThrow();
  const notTruncated=currentFixture(); notTruncated.auxiliary[0]!.truncated=false; expect(()=>compare(fixture(),notTruncated)).toThrow();
  const unmasked=currentFixture(); unmasked.auxiliary[1]!.masked=false; expect(()=>compare(fixture(),unmasked)).toThrow();
  const altered=currentFixture(); setMetric(altered,'chunks/common',50); setMetric(altered,'tools/common',50); altered.auxiliary[0]!.resultHash=digest('7');
  expect(compare(fixture(),altered)).toMatchObject({pass:false,auxiliaryEqual:false});
 });
 it('rejects spans outside the run, reordered phases and conditions, and overlapping runs',()=>{
  for(const mutate of [
   (v:ReturnType<typeof fixture>)=>{v.runs[0]!.timings.warmup.startedAt='2025-12-31T23:59:59.000Z';},
   (v:ReturnType<typeof fixture>)=>{v.runs[5]!.timings.explain.finishedAt='2026-01-01T00:04:00.000Z';},
   (v:ReturnType<typeof fixture>)=>{[v.runs[0]!.timings.wall[0],v.runs[0]!.timings.wall[1]]=[v.runs[0]!.timings.wall[1]!,v.runs[0]!.timings.wall[0]!];},
   (v:ReturnType<typeof fixture>)=>{[v.runs[0],v.runs[1]]=[v.runs[1]!,v.runs[0]!];},
   (v:ReturnType<typeof fixture>)=>{v.runs[1]!.timings.warmup.startedAt=v.runs[0]!.timings.explain.startedAt;},
  ]) {const c=currentFixture(); mutate(c); expect(()=>compare(fixture(),c)).toThrow();}
  const offset=shifted(currentFixture()); offset.runs[0].timings.warmup.startedAt='2026-01-01T00:05:01+00:00';
  expect(()=>rawCompare(fixture(),offset)).toThrow();
  const overlap=fixture(); overlap.finishedAt='2026-01-01T00:06:00.000Z'; expect(()=>rawCompare(overlap,shifted(currentFixture()))).toThrow('overlapping');
 });
 it('registers only the scenario options',()=>{
  const args=['common-search','--checkout','.','--database-url','postgres://localhost/owned','--out','result.json'];
  expect(parseArgs(args)).toEqual({command:'common-search',checkout:'.',databaseUrl:'postgres://localhost/owned',out:'result.json'});
  expect(()=>parseArgs(args.slice(0,-2))).toThrow(); expect(()=>parseArgs([...args,'--out','again'])).toThrow(); expect(()=>parseArgs([...args,'--sizes','10'])).toThrow();
 });
});

describe('fixture index configuration precondition',()=>{
 it('requires the independently fixed ID from the checkout and migrated chunk generation',async()=>{
  const id='019a0000-0000-7000-8000-000000000003';
  const query=vi.fn().mockResolvedValue({rows:[{id,kind:'chunk'}]});
  await expect(assertFixtureConfig({query},id)).resolves.toBeUndefined();
  expect(query).toHaveBeenCalledWith(expect.stringContaining('brain.index_configs'),[id]);
  query.mockClear();
  await expect(assertFixtureConfig({query},'019a0000-0000-7000-8000-000000000001')).rejects.toThrow('fixture config mismatch');
  expect(query).not.toHaveBeenCalled();
  for(const rows of [[],[{id,kind:'other'}],[{id:'019a0000-0000-7000-8000-000000000001',kind:'chunk'}]]) {
   query.mockResolvedValueOnce({rows}); await expect(assertFixtureConfig({query},id)).rejects.toThrow('missing from migrated database');
  }
 });
});

describe('common-search runner sampling and tracing',()=>{
 it('excludes the warmup from exactly three measured samples',async()=>{
  const calls:number[]=[]; const values=await sampleThree(async()=>{calls.push(99);return 99;},async(i:number)=>{calls.push(i);return [11,22,33][i];});
  expect(calls).toEqual([99,0,1,2]); expect(values).toEqual([11,22,33]);
 });
 it('restores the original query function after a failure',async()=>{
  const cause=new Error('synthetic failure'); class Client { query(_text:string) {return Promise.reject(cause);} }
  const original=Client.prototype.query, client=new Client(); await expect(trace(Client,()=>client.query('bad'))).rejects.toBe(cause); expect(Client.prototype.query).toBe(original);
 });
 it('captures search SQL and all query spans',async()=>{
  class Client { query(_text:string) {return Promise.resolve({rows:[]});} }
  const original=Client.prototype.query, client=new Client(), spy=vi.fn();
  const result=await trace(Client,async()=>{await client.query('select 1'); await client.query('select * from brain.chunks where lower(body) like $1'); spy(); return 'ok';});
  expect(result.result).toBe('ok'); expect(result.spans).toHaveLength(2); expect(result.spans.map((span:{search:boolean})=>span.search)).toEqual([false,true]); expect(result.spans.every((span:{sqlSha256:string})=>/^[a-f0-9]{64}$/.test(span.sqlSha256))).toBe(true); expect(result.captured.text).toContain('brain.chunks'); expect(spy).toHaveBeenCalledOnce(); expect(Client.prototype.query).toBe(original);
 });
});

it('CLI replaces prior success with sanitized failure evidence and exit 1',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'common-search-cli-')), out=join(dir,'result.json');
 const previous=process.exitCode, log=vi.spyOn(console,'error').mockImplementation(()=>{});
 try {
  await writeFile(out,JSON.stringify({scenario:'common-search',status:'ok'}));
  const error=Object.assign(new Error('synthetic postgres://user:secret@localhost/db'),{resources:{database:'qp_owned',created:true,deleted:true},evidence:{stage:'wall',errors:[{message:'socket',code:'ECONNRESET'},{message:'cleanup',code:'DROP_FAILED'}],runs:[{kind:'chunks',condition:'common'}],diagnostic:{stage:'cost:analyze:sample:2',cost:{write:{samplesMs:[1,2,3]},analyze:{samples:[{ms:1}]}},active:{failure:{code:'57014'}}},detail:'postgres://user:secret@localhost/db'}});
  await main(['common-search','--checkout','.','--database-url','postgres://localhost/db','--out',out],{runCommonSearch:async()=>{throw error;}});
  const text=await readFile(out,'utf8'), result=JSON.parse(text);
  expect(result).toMatchObject({status:'failed',resources:{database:'qp_owned',created:true,deleted:true},evidence:{stage:'wall',runs:[{kind:'chunks',condition:'common'}]}});
  expect(result.evidence.errors).toEqual([{message:'socket',code:'ECONNRESET'},{message:'cleanup',code:'DROP_FAILED'}]); expect(result.evidence.diagnostic).toMatchObject({stage:'cost:analyze:sample:2',cost:{write:{samplesMs:[1,2,3]},analyze:{samples:[{ms:1}]}},active:{failure:{code:'57014'}}}); expect(text).not.toContain('secret'); expect(process.exitCode).toBe(1);
 } finally {process.exitCode=previous; log.mockRestore(); await rm(dir,{recursive:true,force:true});}
});


describe('mismatch evidence',()=>{
 it.each(['fixed oracle','store oracle','core oracle','auxiliary output contract'])('records sanitized IDs, hashes and first differing path for %s',label=>{
  const partial:{mismatch?:{expectedIds:string[];actualIds:string[];firstDifference:string;expectedHash:string;actualHash:string}}={};
  expect(()=>assertEvidence(partial,label,['expected-id'],['actual-id'],{rows:[{id:'expected-id',body:'secret'}]},{rows:[{id:'actual-id',body:'secret'}]})).toThrow('mismatch');
  expect(partial.mismatch).toMatchObject({expectedIds:['expected-id'],actualIds:['actual-id'],firstDifference:'$.rows.0.id'});
  expect(partial.mismatch?.expectedHash).toMatch(/^[a-f0-9]{64}$/); expect(partial.mismatch?.actualHash).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(partial)).not.toContain('secret');
 });
 it('handles absent fields in the first difference without dumping values',()=>{
  const partial={}; expect(()=>assertEvidence(partial,'core',[],[],{meta:{a:1}},{meta:{}})).toThrow('mismatch');
  expect(partial).toMatchObject({mismatch:{firstDifference:'$.meta.a'}});
 });
});


describe('protocol 2 preparation',()=>{
 it('runs exact vacuum order outside an explicit transaction and refuses failed readiness',async()=>{
  const queries:string[]=[];
  const client={query:vi.fn(async(sql:string,values?:string[]):Promise<{rows:any[]}>=>{queries.push(sql); if(sql.startsWith('create extension')) return {rows:[]}; if(sql.startsWith('select count(*)')) return {rows:[{count:10}]}; if(sql.includes('from pg_class c join pg_namespace')) return {rows:[{relname:values?.[0],reloptions:null}]}; if(sql.includes('from pg_index i')) return {rows:gin()}; if(sql.includes('pgstatginindex')) return {rows:[{pending_pages:0,pending_tuples:'0'}]}; if(sql.includes('from pg_settings')) return {rows:structuredClone(autoSettings)}; return {rows:[]};})};
  const result=await prepareProtocol(client); expect(result).toMatchObject({readinessCriterion:'vacuum-success-counts-unchanged-pending-zero-if-supported',ready:true});
  expect(queries.filter(x=>x.startsWith('VACUUM'))).toEqual(targets.map(x=>`VACUUM (ANALYZE) brain.${x}`));
  expect(queries.some(x=>/^begin/i.test(x))).toBe(false);
  for(const field of ['pending_pages','pending_tuples'] as const) {
   let vacuumCount=0;
   const pendingClient={query:vi.fn(async(sql:string,values?:string[]):Promise<{rows:any[]}>=>{
    if(sql.startsWith('VACUUM')) vacuumCount++;
    if(sql.startsWith('select count(*)')) return {rows:[{count:10}]};
    if(sql.includes('from pg_class c join pg_namespace')) return {rows:[{relname:values?.[0],reloptions:null}]};
    if(sql.includes('from pg_index i')) return {rows:gin()};
    if(sql.includes('pgstatginindex')) return {rows:[{pending_pages:field==='pending_pages' && vacuumCount===4?1:0,pending_tuples:field==='pending_tuples' && vacuumCount===4?'1':'0'}]};
    if(sql.includes('from pg_settings')) return {rows:structuredClone(autoSettings)};
    return {rows:[]};
   })};
   try { await prepareProtocol(pendingClient); throw Error('expected rejection'); } catch(error) {
    const preparation=(error as any).preparation;
    expect(preparation).toMatchObject({stage:'ready',ready:false,vacuum:targets.map(table=>({table,success:true}))});
    expect(preparation.post.indexes[0].pending[field]).toBe(field==='pending_pages'?1:'1');
   }
  }
 });
 it('rejects changed or invalid table options and session settings before measurement',async()=>{
  for(const mutation of ['options','settings','timezone','lock','statement','missing']) {
   let vacuumCount=0;
   const client={query:async(sql:string,values?:string[])=>{
    if(sql.startsWith('VACUUM')) vacuumCount++;
    if(sql.startsWith('select count(*)')) return {rows:[{count:10}]};
    if(sql.includes('from pg_class c join pg_namespace')) return {rows:[{relname:values?.[0],reloptions:mutation==='options' && vacuumCount===4 && values?.[0]==='chunks'?['autovacuum_enabled=false']:null}]};
    if(sql.includes('from pg_index i')) return {rows:gin()};
    if(sql.includes('pgstatginindex')) return {rows:[{pending_pages:0,pending_tuples:'0'}]};
    if(sql.includes('from pg_settings')) {
     const rows=structuredClone(autoSettings);
     if(mutation==='settings' && vacuumCount===4) rows.find(x=>x.name==='autovacuum')!.setting='off';
     const name=mutation==='timezone'?'TimeZone':mutation==='lock'?'lock_timeout':mutation==='statement'?'statement_timeout':null;
     if(name) rows.find(x=>x.name===name)!.setting='1';
     return {rows:mutation==='missing'?rows.filter(x=>x.name!=='autovacuum'):rows};
    }
    return {rows:[]};
   }};
   try {await prepareProtocol(client); throw Error('expected rejection');} catch(error) {expect((error as any).preparation).toMatchObject({stage:'ready',ready:false});}
  }
 });
 it('requires independent policy and observed readiness in main and cost evidence',()=>{
  const base=fixture(), current=shifted(currentFixture());
  setMetric(current,'chunks/common',50); setMetric(current,'tools/common',50);
  expect(rawCompare(base,current).pass).toBe(true);
  for(const side of ['base','current'] as const) for(const location of ['main','cost'] as const) {
   for(const mutate of [
    (p:any)=>{delete p.readinessCriterion;},
    (p:any)=>{p.readinessCriterion='changed';},
    (p:any)=>{p.ready=false;},
    (p:any)=>{delete p.ready;},
    (p:any)=>{delete p.readinessCriterion;p.ready='vacuum-success-counts-unchanged-pending-zero-if-supported';},
   ]) {
    const b=fixture(), c=shifted(currentFixture());
    setMetric(c,'chunks/common',50); setMetric(c,'tools/common',50);
    const target=side==='base'?b:c;
    mutate(location==='main'?target.preparation:target.diagnostic.cost.setup.preparation);
    expect(()=>rawCompare(b,c)).toThrow('protocol');
   }
  }
 });
 it('rejects protocol mismatch, failed readiness and missing diagnostic cleanup',()=>{
  const b=fixture(), c=currentFixture();
  b.preparation.protocolVersion=1; expect(()=>compare(b,c)).toThrow('protocol');
  const bad=fixture(); bad.preparation.ready=false; expect(()=>compare(bad,c)).toThrow('protocol');
  const pending=fixture(); pending.preparation.support={supported:true,reason:null as unknown as string}; pending.preparation.post.indexes=[{pending:{pending_pages:1,pending_tuples:1}}] as never[]; expect(()=>compare(pending,c)).toThrow('protocol');
  const cleanup=fixture(); cleanup.diagnostic.resources[0]!.deleted=false; expect(()=>compare(cleanup,c)).toThrow('protocol');
 });
});

describe('preparation failure evidence',()=>{
 const codeError=()=>Object.assign(new Error('synthetic SQL failure'),{code:'57014'});
 const clientFor=(fail:string)=>({query:vi.fn(async(sql:string,values?:string[]):Promise<{rows:any[]}>=>{
  if(fail==='support' && sql.startsWith('create extension')) throw codeError();
  if(fail==='pre' && sql.includes('from pg_class c join pg_namespace') && values?.[0]==='messages') throw codeError();
  if(fail==='vacuum' && sql==='VACUUM (ANALYZE) brain.chunks') throw codeError();
  if(sql.startsWith('select count(*)')) return {rows:[{count:10}]};
  if(sql.includes('from pg_class c join pg_namespace')) return {rows:[{relname:values?.[0],bytes:'10'}]};
  return {rows:[]};
 })});
 it('preserves support and earlier tables when the pre snapshot fails',async()=>{
  try {await prepareProtocol(clientFor('pre')); throw Error('expected failure');} catch(e) {
   const err=e as Error & {code:string;preparation:{stage:string;support:unknown;pre:{stage:string;tables:unknown[]};failure:unknown}};
   expect(err.code).toBe('57014'); expect(err.preparation).toMatchObject({stage:'pre',support:{supported:true},pre:{stage:'table:messages:relation',tables:[{relname:'sessions',count:10,bytes:'10'},{relname:'messages',count:10}]},failure:{code:'57014'}});
  }
 });
 it('preserves support-stage errors and completed VACUUM commands with SQLSTATE',async()=>{
  for(const [target,stage] of [['support','support'],['vacuum','vacuum']] as const) {
   try {await prepareProtocol(clientFor(target)); throw Error('expected failure');} catch(e) {
    const err=e as Error & {code:string;preparation:{stage:string;vacuum:unknown[];failure:unknown}};
    expect(err).toMatchObject({code:'57014',preparation:{stage,failure:{code:'57014'}}});
    if(target==='vacuum') expect(err.preparation.vacuum).toMatchObject([{table:'sessions',success:true},{table:'messages',success:true},{table:'chunks',success:false,code:'57014'}]);
   }
  }
 });
});


describe('protocol 2 evidence acceptance',()=>{
 const passing=()=>{const b=fixture(), c=currentFixture();setMetric(c,'chunks/common',50);setMetric(c,'tools/common',50);return {b,c:shifted(c)};};
 it('accepts baseline 39 and connection 42 and rejects historical current schemas and invalid evidence',()=>{
  const {b,c}=passing();expect(rawCompare(b,c).pass).toBe(true);
  expect(()=>rawCompare(b,shifted(fixture()))).toThrow('schema');
  expect(()=>rawCompare(b,shifted(fixture(100,40)))).toThrow('schema');
  expect(()=>rawCompare(b,shifted(fixture(100,41)))).toThrow('schema');
  for(const side of ['b','c'] as const) for(const where of ['main','cost'] as const) for(const mutation of ['to','wrongSide','api','manifest','missing','hash','stats','old41','future43'] as const) {
   const pair=passing(), target=pair[side]; const location=where==='main'?target.migration:target.diagnostic.cost.setup;
   if(mutation==='to') (where==='main'?target.migration.value:target.diagnostic.cost.setup.migration).to=43;
   if(mutation==='wrongSide') (where==='main'?target.migration.value:target.diagnostic.cost.setup.migration).to=side==='b'?40:39;
   if(mutation==='api') location.schema.apiVersion=43;
   if(mutation==='manifest') location.schema.manifest.pop();
   if(mutation==='missing') delete (location as any).schema;
   if(mutation==='hash') location.schema.manifest[0].sha256='0'.repeat(64);
   if(mutation==='stats') location.schema.manifest[location.schema.manifest.length-1].name='0040_recall_expression_statistics.sql';
   if(mutation==='old41') location.schema=expectedSchema(41);
   if(mutation==='future43') location.schema.version=43;
   expect(()=>rawCompare(pair.b,pair.c)).toThrow('schema');
  }
  const disguised=passing(); disguised.b.migration.schema=expectedSchema(40); expect(()=>rawCompare(disguised.b,disguised.c)).toThrow('schema');
  const other=passing();other.c.diagnostic.upgrade={available:true};expect(()=>rawCompare(other.b,other.c)).toThrow('protocol');
 });
 it('requires unique matching GIN indexes and matching pre/post inventory even without pending support',()=>{
  const changes=[
   (c:any)=>{c.preparation.pre.indexes=[];},
   (c:any)=>{c.preparation.post.indexes.pop();},
   (c:any)=>{c.preparation.pre.indexes.push(structuredClone(c.preparation.pre.indexes[0]));},
   (c:any)=>{c.preparation.post.indexes[0].table_name='tool_notes';},
   (c:any)=>{c.preparation.post.indexes[0].reloptions=['fastupdate=off'];},
   (c:any)=>{c.preparation.support={supported:true,reason:null};c.preparation.post.indexes.forEach((x:any)=>x.pending={pending_pages:0,pending_tuples:'0'});c.preparation.post.indexes[0].pending.pending_pages=1;},
  ];
  for(const mutate of changes){const {b,c}=passing();mutate(c);expect(()=>rawCompare(b,c)).toThrow();}
 });
 it('requires the declared settings and matching autovacuum and relation options',()=>{
  const changes=[
   (c:any)=>{c.environment.settings=c.environment.settings.filter((x:any)=>x.name!=='random_page_cost');},
   (c:any)=>{c.environment.settings.find((x:any)=>x.name==='effective_cache_size').setting='999';},
   (c:any)=>{c.preparation.post.settings.find((x:any)=>x.name==='autovacuum').setting='off';},
   (c:any)=>{c.preparation.post.tables[0].reloptions=['autovacuum_enabled=false'];},
   (c:any)=>{for(const side of ['pre','post'])c.preparation[side].settings.find((x:any)=>x.name==='autovacuum').setting='off';},
   (c:any)=>{c.diagnostic.cost.setup.preparation.pre.tables[0].reloptions=['autovacuum_enabled=false'];},
  ];
  for(const mutate of changes){const {b,c}=passing();mutate(c);expect(()=>rawCompare(b,c)).toThrow();}
 });
 it('binds all preparation and analyze counts and write counts to the fixture',()=>{
  for(const location of ['mainPre','mainPost','costPre','costPost','analyzePre','analyzePost','writeBefore','writeAfter']) {
   const {b,c}=passing(); const cost=c.diagnostic.cost;
   const snapshots:any={mainPre:c.preparation.pre,mainPost:c.preparation.post,costPre:cost.setup.preparation.pre,costPost:cost.setup.preparation.post,analyzePre:cost.analyze.pre,analyzePost:cost.analyze.post};
   if(location==='writeBefore'||location==='writeAfter') (location==='writeBefore'?cost.write.before:cost.write.after).chunks=99999;
   else snapshots[location].tables[0].count=20;
   expect(()=>rawCompare(b,c)).toThrow();
  }
 });
 it('rejects invalid UTC and timeout policy even when both sides agree',()=>{
  for(const location of ['main','cost','app']) for(const name of ['TimeZone','lock_timeout','statement_timeout']) {
   const {b,c}=passing();
   for(const r of [b,c]) {
    const groups=location==='app'?[r.environment.settings]:location==='main'?[r.preparation.pre.settings,r.preparation.post.settings]:[r.diagnostic.cost.setup.preparation.pre.settings,r.diagnostic.cost.setup.preparation.post.settings];
    for(const settings of groups) settings.find((x:any)=>x.name===name)!.setting=name==='TimeZone'?'Asia/Seoul':'1';
   }
   expect(()=>rawCompare(b,c)).toThrow();
  }
 });
 it('accepts supported pending checks in all four locations and rejects one bad pending field',()=>{
  const supported=()=>{const pair=passing(); for(const r of [pair.b,pair.c]) for(const p of [r.preparation,r.diagnostic.cost.setup.preparation]) {
   p.support={supported:true,reason:null as unknown as string};
   for(const state of [p.pre,p.post]) for(const index of state.indexes) Object.assign(index,{pending:{pending_pages:0,pending_tuples:'0'}});
  } return pair;};
  const good=supported(); expect(rawCompare(good.b,good.c).pass).toBe(true);
  for(const side of ['b','c'] as const) for(const location of ['main','cost']) for(const field of ['pending_pages','pending_tuples']) {
   const pair=supported(), r=pair[side], p=location==='main'?r.preparation:r.diagnostic.cost.setup.preparation;
   (p.post.indexes[0] as any).pending[field]=field==='pending_pages'?1:'1'; expect(()=>rawCompare(pair.b,pair.c)).toThrow();
  }
 });
 it('propagates pending-support connection failure instead of treating it as unsupported',async()=>{
  const error=Object.assign(new Error('connection lost'),{code:'ECONNRESET'});
  await expect(pendingSupport({query:async()=>{throw error;}})).rejects.toBe(error);
 });
 it('allows only pending-support SQLSTATEs reported by the runner',()=>{
  for(const reason of ['0A000','42501','58P01','42704']) {const {b,c}=passing(); for(const r of [b,c]) for(const p of [r.preparation,r.diagnostic.cost.setup.preparation]) p.support.reason=reason; expect(rawCompare(b,c).pass).toBe(true);}
  for(const reason of ['ECONNRESET','', '57014']) {const {b,c}=passing(); c.preparation.support.reason=reason; expect(()=>rawCompare(b,c)).toThrow();}
 });
 it('rejects independently misplaced preparation, write and analyze spans',()=>{
  const changes=[
   (c:any)=>{c.preparation.vacuum[0].startedAt=plus(c.preparation.pre.at,-1);},
   (c:any)=>{c.preparation.post.at=c.preparation.vacuum[0].startedAt;},
   (c:any)=>{c.diagnostic.cost.write.samples[1].startedAt=c.diagnostic.cost.write.warmup.startedAt;},
   (c:any)=>{c.diagnostic.startedAt=plus(c.snapshots.measurementEnd.at,-1);},
   (c:any)=>{c.diagnostic.cost.analyze.warmup.startedAt=c.diagnostic.cost.write.warmup.startedAt;},
   (c:any)=>{c.diagnostic.cost.analyze.pre.at=c.diagnostic.cost.write.warmup.startedAt;},
  ];
  for(const mutate of changes){const {b,c}=passing();mutate(c);expect(()=>rawCompare(b,c)).toThrow();}
 });
 it('rejects remaining candidate statistics in either run and each cost phase',()=>{
  for(const side of ['baseline','current']) for(const location of ['main','before','after']) for(const field of ['definitions','distributions']) {
   const {b,c}=passing(), r:any=side==='baseline'?b:c, stat=location==='main'?r.statistics:location==='before'?r.diagnostic.cost.statisticsBefore:r.diagnostic.cost.statisticsAfter;
   stat[field]=[{}]; expect(()=>rawCompare(b,c)).toThrow();
  }
 });
});


it('runner readiness requires both GIN indexes and stable inventory',async()=>{
 for(const indexes of [[],[gin()[0]], [...gin(),gin()[0]], [{...gin()[0],table_name:'tool_notes'},gin()[1]]]) {
  const client={query:async(sql:string,values?:string[])=>{
   if(sql.startsWith('select count(*)'))return {rows:[{count:10}]};
   if(sql.includes('from pg_class c join pg_namespace'))return {rows:[{relname:values?.[0],reloptions:null}]};
   if(sql.includes('from pg_index i'))return {rows:structuredClone(indexes)};
   if(sql.includes('pgstatginindex'))return {rows:[{pending_pages:0,pending_tuples:'0'}]};
   if(sql.includes('from pg_settings'))return {rows:structuredClone(autoSettings)};
   return {rows:[]};
  }};
  await expect(prepareProtocol(client)).rejects.toThrow('not ready');
 }
});


describe('fixed migration manifest',()=>{
 it('rejects missing, extra, renamed and modified files in a real directory',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'common-schema-'));
  const source=resolve(import.meta.dirname,'../../../packages/postgres/migrations');
  try {
   for(const name of await readdir(source)) if(name.endsWith('.sql')) await copyFile(join(source,name),join(dir,name));
   expect(inspectMigrationDirectory(dir,42)).toEqual(expectedSchema(42));
   const file='0042_drive_connection.sql', original=await readFile(join(dir,file));
   await unlink(join(dir,file)); expect(()=>inspectMigrationDirectory(dir,42)).toThrow();
   expect(inspectMigrationDirectory(dir,41)).toEqual(expectedSchema(41));
   await writeFile(join(dir,'0040_recall_expression_statistics.sql'),original); expect(()=>inspectMigrationDirectory(dir,42)).toThrow();
   await unlink(join(dir,'0040_recall_expression_statistics.sql')); await writeFile(join(dir,file),Buffer.concat([original,Buffer.from('changed')])); expect(()=>inspectMigrationDirectory(dir,42)).toThrow();
   await writeFile(join(dir,file),original); await writeFile(join(dir,'0043_extra.sql'),''); expect(()=>inspectMigrationDirectory(dir,42)).toThrow();
   await unlink(join(dir,'0043_extra.sql')); await unlink(join(dir,file)); await unlink(join(dir,'0041_sources.sql')); expect(inspectMigrationDirectory(dir,40)).toEqual(expectedSchema(40));
   await unlink(join(dir,'0040_drive_uploads.sql')); expect(inspectMigrationDirectory(dir,39)).toEqual(expectedSchema(39));
  } finally {await rm(dir,{recursive:true,force:true});}
 });
});
