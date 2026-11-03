import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { provisionExtension, postgresStore } from '../src/index.js';
import { database, clock } from './fixture.js';

it('binds a followup to its successful predecessor and prior local-day result', async () => {
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`, role=`brain_ext_${name}`, password=randomBytes(24).toString('hex');
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  let ext: pg.Client | undefined;
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    expect(await store.recordExtensionInstall({name,version:'1',now:clock.now(),workKinds:[`${name}.collect`,`${name}.artifacts`],workFollowups:{[`${name}.collect`]:`${name}.artifacts`}})).toMatchObject({ok:true});
    const url=new URL(db.url); url.username=role; url.password=password; ext=new pg.Client({connectionString:url.toString()}); await ext.connect();
    const make=async (day:string, offset:number, cutoff:number=offset) => {
      const id=randomUUID(),token=randomUUID(),now=new Date(clock.now().getTime()+offset);
      expect(await store.addWork({id,kind:`${name}.collect`,targetKind:'account',targetId:'synthetic',createdAt:now,nextAttemptAt:now})).toMatchObject({ok:true});
      expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:[`${name}.collect`],attemptToken:token})).toMatchObject({ok:true,item:{id}});
      const resultSummary={status:'success',local_date:day,cutoff_ms:cutoff};
      expect(await store.finishSupervisedWork({id,attemptToken:token,now,outcome:'succeeded',resultSummary})).toMatchObject({ok:true,outcome:'done'});
      const child=(await admin.query('select work_item_id from brain.work_dependencies where prerequisite_id=$1',[id])).rows[0].work_item_id as string;
      return {id,child,resultSummary};
    };
    const laterQueued=await make('2026-01-01',1500,1000);
    await admin.query("update brain.work_items set next_attempt_at='2100-01-01' where id=$1",[laterQueued.child]);
    const previous=await make('2026-01-01',1000,2000);
    await admin.query("update brain.work_items set next_attempt_at='2100-01-01' where id=$1",[previous.child]);
    const future=await make('2026-01-01',2500,4000);
    await admin.query("update brain.work_items set next_attempt_at='2100-01-01' where id=$1",[future.child]);
    const current=await make('2026-01-02',3000), token=randomUUID(), now=new Date(clock.now().getTime()+3000);
    expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:[`${name}.artifacts`],attemptToken:token})).toMatchObject({ok:true,item:{id:current.child}});
    const rows=(await ext.query('select id,result_summary,previous_result from brain.extension_predecessor_results($1,$2)',[current.child,token])).rows;
    expect(rows).toEqual([{id:current.id,result_summary:current.resultSummary,previous_result:previous.resultSummary}]);
    const late=await make('2026-01-01',3500,2500);
    await admin.query("update brain.work_items set next_attempt_at='2100-01-01' where id=$1",[late.child]);
    expect((await ext.query('select id,result_summary,previous_result from brain.extension_predecessor_results($1,$2)',[current.child,token])).rows).toEqual(rows);
    const other=`${name}other`;
    expect(await store.recordExtensionInstall({name:other,version:'1',now:clock.now(),workKinds:[`${other}.collect`]})).toMatchObject({ok:true});
    const foreign=randomUUID(), foreignToken=randomUUID();
    await admin.query(`insert into brain.work_items(id,kind,execution_class,target_kind,target_id,created_at,attempts,next_attempt_at,completed_at,outcome) values($1,$2,'supervised','account','synthetic',now(),1,now(),now(),'succeeded')`,[foreign,`${other}.collect`]);
    await admin.query(`insert into brain.work_attempts(token,work_item_id,started_at,finished_at,outcome,result_summary) values($1,$2,now(),now(),'succeeded','{"status":"success"}')`,[foreignToken,foreign]);
    await admin.query('insert into brain.work_dependencies(work_item_id,prerequisite_id) values($1,$2)',[current.child,foreign]);
    expect((await ext.query('select id,result_summary,previous_result from brain.extension_predecessor_results($1,$2)',[current.child,token])).rows).toEqual(rows);
    await expect(ext.query('select * from brain.extension_predecessor_results($1,$2)',[current.child,randomUUID()])).rejects.toMatchObject({code:'BRS01'});
  } finally {
    await ext?.end(); await store.close();
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{});
    await admin.end(); await db.drop();
  }
});

it('backfills one dependent for a pending parent when followups are installed', async () => {
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`;
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  try {
    await admin.connect();
    const kinds=[`${name}.collect`,`${name}.artifacts`], now=clock.now(), id=randomUUID();
    expect(await store.recordExtensionInstall({name,version:'1',now,workKinds:kinds})).toMatchObject({ok:true});
    const input={id,kind:kinds[0]!,targetKind:'account',targetId:'synthetic',createdAt:now,nextAttemptAt:now};
    expect(await store.addWork(input)).toMatchObject({ok:true,created:true});
    const upgraded={name,version:'2',now,workKinds:kinds,workFollowups:{[kinds[0]!]:kinds[1]!}};
    expect(await store.recordExtensionInstall(upgraded)).toMatchObject({ok:true});
    expect(await store.recordExtensionInstall(upgraded)).toMatchObject({ok:true});
    expect(await store.addWork({...input,id:randomUUID()})).toMatchObject({ok:true,created:false});
    const children=(await admin.query('select w.id,w.kind from brain.work_items w join brain.work_dependencies d on d.work_item_id=w.id where d.prerequisite_id=$1',[id])).rows;
    expect(children).toHaveLength(1); expect(children[0].kind).toBe(kinds[1]);
    const token=randomUUID();
    expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:[kinds[1]!],attemptToken:token})).toMatchObject({ok:true,item:null});
    expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:[kinds[0]!],attemptToken:token})).toMatchObject({ok:true,item:{id}});
    expect(await store.finishSupervisedWork({id,attemptToken:token,now,outcome:'succeeded'})).toMatchObject({ok:true});
    expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:[kinds[1]!],attemptToken:randomUUID()})).toMatchObject({ok:true,item:{id:children[0].id}});
  } finally { await store.close(); await admin.end(); await db.drop(); }
});
