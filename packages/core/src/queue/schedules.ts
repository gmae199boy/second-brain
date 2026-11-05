import { resolveSelfUser } from '../users/self.js';
import type { Clock } from '../ports/clock.js';
import type { IdGen } from '../ports/id-gen.js';
import type { CronCalculator } from '../ports/cron.js';
import type { ScheduleStore, WorkStore, UserStore, ScheduleStoreFailure } from '../ports/store.js';
import type { Schedule } from '../domain/schedule.js';
import { isLocalTime } from '../local-time.js';

export type TimeZoneFailure={ok:false;code:'USER_MISSING'|'CONFIG_INVALID'|'SCHEMA_MISMATCH'|'DB_UNAVAILABLE'|'DB_LOCKED';message:string};
export type ReadTimeZone=()=>Promise<{ok:true;value:string}|TimeZoneFailure>;
export interface SchedulesDependencies {store:ScheduleStore & WorkStore & Pick<UserStore,'readSelfUser'>;clock:Clock;idGen:IdGen;readTimeZone:ReadTimeZone;cron:CronCalculator}
export interface AddDailyInput {kind:string;targetKind:string;targetId:string;localTime:string;holdGroup?:string|null}
export type CreateScheduleInput = {kind:string;targetKind:string;targetId:string;holdGroup?:string|null;cron?:string;timeZone?:string;once?:string;localTime?:string};
export type AddDailyResult=Awaited<ReturnType<ScheduleStore['addSchedule']>>|TimeZoneFailure|{ok:false;code:'SCHEDULE_INVALID';message:string};
const invalid=(message:string)=>({ok:false as const,code:'SCHEDULE_INVALID' as const,message});
async function trigger(deps:SchedulesDependencies,input:{cron?:string;timeZone?:string;once?:string;localTime?:string},now:Date):Promise<{ok:true;value:Pick<Schedule,'triggerKind'|'cronExpr'|'runAt'|'timeZone'|'timeZoneSource'|'intervalSeconds'|'nextRunAt'>}|TimeZoneFailure|{ok:false;code:'SCHEDULE_INVALID';message:string}> {
 if([input.cron,input.once,input.localTime].filter(x=>x!==undefined).length!==1)return invalid('cron, once, localTime 중 하나가 필요합니다');
 if(input.once!==undefined){if(input.timeZone!==undefined)return invalid('한 번 실행에는 시간대를 지정할 수 없습니다');const m=/^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d):([0-5]\d)(?:\.\d{1,3})?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.exec(input.once);if(!m)return invalid('오프셋이 있는 ISO 시각이 필요합니다');const date=new Date(input.once),check=new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`);if(Number.isNaN(date.getTime())||Number.isNaN(check.getTime())||check.toISOString().slice(0,10)!==`${m[1]}-${m[2]}-${m[3]}`||date<=now)return invalid('미래의 실제 시각이 필요합니다');return {ok:true,value:{triggerKind:'once',cronExpr:null,runAt:date,timeZone:null,timeZoneSource:null,intervalSeconds:null,nextRunAt:date}};}
 let expr=input.cron;if(input.localTime!==undefined){if(input.timeZone!==undefined || !isLocalTime(input.localTime))return invalid('현지 시각이 올바르지 않습니다');const [h,m]=input.localTime.split(':').map(Number);expr=`${m} ${h} * * *`;}
 expr=expr?.trim().split(/\s+/).join(' ');
 let zone=input.timeZone;if(zone===undefined){const read=await deps.readTimeZone();if(!read.ok)return read;zone=read.value;}
 const checked=deps.cron.validate(expr!,zone);if(!checked.ok)return checked;
 try {const next=deps.cron.next(expr!,zone,now);if(!next)return invalid('다음 회차가 없습니다');return {ok:true,value:{triggerKind:'cron',cronExpr:expr!,runAt:null,timeZone:zone,timeZoneSource:input.timeZone===undefined?'user':'fixed',intervalSeconds:null,nextRunAt:next}};}catch{return invalid('cron 식 또는 시간대가 올바르지 않습니다');}
}
export async function addSchedule(deps:SchedulesDependencies,input:CreateScheduleInput):Promise<AddDailyResult>{
 if([input.kind,input.targetKind,input.targetId].some(x=>!x.trim()))return invalid('예약 종류와 대상은 비어 있을 수 없습니다');
 const self=await resolveSelfUser(deps.store);if(!self.ok)return self;const now=deps.clock.now();const t=await trigger(deps,input,now);if(!t.ok)return t;
 return deps.store.addSchedule({id:deps.idGen.next(),kind:input.kind,targetKind:input.targetKind,targetId:input.targetId,holdGroup:input.holdGroup,...t.value,extension:null,scheduleKey:null,userId:self.userId,enabled:true,removedAt:null,triggerUpdatedAt:null,lastRunAt:null,createdAt:now});
}
export const addDaily=addSchedule;
export async function updateSchedule(deps:SchedulesDependencies,input:{id:string;cron?:string;once?:string;timeZone?:string;enabled?:boolean}) {
 const found=await deps.store.readSchedule({id:input.id});if(!found.ok)return found;if(!found.schedule)return {ok:false as const,code:'SCHEDULE_NOT_FOUND' as const,message:'지정한 예약이 없습니다'};
 const old=found.schedule; let replacement=old;
 if(input.cron!==undefined || input.once!==undefined || input.timeZone!==undefined){
  if(input.cron!==undefined && input.once!==undefined)return invalid('예약 종류를 하나만 지정하세요');
  const expr=input.cron ?? (input.once===undefined && old.triggerKind==='cron'?old.cronExpr ?? undefined:undefined);
  if(input.timeZone!==undefined && input.once!==undefined)return invalid('한 번 실행에는 시간대를 지정할 수 없습니다');
  const changedAt=deps.clock.now();
  const t=await trigger(deps,{...(expr===undefined?{}:{cron:expr}),...(input.once===undefined?{}:{once:input.once}),...(input.timeZone!==undefined?{timeZone:input.timeZone}:expr!==undefined && old.timeZoneSource==='fixed' && old.timeZone ? {timeZone:old.timeZone}:{})},changedAt);if(!t.ok)return t;replacement={...old,...t.value,triggerUpdatedAt:changedAt};
 }
 replacement={...replacement,enabled:input.enabled??old.enabled};const updated=await deps.store.updateSchedule({id:input.id,expected:old,schedule:replacement});if(!updated.ok)return updated;return updated.updated?{ok:true as const,schedule:replacement}:{ok:false as const,code:'SCHEDULE_CONFLICT' as const,message:'예약이 변경되었습니다. 다시 시도하세요'};
}
export type RunScheduleResult={ok:true;workId:string;created:boolean}|ScheduleStoreFailure|TimeZoneFailure|{ok:false;code:'SCHEDULE_NOT_FOUND';message:string};
export async function runSchedule(deps:SchedulesDependencies,{scheduleId}:{scheduleId:string}):Promise<RunScheduleResult>{const read=await deps.store.readSchedule({id:scheduleId});if(!read.ok)return read;const s=read.schedule;if(!s)return {ok:false,code:'SCHEDULE_NOT_FOUND',message:'지정한 예약이 없습니다'};const now=deps.clock.now();const work=await deps.store.addWork({id:deps.idGen.next(),kind:s.kind,targetKind:s.targetKind,targetId:s.targetId,holdGroup:s.holdGroup,createdAt:now,nextAttemptAt:now});return work.ok?{ok:true,workId:work.item.id,created:work.created}:work;}
export const SCHEDULES_LIST_LIMIT={min:1,max:200,default:100} as const;
export async function listSchedules({store}:Pick<SchedulesDependencies,'store'>,input:{limit?:number}={}){const limit=input.limit??100;if(!Number.isInteger(limit)||limit<1||limit>200)return {ok:false as const,code:'USAGE' as const,message:'목록 한도는 1~200 정수여야 합니다'};const r=await store.listSchedules({limit});return r.ok?{...r,count:r.schedules.length}:r;}
export async function removeSchedule({store,clock}:Pick<SchedulesDependencies,'store'|'clock'>,input:{id:string}){const r=await store.removeSchedule({...input,now:clock.now()});if(!r.ok)return r;return r.removed?{ok:true as const,id:input.id,marked:r.marked}:{ok:false as const,code:'SCHEDULE_NOT_FOUND' as const,message:'지정한 예약이 없습니다'};}
/** Installation keys reserve tombstones and never overwrite user changes. */
export async function ensureSchedule(deps:SchedulesDependencies,input:CreateScheduleInput & {extension:string;scheduleKey:string}):Promise<AddDailyResult>{
 const self=await resolveSelfUser(deps.store);if(!self.ok)return self;const {extension,scheduleKey}=input;
 const existing=await deps.store.findScheduleByKey({extension,scheduleKey,userId:self.userId});if(!existing.ok)return existing;if(existing.schedule)return {ok:true,schedule:existing.schedule};
 const now=deps.clock.now(),t=await trigger(deps,input,now);if(!t.ok)return t;const added=await deps.store.addSchedule({id:deps.idGen.next(),kind:input.kind,targetKind:input.targetKind,targetId:input.targetId,holdGroup:input.holdGroup,...t.value,extension,scheduleKey,userId:self.userId,enabled:true,removedAt:null,triggerUpdatedAt:null,lastRunAt:null,createdAt:now});
 if(!added.ok && added.code==='SCHEDULE_CONFLICT'){const raced=await deps.store.findScheduleByKey({extension,scheduleKey,userId:self.userId});if(!raced.ok)return raced;if(raced.schedule)return {ok:true,schedule:raced.schedule};}return added;
}
export async function ensureDaily(deps:SchedulesDependencies,input:AddDailyInput):Promise<AddDailyResult>{
 return ensureSchedule(deps,{...input,extension:input.kind.split('.')[0]!,scheduleKey:`${input.kind}:${input.targetKind}:${input.targetId}`});
}
