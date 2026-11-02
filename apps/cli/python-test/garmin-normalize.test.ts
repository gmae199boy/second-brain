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
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    for(const w of manifest.work) if(w.kind.startsWith('garmin.collect')) w.entry='collect_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const marker={home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,response:{totalSteps:2222,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null},responses:{} as Record<string,unknown>};
    const writeMarker=()=>writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker)); await writeMarker();
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imp=await fixture.run(['ext','run','garmin','import','--json']);
    expect(imp.code,imp.stdout+imp.stderr).toBe(0);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${imp.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const v1=await fixture.db.rows("select * from brain.health_authority_rules where account='12345' and revision=1");
    const provenance=await fixture.db.rows("select * from garmin.authority_provenance where account='12345'");
    const queue=async(kind:string,day?:string)=>{
      const id=ids.next(), now=new Date();
      expect(await store.addWork({id,kind,targetKind:'account',targetId:'12345',createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
      if(day) await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='Asia/Seoul',next_attempt_at=now() where id='${id}'`);
      else await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${id}'`);
      await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
      return id;
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
    expect((await fixture.db.rows("select datasets from garmin.authority_v2"))[0]?.datasets).toEqual([dataset,...provenance[0]!.datasets]);
    await fixture.db.query(`insert into garmin.collect_targets(target_kind,target_id,account,dataset) values ('account','12345','12345','${dataset}') on conflict do nothing`);
    const before=await fixture.db.rows(`select original_table,local_date::text,count(*)::int n from brain.health_observations where dataset='${dataset}' group by original_table,local_date order by original_table,local_date`);
    await queue('garmin.normalize');
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
    await queue('garmin.normalize');
    const oldRhr=await fixture.db.rows(`select id,value from brain.health_observations where dataset='${dataset}' and metric='daily_metric.resting_hr' and local_date='${day}'`);
    expect(oldRhr).toHaveLength(1);
    expect(await fixture.db.rows(`select count(*)::int n from brain.health_observations where dataset='${dataset}' and original_table='hr_sample'`)).toEqual([{n:501}]);
    expect(await fixture.db.rows(`select value from brain.health_current_v1 where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}'`)).toEqual([{value:9999}]);
    await fixture.db.query(`update garmin.raw_payloads set body='{"allMetrics":"bad"}',fetched_at_ms=2000000000001,checked_at_ms=2000000000001 where dataset='${dataset}' and scope='day' and original_key='${day}' and endpoint='rhr_day'`);
    await fixture.db.query(`update garmin.raw_payloads set body='${jsonSql(summary(1111))}',fetched_at_ms=1900000000000,checked_at_ms=2000000000001 where dataset='${dataset}' and scope='day' and original_key='${day}' and endpoint='user_summary'`);
    await queue('garmin.normalize');
    expect(await fixture.db.rows(`select value from brain.health_current_v1 where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}'`)).toEqual([{value:9999}]);
    expect(await fixture.db.rows(`select id,value from brain.health_observations where dataset='${dataset}' and metric='daily_metric.resting_hr' and local_date='${day}'`)).toEqual(oldRhr);
    expect(await fixture.db.rows(`select error_code from garmin.normalize_items where dataset='${dataset}' and key='${day}' and endpoint='rhr_day' and not ok`)).toEqual([{error_code:'parse_error'}]);
    const path=join(ext,'src/normalize_store.py'), source=await readFile(path,'utf8');
    await writeFile(path,source.replace('NORMALIZATION_VERSION = 8','NORMALIZATION_VERSION = 9'));
    await fixture.db.query('insert into brain.health_supported_versions values (9)');
    await queue('garmin.normalize');
    expect(await fixture.db.rows(`select distinct normalization_version from brain.health_observations where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}' order by normalization_version`)).toEqual([{normalization_version:8},{normalization_version:9}]);
    expect(await fixture.db.rows(`select count(*)::int n from brain.health_observations where dataset='${dataset}' and metric='daily_metric.steps' and local_date='${day}' and normalization_version=8`)).toEqual([{n:2}]);
    expect(await fixture.db.rows("select value,normalization_version from brain.health_current_v1 where account='12345' and metric='daily_metric.steps' and local_date='2026-01-01'")).toEqual([{value:2222,normalization_version:9}]);
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
},120000);
