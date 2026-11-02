import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { isolatedClusterDatabase } from './isolated-cluster.js';
import { prepareProtectedRoles } from '../src/protected-roles.js';
import { postgresQueueHostFence } from '../src/protected-queue-host.js';

it('보호 queue host fence는 충돌·crash·불명 종료 뒤 자동 재시작을 막는다',async()=>{
  const db=await isolatedClusterDatabase();const admin=new pg.Client({connectionString:db.url});const other=new pg.Client({connectionString:db.url});const app=new pg.Client({connectionString:db.appUrl});
  try {
    await Promise.all([admin.connect(),other.connect(),app.connect()]);await prepareProtectedRoles(db.url);
    const sql=await readFile(new URL('../protected-migrations/0032_protected_queue_host_fence.sql',import.meta.url),'utf8');
    await admin.query('set role brain_owner');await admin.query(sql);await admin.query('reset role');
    await expect(app.query('select brain.begin_queue_host($1)',[randomUUID()])).rejects.toMatchObject({code:'42501'});
    await admin.query('set session authorization brain_protected_supervisor');await other.query('set session authorization brain_protected_supervisor');
    const first=randomUUID(),second=randomUUID();
    const attempts=await Promise.all([admin.query('select brain.begin_queue_host($1) as ok',[first]),other.query('select brain.begin_queue_host($1) as ok',[second])]);
    expect(attempts.map(x=>x.rows[0].ok).sort()).toEqual([false,true]);
    const winner=attempts[0]!.rows[0].ok?first:second;
    expect((await admin.query('select brain.begin_queue_host($1) as ok',[randomUUID()])).rows[0].ok).toBe(false);
    expect((await admin.query('select brain.settle_queue_host($1,true) as ok',[winner])).rows[0].ok).toBe(true);
    const next=randomUUID();expect((await other.query('select brain.begin_queue_host($1) as ok',[next])).rows[0].ok).toBe(true);
    expect((await admin.query('select brain.settle_queue_host($1,false) as ok',[next])).rows[0].ok).toBe(true);
    expect((await admin.query('select brain.settle_queue_host($1,true) as ok',[next])).rows[0].ok).toBe(false);
    expect((await other.query('select brain.begin_queue_host($1) as ok',[randomUUID()])).rows[0].ok).toBe(false);
    await admin.query('reset session authorization');
    expect((await admin.query('select state from brain.protected_queue_host_fence')).rows).toEqual([{state:'unknown'}]);
    // 격리 DB에서만 불명 fixture를 제거하고 실제 보호 role adapter의 재연결을 확인한다.
    await admin.query('delete from brain.protected_queue_host_fence');
    await admin.query("alter role brain_protected_supervisor login password 'fixture-queue-host'");
    const protectedUrl=new URL(db.url);protectedUrl.username='brain_protected_supervisor';protectedUrl.password='fixture-queue-host';
    let adapter=postgresQueueHostFence({databaseUrl:protectedUrl.toString()});const live=randomUUID();
    try {
      expect(await adapter.begin(live)).toBe(true);await adapter.close();
      adapter=postgresQueueHostFence({databaseUrl:protectedUrl.toString()});
      expect(await adapter.begin(randomUUID())).toBe(false);
      expect(await adapter.settle(live,false)).toBe(true);
      expect(await adapter.settle(live,true)).toBe(false);
    } finally {await adapter.close();}

  } finally {await Promise.all([admin.end(),other.end(),app.end()]);await db.drop();}
},60000);
