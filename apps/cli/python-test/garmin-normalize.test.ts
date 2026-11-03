import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('감독자가 반입 권위와 수집 revision 및 재정규화를 보존한다', async () => {
  const {postgresStore}=await import('second_brain/postgres');
  const {runDaemon}=await import('../src/daemon/run.js');
  const {systemClock}=await import('../src/runtime/clock.js');
  const {uuidV7IdGen}=await import('../src/runtime/id-gen.js');
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  const store=postgresStore({databaseUrl:fixture.db.appUrl});
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const home=await realpath(fixture.home), ext=join(home,'extensions/garmin'), python=join(ext,'.venv/bin/python');
    const capture=join(home,'capture'); await mkdir(capture);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    const code=`import sys,pathlib,sqlite3
sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest
p=pathlib.Path(sys.argv[2]); paths=five_candidates(p,rich=True)
with sqlite3.connect(paths['D2']) as c:
 c.execute("insert into raw_response values ('day','2026-01-02','user_summary',?,1700000000123,1700000000456,'test')", ('{"userProfileId":12345}',))
 c.execute("insert into daily_metric(day_key,steps) values ('2026-01-02',4321)")
 c.execute("insert into normalize_result values ('day','2026-01-02','user_summary',1,null,1700000000123,1700000000999)")
capture_manifest(p,paths)`;
    execFileSync(python,['-c',code,fixtures,capture]);
    const channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(join(capture,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    await store.setSetting({key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    const tokens=join(home,'tokens'); await mkdir(tokens); await writeFile(join(tokens,'garmin_tokens.json'),'synthetic-token-canary');
    await store.setSetting({key:'garmin.tokenstore',value:tokens,updatedAt:new Date()});
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py',import.meta.url)),join(ext,'collect_fixture.py'));
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/normalize_fixture.py',import.meta.url)),join(ext,'normalize_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    for(const w of manifest.work) if(w.kind.startsWith('garmin.collect')) w.entry='collect_fixture.py';
    manifest.work.find((w:any)=>w.kind==='garmin.normalize').entry='normalize_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const marker: any={home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,response:{totalSteps:2222,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null},responses:{} as Record<string,unknown>};
    const writeMarker=()=>writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker)); await writeMarker();
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imp=await fixture.run(['ext','run','garmin','import','--json']);
    expect(imp.code,imp.stdout+imp.stderr).toBe(0);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${imp.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const v1=await fixture.db.rows("select * from brain.health_authority_rules where account='12345' and revision=1");
    const provenance=await fixture.db.rows("select * from garmin.authority_provenance where account='12345'");
    const start=async(kind:string,day?:string)=>{
      const id=ids.next(), now=new Date();
      expect(await store.addWork({id,kind,targetKind:'account',targetId:'12345',createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
      if(day) await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='Asia/Seoul',next_attempt_at=now() where id='${id}'`);
      else await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${id}'`);
      return id;
    };
    const queue=async(kind:string,day?:string,outcome='succeeded')=>{
      const id=await start(kind,day);
      await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:30000}).toBe(outcome);
      return id;
    };
    const normalizeOutput=async(id:string)=>{
      const token=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${id}'`))[0]!.token;
      const stdout=await readFile(join(home,`normalize-stdout-${token}`),'utf8');
      const stderr=await readFile(join(home,`normalize-stderr-${token}`),'utf8');
      expect(stdout+stderr).not.toContain('synthetic-token-canary');
      return {stdout,stderr};
    };
    await queue('garmin.collect_recent','2026-01-01');
    const compared=await fixture.db.rows("select dataset,original_key,sub_identity,metric,local_date::text,observed_at,time_zone,account,value from brain.health_observations where account='12345' and original_table='daily_metric' and metric='daily_metric.steps' and local_date='2026-01-01' order by dataset");
    const imported=compared.find(r=>r.dataset==='synthetic-D2')!, collected=compared.find(r=>String(r.dataset).startsWith('collect-'))!;
    expect(collected).toBeDefined();
    for(const key of ['original_key','sub_identity','metric','local_date','observed_at','time_zone','account']) expect(collected[key]).toEqual(imported[key]);
    expect(await fixture.db.rows("select value from brain.health_current_v1 where account='12345' and metric='daily_metric.steps' and local_date='2026-01-01'")).toEqual([{value:2222}]);
    expect(await fixture.db.rows("select value from brain.health_current_v1 where account='12345' and metric='daily_metric.steps' and local_date='2026-01-02'")).toEqual([{value:4321}]);
    expect(await fixture.db.rows("select * from brain.health_authority_rules where account='12345' and revision=1")).toEqual(v1);
    expect(await fixture.db.rows("select * from garmin.authority_provenance where account='12345'")).toEqual(provenance);
    const dataset=String(collected.dataset);
    // An imported-only date lies between collected January and February dates.
    const importedDayId=ids.next();
    expect((await fixture.db.rows("select datasets from garmin.authority_v2"))[0]?.datasets).toEqual([dataset,...provenance[0]!.datasets]);
    expect(await fixture.db.rows("select * from garmin.collect_targets where target_kind='account' and target_id='12345'")).toEqual([]);
    const before=await fixture.db.rows(`select original_table,local_date::text,count(*)::int n from brain.health_observations where dataset='${dataset}' group by original_table,local_date order by original_table,local_date`);
    const successNormalize=await queue('garmin.normalize');
    expect((await normalizeOutput(successNormalize)).stdout).toContain('"type": "result"');
    expect(await fixture.db.rows(`select original_table,local_date::text,count(*)::int n from brain.health_observations where dataset='${dataset}' group by original_table,local_date order by original_table,local_date`)).toEqual(before);
    // A pending date is retried even when collection itself is a no-op.
    await fixture.db.query(`update garmin.normalize_days set normalized_at_ms=0 where dataset='${dataset}' and day='2026-01-01';
      insert into garmin.normalize_days(dataset,day,revision,normalization_version,fetched_at_ms,ok,error_code,normalized_at_ms) values ('${dataset}','2026-01-01','failed-day',8,1,false,'internal',1)`);
    await queue('garmin.collect','2026-01-01');
    expect(await fixture.db.rows(`select ok from garmin.normalize_days where dataset='${dataset}' and day='2026-01-01' order by normalized_at_ms desc limit 1`)).toEqual([{ok:true}]);
    for(const steps of [3333,2222]) {
      marker.response.totalSteps=steps; await writeMarker();
      await fixture.db.query(`update garmin.raw_payloads set checked_at_ms=1 where dataset='${dataset}' and scope='day' and original_key='2026-01-01' and endpoint='user_summary'`);
      await queue('garmin.collect_recent','2026-01-01');
    }
    const revisions=await fixture.db.rows(`select revision,value from brain.health_observations where dataset='${dataset}' and metric='daily_metric.steps' and local_date='2026-01-01' order by fetched_at`);
    expect(revisions.map(r=>r.value)).toEqual([2222,3333,2222]);
    expect(String(revisions[2]!.revision)).toContain(':');
    expect(await fixture.db.rows("select value from brain.health_current_v1 where account='12345' and metric='daily_metric.steps' and local_date='2026-01-01'")).toEqual([{value:2222}]);
    // Raw-only, malformed endpoint, >500 samples and reverse fetched-at order.
    const day='2026-02-01', rawBatch=(await fixture.db.rows(`select batch from garmin.raw_payloads where dataset='${dataset}' limit 1`))[0]!.batch;
    const jsonSql=(value:unknown)=>JSON.stringify(value).replaceAll("'","''");
    const summary=(steps:number)=>({...marker.response,totalSteps:steps});
    const rhr={allMetrics:{metricsMap:{WELLNESS_RESTING_HEART_RATE:[{calendarDate:day,value:52}]}}};
    const hr={heartRateValueDescriptors:[{key:'timestamp',index:0},{key:'heartrate',index:1}],heartRateValues:Array.from({length:501},(_,i)=>[1700000000000+i*1000,60])};
    await fixture.db.query(`insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,body,fetched_at_ms,checked_at_ms,library_version) values
      ('${dataset}','${rawBatch}','12345','day','${day}','user_summary','${jsonSql(summary(9999))}',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','${day}','rhr_day','${jsonSql(rhr)}',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','${day}','heart_rates','${jsonSql(hr)}',2000000000000,2000000000000,'fixture')`);
    marker.pause_item_second_batch=['day',day,'heart_rates']; await writeMarker();
    const interruptedItem=await start('garmin.collect','2026-01-01');
    await expect.poll(()=>readFile(join(home,'item-first-chunk'),'utf8').catch(()=>''),{timeout:30000}).not.toBe('');
    const oldToken=await readFile(join(home,'item-first-chunk'),'utf8');
    await fixture.db.query(`insert into brain.health_observations
      (id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,activity_id,sub_identity)
      select '${importedDayId}',source,dataset,import_batch,'day_summary',original_key,account,account_confirmed,'day_summary.steps',value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,'${interruptedItem}','${oldToken}',value_type,activity_id,sub_identity
      from brain.health_observations where dataset='synthetic-D2' and metric='daily_metric.steps' and local_date='2026-01-02'`);
    const importedDayBefore=await fixture.db.rows("select id,value from brain.health_current_v1 where account='12345' and metric='day_summary.steps' and local_date='2026-01-02'");
    expect(importedDayBefore).toEqual([{id:importedDayId,value:4321}]);
    const partial=await fixture.db.rows(`select id,import_batch,revision,value from brain.health_observations where dataset='${dataset}' and original_table='hr_sample' order by id`);
    expect(partial).toHaveLength(500);
    expect(await fixture.db.rows(`select ok,error_code from garmin.normalize_items where dataset='${dataset}' and scope='day' and key='${day}' and endpoint='heart_rates'`)).toEqual([{ok:false,error_code:'pending'}]);
    await fixture.db.query(`update brain.work_attempts set finished_at=now(),outcome='cancelled' where token='${oldToken}' and outcome is null`);
    await writeFile(join(home,'item-release'),'release');
    await expect.poll(()=>readFile(join(home,`collect-error-${oldToken}`),'utf8').then(s=>JSON.parse(s).code).catch(()=>''),{timeout:30000}).toBe('COLLECT_INVALID_ATTEMPT');
    await expect.poll(()=>readFile(join(home,`collect-exited-${oldToken}`),'utf8').then(()=>true).catch(()=>false),{timeout:30000}).toBe(true);
    expect(await fixture.db.rows(`select id,import_batch,revision,value from brain.health_observations where dataset='${dataset}' and original_table='hr_sample' order by id`)).toEqual(partial);
    await fixture.db.query(`update garmin.collect_runs set started_at=0 where work_id='${interruptedItem}'`);
    await fixture.db.query(`update brain.work_items set completed_at=now(),outcome='cancelled',current_attempt_token=null,claimed_at=null,claim_expires_at=null,claimed_by=null where id='${interruptedItem}' and completed_at is null`);
    delete marker.pause_item_second_batch; await writeMarker();
    const resumed=await queue('garmin.collect','2026-01-01');
    const resumedToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${resumed}'`))[0]!.token;
    expect(resumedToken).not.toBe(oldToken);
    expect(JSON.parse(JSON.parse(await readFile(join(home,`collect-result-${resumedToken}`),'utf8')).summary).status).toBe('noop');
    const complete=await fixture.db.rows(`select id,import_batch,revision,value from brain.health_observations where dataset='${dataset}' and original_table='hr_sample' order by id`);
    expect(complete).toHaveLength(501);
    expect(complete.filter(r=>partial.some(p=>p.id===r.id))).toEqual(partial);
    expect(await fixture.db.rows(`select ok,error_code from garmin.normalize_items where dataset='${dataset}' and scope='day' and key='${day}' and endpoint='heart_rates'`)).toEqual([{ok:true,error_code:null}]);
    await queue('garmin.normalize');
    expect(await fixture.db.rows(`select id from brain.health_observations where dataset='${dataset}' and original_table in ('day_summary','workout','exercise_log') and local_date='2026-01-02'`)).toEqual([]);
    expect(await fixture.db.rows("select id,value from brain.health_current_v1 where account='12345' and metric='day_summary.steps' and local_date='2026-01-02'")).toEqual(importedDayBefore);
    const oldRhr=await fixture.db.rows(`select id,value from brain.health_observations where dataset='${dataset}' and metric='daily_metric.resting_hr' and local_date='${day}'`);
    expect(oldRhr).toHaveLength(1);
    expect(await fixture.db.rows(`select count(*)::int n from brain.health_observations where dataset='${dataset}' and original_table='hr_sample'`)).toEqual([{n:501}]);
    expect(await fixture.db.rows(`select value from brain.health_current_v1 where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}'`)).toEqual([{value:9999}]);
    await fixture.db.query(`update garmin.raw_payloads set body='{"allMetrics":"synthetic-token-canary"}',fetched_at_ms=2000000000001,checked_at_ms=2000000000001 where dataset='${dataset}' and scope='day' and original_key='${day}' and endpoint='rhr_day'`);
    await fixture.db.query(`update garmin.raw_payloads set body='${jsonSql(summary(1111))}',fetched_at_ms=1900000000000,checked_at_ms=2000000000001 where dataset='${dataset}' and scope='day' and original_key='${day}' and endpoint='user_summary'`);
    const parserNormalize=await queue('garmin.normalize');
    const parserOut=(await normalizeOutput(parserNormalize)).stdout;
    const parserResult=parserOut.trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.type==='result');
    expect(JSON.parse(parserResult.summary).normalize_failed).toBeGreaterThan(0);
    expect(await fixture.db.rows(`select value from brain.health_current_v1 where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}'`)).toEqual([{value:9999}]);
    expect(await fixture.db.rows(`select id,value from brain.health_observations where dataset='${dataset}' and metric='daily_metric.resting_hr' and local_date='${day}'`)).toEqual(oldRhr);
    expect(await fixture.db.rows(`select error_code from garmin.normalize_items where dataset='${dataset}' and key='${day}' and endpoint='rhr_day' and not ok`)).toEqual([{error_code:'parse_error'}]);
    const beforeDbFailure=await fixture.db.rows(`select * from garmin.normalize_items where dataset='${dataset}' order by scope,key,endpoint,revision,normalization_version`);
    marker.normalize_database_failure=true; marker.normalize_password_canary='synthetic-token-canary'; await writeMarker();
    const dbFailure=await queue('garmin.normalize',undefined,'failed');
    expect((await normalizeOutput(dbFailure)).stdout).toContain('"type": "error"');
    expect(await fixture.db.rows(`select * from garmin.normalize_items where dataset='${dataset}' order by scope,key,endpoint,revision,normalization_version`)).toEqual(beforeDbFailure);
    expect(JSON.stringify(beforeDbFailure)).not.toContain('synthetic-token-canary');
    const safeState=await fixture.db.rows(`select w.id,w.outcome,w.last_error,a.error_code,a.error_retryable from brain.work_items w left join brain.work_attempts a on a.work_item_id=w.id where w.id in ('${successNormalize}','${parserNormalize}','${dbFailure}')`);
    expect(JSON.stringify(safeState)).not.toContain('synthetic-token-canary');
    delete marker.normalize_database_failure; delete marker.normalize_password_canary; await writeMarker();
    await fixture.db.query(`insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,body,fetched_at_ms,checked_at_ms,library_version) values
      ('${dataset}','${rawBatch}','12345','day','2026-03-10','rhr_day','{',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','2026-03-11','user_summary','${jsonSql(summary(8765))}',2000000000000,2000000000000,'fixture')`);
    const malformedWork=await queue('garmin.normalize');
    const malformedOutput=(await normalizeOutput(malformedWork)).stdout;
    const malformedResult=malformedOutput.trim().split('\n').map(line=>JSON.parse(line)).find(event=>event.type==='result');
    expect(JSON.parse(malformedResult.summary).normalize_failed).toBeGreaterThan(0);
    expect(await fixture.db.rows(`select ok,error_code from garmin.normalize_days where dataset='${dataset}' and day='2026-03-10'`)).toEqual([{ok:false,error_code:'internal'}]);
    expect(await fixture.db.rows(`select value from brain.health_current_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-03-11'`)).toEqual([{value:8765}]);
    // NULL initially creates no target; a later owner creates it and retry emits NULL.
    await fixture.db.query(`insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,body,fetched_at_ms,checked_at_ms,library_version) values
      ('${dataset}','${rawBatch}','12345','day','2026-04-01','rhr_day','null',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','2026-04-02','user_summary','${jsonSql(summary(222))}',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','2026-04-03','user_summary','${jsonSql(summary(333))}',2000000000000,2000000000000,'fixture')`);
    await queue('garmin.normalize');
    expect(await fixture.db.rows(`select id from brain.health_observations where dataset='${dataset}' and metric='daily_metric.resting_hr' and local_date='2026-04-01'`)).toEqual([]);
    expect(await fixture.db.rows(`select ok,null_materialized from garmin.normalize_items where dataset='${dataset}' and key='2026-04-01' and endpoint='rhr_day'`)).toEqual([{ok:true,null_materialized:false}]);
    await fixture.db.query(`insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,body,fetched_at_ms,checked_at_ms,library_version) values
      ('${dataset}','${rawBatch}','12345','day','2026-04-01','user_summary','${jsonSql(summary(111))}',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','2026-04-02','rhr_day','null',2000000000000,2000000000000,'fixture'),
      ('${dataset}','${rawBatch}','12345','day','2026-04-03','rhr_day','null',2000000000000,2000000000000,'fixture')`);
    marker.normalize_interrupt_item=['day','2026-04-03','rhr_day']; await writeMarker();
    await queue('garmin.normalize',undefined,'failed');
    expect(await fixture.db.rows(`select ok,error_code from garmin.normalize_items where dataset='${dataset}' and key='2026-04-03' and endpoint='rhr_day'`)).toEqual([{ok:false,error_code:'pending'}]);
    delete marker.normalize_interrupt_item; await writeMarker();
    await queue('garmin.normalize');
    await queue('garmin.normalize');
    expect(await fixture.db.rows(`select local_date::text,value from brain.health_observations where dataset='${dataset}' and metric='daily_metric.resting_hr' and local_date between '2026-04-01' and '2026-04-03' order by local_date`)).toEqual([{local_date:'2026-04-01',value:null},{local_date:'2026-04-02',value:null},{local_date:'2026-04-03',value:null}]);
    expect(await fixture.db.rows(`select key,ok,null_materialized from garmin.normalize_items where dataset='${dataset}' and key between '2026-04-01' and '2026-04-03' and endpoint='rhr_day' order by key`)).toEqual(['2026-04-01','2026-04-02','2026-04-03'].map(key=>({key,ok:true,null_materialized:true})));
    const path=join(ext,'src/normalize_store.py'), source=await readFile(path,'utf8');
    await writeFile(path,source.replace('NORMALIZATION_VERSION = 8','NORMALIZATION_VERSION = 9'));
    await fixture.db.query('insert into brain.health_supported_versions values (9)');
    await queue('garmin.normalize');
    expect(await fixture.db.rows(`select distinct normalization_version from brain.health_observations where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}' order by normalization_version`)).toEqual([{normalization_version:8},{normalization_version:9}]);
    expect(await fixture.db.rows(`select count(*)::int n from brain.health_observations where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}' and normalization_version=8`)).toEqual([{n:2}]);
    expect(await fixture.db.rows("select value,normalization_version from brain.health_current_v1 where account='12345' and metric='daily_metric.steps' and local_date='2026-01-01'")).toEqual([{value:2222,normalization_version:9}]);
    expect(await fixture.db.rows(`select revision from brain.health_current_v1 where dataset='${dataset}' and metric='daily_metric.steps' and local_date='2026-01-01'`)).toEqual([{revision:revisions[2]!.revision}]);
    const currentDay=()=>fixture.db.rows(`select value,revision,normalization_version from brain.health_current_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`);
    const dayRows=()=>fixture.db.rows(`select revision,normalization_version,fetched_at::text,value from brain.health_observations where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01' order by fetched_at,normalization_version`);
    const versionRows=await dayRows();
    const shared=versionRows.find(r=>r.normalization_version===8 && versionRows.some(s=>s.normalization_version===9 && s.revision===r.revision));
    expect(shared).toBeDefined();
    expect(versionRows.find(r=>r.normalization_version===9 && r.revision===shared!.revision)!.fetched_at).toEqual(shared!.fetched_at);

    // Stop after raw commit, before publish_days. A no-op collect must find the dirty day.
    marker.response.totalSteps=4444; marker.interrupt_after_raw='user_summary'; await writeMarker();
    const beforeRawStop=await dayRows();
    await fixture.db.query(`update garmin.raw_payloads set checked_at_ms=1 where dataset='${dataset}' and scope='day' and original_key='2026-01-01' and endpoint='user_summary'`);
    const interruptedDay=await queue('garmin.collect_recent','2026-01-01','failed');
    const interruptedToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${interruptedDay}'`))[0]!.token;
    expect(JSON.parse(await readFile(join(home,`collect-error-${interruptedToken}`),'utf8')).code).toBe('COLLECT_STOPPED');
    expect(await fixture.db.rows(`select generation>completed_generation pending from garmin.normalize_day_dirty where dataset='${dataset}' and day='2026-01-01'`)).toEqual([{pending:true}]);
    expect(await dayRows()).toEqual(beforeRawStop);
    delete marker.interrupt_after_raw; await writeMarker();
    // Keep a previously successful run as the latest coverage run to exercise the no-op path.
    await fixture.db.query(`update garmin.collect_runs set started_at=0 where dataset='${dataset}' and local_date='2026-01-01' and status='error'`);
    const noop=await queue('garmin.collect','2026-01-01');
    const noopToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${noop}'`))[0]!.token;
    const noopResult=JSON.parse(await readFile(join(home,`collect-result-${noopToken}`),'utf8'));
    expect(JSON.parse(noopResult.summary).status).toBe('noop');
    expect((await currentDay())[0]?.value).toBe(4444);
    expect(await fixture.db.rows(`select generation=completed_generation complete from garmin.normalize_day_dirty where dataset='${dataset}' and day='2026-01-01'`)).toEqual([{complete:true}]);

    // The revision is already pending when execution stops before the first chunk.
    marker.response.totalSteps=5555; marker.interrupt_day_batch='2026-01-01'; await writeMarker();
    await fixture.db.query(`update garmin.raw_payloads set checked_at_ms=1 where dataset='${dataset}' and scope='day' and original_key='2026-01-01' and endpoint='user_summary'`);
    const interruptedChunk=await queue('garmin.collect_recent','2026-01-01','failed');
    const chunkToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${interruptedChunk}'`))[0]!.token;
    expect(JSON.parse(await readFile(join(home,`collect-error-${chunkToken}`),'utf8')).code).toBe('COLLECT_STOPPED');
    expect(await fixture.db.rows(`select ok,error_code from garmin.normalize_days where dataset='${dataset}' and day='2026-01-01' and error_code='pending'`)).toEqual([{ok:false,error_code:'pending'}]);
    expect((await currentDay())[0]?.value).toBe(4444);
    delete marker.interrupt_day_batch; await writeMarker();
    await fixture.db.query(`update garmin.collect_runs set started_at=0 where dataset='${dataset}' and local_date='2026-01-01' and status='error'`);
    await queue('garmin.collect','2026-01-01');
    expect((await currentDay())[0]?.value).toBe(5555);
    const stableRows=await dayRows(); await queue('garmin.normalize'); expect(await dayRows()).toEqual(stableRows);

    // Hold one source at the maximum while a different input and then labels change.
    await fixture.db.query(`update garmin.raw_payloads set fetched_at_ms=2100000000000,checked_at_ms=2100000000000 where dataset='${dataset}' and scope='day' and original_key='2026-01-01' and endpoint='sleep_data'`);
    await queue('garmin.normalize');
    const maxBase=(await currentDay())[0]; expect(maxBase?.value).toBe(5555);
    await fixture.db.query(`update garmin.raw_payloads set body='${jsonSql(summary(6666))}',fetched_at_ms=2000000000000,checked_at_ms=2100000000001 where dataset='${dataset}' and scope='day' and original_key='2026-01-01' and endpoint='user_summary'`);
    await queue('garmin.normalize');
    const changed=(await currentDay())[0]; expect(changed?.value).toBe(6666); expect(changed.revision).not.toBe(maxBase.revision);
    const labelPath=join(ext,'src/labels/exercise_types_ko.json');
    await writeFile(labelPath,(await readFile(labelPath,'utf8'))+'\n');
    await queue('garmin.normalize');
    const relabeled=(await currentDay())[0]; expect(relabeled?.value).toBe(6666); expect(relabeled.revision).not.toBe(changed.revision);
    expect(await fixture.db.rows(`select reason from brain.health_resolution_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`)).toEqual([{reason:null}]);

    // A later reservation from an older, equal-max snapshot cannot overtake current.
    await copyFile(join(fixtures,'day_repair_fixture.py'),join(ext,'day_repair_fixture.py'));
    marker.stale_new_steps=7777; marker.stale_fetch_ms=2000000000001; marker.source_max_ms=2100000000000; await writeMarker();
    const newManifest=JSON.parse(await readFile(manifestPath,'utf8'));
    newManifest.work.find((w:any)=>w.kind==='garmin.normalize').entry='day_repair_fixture.py';
    await writeFile(manifestPath,JSON.stringify(newManifest));
    await queue('garmin.normalize');
    expect(JSON.parse(await readFile(join(home,'day-stale-result.json'),'utf8'))).toEqual({rejected:true,older_rejected:true});
    expect((await currentDay())[0]?.value).toBe(7777);
    expect(await fixture.db.rows(`select reason from brain.health_resolution_v1 where dataset='${dataset}' and metric='day_summary.steps' and local_date='2026-01-01'`)).toEqual([{reason:null}]);
    await copyFile(join(fixtures,'publisher_contract_fixture.py'),join(ext,'publisher_contract_fixture.py'));
    newManifest.work.find((w:any)=>w.kind==='garmin.normalize').entry='publisher_contract_fixture.py';
    await writeFile(manifestPath,JSON.stringify(newManifest));
    await queue('garmin.normalize');
    const keys=JSON.parse(await readFile(join(home,'publisher-contract-keys.json'),'utf8'));
    const contract=await fixture.db.rows(`select original_table,original_key,sub_identity,metric,value,value_type,value_text,encode(value_text_raw,'hex') raw_hex,value_text_encoding,value_json,unit,local_date::text,to_char(observed_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') observed,time_zone,activity_id from brain.health_observations where dataset='${dataset}' and (activity_id='synthetic-activity-9' or original_table in ('hr_sample','day_summary') and (local_date='2026-03-03' or observed_at='2023-11-14 22:33:54+00')) order by metric`);
    const byMetric=(metric:string)=>contract.find(r=>r.metric===metric)!;
    for(const row of contract) { expect(row.original_key).toBe(keys[row.original_table]); expect(row.sub_identity).toBe(row.original_key); expect(row.time_zone).toBe('Asia/Seoul'); }
    expect(byMetric('activity.type_key')).toMatchObject({value_type:'text',value_text:'러닝�원본',raw_hex:Buffer.from('러닝\0원본').toString('hex'),value_text_encoding:'utf-8',unit:'category',local_date:'2026-03-03',observed:null,activity_id:'synthetic-activity-9'});
    expect(byMetric('exercise_set.exercise_name')).toMatchObject({value_text:'스쿼트�원본',raw_hex:Buffer.from('스쿼트\0원본').toString('hex'),value_text_encoding:'utf-8',unit:'category',local_date:'2026-03-03'});
    expect(byMetric('exercise_set.weight_g')).toMatchObject({value:40500,unit:'g',local_date:'2026-03-03'});
    expect(byMetric('exercise_log.sets')).toMatchObject({value:3,unit:'count',local_date:'2026-03-03',activity_id:'synthetic-activity-9'});
    expect(byMetric('day_summary.drinks_json')).toMatchObject({value_type:'json',value_json:[{count:2,name:'물'}],unit:'json',local_date:'2026-03-03'});
    expect(byMetric('hr_sample.bpm')).toMatchObject({value:65,unit:'bpm',local_date:null,observed:'2023-11-14T22:33:54Z'});
    const settings=JSON.stringify({version:1,extension:'garmin',values:{'garmin.timezone':'Asia/Seoul'}});
    const work=(await fixture.db.rows("select id from brain.work_items where kind='garmin.normalize' order by created_at desc limit 1"))[0]!.id;
    const token=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${work}'`))[0]!.token;
    const beforeStopped=await fixture.db.rows(`select count(*)::int n from brain.health_observations where dataset='${dataset}'`);
    const result=execFileSync(python,['-c',"import sys;sys.path.insert(0,sys.argv[1]);import normalize_store as n;\ntry: n.publish_item(__import__('psycopg').connect(sys.argv[2],autocommit=True), '12345',sys.argv[3],sys.argv[4],'day','2026-01-01','user_summary','{}',1,'Asia/Seoul',{},[])\nexcept ValueError as e: print(str(e))",join(ext,'src'),(await import('../src/config/codec.js')).extensionDatabaseUrl ? await (await import('../src/config/codec.js')).extensionDatabaseUrl(home,'garmin',fixture.db.appUrl) : '',String(work),String(token)],{encoding:'utf8'});
    expect(result).toContain('COLLECT_INVALID_ATTEMPT');
    expect(await fixture.db.rows(`select count(*)::int n from brain.health_observations where dataset='${dataset}'`)).toEqual(beforeStopped);
    expect(JSON.stringify(await fixture.db.rows('select * from garmin.normalize_items'))).not.toContain('synthetic-token-canary');
    void settings;
  } finally {controller.abort(); await daemon; await store.close(); await fixture.cleanup();}
},360000);
