import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createIsolatedTestDatabase } from '../../test-db/src/index.js';
// @ts-expect-error JavaScript runner has no declarations.
import { run } from '../src/file-locations.mjs';
// @ts-expect-error JavaScript CLI has no declarations.
import { main } from '../run.mjs';
// @ts-expect-error JavaScript comparison helper has no declarations.
import { indexScan } from '../src/file-location-compare.mjs';
// @ts-expect-error JavaScript helpers have no declarations.
import { compare, hash, parseArgs } from '../src/core.mjs';
// @ts-expect-error JavaScript fixture has no declarations.
import { fixture, stamp, id, expected, expectedLocation, matrixOracle, listExpected } from '../src/file-location-fixture.mjs';

function sample(ratio=1) {
 const manifest=Array.from({length:39},(_,i)=>({owner:'core',version:i+1,name:`${String(i+1).padStart(4,'0')}_fixture.sql`,checksum:'f'.repeat(64)}));
 const snapshot={files:{count:fixture.rows,hash:'1'.repeat(64)},locations:{count:fixture.rows,hash:'2'.repeat(64)}};
 const events=['read','list','mark'].flatMap(kind=>Array.from({length:4},(_,iteration)=>({kind,iteration,n:fixture.rows-iteration,queries:(kind==='mark'?['begin','update brain.file_locations set deleted_at=$1','select deleted_at from brain.file_locations','commit']:['select id, file_id from brain.file_locations']).map(text=>({text}))})));
 return {scenario:'file-locations',failed:false,fixture,fixtureHash:hash(fixture),checkoutRevision:{sha:'eaff4ccd4de4932f8a899dd9c8d69277380f44f7',dirty:false,diffSha256:'a'.repeat(64)},
  artifacts:{sha256:'b'.repeat(64),lockSha256:'c'.repeat(64),functionSha256:'d'.repeat(64),runner:{sha256:'e'.repeat(64)}},
  environment:{measurementRole:'brain_app',replicationRole:'origin',diagnostic:{role:'brain_app',replication:'origin',timezone:'UTC',lock_timeout:'10s',statement_timeout:'2min'},diagnosticTimeouts:{connectMs:10000,queryMs:121000,statementMs:120000,lockMs:10000},node:'n',postgres:'p',platform:'p',arch:'a',cpus:1,pid:1,processesStart:'one',processesEnd:'one',loadAverageStart:[0,0,0],loadAverageEnd:[0,0,0]},
  startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:01Z',resources:{database:'qp_'+'1'.repeat(20),created:true,deleted:true},
  matrix:matrixOracle(),before:structuredClone(snapshot),after:structuredClone(snapshot),migrations:{manifest,manifestHash:hash(manifest),applied:structuredClone(manifest),appliedHash:hash(manifest)},events,
  changed:[...Array.from({length:4},(_,i)=>({id:id(fixture.rows-i),deletedAt:stamp})),{id:id(fixture.rows-6),deletedAt:stamp}].sort((a,b)=>a.id.localeCompare(b.id)),
  runs:['read','list','mark'].map(kind=>({kind,samplesMs:[100*ratio,100*ratio,100*ratio],medianMs:100*ratio,sqlCounts:kind==='mark'?[4,4,4]:[1,1,1],sql:'select synthetic',
   observations:Array.from({length:3},(_,i)=>{const n=fixture.rows-i-1; return {n,result:expected(kind,n),before:expectedLocation(n),after:expectedLocation(n,kind==='mark'?stamp:null)};}),
   diagnostics:(kind==='mark'?['update brain.file_locations','select deleted_at']:['select id']).map(sql=>({sql,values:[],explain:[{Plan:{'Node Type':'Index Scan','Relation Name':'file_locations','Index Cond':kind==='list'?'(file_id = $1)':'(id = $1)','Actual Total Time':1,'Shared Hit Blocks':1}}]}))}))};
}
describe('file locations comparison',()=>{
 it('accepts half time and rejects slower canonical read or mark',()=>{
  expect(compare(sample(),sample(.5)).pass).toBe(true);
  for(const kind of ['read','mark']) {const change=sample(.5), r=change.runs.find(r=>r.kind===kind)!;r.samplesMs=[51,51,51];r.medianMs=51;expect(compare(sample(),change).pass).toBe(false);}
 });
 it('rejects sequential scans even when the time threshold is met',()=>{const change=sample(.5);change.runs[0]!.diagnostics[0]!.explain[0]!.Plan['Node Type']='Seq Scan';expect(compare(sample(),change).pass).toBe(false);});
 it('rejects missing provenance, measurements, oracle evidence and cleanup',()=>{
  const cases=[(v:ReturnType<typeof sample>)=>{v.fixture.rows=999;},(v:ReturnType<typeof sample>)=>{v.artifacts.runner.sha256='';},(v:ReturnType<typeof sample>)=>{v.resources.deleted=false;},(v:ReturnType<typeof sample>)=>{v.runs.pop();},(v:ReturnType<typeof sample>)=>{v.runs[0]!.samplesMs.pop();},(v:ReturnType<typeof sample>)=>{v.runs[0]!.sqlCounts[0]=0;},(v:ReturnType<typeof sample>)=>{v.runs[0]!.observations.pop();},(v:ReturnType<typeof sample>)=>{v.changed.pop();},(v:ReturnType<typeof sample>)=>{v.runs[0]!.diagnostics[0]!.explain=[];}];
  for(const mutate of cases) {const value=sample(); value.fixture={...fixture}; mutate(value);expect(()=>compare(sample(),value)).toThrow();}
 });
 it('rejects same wrong evidence on both sides and mismatched provenance',()=>{
  const a=sample(),b=sample(.5);a.runs[0]!.observations[0]!.result={ok:false};b.runs[0]!.observations[0]!.result={ok:false};expect(()=>compare(a,b)).toThrow();
  const other=sample(.5);other.artifacts.runner.sha256='f'.repeat(64);expect(()=>compare(sample(),other)).toThrow();
 });
 it('parses required CLI options',()=>{const args=['file-locations','--checkout','.','--database-url','postgres://localhost/db','--out','out.json'];expect(parseArgs(args).command).toBe('file-locations');expect(()=>parseArgs(args.slice(0,-2))).toThrow();expect(()=>parseArgs([...args,'--out','again'])).toThrow();});
});

it('requires index plans for both mark statements',()=>{
 const change=sample(.5); change.runs[2]!.diagnostics[1]!.explain[0]!.Plan['Node Type']='Seq Scan';
 expect(compare(sample(),change).pass).toBe(false);
});

it('captures real store index plans on the app connection and rolls back the diagnostic update',async()=>{
 const db=await createIsolatedTestDatabase();
 try {
  const result=await run({checkout:resolve(import.meta.dirname,'../../..'),databaseUrl:db.url},{rows:10000,afterDiagnostics:async ({client,raw}:{client:{query:(q:string,p:unknown[])=>Promise<{rows:{deleted_at:Date|null}[]}>};raw:{fixture:{rows:number}}})=>{
   const row=await client.query('select deleted_at from brain.file_locations where id=$1',[id(raw.fixture.rows-4)]); expect(row.rows[0]?.deleted_at).toBeNull();
  }});
  expect(result.environment.diagnostic).toMatchObject({role:'brain_app',replication:'origin',timezone:'UTC'});
  expect(result.resources).toMatchObject({created:true,deleted:true});
  for(const row of result.runs) for(const diagnostic of row.diagnostics) expect(indexScan(diagnostic.explain[0].Plan,row.kind==='list'?'file_id':'id')).toBe(true);
  expect(result.runs.find((r:{kind:string})=>r.kind==='mark').diagnostics).toHaveLength(2);
  expect(result.runs.find((r:{kind:string})=>r.kind==='list').observations[0].result.locations).toHaveLength(3);
  expect(result.matrix).toEqual(matrixOracle(10000));
  expect(result.before).toEqual(result.after); expect(result.migrations.manifest).toEqual(result.migrations.applied);
 } finally {await db.drop();}
},120000);

it('writes sanitized CLI failure JSON with partial measurements and cleanup evidence',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'location-cli-')), output=join(dir,'failure.json'), old=process.exitCode;
 const spy=vi.spyOn(console,'error').mockImplementation(()=>{});
 try {
  const error=Object.assign(new Error('postgres://name:secret@localhost/db /Users/person/private'),{raw:{scenario:'file-locations',failed:true,environment:{node:'synthetic'},runs:[{samplesMs:[3],sql:'select 1'}],resources:{created:true,deleted:true},errors:[{message:'postgres://name:secret@localhost/db /Users/person/private'}]}});
  process.exitCode=0; await main(['file-locations','--checkout','.','--database-url','postgres://localhost/db','--out',output],{runLocations:()=>{throw error;}});
  expect(process.exitCode).toBe(1); const text=await readFile(output,'utf8'); expect(text).not.toContain('secret');expect(text).not.toContain('/Users/person');
  expect(JSON.parse(text)).toMatchObject({failed:true,runs:[{samplesMs:[3],sql:'select 1'}],resources:{created:true,deleted:true}});
 } finally {process.exitCode=old;spy.mockRestore();await rm(dir,{recursive:true,force:true});}
});

it('retains partial raw measurements when a run fails and cleans up its database',async()=>{
 const db=await createIsolatedTestDatabase();
 try {
  await expect(run({checkout:resolve(import.meta.dirname,'../../..'),databaseUrl:db.url},{rows:10000,afterSample:({kind,iteration}:{kind:string;iteration:number})=>{if(kind==='read'&&iteration===1) throw Error('injected');}})).rejects.toMatchObject({raw:{failed:true,environment:{measurementRole:'brain_app'},runs:[{kind:'read',samplesMs:[expect.any(Number)]}],resources:{created:true,deleted:true},errors:[{message:'injected'}]}});
 } finally {await db.drop();}
},120000);

it('rejects changed full-table counts or fingerprints, migration history, matrix and SQL traces',()=>{
 for(const mutate of [
  (v:ReturnType<typeof sample>)=>{v.after.files.count--;},
  (v:ReturnType<typeof sample>)=>{v.after.locations.count++;},
  (v:ReturnType<typeof sample>)=>{v.after.locations.hash='3'.repeat(64);},
  (v:ReturnType<typeof sample>)=>{v.migrations.applied.pop();},
  (v:ReturnType<typeof sample>)=>{v.migrations.manifest[0]!.checksum='4'.repeat(64);},
  (v:ReturnType<typeof sample>)=>{v.matrix.pop();},
  (v:ReturnType<typeof sample>)=>{v.events[0]!.queries.push({text:'select 1'});},
  (v:ReturnType<typeof sample>)=>{v.events[8]!.queries.pop();},
  (v:ReturnType<typeof sample>)=>{v.runs[2]!.sqlCounts[0]=1;}
 ]) {const v=sample(.5);mutate(v);expect(()=>compare(sample(),v)).toThrow();}
});
it('rejects matching baseline and change when their full-table contents differ from each other',()=>{
 const changed=sample(.5);changed.before.files.hash='5'.repeat(64);changed.after.files.hash='5'.repeat(64);expect(()=>compare(sample(),changed)).toThrow();
});

it('uses three ordered locations for each timed list target and rejects a reordered list',()=>{
 const locations=listExpected(fixture.rows); expect(locations).toHaveLength(3);
 expect(locations.map((x:{ownership:string})=>x.ownership)).toEqual(['brain','brain','external']);
 expect(locations.map((x:{locator:string})=>x.locator)).toEqual(['a/1',`synthetic/${fixture.rows}`,'z/2']);
 const value=sample(.5); value.runs[1]!.observations[0]!.result.locations.reverse(); expect(()=>compare(sample(),value)).toThrow();
});

it('accepts a UUID bitmap index only under the matching heap relation',()=>{
 const bitmap=(column:string,condition=`(${column} = $1)`)=>({'Node Type':'Bitmap Heap Scan','Relation Name':'file_locations','Actual Total Time':1,'Shared Hit Blocks':1,Plans:[{'Node Type':'Bitmap Index Scan','Index Cond':condition}]});
 const change=sample(.5); change.runs[1]!.diagnostics[0]!.explain[0]!.Plan=bitmap('file_id') as unknown as typeof change.runs[1]['diagnostics'][0]['explain'][0]['Plan'];
 expect(compare(sample(),change).pass).toBe(true);
 expect(indexScan(bitmap('file_id'),'file_id')).toBe(true);
 expect(indexScan(bitmap('id'),'file_id')).toBe(false);
 expect(indexScan(bitmap('file_id', '((file_id)::text = $1)'),'file_id')).toBe(false);
 expect(indexScan({'Node Type':'Bitmap Heap Scan','Relation Name':'other',Plans:[{'Node Type':'Bitmap Index Scan','Index Cond':'(file_id = $1)'}]},'file_id')).toBe(false);
 expect(indexScan({'Node Type':'Seq Scan','Relation Name':'file_locations',Filter:'(file_id = $1)'},'file_id')).toBe(false);
 expect(indexScan({'Node Type':'Index Scan','Relation Name':'file_locations'},'id')).toBe(false);
 expect(indexScan({'Node Type':'Index Scan','Relation Name':'file_locations','Index Cond':'((id)::text = $1)'},'id')).toBe(false);
 expect(indexScan({'Node Type':'Index Only Scan','Relation Name':'file_locations','Index Cond':"(id = 'abcdef00-0000-0000-0000-000000000001'::uuid)"},'id')).toBe(true);
});
it('rejects failed, missing status, or errors on either complete input',()=>{
 for(const side of ['base','change'] as const) for(const variant of ['failed','missing','errors'] as const) {
  const base=sample(),change=sample(.5), target=side==='base'?base:change;
  if(variant==='failed') target.failed=true;
  else if(variant==='missing') delete (target as Partial<typeof target>).failed;
  else Object.assign(target,{errors:[{message:'cleanup failed'}]});
  expect(()=>compare(base,change)).toThrow();
 }
 const valid=sample(.5);Object.assign(valid,{errors:[]});expect(compare(sample(),valid).pass).toBe(true);
});
