import type { CronCalculator } from '../ports/cron.js';
import type { ReadTimeZone, TimeZoneFailure } from './schedules.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { ScheduleStore, ScheduleStoreFailure } from '../ports/store.js';

export const SCHEDULE_TICK_LIMIT=100;
export const SCHEDULE_GRACE_MS=300_000;
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
  const due=await store.listDueSchedules({now,limit:SCHEDULE_TICK_LIMIT});if(!due.ok)return {...due,fired,enqueued};
  for(const s of due.schedules){if(!s.nextRunAt)continue;
   const advance=(after:Date):Date|null=>s.triggerKind==='cron'?cron.next(s.cronExpr!,s.timeZone!,after):s.triggerKind==='interval'?new Date(after.getTime()+s.intervalSeconds!*1000):null;
   let dates:Date[]=[s.nextRunAt], next:Date|null=null;
   if(s.triggerKind==='once')next=null;
   else {
    let cursor=s.nextRunAt;
    while(true){const candidate=advance(cursor);if(!candidate || candidate.getTime()<=cursor.getTime())throw new Error('다음 회차를 계산할 수 없습니다');if(candidate>now){next=candidate;break;}dates.push(candidate);cursor=candidate;
     if(dates.length>10_000){
      const warning=`예약 ${s.id}: 회차 10000개 초과, 최근 1000개만 기록합니다`; warnings.push(warning);log?.(warning);
      // Search back from now in expanding windows. A five-field cron has at
      // most one wall match per minute; each window is bounded and retains a
      // rolling suffix even for internal sub-minute intervals.
      let span=s.triggerKind==='interval' ? Math.min(86_400_000, s.intervalSeconds! * 1000 * 1001) : 86_400_000;
      for(;;){const base=s.nextRunAt.getTime(), threshold=now.getTime()-span;
       let start=new Date(s.triggerKind==='interval' ? Math.max(base-1, base+Math.floor((threshold-base)/(s.intervalSeconds!*1000))*s.intervalSeconds!*1000) : Math.max(base-1,threshold));const recent:Date[]=[];
       if(start.getTime()<s.nextRunAt.getTime()) {recent.push(s.nextRunAt); start=s.nextRunAt;}
       let p=advance(start);while(p && p<=now){recent.push(p);if(recent.length>1000)recent.shift();const n=advance(p);if(!n || n<=p)throw new Error('다음 회차를 계산할 수 없습니다');p=n;}
       if(recent.length>=1000 || start.getTime()===s.nextRunAt.getTime()){dates=recent;next=p;break;}span*=2;
      }break;
     }
    }
   }
   let policy:'latest'|'coalesce'|'skip'='latest';if(s.triggerKind!=='once'){const read=await store.readMissedPolicy({kind:s.kind});if(!read.ok)return {...read,fired,enqueued};policy=read.policy;}
   const mostRecentMissed=[...dates].reverse().find(date=>now.getTime()-date.getTime()>SCHEDULE_GRACE_MS);
   const occurrences=dates.map(occurrenceAt=>({occurrenceAt,status:(s.triggerKind==='once'||now.getTime()-occurrenceAt.getTime()<=SCHEDULE_GRACE_MS||policy==='coalesce'||(policy==='latest' && occurrenceAt===mostRecentMissed)?'pending':'skipped') as 'pending'|'skipped'}));
   const result=await store.fireSchedule({scheduleId:s.id,expectedTriggerKind:s.triggerKind,expectedTimeZone:s.timeZone,expectedCronExpr:s.cronExpr,expectedNextRunAt:s.nextRunAt,nextRunAt:next,now,occurrences,work:{id:idGen.next(),kind:s.kind,targetKind:s.targetKind,targetId:s.targetId,holdGroup:s.holdGroup,createdAt:now,nextAttemptAt:now}});
   if(!result.ok)return {...result,fired,enqueued};if(result.fired){fired++;if(result.created)enqueued++;}
  }
  return {ok:true,fired,enqueued,...(warnings.length ? {warnings} : {})};
 }catch(error){return {ok:false,code:'SCHEDULE_INVALID',message:error instanceof Error?error.message:'예약을 계산할 수 없습니다',fired,enqueued};}
}
