import type { CronCalculator } from '../ports/cron.js';
import type { ReadTimeZone, TimeZoneFailure } from './schedules.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ScheduleStore, ScheduleStoreFailure } from '../ports/store.js';

export const SCHEDULE_TICK_LIMIT=100;
export const SCHEDULE_GRACE_MS=300_000;
export const SCHEDULE_FIRE_BATCH=1000;
const SCHEDULE_BATCHES_PER_TICK=10;
export type ScheduleTickResult = {ok:true;fired:number;enqueued:number;warnings?:string[]} | ((ScheduleStoreFailure|TimeZoneFailure|{ok:false;code:'SCHEDULE_INVALID';message:string}) & {fired:number;enqueued:number});
/** Resolve each due instant and commit the policy decisions with the CAS. */
export async function tickSchedules({store,clock,idGen,readTimeZone,cron,log}: {store:ScheduleStore;clock:Clock;idGen:IdGen;readTimeZone:ReadTimeZone;cron:CronCalculator;log?:(message:string)=>void}): Promise<ScheduleTickResult> {
 const now=clock.now();let fired=0,enqueued=0;const warnings:string[]=[];
 try {
  let limit=SCHEDULE_TICK_LIMIT; const visited=new Set<string>(); let zone:string|undefined;
  for (;;) {
   const list=await store.listUserZoneSchedules({limit}); if(!list.ok)return {...list,fired,enqueued};
   if(list.schedules.length && zone===undefined){const read=await readTimeZone();if(!read.ok)return {...read,fired,enqueued};zone=read.value;}
   for(const s of list.schedules){if(visited.has(s.id))continue;visited.add(s.id);if(s.timeZone===zone || s.triggerKind!=='cron' || !s.nextRunAt)continue;
    const validated=cron.validate(s.cronExpr!,zone!);if(!validated.ok)return {...validated,fired,enqueued};
    const anchor=s.lastRunAt??s.createdAt; const next=cron.next(s.cronExpr!,zone!,s.triggerUpdatedAt && s.triggerUpdatedAt>anchor ? s.triggerUpdatedAt : anchor);if(!next)return {ok:false,code:'SCHEDULE_INVALID',message:'다음 회차를 계산할 수 없습니다',fired,enqueued};
    const result=await store.rezoneSchedule({id:s.id,expectedNextRunAt:s.nextRunAt,expectedTimeZone:s.timeZone!,expectedCronExpr:s.cronExpr!,expectedTriggerUpdatedAt:s.triggerUpdatedAt,timeZone:zone!,nextRunAt:next});if(!result.ok)return {...result,fired,enqueued};
   }
   if(list.schedules.length<limit)break;limit*=2;
  }
  let dueLimit=SCHEDULE_TICK_LIMIT;const seenDue=new Set<string>();
  for (;;) {
  const due=await store.listDueSchedules({now,limit:dueLimit});if(!due.ok)return {...due,fired,enqueued};
  for(const s of due.schedules){if(fired>=SCHEDULE_TICK_LIMIT)break;if(seenDue.has(s.id) || !s.nextRunAt)continue;seenDue.add(s.id);
   const advance=(after:Date):Date|null=>s.triggerKind==='cron'?cron.next(s.cronExpr!,s.timeZone!,after):s.triggerKind==='interval'?new Date(after.getTime()+s.intervalSeconds!*1000):null;
   let policy:'latest'|'coalesce'|'skip'='latest';if(s.triggerKind!=='once'){const read=await store.readMissedPolicy({kind:s.kind});if(!read.ok)return {...read,fired,enqueued};policy=read.policy;}
   let expected:Date|null=s.nextRunAt;
   for(let batch=0;batch<SCHEDULE_BATCHES_PER_TICK && expected && expected<=now;batch++){
    const dates:Date[]=[];let next:Date|null=expected;
    while(next && next<=now && dates.length<SCHEDULE_FIRE_BATCH){
     const cursor:Date=next;dates.push(cursor);next=advance(cursor);
     if(s.triggerKind!=='once' && (!next || next.getTime()<=cursor.getTime()))throw new Error('다음 회차를 계산할 수 없습니다');
    }
    const occurrences=dates.map((occurrenceAt,index)=>{
     const following=dates[index+1]??next;
     const missed=now.getTime()-occurrenceAt.getTime()>SCHEDULE_GRACE_MS;
     const laterMissed=following!==null && now.getTime()-following.getTime()>SCHEDULE_GRACE_MS;
     return {occurrenceAt,status:(s.triggerKind==='once'||!missed||policy==='coalesce'||(policy==='latest'&&!laterMissed)?'pending':'skipped') as 'pending'|'skipped'};
    });
    const result=await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:s.triggerKind,expectedTimeZone:s.timeZone,expectedCronExpr:s.cronExpr,expectedNextRunAt:expected,nextRunAt:next,now,occurrences,work:{id:idGen.next(),kind:s.kind,targetKind:s.targetKind,targetId:s.targetId,holdGroup:s.holdGroup,createdAt:now,nextAttemptAt:now}});
    if(!result.ok)return {...result,fired,enqueued};if(!result.fired)break;fired++;if(result.created)enqueued++;expected=next;
   }
  }
  if(fired>=SCHEDULE_TICK_LIMIT || due.schedules.length<dueLimit)break;
  if(dueLimit > Number.MAX_SAFE_INTEGER / 2)break;dueLimit*=2;
  }
  return {ok:true,fired,enqueued,...(warnings.length ? {warnings} : {})};
 }catch(error){return {ok:false,code:'SCHEDULE_INVALID',message:error instanceof Error?error.message:'예약을 계산할 수 없습니다',fired,enqueued};}
}
