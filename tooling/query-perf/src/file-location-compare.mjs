import { hash, median } from './core.mjs';
import { fixture, stamp, id, expected, expectedLocation, matrixOracle } from './file-location-fixture.mjs';
const digest=x=>typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
const same=(a,b)=>hash(a)===hash(b);
// A bitmap index node has no relation name; bind it to its enclosing heap
// node instead of accepting an unrelated bitmap elsewhere in the plan.
export function indexScan(plan, column) {
 const condition=node=>{
  const value=node?.['Index Cond'];
  if(typeof value!=='string'||/::\s*text\b/i.test(value)) return false;
  const rhs="(?:'[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'::uuid|\\$[0-9]+(?:::uuid)?)";
  return new RegExp(`\\b${column}\"?\\s*=\\s*${rhs}`, 'i').test(value);
 };
 const bitmap=node=>!!node && typeof node==='object' && (node['Node Type']==='Bitmap Index Scan' && condition(node) || (node.Plans??[]).some(bitmap));
 const walk=node=>{
  if(!node || typeof node!=='object') return false;
  if(node['Relation Name']==='file_locations') {
   if(['Index Scan','Index Only Scan'].includes(node['Node Type']) && condition(node)) return true;
   if(node['Node Type']==='Bitmap Heap Scan' && (node.Plans??[]).some(bitmap)) return true;
  }
  return (node.Plans??[]).some(walk);
 };
 return walk(plan);
}
export function compareFileLocations(base,change) {
 const validate=v=>{
  const a=v?.artifacts, e=v?.environment, rev=v?.checkoutRevision;
  if(v?.scenario!=='file-locations'||v.failed!==false||(v.errors!==undefined&&(!Array.isArray(v.errors)||v.errors.length!==0))||!same(v.fixture,fixture)||v.fixtureHash!==hash(fixture)||!digest(a?.sha256)||!digest(a?.lockSha256)||!digest(a?.functionSha256)||!digest(a?.runner?.sha256)||
   !/^[a-f0-9]{40}$/.test(rev?.sha??'')||!((rev.dirty===null&&rev.diffSha256===null)||(typeof rev.dirty==='boolean'&&digest(rev.diffSha256)))||
   e?.measurementRole!=='brain_app'||e?.replicationRole!=='origin'||e?.diagnostic?.role!=='brain_app'||e?.diagnostic?.replication!=='origin'||e?.diagnostic?.timezone!=='UTC'||e?.diagnostic?.lock_timeout!=='10s'||e?.diagnostic?.statement_timeout!=='2min'||!same(e?.diagnosticTimeouts,{connectMs:10000,queryMs:121000,statementMs:120000,lockMs:10000})||!e?.node||!e?.postgres||!e?.platform||!e?.arch||!Number.isSafeInteger(e?.cpus)||e.cpus<1||!Number.isSafeInteger(e?.pid)||e.pid<1||!e.processesStart||!e.processesEnd||
   ![e.loadAverageStart,e.loadAverageEnd].every(a=>Array.isArray(a)&&a.length===3&&a.every(n=>Number.isFinite(n)&&n>=0))||!Number.isFinite(Date.parse(v.startedAt))||!Number.isFinite(Date.parse(v.finishedAt))||Date.parse(v.startedAt)>Date.parse(v.finishedAt)||
   !/^qp_[a-f0-9]{20}$/.test(v.resources?.database??'')||v.resources.created!==true||v.resources.deleted!==true||!Array.isArray(v.runs)||v.runs.length!==3) throw Error('invalid file-locations provenance');
  const wanted=[...Array.from({length:4},(_,i)=>({id:id(fixture.rows-i),deletedAt:stamp})),{id:id(fixture.rows-6),deletedAt:stamp}].sort((a,b)=>a.id.localeCompare(b.id));
  if(!same(v.changed,wanted)||!same(v.matrix,matrixOracle())) throw Error('invalid matrix or changed rows');
  for(const snap of [v.before,v.after]) if(!snap || !['files','locations'].every(k=>snap[k]?.count===fixture.rows&&digest(snap[k]?.hash))) throw Error('invalid table fingerprint');
  if(!same(v.before,v.after)) throw Error('unexpected full table changes');
  const m=v.migrations;
  if(!Array.isArray(m?.manifest)||m.manifest.length!==39||m.manifest.some((x,i)=>x.owner!=='core'||x.version!==i+1||!new RegExp(`^${String(i+1).padStart(4,'0')}_.+\\.sql$`).test(x.name)||!digest(x.checksum))||!same(m.manifest,m.applied)||m.manifestHash!==hash(m.manifest)||m.appliedHash!==hash(m.applied)) throw Error('invalid migration evidence');
  if(!Array.isArray(v.events)||v.events.length!==12) throw Error('missing SQL events');
  for(const [k,kind] of ['read','list','mark'].entries()) for(let i=0;i<4;i++) {
   const event=v.events[k*4+i], patterns=kind==='mark'?[/^begin$/i,/^\s*update\s+brain\.file_locations\b/i,/^\s*select\s+deleted_at\b/i,/^commit$/i]:[/^\s*select\s+id,\s*file_id\b/i];
   if(event?.kind!==kind||event.iteration!==i||event.n!==fixture.rows-i||!Array.isArray(event.queries)||event.queries.length!==patterns.length||!event.queries.every((q,j)=>patterns[j].test(q.text))) throw Error('invalid SQL trace');
  }
  const map=new Map();
  for(const r of v.runs) {
   if(!['read','list','mark'].includes(r.kind)||map.has(r.kind)||!Array.isArray(r.samplesMs)||r.samplesMs.length!==3||r.samplesMs.some(n=>!Number.isFinite(n)||n<=0)||!Number.isFinite(r.medianMs)||Math.abs(median(r.samplesMs)-r.medianMs)>1e-9||!Array.isArray(r.sqlCounts)||r.sqlCounts.length!==3||r.sqlCounts.some(n=>n!==(r.kind==='mark'?4:1))||!Array.isArray(r.observations)||r.observations.length!==3||!Array.isArray(r.diagnostics)||r.diagnostics.length!==(r.kind==='mark'?2:1)||r.diagnostics.some(d=>typeof d.sql!=='string'||!d.sql||!Array.isArray(d.values)||!Array.isArray(d.explain)||!d.explain[0]?.Plan||!Number.isFinite(d.explain[0].Plan['Actual Total Time'])||!Number.isFinite(d.explain[0].Plan['Shared Hit Blocks']))||r.kind==='mark'&&(!/^\s*update\b/i.test(r.diagnostics[0].sql)||!/^\s*select\b/i.test(r.diagnostics[1].sql))) throw Error('invalid file-locations measurement');
   for(let i=0;i<3;i++) {const n=fixture.rows-i-1, o=r.observations[i]; if(o?.n!==n||!same(o.result,expected(r.kind,n))||!same(o.before,expectedLocation(n))||!same(o.after,expectedLocation(n,r.kind==='mark'?stamp:null))) throw Error('invalid oracle evidence');}
   map.set(r.kind,r);
  }
  return map;
 };
 const b=validate(base), c=validate(change);
 if(!same(base.migrations,change.migrations)||!same(base.before,change.before)||!same(base.after,change.after)||!same(base.matrix,change.matrix)) throw Error('incompatible oracle evidence');
 if(base.checkoutRevision.sha!=='eaff4ccd4de4932f8a899dd9c8d69277380f44f7'||base.checkoutRevision.dirty===true||base.artifacts.runner.sha256!==change.artifacts.runner.sha256||base.artifacts.lockSha256!==change.artifacts.lockSha256||['node','postgres','platform','arch','cpus'].some(k=>base.environment[k]!==change.environment[k])) throw Error('incompatible file-locations provenance');
 const rows=['read','list','mark'].map(kind=>{const x=b.get(kind),y=c.get(kind),ratio=y.medianMs/x.medianMs, index=y.diagnostics.every(d=>indexScan(d.explain[0].Plan,kind==='list'?'file_id':'id')); const equal=same(x.observations,y.observations); return {kind,ratio,index,equal,sqlCounts:{base:x.sqlCounts,change:y.sqlCounts},pass:equal&&index&&(kind==='list'||ratio<=0.5)};});
 return {scenario:'file-locations',pass:rows.every(r=>r.pass),rows,provenance:{base:{checkoutRevision:base.checkoutRevision,artifacts:base.artifacts},change:{checkoutRevision:change.checkoutRevision,artifacts:change.artifacts}}};
}
