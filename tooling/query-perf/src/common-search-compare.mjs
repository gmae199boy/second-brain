import { schemaEvidenceValid } from './common-search-schema.mjs';
import { median } from './core.mjs';
import { PROCEDURE, TARGETS, ginInventory, AUTO_SETTINGS, settingsValid, requiredSessionSettings, sameStateConfig } from './common-search-protocol.mjs';

const keys = ['chunks/common', 'chunks/a', 'chunks/missing', 'tools/common', 'tools/a', 'tools/missing'];
const BASELINE='d6a0b4b614daa1c321c735a2ca09aab27d78e193';
const sha = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const measure = value => {
 if (!Array.isArray(value?.samplesMs) || value.samplesMs.length !== 3 || value.samplesMs.some(n => !Number.isFinite(n) || n <= 0) || !Number.isFinite(value.medianMs) || Math.abs(median(value.samplesMs) - value.medianMs) > 1e-9) throw Error('invalid common-search samples');
};
const validTime = v => v && typeof v.startedAt==='string' && /Z$/.test(v.startedAt) && typeof v.finishedAt==='string' && /Z$/.test(v.finishedAt) && Number.isFinite(Date.parse(v.startedAt)) && Number.isFinite(Date.parse(v.finishedAt)) && Date.parse(v.startedAt)<=Date.parse(v.finishedAt);
const validSnapshot = s => typeof s?.at==='string' && /Z$/.test(s.at) && Number.isFinite(Date.parse(s.at)) && Array.isArray(s.loadAverage) && s.loadAverage.length===3 && s.loadAverage.every(n=>Number.isFinite(n) && n>=0) && Array.isArray(s.processes) && s.processes.every(p=>typeof p==='string');
const validLocale = l => l && ['c','i','b'].includes(l.provider) && typeof l.collate==='string' && l.collate.length>0 && typeof l.ctype==='string' && l.ctype.length>0 && (l.locale===null || typeof l.locale==='string' && l.locale.length>0) && (l.version===null || typeof l.version==='string' && l.version.length>0) && (l.provider==='c' || typeof l.locale==='string' && l.locale.length>0);
const validPlan = value => {
 if(!Array.isArray(value)||value.length!==1 || !value[0]?.Plan || !Number.isFinite(value[0]['Execution Time']) || value[0]['Execution Time']<0) return false;
 const plan=value[0].Plan;
 return ['Plan Rows','Actual Rows','Actual Total Time','Shared Hit Blocks','Shared Read Blocks','Shared Dirtied Blocks','Shared Written Blocks'].every(key=>Number.isFinite(plan[key]) && plan[key]>=0);
};
const eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const utc=s=>typeof s==='string' && /Z$/.test(s) && Number.isFinite(Date.parse(s));
const timeAt=s=>Date.parse(s);
const APP=['shared_buffers','work_mem','jit','max_parallel_workers_per_gather','effective_cache_size','random_page_cost','seq_page_cost','parallel_setup_cost','parallel_tuple_cost','min_parallel_table_scan_size','min_parallel_index_scan_size','max_parallel_workers','max_worker_processes','server_encoding','TimeZone','lock_timeout','statement_timeout'];
const validState=s=>s && utc(s.at) && utc(s.finishedAt) && timeAt(s.at)<=timeAt(s.finishedAt) && Array.isArray(s.tables) && s.tables.length===4 && eq(s.tables.map(x=>x.relname),TARGETS) && s.tables.every(x=>Number.isSafeInteger(x.count)&&x.count>=0&&(x.reloptions===null||Array.isArray(x.reloptions))) && settingsValid(s.settings,AUTO_SETTINGS) && requiredSessionSettings(s.settings) && ginInventory(s.indexes)!==null;
const validPreparation = p => {
 if(!p || Object.entries(PROCEDURE).some(([k,v])=>!eq(p[k],v)) || p.ready!==true || typeof p.support?.supported!=='boolean' || (p.support.supported ? p.support.reason!==null : !['0A000','42501','58P01','42704'].includes(p.support.reason))) return false;
 if(!Array.isArray(p.vacuum)||p.vacuum.length!==4 || p.vacuum.some((v,i)=>v.table!==TARGETS[i] || v.success!==true || !validTime(v) || !Number.isFinite(v.ms) || v.ms<0)) return false;
 if(!validState(p.pre)||!validState(p.post)||!sameStateConfig(p.pre,p.post)) return false;
 if(!eq(p.pre.tables.map(x=>[x.relname,x.count]),p.post.tables.map(x=>[x.relname,x.count]))) return false;
 if(p.support.supported && p.post.indexes.some(x=>x.pending?.pending_pages!==0 || String(x.pending?.pending_tuples)!=='0')) return false;
 const ordered=[{startedAt:p.pre.at,finishedAt:p.pre.finishedAt},...p.vacuum,{startedAt:p.post.at,finishedAt:p.post.finishedAt}];
 return ordered.every((v,i)=>!i || timeAt(ordered[i-1].finishedAt)<=timeAt(v.startedAt));
};
const validCostMetric = v => {try {measure(v);} catch {return false;} return validTime(v.warmup) && Array.isArray(v.samples) && v.samples.length===3 && v.samples.every((s,i)=>validTime(s) && s.ms===v.samplesMs[i]);};
const validStats=stats=>stats && stats.stage==='complete' && Array.isArray(stats.definitions) && stats.definitions.length===0 && Array.isArray(stats.distributions) && stats.distributions.length===0;
const appRole=role=>role?.current_user==='brain_app' && role?.session_user==='brain_app';
const validDiagnostic=d=>{
 if(!validTime(d) || !Array.isArray(d.resources) || d.resources.length!==1 || d.resources.some(x=>x.label!=='cost'||!validTime(x)||!x.created||!x.deleted||!/^qp_[a-f0-9]{20}$/.test(x.database)) || !validPreparation(d.cost?.setup?.preparation) || d.upgrade!==undefined) return false;
 const w=d.cost.write,a=d.cost.analyze;
 return validStats(d.cost.statisticsBefore) && validStats(d.cost.statisticsAfter) && validCostMetric(w) && validCostMetric(a) && w.sqlCount===5 && w.rowsPerTable===1000 && w.triggerMode==='origin' && eq(w.before,w.after) && sha(w.hash) && w.hash===w.afterHash && a.sqlCount===4 && eq(a.targets,TARGETS) && !!a.pre && !!a.post;
};
export function compareCommonSearch(base, change) {
 const validate = r => {
  if (r?.scenario !== 'common-search' || r.status !== 'ok' || r.fixture?.rows !== 100000 || r.fixture?.bodyBytes !== 1024 || r.fixture?.chunkSessions !== 20 || r.fixture?.toolSessions !== 1 || r.fixture?.limit !== 5 || r.fixture?.recipeVersion!==2 || !r.fixture?.fields || !sha(r.fixture?.sha256)) throw Error('invalid common-search fixture');
  const rev = r.checkoutRevision;
  if (!/^[a-f0-9]{40}$/.test(rev?.sha ?? '') || !(rev.dirty === null && rev.diffSha256 === null || typeof rev.dirty === 'boolean' && sha(rev.diffSha256)) || !sha(r.artifacts?.sha256) || !sha(r.artifacts?.lockSha256) || !sha(r.artifacts?.runner?.sha256)) throw Error('invalid common-search provenance');
  if (!appRole(r.environment?.role) || !sha(r.environment?.hostIdentity) || !/^\d+$/.test(r.environment?.systemIdentifier ?? '') || !r.environment?.node || !r.environment?.postgres || !r.environment?.platform || !r.environment?.arch || !Number.isSafeInteger(r.environment?.cpus) || r.environment.cpus < 1 || !settingsValid(r.environment.settings,APP) || !requiredSessionSettings(r.environment.settings) || !validLocale(r.environment.locale) || !['setupStart','setupEnd','measurementStart','measurementEnd'].every(k=>validSnapshot(r.snapshots?.[k])) || !validTime(r) || Date.parse(r.finishedAt)<Date.parse(r.startedAt) || !r.resources?.created || !r.resources?.deleted) throw Error('invalid common-search environment');
  const snapshotTimes=['setupStart','setupEnd','measurementStart','measurementEnd'].map(k=>Date.parse(r.snapshots[k].at));
  if(snapshotTimes[0]<Date.parse(r.startedAt) || snapshotTimes.some((t,i)=>i>0 && t<snapshotTimes[i-1]) || snapshotTimes[3]>Date.parse(r.finishedAt)) throw Error('invalid common-search snapshot order');
  const map = new Map();
  if (!Array.isArray(r.runs)) throw Error('missing common-search conditions');
  let previous=snapshotTimes[2];
  for (const [index,v] of r.runs.entries()) {
   const key = `${v.kind}/${v.condition}`;
   if (!keys.includes(key) || map.has(key) || !sha(v.resultHash) || !sha(v.storeHash) || !sha(v.oracleHash) || !sha(v.fixedHash) || v.oracleHash!==v.fixedHash || v.oracleMatch!==true || v.fixedMatch!==true || !validPlan(v.explain) || !validTime(v.timings?.warmup) || !validTime(v.timings?.explain) || !['wall','diagnostics','store'].every(k=>Array.isArray(v.timings?.[k]) && v.timings[k].length===3 && v.timings[k].every(validTime)) || !Array.isArray(v.sqlSamples) || v.sqlSamples.length !== 3 || v.sqlSamples.some(s => !Number.isSafeInteger(s.count) || s.count < 1 || !Number.isFinite(s.totalMs) || s.totalMs < 0 || !Array.isArray(s.spansMs) || s.spansMs.length!==s.count || s.spansMs.some(n=>!Number.isFinite(n)||n<0) || Math.abs(s.spansMs.reduce((a,b)=>a+b,0)-s.totalMs)>1e-6 || !Array.isArray(s.spans) || s.spans.length!==s.count || s.spans.some((v,i)=>!sha(v.sqlSha256) || typeof v.search!=='boolean' || v.ms!==s.spansMs[i]) || !s.spans.some(v=>v.search) || !Number.isFinite(s.searchMs) || Math.abs(s.searchMs-s.spans.filter(v=>v.search).reduce((a,v)=>a+v.ms,0))>1e-6)) throw Error('invalid common-search condition');
   if(key!==keys[index]) throw Error('invalid common-search condition order');
   for(const span of [v.timings.warmup,...v.timings.wall,...v.timings.diagnostics,...v.timings.store,v.timings.explain]) {
    if(Date.parse(span.startedAt)<previous || Date.parse(span.finishedAt)>snapshotTimes[3]) throw Error('invalid common-search timing order');
    previous=Date.parse(span.finishedAt);
   }
   measure(v.wall); measure(v.storeWall); map.set(key, v);
  }
  if (map.size !== keys.length) throw Error('missing common-search conditions');
  const auxiliary=new Map();
  if(!Array.isArray(r.auxiliary)) throw Error('missing auxiliary evidence');
  for(const v of r.auxiliary) {
   if(!['chunks','tools'].includes(v.kind) || auxiliary.has(v.kind) || !sha(v.resultHash) || !sha(v.oracleHash) || v.oracleHash!==v.fixedHash || v.truncated!==true || v.masked!==true || v.hasMore!==true || v.omitted!==4 || v.nextVerified!==true || v.metadataVerified!==true || !Number.isSafeInteger(v.jsonSize) || v.jsonSize<1 || v.jsonSize>8000) throw Error('invalid auxiliary evidence');
   auxiliary.set(v.kind,v);
  }
  if(auxiliary.size!==2) throw Error('missing auxiliary evidence');
  return {map,auxiliary};
 };
 const {map:b,auxiliary:ba}=validate(base), {map:c,auxiliary:ca}=validate(change);
 for(const [r,version] of [[base,39],[change,47]]) {
  if(!schemaEvidenceValid(r.migration?.schema,version,r.migration?.value?.to) || !schemaEvidenceValid(r.diagnostic?.cost?.setup?.schema,version,r.diagnostic?.cost?.setup?.migration?.to) || !eq(r.migration.schema,r.diagnostic.cost.setup.schema)) throw Error('invalid schema provenance');
  if(!validPreparation(r.preparation) || !validDiagnostic(r.diagnostic) || !validTime(r.migration) || !validStats(r.statistics)) throw Error('invalid protocol 2 or diagnostics');
  const cost=r.diagnostic.cost, cp=cost.setup.preparation, w=cost.write,a=cost.analyze;
  const expected=[r.fixture.chunkSessions+r.fixture.toolSessions,r.fixture.rows,r.fixture.rows,r.fixture.rows];
  const countsMatch=s=>eq(s.tables.map(t=>t.count),expected);
  if(![r.preparation.pre,r.preparation.post,cp.pre,cp.post,a.pre,a.post].every(countsMatch) || !['chunks','messages','tool_notes'].every(k=>w.before?.[k]===r.fixture.rows && w.after?.[k]===r.fixture.rows)) throw Error('incompatible fixture counts');
  if(cp.support.supported!==r.preparation.support.supported || !sameStateConfig(r.preparation.post,cp.pre) || !validState(a.pre)||!validState(a.post)||!sameStateConfig(cp.post,a.pre)||!sameStateConfig(a.pre,a.post)) throw Error('incompatible diagnostic readiness');
  const spans=[{startedAt:cp.pre.at,finishedAt:cp.pre.finishedAt},...cp.vacuum,{startedAt:cp.post.at,finishedAt:cp.post.finishedAt},w.warmup,...w.samples,{startedAt:a.pre.at,finishedAt:a.pre.finishedAt},a.warmup,...a.samples,{startedAt:a.post.at,finishedAt:a.post.finishedAt}];
  const resources=r.diagnostic.resources;
  if(timeAt(r.diagnostic.startedAt)<timeAt(r.snapshots.measurementEnd.at)||timeAt(r.diagnostic.finishedAt)>timeAt(r.finishedAt)||timeAt(resources[0].startedAt)<timeAt(r.diagnostic.startedAt)||timeAt(cp.pre.at)<timeAt(resources[0].startedAt)||timeAt(a.post.finishedAt)>timeAt(resources[0].finishedAt)||timeAt(resources.at(-1).finishedAt)>timeAt(r.diagnostic.finishedAt)) throw Error('invalid diagnostic resource timing');
  if(spans.some((v,i)=>!validTime(v)||timeAt(v.startedAt)<timeAt(r.snapshots.measurementEnd.at)||timeAt(v.finishedAt)>timeAt(r.finishedAt)||(i>0 && timeAt(spans[i-1].finishedAt)>timeAt(v.startedAt)))) throw Error('invalid diagnostic timing order');
  if(timeAt(r.preparation.pre.at)<timeAt(r.startedAt)||timeAt(r.preparation.post.finishedAt)>timeAt(r.snapshots.measurementStart.at)) throw Error('preparation overlaps measurement');
 }
 if(base.preparation.support.supported!==change.preparation.support.supported || !eq(base.preparation.post.tables.map(x=>[x.relname,x.count]),change.preparation.post.tables.map(x=>[x.relname,x.count])) || !sameStateConfig(base.preparation.post,change.preparation.post)) throw Error('incompatible protocol 2 readiness');
 if(Date.parse(base.finishedAt)>Date.parse(change.startedAt)) throw Error('overlapping common-search runs');
 if(base.checkoutRevision.sha!==BASELINE || !(base.checkoutRevision.dirty===null && base.checkoutRevision.diffSha256===null || base.checkoutRevision.dirty===false && sha(base.checkoutRevision.diffSha256))) throw Error('invalid common-search baseline');
 if (JSON.stringify(base.fixture)!==JSON.stringify(change.fixture) || base.artifacts.runner.sha256!==change.artifacts.runner.sha256 || base.artifacts.lockSha256!==change.artifacts.lockSha256 || JSON.stringify(base.environment.role)!==JSON.stringify(change.environment.role) || JSON.stringify(base.environment.settings)!==JSON.stringify(change.environment.settings) || JSON.stringify(base.environment.locale)!==JSON.stringify(change.environment.locale) || ['node','postgres','platform','arch','cpus','hostIdentity','systemIdentifier'].some(k=>base.environment[k]!==change.environment[k])) throw Error('incompatible common-search provenance');
 const rows=keys.map(key=>{
  const x=b.get(key), y=c.get(key), ratio=y.wall.medianMs/x.wall.medianMs, limit=key.endsWith('/common')?0.5:1;
  const equal=x.resultHash===y.resultHash && x.storeHash===y.storeHash && x.oracleHash===y.oracleHash && x.fixedHash===y.fixedHash;
  return {condition:key,ratio,limit,equal,pass:equal && ratio<=limit};
 });
 const auxiliaryEqual=['chunks','tools'].every(k=>['resultHash','oracleHash','fixedHash','jsonSize'].every(key=>ba.get(k)[key]===ca.get(k)[key]));
 return {scenario:'common-search',pass:rows.every(row=>row.pass) && auxiliaryEqual,auxiliaryEqual,rows,provenance:{base:{checkoutRevision:base.checkoutRevision,artifacts:base.artifacts,environment:base.environment,migration:base.migration,preparation:base.preparation,statistics:base.statistics,diagnostic:base.diagnostic},change:{checkoutRevision:change.checkoutRevision,artifacts:change.artifacts,environment:change.environment,migration:change.migration,preparation:change.preparation,statistics:change.statistics,diagnostic:change.diagnostic}}};
}
