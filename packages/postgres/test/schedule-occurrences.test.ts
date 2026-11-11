import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TestDatabase } from '@second-brain/test-db';
import pg from 'pg';
import { afterEach, expect, it } from 'vitest';
import { clock, database } from './fixture.js';
import { ensureSchedule } from '@second-brain/core';
import { fakeCron, sequenceIdGen } from '@second-brain/core/testing';
import { postgresStore, runMigrations } from '../src/index.js';

async function v32() {
  const db = await database(false);
  const migrated = await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 32 });
  if (!migrated.ok) throw new Error(migrated.message);
  const client = new pg.Client({ connectionString: db.url });
  await client.connect();
  return { db, client, async close() { await client.end(); await db.drop(); } };
}

it('32→33은 성공과 미완료 날짜를 회차로 옮기고 수집 데이터를 보존한다', async () => {
  const kit = await v32();
  try {
    const { client, db } = kit;
    const user = randomUUID(), schedule = randomUUID(), work = randomUUID(), session = randomUUID(), message = randomUUID();
    await client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',1,now())", [user]);
    await client.query("insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ($1,'synthetic','session',$2,'test',now(),'import')", [session, user]);
    await client.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ($1,$2,'message','user','synthetic',now())", [message, session]);
    await client.query("insert into brain.schedules(id,kind,target_kind,target_id,local_time,time_zone,next_run_at,created_at) values ($1,'testext.sync','account','a','09:05','Asia/Seoul','2026-01-05T00:05Z',now())", [schedule]);
    await client.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class,schedule_id,local_date_from,local_date_to,local_time_zone,claimed_date_from,claimed_date_to,claimed_at,claim_expires_at,claimed_by) values ($1,'testext.sync','account','a',now(),now(),'core',$2,'2026-01-01','2026-01-04','Asia/Seoul','2026-01-02','2026-01-03',now(),now()+interval '1 hour','worker')", [work, schedule]);
    await client.query("insert into brain.schedule_successes values ($1,'2026-01-02','Asia/Seoul',$2,'2026-01-02T01:00Z')", [schedule, work]);
    const snapshot = async () => {
      const rows = [];
      for (const table of ['sessions', 'messages', 'tool_notes', 'chunks', 'transcript_files', 'message_attachments', 'context_injections', 'files', 'file_locations', 'file_names', 'document_extractions', 'document_chunks'])
        rows.push((await client.query(`select count(*)::int as n, md5(coalesce(string_agg(row_to_json(t)::text, ',' order by row_to_json(t)::text),'')) as hash from brain.${table} t`)).rows[0]);
      return rows;
    };
    const before = await snapshot();
    expect(await runMigrations({ databaseUrl: db.url, clock })).toMatchObject({ ok: true, from: 32, to: 47 });
    expect(await snapshot()).toEqual(before);
    expect((await client.query('select trigger_kind,cron_expr,time_zone,time_zone_source,extension,schedule_key,user_id,enabled from brain.schedules where id=$1', [schedule])).rows[0]).toEqual({ trigger_kind: 'cron', cron_expr: '5 9 * * *', time_zone: 'Asia/Seoul', time_zone_source: 'user', extension: 'testext', schedule_key: 'testext.sync:account:a', user_id: user, enabled: true });
    const rows = (await client.query("select to_char(occurrence_at at time zone 'UTC','YYYY-MM-DD HH24:MI') as at,status,work_id,user_id,time_zone from brain.schedule_occurrences order by occurrence_at")).rows;
    expect(rows).toEqual(['pending', 'done', 'claimed', 'pending'].map((status, i) => ({ at: `2026-01-0${i + 1} 00:05`, status, work_id: work, user_id: user, time_zone: 'Asia/Seoul' })));
    await expect(client.query("insert into brain.schedules(id,kind,target_kind,target_id,trigger_kind,cron_expr,time_zone,time_zone_source,extension,schedule_key,user_id,created_at) values ($1,'testext.sync','account','a','cron','0 9 * * *','UTC','fixed','testext','testext.sync:account:a',$2,now())", [randomUUID(), user])).rejects.toMatchObject({ code: '23505' });
    expect((await client.query("select has_table_privilege('brain_app','brain.schedule_occurrences','SELECT,INSERT,UPDATE,DELETE') as allowed")).rows[0].allowed).toBe(true);
    // A migrated done instant is never linked again when a stale due instant is fired.
    await client.query("update brain.schedules set next_run_at='2026-01-02T00:05Z' where id=$1", [schedule]);
    const store=postgresStore({databaseUrl:db.appUrl});
    try {
      const reused=await ensureSchedule({store,clock,idGen:sequenceIdGen({timestampMs:clock.now().getTime()}),cron:fakeCron,readTimeZone:async()=>({ok:true,value:'Asia/Seoul'})},{extension:'testext',scheduleKey:'testext.sync:account:a',kind:'testext.sync',targetKind:'account',targetId:'a',localTime:'09:05'});
      expect(reused).toMatchObject({ok:true,schedule:{id:schedule}});
      expect((await client.query("select count(*)::int as n from brain.schedules where extension='testext' and schedule_key='testext.sync:account:a'")).rows[0].n).toBe(1);
      const result=await store.fireSchedule({scheduleId:schedule,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:'5 9 * * *',expectedNextRunAt:new Date('2026-01-02T00:05Z'),nextRunAt:new Date('2026-01-03T00:05Z'),now:new Date('2026-01-02T00:05Z'),occurrences:[{occurrenceAt:new Date('2026-01-02T00:05Z'),status:'pending'}],work:{id:randomUUID(),kind:'testext.sync',targetKind:'account',targetId:'a',createdAt:new Date('2026-01-02T00:05Z'),nextAttemptAt:new Date('2026-01-02T00:05Z')}});
      expect(result).toMatchObject({ok:true,fired:true,created:false,covered:true});
      expect((await client.query("select status,work_id from brain.schedule_occurrences where schedule_id=$1 and occurrence_at='2026-01-02T00:05Z'",[schedule])).rows).toEqual([{status:'done',work_id:work}]);
    } finally { await store.close(); }

  } finally { await kit.close(); }
});

it('self가 없는 기존 예약은 USER_MISSING으로 0033 전체가 롤백된다', async () => {
  const kit = await v32();
  try {
    await kit.client.query("insert into brain.schedules(id,kind,target_kind,target_id,interval_seconds,next_run_at,created_at) values ($1,'probe','test','a',60,now(),now())", [randomUUID()]);
    expect(await runMigrations({ databaseUrl: kit.db.url, clock })).toMatchObject({ ok: false, file: '0033_schedule_occurrences.sql', message: expect.stringContaining('USER_MISSING') });
    expect((await kit.client.query("select max(version)::int as version from brain.schema_migrations where owner='core'")).rows[0].version).toBe(32);
    expect((await kit.client.query("select to_regclass('brain.schedule_occurrences') as name")).rows[0].name).toBeNull();
    expect((await kit.client.query("select local_time from brain.schedules")).rowCount).toBe(1);
  } finally { await kit.close(); }
});

it('DST gap은 전환 순간, fold는 첫 instant로 이행한다', async () => {
  const kit = await v32();
  try {
    const user = randomUUID(), gap = randomUUID(), fold = randomUUID(), gapWork = randomUUID(), foldWork = randomUUID();
    await kit.client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',1,now())", [user]);
    for (const [id, time, target] of [[gap, '02:30', 'gap'], [fold, '01:30', 'fold']])
      await kit.client.query("insert into brain.schedules(id,kind,target_kind,target_id,local_time,time_zone,next_run_at,created_at) values ($1,'testext.sync','account',$2,$3,'America/New_York',now(),now())", [id, target, time]);
    for (const [id, schedule, date, target] of [[gapWork, gap, '2026-03-08', 'gap'], [foldWork, fold, '2026-11-01', 'fold']]) {
      await kit.client.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,next_attempt_at,execution_class) values ($1,'testext.sync','account',$2,now(),now(),'core')", [id, target]);
      await kit.client.query("insert into brain.schedule_successes values ($1,$2,'America/New_York',$3,now())", [schedule, date, id]);
    }
    expect(await runMigrations({ databaseUrl: kit.db.url, clock })).toMatchObject({ ok: true, from: 32, to: 47 });
    const rows = (await kit.client.query('select schedule_id,occurrence_at,status from brain.schedule_occurrences order by occurrence_at')).rows;
    expect(rows).toEqual([{ schedule_id: gap, occurrence_at: new Date('2026-03-08T07:00:00Z'), status: 'done' }, { schedule_id: fold, occurrence_at: new Date('2026-11-01T05:30:00Z'), status: 'done' }]);
  } finally { await kit.close(); }
});

// Historical v9 contract stays pinned below 0033 while the current store uses occurrences.
const legacyDatabases: TestDatabase[] = []; const folders: string[] = [];
afterEach(async () => { await Promise.all([...legacyDatabases.splice(0).map(db => db.drop()), ...folders.splice(0).map(dir => rm(dir,{recursive:true,force:true}))]); });
async function fresh() { const db=await database(false); legacyDatabases.push(db); return db; }
it('preserves v8 schedules and enforces v9 work dates and schedule deletion rules', async () => {
  const db = await fresh();
  const directory = await mkdtemp(join(tmpdir(), 'brain-migrations-v8-')); folders.push(directory);
  for (const file of (await readdir(new URL('../migrations/', import.meta.url))).filter(file => /^000[1-8]_.*\.sql$/.test(file)))
    await copyFile(new URL(`../migrations/${file}`, import.meta.url), join(directory, file));
  expect(await runMigrations({ databaseUrl: db.url, clock, owners: [{ owner: 'core', directory }] })).toMatchObject({ ok: true, to: 8 });
  const interval = '01940000-0000-7000-8000-000000000001';
  const once = '01940000-0000-7000-8000-000000000002';
  const workId = '01940000-0000-7000-8000-000000000003';
  await db.query(`insert into brain.schedules(id,kind,target_kind,target_id,interval_seconds,next_run_at,last_run_at,created_at) values
    ('${interval}','upgrade_probe','probe','interval',60,'2026-10-29T02:00:00Z','2026-10-29T01:59:00Z','2026-10-01T00:00:00Z'),
    ('${once}','upgrade_probe','probe','once',null,null,'2026-10-28T02:00:00Z','2026-10-01T00:00:00Z')`);
  await db.query(`insert into brain.work_items(id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome,execution_class)
    values ('${workId}','upgrade_probe','probe','once','2026-10-28T02:00:00Z',1,'2026-10-28T02:00:00Z','2026-10-28T02:01:00Z','succeeded','core')`);
  const columns = 'id,kind,target_kind,target_id,interval_seconds,next_run_at,last_run_at,created_at';
  const schedulesBefore = await db.rows(`select ${columns} from brain.schedules order by id`);
  const workColumns = 'id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome';
  const workBefore = await db.rows(`select ${workColumns} from brain.work_items`);
  expect(await runMigrations({ databaseUrl: db.url, clock, coreMaxVersion: 32 })).toMatchObject({ ok: true, from: 8, to: 32, applied: ['0009_local_schedules.sql', '0010_work_hold_groups.sql', '0011_extension_registry.sql', '0012_extension_work_kinds.sql', '0013_extension_python_environment.sql', '0014_conversation_chunks.sql', '0015_extension_status_public.sql', '0016_extension_install_progress.sql', '0017_channels.sql', '0018_channel_attempt_results.sql', '0019_channel_legacy.sql', '0020_channel_bundle.sql', '0021_channel_attempt_order.sql', '0022_import_contracts.sql', '0023_health_contract.sql', '0024_health_authority_import.sql', '0025_original_text.sql', '0026_health_json_comparison.sql', '0027_analysis_artifacts.sql', '0028_file_request_metadata.sql', '0029_core_analyses.sql', '0030_analysis_snapshot_inputs.sql', '0031_remove_core_garmin.sql', '0032_user_keys.sql'] });
  expect(await db.rows(`select ${columns} from brain.schedules order by id`)).toEqual(schedulesBefore);
  expect(await db.rows(`select ${workColumns} from brain.work_items`)).toEqual(workBefore);
  expect(await db.rows('select local_time,time_zone from brain.schedules')).toEqual([
    { local_time: null, time_zone: null }, { local_time: null, time_zone: null },
  ]);
  expect(await db.rows('select schedule_id,local_date_from,local_date_to,local_time_zone,claimed_date_from,claimed_date_to from brain.work_items'))
    .toEqual([{ schedule_id: null, local_date_from: null, local_date_to: null, local_time_zone: null, claimed_date_from: null, claimed_date_to: null }]);
  for (const [change, constraint] of [
    ["local_date_from='2026-10-01'", 'work_local_dates_shape'],
    ["local_date_to='2026-10-01'", 'work_local_dates_shape'],
    ["local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["local_date_from='2026-10-01',local_date_to='2026-10-02'", 'work_local_dates_shape'],
    ["local_date_from='2026-10-01',local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["local_date_to='2026-10-01',local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["local_date_from='2026-10-02',local_date_to='2026-10-01',local_time_zone='Asia/Seoul'", 'work_local_dates_shape'],
    ["claimed_date_from='2026-10-01'", 'work_claimed_dates_shape'],
    ["claimed_date_to='2026-10-01'", 'work_claimed_dates_shape'],
    ["claimed_date_from='2026-10-02',claimed_date_to='2026-10-01'", 'work_claimed_dates_shape'],
  ]) await expect(db.query(`update brain.work_items set ${change} where id='${workId}'`)).rejects.toMatchObject({ code: '23514', constraint });
  await db.query(`update brain.work_items set schedule_id='${once}',local_date_from='2026-10-01',local_date_to='2026-10-02',local_time_zone='Asia/Seoul',
    claimed_date_from='2026-10-01',claimed_date_to='2026-10-02' where id='${workId}'`);
  await db.query(`insert into brain.schedule_successes(schedule_id,local_date,time_zone,work_id,recorded_at)
    values ('${once}','2026-10-01','Asia/Seoul','${workId}','2026-10-28T02:01:00Z')`);
  expect(await db.rows('select work_id from brain.schedule_successes')).toEqual([{ work_id: workId }]);
  await db.query(`delete from brain.schedules where id='${once}'`);
  expect(await db.rows('select schedule_id,local_date_from::text,local_date_to::text,local_time_zone from brain.work_items'))
    .toEqual([{ schedule_id: null, local_date_from: '2026-10-01', local_date_to: '2026-10-02', local_time_zone: 'Asia/Seoul' }]);
  expect(await db.rows(`select ${workColumns} from brain.work_items`)).toEqual(workBefore);
  expect(await db.rows('select * from brain.schedule_successes')).toEqual([]);
  expect(await db.rows(`select ${columns} from brain.schedules`)).toEqual([schedulesBefore[0]]);
});
it('같은 확장 대상의 daily·interval·once와 완료 once fallback을 이행한다',async()=>{
 const kit=await v32();try {
  const user=randomUUID(),daily=randomUUID(),interval=randomUUID(),onceLast=randomUUID(),onceCreated=randomUUID();
  await kit.client.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',1,now())",[user]);
  await kit.client.query("insert into brain.schedules(id,kind,target_kind,target_id,local_time,time_zone,interval_seconds,next_run_at,last_run_at,created_at) values ($1,'testext.sync','account','same','09:00','UTC',null,'2026-01-02T09:00Z',null,'2026-01-01T00:00Z'),($2,'testext.sync','account','same',null,null,60,'2026-01-02T09:00Z',null,'2026-01-01T00:00Z'),($3,'testext.sync','account','same',null,null,null,null,'2026-01-02T08:00Z','2026-01-01T00:00Z'),($4,'testext.sync','account','same',null,null,null,null,null,'2026-01-01T00:00Z')",[daily,interval,onceLast,onceCreated]);
  expect(await runMigrations({databaseUrl:kit.db.url,clock})).toMatchObject({ok:true,from:32,to:47});
  const rows=(await kit.client.query('select id,trigger_kind,schedule_key,run_at,next_run_at from brain.schedules')).rows;
  expect(rows.find(r=>r.id===daily)).toMatchObject({trigger_kind:'cron',schedule_key:'testext.sync:account:same'});
  expect(rows.find(r=>r.id===interval)).toMatchObject({trigger_kind:'interval',schedule_key:`testext.sync:account:same:${interval}`});
  expect(rows.find(r=>r.id===onceLast)).toMatchObject({trigger_kind:'once',schedule_key:`testext.sync:account:same:${onceLast}`,run_at:new Date('2026-01-02T08:00:00Z'),next_run_at:null});
  expect(rows.find(r=>r.id===onceCreated)).toMatchObject({trigger_kind:'once',schedule_key:`testext.sync:account:same:${onceCreated}`,run_at:new Date('2026-01-01T00:00:00Z'),next_run_at:null});
 }finally{await kit.close();}
});

it('freezes the selected user target at firing and preserves a due occurrence until configured', async () => {
  const db = await database();
  const store = postgresStore({databaseUrl:db.appUrl});
  const user=randomUUID(), other=randomUUID(), scheduleId=randomUUID();
  const due=new Date('2026-10-28T01:00:00Z'), next=new Date('2026-10-29T01:00:00Z');
  const fire = (id:string, at:Date, following:Date) => store.fireSchedule({scheduleId,expectedTriggerKind:'cron',expectedTimeZone:'UTC',expectedCronExpr:'0 1 * * *',expectedNextRunAt:at,nextRunAt:following,now:at,occurrences:[{occurrenceAt:at,status:'pending'}],work:{id,kind:'testext.sync',targetKind:'account',targetId:'unselected',createdAt:at,nextAttemptAt:at}});
  try {
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,now()),('${other}','other',0,now())`);
    const inserted=await store.addSchedule({id:scheduleId,kind:'testext.sync',targetKind:'account',targetId:'unselected',targetSetting:'testext.account',triggerKind:'cron',cronExpr:'0 1 * * *',runAt:null,timeZone:'UTC',timeZoneSource:'fixed',intervalSeconds:null,extension:'testext',scheduleKey:'daily',userId:user,enabled:true,removedAt:null,nextRunAt:due,lastRunAt:null,createdAt:due});
    expect(inserted).toMatchObject({ok:true,schedule:{targetSetting:'testext.account'}});
    await store.setSetting({userId:other,key:'testext.account',value:'other-target',updatedAt:due});
    expect(await fire(randomUUID(),due,next)).toMatchObject({ok:true,fired:false});
    expect((await store.readSchedule({id:scheduleId}))).toMatchObject({ok:true,schedule:{nextRunAt:due}});
    expect((await store.listOccurrences({scheduleId}))).toMatchObject({ok:true,occurrences:[]});
    await store.setSetting({userId:user,key:'testext.account',value:'   ',updatedAt:due});
    expect(await fire(randomUUID(),due,next)).toMatchObject({ok:true,fired:false});
    await store.setSetting({userId:user,key:'testext.account',value:'account-a',updatedAt:due});
    const first=randomUUID(); expect(await fire(first,due,next)).toMatchObject({ok:true,fired:true,created:true});
    await store.setSetting({userId:user,key:'testext.account',value:'account-b',updatedAt:due});
    const later=new Date('2026-10-30T01:00:00Z'), second=randomUUID();
    expect(await fire(second,next,later)).toMatchObject({ok:true,fired:true,created:true});
    expect(await db.rows(`select target_id from brain.work_items where id in ('${first}','${second}') order by target_id`)).toEqual([{target_id:'account-a'},{target_id:'account-b'}]);
    expect((await store.listOccurrences({scheduleId}))).toMatchObject({ok:true,occurrences:[{workId:first},{workId:second}]});
  } finally { await store.close(); await db.drop(); }
});

it('gates dependent occurrences by user, target and local date, recovers late success and skips stale pending', async () => {
  const db=await database(), store=postgresStore({databaseUrl:db.appUrl});
  const user=randomUUID(), other=randomUUID(), parent=randomUUID(), child=randomUUID(), unrelated=randomUUID();
  const at=new Date('2026-10-28T02:00:00Z'), next=new Date('2026-10-29T02:00:00Z'), next2=new Date('2026-10-30T02:00:00Z');
  try {
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','self',1,now()),('${other}','other',0,now());
      insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','1',now(),true,now());
      insert into brain.extension_work_kinds(extension_name,kind) values ('testext','testext.collect'),('testext','testext.report'),('testext','testext.other')`);
    const make=async(id:string,kind:string,key:string,afterSchedule?:string)=>store.addSchedule({id,kind,targetKind:'account',targetId:'a',...(afterSchedule?{afterSchedule}:{}),triggerKind:'cron',cronExpr:'0 11 * * *',runAt:null,timeZone:'Asia/Seoul',timeZoneSource:'fixed',intervalSeconds:null,extension:'testext',scheduleKey:key,userId:user,enabled:true,removedAt:null,nextRunAt:at,lastRunAt:null,createdAt:at});
    expect(await make(parent,'testext.collect','collect')).toMatchObject({ok:true});
    expect(await make(child,'testext.report','report','collect')).toMatchObject({ok:true});
    const fire=async(scheduleId:string,kind:string,atDate:Date,following:Date,id:string)=>store.fireSchedule({scheduleId,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:'0 11 * * *',expectedNextRunAt:atDate,nextRunAt:following,now:atDate,occurrences:[{occurrenceAt:atDate,status:'pending'}],work:{id,kind,targetKind:'account',targetId:'a',createdAt:atDate,nextAttemptAt:atDate}});
    const childWork=randomUUID();expect(await fire(child,'testext.report',at,next,childWork)).toMatchObject({ok:true,created:true});
    await store.addWork({id:unrelated,kind:'testext.other',targetKind:'account',targetId:'a',createdAt:at,nextAttemptAt:at});
    const claim=async(kinds:string[])=>store.claimSupervisedWork({kinds,now:next,claimedBy:'worker',attemptToken:randomUUID()});
    expect(await claim(['testext.report','testext.other'])).toMatchObject({ok:true,item:{id:unrelated}});
    expect(await claim(['testext.report'])).toMatchObject({ok:true,item:null});
    const wrongWork=randomUUID();
    await db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,completed_at,outcome) values ('${wrongWork}','testext.collect','supervised','account','other',now(),now(),now(),'succeeded');
      insert into brain.schedule_occurrences(schedule_id,occurrence_at,time_zone,status,work_id,user_id,recorded_at) values ('${parent}','2026-10-28T02:00Z','Asia/Seoul','done','${wrongWork}','${user}',now())`);
    expect(await claim(['testext.report'])).toMatchObject({ok:true,item:null});
    await fire(child,'testext.report',next,next2,randomUUID());
    expect(await store.listOccurrences({scheduleId:child})).toMatchObject({ok:true,occurrences:[{status:'skipped'},{status:'pending'}]});
    const foreignSchedule=randomUUID(), foreignWork=randomUUID();
    await db.query(`insert into brain.schedules(id,kind,target_kind,target_id,trigger_kind,cron_expr,time_zone,time_zone_source,extension,schedule_key,user_id,created_at) values ('${foreignSchedule}','testext.collect','account','a','cron','0 11 * * *','Asia/Seoul','fixed','testext','collect','${other}',now());
      insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,completed_at,outcome) values ('${foreignWork}','testext.collect','supervised','account','a',now(),now(),now(),'succeeded');
      insert into brain.schedule_occurrences(schedule_id,occurrence_at,time_zone,status,work_id,user_id,recorded_at) values ('${foreignSchedule}','2026-10-29T02:00Z','Asia/Seoul','done','${foreignWork}','${other}',now())`);
    expect(await claim(['testext.report'])).toMatchObject({ok:true,item:null});
    // The manually seeded previous-day occurrence represents a firing; advance its schedule as well.
    await db.query(`update brain.schedules set next_run_at='2026-10-29T02:00Z' where id='${parent}'`);
    const laterWork=randomUUID();expect(await fire(parent,'testext.collect',next,next2,laterWork)).toMatchObject({ok:true,fired:true,created:true});
    expect(await db.rows(`select next_attempt_at from brain.work_items where id='${laterWork}'`)).toEqual([{next_attempt_at:next}]);
    await db.query(`update brain.schedule_occurrences set status='failed' where schedule_id='${parent}' and occurrence_at='2026-10-29T02:00Z'`);
    expect(await claim(['testext.report'])).toMatchObject({ok:true,item:null});
    const cancelledWork=randomUUID();
    await db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,completed_at,outcome) values ('${cancelledWork}','testext.collect','supervised','account','a','${next.toISOString()}','${next.toISOString()}','${next.toISOString()}','cancelled'); update brain.schedule_occurrences set work_id='${cancelledWork}' where schedule_id='${parent}' and occurrence_at='2026-10-29T02:00Z'`);
    expect(await claim(['testext.report'])).toMatchObject({ok:true,item:null});
    await db.query(`update brain.schedule_occurrences set status='pending',work_id='${laterWork}' where schedule_id='${parent}' and occurrence_at='2026-10-29T02:00Z'`);
    const parentToken=randomUUID();
    expect(await store.claimSupervisedWork({kinds:['testext.collect'],now:next,claimedBy:'parent',attemptToken:parentToken})).toMatchObject({ok:true,item:{id:laterWork,currentAttemptToken:parentToken,scheduledOccurrences:[{scheduleId:parent,occurrences:[next]}]}});
    expect(await store.finishSupervisedWork({id:laterWork,attemptToken:parentToken,now:next,outcome:'succeeded'})).toMatchObject({ok:true,outcome:'done'});
    expect(await store.listOccurrences({scheduleId:parent})).toMatchObject({ok:true,occurrences:[{status:'done'},{status:'done',workId:laterWork}]});
    const restarted=postgresStore({databaseUrl:db.appUrl});
    try {
      const token=randomUUID(); const eligible=await restarted.claimSupervisedWork({kinds:['testext.report'],now:next,claimedBy:'restart',attemptToken:token});
      expect(eligible).toMatchObject({ok:true,item:{id:childWork,scheduledOccurrences:[{scheduleId:child,occurrences:[next]}]}});
      expect(await restarted.claimSupervisedWork({kinds:['testext.report'],now:next,claimedBy:'restart',attemptToken:randomUUID()})).toMatchObject({ok:true,item:null});
      expect(await restarted.finishSupervisedWork({id:childWork,attemptToken:token,now:next,outcome:'succeeded'})).toMatchObject({ok:true,outcome:'done'});
      const duplicate=new Date('2026-10-29T03:00:00Z');
      await db.query(`update brain.schedules set next_run_at='2026-10-29T03:00Z' where id='${child}'`);
      expect(await fire(child,'testext.report',duplicate,next2,randomUUID())).toMatchObject({ok:true,fired:true,created:false,covered:true});
      expect((await store.listOccurrences({scheduleId:child}))).toMatchObject({ok:true,occurrences:[{status:'skipped'},{status:'done'},{status:'skipped'}]});
    } finally {await restarted.close();}
  } finally {await store.close();await db.drop();}
});

it('latest prerequisite coalesces accumulated pending days to one claimed occurrence', async () => {
  const db=await database(), store=postgresStore({databaseUrl:db.appUrl});
  const user=randomUUID(), scheduleId=randomUUID(), workId=randomUUID(), at=new Date('2026-10-28T02:00:00Z'), next=new Date('2026-10-29T02:00:00Z'), later=new Date('2026-10-30T02:00:00Z');
  try {
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,now()); insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','1',now(),true,now()); insert into brain.extension_work_kinds(extension_name,kind,missed_policy) values ('testext','testext.collect','latest')`);
    await store.addSchedule({id:scheduleId,kind:'testext.collect',targetKind:'account',targetId:'a',triggerKind:'cron',cronExpr:'0 11 * * *',runAt:null,timeZone:'Asia/Seoul',timeZoneSource:'fixed',intervalSeconds:null,extension:'testext',scheduleKey:'collect',userId:user,enabled:true,removedAt:null,nextRunAt:at,lastRunAt:null,createdAt:at});
    const fire=(date:Date,following:Date,id:string)=>store.fireSchedule({scheduleId,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:'0 11 * * *',expectedNextRunAt:date,nextRunAt:following,now:date,occurrences:[{occurrenceAt:date,status:'pending'}],work:{id,kind:'testext.collect',targetKind:'account',targetId:'a',createdAt:date,nextAttemptAt:date}});
    expect(await fire(at,next,workId)).toMatchObject({ok:true,created:true});
    expect(await fire(next,later,randomUUID())).toMatchObject({ok:true,created:false});
    expect(await store.listOccurrences({scheduleId})).toMatchObject({ok:true,occurrences:[{status:'skipped'},{status:'pending'}]});
    const claimed=await store.claimSupervisedWork({kinds:['testext.collect'],now:next,claimedBy:'worker',attemptToken:randomUUID()});
    expect(claimed).toMatchObject({ok:true,item:{id:workId,scheduledOccurrences:[{scheduleId,occurrences:[next]}]}});
  } finally {await store.close();await db.drop();}
});

it('concurrent firing and completion serialize without deadlock and deduplicate the local day', async () => {
  const db=await database(), store=postgresStore({databaseUrl:db.appUrl});
  const user=randomUUID(), parent=randomUUID(), child=randomUUID(), prerequisite=randomUUID(), work=randomUUID(), token=randomUUID();
  const at=new Date('2026-10-28T02:00:00Z'), duplicate=new Date('2026-10-28T03:00:00Z'), next=new Date('2026-10-29T02:00:00Z');
  try {
    await db.query(`insert into brain.users(id,name,is_self,created_at) values ('${user}','synthetic',1,now());
      insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ('testext','1',now(),true,now());
      insert into brain.extension_work_kinds(extension_name,kind) values ('testext','testext.collect'),('testext','testext.report')`);
    const make=(id:string,kind:string,key:string,afterSchedule?:string)=>store.addSchedule({id,kind,targetKind:'account',targetId:'a',...(afterSchedule?{afterSchedule}:{}),triggerKind:'cron',cronExpr:'0 11 * * *',runAt:null,timeZone:'Asia/Seoul',timeZoneSource:'fixed',intervalSeconds:null,extension:'testext',scheduleKey:key,userId:user,enabled:true,removedAt:null,nextRunAt:at,lastRunAt:null,createdAt:at});
    expect(await make(parent,'testext.collect','collect')).toMatchObject({ok:true});
    expect(await make(child,'testext.report','report','collect')).toMatchObject({ok:true});
    await db.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,next_attempt_at,completed_at,outcome) values ('${prerequisite}','testext.collect','supervised','account','a',now(),now(),now(),'succeeded');
      insert into brain.schedule_occurrences(schedule_id,occurrence_at,time_zone,status,work_id,user_id,recorded_at) values ('${parent}','${at.toISOString()}','Asia/Seoul','done','${prerequisite}','${user}',now())`);
    const fire=(when:Date, following:Date, id:string)=>store.fireSchedule({scheduleId:child,expectedTriggerKind:'cron',expectedTimeZone:'Asia/Seoul',expectedCronExpr:'0 11 * * *',expectedNextRunAt:when,nextRunAt:following,now:when,occurrences:[{occurrenceAt:when,status:'pending'}],work:{id,kind:'testext.report',targetKind:'account',targetId:'a',createdAt:when,nextAttemptAt:when}});
    expect(await fire(at,duplicate,work)).toMatchObject({ok:true,created:true});
    expect(await store.claimSupervisedWork({kinds:['testext.report'],now:duplicate,claimedBy:'worker',attemptToken:token})).toMatchObject({ok:true,item:{id:work}});
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const results=await Promise.race([
        Promise.all([fire(duplicate,next,randomUUID()),store.finishSupervisedWork({id:work,attemptToken:token,now:duplicate,outcome:'succeeded'})]),
        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('concurrent schedule operations timed out')),10000);}),
      ]);
      expect(results[0]).toMatchObject({ok:true,fired:true});
      expect(results[1]).toMatchObject({ok:true,outcome:'done'});
    } finally { if (timer) clearTimeout(timer); }
    const rows=await store.listOccurrences({scheduleId:child});
    expect(rows).toMatchObject({ok:true,occurrences:[{status:'done',workId:work},{status:'skipped'}]});
    expect((await db.rows(`select count(*)::int n from brain.work_items where kind='testext.report' and completed_at is null`))[0]?.n).toBe(0);
  } finally {await store.close();await db.drop();}
});
