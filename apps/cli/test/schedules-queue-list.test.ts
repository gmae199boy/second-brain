import { cronCalculator } from '../src/runtime/cron.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { isoWithOffset, tickSchedules } from 'second_brain';
import { postgresStore } from 'second_brain/postgres';
import { supervisorFixture } from './supervisor-fixture.js';
import { runPgCommand } from './pg-home.js';
import { withoutHarnessFolders } from './environment.js';
import { HOME_ENV } from '../src/config/paths.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'brain-schedules-list-'));
  const f = await supervisorFixture(home);
  const env = withoutHarnessFolders({ ...process.env, ...f.env, [HOME_ENV]: home });
  const store = postgresStore({ databaseUrl: f.db.appUrl });
  const run = (args: string[], json = true) => runPgCommand(json ? [...args, '--json'] : args, env);
  const add = (targetId = 'daily', at = '11:00') => run(['schedules', 'add', '--kind', 'process_probe', '--target-kind', 'probe', '--target-id', targetId, '--at', at]);
  return { f, store, run, add, async close() { await store.close(); await f.close(); await rm(home, { recursive: true, force: true }); } };
}
it('adds a local schedule and lists it', async () => {
  const k = await fixture();
  try {
    await k.run(['config', 'set', 'timezone', 'America/New_York']);
    const added = await k.add(); expect(added.code).toBe(0);
    const list = await k.run(['schedules', 'list']); expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ data: { schedules: [{ id: JSON.parse(added.stdout).data.id, target_kind: 'probe', target_id: 'daily', local_time: '11:00', time_zone: 'America/New_York', next_run_at: expect.any(String) }] }, meta: { count: 1, has_more: false } });
  } finally { await k.close(); }
});
it('runs a schedule twice into one open work', async () => {
  const k = await fixture();
  try {
    const id = JSON.parse((await k.add()).stdout).data.id;
    const first = JSON.parse((await k.run(['schedules', 'run', id])).stdout);
    const second = JSON.parse((await k.run(['schedules', 'run', id])).stdout);
    expect(first.data).toMatchObject({ schedule_id: id, created: true });
    expect(second.data).toEqual({ ...first.data, created: false });
    expect(JSON.parse((await k.run(['queue', 'list'])).stdout).meta.count).toBe(1);
  } finally { await k.close(); }
});
it('stops firing after remove', async () => {
  const k = await fixture();
  try {
    const id = JSON.parse((await k.add()).stdout).data.id;
    const control = JSON.parse((await k.add('control')).stdout).data.id;
    const schedules = await k.store.listSchedules({ limit: 100 }); if (!schedules.ok) throw new Error(schedules.message);
    const next = schedules.schedules.find(s => s.id === id)!.nextRunAt!;
    expect((await k.run(['schedules', 'remove', id])).code).toBe(0);
    const result = await tickSchedules({ cron: cronCalculator, store: k.store, clock: { now: () => new Date(next.getTime() + 1000) }, idGen: uuidV7IdGen(), readTimeZone: async () => ({ ok: true, value: 'Asia/Seoul' }) });
    expect(result).toMatchObject({ ok: true, fired: 1, enqueued: 1 });
    expect(await tickSchedules({ cron: cronCalculator, store: k.store, clock: { now: () => new Date(next.getTime() + 1000) }, idGen: uuidV7IdGen(), readTimeZone: async () => ({ ok: true, value: 'Asia/Seoul' }) }))
      .toMatchObject({ ok: true, fired: 0, enqueued: 0 });
    const work = await k.store.listWork({ includeClosed: true, limit: 100 }); if (!work.ok) throw new Error(work.message);
    expect(work.entries.map(e => e.item.targetId)).toEqual(['control']);
    expect(await k.store.listOccurrences({scheduleId:control})).toMatchObject({ok:true,occurrences:[{status:'pending'}]});
    expect(await k.store.readSchedule({ id })).toMatchObject({ schedule: null });
  } finally { await k.close(); }
});
it('rejects invalid schedule input with codes', async () => {
  const k = await fixture();
  try {
    const bad = await k.add('bad', '24:00'); expect(bad.code).toBe(1); expect(JSON.parse(bad.stdout).error.code).toBe('SCHEDULE_INVALID');
    const blank = await k.add('  '); expect(blank.code).toBe(1); expect(JSON.parse(blank.stdout).error.code).toBe('SCHEDULE_INVALID');
    await k.add(); const duplicate = await k.add(); expect(duplicate.code).toBe(0);
    for (const verb of ['remove', 'run']) {
      const missing = await k.run(['schedules', verb, uuidV7IdGen().next()]); expect(missing.code).toBe(1); expect(JSON.parse(missing.stdout).error.code).toBe('SCHEDULE_NOT_FOUND');
      const malformed = await k.run(['schedules', verb, 'bad']); expect(malformed.code).toBe(2); expect(JSON.parse(malformed.stdout).error.code).toBe('USAGE');
    }
    for (const ns of ['schedules', 'queue']) expect((await k.run([ns, 'list', '--limit', '0'])).code).toBe(2);
    const missingOption = await k.run(['schedules', 'add', '--kind', 'probe']); expect(missingOption.code).toBe(2);
  } finally { await k.close(); }
});
it('lists a finished probe with state, attempt, elapsed and usage', async () => {
  const k = await fixture();
  try {
    const id = await k.f.enqueueProbe(); const token = uuidV7IdGen().next(); const now = new Date();
    expect(await k.store.claimSupervisedWork({ now, claimedBy: uuidV7IdGen().next(), kinds: ['process_probe'], attemptToken: token })).toMatchObject({ item: { id } });
    await k.store.renewSupervisedLease({ id, attemptToken: token, now, progressAt: now });
    await k.store.finishSupervisedWork({ id, attemptToken: token, now: new Date(now.getTime() + 1500), outcome: 'succeeded', elapsedMs: 1500, usage: { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5 } });
    const list = await k.run(['queue', 'list', '--all']); expect(list.code).toBe(0);
    expect(JSON.parse(list.stdout)).toMatchObject({ data: { items: [{ id, state: 'succeeded', attempts: 1, attempt_outcome: 'succeeded', elapsed_ms: 1500, last_progress_at: expect.any(String), usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 5 } }] } });
    const text = await k.run(['queue', 'list', '--all'], false); expect(text.code).toBe(0);
    expect(text.stdout).toContain(`attempt 결과 succeeded, 마지막 진행 ${isoWithOffset(now)}`);
    expect(JSON.parse((await k.run(['queue', 'list'])).stdout).data.items).toEqual([]);
  } finally { await k.close(); }
});
it('shows the new verbs in guide schema', async () => {
  const k = await fixture();
  try {
    const schema = await k.run(['guide', 'schema']); expect(schema.code).toBe(0);
    const commands = JSON.parse(schema.stdout).data.commands;
    for (const verb of ['add', 'list', 'remove', 'run', 'update']) expect(commands).toContainEqual(expect.objectContaining({ ns: 'schedules', verb }));
    expect(commands).toContainEqual(expect.objectContaining({ ns: 'queue', verb: 'list' }));
    expect(commands.find((c: { ns: string; verb: string }) => c.ns === 'schedules' && c.verb === 'add').required).toEqual(['kind', 'target-kind', 'target-id']);
  } finally { await k.close(); }
});
it('doctor shows model tokens and elapsed time', async () => {
  const k = await fixture();
  try {
    const report = await k.run(['doctor', 'run']); expect(report.code).toBe(0);
    expect(JSON.parse(report.stdout).data.checks).toContainEqual({ id: 'work-model-usage', status: 'ok', detail: '입력 0 토큰, 캐시 0 토큰, 출력 0 토큰, 걸린 시간 0초' });
  } finally { await k.close(); }
});
it('cron·once·legacy 등록과 변경·목록 필드 및 입력 충돌', async () => {
 const k=await fixture();try {
  const base=['schedules','add','--kind','process_probe','--target-kind','probe','--target-id'];
  const cron=await k.run([...base,'weekly','--cron','0 9 * * 5','--tz','Asia/Seoul']);expect(cron.code).toBe(0);const cronId=JSON.parse(cron.stdout).data.id;
  const once=await k.run([...base,'once','--once','2099-01-01T09:00:00+09:00']);expect(once.code).toBe(0);
  const daily=await k.add('daily');expect(daily.code).toBe(0);
  const list=JSON.parse((await k.run(['schedules','list'])).stdout).data.schedules;
  expect(list).toEqual(expect.arrayContaining([expect.objectContaining({id:cronId,trigger_kind:'cron',cron:'0 9 * * 5',run_at:null,time_zone:'Asia/Seoul',time_zone_source:'fixed',schedule_key:null,extension:null,enabled:true,local_time:null}),expect.objectContaining({trigger_kind:'once',run_at:expect.any(String),local_time:null}),expect.objectContaining({target_id:'daily',local_time:'11:00',time_zone_source:'user'})]));
  expect((await k.run(['schedules','update',cronId,'--cron',' 15   8 * * * ','--disable'])).code).toBe(0);
  expect(JSON.parse((await k.run(['schedules','list'])).stdout).data.schedules).toContainEqual(expect.objectContaining({id:cronId,cron:'15 8 * * *',local_time:'08:15',enabled:false}));
  const text=await k.run(['schedules','list'],false);expect(text.stdout).toContain('cron 15 8 * * * (Asia/Seoul)');expect(text.stdout).toContain('once ');expect(text.stdout).toContain('다음 실행');expect(text.stdout).toContain('비활성');
  for(const args of [[...base,'x'],[...base,'x','--cron','0 9 * * *','--at','09:00'],[...base,'x','--once','2099-01-01T00:00:00Z','--tz','UTC'],['schedules','update',cronId],['schedules','update',cronId,'--enable','--disable']]) expect((await k.run(args)).code).toBe(2);
  expect(JSON.parse((await k.run([...base,'bad','--cron','0 9 * *'])).stdout).error.code).toBe('SCHEDULE_INVALID');
  expect(JSON.parse((await k.run(['schedules','remove',cronId])).stdout).data).toMatchObject({id:cronId,marked:false});
 } finally {await k.close();}
});
it('키가 있는 예약 삭제는 표식을 반환하고 다시 만들지 않는다',async()=>{
 const k=await fixture();try {
  const self=await k.store.readSelfUser();if(!self.ok||!self.user)throw Error('self');const now=new Date(),id=uuidV7IdGen().next();
  expect(await k.store.addSchedule({id,kind:'testext.sync',targetKind:'account',targetId:'synthetic',triggerKind:'cron',cronExpr:'0 9 * * *',runAt:null,timeZone:'UTC',timeZoneSource:'fixed',intervalSeconds:null,extension:'testext',scheduleKey:'default',userId:self.user.id,enabled:true,removedAt:null,nextRunAt:new Date(now.getTime()+86400000),lastRunAt:null,createdAt:now})).toMatchObject({ok:true});
  const intervalId=uuidV7IdGen().next();expect(await k.store.addSchedule({id:intervalId,kind:'process_probe',targetKind:'probe',targetId:'interval',triggerKind:'interval',cronExpr:null,runAt:null,timeZone:null,timeZoneSource:null,intervalSeconds:60,extension:null,scheduleKey:null,userId:self.user.id,enabled:true,removedAt:null,nextRunAt:new Date(now.getTime()+86400000),lastRunAt:null,createdAt:now})).toMatchObject({ok:true});
  expect((await k.run(['schedules','list'],false)).stdout).toContain('interval 60초');
  const removed=await k.run(['schedules','remove',id]);expect(JSON.parse(removed.stdout).data).toEqual({id,marked:true});
  expect(await k.store.findScheduleByKey({extension:'testext',scheduleKey:'default',userId:self.user.id})).toMatchObject({ok:true,schedule:{id,enabled:false,removedAt:expect.any(Date)}});
 }finally{await k.close();}
});
