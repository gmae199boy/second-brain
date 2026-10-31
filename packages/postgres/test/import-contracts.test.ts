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
    const copyText = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_text,activity_id,sub_identity,value_text_raw,value_text_encoding) select $1,source,dataset,import_batch,original_table,$2,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,$3,activity_id,'comparison',$4,$5 from brain.health_observations where original_key='typed'`;
    const logical = 'a\0b😀', display = 'a�b😀';
    const utf8 = Buffer.from(logical), le = Buffer.from(logical,'utf16le'), be = Buffer.from(logical,'utf16le').swap16();
    for (const [index,bytes,encoding] of [[1,utf8,'utf-8'],[2,le,'utf-16le'],[3,be,'utf-16be']] as const)
      await admin.query(copyText,[randomUUID(),`text-${index}`,display,bytes,encoding]);
    expect((await admin.query("select reason,cardinality(selected_ids) as count from brain.health_resolution_v1 where metric='daily_metric.hrv_status' and sub_identity='comparison'")).rows).toEqual([{reason:null,count:3}]);
    expect((await admin.query("select value_text_raw from brain.health_observations where original_key like 'text-%' order by original_key")).rows).toEqual([{value_text_raw:utf8},{value_text_raw:le},{value_text_raw:be}]);
    await admin.query(copyText,[randomUUID(),'text-different',display,null,null]);
    expect((await admin.query("select reason from brain.health_resolution_v1 where metric='daily_metric.hrv_status' and sub_identity='comparison'")).rows).toEqual([{reason:'value_ambiguous'}]);
    const rawTyped = typed.replace('value_type,value_text,activity_id,sub_identity)', 'value_type,value_text,activity_id,sub_identity,value_text_raw,value_text_encoding)').replace("'text','normal','exercise','set')", "'text','a�b','exercise','raw-set',$5,'utf-8')").replace("'typed'", "'raw-typed'");
    await ext.query(rawTyped,[randomUUID(),name,work,token,Buffer.from([97,0,98])]);
    expect((await admin.query("select value_text,value_text_raw,value_text_encoding from brain.health_observations where original_key='raw-typed'")).rows).toEqual([{value_text:'a�b',value_text_raw:Buffer.from([97,0,98]),value_text_encoding:'utf-8'}]);
    await expect(ext.query(rawTyped.replace("'utf-8'", 'null').replace("'raw-typed'", "'invalid-pair'"),[randomUUID(),name,work,token,Buffer.from([97,0,98])])).rejects.toMatchObject({code:'23514'});
    const distinctAccounts = typed.replace('value_type,value_text,activity_id,sub_identity)', 'value_type,value_text,activity_id,sub_identity,account_raw,account_encoding)').replace("'text','normal','exercise','set')", "'text','normal','exercise','identity-set',$5,$6)").replace("'acct'", "'a�b'").replace("'typed'", "'identity'");
    await ext.query(distinctAccounts,[randomUUID(),name,work,token,Buffer.from([97,0,98]),'utf-8']);
    await ext.query(distinctAccounts,[randomUUID(),name,work,token,null,null]);
    expect((await admin.query("select id from brain.health_current_v1 where original_key='identity'")).rowCount).toBe(2);
    for (const column of ['activity_id','sub_identity']) {
      const inserted = typed.replace('value_type,value_text,activity_id,sub_identity)', `value_type,value_text,activity_id,sub_identity,${column}_raw,${column}_encoding)`)
        .replace("'typed'", `'${column}-identity'`)
        .replace("'text','normal','exercise','set')", column === 'activity_id' ? "'text','normal','a�b','different',$5,$6)" : "'text','normal','different','a�b',$5,$6)");
      await ext.query(inserted,[randomUUID(),name,work,token,Buffer.from([97,0,98]),'utf-8']);
      await ext.query(inserted,[randomUUID(),name,work,token,null,null]);
      expect((await admin.query('select id from brain.health_current_v1 where original_key=$1',[`${column}-identity`])).rowCount).toBe(2);
    }
    const jsonBody = '{"a\\u0000b":{"a�b":"\\u0000"},"a�b":2}';
    const jsonInsert = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_json,value_json_raw,value_json_encoding) values ($1,$2,'d','b','day_summary','json-key','acct',true,'day_summary.drinks_json','json','2026-01-01','Asia/Seoul',false,'hash',now(),1,$3,$4,'json','{}'::jsonb,$5,'utf-8')`;
    await ext.query(jsonInsert,[randomUUID(),name,work,token,Buffer.from(jsonBody)]);
    const healthDto=await store.imports.readHealth();
    expect(healthDto.ok && healthDto.rows).toContainEqual(expect.objectContaining({original_key:'json-key',value_json:{'a\0b':{'a�b':'\0'},'a�b':2}}));
    if (healthDto.ok) expect(healthDto.rows.every(row=>Object.keys(row).every(k=>!k.endsWith('_raw') && !k.endsWith('_encoding')))).toBe(true);
    const equivalent = '{ "a�b": 2, "a\\u0000b": {"a�b":"\\u0000"} }';
    const copyJson = `insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_json,value_json_raw,value_json_encoding) select $1,source,dataset,import_batch,original_table,$2,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_json,$3,'utf-16le' from brain.health_observations where original_key='json-key'`;
    await admin.query(copyJson,[randomUUID(),'json-equivalent',Buffer.from(equivalent,'utf16le')]);
    expect((await admin.query("select reason,cardinality(selected_ids) as count from brain.health_resolution_v1 where metric='day_summary.drinks_json'")).rows).toEqual([{reason:null,count:2}]);
    await admin.query(copyJson,[randomUUID(),'json-different',Buffer.from(equivalent.replace(': 2',': 3'),'utf16le')]);
    expect((await admin.query("select reason from brain.health_resolution_v1 where metric='day_summary.drinks_json'")).rows).toEqual([{reason:'value_ambiguous'}]);
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

it('기존 JSON 원문을 인코딩과 서식에 관계없이 논리 값으로 비교한다', async () => {
  const db = await database(); const admin = new pg.Client({connectionString: db.url});
  try {
    await admin.connect();
    const compare = async (bytes: Buffer, encoding: string) => (await admin.query('select brain.health_json_comparison($1::jsonb,$2,$3) as value', ['{}', bytes, encoding])).rows[0].value;
    const first = '{"a\\u0000b":{"\\ud800":"\\udfff","pair":"\\ud83d\\ude00"},"x":[1,2]}';
    const same = '{ "x" : [1.0,2], "a\\u0000b" : {"pair":"😀", "\\ud800":"\\udfff"} }';
    const expected = await compare(Buffer.from(first), 'utf-8');
    expect(expected[0]).toBe('json');
    expect(await compare(Buffer.from(same, 'utf16le'), 'utf-16le')).toEqual(expected);
    expect(await compare(Buffer.from(same, 'utf16le').swap16(), 'utf-16be')).toEqual(expected);
    expect(await compare(Buffer.from(first.replace('\\udfff','\\udffe')), 'utf-8')).not.toEqual(expected);
    expect(await compare(Buffer.from('{"x":"\\\\u0000"}'), 'utf-8')).not.toEqual(await compare(Buffer.from('{"x":"\\u0000"}'), 'utf-8'));
    expect((await compare(Buffer.from([0, 0xd8]), 'utf-16le'))[0]).toBe('invalid');
    expect((await compare(Buffer.from([0xff]), 'utf-8'))[0]).toBe('invalid');
    expect((await compare(Buffer.from('{"x":]'), 'utf-8'))[0]).toBe('invalid');
    const textCompare = async (display: string, bytes: Buffer | null, encoding: string | null) => (await admin.query('select brain.health_text_comparison($1,$2,$3) as value',[display,bytes,encoding])).rows[0].value;
    expect(await textCompare('',Buffer.alloc(0),'utf-8')).toEqual(await textCompare('',Buffer.alloc(0),'utf-16be'));
    expect(await textCompare('�',Buffer.from([0]),'utf-8')).not.toEqual(await textCompare('�',null,null));
    expect(await textCompare('�',Buffer.from([0]),'utf-8')).not.toEqual(await textCompare('\\u0000',null,null));
    expect((await textCompare('�',Buffer.from([0xff]),'utf-8'))[0]).toBe('invalid');
    expect((await textCompare('�',Buffer.from([0,0xd8]),'utf-16le'))[0]).toBe('invalid');
  } finally { await admin.end(); await db.drop(); }
});
