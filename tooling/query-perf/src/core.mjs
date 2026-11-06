export const sanitize = value => String(value).replace(/postgres(?:ql)?:\/\/[^\s]+/gi,'[database-url]').replace(/(?:\/Users\/|\/home\/)[^\s]+/g,'[home-path]');
import { createHash } from 'node:crypto';
export function median(values) { if (!values.length) throw Error('empty samples'); const a = [...values].sort((x,y)=>x-y); const i = Math.floor(a.length/2); return a.length%2 ? a[i] : (a[i-1]+a[i])/2; }
export function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function parseArgs(args) {
  const [command,...rest] = args;
  if (command === 'compare') { if (rest.length !== 2 || rest.some(x=>x.startsWith('--'))) throw Error('compare requires two JSON files'); return {command, base:rest[0], change:rest[1]}; }
  if (command === 'session-snapshot') {
    const opts={command}; const keys={'--checkout':'checkout','--database-url':'databaseUrl','--out':'out'}; const seen=new Set();
    for(let i=0;i<rest.length;i+=2) { const key=keys[rest[i]]; if(!key||seen.has(key)||!rest[i+1]||rest[i+1].startsWith('--')) throw Error('invalid option'); seen.add(key); opts[key]=rest[i+1]; }
    if(!opts.checkout||!opts.databaseUrl||!opts.out) throw Error('checkout, database-url and out are required');
    return opts;
  }
  if (command !== 'import-cleanup') throw Error('unknown command');
  const opts = {command, sizes:[1000,10000,100000], candidate:'none', queryVariant:'original'};
  const keys = {'--checkout':'checkout','--database-url':'databaseUrl','--out':'out','--sizes':'sizes','--candidate':'candidate','--query-variant':'queryVariant'};
  const seen = new Set();
  for (let i=0;i<rest.length;i+=2) { const key=keys[rest[i]]; if (!key || seen.has(key) || !rest[i+1] || rest[i+1].startsWith('--')) throw Error('invalid option'); seen.add(key); opts[key]=rest[i+1]; }
  if (!opts.checkout || !opts.databaseUrl || !opts.out) throw Error('checkout, database-url and out are required');
  if (typeof opts.sizes === 'string') opts.sizes=opts.sizes.split(',').map(Number);
  if (!opts.sizes.length || opts.sizes.some(n=>!Number.isSafeInteger(n)||n<100) || new Set(opts.sizes).size!==opts.sizes.length) throw Error('invalid sizes');
  if (!['none','locator','open','both'].includes(opts.candidate) || !['original','rewritten'].includes(opts.queryVariant)) throw Error('invalid candidate or query variant');
  return opts;
}
export function compare(base, change) {
  if (base?.scenario === 'session-snapshot' || change?.scenario === 'session-snapshot') return compareSnapshot(base, change);
  if(base?.scenario!=='import-cleanup' || change?.scenario!=='import-cleanup' || base.candidate!==change.candidate || base.queryVariant!==change.queryVariant || !['none','locator','open','both'].includes(base.candidate) || !['original','rewritten'].includes(base.queryVariant)) throw Error('incompatible result provenance');
  const measurement=(v)=>{ if(!v || !Array.isArray(v.samplesMs) || v.samplesMs.length!==3 || v.samplesMs.some(n=>!Number.isFinite(n)||n<0) || !Number.isFinite(v.medianMs) || v.medianMs<0) throw Error('invalid measurement'); const m=median(v.samplesMs); if(Math.abs(m-v.medianMs)>1e-9) throw Error('median mismatch'); return m; };
  const key = r=>`${r.size}/${r.condition}`;
  const makeMap=(input)=>{
    if (!Array.isArray(input?.runs)) throw Error('invalid runs');
    const map=new Map();
    for(let r of input.runs) {
      if (!Number.isSafeInteger(r.size) || r.size<0 || typeof r.condition!=='string' || !/^[0-9a-f]{64}$/i.test(r.hash ?? '') || !Number.isSafeInteger(r.rowCount) || r.rowCount<0 || !Number.isFinite(r.medianMs) || r.medianMs<0 || !Array.isArray(r.samplesMs) || r.samplesMs.length!==3 || r.samplesMs.some(v=>!Number.isFinite(v)||v<0)) throw Error('invalid run');
      const measured=measurement(r); if(r.condition==='shared100') { measurement(r.cleanup); if(r.cleanup.cleaned!==false || r.cleanup.removeCalled!==false) throw Error('shared cleanup not verified'); }
      measurement(r.unhanded); if(!/^[0-9a-f]{64}$/i.test(r.unhanded.hash??'') || !Number.isSafeInteger(r.unhanded.rowCount) || r.unhanded.rowCount<0) throw Error('invalid unhanded result');
      r={...r,medianMs:measured,cleanup:r.cleanup?{...r.cleanup,medianMs:measurement(r.cleanup)}:undefined,unhanded:{...r.unhanded,medianMs:measurement(r.unhanded)}};
      const k=key(r); if(map.has(k)) throw Error(`duplicate run: ${k}`); map.set(k,r);
    }
    return map;
  };
  const b=makeMap(base), c=makeMap(change);
  const requiredKeys=[1000,10000,100000].flatMap(n=>['idle','pending100','shared100'].map(condition=>`${n}/${condition}`));
  const required={base:requiredKeys.filter(k=>!b.has(k)),change:requiredKeys.filter(k=>!c.has(k))};
  const extra={base:[...b.keys()].filter(k=>!requiredKeys.includes(k)),change:[...c.keys()].filter(k=>!requiredKeys.includes(k))};
  const keys=[...new Set([...b.keys(),...c.keys()])].sort();
  const rows=keys.map(k=>{ const x=b.get(k), y=c.get(k); const ratio=x&&y&&x.medianMs>0 ? y.medianMs/x.medianMs : null; const equal=!!x&&!!y&&x.hash===y.hash&&x.rowCount===y.rowCount; const limit=k==='100000/pending100'?0.5:k.endsWith('/idle')?1.1:null; const unhandedEqual=!!x&&!!y&&x.unhanded.hash===y.unhanded.hash&&x.unhanded.rowCount===y.unhanded.rowCount; const unhandedRatio=x&&y&&x.unhanded.medianMs>0?y.unhanded.medianMs/x.unhanded.medianMs:null; const cleanupRatio=k.endsWith('/shared100') && x?.cleanup?.medianMs>0 && y?.cleanup ? y.cleanup.medianMs/x.cleanup.medianMs : null; return {condition:k,equal,ratio,cleanupRatio,unhandedEqual,unhandedRatio,limit,pass:equal && unhandedEqual && (limit===null || (ratio!==null && ratio<=limit))}; });
  const provenance=v=>({checkoutRevision:v.checkoutRevision,artifacts:v.artifacts,node:v.environment?.node,postgres:v.environment?.postgres,loadAverageStart:v.environment?.loadAverageStart,loadAverageEnd:v.environment?.loadAverageEnd});
  return {provenance:{base:provenance(base),change:provenance(change)},pass:!required.base.length&&!required.change.length&&!extra.base.length&&!extra.change.length&&rows.every(r=>r.pass),rows,required,extra};
}

export function compareSnapshot(base, change) {
  if(base?.scenario!=='session-snapshot'||change?.scenario!=='session-snapshot'||base.fixture?.rows!==100000||base.fixture?.bodyBytes!==1024||base.fixture?.groupSize!==20||base.fixture?.chunkCount!==5000||JSON.stringify(base.fixture)!==JSON.stringify(change.fixture)) throw Error('incompatible snapshot fixture');
  if(!/^[a-f0-9]{64}$/.test(base.artifacts?.runner?.sha256??'')||base.artifacts.runner.sha256!==change.artifacts?.runner?.sha256||!base.environment?.node||!base.environment?.postgres||base.environment.node!==change.environment?.node||base.environment.postgres!==change.environment?.postgres||!base.environment?.platform||!base.environment?.arch||base.environment.platform!==change.environment?.platform||base.environment.arch!==change.environment?.arch||!Number.isSafeInteger(base.environment?.cpus)||base.environment.cpus<1||base.environment.cpus!==change.environment?.cpus) throw Error('incompatible snapshot provenance');
  const check=r=>{
    const rev=r.checkoutRevision, validRevision=rev && (rev.dirty===null&&rev.diffSha256===null || typeof rev.dirty==='boolean'&&/^[a-f0-9]{64}$/.test(rev.diffSha256??''));
    if(!/^[a-f0-9]{40}$/.test(rev?.sha??'')||!validRevision||!/^[a-f0-9]{64}$/.test(r.artifacts?.sha256??'')||!/^[a-f0-9]{64}$/.test(r.artifacts?.lockSha256??'')||!r.results||r.results.staleCommitted!==false||r.results.rowCount!==100000||r.results.oracleMatch!==true||!/^sha256:[a-f0-9]{64}$/.test(r.results.fingerprint??'')||!/^sha256:[a-f0-9]{64}$/.test(r.results.staleFingerprint??'')||r.results.staleFingerprint===r.results.fingerprint||!['chunksHash','changedChunksHash','configHash','messagesHash'].every(k=>/^[a-f0-9]{64}$/.test(r.results[k]??''))) throw Error('invalid snapshot results');
    for(const k of ['readTransaction','commitTransaction','lockHeld','initialWrite','changedWrite','advisoryWait']) { const v=r.measurements?.[k]; if(!Array.isArray(v?.samplesMs)||v.samplesMs.length!==3||v.samplesMs.some(n=>!Number.isFinite(n)||n<=0)||!Number.isFinite(v.medianMs)||Math.abs(median(v.samplesMs)-v.medianMs)>1e-9) throw Error('invalid snapshot measurement'); }
    if(!Number.isSafeInteger(r.measurements?.probe?.pid)||r.measurements.probe.pid<=0||r.measurements.probe.confirmedWaits!==3||r.measurements.probe.sampleCount!==3) throw Error('unconfirmed advisory contention');
  };
  check(base); check(change);
  if(base.artifacts.lockSha256!==change.artifacts.lockSha256) throw Error('incompatible lockfile');
  const equal=['fingerprint','staleFingerprint','chunksHash','changedChunksHash','rowCount','staleCommitted','configHash','messagesHash'].every(k=>base.results[k]!==undefined&&base.results[k]===change.results[k]);
  const ratios=Object.fromEntries(['readTransaction','commitTransaction','lockHeld'].map(k=>[k,change.measurements[k].medianMs/base.measurements[k].medianMs]));
  const writeRatios=Object.fromEntries(['initialWrite','changedWrite'].map(k=>[k,change.measurements[k].medianMs/base.measurements[k].medianMs]));
  return {scenario:'session-snapshot',equal,ratios,writeRatios,pass:equal&&Object.values(ratios).every(n=>n<=0.5),provenance:{base:{checkoutRevision:base.checkoutRevision,artifacts:base.artifacts},change:{checkoutRevision:change.checkoutRevision,artifacts:change.artifacts}}};
}

export function candidateConflict(candidate, indexes) {
  return indexes.find(i =>
    (candidate === 'locator' || candidate === 'both') && i.table_name === 'file_requests' && JSON.stringify(i.columns) === JSON.stringify(['source','locator']) && i.predicate === null ||
    (candidate === 'open' || candidate === 'both') && i.table_name === 'file_import_cleanup' && JSON.stringify(i.columns) === JSON.stringify(['request_id']) && i.predicate?.replace(/[()\s]/g,'').toLowerCase() === 'cleaned_atisnull'
  );
}
