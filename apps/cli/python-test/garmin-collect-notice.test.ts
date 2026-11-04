import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';

it('수집 사건은 날짜별 한 번만 채널에 인계하고 외부로 직접 연결하지 않는다', async () => {
  const { postgresStore } = await import('second_brain/postgres');
  const { runDaemon } = await import('../src/daemon/run.js');
  const { systemClock } = await import('../src/runtime/clock.js');
  const { uuidV7IdGen } = await import('../src/runtime/id-gen.js');
  const fixture = await extHome(), ids = uuidV7IdGen(), controller = new AbortController();
  const store = postgresStore({databaseUrl:fixture.db.appUrl});
  const home=await realpath(fixture.home), ext=join(home,'extensions/garmin');
  const requests:string[]=[];
  const server=createServer((req,res)=>{ let body=''; req.on('data',chunk=>body+=chunk); req.on('end',()=>{ if (req.method==='POST' && /^\/bot[^/]+\/sendMessage$/.test(req.url ?? '')) requests.push(body); res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,result:{message_id:1}})); }); });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if (!address || typeof address==='string') throw Error('server');
  let daemon:ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    await copyFile(fileURLToPath(new URL('../../../extensions/garmin/tests/collect_fixture.py',import.meta.url)),join(ext,'collect_fixture.py'));
    const manifestPath=join(ext,'manifest.json'), manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    for (const w of manifest.work) if (w.kind.startsWith('garmin.collect')) w.entry='collect_fixture.py';
    await writeFile(manifestPath,JSON.stringify(manifest));
    const marker={home,database:new URL(fixture.db.url).pathname.slice(1),host:new URL(fixture.db.url).hostname,port:new URL(fixture.db.url).port,response:{totalSteps:1234,totalDistanceMeters:null,activeKilocalories:null,moderateIntensityMinutes:null,vigorousIntensityMinutes:null,minHeartRate:null,maxHeartRate:null},fail_endpoint:'sleep_data',fail_code:'RATE_LIMITED',notice_kill:'',write_block:false,guard_status:0,all_no_data:false,invalid_sleep_days:[] as string[]};
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    const tokenDir=join(home,'tokens'); await mkdir(tokenDir); await writeFile(join(tokenDir,'garmin_tokens.json'),'synthetic-token-canary');
    const channel=ids.next(), conversation=ids.next();
    await store.ensureChannel({id:channel,kind:'telegram',botRef:'test-bot'});
    await store.ensureChannelConversation({id:conversation,channelId:channel,externalRef:'test-chat',threadRef:'12'});
    for (const [key,value] of [['garmin.timezone','UTC'],['garmin.tokenstore',tokenDir]]) await store.setSetting({key,value,updatedAt:new Date()});
    daemon=runDaemon({home,env:{...fixture.env,BRAIN_TELEGRAM_BOT_TOKEN:'test-token',BRAIN_TELEGRAM_CHAT_ID:'test-chat'},clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,channelTestEndpoint:`http://127.0.0.1:${address.port}`}});
    const queue=async(day:string, account='notice-test', expected='RATE_LIMITED')=>{ const id=ids.next(), now=new Date(); await store.addWork({id,kind:'garmin.collect',targetKind:'account',targetId:account,createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)}); await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='UTC',next_attempt_at=now() where id='${id}'`); await expect.poll(async()=>(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${id}'`))[0]?.error_code,{timeout:20000}).toBe(expected); return id; };
    // 설정이 없으면 gate를 소비하지 않으며 수집 결과는 동일하다.
    await queue('2026-02-02','no-conversation');
    expect((await fixture.db.rows("select count(*)::int n from garmin.collect_notices where account='no-conversation'"))[0]?.n).toBe(0);
    expect((await fixture.db.rows('select count(*)::int n from brain.channel_requests'))[0]?.n).toBe(0);
    await store.setSetting({key:'garmin.notice_conversation_id',value:conversation,updatedAt:new Date()});
    marker.write_block=true; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    await queue('2026-01-31'); await queue('2026-01-31','notice-test','SESSION_BLOCKED'); await queue('2026-02-01');
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(2);
    await expect.poll(async()=>await fixture.db.rows('select status from brain.channel_requests order by created_at'),{timeout:20000}).toEqual([{status:'sent'},{status:'sent'}]);
    expect((await fixture.db.rows('select count(*)::int n from garmin.collect_notices'))[0]?.n).toBe(2);
    expect(JSON.stringify(requests)).not.toContain('synthetic-token-canary');
    expect(JSON.stringify(await fixture.db.rows('select detail from garmin.collect_notices'))).not.toContain('synthetic-token-canary');

    marker.write_block=false; marker.fail_endpoint=''; marker.all_no_data=true; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    const successDataset='collect-'+createHash('sha256').update(JSON.stringify(['success-account'])).digest('hex');
    await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('${successDataset}','success-account',true), ('legacy-notice-fixture','success-account',true);
      insert into garmin.normalize_items(dataset,scope,key,endpoint,revision,normalization_version,fetched_at_ms,ok,error_code,normalized_at_ms) values ('${successDataset}','day','2000-01-01','sleep_data','old',1,1,false,'old',1);
      insert into garmin.preserved_rows(id,dataset,original_table,original_key,values_json) values (gen_random_uuid(),'legacy-notice-fixture','run','old','{"local_date":{"type":"text","value":"2000-01-01"},"status":{"type":"text","value":"running"},"started_at":{"type":"integer","value":1}}')`);
    const successId=ids.next(), successNow=new Date();
    await store.addWork({id:successId,kind:'garmin.collect',targetKind:'account',targetId:'success-account',createdAt:successNow,nextAttemptAt:new Date(Date.now()+3600000)});
    await fixture.db.query(`update brain.work_items set local_date_from='2026-02-03',local_date_to='2026-02-03',local_time_zone='UTC',next_attempt_at=now() where id='${successId}'`);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${successId}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='success-account'")).toEqual([]);
    // 실제 두 항목의 정규화 실패를 한 endpoint 토큰으로 묶는다.
    marker.invalid_sleep_days=['2026-02-08','2026-02-07'];
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    const normalizeId=ids.next(), normalizeNow=new Date();
    await store.addWork({id:normalizeId,kind:'garmin.collect',targetKind:'account',targetId:'normalize-account',createdAt:normalizeNow,nextAttemptAt:new Date(Date.now()+3600000)});
    await fixture.db.query(`update brain.work_items set local_date_from='2026-02-08',local_date_to='2026-02-08',local_time_zone='UTC',next_attempt_at=now() where id='${normalizeId}'`);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${normalizeId}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='normalize-account'")).toEqual([{event:'normalize_failed',detail:'sleep_data=2'}]);
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(3);
    marker.invalid_sleep_days=[];
    marker.fail_endpoint='sleep_data'; marker.all_no_data=false; marker.write_block=true;
    // 알림 실패는 재시도 가능한 고정 코드로 표시하고 실행 행을 보존한다.
    const nonexistent=ids.next();
    expect(await store.setSetting({key:'garmin.notice_conversation_id',value:nonexistent,updatedAt:new Date()})).toMatchObject({ok:true});
    expect((await fixture.db.rows("select value from brain.settings where key='garmin.notice_conversation_id'"))[0]?.value).not.toBe(conversation);
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    const failedNotice=await queue('2026-02-04','notice-failure','COLLECT_NOTICE_FAILED');
    const failedToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${failedNotice}'`))[0]!.token;
    expect(await readFile(join(home,`collect-conversation-${failedToken}`),'utf8')).toBe(nonexistent);
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='notice-failure'")).toEqual([]);
    expect((await fixture.db.rows(`select status from garmin.collect_runs where work_id='${failedNotice}'`))[0]?.status).toBe('rate_limited');
    expect(JSON.parse(await readFile(join(home,`collect-error-${failedToken}`),'utf8')).retryable).toBe(true);
    await store.setSetting({key:'garmin.notice_conversation_id',value:conversation,updatedAt:new Date()});
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${failedNotice}'`);
    await expect.poll(async()=>(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${failedNotice}' order by started_at desc limit 1`))[0]?.error_code,{timeout:20000}).toBe('SESSION_BLOCKED');
    await expect.poll(async()=>(await fixture.db.rows("select count(*)::int n from garmin.collect_notices where account='notice-failure' and event='rate_limited'"))[0]?.n,{timeout:20000}).toBe(1);
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(4);
    for (const [stage,day] of [['insert','2026-02-05'],['commit','2026-02-06']] as const) {
      const account=`kill-${stage}`, before=requests.length, id=ids.next(), now=new Date();
      marker.notice_kill=stage; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
      await store.addWork({id,kind:'garmin.collect',targetKind:'account',targetId:account,createdAt:now,nextAttemptAt:new Date(Date.now()+3600000)});
      await fixture.db.query(`update brain.work_items set local_date_from='${day}',local_date_to='${day}',local_time_zone='UTC',next_attempt_at=now() where id='${id}'`);
      await expect.poll(async()=>Boolean((await fixture.db.rows(`select outcome from brain.work_attempts where work_item_id='${id}' order by started_at desc limit 1`))[0]?.outcome),{timeout:20000}).toBe(true);
      expect((await fixture.db.rows(`select count(*)::int n from garmin.collect_notices where account='${account}'`))[0]?.n).toBe(stage==='insert'?0:1);
      expect(JSON.parse(await readFile(join(tokenDir,'block.json'),'utf8'))).toMatchObject({local_date:day,reason:'rate_limited'});
      marker.notice_kill=''; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
      await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${id}'`);
      await expect.poll(async()=>(await fixture.db.rows(`select error_code from brain.work_attempts where work_item_id='${id}' order by started_at desc limit 1`))[0]?.error_code,{timeout:20000}).toBe('SESSION_BLOCKED');
      await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+1);
      expect((await fixture.db.rows(`select count(*)::int n from garmin.collect_notices where account='${account}'`))[0]?.n).toBe(1);
      await expect.poll(async()=>(await fixture.db.rows(`select count(*)::int n from brain.channel_requests r join garmin.collect_notices n on n.id::text=r.producer_result_id where n.account='${account}' and r.status='sent'`))[0]?.n,{timeout:20000}).toBe(1);
      expect((await fixture.db.rows(`select count(*)::int n from brain.work_items w join brain.channel_requests r on r.work_item_id=w.id join garmin.collect_notices n on n.id::text=r.producer_result_id where n.account='${account}' and w.kind='channel_send'`))[0]?.n).toBe(1);
    }

    // 403과 인증 실패도 사건을 발행하고 차단 재진입은 중복 발행하지 않는다.
    marker.fail_code='BLOCKED_403'; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    let before=requests.length;
    await queue('2026-03-01','blocked-account','BLOCKED_403');
    await queue('2026-03-01','blocked-account','SESSION_BLOCKED');
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+1);
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='blocked-account'")).toEqual([{event:'blocked_403',detail:'blocked_403'}]);
    marker.fail_code='LOGIN_REQUIRED'; marker.guard_status=401; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    before=requests.length;
    await queue('2026-03-02','auth-account','LOGIN_REQUIRED');
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+1);
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='auth-account'")).toEqual([{event:'auth_failed',detail:'login_required'}]);
    // 이전 native running 행의 만료 attempt는 원래 날짜의 abandoned 사건이다.
    const abandonedDataset='collect-'+createHash('sha256').update(JSON.stringify(['abandoned-account'])).digest('hex');
    await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('${abandonedDataset}','abandoned-account',true);
      insert into garmin.collect_runs(dataset,run_id,work_id,attempt_token,local_date,started_at,status,detail) values ('${abandonedDataset}','${ids.next()}','${failedNotice}','${failedToken}','2026-01-01',1,'running','')`);
    marker.guard_status=0; marker.fail_endpoint=''; marker.all_no_data=true; marker.write_block=false; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    before=requests.length;
    const abandonedId=ids.next(), abandonedNow=new Date();
    await store.addWork({id:abandonedId,kind:'garmin.collect',targetKind:'account',targetId:'abandoned-account',createdAt:abandonedNow,nextAttemptAt:new Date(Date.now()+3600000)});
    await fixture.db.query(`update brain.work_items set local_date_from='2026-03-03',local_date_to='2026-03-03',local_time_zone='UTC',next_attempt_at=now() where id='${abandonedId}'`);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${abandonedId}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+1);
    expect(await fixture.db.rows("select local_date::text,event,detail from garmin.collect_notices where account='abandoned-account'")).toEqual([{local_date:'2026-01-01',event:'error',detail:'abandoned'}]);

    // 이틀 연속 transient 부분 수집은 오늘 detail로 한 번만 알린다.
    marker.fail_endpoint='sleep_data'; marker.fail_code='GARMIN_TRANSIENT'; marker.all_no_data=true;
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    before=requests.length;
    await queue('2026-04-01','repeat-partial','COLLECT_PARTIAL');
    const partialToday=await queue('2026-04-02','repeat-partial','COLLECT_PARTIAL');
    const detail=(await fixture.db.rows(`select detail from garmin.collect_runs where work_id='${partialToday}'`))[0]!.detail;
    expect(String(detail)).toMatch(/transient=[1-9]/);
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='repeat-partial'")).toEqual([{event:'repeated_partial',detail}]);
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+1);
    await queue('2026-04-02','repeat-partial','COLLECT_PARTIAL');
    expect((await fixture.db.rows("select count(*)::int n from brain.channel_requests r join garmin.collect_notices n on n.id::text=r.producer_result_id where n.account='repeat-partial'"))[0]?.n).toBe(1);
    expect(requests).toHaveLength(before+1);
    // 인증 사건 삽입 실패 뒤 같은 일감이 noop이어도 원래 사건을 인계한다.
    marker.guard_status=401; marker.fail_endpoint=''; marker.all_no_data=false;
    await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    await store.setSetting({key:'garmin.notice_conversation_id',value:ids.next(),updatedAt:new Date()});
    const authRetry=await queue('2026-04-03','auth-retry','COLLECT_NOTICE_FAILED');
    expect(await fixture.db.rows("select event from garmin.collect_notices where account='auth-retry'")).toEqual([]);
    await store.setSetting({key:'garmin.notice_conversation_id',value:conversation,updatedAt:new Date()});
    marker.guard_status=0; await writeFile(join(home,'.garmin-collect-fixture.json'),JSON.stringify(marker));
    before=requests.length;
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${authRetry}'`);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${authRetry}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    const retryToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${authRetry}' order by started_at desc limit 1`))[0]!.token;
    const retryResult=JSON.parse(await readFile(join(home,`collect-result-${retryToken}`),'utf8'));
    expect(JSON.parse(retryResult.summary).status).toBe('noop');
    expect(await fixture.db.rows("select event,detail from garmin.collect_notices where account='auth-retry'")).toEqual([{event:'auth_failed',detail:'login_required'}]);
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+1);
    expect((await fixture.db.rows("select count(*)::int n from brain.channel_requests r join garmin.collect_notices n on n.id::text=r.producer_result_id where n.account='auth-retry'"))[0]?.n).toBe(1);

    // 같은 날 여러 native 종료 사건을 뒤의 success가 가리지 않는다.
    const multiAccount='multiple-pending', multiDay='2026-04-04';
    const multiDataset='collect-'+createHash('sha256').update(JSON.stringify([multiAccount])).digest('hex');
    await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('${multiDataset}','${multiAccount}',true);
      insert into garmin.collect_runs(dataset,run_id,work_id,attempt_token,local_date,started_at,finished_at,status,detail) values
      ('${multiDataset}','${ids.next()}','${failedNotice}','${failedToken}','${multiDay}',1,2,'error','error'),
      ('${multiDataset}','${ids.next()}','${failedNotice}','${failedToken}','${multiDay}',3,4,'auth_failed','login_required'),
      ('${multiDataset}','${ids.next()}','${failedNotice}','${failedToken}','${multiDay}',5,6,'success','')`);
    expect((await fixture.db.rows(`select count(*)::int n from garmin.collect_notices where account='${multiAccount}'`))[0]?.n).toBe(0);
    before=requests.length;
    const multiId=ids.next(), multiNow=new Date();
    await store.addWork({id:multiId,kind:'garmin.collect',targetKind:'account',targetId:multiAccount,createdAt:multiNow,nextAttemptAt:new Date(Date.now()+3600000)});
    await fixture.db.query(`update brain.work_items set local_date_from='${multiDay}',local_date_to='${multiDay}',local_time_zone='UTC',next_attempt_at=now() where id='${multiId}'`);
    await expect.poll(async()=>(await fixture.db.rows(`select outcome from brain.work_items where id='${multiId}'`))[0]?.outcome,{timeout:20000}).toBe('succeeded');
    const multiToken=(await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${multiId}'`))[0]!.token;
    const multiResult=JSON.parse(await readFile(join(home,`collect-result-${multiToken}`),'utf8'));
    expect(JSON.parse(multiResult.summary).status).toBe('noop');
    expect(await fixture.db.rows(`select local_date::text,event,detail from garmin.collect_notices where account='${multiAccount}' order by event`)).toEqual([
      {local_date:multiDay,event:'auth_failed',detail:'login_required'}, {local_date:multiDay,event:'error',detail:'error'}]);
    await expect.poll(async()=>requests.length,{timeout:20000}).toBe(before+2);
    expect(requests.slice(before).map(body=>JSON.parse(body).text).sort()).toEqual([expect.stringContaining(`${multiDay} auth_failed`),expect.stringContaining(`${multiDay} error`)]);
    await expect.poll(async()=>await fixture.db.rows(`select n.event,count(r.id)::int n from garmin.collect_notices n join brain.channel_requests r on r.producer_result_id=n.id::text where n.account='${multiAccount}' and r.status='sent' group by n.event order by n.event`),{timeout:20000}).toEqual([{event:'auth_failed',n:1},{event:'error',n:1}]);
    expect((await fixture.db.rows(`select count(*)::int n from brain.channel_requests r join garmin.collect_notices n on n.id::text=r.producer_result_id where n.account='${multiAccount}'`))[0]?.n).toBe(2);

    const addresses=await readFile(join(home,'collect-addresses'),'utf8').catch(()=>'');
    expect(addresses).not.toContain(String(address.port));
    for (const line of addresses.split('\n').filter(Boolean)) expect(JSON.parse(line)).toMatch(/127\.0\.0\.1|::1/);
    expect(JSON.stringify(requests)).not.toContain('synthetic-token-canary');
    expect(JSON.stringify(await fixture.db.rows('select body from brain.channel_requests'))).not.toContain('synthetic-token-canary');
    expect(JSON.stringify(await fixture.db.rows('select detail from garmin.collect_notices'))).not.toContain('synthetic-token-canary');
  } finally { controller.abort(); await daemon; await store.close(); server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve())); await fixture.cleanup(); }
});
