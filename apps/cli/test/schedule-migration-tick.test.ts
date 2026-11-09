import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { tickSchedules } from 'second_brain';
import { sequenceIdGen } from 'second_brain/testing';
import { postgresStore, runMigrations } from 'second_brain/postgres';
import { database, clock } from '../../../packages/postgres/test/fixture.js';
import { cronCalculator } from '../src/runtime/cron.js';

it('32 이행된 성공 회차는 같은 날 실제 tick을 반복해도 재발화하지 않는다',async()=>{
 const db=await database(false);try{
  expect(await runMigrations({databaseUrl:db.url,clock,coreMaxVersion:32})).toMatchObject({ok:true});
  const user=randomUUID(),schedule=randomUUID(),work=randomUUID();
  await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,'2026-01-01T00:00Z');
   insert into brain.schedules(id,kind,target_kind,target_id,local_time,time_zone,next_run_at,created_at) values ('${schedule}','testext.sync','account','a','09:05','Asia/Seoul','2026-01-02T00:05Z','2026-01-01T00:00Z');
   insert into brain.work_items(id,kind,target_kind,target_id,execution_class,created_at,next_attempt_at,schedule_id,local_date_from,local_date_to,local_time_zone) values ('${work}','testext.sync','account','a','core','2026-01-01T00:00Z','2026-01-01T00:00Z','${schedule}','2026-01-02','2026-01-02','Asia/Seoul');
   insert into brain.schedule_successes values ('${schedule}','2026-01-02','Asia/Seoul','${work}','2026-01-02T00:05Z')`);
  expect(await runMigrations({databaseUrl:db.url,clock})).toMatchObject({ok:true,from:32,to:44});
  const store=postgresStore({databaseUrl:db.appUrl});try{
   const fakeClock={now:()=>new Date('2026-01-02T00:05:00.000Z')}, idGen=sequenceIdGen({timestampMs:fakeClock.now().getTime()});
   const deps={store,clock:fakeClock,idGen,cron:cronCalculator,readTimeZone:async()=>({ok:true as const,value:'Asia/Seoul'})};
   expect(await tickSchedules(deps)).toMatchObject({ok:true,fired:1,enqueued:0});expect(await tickSchedules(deps)).toMatchObject({ok:true,fired:0,enqueued:0});
   expect(await store.listOccurrences({scheduleId:schedule})).toMatchObject({ok:true,occurrences:[{status:'done',workId:work}]});
   expect(await store.readSchedule({id:schedule})).toMatchObject({ok:true,schedule:{nextRunAt:new Date('2026-01-03T00:05:00.000Z')}});
  }finally{await store.close();}
 }finally{await db.drop();}
});
