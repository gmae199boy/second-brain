import { schemaEvidenceValid } from './common-search-schema.mjs';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { median, hash, sanitize } from './core.mjs';

export const TARGETS=['sessions','messages','chunks','tool_notes'];
export const PROCEDURE={protocolVersion:2,targets:TARGETS,command:'VACUUM (ANALYZE)',transaction:'outside',timezone:'UTC',lockTimeout:'0',statementTimeout:'0',readinessCriterion:'vacuum-success-counts-unchanged-pending-zero-if-supported'};
const at=()=>new Date().toISOString();
const span=async(action)=>{const startedAt=at(), start=performance.now(); const value=await action(); return {startedAt,finishedAt:at(),ms:performance.now()-start,value};};
const metric=samples=>({samplesMs:samples.map(x=>x.ms),medianMs:median(samples.map(x=>x.ms)),samples});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const REQUIRED_GIN={chunks_body_idx:'chunks',tool_notes_target_idx:'tool_notes'};
export function ginInventory(indexes) {
 if(!Array.isArray(indexes)||indexes.length===0) return null;
 const seen=new Set();
 for(const index of indexes) {
  if(typeof index?.relname!=='string'||typeof index.table_name!=='string'||seen.has(index.relname)||!(index.reloptions===null||Array.isArray(index.reloptions))) return null;
  seen.add(index.relname);
 }
 for(const [name,table] of Object.entries(REQUIRED_GIN)) if(!indexes.some(x=>x.relname===name && x.table_name===table)) return null;
 return indexes.map(x=>[x.relname,x.table_name,x.reloptions]).sort((a,b)=>a[0].localeCompare(b[0]));
}


export const AUTO_SETTINGS=['autovacuum','autovacuum_analyze_scale_factor','autovacuum_vacuum_scale_factor','autovacuum_naptime','TimeZone','lock_timeout','statement_timeout'];
export const settingsValid=(rows,names)=>Array.isArray(rows) && names.every(name=>rows.filter(x=>x.name===name && typeof x.setting==='string' && (typeof x.unit==='string'||x.unit===null)).length===1);
export const requiredSessionSettings=rows=>['TimeZone','lock_timeout','statement_timeout'].every((name,i)=>rows?.find(x=>x.name===name)?.setting===['UTC','0','0'][i]);
export const sameStateConfig=(a,b)=>same(a.tables.map(x=>[x.relname,x.reloptions]),b.tables.map(x=>[x.relname,x.reloptions])) && same(a.settings,b.settings) && same(ginInventory(a.indexes),ginInventory(b.indexes));
const validReadySnapshot=s=>Array.isArray(s?.tables) && s.tables.length===TARGETS.length && s.tables.every((t,i)=>t.relname===TARGETS[i] && Number.isSafeInteger(t.count) && t.count>=0 && (t.reloptions===null||Array.isArray(t.reloptions))) && settingsValid(s.settings,AUTO_SETTINGS) && requiredSessionSettings(s.settings);

// Only expected extension availability/privilege errors mean unsupported; connection errors fail preparation.
export async function pendingSupport(client) {
 try { await client.query('create extension if not exists pgstattuple'); return {supported:true,reason:null}; }
 catch(e) { if(['0A000','42501','58P01','42704'].includes(e.code)) return {supported:false,reason:String(e.code)}; throw e; }
}
const failureInfo=e=>({message:sanitize(e?.message ?? String(e)),...(e?.code?{code:String(e.code)}:{})});
const emptySnapshot=()=>({at:at(),tables:[],indexes:[],settings:null,activity:null,locks:null,stage:'start',statsLimit:'pg_stat counters and timestamps may be delayed or null; no forced flush'});
export async function preparationSnapshot(client,support,snapshot=emptySnapshot()) {
 for(const table of TARGETS) {
  snapshot.stage=`table:${table}:count`;
  const counts=(await client.query(`select count(*)::int as count from brain.${table}`)).rows[0];
  // Save the count before the second query can fail.
  const entry={relname:table,...counts}; snapshot.tables.push(entry);
  snapshot.stage=`table:${table}:relation`;
  const info=(await client.query(`select c.relname,pg_relation_size(c.oid)::text as bytes,pg_total_relation_size(c.oid)::text as total_bytes,c.reloptions,
   s.last_vacuum,s.last_autovacuum,s.last_analyze,s.last_autoanalyze,s.vacuum_count::text,s.autovacuum_count::text,s.analyze_count::text,s.autoanalyze_count::text
   from pg_class c join pg_namespace n on n.oid=c.relnamespace left join pg_stat_user_tables s on s.relid=c.oid where n.nspname='brain' and c.relname=$1`,[table])).rows[0];
  Object.assign(entry,info);
 }
 snapshot.stage='indexes';
 snapshot.indexes=(await client.query(`select c.oid::regclass::text as name,c.relname, t.relname as table_name,pg_relation_size(c.oid)::text as bytes,c.reloptions
 from pg_index i join pg_class c on c.oid=i.indexrelid join pg_class t on t.oid=i.indrelid join pg_namespace n on n.oid=t.relnamespace join pg_am a on a.oid=c.relam
 where n.nspname='brain' and t.relname=any($1::text[]) and a.amname='gin' order by c.relname`,[TARGETS])).rows;
 if(support.supported) for(const index of snapshot.indexes) {snapshot.stage=`pending:${index.relname}`; index.pending=(await client.query('select pending_pages,pending_tuples from pgstatginindex($1::regclass)',[index.name])).rows[0];}
 snapshot.stage='settings'; snapshot.settings=(await client.query("select name,setting,unit from pg_settings where name in ('autovacuum','autovacuum_analyze_scale_factor','autovacuum_vacuum_scale_factor','autovacuum_naptime','TimeZone','lock_timeout','statement_timeout') order by name")).rows;
 snapshot.stage='activity'; snapshot.activity=(await client.query("select pid,backend_type,state,wait_event_type,wait_event from pg_stat_activity where datname=current_database() order by pid")).rows;
 snapshot.stage='locks'; snapshot.locks=(await client.query("select locktype,mode,granted,count(*)::int as count from pg_locks where database=(select oid from pg_database where datname=current_database()) group by locktype,mode,granted order by locktype,mode,granted")).rows;
 snapshot.stage='complete'; snapshot.finishedAt=at(); return snapshot;
}
export async function prepareProtocol(client,onProgress=()=>{}) {
 const result={...PROCEDURE,support:null,pre:null,vacuum:[],post:null,ready:false,stage:'support'}; onProgress(result);
 try {
  result.support=await pendingSupport(client);
  result.stage='pre'; result.pre=emptySnapshot(); await preparationSnapshot(client,result.support,result.pre);
  result.stage='vacuum';
  for(const table of TARGETS) {
   const startedAt=at(), start=performance.now();
   try {await client.query(`VACUUM (ANALYZE) brain.${table}`); result.vacuum.push({table,startedAt,finishedAt:at(),ms:performance.now()-start,success:true});}
   catch(error) {result.vacuum.push({table,startedAt,finishedAt:at(),ms:performance.now()-start,success:false,code:error.code??null}); throw error;}
  }
  result.stage='post'; result.post=emptySnapshot(); await preparationSnapshot(client,result.support,result.post);
  result.stage='ready'; const beforeGin=ginInventory(result.pre.indexes), afterGin=ginInventory(result.post.indexes);
  result.ready=Boolean(beforeGin && afterGin && validReadySnapshot(result.pre) && validReadySnapshot(result.post) && sameStateConfig(result.pre,result.post)) && same(result.pre.tables.map(x=>[x.relname,x.count]),result.post.tables.map(x=>[x.relname,x.count])) && (!result.support.supported || result.post.indexes.every(x=>x.pending?.pending_pages===0 && String(x.pending?.pending_tuples)==='0'));
  if(!result.ready) throw Error('protocol 2 preparation not ready');
  result.stage='complete'; return result;
 } catch(error) {result.failure=failureInfo(error); error.preparation=result; throw error;}
}
export async function statistics(client,result={}) {
 result.stage='definitions'; result.definitions=(await client.query(`select s.stxname, c.relname, pg_get_userbyid(s.stxowner) as owner,pg_get_expr(s.stxexprs,s.stxrelid) as expression,
 pg_column_size(s)::int as definition_logical_bytes,pg_column_size(d)::int as data_logical_bytes
 from pg_statistic_ext s join pg_class c on c.oid=s.stxrelid join pg_namespace n on n.oid=s.stxnamespace left join pg_statistic_ext_data d on d.stxoid=s.oid
 where n.nspname='brain' and s.stxname in ('chunks_lower_body_stats','tool_notes_lower_target_stats') order by s.stxname`)).rows;
 result.stage='distributions'; result.distributions=(await client.query(`select statistics_name,expr,null_frac,n_distinct,most_common_freqs from pg_stats_ext_exprs where schemaname='brain' and statistics_name in ('chunks_lower_body_stats','tool_notes_lower_target_stats') order by statistics_name`)).rows;
 result.bytesKind='catalog logical tuple bytes; not physical index size'; result.stage='complete'; return result;
}
const counts=async c=>(await c.query('select (select count(*)::int from brain.chunks) chunks,(select count(*)::int from brain.messages) messages,(select count(*)::int from brain.tool_notes) tool_notes')).rows[0];
const searchHash=async c=>hash((await c.query("select 'chunk' kind,id::text from brain.chunks where lower(body) like '%common%' union all select 'tool',id::text from brain.tool_notes where lower(target) like '%common%' order by kind,id")).rows);
const writeSql=[
 `insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) select md5('cost-chunk'||i)::uuid,md5('chunk-session'||((i-1)%20))::uuid,'019a0000-0000-7000-8000-000000000003','2030-01-01'::timestamptz+i*interval '1 second','2030-01-01'::timestamptz+i*interval '1 second',0,'common a '||repeat('x',1015) from generate_series(1,1000) i`,
 `insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) select md5('cost-message'||i)::uuid,'019a0000-0000-7000-8000-000000000101','cost-'||i,'user',repeat('x',1024),'2030-01-01'::timestamptz+i*interval '1 second' from generate_series(1,1000) i`,
 `insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) select md5('cost-tool'||i)::uuid,'019a0000-0000-7000-8000-000000000101','cost-'||i,0,'synthetic','common a '||repeat('x',1015),1 from generate_series(1,1000) i`];
async function writeBatch(c) { await c.query('begin'); let failure; try {for(const sql of writeSql) await c.query(sql);} catch(e) {failure=e;} try {await c.query('rollback');} catch(e) {if(failure) {const both=new AggregateError([failure,e],'write and rollback failed');both.code=failure.code??e.code;throw both;} throw e;} if(failure) throw failure; }
async function analyzeBatch(c) {for(const table of TARGETS) await c.query(`analyze brain.${table}`);}
// Publish mutable, synthetic-only evidence before each operation so failures retain progress.
export async function diagnostics({admin,Client,url,api,schema,fixture,size,assertConfig,checkoutConfig,options,onResource,onDiagnostic,onProgress}) {
 const resources=[], state={stage:'start',startedAt:at(),resources,cost:null}; onProgress?.(state);
 const sockets=[];
 const watch=(client,label)=>{client.on('error',error=>sockets.push({label,error}));return client;};
 const step=async(stage,action)=>{
  state.stage=stage; const startedAt=at(), start=performance.now(); state.active={stage,startedAt};
  try {const value=await action(); state.active=null; return {startedAt,finishedAt:at(),ms:performance.now()-start,value};}
  catch(error) {state.active={stage,startedAt,finishedAt:at(),ms:performance.now()-start,failure:failureInfo(error)}; throw error;}
 };
 const four=async(label,action,target)=>{
  target.warmup=await step(`${label}:warmup`,action); target.samples=[];
  for(let i=0;i<3;i++) target.samples.push(await step(`${label}:sample:${i+1}`,action));
  Object.assign(target,metric(target.samples));
 };
 const withDb=async(label,action)=>{
  const name=`qp_${randomBytes(10).toString('hex')}`, dburl=new URL(url); dburl.pathname='/'+name;
  const resource={label,database:name,startedAt:at(),created:false,deleted:false}; resources.push(resource); onResource?.(resources);
  let client, error, value; const failures=[]; const socketStart=sockets.length;
  try {
   await step(`${label}:create`,()=>admin.query(`create database "${name}"`)); resource.created=true;
   const result=(await step(`${label}:prepare-database`,()=>api.prepareDatabase({databaseUrl:dburl.toString(),databaseName:name,appPassword:'query-perf-only',maintenancePassword:'query-perf-only'}))).value;
   if(!result.ok) {const e=new Error(result.message);e.code=result.code;throw e;}
   client=watch(new Client({connectionString:dburl.toString(),connectionTimeoutMillis:10000,options}),`${label}:client`);
   await step(`${label}:connect`,()=>client.connect());
   if(onDiagnostic) await step(`${label}:hook`,()=>onDiagnostic({label,client,name}));
   if(sockets.length>socketStart) throw sockets[socketStart].error;
   value=await action(client,dburl.toString());
  } catch(e) {error=e;}
  if(client) try {await client.end();} catch(e){failures.push(e);}
  if(resource.created) try {await admin.query(`drop database "${name}" with (force)`);resource.deleted=true;} catch(e){failures.push(e);}
  resource.finishedAt=at();
  const all=[...(error?[error]:[]),...sockets.slice(socketStart).map(item=>item.error),...failures];
  if(all.length) {
   state.errors=all.map(failureInfo); if(error?.preparation) state.preparation=error.preparation;
   const aggregate=new AggregateError(all,`${label} diagnostic failed: ${all.map(e=>sanitize(e.message)).join('; ')}`);
   aggregate.code=all.find(e=>e.code)?.code; aggregate.diagnostic=state; if(error?.preparation) aggregate.preparation=error.preparation; throw aggregate;
  }
  return value;
 };
 const clock={now:()=>new Date('2026-01-01T00:00:00Z')};
 const migrate=async(dburl,extra={})=>{const r=await api.runMigrations({databaseUrl:dburl,clock,...extra}); if(!r.ok) {const e=new Error(r.message);e.code=r.code;throw e;} return r;};
 const setup=async(c,dburl,max,target,label)=>{
  target.migration=(await step(`${label}:migration`,()=>migrate(dburl,max?{coreMaxVersion:max}:{}))).value;
  target.schema=structuredClone(schema);
  if(api.CORE_SCHEMA_VERSION!==schema.version || !schemaEvidenceValid(target.schema,schema.version,target.migration.to)) throw Error('unexpected checkout schema');
  await step(`${label}:fixture-config`,()=>assertConfig(c,checkoutConfig));
  await step(`${label}:fixture`,()=>fixture(c,size));
  await step(`${label}:preparation`,()=>prepareProtocol(c,p=>{target.preparation=p;}));
 };
 try {
  state.cost={setup:{},write:{sqlCount:5,rowsPerTable:1000,triggerMode:'origin'},analyze:{targets:TARGETS,sqlCount:4}};
  await withDb('cost',async(c,dburl)=>{
   const cost=state.cost; await setup(c,dburl,undefined,cost.setup,'cost');
   cost.write.before=(await step('cost:counts-before',()=>counts(c))).value;
   cost.write.hash=(await step('cost:hash-before',()=>searchHash(c))).value;
   cost.statisticsBefore={}; await step('cost:statistics-before',()=>statistics(c,cost.statisticsBefore));
   if(cost.statisticsBefore.definitions.length!==0 || cost.statisticsBefore.distributions.length!==0) throw Error('unexpected diagnostic expression statistics');
   await four('cost:write',()=>writeBatch(c),cost.write);
   cost.write.after=(await step('cost:counts-after-write',()=>counts(c))).value;
   cost.write.afterHash=(await step('cost:hash-after-write',()=>searchHash(c))).value;
   if(!same(cost.write.before,cost.write.after)||cost.write.hash!==cost.write.afterHash) throw Error('rollback changed fixture');
   cost.analyze.pre=emptySnapshot(); await step('cost:pre-analyze',()=>preparationSnapshot(c,cost.setup.preparation.support,cost.analyze.pre));
   await four('cost:analyze',()=>analyzeBatch(c),cost.analyze);
   cost.analyze.post=emptySnapshot(); await step('cost:post-analyze',()=>preparationSnapshot(c,cost.setup.preparation.support,cost.analyze.post));
   if(!same(cost.write.before,(await step('cost:counts-after-analyze',()=>counts(c))).value)||cost.write.hash!==(await step('cost:hash-after-analyze',()=>searchHash(c))).value) throw Error('analyze changed fixture');
   cost.statisticsAfter={}; await step('cost:statistics-after',()=>statistics(c,cost.statisticsAfter));
   if(cost.statisticsAfter.definitions.length!==0 || cost.statisticsAfter.distributions.length!==0) throw Error('unexpected diagnostic expression statistics');
  });
  state.stage='complete'; state.finishedAt=at(); return state;
 } catch(error) {state.finishedAt=at();state.failure=failureInfo(error);error.diagnostic=state;throw error;}
}
