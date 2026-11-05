import type { ExtensionStore, WorkStore, ScheduleStore, UserStore } from '../../ports/store.js';
import { sampleSelfUserInput } from '../fixtures.js';
import { assertEqual, assertOk } from '../assert.js';
import { contractCase, withSubject, type ContractCase } from '../contract.js';

type Store = ExtensionStore & WorkStore & ScheduleStore & UserStore;
export function extensionQuiesceContract(): ContractCase<Store>[] {
  const now = new Date('2026-01-02T03:04:00Z');
  const id = (n: number) => `00000000-0000-7000-8000-${String(n).padStart(12, '0')}`;
  const owner = id(90), other = id(91);
  return [contractCase('quiesce fences fire and claims independently of user holds, waits for current token and respects ownership', async make => withSubject(make, async store => {
    const self = await store.ensureSelfUser(sampleSelfUserInput()); assertOk(self, 'self');
    assertOk(await store.recordExtensionInstall({ name:'testext', version:'1', now, workKinds:['testext.job'] }), 'registry');
    assertOk(await store.recordExtensionInstall({ name:'otherext', version:'1', now, workKinds:['otherext.job'] }), 'other registry');
    const work = (n: number, kind: string, targetId: string) => ({ id:id(n), kind, targetKind:'probe', targetId, createdAt:now, nextAttemptAt:now, holdGroup:'explicit-user' });
    assertOk(await store.addWork(work(1,'testext.job','a')), 'first work');
    const first = await store.claimSupervisedWork({ now, claimedBy:'worker', kinds:['testext.job'], attemptToken:id(20) }); assertOk(first, 'first claim'); assertEqual(first.item?.id,id(1),'active');
    assertOk(await store.addWork(work(2,'testext.job','b')), 'second work');
    assertOk(await store.addWork(work(3,'otherext.job','c')), 'other work');
    const schedule = { id:id(4), kind:'testext.job', holdGroup:'explicit-user', targetKind:'probe', targetId:'d', triggerKind:'cron' as const, cronExpr:'0 9 * * *', runAt:null, triggerUpdatedAt:null, timeZone:'UTC', timeZoneSource:'fixed' as const, intervalSeconds:null, extension:'testext', scheduleKey:'key', userId:self.user.id, enabled:true, removedAt:null, nextRunAt:now, lastRunAt:null, createdAt:now };
    assertOk(await store.addSchedule(schedule),'schedule');
    assertOk(await store.addSchedule({ ...schedule, id:id(6), kind:'legacy_probe', scheduleKey:'legacy', holdGroup:'custom' }),'legacy explicit extension');
    assertEqual(await store.beginExtensionQuiesce({name:'testext',owner,now}),{ok:true,acquired:true},'begin');
    const stopped = await store.getExtensionPublicStatus('testext'); assertOk(stopped,'public quiesce');
    assertEqual(stopped.status.quiesced,true,'quiesced'); assertEqual(JSON.stringify(stopped).includes(owner),false,'owner private');
    assertEqual(await store.beginExtensionQuiesce({name:'testext',owner:other,now}),{ok:true,acquired:false},'foreign owner');
    assertEqual(await store.readExtensionQuiesce('testext'),{ok:true,owner,running:1},'running retained');
    const open = await store.listOpenSupervisedAttempts(); assertOk(open,'open'); assertEqual(open.attempts.find(a=>a.token===id(20))?.held,false,'no forced stop');
    const denied = await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['testext.job'],attemptToken:id(21)}); assertOk(denied,'denied'); assertEqual(denied.item,null,'blocked');
    const otherClaim = await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['otherext.job'],attemptToken:id(22)}); assertOk(otherClaim,'other'); assertEqual(otherClaim.item?.id,id(3),'other unaffected');
    const fire = await store.fireSchedule({scheduleId:id(4),expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:new Date(now.getTime()+60000),now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(5,'testext.job','d')}); assertEqual(fire,{ok:true,fired:false},'no occurrence');
    const legacy = await store.fireSchedule({scheduleId:id(6),expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 9 * * *',expectedNextRunAt:now,nextRunAt:new Date(now.getTime()+60000),now,occurrences:[{occurrenceAt:now,status:'pending'}],work:work(7,'legacy_probe','d')}); assertEqual(legacy,{ok:true,fired:false},'explicit extension blocked');
    assertOk(await store.settleSupervisedAttempt({id:id(1),attemptToken:id(20),now,outcome:'died'}),'settle');
    assertEqual(await store.readExtensionQuiesce('testext'),{ok:true,owner,running:0},'drained');
    assertEqual(await store.endExtensionQuiesce({name:'testext',owner:other}),{ok:true,released:false},'foreign release');
    assertOk(await store.setExtensionEnabled({name:'testext',enabled:false,now}),'user disabled');
    assertOk(await store.holdWorkGroup({group:'extension:testext',now}),'user hold');
    assertEqual(await store.endExtensionQuiesce({name:'testext',owner}),{ok:true,released:true},'release');
    const resumed = await store.getExtensionPublicStatus('testext'); assertOk(resumed,'public recovery'); assertEqual(resumed.status.quiesced,false,'quiesce cleared');
    const status = await store.getExtension('testext'); assertOk(status,'disabled read'); assertEqual(status.extension?.enabled,false,'disabled preserved');
    const held = await store.claimSupervisedWork({now,claimedBy:'worker',kinds:['testext.job'],attemptToken:id(23)}); assertOk(held,'held'); assertEqual(held.item,null,'user hold preserved');
  }))];
}
