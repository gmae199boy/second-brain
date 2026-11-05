import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';
import { expect, it } from 'vitest';
import { provisionExtension, postgresStore } from '../src/index.js';
import { database, clock } from './fixture.js';

it('출처와 현재 시도에 결합된 불변 가져오기 계약을 강제한다', async () => {
  const db = await database(), name = `x${randomBytes(5).toString('hex')}`, role = `brain_ext_${name}`, password = randomBytes(24).toString('hex');
  const admin = new pg.Client({ connectionString: db.url });
  const store = postgresStore({ databaseUrl: db.appUrl });
  let ext: pg.Client | undefined;
  try {
    await admin.connect();
    await provisionExtension(db.url, name, password);
    const url = new URL(db.url); url.username = role; url.password = password;
    ext = new pg.Client({ connectionString: url.toString() }); await ext.connect();
    await admin.query('insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,\'1\',now(),true,now())', [name]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)', [name, `${name}.import`]);
    const work = randomUUID(), token = randomUUID(), now = clock.now();
    expect(await store.addWork({ id: work, kind: `${name}.import`, targetKind: 'import', targetId: 'test', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
    expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: [`${name}.import`], attemptToken: token })).toMatchObject({ ok: true });
    const file = randomUUID();
    const request = `insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'d','b','x',$4,1,'text/plain',now(),$5,$6)`;
    await ext.query(request, [file,name,'request','a'.repeat(64),work,token]);
    expect((await ext.query('select request_id,status,resumable from brain.file_request_results_public_v1')).rows).toMatchObject([{request_id:file,status:'pending',resumable:false}]);
    const metadataId=randomUUID();
    const metadataRequest=`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,$2,'metadata','d','b','metadata',$3,1,'application/json','2026-01-01T00:00:00Z',$4,$5,$6::jsonb)`;
    const metadataArgs=[metadataId,name,'d'.repeat(64),work,token,JSON.stringify({kind:'digest',revision:'synthetic'})];
    await ext.query(metadataRequest,metadataArgs); await ext.query(metadataRequest,metadataArgs);
    expect((await admin.query('select metadata from brain.file_requests where id=$1',[metadataId])).rows[0].metadata).toEqual({kind:'digest',revision:'synthetic'});
    await expect(ext.query(metadataRequest,[...metadataArgs.slice(0,5),JSON.stringify({kind:'changed'})])).rejects.toThrow('충돌');
    await expect(ext.query(metadataRequest,[randomUUID(),name,'d'.repeat(64),work,randomUUID(),metadataArgs[5]])).rejects.toMatchObject({code:'BRS01'});

    for (const table of ['file_requests']) {
      await expect(ext.query(`select * from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(ext.query(`update brain.${table} set id=id`)).rejects.toMatchObject({ code: '42501' });
      await expect(ext.query(`delete from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(admin.query(`update brain.${table} set id=id`)).rejects.toThrow('불변');
    }
    // 실패 결과는 정리 대상이 아니며 완료 확정과 정리 근거는 원자적으로 생성된다.
    const cleanupRequest = randomUUID(), cleanupFile = randomUUID();
    await ext.query(request,[cleanupRequest,name,'cleanup','b'.repeat(64),work,token]);
    await admin.query("insert into brain.file_request_results(request_id,error_code,finished_at) values ($1,'IMPORT_FAILED',now())",[cleanupRequest]);
    expect((await admin.query('select * from brain.file_import_cleanup where request_id=$1',[cleanupRequest])).rowCount).toBe(0);
    await admin.query('insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())',[cleanupFile,'sha256:'+'b'.repeat(64)]);
    await admin.query('begin');
    await admin.query('update brain.file_request_results set file_id=$2,error_code=null where request_id=$1',[cleanupRequest,cleanupFile]);
    expect((await admin.query('select * from brain.file_import_cleanup where request_id=$1',[cleanupRequest])).rowCount).toBe(1);
    await admin.query('rollback');
    expect((await admin.query('select * from brain.file_import_cleanup where request_id=$1',[cleanupRequest])).rowCount).toBe(0);
    await admin.query('update brain.file_request_results set file_id=$2,error_code=null where request_id=$1',[cleanupRequest,cleanupFile]);
    expect((await admin.query('select * from brain.file_import_cleanup where request_id=$1',[cleanupRequest])).rowCount).toBe(1);
    const other = `${name}b`, otherWork = randomUUID(), otherToken = randomUUID(), otherFile = randomUUID();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())", [other]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)', [other, `${other}.import`]);
    await store.addWork({ id: otherWork, kind: `${other}.import`, targetKind: 'import', targetId: 'test', createdAt: now, nextAttemptAt: now });
    await store.claimSupervisedWork({ now, claimedBy: 'other', kinds: [`${other}.import`], attemptToken: otherToken });
    await admin.query(request, [otherFile,other,'foreign','a'.repeat(64),otherWork,otherToken]);
    expect((await ext.query('select request_id from brain.file_request_results_public_v1')).rows).toEqual(expect.arrayContaining([{request_id:file},{request_id:cleanupRequest}]));
    for (const [sql, args] of [
      [request,[randomUUID(),other,'foreign2','a'.repeat(64),otherWork,otherToken]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toMatchObject({ code: '42501' });
    for (const [sql, args] of [
      [request,[randomUUID(),name,'wrong-token','a'.repeat(64),otherWork,otherToken]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toMatchObject({ code: 'BRS01' });
    for (const [sql, args] of [
      [request,[randomUUID(),'other','r','a'.repeat(64),work,token]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toThrow();
    await provisionExtension(db.url, name, password);
    await store.settleSupervisedAttempt({ id: work, attemptToken: token, now, outcome: 'died' });
    for (const [sql, args] of [
      [request,[randomUUID(),name,'r2','a'.repeat(64),work,token]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toMatchObject({ code: 'BRS01' });
  } finally {
    await ext?.end(); await store.close();
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
});
