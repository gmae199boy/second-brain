import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { expect, it } from 'vitest';
import { isolatedClusterDatabase } from './isolated-cluster.js';
import { prepareProtectedRoles } from '../src/protected-roles.js';

it('봉인 감독자 OS 인스턴스는 기록·확인과 재시작 fence를 보존한다',async()=>{
  const db=await isolatedClusterDatabase();const admin=new pg.Client({connectionString:db.url}),app=new pg.Client({connectionString:db.appUrl});
  try {
    await Promise.all([admin.connect(),app.connect()]);await prepareProtectedRoles(db.url);
    const sql=await readFile(new URL('../protected-migrations/0033_sealed_supervisor_instance.sql',import.meta.url),'utf8');
    await admin.query('set role brain_owner');await admin.query(sql);await admin.query('reset role');
    const token=randomUUID(),identity=[token,100,501,1700000000,1700000010000000,'a'.repeat(64),'b'.repeat(40)];
    const record='select brain.record_sealed_supervisor($1,$2,$3,$4,$5,$6,$7) as ok',confirm='select brain.confirm_sealed_supervisor($1,$2,$3,$4,$5,$6,$7) as ok';
    await expect(app.query(record,identity)).rejects.toMatchObject({code:'42501'});
    await expect(app.query('select brain.sealed_supervisor_current($1,$2,$3,$4,$5,$6)',identity.slice(1))).rejects.toMatchObject({code:'42501'});
    await admin.query('set session authorization brain_protected_supervisor');
    expect((await admin.query(record,identity)).rows[0].ok).toBe(true);
    expect((await admin.query(record,[randomUUID(),...identity.slice(1)])).rows[0].ok).toBe(false);
    expect((await admin.query(confirm,[...identity.slice(0,4),1700000010000001,...identity.slice(5)])).rows[0].ok).toBe(false);
    expect((await admin.query(confirm,identity)).rows[0].ok).toBe(true);
    expect((await admin.query('select brain.sealed_supervisor_current($1,$2,$3,$4,$5,$6) as ok',identity.slice(1))).rows[0].ok).toBe(true);
    expect((await admin.query('select brain.sealed_supervisor_current($1,$2,$3,$4,$5,$6) as ok',[101,...identity.slice(2)])).rows[0].ok).toBe(false);
    expect((await admin.query('select brain.release_sealed_supervisor($1) as ok',[randomUUID()])).rows[0].ok).toBe(false);
    await admin.query('reset session authorization');
    expect((await admin.query('select pid,uid,state,package_hash,node_hash from brain.sealed_supervisor_instance')).rows).toEqual([{pid:100,uid:'501',state:'verified',package_hash:'a'.repeat(64),node_hash:'b'.repeat(40)}]);
  } finally {await Promise.all([admin.end(),app.end()]);await db.drop();}
},60000);
