import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, chmod, copyFile, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { postgresStore } from 'second_brain/postgres';
import { extHome } from '../test/ext-fixture.js';
import { pidAlive, killGroup } from '../test/supervisor-fixture.js';
import { extensionDatabaseUrl } from '../src/config/codec.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

const source=fileURLToPath(new URL('../../../extensions/garmin/tests/supervised_fake_network.py',import.meta.url));
const self='01940000-0000-7000-8000-00000000000a';
type Request={work:string;target:string;kind:string;endpoint:string|null;key:string|null};
async function requests(path:string):Promise<Request[]> {
  const text=await readFile(path,'utf8').catch(()=> '');
  return text.trim() ? text.trim().split('\n').map(line=>JSON.parse(line) as Request) : [];
}

it('installed supervised collect cancels its process tree, resumes missing raw, rejects stale and preserves memory', async()=>{
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  const store=postgresStore({databaseUrl:fixture.db.appUrl}); let daemon:ReturnType<typeof runDaemon>|undefined;
  let pids:{leader:number;child:number}|undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']);
    expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const home=await realpath(fixture.home), extension=join(home,'extensions/garmin'), src=join(extension,'src');
    const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
    expect(manifest.work).toContainEqual(expect.objectContaining({kind:'garmin.collect',entry:'src/collect.py',execution:'supervised',manual:'collect',missed:'latest'}));
    expect(manifest.work).toContainEqual(expect.objectContaining({kind:'garmin.report',missed:'latest'}));
    expect(manifest.default_schedules).toEqual(expect.arrayContaining([
      expect.objectContaining({key:'collect',kind:'garmin.collect',cron:'0 11 * * *',time_zone:'Asia/Seoul',target_setting:'garmin.connection_id'}),
      expect.objectContaining({key:'report',kind:'garmin.report',cron:'30 11 * * *',time_zone:'Asia/Seoul',target_setting:'garmin.connection_id',after_schedule:'collect'}),
    ]));
    await copyFile(source,join(src,'supervised_fake_network.py'));
    await appendFile(join(src,'collect_runtime.py'),'\nimport supervised_fake_network\n');
    const tokenstore=join(extension,'tokenstore'); await mkdir(tokenstore,{recursive:true,mode:0o700}); await chmod(tokenstore,0o700);
    const token=Buffer.from('synthetic-token-only'); const account=ids.next(), other=ids.next();
    await writeFile(join(tokenstore,'garmin_tokens.json'),token,{mode:0o600});
    await writeFile(join(tokenstore,'brain-account-binding.json'),JSON.stringify({version:1,user_id:self,connection_id:account,external_identity:'12345',token_sha256:createHash('sha256').update(token).digest('hex')}),{mode:0o600});
    await store.setSetting({userId:self,key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
    const sid=ids.next(),mid=ids.next(),fid=ids.next();
    await fixture.db.query(`insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values ('${self}','${account}','12345','UTC'),('${self}','${other}','67890','UTC');
      insert into garmin.meta(user_id,connection_id,key,value) values ('${self}','${account}','history_start','2026-01-01'),('${self}','${other}','history_start','2026-01-01');
      insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${sid}','synthetic','collect-memory','${self}','fixture',now(),'import');
      insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${mid}','${sid}','collect-memory','user','synthetic memory',now());
      insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${fid}','sha256:${'b'.repeat(64)}',0,now())`);
    const memory=await fixture.db.rows(`select s.id,m.body,f.content_hash from brain.sessions s join brain.messages m on m.session_id=s.id cross join brain.files f where s.id='${sid}' and f.id='${fid}'`);
    const ledger=join(extension,'synthetic-requests.jsonl'); await writeFile(join(extension,'synthetic-hold'),'hold');
    await writeFile(join(extension,'synthetic-refresh'),'refresh');
    daemon=runDaemon({home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,cancelPollMs:25,cancelGraceMs:200}});
    const enqueue=async(target:string)=>{
      const result=await fixture.run(['ext','run','garmin','collect','--target',target,'--json']);
      expect(result.code,result.stdout+result.stderr).toBe(0); return String(result.body.data.work_id);
    };
    const first=await enqueue(account);
    await expect.poll(async()=>readFile(join(extension,'synthetic-pids.json'),'utf8').then(text=>JSON.parse(text) as {leader:number;child:number}).catch(()=>null),{timeout:30000}).not.toBeNull();
    pids=JSON.parse(await readFile(join(extension,'synthetic-pids.json'),'utf8')) as {leader:number;child:number};
    const firstRows=await requests(ledger); expect(firstRows.filter(row=>row.kind==='data').map(row=>row.endpoint)).toEqual(['sleep_data','hrv_data']);
    const before=await fixture.db.rows(`select scope,key,endpoint,raw from garmin.raw_current where user_id='${self}' and connection_id='${account}'`);
    expect(before).toHaveLength(1); expect(before[0]?.endpoint).toBe('sleep_data');
    const attempts=await fixture.db.rows(`select token from brain.work_attempts where work_item_id='${first}'`); const oldToken=String(attempts[0]?.token);
    expect(await enqueue(account)).toBe(first); // same account open work coalesces
    const foreign=await enqueue(other);
    await expect.poll(async()=> (await fixture.db.rows(`select count(*)::int n from brain.work_attempts where work_item_id='${foreign}'`))[0]?.n,{timeout:15000}).toBeGreaterThan(0);
    const lockBusy=async(id:string)=> (await fixture.db.rows(`select not pg_try_advisory_xact_lock(hashtextextended('garmin:write:${self}:${id}',0)) as busy`))[0]?.busy;
    await expect.poll(()=>lockBusy(other),{timeout:15000}).toBe(true);
    expect(await lockBusy(account)).toBe(true); // distinct account writers are both active
    expect((await requests(ledger)).filter(row=>row.target===other)).toEqual([]);
    const cancel=await fixture.run(['queue','cancel',first,'--json']); expect(cancel.code,cancel.stdout+cancel.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome,{timeout:30000}).toBe('cancelled');
    await expect.poll(()=>[pidAlive(pids!.leader),pidAlive(pids!.child)],{timeout:15000}).toEqual([false,false]);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${foreign}'`))[0]?.outcome,{timeout:30000}).toBe('failed');
    expect((await requests(ledger)).filter(row=>row.target===other)).toEqual([]);
    await unlink(join(extension,'synthetic-hold'));
    const resumed=await enqueue(account);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${resumed}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    expect(await readFile(join(tokenstore,'garmin_tokens.json'),'utf8')).toBe('synthetic-refreshed-token');
    const evidence=JSON.parse(await readFile(join(tokenstore,'brain-account-binding.json'),'utf8'));
    expect(evidence.token_sha256).toBe(createHash('sha256').update('synthetic-refreshed-token').digest('hex'));
    const after=await requests(ledger); expect(after.filter(row=>row.work===resumed && row.kind==='data').map(row=>row.endpoint)).not.toContain('sleep_data');
    expect(await fixture.db.rows(`select scope,key,endpoint,raw from garmin.raw_current where user_id='${self}' and connection_id='${account}' and endpoint='sleep_data'`)).toEqual(before);
    expect(await fixture.db.rows(`select s.id,m.body,f.content_hash from brain.sessions s join brain.messages m on m.session_id=s.id cross join brain.files f where s.id='${sid}' and f.id='${fid}'`)).toEqual(memory);
    const extDsn=await extensionDatabaseUrl(home,'garmin',fixture.db.appUrl), python=join(extension,'.venv/bin/python');
    const snapshot=JSON.stringify({version:1,extension:'garmin',user_id:self,values:{'garmin.timezone':'UTC','garmin.tokenstore':tokenstore}});
    const rawBeforeStale=await fixture.db.rows(`select count(*)::int n from garmin.raw_observations where user_id='${self}' and connection_id='${account}'`);
    const stale=spawnSync(python,[join(src,'collect.py')],{encoding:'utf8',env:{...fixture.env,BRAIN_ABI_VERSION:'1',BRAIN_DATABASE_URL:extDsn,BRAIN_USER_ID:self,BRAIN_WORK_ID:first,BRAIN_ATTEMPT_TOKEN:oldToken,BRAIN_WORK_KIND:'garmin.collect',BRAIN_TARGET_KIND:'extension',BRAIN_TARGET_ID:account,BRAIN_RUN_GENERATION:'1',BRAIN_SETTINGS_SNAPSHOT:snapshot,BRAIN_EXTENSION_HOME:extension}});
    expect(stale.status).not.toBe(0); expect(JSON.parse(stale.stdout)).toMatchObject({abi:1,type:'error',code:'COLLECT_UNAVAILABLE'});
    expect(await requests(ledger)).toEqual(after);
    expect(await fixture.db.rows(`select count(*)::int n from garmin.raw_observations where user_id='${self}' and connection_id='${account}'`)).toEqual(rawBeforeStale);
    await writeFile(join(tokenstore,'block.json'), JSON.stringify({schema_version:1,local_date:'2026-01-01',reason:'rate_limited'}), {mode:0o600});
    const blocked=await enqueue(account);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${blocked}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    expect(await requests(ledger)).toEqual(after);
    const statuses=await fixture.db.rows(`select status from garmin.run where user_id='${self}' and connection_id='${account}' order by id desc limit 1`);
    expect(statuses).toEqual([{status:'skipped_blocked'}]);
  } finally {
    controller.abort(); if(daemon) await daemon;
    if(pids && pidAlive(pids.leader)) killGroup(pids.leader);
    await store.close(); await fixture.cleanup();
  }
},180000);

const repo=fileURLToPath(new URL('../../../',import.meta.url));
const richSource=join(repo,'extensions/garmin/tests/supervised_rich_network.py');
const day='2026-10-15';
type OracleTable={columns:string[];keys:string[];rows:Record<string,unknown>[]};
type Oracle={requests:string[][];raw:unknown[][];runs:unknown[][];tables:Record<string,OracleTable>};

async function installRich(fixture:Awaited<ReturnType<typeof extHome>>) {
  const result=await fixture.run(['ext','install','garmin','--json']);
  expect(result.code,result.stdout+result.stderr).toBe(0);
  const home=await realpath(fixture.home), extension=join(home,'extensions/garmin'), src=join(extension,'src');
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  expect(manifest.work).toContainEqual(expect.objectContaining({kind:'garmin.collect',entry:'src/collect.py',execution:'supervised'}));
  await mkdir(join(extension,'tests'),{recursive:true});
  await mkdir(join(extension,'fixtures/legacy/normalize_v8'),{recursive:true});
  for(const name of ['collect_oracle_support.py','collect_lifestyle_pinned.json'])
    await copyFile(join(repo,'extensions/garmin/tests',name),join(extension,'tests',name));
  await copyFile(join(repo,'extensions/garmin/fixtures/legacy/normalize_v8/input.json'),join(extension,'fixtures/legacy/normalize_v8/input.json'));
  await copyFile(richSource,join(src,'supervised_rich_network.py'));
  await appendFile(join(src,'collect_runtime.py'),'\nimport supervised_rich_network\n');
  const settings=postgresStore({databaseUrl:fixture.db.appUrl});
  try { await settings.setSetting({userId:self,key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()}); }
  finally { await settings.close(); }
  return {home,extension,src,python:join(extension,'.venv/bin/python'),ledger:join(extension,'rich-requests.jsonl')};
}

async function richAccount(fixture:Awaited<ReturnType<typeof extHome>>,extension:string,id:string,tokenstore:string) {
  await mkdir(tokenstore,{recursive:true,mode:0o700}); await chmod(tokenstore,0o700);
  const token=Buffer.from('synthetic-token-'+id), profile='synthetic-profile-'+id;
  await writeFile(join(tokenstore,'garmin_tokens.json'),token,{mode:0o600});
  await writeFile(join(tokenstore,'brain-account-binding.json'),JSON.stringify({version:1,user_id:self,connection_id:id,external_identity:profile,token_sha256:createHash('sha256').update(token).digest('hex')}),{mode:0o600});
  await fixture.db.query(`insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values ('${self}','${id}','${profile}','Asia/Seoul');
    insert into garmin.meta(user_id,connection_id,key,value) values ('${self}','${id}','history_start','${day}'),('${self}','${id}','normalize_version','8')`);
}

function compareKey(row:Record<string,unknown>,keys:string[]) { return JSON.stringify(keys.map(key=>row[key])); }
function lexical(a:string,b:string) { return a<b ? -1 : a>b ? 1 : 0; }

it('installed manifest and supervisor collect rich fixture equal pinned SQLite tables and request sequence',async()=>{
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const app=await installRich(fixture), account=ids.next();
    await richAccount(fixture,app.extension,account,join(app.extension,'tokenstore'));
    const oracle=spawnSync(app.python,[join(repo,'extensions/garmin/tests/collect_supervisor_oracle_child.py')],{encoding:'utf8',timeout:60000,cwd:app.home,env:{...fixture.env,HOME:app.home,PYTHONPATH:[join(repo,'extensions/garmin/tests/oracle/src'),join(repo,'extensions/garmin/tests')].join(':'),PYTHONDONTWRITEBYTECODE:'1'}});
    expect(oracle.status,oracle.stderr).toBe(0);
    const expected=JSON.parse(oracle.stdout) as Oracle;
    daemon=runDaemon({home:app.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,cancelPollMs:25,cancelGraceMs:200}});
    const result=await fixture.run(['ext','run','garmin','collect','--target',account,'--json']);
    expect(result.code,result.stdout+result.stderr).toBe(0);
    const work=String(result.body.data.work_id);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:60000}).toBe('succeeded');
    const actualRequests=(await requests(app.ledger)).filter(row=>row.work===work && row.kind==='data').map(row=>[row.endpoint==='activity_exercise_sets' || !/^\d{4}-\d{2}-\d{2}$/.test(row.key ?? '') ? 'activity':'day',row.key,row.endpoint]);
    expect(actualRequests).toEqual(expected.requests);
    const where=`user_id='${self}' and connection_id='${account}'`;
    const raw=await fixture.db.rows(`select scope,key,endpoint,raw,fetched_at,checked_at,library_version from garmin.raw_current where ${where} order by scope collate "C",key collate "C",endpoint collate "C"`);
    expect(raw.map(row=>[row.scope,row.key,row.endpoint,row.raw,Number(row.fetched_at),Number(row.checked_at),row.library_version])).toEqual(expected.raw);
    const runs=await fixture.db.rows(`select local_date,started_at,finished_at,status,detail from garmin.run where ${where} order by id`);
    expect(runs.map(row=>[row.local_date,Number(row.started_at),Number(row.finished_at),row.status,row.detail])).toEqual(expected.runs);
    for(const [table,definition] of Object.entries(expected.tables)) {
      expect(/^[a-z_]+$/.test(table)).toBe(true);
      for(const column of definition.columns) expect(/^[a-z_]+$/.test(column)).toBe(true);
      const fields=definition.columns.map(column=>`"${column}"`).join(',');
      const rows=await fixture.db.rows(`select row_to_json(t) as value from (select ${fields} from garmin."${table}" where ${where}) t`);
      const actual=rows.map(row=>row.value as Record<string,unknown>).sort((a,b)=>lexical(compareKey(a,definition.keys),compareKey(b,definition.keys)));
      expect(actual,table).toEqual(definition.rows);
    }
    expect(expected.tables.daily_metric?.rows.length).toBeGreaterThan(0);
    expect(expected.tables.workout?.rows.length).toBeGreaterThan(0);
    expect(await fixture.db.rows(`select result_summary from brain.work_attempts where work_item_id='${work}'`)).toEqual([{result_summary:{status:'success',runs:1,errors:0}}]);
    const again=await fixture.run(['ext','run','garmin','collect','--target',account,'--json']);
    expect(again.code,again.stdout+again.stderr).toBe(0); const noop=String(again.body.data.work_id);
    expect(noop).not.toBe(work);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${noop}'`))[0]?.outcome,{timeout:60000}).toBe('succeeded');
    expect(await fixture.db.rows(`select result_summary,previous_result from brain.work_attempts where work_item_id='${noop}'`)).toEqual([{result_summary:{status:'noop',runs:0,errors:0},previous_result:null}]);
  } finally { controller.abort(); if(daemon) await daemon; await fixture.cleanup(); }
},180000);

it('installed entry rejects MFA and expired login before data and refuses blocked or invalid credentials before login',async()=>{
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  try {
    const app=await installRich(fixture), tokenstore=join(app.extension,'tokenstore');
    daemon=runDaemon({home:app.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,cancelPollMs:25,cancelGraceMs:200}});
    for(const mode of ['mfa','expired','blocked','invalid'] as const) {
      const account=ids.next(); await richAccount(fixture,app.extension,account,tokenstore);
      if(mode==='mfa' || mode==='expired') await writeFile(join(app.extension,'auth-'+account),mode==='mfa'?'MFA required':'HTTP 401');
      if(mode==='blocked') await writeFile(join(tokenstore,'block.json'),JSON.stringify({schema_version:1,local_date:day,reason:'rate_limited'}),{mode:0o600});
      if(mode==='invalid') await writeFile(join(tokenstore,'garmin_tokens.json'),'synthetic-replaced',{mode:0o600});
      const result=await fixture.run(['ext','run','garmin','collect','--target',account,'--json']);
      expect(result.code,result.stdout+result.stderr).toBe(0); const work=String(result.body.data.work_id);
      const wanted=mode==='invalid'?'failed':'succeeded';
      await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:60000}).toBe(wanted);
      const ledger=(await requests(app.ledger)).filter(row=>row.work===work);
      expect(ledger.filter(row=>row.kind==='data')).toEqual([]);
      expect(ledger.filter(row=>row.kind==='login')).toHaveLength(mode==='mfa' || mode==='expired'?1:0);
      const rows=await fixture.db.rows(`select status from garmin.run where user_id='${self}' and connection_id='${account}' order by id desc limit 1`);
      if(mode==='mfa' || mode==='expired') expect(rows).toEqual([{status:'auth_failed'}]);
      if(mode==='mfa' || mode==='expired') expect(await fixture.db.rows(`select result_summary from brain.work_attempts where work_item_id='${work}'`)).toEqual([{result_summary:{status:'auth_required',runs:1,errors:0}}]);
      if(mode==='blocked') expect(rows).toEqual([{status:'skipped_blocked'}]);
      if(mode==='blocked') await unlink(join(tokenstore,'block.json'));
    }
  } finally { controller.abort(); if(daemon) await daemon; await fixture.cleanup(); }
},240000);

it('separate work and driver wait on the same connection while a different connection progresses',async()=>{
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  let daemon:ReturnType<typeof runDaemon>|undefined;
  const children:ChildProcess[]=[];
  try {
    const app=await installRich(fixture), account=ids.next(), other=ids.next();
    const tokenstore=join(app.extension,'tokenstore'), otherTokens=join(app.extension,'other-tokenstore');
    await richAccount(fixture,app.extension,account,tokenstore);
    await richAccount(fixture,app.extension,other,otherTokens);
    await writeFile(join(app.extension,'hold-'+account),'hold');
    daemon=runDaemon({home:app.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,cancelPollMs:25,cancelGraceMs:200}});
    const firstResult=await fixture.run(['ext','run','garmin','collect','--target',account,'--json']);
    expect(firstResult.code,firstResult.stdout+firstResult.stderr).toBe(0); const first=String(firstResult.body.data.work_id);
    await expect.poll(()=>readFile(join(app.extension,'waiting-'+first),'utf8').then(()=>true).catch(()=>false),{timeout:30000}).toBe(true);
    await writeFile(join(app.extension,'fail-'+first),'fail');
    const extDsn=await extensionDatabaseUrl(app.home,'garmin',fixture.db.appUrl);
    async function direct(target:string,tokens:string,label:string) {
      const work=ids.next(),attempt=ids.next();
      // A different registered Garmin kind bypasses the queue's open-work uniqueness;
      // the real collect entry still receives its normal collect ABI envelope.
      await fixture.db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,claimed_at,claim_expires_at,claimed_by) values ('${work}','garmin.import','extension','${target}',now(),now(),'supervised',now(),now()+interval '1 hour','synthetic');
        insert into brain.work_attempts(token,work_item_id,started_at) values ('${attempt}','${work}',now());
        update brain.work_items set current_attempt_token='${attempt}' where id='${work}'`);
      const snapshot=JSON.stringify({version:1,extension:'garmin',user_id:self,values:{'garmin.timezone':'Asia/Seoul','garmin.tokenstore':tokens}});
      const child=spawn(app.python,[join(app.src,'collect.py')],{stdio:['ignore','pipe','pipe'],env:{...fixture.env,PGAPPNAME:label,BRAIN_ABI_VERSION:'1',BRAIN_DATABASE_URL:extDsn,BRAIN_USER_ID:self,BRAIN_WORK_ID:work,BRAIN_ATTEMPT_TOKEN:attempt,BRAIN_WORK_KIND:'garmin.collect',BRAIN_TARGET_KIND:'extension',BRAIN_TARGET_ID:target,BRAIN_RUN_GENERATION:'1',BRAIN_SETTINGS_SNAPSHOT:snapshot,BRAIN_EXTENSION_HOME:app.extension}});
      children.push(child); let stdout='',stderr='';
      child.stdout!.setEncoding('utf8').on('data',chunk=>{stdout+=chunk;});
      child.stderr!.setEncoding('utf8').on('data',chunk=>{stderr+=chunk;});
      const done=new Promise<{code:number|null;stdout:string;stderr:string}>((resolve,reject)=>{
        const timeout=setTimeout(()=>{ child.kill('SIGKILL'); reject(new Error('synthetic entry timed out')); },90000);
        child.once('error',error=>{ clearTimeout(timeout); reject(error); });
        child.once('close',code=>{ clearTimeout(timeout); resolve({code,stdout,stderr}); });
      });
      return {work,child,done};
    }
    const waiting=await direct(account,tokenstore,'r7d-contender');
    await expect.poll(async()=> (await fixture.db.rows("select count(*)::int n from pg_stat_activity where application_name='r7d-contender'"))[0]?.n,{timeout:15000}).toBe(1);
    const before=await fixture.db.rows(`select count(*)::int n from garmin.raw_observations where user_id='${self}' and connection_id='${account}'`);
    const otherRun=await direct(other,otherTokens,'r7d-independent');
    const otherDone=await otherRun.done;
    expect(otherDone.code,otherDone.stderr).toBe(0);
    expect(JSON.parse(otherDone.stdout)).toMatchObject({abi:1,type:'result'});
    expect((await requests(app.ledger)).filter(row=>row.work===otherRun.work && row.kind==='data').length).toBeGreaterThan(0);
    expect(waiting.child.exitCode).toBeNull();
    expect((await requests(app.ledger)).filter(row=>row.work===waiting.work)).toEqual([]);
    expect(await fixture.db.rows(`select count(*)::int n from garmin.raw_observations where user_id='${self}' and connection_id='${account}'`)).toEqual(before);
    await unlink(join(app.extension,'hold-'+account));
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${first}'`))[0]?.outcome,{timeout:60000}).toBe('succeeded');
    expect(await fixture.db.rows(`select result_summary,previous_result from brain.work_attempts where work_item_id='${first}'`)).toEqual([{result_summary:{status:'partial',runs:1,errors:1},previous_result:null}]);
    const done=await waiting.done;
    expect(done.code,done.stderr).toBe(0);
    expect(JSON.parse(done.stdout)).toMatchObject({abi:1,type:'result'});
    expect((await requests(app.ledger)).filter(row=>row.work===waiting.work && row.kind==='data').length).toBeGreaterThan(0);
  } finally {
    controller.abort();
    for(const child of children) if(child.exitCode===null) child.kill('SIGKILL');
    if(daemon) await daemon;
    await fixture.cleanup();
  }
},240000);
