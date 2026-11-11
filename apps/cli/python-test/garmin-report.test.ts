import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { copyFile, chmod, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { postgresStore } from 'second_brain/postgres';
import { extHome } from '../test/ext-fixture.js';
import { killGroup, pidAlive } from '../test/supervisor-fixture.js';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';
import { openReportTransactions } from './garmin-report-observer.js';

const root=fileURLToPath(new URL('../../../extensions/garmin/tests/report-fixture/',import.meta.url));
const self='01940000-0000-7000-8000-00000000000a';
type Call={scope:string; target:string; work:string; attempt:string; pid:number; pgid:number; argv:string[]; cwd:string; skill:string; observed:Record<string,unknown>};

async function setup(startDaemon=true) {
  const fixture=await extHome(), ids=uuidV7IdGen(), controller=new AbortController();
  const server=createServer((req,res)=>{req.resume(); req.on('end',()=>{const method=req.url?.split('/').at(-1); res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,result:method==='sendMediaGroup'?[{message_id:1},{message_id:2}]:{message_id:1}}));});});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address(); if(!address || typeof address==='string') throw Error('missing fake channel address');
  const channelTestEndpoint=`http://127.0.0.1:${address.port}`;
  const store=postgresStore({databaseUrl:fixture.db.appUrl});
  const installed=await fixture.run(['ext','install','garmin','--json']);
  expect(installed.code,installed.stdout+installed.stderr).toBe(0);
  const home=await realpath(fixture.home), extension=join(home,'extensions/garmin');
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
  expect(manifest.work).toContainEqual(expect.objectContaining({kind:'garmin.report',entry:'src/report.py',execution:'supervised'}));
  expect(manifest.work).toContainEqual(expect.objectContaining({kind:'garmin.report_regenerate',entry:'src/report.py',execution:'supervised'}));
  const bin=join(home,'fake-bin'), control=join(extension,'report-fixture');
  await mkdir(bin,{recursive:true}); await mkdir(control,{recursive:true});
  await copyFile(join(root,'codex'),join(bin,'codex')); await chmod(join(bin,'codex'),0o700);
  await store.setSetting({userId:null,key:'agent.codex_path',value:join(bin,'codex'),updatedAt:new Date()});
  await store.setSetting({userId:self,key:'garmin.timezone',value:'UTC',updatedAt:new Date()});
  await store.setSetting({userId:self,key:'garmin.analysis_model',value:'synthetic',updatedAt:new Date()});
  await store.setSetting({userId:self,key:'garmin.analysis_reasoning_effort',value:'medium',updatedAt:new Date()});
  const channel=ids.next(), conversation=ids.next();
  await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','synthetic'); insert into brain.channel_conversations(id,channel_id,external_ref,user_id) values ('${conversation}','${channel}','synthetic-chat','${self}'); insert into brain.channel_routes(topic,conversation_id) values ('garmin.report','${conversation}')`);
  const account=ids.next(), other=ids.next();
  await fixture.db.query(`insert into garmin.account_connections(user_id,connection_id,external_identity,timezone) values ('${self}','${account}','fixture-a','UTC'),('${self}','${other}','fixture-b','UTC')`);
  for (const target of [account,other]) {
    const runtime=join(extension,'reports/accounts',self,target); await mkdir(runtime,{recursive:true});
    await writeFile(join(runtime,'profile.md'),`profile-${target}`);
  }
  const env={...fixture.env,HOME:home,PATH:'/usr/bin:/bin',BRAIN_TELEGRAM_BOT_TOKEN:'synthetic-token',BRAIN_TELEGRAM_CHAT_ID:'synthetic-chat'};
  const daemon=startDaemon ? runDaemon({home,env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,cancelPollMs:25,cancelGraceMs:200,channelTestEndpoint}}) : undefined;
  const calls=async():Promise<Call[]> => (await readFile(join(control,'calls.jsonl'),'utf8').catch(()=>'')) .split('\n').filter(Boolean).map(line=>JSON.parse(line) as Call);
  const enqueue=async(target=account,regenerate=false)=>{
    const result=await fixture.run(['ext','run','garmin',regenerate?'report-regenerate':'report','--target',target,'--json']);
    expect(result.code,result.stdout+result.stderr).toBe(0); return String(result.body.data.work_id);
  };
  const outcome=async(work:string,wanted:string)=>expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${work}'`))[0]?.outcome,{timeout:90000}).toBe(wanted);
  const revisions=(target=account)=>fixture.db.rows(`select scope,revision,report_md from garmin.evaluation_revisions where user_id='${self}' and connection_id='${target}' order by scope,revision`);
  const waitCall=async(work:string,scope:string,options:{attempt?:string; except?:string; timeout?:number}={}):Promise<Call>=>{
    let found:Call|undefined;
    await expect.poll(async()=>{found=(await calls()).find(c=>c.work===work && c.scope===scope && (!options.attempt || c.attempt===options.attempt) && (!options.except || c.attempt!==options.except)); return !!found;},{timeout:options.timeout ?? 45000}).toBe(true);
    return found!;
  };
  const failedAttempt=async(work:string,attempt?:string,expected='failed')=>{
    let row:Record<string,unknown>|undefined;
    await expect.poll(async()=>{row=(await fixture.db.rows(`select token,outcome,finished_at,error_retryable from brain.work_attempts where work_item_id='${work}' ${attempt ? `and token='${attempt}'` : ''} order by started_at desc limit 1`))[0]; return row?.outcome;},{timeout:90000}).toBe(expected);
    expect(row?.finished_at).toBeTruthy();
    if(expected==='failed') expect(row?.error_retryable).toBe(true);
    const item=(await fixture.db.rows(`select outcome,completed_at,current_attempt_token from brain.work_items where id='${work}'`))[0];
    expect(item).toMatchObject({outcome:null,completed_at:null,current_attempt_token:null});
    return String(row!.token);
  };
  const retryNow=async(work:string)=>{
    await fixture.db.query(`update brain.work_items set next_attempt_at=now() where id='${work}' and completed_at is null and current_attempt_token is null`);
  };
  const photo=async(target=account)=>{
    const dir=join(extension,'reports/accounts',self,target,'inbox/inbody'); await mkdir(dir,{recursive:true});
    const file=join(dir,'synthetic.png'); await writeFile(file,Buffer.from((await readFile(join(root,'synthetic-photo.png.base64'),'utf8')).trim(),'base64')); return file;
  };
  return {fixture,ids,controller,store,home,env,extension,control,account,other,calls,enqueue,outcome,revisions,waitCall,failedAttempt,retryNow,photo,channelTestEndpoint,
    async close(){controller.abort(); if(daemon) await daemon; await store.close(); await new Promise<void>(resolve=>server.close(()=>resolve())); await fixture.cleanup();}};
}

it('resumes 30d/all after 7d commit, skips complete day even with pending photo, regenerates and preserves memory',async()=>{
  const t=await setup();
  try {
    const sid=t.ids.next(),mid=t.ids.next(),fid=t.ids.next();
    await t.fixture.db.query(`insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('${sid}','synthetic','report-memory','${self}','fixture',now(),'import'); insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ('${mid}','${sid}','report-memory','user','synthetic memory',now()); insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('${fid}','sha256:${'c'.repeat(64)}',0,now())`);
    const memory=()=>t.fixture.db.rows(`select s.id,m.body,f.content_hash from brain.sessions s join brain.messages m on m.session_id=s.id cross join brain.files f where s.id='${sid}' and f.id='${fid}'`);
    const before=await memory(); await writeFile(join(t.control,'hold-30d'),'hold');
    const first=await t.enqueue(); const firstCall=await t.waitCall(first,'30d');
    expect((await t.revisions()).map(row=>row.scope).sort()).toEqual(['7d','day']);
    const processRow=(await t.fixture.db.rows(`select pgid from brain.work_attempts where work_item_id='${first}'`))[0];
    killGroup(Number(processRow?.pgid)); await t.failedAttempt(first,firstCall.attempt,'died');
    await unlink(join(t.control,'hold-30d')); await t.retryNow(first);
    const resumed=await t.waitCall(first,'30d',{except:firstCall.attempt}); await t.outcome(first,'succeeded');
    expect((await t.calls()).filter(c=>c.work===first && c.attempt===resumed.attempt).map(c=>c.scope)).toEqual(['30d','all']);
    const originals=await t.revisions(); expect(originals).toHaveLength(4);
    const image=await t.photo(); const skip=await t.enqueue(); await t.outcome(skip,'succeeded');
    expect((await t.calls()).filter(c=>c.work===skip)).toEqual([]); expect(await readFile(image)).toBeDefined();
    await copyFile(image,join(t.extension,'reports/accounts',self,t.account,'inbox/inbody/another.png'));
    const regen=await t.enqueue(t.account,true); await t.outcome(regen,'succeeded');
    const regenCalls=(await t.calls()).filter(c=>c.work===regen);
    expect(regenCalls.map(c=>c.scope)).toEqual(['intake','day','7d','30d','all']);
    const intake=regenCalls[0]!;
    expect(intake.observed.pending).toEqual(['inbox/inbody/another.png','inbox/inbody/synthetic.png']);
    expect(intake.argv.slice(intake.argv.indexOf('-i'))).toEqual(['-i','inbox/inbody/another.png','inbox/inbody/synthetic.png']);
    expect(intake.argv.find(arg=>arg.startsWith('$garmin-body-intake'))).toContain('1. inbox/inbody/another.png\n2. inbox/inbody/synthetic.png');
    for (const call of regenCalls) {
      expect(call.argv.slice(call.argv.indexOf('-m'),call.argv.indexOf('-m')+2)).toEqual(['-m','synthetic']);
      expect(call.argv).toContain('model_reasoning_effort=medium');
    }
    const after=await t.revisions(); expect(after).toHaveLength(8);
    for(const row of originals) expect(after).toContainEqual(row);
    expect(await t.fixture.db.rows(`select scope,count(*)::int n from garmin.evaluation where user_id='${self}' and connection_id='${t.account}' group by scope`)).toHaveLength(4);
    expect(await memory()).toEqual(before);
  } finally {await t.close();}
},240000);

it('isolates accounts and leaves no open extension transaction while the model waits',async()=>{
  const t=await setup();
  try {
    await writeFile(join(t.control,`hold-${t.account}-day`),'hold'); await writeFile(join(t.control,`hold-${t.other}-day`),'hold');
    const a=await t.enqueue(t.account), b=await t.enqueue(t.other); await Promise.all([t.waitCall(a,'day'),t.waitCall(b,'day')]);
    expect(await openReportTransactions(sql=>t.fixture.db.rows(sql),'brain_ext_garmin')).toBe(0);
    await unlink(join(t.control,`hold-${t.other}-day`)); await t.outcome(b,'succeeded');
    expect(await t.revisions(t.account)).toEqual([]); expect(await t.revisions(t.other)).toHaveLength(4);
    await unlink(join(t.control,`hold-${t.account}-day`)); await t.outcome(a,'succeeded'); expect(await t.revisions(t.account)).toHaveLength(4);
  } finally {await t.close();}
},180000);

it('observes account-specific raw, body, projection, evaluation and period profile inputs',async()=>{
  const t=await setup();
  try {
    const yesterday=new Date(Date.now()-86400000).toISOString().slice(0,10);
    for(const [target,tag,steps] of [[t.account,'alpha',1231],[t.other,'bravo',4562]] as const) {
      await t.fixture.db.query(`insert into garmin.raw_response(user_id,connection_id,scope,key,endpoint,raw,fetched_at,checked_at,library_version) values ('${self}','${target}','day','${yesterday}','user_summary','{"marker":"raw-${tag}","totalSteps":${steps}}',1,1,'fixture'); insert into garmin.day_summary(user_id,connection_id,date,steps) values ('${self}','${target}','${yesterday}',${steps}); insert into garmin.evaluation_revisions(user_id,connection_id,report_date,scope,summary,judgments,evidence,next_checks,report_md,model,created_at,revision) values ('${self}','${target}','${yesterday}','day','eval-${tag}','[]','[]','[]','prior-${tag}','fixture',1,1)`);
      const runtime=join(t.extension,'reports/accounts',self,target), bodyDir=join(runtime,'data/body');
      await mkdir(bodyDir,{recursive:true});
      await writeFile(join(bodyDir,`${yesterday}.json`),JSON.stringify({schema_version:1,measured_on:yesterday,values:{weight_kg:steps===1231?71:82},value_mtime_ns:{weight_kg:1},source_files:[`body-${tag}`]}));
    }
    const a=await t.enqueue(t.account), b=await t.enqueue(t.other);
    await Promise.all([t.outcome(a,'succeeded'),t.outcome(b,'succeeded')]);
    for(const [target,work,own,other,steps,weight] of [[t.account,a,'alpha','bravo',1231,71],[t.other,b,'bravo','alpha',4562,82]] as const) {
      const calls=(await t.calls()).filter(row=>row.work===work);
      expect(calls.map(row=>row.scope)).toEqual(['day','7d','30d','all']);
      for(const call of calls) {
        expect(call.cwd).toBe(join(t.extension,'reports/accounts',self,target));
        expect(call.skill).toBe(call.scope==='day'?'garmin-daily-analysis':'garmin-period-review');
        expect(JSON.stringify(call.observed)).not.toContain(`raw-${other}`);
        expect(JSON.stringify(call.observed)).not.toContain(`eval-${other}`);
        expect(JSON.stringify(call.observed)).not.toContain(`body-${other}`);
      }
      const day=JSON.stringify(calls[0]!.observed);
      expect(calls[0]!.observed.digest).toMatchObject({day:{yesterday:{steps}}});
      expect(day).toContain(`raw-${own}`); expect(day).toContain(`eval-${own}`); expect(day).toContain(`body-${own}`); expect(day).toContain(`"weight_kg":${weight}`);
      for(const call of calls.slice(1)) {
        expect(call.observed.profile).toBe(`profile-${target}`);
        expect(JSON.stringify(call.observed.day_values)).toContain(String(steps));
      }
      const revisions=await t.revisions(target);
      for(const call of calls) {
        const row=revisions.find(r=>r.scope===call.scope && String(r.report_md).includes(work));
        expect(row).toBeDefined();
        const payload=JSON.parse(String(row!.report_md));
        expect(payload).toMatchObject({scope:call.scope,work,observed:call.observed});
      }
    }
  } finally {await t.close();}
},240000);

it('failed regeneration appends successful scopes only and latest selects each maximum revision',async()=>{
  const t=await setup();
  try {
    const first=await t.enqueue(); await t.outcome(first,'succeeded');
    const before=await t.revisions(); expect(before).toHaveLength(4);
    await writeFile(join(t.control,'status-failed-7d'),'yes');
    const regen=await t.enqueue(t.account,true); const regenAttempt=await t.failedAttempt(regen);
    expect((await t.calls()).filter(row=>row.work===regen && row.attempt===regenAttempt).map(row=>row.scope)).toEqual(['day','7d','30d','all']);
    const after=await t.revisions(); expect(after).toHaveLength(7);
    for(const row of before) expect(after).toContainEqual(row);
    for(const scope of ['day','7d','30d','all']) {
      const rows=after.filter(row=>row.scope===scope);
      expect(rows).toHaveLength(scope==='7d'?1:2);
      if(scope!=='7d') {
        expect(String(rows[1]!.report_md)).toContain(regen);
        expect(rows[1]!.report_md).not.toBe(rows[0]!.report_md);
      }
    }
    const latest=await t.fixture.db.rows(`select e.scope,e.revision,e.report_md,(select count(*)::int from garmin.evaluation x where x.user_id=e.user_id and x.connection_id=e.connection_id and x.report_date=e.report_date and x.scope=e.scope) n,(select max(r.revision) from garmin.evaluation_revisions r where r.user_id=e.user_id and r.connection_id=e.connection_id and r.report_date=e.report_date and r.scope=e.scope) max_revision from garmin.evaluation e where e.user_id='${self}' and e.connection_id='${t.account}' order by e.scope`);
    expect(latest).toHaveLength(4);
    for(const row of latest) {
      expect(Number(row.n)).toBe(1); expect(String(row.revision)).toBe(String(row.max_revision));
      const expected=after.filter(value=>value.scope===row.scope).at(-1)!;
      expect(row.report_md).toBe(expected.report_md);
    }
    const links=()=>t.fixture.db.rows(`select scope,revision,request_id,file_id,kind from garmin.evaluation_files where user_id='${self}' and connection_id='${t.account}' order by scope,revision,request_id`);
    const originalLinks=await links(); expect(originalLinks.length).toBeGreaterThanOrEqual(4);
    expect(originalLinks.every(row=>row.file_id)).toBe(true);
    await unlink(join(t.control,'status-failed-7d')); await t.retryNow(regen);
    const retry=await t.waitCall(regen,'7d',{except:regenAttempt}); await t.outcome(regen,'succeeded');
    expect((await t.calls()).filter(row=>row.work===regen && row.attempt===retry.attempt).map(row=>row.scope)).toEqual(['7d']);
    const recovered=await t.revisions(); expect(recovered).toHaveLength(8);
    for(const row of after) expect(recovered).toContainEqual(row);
    const recoveredLinks=await links(); for(const row of originalLinks) expect(recoveredLinks).toContainEqual(row);
    for(const row of recovered.filter(r=>String(r.report_md).includes(regen))) expect(recoveredLinks.some(link=>link.scope===row.scope && String(link.revision)===String(row.revision) && link.file_id)).toBe(true);
  } finally {await t.close();}
},240000);

it('invalid body stays pending, completed day skips it, and explicit regeneration retries it',async()=>{
  const t=await setup();
  try {
    const image=await t.photo(); await writeFile(join(t.control,'body-mode'),'invalid');
    const failed=await t.enqueue(); const failedAttempt=await t.failedAttempt(failed);
    expect(await readFile(image)).toBeDefined(); expect(await t.revisions()).toHaveLength(4);
    const callsBefore=(await t.calls()).length; await t.retryNow(failed); await t.outcome(failed,'succeeded');
    expect((await t.calls()).length).toBe(callsBefore); expect(await readFile(image)).toBeDefined();
    expect((await t.fixture.db.rows(`select count(*)::int n from brain.work_attempts where work_item_id='${failed}' and token<>'${failedAttempt}' and outcome='succeeded'`))[0]?.n).toBe(1);
    await writeFile(join(t.control,'body-mode'),'valid'); const retry=await t.enqueue(t.account,true); await t.outcome(retry,'succeeded');
    expect((await t.calls()).filter(row=>row.work===retry)[0]?.scope).toBe('intake');
    await expect(readFile(image)).rejects.toThrow();
    const sidecar=join(t.extension,'reports/accounts',self,t.account,'data/body/2020-01-02.json');
    expect(JSON.parse(await readFile(sidecar,'utf8')).values).toEqual({weight_kg:70});
  } finally {await t.close();}
},180000);

it('finishes the previous model descendants before starting the next scope',async()=>{
  const t=await setup(); let childPid=0;
  try {
    await writeFile(join(t.control,'grandchild-day'),'yes');
    await writeFile(join(t.control,'hold-7d'),'hold');
    const work=await t.enqueue(); await t.waitCall(work,'7d');
    childPid=Number(await readFile(join(t.control,`child-${t.account}-day`),'utf8'));
    expect(pidAlive(childPid)).toBe(false);
    await unlink(join(t.control,'hold-7d')); await t.outcome(work,'succeeded');
  } finally {if(childPid && pidAlive(childPid)) process.kill(childPid,'SIGKILL'); await t.close();}
},180000);

it('revoked body request fails at host fence and leaves its input pending',async()=>{
  const t=await setup();
  try {
    const image=await t.photo(); await writeFile(join(t.control,'hold-body-write'),'hold');
    const work=await t.enqueue(); const call=await t.waitCall(work,'intake');
    await expect.poll(()=>readFile(join(t.control,`before-body-write-${t.account}`),'utf8').then(()=>true).catch(()=>false),{timeout:30000}).toBe(true);
    await t.fixture.db.query(`update brain.work_items set current_attempt_token=null where id='${work}'`);
    await unlink(join(t.control,'hold-body-write'));
    await expect.poll(()=>[pidAlive(call.pgid),pidAlive(call.pid)],{timeout:45000}).toEqual([false,false]);
    expect((await t.fixture.db.rows(`select finished_at from brain.work_attempts where token='${call.attempt}'`))[0]?.finished_at).toBeNull();
    expect(await readFile(image)).toBeDefined();
    expect(await t.revisions()).toEqual([]);
    expect((await t.calls()).filter(row=>row.work===work && row.attempt===call.attempt).map(row=>row.scope)).toEqual(['intake']);
    await expect(readFile(join(t.extension,'reports/accounts',self,t.account,'data/body/2020-01-02.json'))).rejects.toThrow();
  } finally {await t.close();}
},180000);

it('cancel while intake waits preserves pending and kills the supervised child and grandchild',async()=>{
  const t=await setup(); let childPid=0;
  try {
    const image=await t.photo(); await writeFile(join(t.control,'hold-intake'),'hold'); await writeFile(join(t.control,'grandchild-intake'),'yes');
    const work=await t.enqueue(); await t.waitCall(work,'intake');
    await expect.poll(()=>readFile(join(t.control,`child-${t.account}-intake`),'utf8').then(Number).catch(()=>0),{timeout:15000}).toBeGreaterThan(0);
    childPid=Number(await readFile(join(t.control,`child-${t.account}-intake`),'utf8'));
    const model=(await t.calls()).find(row=>row.work===work && row.scope==='intake')!;
    const cancel=await t.fixture.run(['queue','cancel',work,'--json']); expect(cancel.code,cancel.stdout+cancel.stderr).toBe(0);
    await t.outcome(work,'cancelled');
    await expect.poll(()=>[pidAlive(model.pid),pidAlive(childPid)],{timeout:15000}).toEqual([false,false]);
    expect(await readFile(image)).toBeDefined(); expect(await t.revisions()).toEqual([]);
  } finally {if(childPid && pidAlive(childPid)) process.kill(childPid,'SIGKILL'); await t.close();}
},180000);

it('revoked attempt cannot append or invoke subsequent scopes after the held model returns',async()=>{
  const t=await setup();
  try {
    await writeFile(join(t.control,'hold-day'),'hold'); const work=await t.enqueue(); const call=await t.waitCall(work,'day');
    await t.fixture.db.query(`update brain.work_items set current_attempt_token=null where id='${work}'`);
    await unlink(join(t.control,'hold-day'));
    await expect.poll(()=>[pidAlive(call.pgid),pidAlive(call.pid)],{timeout:45000}).toEqual([false,false]);
    expect((await t.fixture.db.rows(`select finished_at from brain.work_attempts where token='${call.attempt}'`))[0]?.finished_at).toBeNull();
    expect(await t.revisions()).toEqual([]);
    expect((await t.calls()).filter(row=>row.work===work).map(row=>row.scope)).toEqual(['day']);
  } finally {await t.close();}
},180000);

it('model timeout produces a failed attempt and cleans its group descendants',async()=>{
  const t=await setup(); let childPid=0;
  try {
    await t.store.setSetting({userId:self,key:'garmin.analysis_timeout_minutes',value:'1',updatedAt:new Date()});
    await writeFile(join(t.control,'hold-day'),'hold'); await writeFile(join(t.control,'grandchild-day'),'yes'); await writeFile(join(t.control,'hold-7d'),'hold');
    const work=await t.enqueue(); const day=await t.waitCall(work,'day');
    await expect.poll(()=>readFile(join(t.control,`child-${t.account}-day`),'utf8').then(Number).catch(()=>0),{timeout:15000}).toBeGreaterThan(0);
    childPid=Number(await readFile(join(t.control,`child-${t.account}-day`),'utf8'));
    await t.waitCall(work,'7d',{attempt:day.attempt,timeout:100000});
    expect(pidAlive(childPid)).toBe(false);
    await unlink(join(t.control,'hold-7d')); await t.failedAttempt(work,day.attempt);
    expect((await t.revisions()).some(row=>row.scope==='day')).toBe(false);
    await unlink(join(t.control,'hold-day')); await unlink(join(t.control,'grandchild-day')); await t.retryNow(work);
    const retry=await t.waitCall(work,'day',{except:day.attempt}); await t.outcome(work,'succeeded');
    expect((await t.calls()).filter(row=>row.work===work && row.attempt===retry.attempt).map(row=>row.scope)).toEqual(['day']);
  } finally {if(childPid && pidAlive(childPid)) process.kill(childPid,'SIGKILL'); await t.close();}
},240000);

it('daemon SIGKILL after 7d commit recovers its group then resumes only 30d and all',async()=>{
  const t=await setup(false); const daemonBin=fileURLToPath(new URL('../dist/bin.js',import.meta.url));
  const daemon=spawn(process.execPath,[daemonBin,'daemon','run'],{env:{...t.env,BRAIN_TELEGRAM_BOT_TOKEN:'',BRAIN_TELEGRAM_CHAT_ID:''},stdio:'ignore'});
  let recovery:ReturnType<typeof runDaemon>|undefined, modelPid=0, grandchild=0;
  const recoveryController=new AbortController();
  try {
    await writeFile(join(t.control,'hold-30d'),'hold'); await writeFile(join(t.control,'grandchild-30d'),'yes');
    const work=await t.enqueue(); const call=await t.waitCall(work,'30d');
    expect((await t.revisions()).map(row=>row.scope).sort()).toEqual(['7d','day']);
    const before=await t.revisions();
    modelPid=call.pid;
    await expect.poll(()=>readFile(join(t.control,`child-${t.account}-30d`),'utf8').then(Number).catch(()=>0),{timeout:15000}).toBeGreaterThan(0);
    grandchild=Number(await readFile(join(t.control,`child-${t.account}-30d`),'utf8'));
    const exited=new Promise<void>(resolve=>daemon.once('exit',()=>resolve())); daemon.kill('SIGKILL'); await exited;
    recovery=runDaemon({home:t.home,env:t.env,clock:systemClock,idGen:t.ids,signal:recoveryController.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,cancelPollMs:25,cancelGraceMs:200,channelTestEndpoint:t.channelTestEndpoint}});
    await expect.poll(()=>[pidAlive(modelPid),pidAlive(grandchild)],{timeout:45000}).toEqual([false,false]);
    await expect.poll(async()=> (await t.fixture.db.rows(`select outcome from brain.work_attempts where token='${call.attempt}'`))[0]?.outcome,{timeout:45000}).toBe('died');
    expect((await t.fixture.db.rows(`select finished_at from brain.work_attempts where token='${call.attempt}'`))[0]?.finished_at).toBeTruthy();
    expect(await t.revisions()).toEqual(before);
    const resumed=await t.waitCall(work,'30d',{except:call.attempt});
    expect((await t.calls()).filter(row=>row.work===work && row.attempt===call.attempt).map(row=>row.scope)).toEqual(['day','7d','30d']);
    await unlink(join(t.control,'hold-30d')); await unlink(join(t.control,'grandchild-30d'));
    await t.outcome(work,'succeeded');
    expect((await t.calls()).filter(row=>row.work===work && row.attempt===resumed.attempt).map(row=>row.scope)).toEqual(['30d','all']);
    const after=await t.revisions(); expect(after).toHaveLength(4);
    for(const row of before) expect(after).toContainEqual(row);
  } finally {
    recoveryController.abort(); if(recovery) await recovery;
    if(daemon.exitCode===null && daemon.signalCode===null) daemon.kill('SIGKILL');
    if(modelPid && pidAlive(modelPid)) process.kill(modelPid,'SIGKILL');
    if(grandchild && pidAlive(grandchild)) process.kill(grandchild,'SIGKILL');
    await t.close();
  }
},240000);

it('same account regenerate reports lock busy while another account proceeds',async()=>{
  const t=await setup();
  try {
    await writeFile(join(t.control,`hold-${t.account}-day`),'hold');
    const first=await t.enqueue(t.account); await t.waitCall(first,'day');
    const busy=await t.enqueue(t.account,true); const busyAttempt=await t.failedAttempt(busy);
    expect((await t.calls()).filter(row=>row.work===busy)).toEqual([]);
    const independent=await t.enqueue(t.other); await t.outcome(independent,'succeeded');
    await unlink(join(t.control,`hold-${t.account}-day`)); await t.outcome(first,'succeeded');
    expect(await t.revisions(t.account)).toHaveLength(4); expect(await t.revisions(t.other)).toHaveLength(4);
    await t.retryNow(busy); const retry=await t.waitCall(busy,'day',{except:busyAttempt}); await t.outcome(busy,'succeeded');
    expect((await t.calls()).filter(row=>row.work===busy && row.attempt===retry.attempt).map(row=>row.scope)).toEqual(['day','7d','30d','all']);
  } finally {await t.close();}
},180000);

it.each(['fail','invalid','status-failed'])('model %s on 7d keeps later successes and retries only missing scope',async(mode)=>{
  const t=await setup();
  try {
    await writeFile(join(t.control,`${mode}-7d`),'yes');
    const first=await t.enqueue(); const attempt=await t.failedAttempt(first);
    expect((await t.revisions()).map(row=>row.scope).sort()).toEqual(['30d','all','day']);
    expect((await t.calls()).filter(row=>row.work===first && row.attempt===attempt).map(row=>row.scope)).toEqual(['day','7d','30d','all']);
    await unlink(join(t.control,`${mode}-7d`)); await t.retryNow(first);
    const retry=await t.waitCall(first,'7d',{except:attempt}); await t.outcome(first,'succeeded');
    expect((await t.calls()).filter(row=>row.work===first && row.attempt===retry.attempt).map(row=>row.scope)).toEqual(['7d']);
    expect(await t.revisions()).toHaveLength(4);
  } finally {await t.close();}
},180000);
