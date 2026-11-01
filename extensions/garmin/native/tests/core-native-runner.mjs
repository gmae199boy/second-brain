/* 격리 DB와 합성 서비스로 실제 Core 및 제품 adapter를 조합한다. */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { postgresStore, postgresProtectedMutationStore } from '../../../../packages/postgres/dist/index.js';
import { createBrain } from '../../../../packages/core/dist/index.js';
import { createProtectedService } from '../../../../apps/cli/dist/daemon/protected-supervisor.js';
import { createNativeBridgeAdapter } from '../../../../apps/cli/dist/daemon/sealed-native-bridge.js';
import { systemClock, systemTimer } from '../../../../apps/cli/dist/runtime/clock.js';
import pg from '../../../../packages/postgres/node_modules/pg/lib/index.js';

const [bridge, port, fixtureWorker, signalCase, hostService] = process.argv.slice(2);
if (!bridge || !/^\d+$/.test(port ?? '') || !fixtureWorker) process.exit(2);
const work = '00000000-0000-4000-8000-000000000151';
const work2 = '00000000-0000-4000-8000-000000000152';
const twoCore = process.env.BRAIN_FIXTURE_TWO_CORE === '1';
const store = postgresStore({ databaseUrl: `postgres://brain_protected_supervisor@127.0.0.1:${port}/postgres` });
const mutationStore = postgresProtectedMutationStore({ databaseUrl: `postgres://brain_protected_supervisor@127.0.0.1:${port}/postgres` });
const controller = new AbortController();
const recordCase = process.env.BRAIN_FIXTURE_CORE_RECORD ?? '';
let recordCalls = 0, authorizeCalls = 0, workerAfterAck = false, bridgeChild, workerStages = [];
const recordProcess = store.recordSupervisedProcess.bind(store);
if (recordCase) store.recordSupervisedProcess = async input => {
  recordCalls++;
  const result = await recordProcess(input);
  if (recordCase === 'lost' && result.ok && result.outcome === 'done') return { ok: false, code: 'DB_UNAVAILABLE', message: 'fixture' };
  return result;
};
const bridgeAdapter = createNativeBridgeAdapter(async () => (bridgeChild = spawn(bridge, [], {
  cwd: '/', env: { PATH: '/usr/bin:/bin', LANG: 'C' }, stdio: ['ignore','pipe','pipe','pipe'],
})).on('spawn', function () { this.stderr.on('data', chunk => { if (String(chunk).includes('fixture-worker-after-ack')) workerAfterAck = true; for (const match of String(chunk).matchAll(/fixture-worker-stage=([0-9]+)|fixture-(observed|members|reap|revoke)-wire/g)) workerStages.push(match[1] ?? match[2]); }); }));
const verify = promisify(execFile);
const garmin = {
  async verifyInstalledWorker() {
    try { await verify('/usr/bin/codesign', ['--verify','--strict',fixtureWorker], { env: { PATH: '/usr/bin:/bin', LANG: 'C' }, timeout: 5000 }); return true; }
    catch { return false; }
  },
  async snapshot(_kind,item) { return JSON.stringify({ version: 1, extension: 'garmin', values: { 'garmin.tokenstore': item.id===work2?'fixture2':'fixture', 'garmin.timezone': 'UTC' } }); },
  async admit(item, token, spec) {
    const target=JSON.parse(spec.env.BRAIN_SETTINGS_SNAPSHOT).values['garmin.tokenstore'];
    return store.reserveExtensionAdmission({ extension: 'garmin', workId: item.id, attemptToken: token, generation: item.attempts, target, timeZone: 'UTC' });
  },
  async release(item, token) { return store.releaseExtensionAdmission({ extension: 'garmin', workId: item.id, attemptToken: token }); },
};
const issues = [];
const mutation = process.env.BRAIN_FIXTURE_CORE_MUTATION ?? '';
const multiple = process.env.BRAIN_FIXTURE_CORE_MULTIPLE ?? '';
const lostCommit = process.env.BRAIN_FIXTURE_CORE_COMMIT_LOST === '1';
const failedAck = process.env.BRAIN_FIXTURE_CORE_ACK_FAIL ?? '';
let revokedBeforeFailure=0;
async function addExtra() {
  const client = new pg.Client({ connectionString: `postgres://brain_protected_supervisor@127.0.0.1:${port}/postgres` });await client.connect();
  try {
    const extra='00000000-0000-4000-8000-000000000251',token='00000000-0000-4000-8000-000000000252';
    await client.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,attempts,claimed_at,claim_expires_at,claimed_by,hold_group) values ($1,'garmin.auth','extension','fixture-extra',now(),now(),'supervised',1,now(),now()+interval '1 hour','fixture','extension:garmin')",[extra]);
    await client.query('insert into brain.work_attempts(token,work_item_id,started_at) values ($1,$2,now())',[token,extra]);
    await client.query('update brain.work_items set current_attempt_token=$1 where id=$2',[token,extra]);
    if(multiple==='missing') {
      await client.query('select brain.begin_protected_input_launch($1,$2,1)',[extra,token]);
      await client.query("update brain.work_attempts set protected_launch_lease='00000000-0000-4000-8000-000000000253',protected_connection_epoch=1 where token=$1",[token]);
    }
  } finally {await client.end();}
}
let raced=false;
const mutationPorts = {
  async list(action) {const result=await mutationStore.list(action);if(multiple==='race' && !raced){raced=true;await addExtra();}return result;},
  async commit(action,attempts,request) {const result=await mutationStore.commit(action,attempts,request);return lostCommit && result.status==='committed'?{status:'unknown'}:result;},
  applied: (action,attempts,request) => mutationStore.applied(action,attempts,request),
};
let restarted=false;
const revoker={ async revoke(attempt) {
  if(restarted || failedAck==='1' || (failedAck==='second' && revokedBeforeFailure===1))return false;
  const result=await bridgeAdapter.revoker.revoke(attempt);if(result)revokedBeforeFailure++;return result;
} };
let service=createProtectedService({ store, schemaVersions: { core: 29 },
  clock: systemClock, timer: systemTimer, idGen: { next: randomUUID }, signal: controller.signal,
  pollMs: 50, cancelPollMs: 100, renewEveryMs: 500, groupConfirmMs: 1000, cancelGraceMs: 200,
  log(message) { issues.push(message); },
}, {garmin,mutations:mutationPorts,status:async()=>({available:true,requiresAction:false}),
  makeBrain: commandStore => createBrain({store:commandStore,clock:systemClock,idGen:{next:randomUUID},schemaVersions:{core:29},files:{},spool:{},parsers:[],transcripts:{},repositories:{},machine:'fixture'}),
}, {...bridgeAdapter,revoker,bootstrap:{async authorize(...args){authorizeCalls++;return bridgeAdapter.bootstrap.authorize(...args);}}});
if(mutation) {
  const ordinary=randomUUID(),now=systemClock.now();
  const added=await store.addWork({id:ordinary,kind:'process_probe',targetKind:'fixture',targetId:ordinary,createdAt:now,nextAttemptAt:now});
  if(!added.ok)throw new Error('fixture ordinary enqueue');
  const cancelled=await service.request({operation:'queue.cancel',id:ordinary});
  if(!cancelled.ok || cancelled.state!=='cancelled')throw new Error('fixture ordinary cancel');
}
const running = service.run();
let success = false, lastState = null;
let restartController, restartedRunning, restartStarts=0, fixtureGroup=0;
try {
  const deadline = Date.now() + 35000;
  while (Date.now() < deadline) {
    const result = await store.getWork(work);
    if (!result.ok) { issues.push(`fixture 조회 오류 ${result.code}`); break; }
    if (result.entry) lastState = { attempts: result.entry.item.attempts, outcome: result.entry.item.outcome, current: Boolean(result.entry.item.currentAttemptToken), lastOutcome: result.entry.latestAttempt?.outcome, lastCode: result.entry.latestAttempt?.errorCode };
    if (recordCase && result.entry?.latestAttempt?.outcome) { success = true; break; }
    if (signalCase === '1' && result.entry?.latestAttempt?.lastProgressAt) {
      if(twoCore) {const other=await store.getWork(work2);if(!other.ok || !other.entry?.latestAttempt?.lastProgressAt){await new Promise(resolve => setTimeout(resolve,100));continue;}}
      if (mutation) {
        if (multiple==='restart' || multiple==='host-restart') {
          if(!bridgeChild)break;
          fixtureGroup=result.entry.latestAttempt.pid;if(!Number.isSafeInteger(fixtureGroup) || fixtureGroup<=0)break;
          const ended=new Promise(resolve => bridgeChild.once('exit',resolve));
          if(multiple==='host-restart') {if(!hostService)break;await verify('/bin/launchctl',['kill','SIGKILL',hostService],{timeout:5000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});}
          else bridgeChild.kill('SIGKILL');
          let timeout;try {await Promise.race([ended,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('fixture host exit timeout')),12000);})]);} finally {clearTimeout(timeout);}restarted=true;
          controller.abort();await running;
          restartController=new AbortController();
          const newBridge=createNativeBridgeAdapter(async()=>{restartStarts++;throw new Error('unexpected restart');});
          service=createProtectedService({store,schemaVersions:{core:29},clock:systemClock,timer:systemTimer,idGen:{next:randomUUID},signal:restartController.signal,pollMs:50,cancelPollMs:100,groupConfirmMs:1000,cancelGraceMs:200},
            {garmin,mutations:mutationPorts,status:async()=>({available:true,requiresAction:false}),makeBrain: commandStore=>createBrain({store:commandStore,clock:systemClock,idGen:{next:randomUUID},schemaVersions:{core:29},files:{},spool:{},parsers:[],transcripts:{},repositories:{},machine:'fixture'})},newBridge);
          restartedRunning=service.run();await new Promise(resolve=>setTimeout(resolve,700));
          const recovered=await store.getWork(work);if(!recovered.ok || recovered.entry?.item.attempts!==1 || !recovered.entry.item.currentAttemptToken || restartStarts!==0)break;
        }
        if (multiple && multiple!=='restart' && multiple!=='host-restart' && multiple!=='race') await addExtra();
        const request = mutation==='cancel' ? {operation:'queue.cancel',id:work} : mutation==='hold' ? {operation:'queue.hold',group:'extension:garmin'} : {operation:'extension.disable',name:'garmin'};
        const concurrent=process.env.BRAIN_FIXTURE_CORE_CONCURRENT==='1';
        const results=await Promise.all(Array.from({length:concurrent?2:1},()=>service.request(request)));const outcome=results[0];
        success = multiple==='missing' || multiple==='restart' || multiple==='host-restart' || failedAck ? !outcome.ok && outcome.code==='DB_UNAVAILABLE' : outcome.ok && (mutation==='cancel'?outcome.state==='requested':mutation==='hold'?outcome.held===true:outcome.changed===true);
        if(concurrent)success=results.every(result=>result.ok && typeof result.held==='boolean') && results.filter(result=>result.held===true).length===1;
        if(failedAck==='second' && revokedBeforeFailure!==1)success=false;
        if(twoCore && mutation==='cancel') {const other=await store.getWork(work2);if(!other.ok || !other.entry?.item.currentAttemptToken || other.entry.latestAttempt?.outcome)success=false;}
      } else success = true;
      break;
    }
    if (result.entry?.item.completedAt) { success = signalCase !== '1' && result.entry.item.outcome === 'succeeded'; break; }
    await new Promise(resolve => setTimeout(resolve,100));
  }
} finally {
  restartController?.abort();if(restartedRunning)await restartedRunning;
  controller.abort(); await running; await store.close(); await mutationStore.close();
  if(fixtureGroup) {
    // 이 fixture의 leader는 자손을 만들지 않는다. zombie는 host 종료 시 회수된다.
    let gone=false;for(let i=0;i<100;i++) {
      try {const result=await verify('/bin/ps',['-o','stat=','-p',String(fixtureGroup)],{timeout:2000,env:{PATH:'/usr/bin:/bin',LANG:'C'}});if(/^\s*Z/.test(result.stdout)){gone=true;break;}}
      catch(error) {if(error.code===1 && !error.stdout && !error.stderr){gone=true;break;}throw error;}
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    if(!gone){process.stderr.write('합성 leader 종료 불명\n');process.exitCode=1;}
  }
}
if (recordCase && (recordCalls !== 1 || authorizeCalls !== 0 || workerAfterAck)) success = false;
if (!success) { process.stderr.write(`Core/native fixture 실패: ${issues.join(' | ')} 단계=${workerStages.join(',')} 상태=${JSON.stringify(lastState)}\n`); process.exitCode = 1; }
