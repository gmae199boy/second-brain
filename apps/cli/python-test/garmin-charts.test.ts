import { copyFile, mkdir, readFile, realpath, writeFile, stat, unlink } from 'node:fs/promises';
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

it('그래프 요청은 core 인계와 중단 재개 및 재실행에서 수렴한다', async () => {
  const fixture=await extHome(), home=await realpath(fixture.home), ext=join(home,'extensions/garmin');
  const store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen();
  const initial=new AbortController(), restarted=new AbortController(), resumed=new AbortController();
  let supervisor: Awaited<ReturnType<typeof startDaemonSupervisor>> | undefined;
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py',import.meta.url)),join(ext,'collect_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    manifest.work.find((w:any)=>w.kind==='garmin.collect').entry='collect_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const chartPath=join(ext,'src','charts.py');
    await writeFile(chartPath,(await readFile(chartPath,'utf8'))+`\n_original_render_one = render_one\ndef render_one(home,name,size,draw):\n    if name == '01-yesterday.png' and (Path(home) / 'forbid-redraw').exists(): raise RuntimeError('unexpected redraw')\n    if name == '52-heart-30d.png': raise RuntimeError('synthetic failure')\n    if name == '57-workouts-all.png':\n        from matplotlib.figure import Figure\n        original = Figure.savefig\n        def huge(self,path,**kwargs): path.write_bytes(b'x'*10_000_001)\n        Figure.savefig = huge\n        try: return _original_render_one(home,name,size,draw)\n        finally: Figure.savefig = original\n    return _original_render_one(home,name,size,draw)\n`);
    const timestamp=Date.parse('2026-01-30T12:00:00Z');
    const marker={home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,
      response:{totalSteps:1234,restingHeartRate:55,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null},sleep_payload:null,
      responses:{heart_rates:{heartRateValueDescriptors:[{key:'timestamp',index:0},{key:'heartrate',index:1}],heartRateValues:[[timestamp,62]]},hrv_data:null,rhr_day:null,stress_data:null,body_battery:null,training_readiness:null,daily_weigh_ins:null,lifestyle_logging_data:null}};
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    await store.setSetting({key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const tokens=join(home,'fake-tokens'); await mkdir(tokens); await writeFile(join(tokens,'garmin_tokens.json'),'synthetic-token');
    await store.setSetting({key:'garmin.tokenstore',value:tokens,updatedAt:new Date()});
    supervisor=startDaemonSupervisor({home,env:fixture.env,clock:systemClock,idGen:ids,signal:initial.signal,supervisor:{pollMs:25}},await readConfig(home),{async write(){}});
    const collectDay=async(day:string)=>{
      const id=ids.next(); expect(await store.addWork({id,kind:'garmin.collect',targetKind:'extension',targetId:'default',createdAt:new Date(),nextAttemptAt:new Date(Date.now()+3600000)})).toMatchObject({ok:true});
      await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='UTC',next_attempt_at=now() where id='${id}'`);
      await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
      return id;
    };
    await collectDay('2026-01-30'); const parent=await collectDay('2026-01-31');
    const child=(await fixture.db.rows(`select work_item_id id from brain.work_dependencies where prerequisite_id='${parent}'`))[0]!.id;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${child}'`);
    try { await expect.poll(async()=> (await fixture.db.rows("select count(*)::int n from brain.file_requests where metadata->>'kind'='digest'"))[0]?.n,{timeout:30000}).toBe(1); }
    catch (error) { throw new Error(JSON.stringify(await fixture.db.rows(`select w.outcome,w.last_error,a.error_code,a.stderr from brain.work_items w left join brain.work_attempts a on a.work_item_id=w.id where w.id='${child}'`)),{cause:error}); }
    const digest=(await fixture.db.rows("select id from brain.file_requests where metadata->>'kind'='digest'"))[0]!.id;
    expect(await store.imports.handoffImport({requestId:String(digest),workId:ids.next(),now:new Date()})).toMatchObject({ok:true});
    const {drainQueue,importFileHandler,FILE_IMPORT_KIND}=await import('second_brain');
    const {memorySpool}=await import('second_brain/testing');
    const {importStaging}=await import('../src/runtime/import-staging.js');
    const {localFileStore}=await import('../src/runtime/file-store.js');
    const handler=importFileHandler(store.imports,importStaging(home),localFileStore({root:join(home,'files')}),systemClock,ids,store,store);
    await drainQueue({store,clock:systemClock,idGen:ids,spool:memorySpool()},{budgetMs:10000,handlers:{[FILE_IMPORT_KIND]:handler}});
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int n from brain.file_requests where metadata->>'kind'='graph'"))[0]?.n,{timeout:60000}).toBe(1);
    const pending=(await fixture.db.rows("select id,locator from brain.file_requests where metadata->>'kind'='graph'"))[0]!;
    expect((await stat(join(ext,'staging',String(pending.locator)))).size).toBeGreaterThan(0);
    const pid=(await fixture.db.rows(`select pid from brain.work_attempts where work_item_id='${child}' and outcome is null`))[0]!.pid as number;
    process.kill(pid,'SIGKILL');
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_attempts where work_item_id='${child}' order by started_at limit 1`))[0]?.outcome,{timeout:20000}).not.toBeNull();
    initial.abort(); await supervisor.stop(); supervisor=undefined;
    expect((await stat(join(ext,'staging',String(pending.locator)))).mode & 0o777).toBe(0o600);
    expect(await store.imports.handoffImport({requestId:String(pending.id),workId:ids.next(),now:new Date()})).toMatchObject({ok:true});
    expect(await drainQueue({store,clock:systemClock,idGen:ids,spool:memorySpool()},{budgetMs:10000,handlers:{[FILE_IMPORT_KIND]:handler}})).toMatchObject({failed:0});
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${child}'`);
    supervisor=startDaemonSupervisor({home,env:fixture.env,clock:systemClock,idGen:ids,signal:restarted.signal,supervisor:{pollMs:25}},await readConfig(home),{async write(){}});
    // Corrupt the next staged synthetic graph so the real core handler rejects it.
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int n from brain.file_requests where metadata->>'kind'='graph'"))[0]?.n,{timeout:60000}).toBe(2);
    const rejected=(await fixture.db.rows(`select id,locator,metadata from brain.file_requests where metadata->>'kind'='graph' and id<>'${pending.id}'`))[0]!;
    await writeFile(join(ext,'staging',String(rejected.locator)),'corrupt synthetic graph');
    expect(await store.imports.handoffImport({requestId:String(rejected.id),workId:ids.next(),now:new Date()})).toMatchObject({ok:true});
    expect(await drainQueue({store,clock:systemClock,idGen:ids,spool:memorySpool()},{budgetMs:10000,handlers:{[FILE_IMPORT_KIND]:handler}})).toMatchObject({failed:1});
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${child}'`))[0]?.outcome,{timeout:90000}).toBe('succeeded');
    restarted.abort(); await supervisor.stop(); supervisor=undefined;
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:resumed.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const summary=(await fixture.db.rows(`select result_summary from brain.work_attempts where work_item_id='${child}' and outcome='succeeded'`))[0]!.result_summary as any;
    const failedNames=summary.graphs_failed_names.split(',');
    expect(failedNames).toEqual(expect.arrayContaining(['52-heart-30d.png','57-workouts-all.png',(rejected.metadata as any).name]));
    const rows=await fixture.db.rows("select q.id,q.metadata,q.media_type,q.size_bytes,r.file_id,r.error_code,l.locator,case when r.file_id is not null then 'completed' when r.error_code is not null then 'failed' else 'pending' end status from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id left join brain.files f on f.id=r.file_id left join brain.file_locations l on l.id=f.home_location_id where q.metadata->>'kind'='graph'");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some(r=>r.id===pending.id && r.file_id)).toBe(true);
    expect(rows.some(r=>r.id===rejected.id && !r.file_id)).toBe(true);
    for (const row of rows) {
      const meta=row.metadata as any;
      expect(meta).toMatchObject({kind:'graph',local_date:'2026-01-31',name:expect.stringMatching(/^[0-9]{2}-[a-z0-9-]+\.png$/),collect_result_id:parent,revision:expect.stringMatching(/^[0-9a-f]{64}$/)});
      expect(meta.role).toBe(Number(meta.name.slice(0,2))<50?'today':'trend');
      if (!row.file_id) {
        expect(failedNames).toContain(meta.name);
        continue;
      }
      expect(row.status).toBe('completed');
      expect(row.error_code).toBeNull();
      expect(row.locator).toBeTruthy();
      expect(row.media_type).toBe('image/png');
      const bytes=await readFile(join(home,'files',String(row.locator)));
      expect(bytes.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(bytes.readUInt32BE(16)).toBe(1800); expect(bytes.readUInt32BE(20)).toBe(900);
      expect(Number(row.size_bytes)).toBe(bytes.length);
    }
    await writeFile(join(ext,'forbid-redraw'),'');
    const queued=await fixture.run(['ext','run','garmin','artifacts','--json']); expect(queued.code).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${queued.body.data.work_id}'`))[0]?.outcome,{timeout:90000}).toBe('succeeded');
    expect((await fixture.db.rows("select count(*)::int n from brain.file_requests where metadata->>'kind'='graph'"))[0]!.n).toBe(rows.length);
    const repeatSummary=(await fixture.db.rows(`select result_summary from brain.work_attempts where work_item_id='${queued.body.data.work_id}' and outcome='succeeded'`))[0]!.result_summary as any;
    expect(repeatSummary.graphs_failed_names.split(',')).not.toContain('01-yesterday.png');
    await unlink(join(ext,'forbid-redraw'));
    // A changed heart sample changes yesterday's revision, while unrelated graph requests stay reusable.
    await fixture.db.query("update garmin.raw_payloads set body=jsonb_set(body::jsonb,'{heartRateValues,0,1}','70')::text, fetched_at_ms=fetched_at_ms+1 where account='fixture-account' and scope='day' and original_key='2026-01-30' and endpoint='heart_rates'");
    const changedParent=await collectDay('2026-01-31');
    const changedChild=(await fixture.db.rows(`select work_item_id id from brain.work_dependencies where prerequisite_id='${changedParent}'`))[0]!.id;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${changedChild}'`);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${changedChild}'`))[0]?.outcome,{timeout:90000}).toBe('succeeded');
    const after=await fixture.db.rows("select id,metadata from brain.file_requests where metadata->>'kind'='graph'");
    expect(after).toHaveLength(rows.length+1);
    expect(after.filter(r=>(r.metadata as any).name==='01-yesterday.png')).toHaveLength(2);
    expect(after.filter(r=>(r.metadata as any).name!=='01-yesterday.png').map(r=>r.id).sort()).toEqual(rows.filter(r=>(r.metadata as any).name!=='01-yesterday.png').map(r=>r.id).sort());
  } finally { initial.abort(); restarted.abort(); if(supervisor) await supervisor.stop(); resumed.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup(); }
},240000);
