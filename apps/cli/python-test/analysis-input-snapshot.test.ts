import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { describe, expect, it } from 'vitest';
import { buildInputSnapshot, createAnalysisInputSnapshot, exportScopeInput } from '@second-brain/core';
import { postgresStore } from 'second_brain/postgres';
import { extHome } from '../test/ext-fixture.js';

const fixturePath = fileURLToPath(new URL('../test/fixtures/analysis-input-fixture.json',import.meta.url));
const oraclePath = fileURLToPath(new URL('../test/fixtures/legacy-report-input-oracle.py',import.meta.url));
const archive = fileURLToPath(new URL('../../../_bmad-output/personal-brain/prep-garmin-absorption/inputs/garmin-source.tar.gz',import.meta.url));
const labelsPath = fileURLToPath(new URL('../../../packages/core/resources/health-analysis/v1/labels/exercise_types_ko.json',import.meta.url));
const input = JSON.parse(await readFile(fixturePath,'utf8'));
const parseFiles = (files: {path:string;bytes:Uint8Array}[]) => Object.fromEntries(files.map(f => [f.path, new TextDecoder().decode(f.bytes)]));
const encodedExercise = (activity: number, exercise: string) => JSON.stringify([{type:'integer',value:activity},{base64:Buffer.from(exercise,'utf8').toString('base64'),encoding:'utf-8',type:'text'}]);
const normalized = (entries: Record<string,string>) => Object.fromEntries(Object.entries(entries).map(([path,value]) => [path,path.endsWith('.json') && path !== 'digest.json' ? JSON.parse(value) : value]));

async function setup() {
  const fixture = await extHome(), store = postgresStore({databaseUrl:fixture.db.appUrl});
  const install = await fixture.run(['ext','install','garmin','--json']);
  if (install.code !== 0) throw new Error(`${install.stdout}\n${install.stderr}`);
  const db = new pg.Client({connectionString:fixture.db.url}); await db.connect();
  const collect = randomUUID(), artifacts = randomUUID(), collectToken = randomUUID(), artifactToken = randomUUID(), request = randomUUID(), file = randomUUID(), location = randomUUID(), bundle = randomUUID();
  const digest = new TextEncoder().encode(input.digest), sha = createHash('sha256').update(digest).digest('hex');
  try {
    await db.query('begin'); await db.query("set local session_replication_role='replica'");
    await db.query("insert into brain.settings(key,value,updated_at) values('analysis.profile_path','~/fixture-profile.md',now())");
    await db.query("insert into garmin.datasets(dataset,account,account_confirmed) values('fixture','synthetic',true),('other','synthetic',true)");
    await db.query("insert into garmin.import_batches(id,dataset,imported_at) values('batch','fixture',now())");
    await db.query("insert into garmin.collect_targets(target_kind,target_id,account,dataset) values('account','synthetic','synthetic','fixture')");
    for (const [id,kind,token,summary] of [[collect,'garmin.collect',collectToken,{status:'success',cutoff_ms:input.cutoff,local_date:input.date,timezone:input.timezone,snapshot_id:randomUUID()}],[artifacts,'garmin.artifacts',artifactToken,{status:'success',request_id:request}] ] as const) {
      await db.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,completed_at,outcome) values($1,$2,'account','synthetic',now(),now(),'supervised',now(),'succeeded')",[id,kind]);
      await db.query("insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome,result_summary) values($1,$2,to_timestamp($4/1000.0),to_timestamp($4/1000.0),'succeeded',$3)",[token,id,JSON.stringify(summary),input.cutoff]);
    }
    const previousWork = randomUUID(), previousToken = randomUUID();
    await db.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,completed_at,outcome) values($1,'garmin.collect','account','synthetic',now(),now(),'supervised',now(),'succeeded')",[previousWork]);
    await db.query("insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome,result_summary) values($1,$2,to_timestamp($3/1000.0),to_timestamp($3/1000.0),'succeeded',$4)",[previousToken,previousWork,input.previous_cutoff,JSON.stringify({status:'success',local_date:'2026-01-31',cutoff_ms:input.previous_cutoff})]);
    for (const r of input.raw) await db.query("insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body) values('fixture','batch','synthetic',$1,$2,$3,$4,$4,'test',$5)",[r.scope,r.key,r.endpoint,input.cutoff,r.body]);
    for (const b of input.body) await db.query("insert into garmin.body_measurements(dataset,measured_on,sidecar,field_sources) values('fixture',$1,$2,'{}')",[b.measured_on,JSON.stringify(b.sidecar).replace('1769911200000000000','1769911200000000001')]);
    await db.query("insert into garmin.body_measurements(dataset,measured_on,sidecar,field_sources) values('other','2026-01-31','{}','{}')");
    const catalog = await db.query('select metric,definition from brain.health_catalog_v1');
    const definitions = new Map(catalog.rows.map(r => [r.metric,r.definition]));
    const observations: {metric:string; date:string; activity:string|null; sub:string|null; value:unknown}[] = [];
    for (const [table,rows,keys] of [['day_summary',input.day_summary,['date']],['workout',input.workout,['activity_id','date']],['exercise_log',input.exercise_log,['activity_id','exercise']]] as const) for (const row of rows) for (const [column,value] of Object.entries(row)) if (!(keys as readonly string[]).includes(column)) observations.push({metric:`${table}.${column}`,date:row.date ?? input.workout.find((w:any)=>w.activity_id===row.activity_id)?.date ?? input.date,activity:row.activity_id === undefined ? null : String(row.activity_id),sub:row.exercise === undefined ? null : encodedExercise(row.activity_id,row.exercise),value});
    for (const a of input.activities) for (const column of ['start_ms','duration_s'] as const) observations.push({metric:`activity.${column}`,date:a.day_key,activity:String(a.activity_id),sub:null,value:a[column]});
    for (const o of observations) {
      const def = definitions.get(o.metric) as any; if (!def) throw new Error(`missing catalog ${o.metric}`);
      const factor = def.mappings.find((m:any) => `${m.table}.${m.column}` === o.metric)?.factor ?? 1;
      await db.query("insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,activity_id,sub_identity,value_type,value_text,value_json) values($1,'garmin','fixture','batch',$2,$3,'synthetic',true,$4,$5,$6,$7,$8,false,'r',now(),8,$9,$10,$11,$12,$13,$14,$15)",[randomUUID(),o.metric.split('.')[0],`${o.date}/${o.activity}/${o.sub}`,o.metric,def.type === 'number' && o.value !== null ? Number(o.value)*factor : null,def.unit,o.date,input.timezone,collect,collectToken,o.activity,o.sub,def.type,def.type === 'text' ? o.value : null,def.type === 'json' && o.value !== null ? JSON.stringify(JSON.parse(String(o.value))) : null]);
      if (o.metric === 'day_summary.drinks_json' && o.value !== null) await db.query("update brain.health_observations set value_json_raw=$1,value_json_encoding='utf-8' where metric=$2 and local_date=$3",[Buffer.from(String(o.value),'utf8'),o.metric,o.date]);
    }
    await db.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at,home_location_id) values($1,$2,$3,now(),$4)",[file,`sha256:${sha}`,digest.length,location]);
    await db.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values($1,$2,'local','digest','brain',now())",[location,file]);
    await db.query("insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values($1,'garmin','fixture','fixture','batch','fixture',$2,$3,'application/json',now(),$4,$5,$6)",[request,sha,digest.length,artifacts,artifactToken,JSON.stringify({kind:'digest',collect_result_id:collect})]);
    await db.query('insert into brain.file_request_results(request_id,file_id,finished_at) values($1,$2,now())',[request,file]);
    for (const r of input.evaluations.filter((r:any) => !(r.report_date === '2026-01-31' && r.scope === 'day'))) await db.query("insert into brain.analyses(id,source,dataset,import_batch,original_table,original_key,revision,model,model_missing,created_at,created_at_missing,file_request_id,source_work_item_id,source_attempt_token,report_date,scope,summary,judgments,evidence,next_checks,report_md) values($1,'garmin','legacy','batch','evaluation',$2,1,'fixture',false,now(),false,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",[randomUUID(),`${r.report_date}/${r.scope}`,request,collect,collectToken,r.report_date,r.scope,r.summary,JSON.stringify(r.judgments),JSON.stringify(r.evidence),JSON.stringify(r.next_checks),r.report_md]);
    const report = input.evaluations.find((r:any)=>r.report_date==='2026-01-31' && r.scope==='day');
    const reportBytes = Buffer.from(report.report_md), reportFile = randomUUID(), reportLocation = randomUUID(), previousSnapshot = randomUUID(), analysis = randomUUID();
    const snapshotBytes = Buffer.from(JSON.stringify({manifest:{account:'synthetic'}}));
    await db.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at,home_location_id) values($1,$2,$3,now(),$4)",[reportFile,'sha256:'+createHash('sha256').update(reportBytes).digest('hex'),reportBytes.length,reportLocation]);
    await db.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values($1,$2,'local','previous-report','brain',now())",[reportLocation,reportFile]);
    await db.query("insert into brain.analysis_snapshots(id,bundle_id,local_date,time_zone,content,content_sha256,created_at,collect_work_id,artifacts_work_id) values($1,$2,'2026-01-31',$3,$4,$5,now(),$6,$7)",[previousSnapshot,randomUUID(),input.timezone,snapshotBytes,createHash('sha256').update(snapshotBytes).digest('hex'),randomUUID(),randomUUID()]);
    await db.query("insert into brain.analyses(id,source,dataset,revision,model_missing,created_at,created_at_missing,source_work_item_id,source_attempt_token,report_date,scope,bundle_id,snapshot_id,agent,output_json) values($1,'core','health',1,true,now(),false,$2,$3,'2026-01-31','day',$4,$5,'codex',$6)",[analysis,collect,collectToken,randomUUID(),previousSnapshot,JSON.stringify({summary:report.summary,judgments:report.judgments,evidence:report.evidence,next_checks:report.next_checks,report_md:report.report_md})]);
    await db.query("insert into brain.analysis_files(analysis_id,file_id,role) values($1,$2,'report')",[analysis,reportFile]);
    await db.query('commit');
  } catch (error) { await db.query('rollback'); await db.end(); await store.close(); await fixture.cleanup(); throw error; }
  const files = {async get(location: {locator:string}) {return {ok:true as const,bytes:location.locator === 'previous-report' ? new TextEncoder().encode(input.evaluations.find((r:any)=>r.report_date==='2026-01-31' && r.scope==='day').report_md) : digest};},async put(){throw Error('unexpected put');},async exists(){throw Error('unexpected exists');},async url(){throw Error('unexpected url');},async delete(){throw Error('unexpected delete');}};
  const deps = {store,files,idGen:{next:randomUUID},now:()=>new Date('2026-02-01T02:01:00Z'),labels:new Uint8Array(await readFile(labelsPath)),readProfile:async()=>new TextEncoder().encode(input.profile)};
  return {fixture,store,db,collect,artifacts,bundle,deps,async close(){await db.end();await store.close();await fixture.cleanup();}};
}

describe('analysis input snapshot matches legacy report-input', () => {
  it('matches trees, cutoff, incomplete workouts, short history, month boundary and invalid raw/body', async () => {
    const ctx = await setup();
    try {
      const result = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
      expect(result).toMatchObject({ok:true}); if (!result.ok || !result.snapshot) throw Error('snapshot missing');
      const oracle = JSON.parse(execFileSync('uv',['run','--offline','--no-project','--python','3.14','--with','jsonschema==4.26.0','python',oraclePath,fixturePath,archive],{encoding:'utf8'})) as Record<string,string>;
      const actual = Object.assign({},...(['day','7d','30d','all'] as const).map(scope => parseFiles(exportScopeInput(result.snapshot!.content,scope))));
      const a = normalized(actual), b = normalized(oracle);
      for (const month of (a['period/all/day_values.json'] as any).months) for (const key of ['hrv_avg','spo2_avg','spo2_min','resp_avg']) { expect(month[key]).toBeNull(); const old = (b['period/all/day_values.json'] as any).months.find((x:any)=>x.month===month.month); expect(old[key] === null || typeof old[key] === 'number').toBe(true); old[key]=null; }
      expect(a).toEqual(b);
      expect(actual['body/2026-01-31.json']).toContain('1769911200000000001');
      expect(oracle['body/2026-01-31.json']).toContain('1769911200000000001');
      expect(actual['days/2026-02-01/heart_rates.json']).toContain('1769911200000000001');
      expect(oracle['days/2026-02-01/heart_rates.json']).toContain('1769911200000000001');
      expect(actual['previous_report.md']).toBe('별도 core 보고서\n');
      expect((a['period/7d/day_values.json'] as any).exercise_log.map((r:any)=>r.exercise)).toEqual(['Z press','a squat']);
      expect(createHash('sha256').update(actual['digest.json']!).digest('hex')).toBe(createHash('sha256').update(input.digest).digest('hex'));
    } finally { await ctx.close(); }
  },180000);
});

describe('analysis input snapshot new contract', () => {
  it('returns the same snapshot on re-entry and rejects missing inputs', async () => {
    const ctx = await setup();
    try {
      const first = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
      const second = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:randomUUID()});
      expect(first.ok && first.snapshot?.id).toBe(second.ok && second.snapshot?.id);
      expect(await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:randomUUID(),artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle})).toMatchObject({ok:false,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID'});
    } finally { await ctx.close(); }
  },180000);
});

it('analysis input snapshot new contract excludes ambiguous datasets and records authority', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query('begin'); await ctx.db.query("set local session_replication_role='replica'");
    await ctx.db.query("insert into brain.health_observations select $1,source,'other',import_batch,original_table,original_key,account,account_confirmed,metric,9999,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_text,value_json,catalog_version,activity_id,sub_identity,account_raw,account_encoding,activity_id_raw,activity_id_encoding,sub_identity_raw,sub_identity_encoding,value_text_raw,value_text_encoding,value_json_raw,value_json_encoding from brain.health_observations where metric='day_summary.steps' and local_date='2026-01-30' limit 1",[randomUUID()]);
    await ctx.db.query('commit');
    const found = await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts);
    expect(found.ok).toBe(true); if (!found.ok) throw Error(found.message);
    expect(found.sources.excluded).toEqual(expect.arrayContaining([expect.objectContaining({metric:'day_summary.steps',localDate:'2026-01-30',reason:'dataset_ambiguous'})]));
    expect(found.sources.metrics.some(m => m.metric === 'day_summary.steps' && m.localDate === '2026-01-30')).toBe(false);
    const ambiguous = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
    expect(ambiguous.ok).toBe(true); if (!ambiguous.ok || !ambiguous.snapshot) throw Error('snapshot missing');
    const document = JSON.parse(new TextDecoder().decode(ambiguous.snapshot.content));
    expect(document.manifest.excluded).toEqual(expect.arrayContaining([expect.objectContaining({metric:'day_summary.steps',reason:'dataset_ambiguous'})]));
    expect(Object.values(parseFiles(exportScopeInput(ambiguous.snapshot.content,'all'))).join('')).not.toContain('9999');
    const authority = randomUUID();
    await ctx.db.query("insert into brain.health_authority_rules(id,source,account,metric,date_from,date_to,revision,datasets) values($1,'garmin','synthetic','day_summary.steps','2026-01-30','2026-01-30',1,array['fixture'])",[authority]);
    const resolved = await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts);
    expect(resolved.ok).toBe(true); if (!resolved.ok) throw Error(resolved.message);
    expect(resolved.sources.metrics).toEqual(expect.arrayContaining([expect.objectContaining({metric:'day_summary.steps',localDate:'2026-01-30',value:1000,authorityId:authority})]));
    const resolvedSnapshot = buildInputSnapshot(resolved.sources,{snapshotId:'test',digest:new TextEncoder().encode(input.digest),labels:ctx.deps.labels});
    expect(resolvedSnapshot.manifest.authority).toEqual(expect.arrayContaining([expect.objectContaining({id:authority,revision:1})]));
  } finally { await ctx.close(); }
},180000);

it('analysis input snapshot new contract excludes other account and tracer core analyses', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query('begin'); await ctx.db.query("set local session_replication_role='replica'");
    for (const [account,tracer] of [['synthetic',false],['other-account',false],['synthetic',true]] as const) {
      const snapshot = randomUUID(), analysis = randomUUID(), bytes = Buffer.from(tracer ? 'not json' : JSON.stringify({manifest:{account}}));
      await ctx.db.query('insert into brain.analysis_snapshots(id,bundle_id,local_date,time_zone,content,content_sha256,created_at,collect_work_id,artifacts_work_id) values($1,$2,$3,$4,$5,$6,now(),$7,$8)',[snapshot,randomUUID(),input.date,input.timezone,bytes,createHash('sha256').update(bytes).digest('hex'),tracer ? null : randomUUID(),tracer ? null : randomUUID()]);
      await ctx.db.query("insert into brain.analyses(id,source,dataset,revision,model_missing,created_at,created_at_missing,source_work_item_id,source_attempt_token,report_date,scope,bundle_id,snapshot_id,agent,output_json) values($1,'core','health',1,true,now(),false,$2,$3,'2026-01-31','day',$4,$5,'codex',$6)",[analysis,ctx.collect,randomUUID(),randomUUID(),snapshot,JSON.stringify({summary:account,judgments:[],evidence:[],next_checks:[]})]);
    }
    await ctx.db.query('commit');
    const read = await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts);
    expect(read.ok).toBe(true); if (!read.ok) throw Error(read.message);
    expect(read.sources.analyses.filter(a => a.source === 'core').map(a => a.summary).sort()).toEqual(['core 어제','synthetic']);
    expect(read.sources.analyses.filter(a => a.source === 'legacy')).toHaveLength(input.evaluations.filter((r:any)=>r.report_date <= input.date && !(r.report_date==='2026-01-31' && r.scope==='day')).length);
    expect(read.sources.body).toHaveLength(2);
  } finally { await ctx.close(); }
},180000);

it('analysis input snapshot new contract keeps one snapshot across four exports', async () => {
  const ctx = await setup();
  try {
    const result = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
    if (!result.ok || !result.snapshot) throw Error('snapshot missing');
    const snapshot = JSON.parse(new TextDecoder().decode(result.snapshot.content));
    expect(snapshot.manifest.snapshot_id).toBe(result.snapshot.id);
    expect(snapshot.manifest.account).toBe('synthetic');
    const before = JSON.stringify(snapshot);
    for (const scope of ['day','7d','30d','all'] as const) expect(exportScopeInput(result.snapshot.content,scope).length).toBeGreaterThan(0);
    expect(JSON.stringify(JSON.parse(new TextDecoder().decode(result.snapshot.content)))).toBe(before);
  } finally { await ctx.close(); }
},180000);

it('analysis input snapshot new contract rejects unsuccessful or incomplete predecessors', async () => {
  const ctx = await setup();
  try {
    const request = async () => createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
    const change = async (query:string) => { await ctx.db.query('begin'); await ctx.db.query("set local session_replication_role='replica'"); await ctx.db.query(query); await ctx.db.query('commit'); };
    await change(`update brain.work_items set outcome='failed' where id='${ctx.collect}'`);
    expect(await request()).toMatchObject({ok:false,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID'});
    await change(`update brain.work_items set outcome='succeeded' where id='${ctx.collect}'; update brain.work_items set outcome='failed' where id='${ctx.artifacts}'`);
    expect(await request()).toMatchObject({ok:false,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID'});
    await change(`update brain.work_items set outcome='succeeded' where id='${ctx.artifacts}'; update brain.work_attempts set result_summary=result_summary-'cutoff_ms' where work_item_id='${ctx.collect}'`);
    expect(await request()).toMatchObject({ok:false,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID'});
    await change(`update brain.work_attempts set result_summary=jsonb_set(result_summary,'{cutoff_ms}','${input.cutoff}'::jsonb) where work_item_id='${ctx.collect}'; delete from brain.file_request_results where request_id=(select (result_summary->>'request_id')::uuid from brain.work_attempts where work_item_id='${ctx.artifacts}')`);
    expect(await request()).toMatchObject({ok:false,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID'});
    expect((await ctx.db.query(`select count(*)::int n from brain.analysis_snapshots where collect_work_id='${ctx.collect}'`)).rows[0].n).toBe(0);
  } finally { await ctx.close(); }
},180000);

it('analysis input snapshot new contract reports missing Garmin read contract', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query('drop view garmin.collect_target_accounts');
    expect(await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts)).toMatchObject({ok:false,code:'ANALYSIS_SNAPSHOT_INPUT_INVALID'});
  } finally { await ctx.close(); }
},180000);

it('analysis input snapshot accepts a successful noop collect', async () => {
  const ctx = await setup();
  try {
    await ctx.db.query("update brain.work_attempts set result_summary=jsonb_set(result_summary,'{status}','\"noop\"') where work_item_id=$1",[ctx.collect]);
    const result = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
    expect(result.ok).toBe(true);
  } finally { await ctx.close(); }
},180000);

it('uses the previous local 11:00 cutoff when no previous collect exists', async () => {
  const ctx = await setup();
  try {
    const fallback = Date.parse('2026-01-31T02:00:00Z');
    await ctx.db.query('begin'); await ctx.db.query("set local session_replication_role='replica'");
    await ctx.db.query("delete from brain.work_attempts where work_item_id in (select id from brain.work_items where kind='garmin.collect' and id<>$1)",[ctx.collect]);
    await ctx.db.query("update brain.health_observations set value=case activity_id when '1' then $1::bigint-1 else $1::bigint end where metric='activity.start_ms'",[fallback]);
    await ctx.db.query('commit');
    const result = await createAnalysisInputSnapshot(ctx.deps,{collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle});
    if (!result.ok || !result.snapshot) throw Error('snapshot missing');
    const files = parseFiles(exportScopeInput(result.snapshot.content,'day'));
    const manifest = JSON.parse(files['manifest.json']!);
    expect(manifest.workout_window.from).toBe('2026-01-31T11:00:00.000+09:00');
    expect(manifest.workouts).toEqual(['2']);
  } finally { await ctx.close(); }
},180000);

it('retries when the previous core report file cannot be read', async () => {
  const ctx = await setup();
  try {
    const deps = {...ctx.deps,files:{...ctx.deps.files,async get(location:{locator:string}) { return location.locator === 'previous-report' ? {ok:false as const,code:'FILES_UNAVAILABLE' as const,message:'temporary failure'} : ctx.deps.files.get(location); }}};
    const request = {collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle};
    expect(await createAnalysisInputSnapshot(deps,request)).toEqual({ok:false,code:'FILES_UNAVAILABLE',message:'temporary failure'});
    expect((await ctx.db.query('select count(*)::int n from brain.analysis_snapshots where collect_work_id=$1',[ctx.collect])).rows[0].n).toBe(0);
    expect((await createAnalysisInputSnapshot(ctx.deps,request)).ok).toBe(true);
  } finally { await ctx.close(); }
},180000);

it('chooses the previous collect by cutoff instead of completion time', async () => {
  const ctx = await setup();
  try {
    const previous = randomUUID(), token = randomUUID(), cutoff = input.previous_cutoff - 60000;
    await ctx.db.query('begin'); await ctx.db.query("set local session_replication_role='replica'");
    await ctx.db.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,completed_at,outcome) values($1,'garmin.collect','account','synthetic',now(),now(),'supervised',now(),'succeeded')",[previous]);
    await ctx.db.query("insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome,result_summary) values($1,$2,now(),now()+interval '1 day','succeeded',$3)",[token,previous,JSON.stringify({status:'success',local_date:'2026-01-31',cutoff_ms:cutoff})]);
    await ctx.db.query('commit');
    const result = await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts);
    expect(result.ok && result.sources.windowFromMs).toBe(input.previous_cutoff);
  } finally { await ctx.close(); }
},180000);

it('retries digest file reads without committing a snapshot', async () => {
  const ctx = await setup();
  try {
    const deps = {...ctx.deps,files:{...ctx.deps.files,async get(location:{locator:string}) { return location.locator === 'digest' ? {ok:false as const,code:'FILES_UNAVAILABLE' as const,message:'temporary digest'} : ctx.deps.files.get(location); }}};
    const request = {collectWorkId:ctx.collect,artifactsWorkId:ctx.artifacts,bundleId:ctx.bundle};
    expect(await createAnalysisInputSnapshot(deps,request)).toEqual({ok:false,code:'FILES_UNAVAILABLE',message:'temporary digest'});
    expect((await ctx.db.query('select count(*)::int n from brain.analysis_snapshots where collect_work_id=$1',[ctx.collect])).rows[0].n).toBe(0);
    expect((await createAnalysisInputSnapshot(ctx.deps,request)).ok).toBe(true);
  } finally { await ctx.close(); }
},180000);

it('converges concurrent snapshot inserts on the same id', async () => {
  const ctx = await setup();
  try {
    const mk = () => { const content = new TextEncoder().encode(JSON.stringify({id:randomUUID()})); return {id:randomUUID(),bundleId:ctx.bundle,localDate:input.date,timeZone:input.timezone,content,contentSha256:createHash('sha256').update(content).digest('hex'),createdAt:new Date()}; };
    expect((await ctx.store.findAnalysisSnapshotByInputs(ctx.collect,ctx.artifacts))).toMatchObject({ok:true,snapshot:null});
    const [a,b] = await Promise.all([ctx.store.createInputSnapshot(mk(),ctx.collect,ctx.artifacts),ctx.store.createInputSnapshot(mk(),ctx.collect,ctx.artifacts)]);
    expect(a.ok && b.ok && a.snapshot.id === b.snapshot.id).toBe(true);
    expect((await ctx.db.query('select count(*)::int n from brain.analysis_snapshots where collect_work_id=$1 and artifacts_work_id=$2',[ctx.collect,ctx.artifacts])).rows[0].n).toBe(1);
  } finally { await ctx.close(); }
},180000);

it.each(['activity.start_ms','activity.duration_s'])('excludes ambiguous %s and restores it with authority', async metric => {
  const ctx = await setup();
  try {
    await ctx.db.query('begin'); await ctx.db.query("set local session_replication_role='replica'");
    await ctx.db.query("insert into brain.health_observations select $1,source,'other',import_batch,original_table,original_key,account,account_confirmed,metric,value+1,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_text,value_json,catalog_version,activity_id,sub_identity,account_raw,account_encoding,activity_id_raw,activity_id_encoding,sub_identity_raw,sub_identity_encoding,value_text_raw,value_text_encoding,value_json_raw,value_json_encoding from brain.health_observations where metric=$2 and activity_id='1' limit 1",[randomUUID(),metric]);
    await ctx.db.query('commit');
    const before = await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts);
    if (!before.ok) throw Error(before.message);
    expect(before.sources.excluded).toEqual(expect.arrayContaining([expect.objectContaining({metric,activityId:'1',reason:'dataset_ambiguous'})]));
    const make = (sources: typeof before.sources) => buildInputSnapshot(sources,{snapshotId:'test',digest:new TextEncoder().encode(input.digest),labels:ctx.deps.labels});
    const ambiguous = make(before.sources);
    expect(ambiguous.legacyManifest.workouts).toEqual([]);
    expect(ambiguous.legacyManifest._workout_starts_ms).toHaveLength(metric === 'activity.start_ms' ? 1 : 2);
    expect(Object.keys(ambiguous.files)).not.toContain('activities/1/activity.json');
    await ctx.db.query("insert into brain.health_authority_rules(id,source,account,metric,activity_id,revision,datasets) values($1,'garmin','synthetic',$2,'1',1,array['fixture'])",[randomUUID(),metric]);
    const after = await ctx.store.readAnalysisInputSources(ctx.collect,ctx.artifacts);
    if (!after.ok) throw Error(after.message);
    const restored = make(after.sources);
    expect(restored.legacyManifest.workouts).toEqual(['1']);
    expect(restored.legacyManifest._workout_starts_ms).toHaveLength(2);
    expect(Object.keys(restored.files)).toContain('activities/1/activity.json');
  } finally { await ctx.close(); }
},180000);
