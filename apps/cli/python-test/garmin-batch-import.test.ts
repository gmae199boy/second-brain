import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('다섯 합성 snapshot의 원형과 키를 보존하고 재실행한다', async () => {
  const { realpath } = await import('node:fs/promises');
  const { postgresStore } = await import('second_brain/postgres');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const fixture = await extHome();
  const store = postgresStore({ databaseUrl: fixture.db.appUrl });
  try {
    const installed = await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code, installed.stdout + installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python');
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    const code="import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; d=pathlib.Path(sys.argv[2]); capture_manifest(d,five_candidates(d,rich=True))";
    execFileSync(python,['-c',code,fixtures,fixture.home]);
    const manifest=await realpath(join(fixture.home,'manifest.json'));
    const ids=uuidV7IdGen(), channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot')`);
    await fixture.db.query(`insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('synthetic-D1','12345',true);
      insert into garmin.import_batches values ('tracer-seed','synthetic-D1',now());
      insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body)
      values ('synthetic-D1','tracer-seed','12345','day','2026-01-01','user_summary',1700000000123,1700000000456,'test-1','{"userProfileId": 12345, "한글": null, "order": [2,1]}')`);
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const run = async () => {
      const id=ids.next(), token=ids.next(), now=new Date();
      await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:id,createdAt:now,nextAttemptAt:now});
      expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true});
      try { return execFileSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',env:{...process.env,BRAIN_EXTENSION_HOME:realpathSync(join(fixture.home,'extensions/garmin')),BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:id,BRAIN_ATTEMPT_TOKEN:token,BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',values:{'garmin.capture_manifest':manifest,'garmin.legacy_conversation_id':conversation}})}}); } catch (e: any) { throw new Error(String(e.stdout) + String(e.stderr)); }
    };
    await fixture.db.query('grant select on brain.health_observations to brain_ext_garmin');
    await expect(run()).rejects.toThrow('IMPORT_INVALID');
    expect(await fixture.db.rows('select count(*)::int as n from garmin.preserved_rows')).toEqual([{n:0}]);
    await fixture.db.query('revoke select on brain.health_observations from brain_ext_garmin');
    await fixture.db.query('revoke execute on function brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean) from brain_ext_garmin');
    await expect(run()).rejects.toThrow('IMPORT_INVALID');
    await fixture.db.query('grant execute on function brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean) to brain_ext_garmin');
    expect(await run()).toContain('"type": "result"');
    expect(await fixture.db.rows("select values_json->'value' as v from garmin.preserved_rows where dataset='synthetic-D1' and original_table='meta' and values_json->'key'->>'base64'='bnVsLXRleHQ='")).toEqual([{v:{type:'text',encoding:'utf-8',base64:'7ZWc6riAAOuBnQ=='}}]);
    const before=await fixture.db.rows('select dataset,original_table,original_key,values_json from garmin.preserved_rows order by dataset,original_table,original_key');
    const expectedCode = `import sys,json,pathlib
sys.path.insert(0,sys.argv[1]); from reader import read_snapshot
sys.path.insert(0,sys.argv[1]); from batch_import import encoded,canonical
root=pathlib.Path(sys.argv[2]); out=[]
for role in ('D1','D2','D3','D4','D5'):
 for name,table in read_snapshot(root/(role+'.db'))['tables'].items():
  for row in table['rows']:
   out.append({'dataset':'synthetic-'+role,'original_table':name,'original_key':canonical([encoded(row[k]) for k in table['keys']]),'values_json':{k:encoded(v) for k,v in row.items()}})
print(json.dumps(out,ensure_ascii=False))`;
    const expected = JSON.parse(execFileSync(python,['-c',expectedCode,join(fixture.home,'extensions/garmin/src'),fixture.home],{encoding:'utf8'}));
    const normalize = (rows: any[]) => rows.map(row => JSON.stringify([row.dataset,row.original_table,row.original_key,Object.keys(row.values_json).sort().map(k => [k,Object.fromEntries(Object.entries(row.values_json[k]).sort(([a],[b]) => a.localeCompare(b)))])])).sort();
    expect(normalize(before)).toEqual(normalize(expected));
    expect((await fixture.db.rows('select distinct original_table from garmin.preserved_rows')).length).toBe(20);
    expect(await fixture.db.rows('select count(*)::int as n from garmin.source_schemas')).toEqual([{n:71}]);
    expect(await fixture.db.rows("select datasets from garmin.authority_provenance where account='12345'")).toEqual([{datasets:['synthetic-D2','synthetic-D1','synthetic-D4']}]);
    const authority = (await fixture.db.rows("select rule_id from garmin.authority_provenance where account='12345'"))[0]!.rule_id;
    await fixture.db.query("alter table brain.health_authority_rules disable trigger authority_immutable; delete from brain.health_authority_rules where account='12345'; alter table brain.health_authority_rules enable trigger authority_immutable");
    expect(await run()).toContain('"type": "result"');
    expect(await fixture.db.rows("select id from brain.health_authority_rules where account='12345'")).toEqual([{id:authority}]);
    await fixture.db.query("delete from garmin.authority_provenance where account='12345'");
    expect(await run()).toContain('"type": "result"');
    expect(await fixture.db.rows("select rule_id from garmin.authority_provenance where account='12345'")).toEqual([{rule_id:authority}]);
    expect(await fixture.db.rows("select value,activity_id from brain.health_current_v1 where dataset='synthetic-D1' and metric='exercise_set.reps'")).toEqual([{value:5,activity_id:'42'}]);
    for (const field of ['account','activity_id','sub_identity']) {
      const priorConflicts = Number((await fixture.db.rows("select count(*)::int as n from garmin.import_conflicts where reason='row_mismatch'"))[0]!.n);
      await fixture.db.query(`alter table brain.health_observations disable trigger import_immutable; update brain.health_observations set ${field}_raw=convert_to(${field},'UTF8'),${field}_encoding='utf-8',${field}='변조' where dataset='synthetic-D1' and metric='exercise_set.reps'; alter table brain.health_observations enable trigger import_immutable`);
      await expect(run()).rejects.toThrow('IMPORT_CONFLICT');
      expect(await fixture.db.rows("select count(*)::int as n from garmin.import_conflicts where reason='row_mismatch'")).toEqual([{n:priorConflicts+1}]);
      expect(await fixture.db.rows(`select ${field} as value from brain.health_observations where dataset='synthetic-D1' and metric='exercise_set.reps'`)).toEqual([{value:'변조'}]);
      await fixture.db.query(`alter table brain.health_observations disable trigger import_immutable; update brain.health_observations set ${field}=convert_from(${field}_raw,'UTF8'),${field}_raw=null,${field}_encoding=null where dataset='synthetic-D1' and metric='exercise_set.reps'; alter table brain.health_observations enable trigger import_immutable`);
    }
    await fixture.db.query("update garmin.raw_payloads set body='불일치' where dataset='synthetic-D1' and endpoint='user_summary'");
    await expect(run()).rejects.toThrow('IMPORT_CONFLICT');
    expect(await fixture.db.rows("select body from garmin.raw_payloads where dataset='synthetic-D1' and endpoint='user_summary'")).toEqual([{body:'불일치'}]);
    expect((await fixture.db.rows("select id from garmin.import_conflicts where dataset='synthetic-D1' and reason='row_mismatch'")).length).toBeGreaterThan(0);
    expect(await fixture.db.rows("select value,activity_id from brain.health_current_v1 where dataset='synthetic-D1' and metric='activity.duration_s'")).toEqual([{value:60,activity_id:'42'}]);
    expect((await fixture.db.rows("select metric,value from brain.health_current_v1 where dataset='synthetic-D4' and metric like 'body_battery_sample.%'")).length).toBeGreaterThan(0);
    const links=await fixture.db.rows("select c.dataset,c.id,c.run_id,p.dataset as parent_dataset,p.original_table as parent_table from garmin.preserved_rows c join garmin.preserved_rows p on p.id=c.run_id where c.original_table='fetch_error' order by c.dataset");
    expect(links).toHaveLength(2); expect(links[0]?.run_id).not.toBe(links[1]?.run_id);
    expect(links.every(r=>r.dataset===r.parent_dataset && r.parent_table==='run')).toBe(true);
    expect(await fixture.db.rows('select conversation_id,detail,resend_eligible from brain.channel_legacy_notifications')).toEqual([{conversation_id:conversation,detail:'합성',resend_eligible:false}]);
    expect(await fixture.db.rows('select conversation_id,ok,reason,resend_eligible from brain.channel_legacy_deliveries')).toEqual([{conversation_id:conversation,ok:false,reason:'network',resend_eligible:false}]);
    expect(await fixture.db.rows('select count(*)::int as n from brain.channel_requests')).toEqual([{n:0}]);
    expect(await fixture.db.rows('select count(*)::int as n from garmin.raw_records')).toEqual([{n:9}]);
    expect(await fixture.db.rows("select batch from garmin.raw_payloads where dataset='synthetic-D1' and endpoint='user_summary'")).toEqual([{batch:'tracer-seed'}]);
    await fixture.db.query('grant select on brain.health_observations to brain_ext_garmin');
    await expect(run()).rejects.toThrow('IMPORT_INVALID');
    await fixture.db.query('revoke select on brain.health_observations from brain_ext_garmin');
    await fixture.db.query("delete from garmin.preserved_rows where dataset='synthetic-D1' and original_table='meta' and values_json->'key'->>'base64'='bnVsLXRleHQ='");
    await fixture.db.query("delete from garmin.raw_payloads where dataset='synthetic-D1' and scope='day' and endpoint='user_summary'");
    await fixture.db.query("update brain.channel_legacy_notifications set detail='다른 원문' where dataset='synthetic-D1'");
    await expect(run()).rejects.toThrow('IMPORT_CONFLICT');
    expect(await fixture.db.rows("select detail from brain.channel_legacy_notifications where dataset='synthetic-D1'")).toEqual([{detail:'다른 원문'}]);
    await fixture.db.query("delete from brain.channel_legacy_notifications where dataset='synthetic-D1'");
    await fixture.db.query("alter table brain.health_observations disable trigger import_immutable; update brain.health_observations set value=999 where dataset='synthetic-D1' and metric='exercise_set.reps'; alter table brain.health_observations enable trigger import_immutable");
    await expect(run()).rejects.toThrow('IMPORT_CONFLICT');
    expect(await fixture.db.rows("select value from brain.health_observations where dataset='synthetic-D1' and metric='exercise_set.reps'")).toEqual([{value:999}]);
    await fixture.db.query("alter table brain.health_observations disable trigger import_immutable; delete from brain.health_observations where dataset='synthetic-D1' and metric='exercise_set.reps'; alter table brain.health_observations enable trigger import_immutable");
    expect(await run()).toContain('"type": "result"');
    expect(await fixture.db.rows('select dataset,original_table,original_key,values_json from garmin.preserved_rows order by dataset,original_table,original_key')).toEqual(before);
    expect(await fixture.db.rows('select count(*)::int as n from garmin.raw_records')).toEqual([{n:9}]);
    expect(await fixture.db.rows('select conversation_id,detail from brain.channel_legacy_notifications')).toEqual([{conversation_id:conversation,detail:'합성'}]);
    expect(await fixture.db.rows("select value,activity_id from brain.health_current_v1 where dataset='synthetic-D1' and metric='exercise_set.reps'")).toEqual([{value:5,activity_id:'42'}]);
  } finally { await store.close(); await fixture.cleanup(); }
});

it('공용 명령과 실제 감독자가 capture를 반입하고 발신 없이 재실행한다', async () => {
  const { mkdir, realpath, readFile } = await import('node:fs/promises');
  const { createHash } = await import('node:crypto');
  const { createServer } = await import('node:http');
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture=await extHome(), controller=new AbortController(), ids=uuidV7IdGen();
  const store=postgresStore({databaseUrl:fixture.db.appUrl});
  let daemon: ReturnType<typeof runDaemon> | undefined, sends=0;
  const server=createServer((_req,res)=>{sends++;res.end('{}');});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture');
    await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; p=pathlib.Path(sys.argv[2]); capture_manifest(p,five_candidates(p,rich=True))",fixtures,root]);
    const snapshots=['D1','D2','D3','D4','D5'].map(r=>join(root,`${r}.db`));
    const hash=async(p:string)=>createHash('sha256').update(await readFile(p)).digest('hex');
    const hashes=await Promise.all(snapshots.map(hash));
    const channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot')`);
    await fixture.db.query(`insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    const endpoint=`http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,channelTestEndpoint:endpoint}});
    const first=await fixture.run(['ext','run','garmin','import','--json']);
    expect(first.code,first.stdout+first.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${first.body.data.work_id}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    const preflight=await fixture.run(['ext','run','garmin','import-preflight','--json']);
    expect(preflight.code,preflight.stdout+preflight.stderr).toBe(0);
    const privateReport=JSON.parse(await readFile(join(fixture.home,'extensions/garmin/reports',preflight.body.data.work_id,'private.json'),'utf8'));
    expect(privateReport.checkpoint.entries).toHaveLength(5);
    expect(privateReport.checkpoint.entries.every((r:any)=>r.conversation_id===conversation)).toBe(true);
    const counts=await fixture.db.rows('select original_table,count(*)::int as n from garmin.preserved_rows group by original_table order by original_table');
    const second=await fixture.run(['ext','run','garmin','import','--json']);
    expect(second.code,second.stdout+second.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${second.body.data.work_id}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await fixture.db.rows('select original_table,count(*)::int as n from garmin.preserved_rows group by original_table order by original_table')).toEqual(counts);
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:20000}).toBe(0);
    const verified=await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(verified.code,verified.stdout+verified.stderr).toBe(0);
    expect(verified.body.data.report.counts).toMatchObject({outbound_requests:0,outbound_results:0});
    for (const value of ['12345','2026-01-01','한글',fixture.home,...hashes]) expect(first.stdout+second.stdout+verified.stdout+verified.stderr).not.toContain(value);
    expect(await Promise.all(snapshots.map(hash))).toEqual(hashes);
    expect(await fixture.db.rows('select count(*)::int as n from brain.channel_requests')).toEqual([{n:0}]);
    expect(await fixture.db.rows("select count(*)::int as n from brain.work_items where kind='channel_send'")).toEqual([{n:0}]);
    expect(await fixture.db.rows(`select count(*)::int as n from brain.channel_legacy_notifications where conversation_id='${conversation}'`)).toEqual([{n:1}]);
    expect(await fixture.db.rows(`select count(*)::int as n from brain.channel_legacy_deliveries where conversation_id='${conversation}'`)).toEqual([{n:1}]);
    expect(sends).toBe(0);
    controller.abort(); await daemon; daemon=undefined;
    const requestId=ids.next();
    expect(await store.createChannelRequest({id:requestId,conversationId:conversation,producer:'synthetic',producerResultId:'new',purpose:'notice',revision:null,text:'합성',createdAt:new Date()})).toMatchObject({ok:true});
    expect(await store.readChannelRequest(requestId)).toMatchObject({ok:true,conversation:{id:conversation}});
    const legacyRows=await fixture.db.rows('select dataset,original_table,original_key from brain.channel_legacy_notifications union all select dataset,original_table,original_key from brain.channel_legacy_deliveries order by original_table');
    for (const row of legacyRows) expect(await store.readChannelLegacy({type:row.original_table === 'notification' ? 'notification':'delivery',dataset:row.dataset,originalTable:row.original_table,originalKey:row.original_key})).toMatchObject({ok:true,record:{conversationId:conversation,resendEligible:false}});
    const status=await store.listChannelStatuses();
    expect(status.ok && status.requests.filter(r=>r.legacy)).toHaveLength(2);
    expect(status.ok && status.requests.some(r=>r.id===requestId && !r.legacy)).toBe(true);
  } finally {
    controller.abort(); await daemon; await store.close();
    await new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()));
    await fixture.cleanup();
  }
});

it('checkpoint 중단·재개와 동시 반입 및 입력 변경 충돌을 검증한다', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { realpath, readFile, writeFile, rm } = await import('node:fs/promises');
  const { postgresStore } = await import('second_brain/postgres');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), ids=uuidV7IdGen();
  let child: ReturnType<typeof spawn> | undefined, walProcess: ReturnType<typeof spawn> | undefined, timeoutChild: ReturnType<typeof spawn> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib,sqlite3; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; p=pathlib.Path(sys.argv[2]); paths=five_candidates(p); c=sqlite3.connect(paths['D2']); c.executemany('insert into meta values (?,?)', [('extra%03d'%i,'value') for i in range(80)]); c.commit(); c.execute('pragma journal_mode=wal'); c.close(); capture_manifest(p,paths)",fixtures,fixture.home]);
    const manifest=await realpath(join(fixture.home,'manifest.json')), url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const entry=join(fixture.home,'extensions/garmin/src/import.py');
    const claim=async()=>{
      const id=ids.next(),token=ids.next(),now=new Date();
      await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:id,createdAt:now,nextAttemptAt:now});
      expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:['garmin.import'],attemptToken:token})).toMatchObject({ok:true,attemptToken:token});
      return {id,token};
    };
    const env=(attempt:{id:string,token:string},conv?:string)=>({...process.env,BRAIN_EXTENSION_HOME:realpathSync(join(fixture.home,'extensions/garmin')),BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:attempt.id,BRAIN_ATTEMPT_TOKEN:attempt.token,BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',values:{'garmin.capture_manifest':manifest,...(conv?{'garmin.legacy_conversation_id':conv}:{})}})});
    const run=(attempt:{id:string,token:string},conv?:string)=>spawnSync(python,[entry],{encoding:'utf8',env:env(attempt,conv),timeout:20000});
    await fixture.db.query("create function garmin.test_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(0.8); return new; end $$; create trigger test_delay before insert on garmin.preserved_rows for each row execute function garmin.test_delay(); create trigger test_delay_mapping before insert on garmin.import_mapping for each row execute function garmin.test_delay(); create trigger test_delay_checkpoint before update on garmin.import_checkpoints for each row execute function garmin.test_delay()");
    const timeoutAttempt=await claim(), started=Date.now();
    timeoutChild=spawn(python,[entry],{env:env(timeoutAttempt),stdio:['ignore','pipe','pipe']});
    let timeoutOutput=''; timeoutChild.stdout!.on('data',chunk=>{timeoutOutput+=String(chunk);});
    const timeoutExit=new Promise<number|null>((resolve,reject)=>{timeoutChild.once('exit',resolve);timeoutChild.once('error',reject);});
    let backend: number | undefined;
    await expect.poll(async()=>{
      const rows=await fixture.db.rows("select pid from pg_stat_activity where usename='brain_ext_garmin' and wait_event='PgSleep'");
      if (rows.length) backend=Number(rows[0]!.pid);
      return backend;
    },{timeout:10000,interval:25}).toBeDefined();
    expect(await timeoutExit).not.toBe(0); timeoutChild=undefined;
    expect(Date.now()-started).toBeGreaterThanOrEqual(2000);
    expect(Date.now()-started).toBeLessThan(3800);
    expect(timeoutOutput).toContain('"retryable": true');
    expect(await fixture.db.rows(`select pid from pg_stat_activity where pid=${backend}`)).toEqual([]);
    expect(await fixture.db.rows('select count(*)::int as n from garmin.preserved_rows')).toEqual([{n:0}]);
    expect(await fixture.db.rows('select count(*)::int as n from garmin.import_mapping')).toEqual([{n:0}]);
    expect(await fixture.db.rows('select original_table,original_key from garmin.import_checkpoints')).toEqual([{original_table:null,original_key:null}]);
    await fixture.db.query("drop trigger test_delay_mapping on garmin.import_mapping; drop trigger test_delay_checkpoint on garmin.import_checkpoints; create or replace function garmin.test_delay() returns trigger language plpgsql as $$ begin perform pg_sleep(0.02); return new; end $$");
    const killed=await claim(); child=spawn(python,[entry],{env:env(killed)});
    await expect.poll(async()=>Number((await fixture.db.rows("select count(*)::int as n from garmin.preserved_rows where dataset='synthetic-D2' and original_table='meta'"))[0]?.n),{timeout:15000}).toBeGreaterThan(2);
    const exited=new Promise<{code:number|null,signal:NodeJS.Signals|null}>(resolve=>child!.once('exit',(code,signal)=>resolve({code,signal})));
    child.kill('SIGKILL'); expect(await exited).toMatchObject({signal:'SIGKILL'}); child=undefined;
    const partial=Number((await fixture.db.rows("select count(*)::int as n from garmin.preserved_rows where dataset='synthetic-D2' and original_table='meta'"))[0]?.n);
    expect(partial).toBeLessThan(82);
    await fixture.db.query('drop trigger test_delay on garmin.preserved_rows; drop function garmin.test_delay()');
    const concurrent=(attempt:{id:string,token:string})=>new Promise<number|null>((resolve,reject)=>{const p=spawn(python,[entry],{env:env(attempt)});p.once('error',reject);p.once('exit',resolve);});
    const resumedA=await claim(), resumedB=await claim();
    expect(await Promise.all([concurrent(resumedA),concurrent(resumedB)])).toEqual([0,0]);
    expect(Number((await fixture.db.rows("select count(*)::int as n from garmin.preserved_rows where dataset='synthetic-D2' and original_table='meta'"))[0]?.n)).toBe(82);
    for (const [attempt, outcome] of [[timeoutAttempt,'failed'],[killed,'failed'],[resumedA,'succeeded'],[resumedB,'succeeded']] as const) {
      expect(await store.finishSupervisedWork({id:attempt.id,attemptToken:attempt.token,now:new Date(),outcome})).toMatchObject({ok:true});
    }
    await store.setSetting({key:'garmin.capture_manifest',value:manifest,updatedAt:new Date()});
    const {runDaemon}=await import('../src/daemon/run.js'); const {systemClock}=await import('../src/runtime/clock.js');
    const controller=new AbortController();
    const daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    try {
      const verified=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(verified.code,verified.stdout+verified.stderr).toBe(0);
      expect(verified.body.data.report.counts).toMatchObject({outbound_requests:0,outbound_results:0,mismatches:0});
      expect(await fixture.db.rows('select count(*)::int as n from brain.channel_requests')).toEqual([{n:0}]);
      expect(await fixture.db.rows('select count(*)::int as n from brain.channel_attempt_results')).toEqual([{n:0}]);
    } finally {controller.abort(); await daemon;}
    const before=await fixture.db.rows('select dataset,original_table,original_key,id,values_json,run_id from garmin.preserved_rows order by dataset,original_table,original_key');
    const a=await claim(), b=await claim();
    expect(await Promise.all([concurrent(a),concurrent(b)])).toEqual([0,0]);
    expect(await fixture.db.rows('select dataset,original_table,original_key,id,values_json,run_id from garmin.preserved_rows order by dataset,original_table,original_key')).toEqual(before);
    const stale=run({id:a.id,token:ids.next()}); expect(stale.status).not.toBe(0);
    await fixture.db.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('other','1',now(),true,now())");
    await fixture.db.query("insert into brain.extension_work_kinds(extension_name,kind) values ('other','other.import')");
    const otherId=ids.next(), otherToken=ids.next(), otherNow=new Date();
    await store.addWork({id:otherId,kind:'other.import',targetKind:'import',targetId:'x',createdAt:otherNow,nextAttemptAt:otherNow});
    await store.claimSupervisedWork({now:otherNow,claimedBy:'test',kinds:['other.import'],attemptToken:otherToken});
    expect(run({id:otherId,token:otherToken}).status).not.toBe(0);
    const walDb=join(fixture.home,'D2.db'), mainBefore=await readFile(walDb);
    walProcess=spawn(python,['-u','-c',`import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute("update meta set value='wal-change' where key='extra000'"); c.commit(); print('ready',flush=True); sys.stdin.read()`,walDb],{stdio:['pipe','pipe','pipe']});
    await new Promise<void>((resolve,reject)=>{walProcess!.stdout!.once('data',()=>resolve());walProcess!.once('error',reject);walProcess!.once('exit',()=>reject(new Error('WAL writer exited')));});
    expect(await readFile(walDb)).toEqual(mainBefore);
    const walBefore=await readFile(walDb+'-wal');
    expect(execFileSync(python,['-c',`import sqlite3,sys; print(sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True).execute("select value from meta where key='extra000'").fetchone()[0])`,walDb],{encoding:'utf8'}).trim()).toBe('wal-change');
    const walFailure=run(await claim()); expect(walFailure.stdout).toContain('IMPORT_CONFLICT');
    expect(await readFile(walDb)).toEqual(mainBefore); expect(await readFile(walDb+'-wal')).toEqual(walBefore);
    expect((await fixture.db.rows("select reason from garmin.import_conflicts where reason='wal_present'")).length).toBeGreaterThan(0);
    const walExit=new Promise<void>(resolve=>walProcess!.once('exit',()=>resolve())); walProcess.kill('SIGKILL'); await walExit; walProcess=undefined;
    await rm(walDb+'-wal',{force:true}); await rm(walDb+'-shm',{force:true}); await writeFile(walDb,mainBefore);
    const changedConversation=run(await claim(),ids.next()); expect(changedConversation.stdout).toContain('IMPORT_CONFLICT');
    await fixture.db.query('update garmin.import_checkpoints set importer_version=999');
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    await fixture.db.query('update garmin.import_checkpoints set importer_version=1');
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    await fixture.db.query('update garmin.import_checkpoints set importer_version=2');
    await fixture.db.query("update brain.health_catalog_v1 set definition=definition || '{\"synthetic_revision\":true}'::jsonb where metric='daily_metric.steps'");
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    await fixture.db.query("update brain.health_catalog_v1 set definition=definition - 'synthetic_revision' where metric='daily_metric.steps'");
    expect(run(await claim()).status).toBe(0);
    const text=await readFile(manifest,'utf8'), value=JSON.parse(text); value.files[0].source='다른 합성 이름'; await writeFile(manifest,JSON.stringify(value));
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT'); await writeFile(manifest,text);
    const db=join(fixture.home,'D2.db'), original=await readFile(db);
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version=9'); c.commit()",db]);
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT'); await writeFile(db,original);
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update meta set value='changed' where key='extra000'\"); c.commit()",db]);
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    value.capture_id='new-capture'; await writeFile(manifest,JSON.stringify(value));
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    await writeFile(db,original);
    execFileSync(python,['-c',`import sqlite3,sys,json; c=sqlite3.connect(sys.argv[1]); c.execute('update raw_response set raw=?',(json.dumps({'userProfileId':999}),)); c.commit()`,db]);
    value.capture_id='account-change'; await writeFile(manifest,JSON.stringify(value));
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    expect((await fixture.db.rows("select reason from garmin.import_conflicts where reason='account_mismatch'")).length).toBeGreaterThan(0);
    await writeFile(db,original);
    const swapped=JSON.parse(text); swapped.capture_id='authority-change';
    [swapped.datasets[0].source,swapped.datasets[1].source]=[swapped.datasets[1].source,swapped.datasets[0].source];
    await writeFile(manifest,JSON.stringify(swapped));
    expect(run(await claim()).stdout).toContain('IMPORT_CONFLICT');
    expect((await fixture.db.rows("select reason from garmin.import_conflicts where reason='authority_mismatch'")).length).toBeGreaterThan(0);
    expect(Number((await fixture.db.rows('select count(*)::int as n from garmin.import_conflicts'))[0]?.n)).toBeGreaterThanOrEqual(8);
    expect(await fixture.db.rows('select dataset,original_table,original_key,id,values_json,run_id from garmin.preserved_rows order by dataset,original_table,original_key')).toEqual(before);
  } finally {
    if (timeoutChild && timeoutChild.exitCode === null && timeoutChild.signalCode === null) {
      const exit = new Promise<void>(resolve => timeoutChild!.once('exit', () => resolve())); timeoutChild.kill('SIGKILL'); await exit;
    }
    if (walProcess && walProcess.exitCode === null && walProcess.signalCode === null) {
      const exit = new Promise<void>(resolve => walProcess!.once('exit', () => resolve())); walProcess.kill('SIGKILL'); await exit;
    }
    if (child && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(resolve => child!.once('exit', () => resolve()));
      child.kill('SIGKILL'); await exit;
    }
    await store.close(); await fixture.cleanup();
  }
});

it.each([['UTF-16le','00d8','ANg='],['UTF-16be','d800','2AA=']])('NUL 계정과 원문·legacy·건강 TEXT를 %s에서 복원하고 검증한다', async (encoding, badHex, badBase64) => {
  const { realpath } = await import('node:fs/promises');
  const { postgresStore } = await import('second_brain/postgres');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const { extensionDatabaseUrl } = await import('../src/config/codec.js');
  const fixture = await extHome(), store = postgresStore({databaseUrl:fixture.db.appUrl});
  try {
    expect((await fixture.run(['ext','install','garmin','--json'])).code).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python');
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    const code=`import sys,pathlib,sqlite3,json
sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest
p=pathlib.Path(sys.argv[2]); items=five_candidates(p,rich=True,encoding='${encoding}')
with sqlite3.connect(p/'D1.db') as db:
 db.execute('pragma ignore_check_constraints=on')
 db.execute('update raw_response set raw=?',(json.dumps({'userProfileId':'a\\u0000b'}),))
 db.execute('update notification set event=?,detail=?',('e\\u0000x','d\\u0000x'))
 db.execute('update daily_metric set hrv_status=?',('h\\u0000x',))
 db.execute('update daily_metric set sleep_score=?',(json.dumps({'a\\u0000b':{'a�b':'v\\u0000x',chr(0xd800):chr(0xdfff),'pair':'😀'},'a�b':2}),))
 db.execute('update daily_metric set sleep_s=?',(json.dumps({'escaped':chr(92)+'u0000','nested':{'n':[1,0]}}),))
 db.execute("update daily_metric set stress_avg=cast(x'${badHex}' as text)")
 db.execute("update daily_metric set readiness_level=cast(x'${badHex}' as text)")
 db.execute("update delivery set reason=cast(x'${badHex}' as text)")
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-01','hrv_data',json.dumps({'userProfileId':'a\\u0000b'}),1700000000123,1700000000456,'test'))
 db.execute('insert into normalize_result values (?,?,?,?,?,?,?)',('day','2026-01-01','hrv_data',1,None,1700000000123,1700000000999))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-01','training_readiness',json.dumps({'userProfileId':'a\\u0000b'}),1700000000123,1700000000456,'test'))
 db.execute('insert into normalize_result values (?,?,?,?,?,?,?)',('day','2026-01-01','training_readiness',1,None,1700000000123,1700000000999))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-01','sleep_data',json.dumps({'userProfileId':'a\\u0000b'}),1700000000123,1700000000456,'test'))
 db.execute('insert into normalize_result values (?,?,?,?,?,?,?)',('day','2026-01-01','sleep_data',1,None,1700000000123,1700000000999))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-01','stress_data',json.dumps({'userProfileId':'a\\u0000b'}),1700000000123,1700000000456,'test'))
 db.execute('insert into normalize_result values (?,?,?,?,?,?,?)',('day','2026-01-01','stress_data',1,None,1700000000123,1700000000999))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('scope/a','b/c','extra','body\\u0000end',1,1,'test'))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('scope','a/b/c','extra','body�end',1,1,'test'))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('scope','escape','extra',r'body\\u0000end',1,1,'test'))
 db.execute('insert into raw_response values (?,?,?,?,?,?,?)',('scope','empty','extra','',1,1,'test'))
 db.execute("insert into raw_response values ('invalid','key','extra',cast(x'${badHex}' as text),1,1,'test')")
manifest,_=capture_manifest(p,items)
data=json.loads(manifest.read_text()); data['datasets'][0]['dataset']='synthetic\\u0000D1'; manifest.write_text(json.dumps(data))`;
    execFileSync(python,['-c',code,fixtures,fixture.home]);
    const ids=uuidV7IdGen(), channel=ids.next(), conversation=ids.next(), id=ids.next(), token=ids.next(), now=new Date();
    await fixture.db.query("update brain.health_catalog_v1 set definition=jsonb_set(jsonb_set(definition,'{type}',to_jsonb('json'::text)),'{unit}',to_jsonb('json'::text)) where metric in ('daily_metric.sleep_score','daily_metric.sleep_s','daily_metric.stress_avg')");
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot')`);
    await fixture.db.query(`insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.addWork({id,kind:'garmin.import',targetKind:'import',targetId:id,createdAt:now,nextAttemptAt:now});
    await store.claimSupervisedWork({now,claimedBy:'test',kinds:['garmin.import'],attemptToken:token});
    const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl);
    const manifest=await realpath(join(fixture.home,'manifest.json'));
    const runImport = () => execFileSync(python,[join(fixture.home,'extensions/garmin/src/import.py')],{encoding:'utf8',env:{...process.env,BRAIN_EXTENSION_HOME:realpathSync(join(fixture.home,'extensions/garmin')),BRAIN_DATABASE_URL:url,BRAIN_WORK_ID:id,BRAIN_ATTEMPT_TOKEN:token,BRAIN_SETTINGS_SNAPSHOT:JSON.stringify({version:1,extension:'garmin',values:{'garmin.capture_manifest':manifest,'garmin.legacy_conversation_id':conversation}})}});
    runImport(); runImport();
    const raw=await store.imports.readRaw({source:'garmin',rawViews:['raw_records','raw_records_v2']});
    expect(raw.ok && raw.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',account:'a\0b',scope:'scope/a',originalKey:'b/c',body:'body\0end'}));
    expect(raw.ok && raw.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',scope:'scope',originalKey:'a/b/c',body:'body�end'}));
    expect(raw.ok && raw.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',scope:'scope',originalKey:'escape',body:'body\\u0000end'}));
    expect(raw.ok && raw.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',scope:'scope',originalKey:'empty',body:''}));
    expect(raw.ok && raw.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',scope:'invalid',body:{type:'invalid-text',encoding:encoding.toLowerCase(),base64:badBase64}}));
    const key=(await fixture.db.rows("select original_key from brain.channel_legacy_notifications where dataset like '~dataset1:%'"))[0]!.original_key as string;
    const legacy=await store.readChannelLegacy({type:'notification',dataset:'synthetic\0D1',originalTable:'notification',originalKey:key});
    expect(legacy).toMatchObject({ok:true,record:{event:'e\0x',detail:'d\0x'}});
    const deliveryKey=(await fixture.db.rows("select original_key from brain.channel_legacy_deliveries where dataset like '~dataset1:%'"))[0]!.original_key as string;
    expect(await store.readChannelLegacy({type:'delivery',dataset:'synthetic\0D1',originalTable:'delivery',originalKey:deliveryKey})).toMatchObject({ok:true,record:{reason:{type:'invalid-text',encoding:encoding.toLowerCase(),base64:badBase64}}});
    const health=await store.imports.readHealth();
    expect(health.ok && health.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',account:'a\0b',metric:'daily_metric.hrv_status',value_text:'h\0x'}));
    expect(health.ok && health.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',metric:'daily_metric.readiness_level',value_text:{type:'invalid-text',encoding:encoding.toLowerCase(),base64:badBase64}}));
    expect(health.ok && health.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',metric:'daily_metric.sleep_score',value_json:{'a\0b':{'a�b':'v\0x','\ud800':'\udfff',pair:'😀'},'a�b':2}}));
    expect(health.ok && health.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',metric:'daily_metric.sleep_s',value_json:{escaped:'\\u0000',nested:{n:[1,0]}}}));
    expect(health.ok && health.rows).toContainEqual(expect.objectContaining({dataset:'synthetic\0D1',metric:'daily_metric.stress_avg',value_json:{type:'invalid-text',encoding:encoding.toLowerCase(),base64:badBase64}}));
    if (health.ok) expect(health.rows.every(row=>Object.keys(row).every(key=>!key.endsWith('_raw') && !key.endsWith('_encoding')))).toBe(true);
    const preflightCode = "import sys,json,pathlib; sys.path.insert(0,sys.argv[1]); from preflight import analyze,public_report; p=pathlib.Path(sys.argv[2]); report=analyze({r:p/(r+'.db') for r in ('D1','D2','D3','D4','D5')}); print(json.dumps(public_report(report,{'checks':{},'previous_batches':[]})))";
    const publicReport = execFileSync(python,['-c',preflightCode,join(fixture.home,'extensions/garmin/src'),fixture.home],{encoding:'utf8'});
    expect(publicReport).not.toContain('body\\u0000end'); expect(publicReport).not.toContain('synthetic'); expect(publicReport).not.toContain('2026-01-01'); expect(publicReport).not.toContain(badBase64);
    expect(await store.finishSupervisedWork({id,attemptToken:token,now:new Date(),outcome:'succeeded'})).toMatchObject({ok:true});
    await store.setSetting({key:'garmin.capture_manifest',value:manifest,updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    const {runDaemon}=await import('../src/daemon/run.js'); const {systemClock}=await import('../src/runtime/clock.js');
    const controller=new AbortController();
    const daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    try {
      await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:20000}).toBe(0);
      const verified=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(verified.code,verified.stdout+verified.stderr).toBe(0);
      for (const secret of ['body\\u0000end','synthetic','2026-01-01',badBase64]) expect(verified.stdout+verified.stderr).not.toContain(secret);
      await fixture.db.query("create table public.json_backup as select * from brain.health_observations where dataset like '~dataset1:%' and metric='daily_metric.sleep_s'");
      for (const [index, replacement] of [[0,'true'],[1,'false']] as const) {
        await fixture.db.query(`alter table brain.health_observations disable trigger user; update brain.health_observations set value_json=jsonb_set(value_json,'{nested,n,${index}}','${replacement}'::jsonb) where id=(select id from public.json_backup); alter table brain.health_observations enable trigger user`);
        try {
          const before=await fixture.db.rows('select value_json,value_json_raw from brain.health_observations where id=(select id from public.json_backup)');
          const changed=await fixture.run(['ext','run','garmin','import-verify','--json']);
          expect(changed.code,changed.stdout+changed.stderr).not.toBe(0); expect(changed.body.data.report.checks.health).toBe(false);
          expect(await fixture.db.rows('select value_json,value_json_raw from brain.health_observations where id=(select id from public.json_backup)')).toEqual(before);
          for (const secret of ['synthetic','2026-01-01',badBase64]) expect(changed.stdout+changed.stderr).not.toContain(secret);
        } finally {await fixture.db.query('alter table brain.health_observations disable trigger user; update brain.health_observations h set value_json=b.value_json from public.json_backup b where h.id=b.id; alter table brain.health_observations enable trigger user');}
      }
      await fixture.db.query("alter table brain.health_observations disable trigger user; update brain.health_observations set value_json=jsonb_set(value_json,'{nested,n,0}','1.0'::jsonb) where id=(select id from public.json_backup); alter table brain.health_observations enable trigger user");
      try {const equal=await fixture.run(['ext','run','garmin','import-verify','--json']); expect(equal.code,equal.stdout+equal.stderr).toBe(0);}
      finally {await fixture.db.query('alter table brain.health_observations disable trigger user; update brain.health_observations h set value_json=b.value_json from public.json_backup b where h.id=b.id; alter table brain.health_observations enable trigger user');}

    } finally {controller.abort(); await daemon;}

  } finally { await store.close(); await fixture.cleanup(); }
});
