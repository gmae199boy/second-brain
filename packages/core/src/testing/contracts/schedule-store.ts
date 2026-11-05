import type { ScheduleStore, WorkStore, UserStore } from '../../ports/store.js';
import type { Schedule } from '../../domain/schedule.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';
import { sampleSelfUserInput } from '../fixtures.js';

export function scheduleStoreContract(): ContractCase<ScheduleStore & WorkStore & UserStore>[] {
 const now=new Date('2026-02-03T04:05:06Z'), next=new Date(now.getTime()+60000), later=new Date(next.getTime()+60000);
 const id=(n:number)=>`00000000-0000-7000-8000-${String(n).padStart(12,'0')}`;
 const work=(n:number,kind='schedule_probe')=>({id:id(n),kind,targetKind:'probe',targetId:'same',createdAt:now,nextAttemptAt:now});
 const seed=async (store:ScheduleStore & UserStore,n=1,kind='schedule_probe') => {const self=await store.ensureSelfUser(sampleSelfUserInput());assertOk(self,'self');const s:Schedule={id:id(n),kind,holdGroup:'pause',targetKind:'probe',targetId:'same',triggerKind:'cron',cronExpr:'0 9 * * *',runAt:null,timeZone:'UTC',timeZoneSource:'fixed',intervalSeconds:null,extension:'testext',scheduleKey:`key${n}`,userId:self.user.id,enabled:true,removedAt:null,triggerUpdatedAt:null,nextRunAt:now,lastRunAt:null,createdAt:now};assertOk(await store.addSchedule(s),'add');return s;};
 return [contractCase('schedule keys, deletion marks and update CAS',async make=>withSubject(make,async store=>{
  const s=await seed(store);const key={extension:s.extension,scheduleKey:s.scheduleKey!,userId:s.userId};
  assertOk(await store.findScheduleByKey(key),'find');const duplicate=await store.addSchedule({...s,id:id(2)});assertEqual(duplicate.ok,false,'duplicate key');
  assertEqual(await store.updateSchedule({id:s.id,expected:{...s,nextRunAt:next},schedule:{...s,enabled:false}}),{ok:true,updated:false},'stale CAS');
  assertEqual(await store.updateSchedule({id:s.id,expected:s,schedule:{...s,enabled:false}}),{ok:true,updated:true},'winning CAS');
  assertEqual(await store.removeSchedule({id:s.id,now}),{ok:true,removed:true,marked:true},'mark');const marked=await store.findScheduleByKey(key);assertOk(marked,'marked');assertEqual(marked.schedule?.removedAt,now,'tombstone');
 })),contractCase('claimed occurrences settle separately from arrivals during an attempt',async make=>withSubject(make,async store=>{
  const a=await seed(store,1),b=await seed(store,2);
  assertOk(await store.fireSchedule({scheduleId:a.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(10)}),'fire');
  const claim=await store.claimWork({now,claimedBy:'worker',kinds:['schedule_probe']});assertOk(claim,'claim');assertEqual(claim.item?.scheduledOccurrences?.[0]?.occurrences,[now],'snapshot');
  assertOk(await store.fireSchedule({scheduleId:b.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(11)}),'second schedule');
  assertOk(await store.completeWork({id:id(10),claimedBy:'worker',now:next}),'complete');
  const first=await store.listOccurrences({scheduleId:a.id}),second=await store.listOccurrences({scheduleId:b.id});assertOk(first,'first');assertOk(second,'second');assertEqual(first.occurrences[0]?.status,'done','done');assertEqual(second.occurrences[0]?.status,'pending','pending');
  const again=await store.claimWork({now:next,claimedBy:'worker',kinds:['schedule_probe']});assertOk(again,'second claim');assertEqual(again.item?.scheduledOccurrences?.[0]?.scheduleId,b.id,'next group');
  assertOk(await store.retryWork({id:id(10),claimedBy:'worker',nextAttemptAt:later,lastError:'retry'}),'retry');const retried=await store.listOccurrences({scheduleId:b.id});assertOk(retried,'retry list');assertEqual(retried.occurrences[0]?.status,'pending','retry pending');
 })),contractCase('one claim includes every attached schedule and permanent failure closes all',async make=>withSubject(make,async store=>{
  const a=await seed(store,1),b=await seed(store,2);
  for(const s of [a,b]) assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(s===a?10:11)}),'fire');
  const claim=await store.claimWork({now,claimedBy:'worker',kinds:['schedule_probe']});assertOk(claim,'claim');
  assertEqual(claim.item?.scheduledOccurrences?.map(g=>g.scheduleId),[a.id,b.id],'all groups');
  assertOk(await store.fireSchedule({scheduleId:a.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:next,nextRunAt:later,now:next,occurrences:[{occurrenceAt:next,status:'pending'}],work:work(12)}),'arrives during claim');
  assertOk(await store.recordFailure({id:id(20),targetKind:'probe',targetId:'same',stage:'probe',fingerprint:'permanent',harness:null,sessionId:null,code:'PERMANENT',message:'synthetic',occurredAt:next,closeWork:{id:id(10),claimedBy:'worker',now:next}}),'failure');
  for(const schedule of [a,b]){const result=await store.listOccurrences({scheduleId:schedule.id});assertOk(result,'list');assertEqual(result.occurrences.every(row=>row.status==='failed'),true,'all pending and claimed failed');}
 })),contractCase('expired claims return all attached occurrences to the new claimant',async make=>withSubject(make,async store=>{
  const s=await seed(store);assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'},{occurrenceAt:next,status:'skipped'}],work:work(10)}),'fire');
  const first=await store.claimWork({now,claimedBy:'first',kinds:['schedule_probe']});assertOk(first,'first');
  const expiry=new Date(now.getTime()+700000);const second=await store.claimWork({now:expiry,claimedBy:'second',kinds:['schedule_probe']});assertOk(second,'second');
  assertEqual(second.item?.scheduledOccurrences?.[0]?.occurrences,[now],'reclaimed');
  assertEqual(await store.completeWork({id:id(10),claimedBy:'first',now:expiry}),{ok:true,outcome:'lost'},'old claim loses');
  assertOk(await store.completeWork({id:id(10),claimedBy:'second',now:expiry}),'complete');
  const rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'rows');assertEqual(rows.occurrences.map(x=>x.status),['done','skipped'],'statuses');
 })),...(['core','supervised'] as const).map(mode=>contractCase<ScheduleStore & WorkStore & UserStore>(`${mode}: 청구 상한과 성공 후 이어가기`,async make=>withSubject(make,async store=>{
  const kind=mode==='core'?'schedule_probe':'process_probe',a=await seed(store,1,kind),b=await seed(store,2,kind);
  const dates=Array.from({length:1002},(_,i)=>new Date(now.getTime()+i*1000));
  for(const [schedule,offset] of [[a,0],[b,1]] as const) assertOk(await store.fireSchedule({scheduleId:schedule.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:schedule.cronExpr,expectedNextRunAt:now,nextRunAt:later,now:later,occurrences:dates.filter((_,i)=>i%2===offset).map(occurrenceAt=>({occurrenceAt,status:'pending' as const})),work:work(10+offset,kind)}),'fire');
  const claim=async(token:number)=>mode==='core'?store.claimWork({now:later,claimedBy:'worker',kinds:[kind]}):store.claimSupervisedWork({now:later,claimedBy:'worker',kinds:[kind],attemptToken:id(token)});
  const finish=async(token:number)=>mode==='core'?store.completeWork({id:id(10),claimedBy:'worker',now:later}):store.finishSupervisedWork({id:id(10),attemptToken:id(token),now:later,outcome:'succeeded'});
  const first=await claim(20);assertOk(first,'claim');const flattened=(first.item?.scheduledOccurrences??[]).flatMap(g=>g.occurrences).sort((x,y)=>x.getTime()-y.getTime());assertEqual(flattened,dates.slice(0,1000),'oldest first');
  assertOk(await finish(20),'success');const second=await claim(21);assertOk(second,'resumed');assertEqual((second.item?.scheduledOccurrences??[]).flatMap(g=>g.occurrences).sort((x,y)=>x.getTime()-y.getTime()),dates.slice(1000),'remaining');assertOk(await finish(21),'finish');
 }))),contractCase('만료 재청구는 더 이른 회차를 포함한 상한만 완료한다',async make=>withSubject(make,async store=>{
  const a=await seed(store,1),b=await seed(store,2),dates=Array.from({length:1000},(_,i)=>new Date(now.getTime()-(1000-i)*1000));
  const fire=(schedule:Schedule,occurrences:Date[],n:number)=>store.fireSchedule({scheduleId:schedule.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:schedule.cronExpr,expectedNextRunAt:now,nextRunAt:next,now,occurrences:occurrences.map(occurrenceAt=>({occurrenceAt,status:'pending' as const})),work:work(n)});
  assertOk(await fire(a,dates,10),'first fire');const first=await store.claimWork({now,claimedBy:'first',kinds:['schedule_probe']});assertOk(first,'first claim');assertEqual(first.item?.scheduledOccurrences?.[0]?.occurrences,dates,'first thousand');
  const earlier=new Date(dates[0]!.getTime()-1000);assertOk(await fire(b,[earlier],11),'earlier arrival');const expiry=new Date(now.getTime()+700000);
  const reclaimed=await store.claimWork({now:expiry,claimedBy:'second',kinds:['schedule_probe']});assertOk(reclaimed,'reclaim');const claimed=(reclaimed.item?.scheduledOccurrences??[]).flatMap(g=>g.occurrences).sort((x,y)=>x.getTime()-y.getTime());assertEqual(claimed,[earlier,...dates.slice(0,999)],'oldest thousand only');
  assertOk(await store.completeWork({id:id(10),claimedBy:'second',now:expiry}),'success');const rows=await store.listOccurrences({scheduleId:a.id});assertOk(rows,'rows');assertEqual(rows.occurrences.map(r=>r.status),[...Array(999).fill('done'),'pending'],'unclaimed remains pending');
  const earlyRows=await store.listOccurrences({scheduleId:b.id});assertOk(earlyRows,'earlier rows');assertEqual(earlyRows.occurrences[0]?.status,'done','earlier done');
 })),...(['core','supervised'] as const).map(mode=>contractCase<ScheduleStore & WorkStore & UserStore>(`${mode}: 청구 후 새 회차와 재시도·종료`,async make=>withSubject(make,async store=>{
  const kind=mode==='core'?'schedule_probe':'process_probe',s=await seed(store,1,kind);
  const fire=(at:Date,after:Date,n:number)=>store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:at,nextRunAt:after,now:at,occurrences:[{occurrenceAt:at,status:'pending'}],work:work(n,kind)});
  const claim=async(token:number,at:Date)=>mode==='core'?store.claimWork({now:at,claimedBy:'worker',kinds:[kind]}):store.claimSupervisedWork({now:at,claimedBy:'worker',kinds:[kind],attemptToken:id(token)});
  const success=async(token:number,at:Date)=>mode==='core'?store.completeWork({id:id(10),claimedBy:'worker',now:at}):store.finishSupervisedWork({id:id(10),attemptToken:id(token),now:at,outcome:'succeeded'});
  assertOk(await fire(now,next,10),'first');const first=await claim(20,now);assertOk(first,'claim');assertEqual(first.item?.scheduledOccurrences?.[0]?.occurrences,[now],'first snapshot');
  assertOk(await fire(next,later,11),'new occurrence');assertOk(await success(20,next),'success');
  let rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'rows');assertEqual(rows.occurrences.map(r=>r.status),['done','pending'],'arrival stays pending');
  const second=await claim(21,next);assertOk(second,'claim again');assertEqual(second.item?.scheduledOccurrences?.[0]?.occurrences,[next],'second snapshot');
  if(mode==='core') assertOk(await store.retryWork({id:id(10),claimedBy:'worker',nextAttemptAt:later,lastError:'retry'}),'retry');
  else assertOk(await store.finishSupervisedWork({id:id(10),attemptToken:id(21),now:next,outcome:'failed',nextAttemptAt:later}),'temporary failure');
  rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'retry rows');assertEqual(rows.occurrences.map(r=>r.status),['done','pending'],'retry pending');
  const third=await claim(22,later);assertOk(third,'third claim');
  if(mode==='supervised') {assertOk(await store.settleSupervisedAttempt({id:id(10),attemptToken:id(22),now:later,outcome:'died'}),'settle');rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'settled');assertEqual(rows.occurrences[1]?.status,'pending','settled pending');assertOk(await claim(23,later),'claim after settle');}
  if(mode==='core') assertOk(await store.recordFailure({id:id(30),targetKind:'probe',targetId:'same',stage:'probe',fingerprint:'failure',harness:null,sessionId:null,code:'PERMANENT',message:'synthetic',occurredAt:later,closeWork:{id:id(10),claimedBy:'worker',now:later}}),'permanent');
  else assertOk(await store.finishSupervisedWork({id:id(10),attemptToken:id(23),now:later,outcome:'failed',failure:{id:id(30),stage:'probe',fingerprint:'failure',code:'PERMANENT',message:'synthetic',occurredAt:later}}),'permanent');
  rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'closed');assertEqual(rows.occurrences.map(r=>r.status),['done','failed'],'permanent failure');
 }))),...(['core','supervised'] as const).map(mode=>contractCase<ScheduleStore & WorkStore & UserStore>(`${mode}: 취소로 닫히는 일감의 남은 회차는 실패`,async make=>withSubject(make,async store=>{
  const kind=mode==='core'?'schedule_probe':'process_probe',s=await seed(store,1,kind);
  assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(10,kind)}),'fire');
  if(mode==='core')assertOk(await store.claimWork({now,claimedBy:'worker',kinds:[kind]}),'claim');else assertOk(await store.claimSupervisedWork({now,claimedBy:'worker',kinds:[kind],attemptToken:id(20)}),'claim');
  assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:next,nextRunAt:later,now:next,occurrences:[{occurrenceAt:next,status:'pending'}],work:work(11,kind)}),'arrival');
  assertOk(await store.requestWorkCancel({id:id(10),now:next}),'cancel');if(mode==='supervised')assertOk(await store.finishSupervisedWork({id:id(10),attemptToken:id(20),now:next,outcome:'failed'}),'cancel finish');
  const rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'rows');assertEqual(rows.occurrences.map(r=>r.status),['failed','failed'],'no pending on closed work');
 }))),contractCase('취소 요청 뒤 감독 시도 종료가 확인되면 남은 회차를 닫는다',async make=>withSubject(make,async store=>{
  const s=await seed(store,1,'process_probe');assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(10,'process_probe')}),'fire');
  assertOk(await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['process_probe'],attemptToken:id(20)}),'claim');assertOk(await store.requestWorkCancel({id:id(10),now:next}),'cancel');
  assertOk(await store.settleSupervisedAttempt({id:id(10),attemptToken:id(20),now:next,outcome:'died'}),'settle');const rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'rows');assertEqual(rows.occurrences[0]?.status,'failed','cancel closed');
 })),contractCase('취소 요청 뒤 성공한 감독 시도는 claimed만 done, 남은 pending은 failed',async make=>withSubject(make,async store=>{
  const s=await seed(store,1,'process_probe');const fire=(at:Date,after:Date,n:number)=>store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:at,nextRunAt:after,now:at,occurrences:[{occurrenceAt:at,status:'pending'}],work:work(n,'process_probe')});
  assertOk(await fire(now,next,10),'first');assertOk(await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['process_probe'],attemptToken:id(20)}),'claim');
  assertOk(await fire(next,later,11),'pending');assertOk(await store.requestWorkCancel({id:id(10),now:next}),'cancel');
  assertOk(await store.finishSupervisedWork({id:id(10),attemptToken:id(20),now:next,outcome:'succeeded'}),'success');
  const rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'rows');assertEqual(rows.occurrences.map(x=>x.status),['done','failed'],'closed pending');
 })),contractCase('회차 시간대는 trigger 변경과 독립적으로 보존된다',async make=>withSubject(make,async store=>{
  const s=await seed(store);assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(10)}),'first');
  const read=await store.readSchedule({id:s.id});assertOk(read,'read');const old=read.schedule!;const changed={...old,timeZone:'Asia/Seoul'};assertOk(await store.updateSchedule({id:s.id,expected:old,schedule:changed}),'change');
  assertEqual(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:next,nextRunAt:later,now:next,occurrences:[{occurrenceAt:next,status:'pending'}],work:work(11)}),{ok:true,fired:false},'stale zone CAS');
  assertOk(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:s.cronExpr,expectedNextRunAt:next,nextRunAt:later,now:next,occurrences:[{occurrenceAt:next,status:'pending'}],work:work(11)}),'second');
  const current=await store.readSchedule({id:s.id});assertOk(current,'current');const before=current.schedule!;
  assertOk(await store.updateSchedule({id:s.id,expected:before,schedule:{...before,triggerKind:'once',cronExpr:null,runAt:later,timeZone:null,timeZoneSource:null,nextRunAt:later}}),'switch once');
  assertEqual(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:s.cronExpr,expectedNextRunAt:later,nextRunAt:null,now:later,occurrences:[{occurrenceAt:later,status:'pending'}],work:work(12)}),{ok:true,fired:false},'stale trigger CAS');
  const claim=await store.claimWork({now:next,claimedBy:'worker',kinds:['schedule_probe']});assertOk(claim,'claim');assertEqual(claim.item?.scheduledOccurrences,[{scheduleId:s.id,timeZone:'Asia/Seoul',occurrences:[next]},{scheduleId:s.id,timeZone:'UTC',occurrences:[now]}],'original zones grouped');
 })),contractCase('발화는 잘못된 시각을 거부하고 예약과 일감을 보존한다',async make=>withSubject(make,async store=>{
  const s=await seed(store),bad=new Date(NaN);const valid={scheduleId:s.id,expectedTriggerKind:'cron' as const,expectedTimeZone:'UTC',expectedCronExpr:s.cronExpr,expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending' as const}],work:work(10)};
  for(const invalid of [{...valid,now:bad},{...valid,nextRunAt:bad},{...valid,expectedNextRunAt:bad},{...valid,work:{...valid.work,createdAt:bad}},{...valid,work:{...valid.work,nextAttemptAt:bad}},{...valid,occurrences:[{occurrenceAt:bad,status:'pending' as const}]}]) {const result=await store.fireSchedule(invalid);assertEqual(result.ok,false,'invalid');}
  const read=await store.readSchedule({id:s.id});assertOk(read,'read');assertEqual(read.schedule,s,'schedule unchanged');const list=await store.listOccurrences({scheduleId:s.id});assertOk(list,'list');assertEqual(list.occurrences,[],'no occurrences');
 })),contractCase('skipped-only firing advances without creating work' ,async make=>withSubject(make,async store=>{
  const s=await seed(store);const result=await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'skipped'}],work:work(10)});
  assertEqual(result,{ok:true,fired:true,created:false,covered:true},'advanced');const rows=await store.listOccurrences({scheduleId:s.id});assertOk(rows,'rows');assertEqual(rows.occurrences[0]?.status,'skipped','skipped');
  const workRows=await store.listWork({includeClosed:true,limit:10});assertOk(workRows,'work');assertEqual(workRows.entries,[],'no work');
 })),contractCase('held and stale schedules do not fire or create occurrences',async make=>withSubject(make,async store=>{
  const s=await seed(store);assertOk(await store.holdWorkGroup({group:'pause',now}),'hold');
  const result=await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(10)});
  assertEqual(result,{ok:true,fired:false},'held CAS');
  assertOk(await store.releaseWorkGroup({group:'pause'}),'release');
  assertOk(await store.updateSchedule({id:s.id,expected:s,schedule:{...s,enabled:false}}),'disable');
  assertEqual(await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:next,now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(10)}),{ok:true,fired:false},'disabled CAS');
  const list=await store.listOccurrences({scheduleId:s.id});assertOk(list,'list');assertEqual(list.occurrences,[],'none');
 }))];
}
