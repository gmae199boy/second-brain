// 격리된 임시 DB와 가짜 Telegram 서버만 사용한다. 운영 DB에는 연결하지 않는다.
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';

if (process.env.BRAIN_TEST_DATABASE_URL?.trim()) {
  console.error('외부 시험 DB 설정이 있어 검증을 시작하지 않았습니다.');
  process.exit(2);
}

const app = join(homedir(), '.second_brain/app');
const load = path => import(pathToFileURL(join(app, path)).href);
const { setupTestDatabase, createTestDatabase } = await load('tooling/test-db/dist/index.js');
const { prepareDatabase, runMigrations, postgresStore } = await load('packages/postgres/dist/index.js');
const { sampleSelfUserInput } = await load('packages/core/dist/testing/index.js');
const { writeConfig } = await load('apps/cli/dist/config/codec.js');
const { uuidV7IdGen } = await load('apps/cli/dist/runtime/id-gen.js');
const { runDaemon } = await load('apps/cli/dist/daemon/run.js');
const teardown = setupTestDatabase();
let db, home, store, server, running;
const controller = new AbortController();
const evidence = [];
try {
  home = await mkdtemp(join(tmpdir(), 'brain157-channel-'));
  db = await createTestDatabase();
  assert.equal((await prepareDatabase({databaseUrl:db.url, databaseName:new URL(db.url).pathname.slice(1), appPassword:'brain-test-app', maintenancePassword:'brain-test-maintenance'})).ok, true);
  assert.equal((await runMigrations({databaseUrl:db.url, clock:{now:()=>new Date()}})).ok, true);
  store = postgresStore({ databaseUrl: db.appUrl });
  assert.equal((await store.ensureSelfUser(sampleSelfUserInput())).ok, true);
  assert.equal((await writeConfig(home, {})).ok, true);
  await writeFile(join(home,'.env'), `BRAIN_DATABASE_URL=${db.appUrl}\n`, {mode:0o600});
  const ids=uuidV7IdGen(), channel=ids.next(), conversation=ids.next(), session=ids.next(), producer=ids.next(), request=ids.next(), work=ids.next(), token=ids.next(), now=new Date();
  await db.query(`insert into brain.sessions (id,harness,harness_session_id,user_id,machine,started_at,ingest_source) select '${session}','test','${session}',id,'test',now(),'import' from brain.users limit 1`);
  await db.query(`insert into brain.messages (id,session_id,harness_message_id,role,body,occurred_at) values ('${producer}','${session}','fixture-result','assistant','fixture result',now())`);
  for (const x of [await store.ensureChannel({id:channel,kind:'telegram',botRef:'fixture-bot'}), await store.ensureChannelConversation({id:conversation,userId:sampleSelfUserInput().id,channelId:channel,externalRef:'fixture-chat',threadRef:null}), await store.createChannelRequest({id:request,conversationId:conversation,producer:'fixture',producerResultId:producer,purpose:'notice',revision:null,text:'fixture message',createdAt:now}), await store.handoffChannelRequest({requestId:request,workId:work,now})]) assert.equal(x.ok,true);
  await store.claimSupervisedWork({now,kinds:['channel_send'],claimedBy:'fixture',attemptToken:token});
  const attempt={requestId:request,workItemId:work,attemptToken:token,now};
  await store.gateChannelAttempt(attempt);
  await store.finishChannelAttempt({...attempt,result:{outcome:'definite_failed',code:'fixture',retryable:false}});
  await store.finishSupervisedWork({id:work,attemptToken:token,now,outcome:'failed',failure:{id:ids.next(),stage:'channel_send',fingerprint:'fixture',code:'FAIL',message:'fixture',occurredAt:now}});
  async function cli(label,args,expected) {
    const result=await new Promise((resolve,reject)=>{const p=spawn(join(homedir(),'.second_brain/bin/brain'),args,{env:{...process.env,SECOND_BRAIN_HOME:home,BRAIN_DATABASE_URL:db.appUrl}}); let out='',err=''; p.stdout.on('data',x=>out+=x); p.stderr.on('data',x=>err+=x); p.on('error',reject); p.on('close',code=>resolve({code,stdout:out,stderr:err}));});
    const json=JSON.parse(result.stdout); evidence.push({label,args:args.map(x=>x===request?'<fixture-request-id>':x),...result}); assert.equal(json.ok,expected); return json;
  }
  const before=await cli('status-before',['channels','status',request,'--json'],true); assert.equal(before.data.delivery,'definite_failed'); assert.equal(before.data.resendEligible,true);
  await cli('resend',['channels','resend',request,'--json'],true);
  const duplicate=await cli('resend-in-progress',['channels','resend',request,'--json'],false); assert.equal(duplicate.error.code,'CHANNEL_REQUEST_IN_PROGRESS');
  const probePath=fileURLToPath(new URL('./probe.mjs',import.meta.url));
  async function probe() { return await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[probePath],{env:{...process.env,SECOND_BRAIN_HOME:home}}); let out='',err=''; p.stdout.on('data',x=>out+=x); p.stderr.on('data',x=>err+=x); p.on('error',reject); p.on('close',code=>resolve({code,stdout:out,stderr:err}));}); }
  const missing=await probe(); assert.equal(missing.code,2); evidence.push({label:'probe-missing',...missing});
  await writeFile(join(home,'.env'), `BRAIN_DATABASE_URL=${db.appUrl}\nBRAIN_TELEGRAM_BOT_TOKEN=fixture-token\nBRAIN_TELEGRAM_CHAT_ID=fixture-chat\nBRAIN_POSTGRES_PASSWORD=${decodeURIComponent(new URL(db.url).password)}\n`, {mode:0o600});
  const made=await probe(); assert.equal(made.code,0); const probeReceipt=JSON.parse(made.stdout).receipt; evidence.push({label:'probe-created',...made});
  const again=await probe(); assert.equal(again.code,0); assert.equal(JSON.parse(again.stdout).receipt.request,probeReceipt.request); evidence.push({label:'probe-repeat',...again});
  const cleanupPath=fileURLToPath(new URL('./cleanup.mjs',import.meta.url));
  async function cleanup() { return await new Promise((resolve,reject)=>{const p=spawn(process.execPath,[cleanupPath,'--delete-owned-probe'],{env:{...process.env,SECOND_BRAIN_HOME:home}}); let out='',err=''; p.stdout.on('data',x=>out+=x); p.stderr.on('data',x=>err+=x); p.on('error',reject); p.on('close',code=>resolve({code,stdout:out,stderr:err}));}); }
  const active=await cleanup(); assert.equal(active.code,1); evidence.push({label:'cleanup-active',...active});
  let calls=0; server=createServer((req,res)=>{calls++; req.resume(); req.on('end',()=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({ok:true,result:{message_id:987}})));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  running=runDaemon({home,env:{...process.env,BRAIN_DATABASE_URL:db.appUrl,BRAIN_TELEGRAM_BOT_TOKEN:'fixture-token',BRAIN_TELEGRAM_CHAT_ID:'fixture-chat',CLAUDE_CONFIG_DIR:join(home,'no-claude'),CODEX_HOME:join(home,'no-codex')},clock:{now:()=>new Date()},idGen:uuidV7IdGen(),signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25,channelTestEndpoint:`http://127.0.0.1:${server.address().port}`}});
  let status; for(let i=0;i<150;i++){status=await store.readChannelStatus(request); if(status.request?.delivery==='sent') break; await new Promise(r=>setTimeout(r,100));}
  assert.equal(status.request?.delivery,'sent');
  let probeStatus; for(let i=0;i<150;i++){probeStatus=await store.readChannelStatus(probeReceipt.request); if(probeStatus.request?.delivery==='sent') break; await new Promise(r=>setTimeout(r,100));}
  assert.equal(probeStatus.request?.delivery,'sent'); assert.equal(calls,2);
  const probeSent=await probe(); assert.equal(probeSent.code,0); assert.equal(JSON.parse(probeSent.stdout).status.delivery,'sent'); assert.equal(JSON.parse(probeSent.stdout).messageId,'987'); evidence.push({label:'probe-sent',...probeSent});
  await cli('status-after',['channels','status',request,'--json'],true);
  const cleaned=await cleanup(); assert.equal(cleaned.code,0); evidence.push({label:'cleanup-closed',...cleaned});
  assert.equal((await store.readChannelRequest(probeReceipt.request)).request,null);
  assert.notEqual((await store.readChannelRequest(request)).request,null);
  const afterCleanup=await probe(); assert.equal(afterCleanup.code,1); evidence.push({label:'probe-after-cleanup',...afterCleanup});
  const sent=await cli('resend-sent',['channels','resend',request,'--json'],false); assert.equal(sent.error.code,'CHANNEL_ALREADY_SENT');
  console.log(JSON.stringify({request,work,channel,conversation,calls,evidence},null,2));
} finally {
  controller.abort(); if(running) await running; if(server) await new Promise(resolve=>server.close(resolve)); if(store) await store.close(); if(db) await db.drop(); if(home) await rm(home,{recursive:true,force:true}); if(teardown) teardown();
}
