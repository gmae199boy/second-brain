import { copyFile, mkdir, readFile, realpath, rename, writeFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import pg from 'pg';
import { extensionDatabaseUrl } from '../src/config/codec.js';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { postgresStore } from 'second_brain/postgres';
import { runDaemon } from '../src/daemon/run.js';
import { startDaemonSupervisor } from '../src/daemon/supervisor.js';
import { readConfig } from '../src/config/codec.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

it('감독자가 원본 인계와 중단 재개 및 늦은 측정을 처리한다', async () => {
  const fixture=await extHome(), home=await realpath(fixture.home), ext=join(home,'extensions/garmin');
  const store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen();
  const initial=new AbortController(), resumed=new AbortController();
  let supervisor: Awaited<ReturnType<typeof startDaemonSupervisor>> | undefined;
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py',import.meta.url)),join(ext,'collect_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    for (const work of manifest.work) if (work.kind==='garmin.collect') work.entry='collect_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const marker={home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,response:{totalSteps:1234,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null},fail_endpoint:'',guard_status:0,publish_failure:false,sleep_payload:null,responses:{hrv_data:null,rhr_day:null,heart_rates:null,stress_data:null,body_battery:null,training_readiness:null,daily_weigh_ins:null,lifestyle_logging_data:null}};
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const tokens=join(home,'fake-tokens'); await mkdir(tokens); await writeFile(join(tokens,'garmin_tokens.json'),'synthetic-token');
    await store.setSetting({key:'garmin.tokenstore',value:tokens,updatedAt:new Date()});
    const inbox=join(ext,'inbox','inbody'); await mkdir(inbox,{recursive:true});
    const image=join(inbox,'synthetic.png'); await writeFile(image,'synthetic image');
    const python=join(ext,'.venv/bin/python');
    execFileSync(python,['-c',`import json,os,sys\np=sys.argv[1]\nd={'schema_version':1,'measured_on':'2026-01-31','values':{'weight_kg':80},'value_mtime_ns':{'weight_kg':os.stat(p).st_mtime_ns},'source_files':['inbox/inbody/synthetic.png']}\nopen(sys.argv[2],'w').write(json.dumps(d))`,image,join(inbox,'measurement.json')]);
    supervisor=startDaemonSupervisor({home,env:fixture.env,clock:systemClock,idGen:ids,signal:initial.signal,supervisor:{pollMs:25}},await readConfig(home),{async write(){}});
    // Seed the prior day before parent A takes its immutable snapshot.
    const now=new Date(), seed=ids.next();
    expect(await store.addWork({id:seed,kind:'garmin.collect',targetKind:'extension',targetId:'default',createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
    await fixture.db.query(`update brain.work_items set local_date_from='2026-01-30',local_date_to='2026-01-30',local_time_zone='UTC',next_attempt_at=now() where id='${seed}'`);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${seed}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const id=ids.next();
    // Simulate an upgrade while an older collect is already waiting.
    await fixture.db.query("update brain.extension_work_kinds set followup_kind=null where kind='garmin.collect'");
    expect(await store.addWork({id,kind:'garmin.collect',targetKind:'extension',targetId:'default',createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
    expect(await fixture.db.rows(`select work_item_id from brain.work_dependencies where prerequisite_id='${id}'`)).toHaveLength(0);
    const registration={name:'garmin',version:manifest.version,now,workKinds:manifest.work.map((work:any)=>work.kind),workFollowups:Object.fromEntries(manifest.work.filter((work:any)=>work.followup).map((work:any)=>[work.kind,work.followup]))};
    expect(await store.recordExtensionInstall(registration)).toMatchObject({ok:true});
    expect(await store.recordExtensionInstall(registration)).toMatchObject({ok:true});
    expect(await fixture.db.rows(`select work_item_id from brain.work_dependencies where prerequisite_id='${id}'`)).toHaveLength(1);
    await fixture.db.query(`update brain.work_items set local_date_from='2026-01-31',local_date_to='2026-01-31',local_time_zone='UTC',next_attempt_at=now() where id='${id}'`);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    // B observes different prior-day data while A's artifact remains delayed.
    await fixture.db.query("update garmin.raw_payloads set body=jsonb_set(body::jsonb,'{totalSteps}','9876')::text, fetched_at_ms=fetched_at_ms+1000 where account='fixture-account' and scope='day' and original_key='2026-01-30' and endpoint='user_summary'");
    const parentB=ids.next();
    expect(await store.addWork({id:parentB,kind:'garmin.collect',targetKind:'extension',targetId:'default',createdAt:new Date(),nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
    await fixture.db.query(`update brain.work_items set local_date_from='2026-01-31',local_date_to='2026-01-31',local_time_zone='UTC',next_attempt_at=now() where id='${parentB}'`);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${parentB}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const parentSnapshots=await fixture.db.rows(`select c.work_id,i.body::jsonb->>'totalSteps' steps from garmin.collect_snapshots c join garmin.collect_snapshot_items i on i.snapshot_id=c.id where c.work_id in ('${id}','${parentB}') and i.scope='day' and i.key='2026-01-30' and i.endpoint='user_summary' order by c.work_id`);
    expect(parentSnapshots).toHaveLength(2);
    expect(parentSnapshots.find(r=>r.work_id===id)?.steps).toBe('1234');
    expect(parentSnapshots.find(r=>r.work_id===parentB)?.steps).toBe('9876');
    const child=(await fixture.db.rows(`select w.id from brain.work_items w join brain.work_dependencies d on d.work_item_id=w.id where d.prerequisite_id='${id}'`))[0]!.id;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${child}'`);
    try { await expect.poll(async()=> (await fixture.db.rows("select count(*)::int n from brain.file_requests where metadata->>'kind'='body_source'"))[0]?.n,{timeout:15000}).toBe(1); }
    catch (error) { throw new Error(JSON.stringify(await fixture.db.rows(`select w.outcome,w.last_error,a.error_code,a.stderr from brain.work_items w left join brain.work_attempts a on a.work_item_id=w.id where w.id='${child}'`)), { cause: error }); }
    expect(await readFile(image,'utf8')).toBe('synthetic image');
    expect((await fixture.db.rows("select count(*)::int n from brain.file_request_results"))[0]?.n).toBe(0);
    const sourceRequest=(await fixture.db.rows("select id from brain.file_requests where metadata->>'kind'='body_source'"))[0]!.id;
    const pid=(await fixture.db.rows(`select pid from brain.work_attempts where work_item_id='${child}' and outcome is null`))[0]!.pid as number;
    process.kill(pid,'SIGKILL');
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_attempts where work_item_id='${child}' order by started_at limit 1`))[0]?.outcome,{timeout:20000}).not.toBeNull();
    initial.abort(); await supervisor.stop(); supervisor=undefined;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${child}'`);
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:resumed.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${child}'`))[0]?.outcome,{timeout:60000}).not.toBeNull();
    expect((await fixture.db.rows(`select outcome from brain.work_items where id='${child}'`))[0]?.outcome).toBe('succeeded');
    expect(await stat(image).then(()=>true).catch(()=>false)).toBe(false);
    expect((await fixture.db.rows("select id from brain.file_requests where metadata->>'kind'='body_source'"))[0]!.id).toBe(sourceRequest);
    const original=(await fixture.db.rows(`select l.locator from brain.file_request_results r join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id where r.request_id='${sourceRequest}'`))[0]!;
    expect(await readFile(join(home,'files',String(original.locator)),'utf8')).toBe('synthetic image');

    const measured=await fixture.db.rows("select sidecar,field_sources from garmin.body_measurements where measured_on='2026-01-31'");
    expect((measured[0]!.sidecar as any).values.weight_kg).toBe(80);
    expect((measured[0]!.field_sources as any).weight_kg).toHaveLength(1);
    const requests=await fixture.db.rows("select metadata,sha256 from brain.file_requests where metadata->>'kind'='digest'");
    expect(requests).toHaveLength(1);
    expect(requests[0]!.metadata).toMatchObject({collect_result_id:id,timezone:'UTC',local_date:'2026-01-31',cutoff_ms:expect.any(Number),revision:expect.any(String)});
    const stored=(await fixture.db.rows(`select l.locator,q.metadata,q.sha256 from brain.file_requests q join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id where q.metadata->>'kind'='digest'`))[0]!;
    const digestBytes=await readFile(join(home,'files',String(stored.locator)));
    expect(createHash('sha256').update(digestBytes).digest('hex')).toBe(stored.sha256);
    const extUrl=await extensionDatabaseUrl(home,'garmin',fixture.db.appUrl);
    const childToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${child}' and outcome='succeeded'`))[0]!.token;
    const extensionDb=new pg.Client({connectionString:extUrl}); await extensionDb.connect();
    try {
      await expect(extensionDb.query('select * from brain.extension_predecessor_results($1,$2)',[child,childToken])).rejects.toMatchObject({code:'BRS01'});
      await expect(extensionDb.query('select * from brain.extension_predecessor_results($1,$2)',[child,randomUUID()])).rejects.toMatchObject({code:'BRS01'});
    } finally { await extensionDb.end(); }
    const collectResult=(await fixture.db.rows(`select result_summary from brain.work_attempts where work_item_id='${id}' and outcome='succeeded'`))[0]!.result_summary;
    const comparison=`import sys,json,psycopg,datetime\nsys.path.insert(0,sys.argv[1])\nimport collect_store,digest,labels\nwith psycopg.connect(sys.argv[2],autocommit=True) as c:\n raw=collect_store.artifact_snapshot(c,'fixture-account',json.loads(sys.argv[3])['snapshot_id'],sys.argv[4])['raw']\n body=[x[0] for x in c.execute('select sidecar from garmin.body_measurements order by measured_on').fetchall()]\nr=json.loads(sys.argv[3]); day=datetime.date.fromisoformat(r['local_date'])\ndays={}\nacts={}\nfor i in raw:\n if i['scope']=='day' and i['key']==day.isoformat() and i['endpoint'] in ('user_summary','body_battery'): continue\n d=days if i['scope']=='day' else acts\n d.setdefault(i['key'],{})[i['endpoint']]=json.loads(i['body'])\ncutoff=datetime.datetime.fromtimestamp(r['cutoff_ms']/1000,datetime.timezone.utc).isoformat(timespec='milliseconds')\nm={'report_date':day.isoformat(),'yesterday':(day-datetime.timedelta(days=1)).isoformat(),'baseline_days':[(day-datetime.timedelta(days=i)).isoformat() for i in range(7,0,-1)],'timezone':'UTC','data_cutoff':cutoff,'workouts':list(acts),'_workout_starts_ms':[],'weekday':'월화수목금토일'[day.weekday()],'notes':[],'collect':r}\nsys.stdout.buffer.write(json.dumps(digest.build(m,days,acts,labels.load(),body),ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode())`;
    const expected=execFileSync(python,['-c',comparison,join(ext,'src'),extUrl,JSON.stringify(collectResult),id]);
    expect(digestBytes).toEqual(expected);
    expect(JSON.parse(digestBytes.toString('utf8')).day.yesterday.steps).toBe(1234);
    expect((stored.metadata as any).collect_result_id).toBe(id);
    expect((stored.metadata as any).collect_result_id).not.toBe(parentB);
    expect((await fixture.db.rows("select count(*)::int n from brain.health_current_v1 where account='fixture-account' and metric='day_summary.steps'"))[0]!.n).toBeGreaterThan(0);
    const dayValues=JSON.parse(await readFile(fileURLToPath(new URL('../../../extensions/garmin/tests/fixtures/digest_v8/core_current_expected.json',import.meta.url)),'utf8')).day_summary;
    const currentDay=async()=>Object.fromEntries((await fixture.db.rows("select metric,value from brain.health_current_v1 where account='fixture-account' and local_date='2026-01-31' and metric in ('day_summary.steps','day_summary.active_kcal')")).map(r=>[r.metric,r.value]));
    expect(await currentDay()).toEqual({'day_summary.steps':dayValues.steps,'day_summary.active_kcal':dayValues.active_kcal});
    expect(dayValues.steps).toBe(1234); expect(dayValues.active_kcal).toBeNull();
    const originalCount=(await fixture.db.rows("select count(*)::int n from brain.health_observations"))[0]!.n;
    const runManual=async()=>{
      const queued=await fixture.run(['ext','run','garmin','artifacts','--json']);
      expect(queued.code,queued.stdout+queued.stderr).toBe(0);
      const work=queued.body.data.work_id;
      try { await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:60000}).not.toBeNull(); } catch (error) { throw new Error(JSON.stringify({attempts:await fixture.db.rows(`select w.outcome,w.last_error,a.error_code,a.stderr from brain.work_items w left join brain.work_attempts a on a.work_item_id=w.id where w.id='${work}'`), docs:await fixture.db.rows("select d.fingerprint,d.completed,s.source_path,s.content_hash,s.mtime_ns,s.processed_path from garmin.body_documents d left join garmin.body_sources s using(dataset,fingerprint) where d.measured_on='2026-01-30'")}),{cause:error}); }
      expect((await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome).toBe('succeeded');
    };
    // The manual command selects the latest parent, B. Complete its deliberately
    // delayed automatic child first and verify B's distinct core artifact.
    const childB=(await fixture.db.rows(`select work_item_id id from brain.work_dependencies where prerequisite_id='${parentB}'`))[0]!.id;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${childB}'`);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${childB}'`))[0]?.outcome,{timeout:60000}).toBe('succeeded');
    const storedB=(await fixture.db.rows(`select l.locator,q.metadata from brain.file_requests q join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id where q.metadata->>'kind'='digest' and q.metadata->>'collect_result_id'='${parentB}'`))[0]!;
    expect((storedB.metadata as any).collect_result_id).toBe(parentB);
    expect(JSON.parse(await readFile(join(home,'files',String(storedB.locator)),'utf8')).day.yesterday.steps).toBe(9876);
    await store.setSetting({key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()});
    await runManual();
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(3);
    expect((await fixture.db.rows("select count(*)::int n from brain.health_observations"))[0]!.n).toBe(originalCount);
    const late=join(inbox,'late.png'); await writeFile(late,'synthetic late');
    execFileSync(python,['-c',`import json,os,sys\np=sys.argv[1]\nstamp=json.load(open(sys.argv[3]))['value_mtime_ns']['weight_kg']\nos.utime(p,ns=(stamp,stamp))\nd={'schema_version':1,'measured_on':'2026-01-31','values':{'weight_kg':81,'bmi':23},'value_mtime_ns':{'weight_kg':stamp,'bmi':stamp},'source_files':['inbox/inbody/late.png']}\nopen(sys.argv[2],'w').write(json.dumps(d))`,late,join(inbox,'late.json'),join(inbox,'measurement.json')]);
    await writeFile(join(inbox,'bad-source.png'),'unaccepted');
    await writeFile(join(inbox,'bad-mtime.json'),JSON.stringify({schema_version:1,measured_on:'2026-01-31',values:{bmi:10},value_mtime_ns:{bmi:1},source_files:['inbox/inbody/bad-source.png']}));
    await writeFile(join(inbox,'invalid.json'),'{"schema_version":NaN}');
    await writeFile(join(inbox,'infinity.json'),'{"schema_version":Infinity}');
    await writeFile(join(inbox,'duplicate.json'),'{"schema_version":1,"schema_version":1}');
    await runManual();
    const updated=await fixture.db.rows("select sidecar,field_sources from garmin.body_measurements where measured_on='2026-01-31'");
    expect((updated[0]!.sidecar as any).values).toEqual({weight_kg:81,bmi:23});
    expect(await readFile(join(inbox,'bad-source.png'),'utf8')).toBe('unaccepted');
    expect((updated[0]!.field_sources as any).bmi).toHaveLength(1);
    expect(await stat(late).then(()=>true).catch(()=>false)).toBe(false);
    const afterLate=(await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n;
    expect(afterLate).toBe(5);
    await runManual();
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(afterLate);
    expect((await fixture.db.rows("select count(*)::int n from brain.health_observations"))[0]!.n).toBe(originalCount);
    const beforeReplacement=(await fixture.db.rows("select metadata->>'revision' revision from brain.file_requests where metadata->>'kind'='digest' order by created_at desc,id desc"));
    const beforeSource=(updated[0]!.field_sources as any).weight_kg[0];
    await writeFile(late,'different synthetic bytes');
    execFileSync(python,['-c',`import json,os,sys\ns=json.load(open(sys.argv[2]))['value_mtime_ns']['weight_kg']\nos.utime(sys.argv[1],ns=(s,s))`,late,join(inbox,'late.json')]);
    await runManual();
    const newSource=(await fixture.db.rows("select field_sources from garmin.body_measurements where measured_on='2026-01-31'"))[0]!.field_sources as any;
    expect(newSource.weight_kg[0]).not.toBe(beforeSource);
    const afterReplacement=(await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n;
    expect(afterReplacement).toBe(afterLate+2);
    const revisions=await fixture.db.rows("select metadata->>'revision' revision from brain.file_requests where metadata->>'kind'='digest'");
    expect(revisions.length).toBe(beforeReplacement.length+1);
    expect(new Set(revisions.map(row=>row.revision)).size).toBe(revisions.length);
    await fixture.db.query("update garmin.raw_payloads set body=jsonb_set(body::jsonb,'{totalSteps}','7777')::text, fetched_at_ms=fetched_at_ms+1 where account='fixture-account' and scope='day' and original_key='2026-01-31' and endpoint='user_summary'");
    await runManual();
    expect((await currentDay())['day_summary.steps']).toBe(7777);
    expect((await currentDay())['day_summary.active_kcal']).toBeNull();
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(afterReplacement);
    const labelPath=join(ext,'src','labels','exercise_types_ko.json');
    await writeFile(labelPath,(await readFile(labelPath,'utf8'))+'\n');
    await runManual();
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(afterReplacement+1);
    // A newer sidecar may reuse an earlier sidecar's source path and timestamp.
    await writeFile(late,'new claimant source');
    execFileSync(python,['-c',`import json,os,sys\ns=json.load(open(sys.argv[2]))['value_mtime_ns']['weight_kg']\nos.utime(sys.argv[1],ns=(s,s))\nd={'schema_version':1,'measured_on':'2026-01-31','values':{'weight_kg':82},'value_mtime_ns':{'weight_kg':s},'source_files':['inbox/inbody/late.png']}\nopen(sys.argv[3],'w').write(json.dumps(d))`,late,join(inbox,'late.json'),join(inbox,'new-claim.json')]);
    await runManual();
    const newest=(await fixture.db.rows("select sidecar,field_sources from garmin.body_measurements where measured_on='2026-01-31'"))[0]!;
    expect((newest.sidecar as any).values.weight_kg).toBe(82);
    expect((newest.field_sources as any).weight_kg[0]).not.toBe(newSource.weight_kg[0]);
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(afterReplacement+3);
    // Two distinct source timestamps; simulate a stop after one move and before its ledger update.
    const first=join(inbox,'multi-a.png'), second=join(inbox,'multi-b.png'), multi=join(inbox,'multi.json');
    await writeFile(first,'old-a'); await writeFile(second,'old-b');
    execFileSync(python,['-B','-c',`import json,os,sys\na,b,p=sys.argv[1:]; t=os.stat(a).st_mtime_ns; os.utime(b,ns=(t+1000000000,t+1000000000))\nd={'schema_version':1,'measured_on':'2026-01-30','values':{'weight_kg':70,'bmi':22},'value_mtime_ns':{'weight_kg':t,'bmi':t+1000000000},'source_files':['inbox/inbody/multi-a.png','inbox/inbody/multi-b.png']}\nopen(p,'w').write(json.dumps(d))`,first,second,multi]);
    await runManual();
    const oldSources=await fixture.db.rows("select fingerprint,source_path,request_id,processed_path from garmin.body_sources where source_path in ('inbox/inbody/multi-a.png','inbox/inbody/multi-b.png') order by source_path");
    expect(oldSources).toHaveLength(2);
    for(const row of oldSources) expect(await readFile(join(ext,String(row.processed_path)),'utf8')).toBe(row.source_path==='inbox/inbody/multi-a.png'?'old-a':'old-b');
    // Reconstruct the crash boundary: A moved without ledger update, B still in inbox.
    await rename(join(ext,String(oldSources[1]!.processed_path)),second);
    await fixture.db.query(`update garmin.body_documents set completed=false where fingerprint='${oldSources[0]!.fingerprint}'; update garmin.body_sources set processed_path=null where fingerprint='${oldSources[0]!.fingerprint}'`);
    expect(await readFile(second,'utf8')).toBe('old-b');
    await writeFile(first,'new-a');
    execFileSync(python,['-B','-c',`import json,os,sys\ns=json.load(open(sys.argv[2]))['value_mtime_ns']['weight_kg']; os.utime(sys.argv[1],ns=(s,s))`,first,multi]);
    await runManual();
    const recovered=await fixture.db.rows(`select d.completed,s.source_path,s.request_id,s.processed_path from garmin.body_documents d join garmin.body_sources s using(dataset,fingerprint) where d.fingerprint='${oldSources[0]!.fingerprint}' order by s.source_path`);
    expect(recovered).toHaveLength(2); expect(recovered.every(r=>r.completed && r.processed_path)).toBe(true);
    expect(recovered.map(r=>r.request_id)).toEqual(oldSources.map(r=>r.request_id));
    const rowsMulti=await fixture.db.rows("select s.request_id,s.processed_path from garmin.body_sources s where source_path='inbox/inbody/multi-a.png' order by s.fingerprint");
    expect(rowsMulti).toHaveLength(2);
    expect(new Set(rowsMulti.map(r=>r.request_id)).size).toBe(2);
    expect((await Promise.all(rowsMulti.map(r=>readFile(join(ext,String(r.processed_path)),'utf8')))).sort()).toEqual(['new-a','old-a']);
    const coreSources=await fixture.db.rows("select q.id,l.locator from brain.file_requests q join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id where q.id in (select request_id from garmin.body_sources where source_path in ('inbox/inbody/multi-a.png','inbox/inbody/multi-b.png'))");
    expect(coreSources).toHaveLength(3);
    expect((await Promise.all(coreSources.map(r=>readFile(join(home,'files',String(r.locator)),'utf8')))).sort()).toEqual(['new-a','old-a','old-b']);
    const rel=await fixture.db.rows("select field_sources from garmin.body_measurements where measured_on='2026-01-30'");
    expect((rel[0]!.field_sources as any).weight_kg[0]).toBe(rowsMulti.find(r=>r.request_id!==oldSources[0]!.request_id)!.request_id);
    expect((rel[0]!.field_sources as any).bmi[0]).toBe(oldSources[1]!.request_id);
    const stableCount=(await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n;
    await runManual(); expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(stableCount);

    // A duplicate value key with otherwise valid provenance must not register its source.
    const duplicateImage=join(inbox,'duplicate-valid.png'); await writeFile(duplicateImage,'duplicate-source');
    execFileSync(python,['-B','-c',`import os,sys\nt=os.stat(sys.argv[1]).st_mtime_ns\nopen(sys.argv[2],'w').write('{"schema_version":1,"measured_on":"2026-01-30","values":{"weight_kg":70,"weight_kg":71},"value_mtime_ns":{"weight_kg":%d},"source_files":["inbox/inbody/duplicate-valid.png"]}'%t)`,duplicateImage,join(inbox,'duplicate-valid.json')]);
    const beforeDuplicate=await fixture.db.rows("select sidecar,field_sources from garmin.body_measurements where measured_on='2026-01-30'");
    await runManual();
    expect(await fixture.db.rows("select sidecar,field_sources from garmin.body_measurements where measured_on='2026-01-30'")).toEqual(beforeDuplicate);
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests"))[0]!.n).toBe(stableCount);
    expect(await readFile(duplicateImage,'utf8')).toBe('duplicate-source');

    // A newer malformed claimant must not steal a valid resubmitted source.
    await writeFile(first,'third-a');
    execFileSync(python,['-B','-c',`import json,os,sys\ns=json.load(open(sys.argv[2]))['value_mtime_ns']['weight_kg']; os.utime(sys.argv[1],ns=(s,s))\nd={'schema_version':1,'measured_on':'2026-01-30','values':{'weight_kg':99,'bmi':20},'value_mtime_ns':{'weight_kg':s,'bmi':1},'source_files':['inbox/inbody/multi-a.png']}\nopen(sys.argv[3],'w').write(json.dumps(d))`,first,multi,join(inbox,'invalid-claim.json')]);
    await runManual();
    expect(await stat(first).then(()=>true).catch(()=>false)).toBe(false);
    const claims=await fixture.db.rows("select request_id,processed_path from garmin.body_sources where source_path='inbox/inbody/multi-a.png'");
    expect(claims).toHaveLength(3);
    expect((await Promise.all(claims.map(r=>readFile(join(ext,String(r.processed_path)),'utf8')))).sort()).toEqual(['new-a','old-a','third-a']);
    const artifactResult=(await fixture.db.rows(`select result_summary from brain.work_attempts where work_item_id='${child}' and outcome='succeeded'`))[0]!.result_summary as any;
    expect(artifactResult).toMatchObject({status:'success',request_id:expect.any(String),revision:expect.any(String)});
    expect((await fixture.db.rows("select count(*)::int n from brain.work_attempts where input_tokens is not null or output_tokens is not null"))[0]!.n).toBe(0);
    expect(await readFile(join(home,'collect-outbound'),'utf8').catch(()=>'' )).toBe('');
  } finally {
    initial.abort(); if (supervisor) await supervisor.stop();
    resumed.abort(); if (daemon) await daemon;
    await store.close(); await fixture.cleanup();
  }
},180000);

it('core 파일 인계 실패는 body 작업에서 최종 실패로 전파된다', async () => {
  const fixture=await extHome(), home=await realpath(fixture.home), ext=join(home,'extensions/garmin');
  const store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen(), controller=new AbortController();
  let supervisor: Awaited<ReturnType<typeof startDaemonSupervisor>> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py',import.meta.url)),join(ext,'collect_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.work.find((work:any)=>work.kind==='garmin.collect').entry='collect_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const marker={home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,response:{totalSteps:1234,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null},sleep_payload:null,responses:{hrv_data:null,rhr_day:null,heart_rates:null,stress_data:null,body_battery:null,training_readiness:null,daily_weigh_ins:null,lifestyle_logging_data:null}};
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const tokens=join(home,'fake-tokens'); await mkdir(tokens); await writeFile(join(tokens,'garmin_tokens.json'),'synthetic-token');
    await store.setSetting({key:'garmin.tokenstore',value:tokens,updatedAt:new Date()});
    const inbox=join(ext,'inbox','inbody'); await mkdir(inbox,{recursive:true});
    const image=join(inbox,'failed.png'); await writeFile(image,'original source');
    execFileSync(join(ext,'.venv/bin/python'),['-B','-c',`import json,os,sys\np=sys.argv[1]\nd={'schema_version':1,'measured_on':'2026-01-31','values':{'weight_kg':80},'value_mtime_ns':{'weight_kg':os.stat(p).st_mtime_ns},'source_files':['inbox/inbody/failed.png']}\nopen(sys.argv[2],'w').write(json.dumps(d))`,image,join(inbox,'failed.json')]);
    supervisor=startDaemonSupervisor({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,supervisor:{pollMs:25}},await readConfig(home),{async write(){}});
    const id=ids.next(),now=new Date();
    expect(await store.addWork({id,kind:'garmin.collect',targetKind:'extension',targetId:'default',createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
    await fixture.db.query(`update brain.work_items set local_date_from='2026-01-31',local_date_to='2026-01-31',local_time_zone='UTC',next_attempt_at=now() where id='${id}'`);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const child=(await fixture.db.rows(`select work_item_id id from brain.work_dependencies where prerequisite_id='${id}'`))[0]!.id;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${child}'`);
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int n from brain.file_requests where metadata->>'kind'='body_source'"))[0]?.n,{timeout:30000}).toBe(1);
    const request=(await fixture.db.rows("select id,locator from brain.file_requests where metadata->>'kind'='body_source'"))[0]!;
    // Corrupt only the staged synthetic copy; the real core import handler rejects it.
    await writeFile(join(ext,'staging',String(request.locator)),'corrupt');
    expect(await store.imports.handoffImport({requestId:String(request.id),workId:ids.next(),now:new Date()})).toMatchObject({ok:true});
    const {drainQueue,importFileHandler,FILE_IMPORT_KIND}=await import('second_brain');
    const {memorySpool}=await import('second_brain/testing');
    const {importStaging}=await import('../src/runtime/import-staging.js');
    const {localFileStore}=await import('../src/runtime/file-store.js');
    const handler=importFileHandler(store.imports,importStaging(home),localFileStore({root:join(home,'files')}),systemClock,ids,store,store);
    expect(await drainQueue({store,clock:systemClock,idGen:ids,spool:memorySpool()},{budgetMs:10000,handlers:{[FILE_IMPORT_KIND]:handler}})).toMatchObject({failed:1});
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${child}'`))[0]?.outcome,{timeout:30000}).toBe('failed');
    expect(await fixture.db.rows(`select error_code,error_retryable from brain.work_attempts where work_item_id='${child}' and outcome='failed'`)).toEqual([{error_code:'ARTIFACT_FILE_FAILED',error_retryable:false}]);
    expect(await readFile(image,'utf8')).toBe('original source');
    expect((await fixture.db.rows('select count(*)::int n from garmin.body_measurements'))[0]!.n).toBe(0);
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests q join brain.file_request_results r on r.request_id=q.id where q.metadata->>'kind'='digest' and r.file_id is not null"))[0]!.n).toBe(0);
  } finally { controller.abort(); if (supervisor) await supervisor.stop(); await store.close(); await fixture.cleanup(); }
},120000);
