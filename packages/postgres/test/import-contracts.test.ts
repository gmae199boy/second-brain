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
    await admin.query(`create view "${name}".raw_records as select '${name}'::text as source, null::text as account, 'key'::text as key, 'endpoint'::text as endpoint, null::timestamptz as fetched_at, null::timestamptz as checked_at, '원문'::text as body`);
    await admin.query(`grant usage on schema "${name}" to brain_app; grant select on "${name}".raw_records to brain_app`);
    const active = await store.imports.readRaw({source:name,rawViews:['raw_records']});
    expect(active).toMatchObject({ok:true,extensionEnabled:true,rows:[{body:'원문'}]});
    await admin.query('update brain.extensions set enabled=false where name=$1',[name]);
    const inactive = await store.imports.readRaw({source:name,rawViews:['raw_records']});
    expect(inactive).toEqual(active.ok ? {...active,extensionEnabled:false} : null);
    expect(await store.imports.readRaw({source:'missingext',rawViews:['raw_records']})).toMatchObject({ok:false,code:'IMPORT_VIEW_INVALID'});
    await admin.query('update brain.extensions set enabled=true where name=$1',[name]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)', [name, `${name}.import`]);
    const work = randomUUID(), token = randomUUID(), now = clock.now();
    expect(await store.addWork({ id: work, kind: `${name}.import`, targetKind: 'import', targetId: 'test', createdAt: now, nextAttemptAt: now })).toMatchObject({ ok: true });
    expect(await store.claimSupervisedWork({ now, claimedBy: 'test', kinds: [`${name}.import`], attemptToken: token })).toMatchObject({ ok: true });
    const file = randomUUID();
    const request = `insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'d','b','x',$4,1,'text/plain',now(),$5,$6)`;
    const health = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) values ($1,$2,'d','b','daily',$3,'acct',true,'steps',42,'count','2026-01-01','Asia/Seoul',false,'hash',now(),1,$4,$5)`;
    const analysis = `insert into brain.analyses(id,source,dataset,import_batch,original_table,original_key,revision,model_missing,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) values ($1,$2,'d','b','reports',$3,1,true,true,$4,$5,$6)`;
    await ext.query(request, [file,name,'request','a'.repeat(64),work,token]);
    expect((await ext.query('select request_id,status,resumable from brain.file_request_results_public_v1')).rows).toMatchObject([{request_id:file,status:'pending',resumable:false}]);
    await ext.query(health, [randomUUID(),name,'one',work,token]);
    await ext.query(analysis, [randomUUID(),name,'one',file,work,token]);
    expect((await admin.query('select * from brain.health_current_v1')).rowCount).toBe(1);
    await admin.query("insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) select $1,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,'America/New_York',false,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token from brain.health_observations limit 1", [randomUUID()]);
    expect((await admin.query('select * from brain.health_current_v1')).rowCount).toBe(2);
    await admin.query("insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) select $1,source,dataset,import_batch,original_table,'unconfirmed',null,false,metric,value,unit,local_date,observed_at,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token from brain.health_observations limit 1", [randomUUID()]);
    expect((await admin.query('select * from brain.health_current_v1')).rowCount).toBe(2);
    const typed = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_text,activity_id,sub_identity) values ($1,$2,'d','b','daily','typed','acct',true,'daily_metric.hrv_status','category','2026-01-01','Asia/Seoul',false,'hash',now(),1,$3,$4,'text','normal','exercise','set')`;
    await ext.query(typed,[randomUUID(),name,work,token]);
    expect((await admin.query("select value_type,value_text,activity_id,sub_identity from brain.health_current_v1 where original_key='typed'")).rows).toEqual([{value_type:'text',value_text:'normal',activity_id:'exercise',sub_identity:'set'}]);
    await expect(ext.query("insert into brain.health_authority_rules(id,source,account,revision,datasets) values ($1,$2,'acct',1,array['d'])",[randomUUID(),name])).rejects.toMatchObject({code:'BRS01'});
    for (const table of ['health_observations','file_requests','analyses']) {
      await expect(ext.query(`select * from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(ext.query(`update brain.${table} set id=id`)).rejects.toMatchObject({ code: '42501' });
      await expect(ext.query(`delete from brain.${table}`)).rejects.toMatchObject({ code: '42501' });
      await expect(admin.query(`update brain.${table} set id=id`)).rejects.toThrow('불변');
    }
    const other = `${name}b`, otherWork = randomUUID(), otherToken = randomUUID(), otherFile = randomUUID();
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())", [other]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)', [other, `${other}.import`]);
    await store.addWork({ id: otherWork, kind: `${other}.import`, targetKind: 'import', targetId: 'test', createdAt: now, nextAttemptAt: now });
    await store.claimSupervisedWork({ now, claimedBy: 'other', kinds: [`${other}.import`], attemptToken: otherToken });
    await admin.query(request, [otherFile,other,'foreign','a'.repeat(64),otherWork,otherToken]);
    expect((await ext.query('select request_id from brain.file_request_results_public_v1')).rows).toEqual([{request_id:file}]);
    for (const [sql, args] of [
      [request,[randomUUID(),other,'foreign2','a'.repeat(64),otherWork,otherToken]],
      [health,[randomUUID(),other,'foreign',otherWork,otherToken]],
      [analysis,[randomUUID(),other,'foreign',otherFile,otherWork,otherToken]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toMatchObject({ code: '42501' });
    for (const [sql, args] of [
      [request,[randomUUID(),name,'wrong-token','a'.repeat(64),otherWork,otherToken]],
      [health,[randomUUID(),name,'wrong-token',otherWork,otherToken]],
      [analysis,[randomUUID(),name,'wrong-token',file,otherWork,otherToken]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toMatchObject({ code: 'BRS01' });
    for (const [sql, args] of [
      [request,[randomUUID(),'other','r','a'.repeat(64),work,token]],
      [health,[randomUUID(),'other','two',work,token]],
      [analysis,[randomUUID(),'other','two',file,work,token]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toThrow();
    await provisionExtension(db.url, name, password);
    await store.settleSupervisedAttempt({ id: work, attemptToken: token, now, outcome: 'died' });
    for (const [sql, args] of [
      [request,[randomUUID(),name,'r2','a'.repeat(64),work,token]],
      [health,[randomUUID(),name,'two',work,token]],
      [analysis,[randomUUID(),name,'two',file,work,token]],
    ] as [string, unknown[]][]) await expect(ext.query(sql,args)).rejects.toMatchObject({ code: 'BRS01' });
  } finally {
    await ext?.end(); await store.close();
    await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(() => {});
    await admin.end(); await db.drop();
  }
});
