import { expect, it } from 'vitest';
import { addSchedule, updateSchedule, tickSchedules, type Schedule } from 'second_brain';
import { memoryStore, manualTime, sequenceIdGen, sampleSelfUserInput } from 'second_brain/testing';
import { cronCalculator } from '../src/runtime/cron.js';

async function kit(start='2026-01-01T00:00:00.000Z') {
 const time=manualTime(new Date(start)),store=memoryStore(),idGen=sequenceIdGen({timestampMs:time.clock.now().getTime()});
 await store.ensureSelfUser(sampleSelfUserInput());let zone='Asia/Seoul';
 const deps={store,clock:time.clock,idGen,cron:cronCalculator,readTimeZone:async()=>({ok:true as const,value:zone})};
 const set=(iso:string)=>time.advance(new Date(iso).getTime()-time.clock.now().getTime());
 const add=async (input:Partial<Parameters<typeof addSchedule>[1]>={})=>{const r=await addSchedule(deps,{kind:'schedule_probe',targetKind:'probe',targetId:'a',cron:'0 9 * * 5',...input});if(!r.ok)throw Error(r.message);return r.schedule;};
 const tick=()=>tickSchedules(deps);
 const rows=async (schedule:Schedule)=>{const r=await store.listOccurrences({scheduleId:schedule.id});if(!r.ok)throw Error(r.message);return r.occurrences;};
 const drain=async()=>{const r=await store.claimWork({now:time.clock.now(),claimedBy:'worker',kinds:['schedule_probe']});if(!r.ok)throw Error(r.message);if(r.item)await store.completeWork({id:r.item.id,claimedBy:'worker',now:time.clock.now()});};
 return {store,deps,set,add,tick,rows,drain,zone:(z:string)=>{zone=z;},now:time.clock.now};
}
it('4주 금요일 09시 회차 4개만 생성하고 완료한다',async()=>{
 const k=await kit(),s=await k.add();for(const day of ['02','09','16','23']){k.set(`2026-01-${day}T00:00:00.000Z`);expect(await k.tick()).toMatchObject({fired:1,enqueued:1});await k.drain();}
 expect((await k.rows(s)).map(r=>r.status)).toEqual(['done','done','done','done']);expect(k.store.snapshot().workItems).toHaveLength(4);
});
it.each([['latest',['skipped','skipped','pending']],['coalesce',['pending','pending','pending']],['skip',['skipped','skipped','skipped']]] as const)('3주 정지 %s 정책',async(policy,statuses)=>{
 const k=await kit();await k.store.recordExtensionInstall({name:'testext',version:'1',now:k.now(),workKinds:['testext.sync'],missedPolicies:{'testext.sync':policy}});
 const s=await k.add({kind:'testext.sync'});k.set('2026-01-16T00:06:00.000Z');await k.tick();expect((await k.rows(s)).map(r=>r.status)).toEqual(statuses);expect(k.store.snapshot().workItems).toHaveLength(policy==='skip'?0:1);
 expect(await k.store.readSchedule({id:s.id})).toMatchObject({schedule:{nextRunAt:new Date('2026-01-23T00:00:00Z')}});
 if(policy!=='skip') {
  const claim=await k.store.claimSupervisedWork({now:k.now(),claimedBy:'worker',kinds:['testext.sync'],attemptToken:'00000000-0000-7000-8000-000000000099'});if(!claim.ok||!claim.item)throw Error('claim');
  expect(claim.item.scheduledOccurrences?.[0]?.occurrences.map(x=>x.toISOString())).toEqual(policy==='latest'?['2026-01-16T00:00:00.000Z']:['2026-01-02T00:00:00.000Z','2026-01-09T00:00:00.000Z','2026-01-16T00:00:00.000Z']);
  expect(await k.store.finishSupervisedWork({id:claim.item.id,attemptToken:'00000000-0000-7000-8000-000000000099',now:k.now(),outcome:'succeeded'})).toMatchObject({ok:true,outcome:'done'});
 }
 expect((await k.rows(s)).map(r=>r.status)).toEqual(policy==='latest'?['skipped','skipped','done']:policy==='coalesce'?['done','done','done']:statuses);
});
it('5분 이내는 skip 정책에서도 정상 회차다',async()=>{
 const k=await kit();await k.store.recordExtensionInstall({name:'testext',version:'1',now:k.now(),workKinds:['testext.sync'],missedPolicies:{'testext.sync':'skip'}});const s=await k.add({kind:'testext.sync'});k.set('2026-01-02T00:05:00.000Z');await k.tick();expect((await k.rows(s))[0]?.status).toBe('pending');
});
it('청구 중 들어온 새 회차는 다음 시도에서 청구하고 실패하면 재시도한다',async()=>{
 const k=await kit(),s=await k.add();k.set('2026-01-02T00:00:00.000Z');await k.tick();const first=await k.store.claimWork({now:k.now(),claimedBy:'a',kinds:['schedule_probe']});if(!first.ok||!first.item)throw Error('claim');
 k.set('2026-01-09T00:00:00.000Z');await k.tick();await k.store.completeWork({id:first.item.id,claimedBy:'a',now:k.now()});expect((await k.rows(s)).map(r=>r.status)).toEqual(['done','pending']);
 const second=await k.store.claimWork({now:k.now(),claimedBy:'b',kinds:['schedule_probe']});if(!second.ok||!second.item)throw Error('claim');expect(second.item.scheduledOccurrences?.[0]?.occurrences).toEqual([k.now()]);
 await k.store.retryWork({id:second.item.id,claimedBy:'b',nextAttemptAt:k.now(),lastError:'retry'});expect((await k.rows(s)).map(r=>r.status)).toEqual(['done','pending']);await k.drain();expect((await k.rows(s)).map(r=>r.status)).toEqual(['done','done']);
});
it('늦은 once는 한 번만 실행한다',async()=>{
 const k=await kit(),s=await k.add({cron:undefined,once:'2026-01-02T09:00:00+09:00'});k.set('2026-01-05T00:00:00.000Z');await k.tick();await k.drain();expect((await k.rows(s)).map(r=>r.status)).toEqual(['done']);expect(await k.tick()).toMatchObject({fired:0});
});
it.each([['30 2 * * *','2026-03-08T00:00:00.000Z','2026-03-08T07:00:00.000Z'],['30 1 * * *','2026-11-01T00:00:00.000Z','2026-11-01T05:30:00.000Z']])('DST %s 계산과 단일 발화',async(expr,start,at)=>{
 const k=await kit(start),s=await k.add({cron:expr,timeZone:'America/New_York'});k.set(at);await k.tick();await k.drain();k.set(new Date(new Date(at).getTime()+3600000).toISOString());await k.tick();expect((await k.rows(s)).map(r=>r.occurrenceAt.toISOString())).toEqual([at]);
});
it('trigger 변경은 이력 보존하고 새 다음 시각을 계산한다',async()=>{
 const k=await kit(),s=await k.add();k.set('2026-01-02T00:00:00.000Z');await k.tick();await k.drain();const before=await k.rows(s);const updated=await updateSchedule(k.deps,{id:s.id,cron:'0 10 * * 5'});expect(updated).toMatchObject({ok:true,schedule:{cronExpr:'0 10 * * 5',nextRunAt:new Date('2026-01-02T01:00:00.000Z')}});expect(await k.rows(s)).toEqual(before);
});
it('형식·시간대·과거 또는 잘못된 once를 거부한다',async()=>{
 const k=await kit();for(const cron of ['0 9 * *','0 0 9 * * *','@daily','0 9 * * ?','0 9 L * *'])expect((await addSchedule(k.deps,{kind:'x',targetKind:'y',targetId:'z',cron}))).toMatchObject({ok:false,code:'SCHEDULE_INVALID'});
 expect(await addSchedule(k.deps,{kind:'x',targetKind:'y',targetId:'z',cron:'0 9 * * *',timeZone:'Invalid/Zone'})).toMatchObject({ok:false,code:'SCHEDULE_INVALID'});
 for(const once of ['2025-01-01T00:00:00Z','2026-02-31T00:00:00Z','2026-01-02T00:00:00'])expect(await addSchedule(k.deps,{kind:'x',targetKind:'y',targetId:'z',once})).toMatchObject({ok:false,code:'SCHEDULE_INVALID'});
});
it('10000 초과 회차는 경고하고 최근 1000개만 기록한다',async()=>{
 const k=await kit('2026-01-01T00:00:00.000Z'),s=await k.add({cron:'* * * * *',timeZone:'UTC'});
 k.set('2026-01-08T00:02:00.000Z');const result=await k.tick();expect(result).toMatchObject({ok:true,warnings:[expect.stringContaining('10000')]});
 const rows=await k.rows(s);expect(rows).toHaveLength(1000);expect(rows.at(-1)?.occurrenceAt).toEqual(k.now());expect(rows.filter(row=>row.status==='pending')).toHaveLength(7);
});
it('그룹별 현지 날짜와 중복 제거된 전체 instant를 ABI로 전달한다',async()=>{
 const {scheduleEnvironment}=await import('../src/daemon/supervisor.js');const a=new Date('2026-01-01T16:00:00.000Z'),b=new Date('2026-01-02T01:00:00.000Z');
 expect(scheduleEnvironment([{scheduleId:'a',timeZone:'Asia/Seoul',occurrences:[a,b]},{scheduleId:'b',timeZone:'America/New_York',occurrences:[a]}])).toEqual({BRAIN_RANGE_FROM:'2026-01-01',BRAIN_RANGE_TO:'2026-01-02',BRAIN_OCCURRENCES:'["2026-01-01T16:00:00.000+00:00","2026-01-02T01:00:00.000+00:00"]'});
 expect(scheduleEnvironment(null)).toEqual({});
});
it('user zone은 변경 후 재계산되고 fixed zone은 유지된다',async()=>{
 const k=await kit(),user=await k.add({targetId:'user'}),fixed=await k.add({targetId:'fixed',timeZone:'Asia/Seoul'});k.zone('America/New_York');await k.tick();
 expect(await k.store.readSchedule({id:user.id})).toMatchObject({schedule:{timeZone:'America/New_York',nextRunAt:new Date('2026-01-02T14:00:00.000Z')}});
 expect(await k.store.readSchedule({id:fixed.id})).toMatchObject({schedule:{timeZone:'Asia/Seoul',nextRunAt:new Date('2026-01-02T00:00:00.000Z')}});
});
it('같은 시각을 반환하는 gap 벽시계 일치는 한 회차다',()=>{
 const before=new Date('2026-03-08T06:59:00.000Z');const first=cronCalculator.next('* * * * *','America/New_York',before);
 expect(first).toEqual(new Date('2026-03-08T07:00:00.000Z'));expect(cronCalculator.next('* * * * *','America/New_York',first!)).toEqual(new Date('2026-03-08T07:01:00.000Z'));
});
it('rezone 중 trigger가 바뀌면 오래된 식으로 다음 시각을 덮지 않는다',async()=>{
 const k=await kit(),s=await k.add();k.zone('America/New_York');const rezone=k.store.rezoneSchedule;
 k.store.rezoneSchedule=async input=>{const current=await k.store.readSchedule({id:s.id});if(!current.ok||!current.schedule)throw Error('missing schedule');
  await k.store.updateSchedule({id:s.id,expected:current.schedule,schedule:{...current.schedule,cronExpr:'0 10 * * 5'}});return rezone(input);};
 await k.tick();expect(await k.store.readSchedule({id:s.id})).toMatchObject({schedule:{cronExpr:'0 10 * * 5',timeZone:'Asia/Seoul'}});
});
it('10000회 초과 interval은 원래 격자와 다음 시각의 위상을 보존한다',async()=>{
 const k=await kit('2026-01-01T00:00:00.000Z');const user=await k.store.readSelfUser();if(!user.ok||!user.user)throw Error('self');
 const base=new Date('2026-01-01T00:00:07.000Z');const added=await k.store.addSchedule({id:'00000000-0000-7000-8000-000000000098',kind:'schedule_probe',targetKind:'probe',targetId:'interval',triggerKind:'interval',cronExpr:null,runAt:null,timeZone:null,timeZoneSource:null,intervalSeconds:17,extension:null,scheduleKey:null,userId:user.user.id,enabled:true,removedAt:null,nextRunAt:base,lastRunAt:null,createdAt:k.now()});if(!added.ok)throw Error(added.message);
 const now=new Date(base.getTime()+17_000*11000+4321);k.set(now.toISOString());expect(await k.tick()).toMatchObject({ok:true,warnings:[expect.any(String)]});
 const rows=await k.rows(added.schedule);expect(rows).toHaveLength(1000);expect(rows.every(row=>(row.occurrenceAt.getTime()-base.getTime())%17000===0)).toBe(true);
 const read=await k.store.readSchedule({id:added.schedule.id});if(!read.ok||!read.schedule?.nextRunAt)throw Error('next');expect(read.schedule.nextRunAt.getTime()).toBe(base.getTime()+17_000*11001);
});
it('trigger 변경 뒤 user zone 변경은 변경 이전 회차를 소급하지 않는다',async()=>{
 const k=await kit('2026-01-01T00:00:00.000Z'),s=await k.add();k.set('2026-01-10T00:00:00.000Z');
 expect(await updateSchedule(k.deps,{id:s.id,cron:'0 10 * * *'})).toMatchObject({ok:true});k.zone('America/New_York');await k.tick();
 expect(await k.rows(s)).toEqual([]);expect(await k.store.readSchedule({id:s.id})).toMatchObject({schedule:{triggerUpdatedAt:new Date('2026-01-10T00:00:00Z'),nextRunAt:new Date('2026-01-10T15:00:00Z')}});
});
it('fixed zone에서 cron만 바꾸면 zone과 다음 실행을 유지하고 user zone 변경에도 영향받지 않는다',async()=>{
 const k=await kit(),s=await k.add({cron:'0 9 * * 5',timeZone:'America/New_York'});
 const updated=await updateSchedule(k.deps,{id:s.id,cron:'  15   10  * *  5  '});
 expect(updated).toMatchObject({ok:true,schedule:{cronExpr:'15 10 * * 5',timeZone:'America/New_York',timeZoneSource:'fixed',nextRunAt:new Date('2026-01-02T15:15:00.000Z')}});
 k.zone('Europe/London');await k.tick();expect(await k.store.readSchedule({id:s.id})).toMatchObject({ok:true,schedule:{cronExpr:'15 10 * * 5',timeZone:'America/New_York',timeZoneSource:'fixed',nextRunAt:new Date('2026-01-02T15:15:00.000Z')}});
});
