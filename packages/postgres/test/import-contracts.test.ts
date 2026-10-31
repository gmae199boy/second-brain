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
    const analysisId = randomUUID();
    await ext.query(analysis, [analysisId,name,'one',file,work,token]);
    const relationId = randomUUID();
    const relation = `insert into brain.analysis_artifacts(id,source,dataset,import_batch,analysis_id,file_request_id,role,source_work_item_id,source_attempt_token) values ($1,$2,$3,'b',$4,$5,'image',$6,$7)`;
    const relationArgs = [relationId,name,'d',analysisId,file,work,token];
    await ext.query(relation,relationArgs);
    await ext.query(relation,relationArgs);
    expect((await admin.query('select id from brain.analysis_artifacts')).rowCount).toBe(1);
    await expect(ext.query(relation,[relationId,name,'d',analysisId,file,randomUUID(),token])).rejects.toMatchObject({code:'BRS01'});
    await expect(ext.query(relation,[randomUUID(),name,'wrong',analysisId,file,work,token])).rejects.toThrow();
    await expect(ext.query(relation,[relationId,name,'d',analysisId,file,work,token].map((v,i)=>i===2?'changed':v))).rejects.toThrow();
    await expect(ext.query('select * from brain.analysis_artifacts')).rejects.toMatchObject({code:'42501'});
    await expect(ext.query('update brain.analysis_artifacts set role=role')).rejects.toMatchObject({code:'42501'});
    await expect(admin.query('delete from brain.analysis_artifacts')).rejects.toThrow('불변');
    const foreignId = randomUUID();
    await admin.query('alter table brain.health_observations disable trigger user');
    try { await admin.query("insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) select $1,'foreign_source',dataset,import_batch,original_table,'foreign',account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token from brain.health_observations where source=$2 limit 1", [foreignId,name]); }
    finally { await admin.query('alter table brain.health_observations enable trigger user'); }
    const verification = await store.imports.readVerification({ source:name, workId:work, token, now, rawViews:['raw_records'] });
    expect(verification).toMatchObject({ ok:true, data:{ tables:{ health:[{source:name}], analyses:[{id:analysisId}], raw:[{body:'원문'}], requests:[{id:file}] }, files:[{requestId:file,fileId:null}] } });
    expect(verification.ok && verification.data.tables.health_supported_versions).toEqual([{version:1},{version:2},{version:8}]);
    expect(verification.ok && verification.data.tables.health).not.toContainEqual(expect.objectContaining({id:foreignId}));
    await admin.query('alter table brain.health_observations disable trigger user');
    try { await admin.query('delete from brain.health_observations where id=$1',[foreignId]); }
    finally { await admin.query('alter table brain.health_observations enable trigger user'); }
    expect(await store.imports.readVerification({source:name,workId:work,token:randomUUID(),now,rawViews:[]})).toMatchObject({ok:false});
    expect(await store.imports.readVerification({source:'other',workId:work,token,now,rawViews:[]})).toMatchObject({ok:false});
    const payloadId = randomUUID();
    const payload = analysis.replace('file_request_id,source_work_item_id', 'file_request_id,summary,summary_raw,summary_encoding,source_work_item_id').replace('$4,$5,$6)', "$4,'a�b',$7,'utf-8',$5,$6)");
    await ext.query(payload,[payloadId,name,'payload',file,work,token,Buffer.from([97,0,98])]);
    await ext.query(payload,[payloadId,name,'payload',file,work,token,Buffer.from([97,0,98])]);
    await expect(ext.query(payload,[payloadId,name,'payload',file,work,token,Buffer.from([97,0,99])])).rejects.toThrow('충돌');
    const analysesDto = await store.imports.readAnalyses();
    expect(analysesDto.ok && analysesDto.rows).toContainEqual(expect.objectContaining({id:payloadId,summary:'a\0b'}));
    expect(analysesDto.ok && analysesDto.rows).toContainEqual(expect.objectContaining({id:analysisId,artifacts:[expect.objectContaining({file_request_id:file,role:'image',file_id:null})]}));
    await expect(ext.query(analysis.replace("'d','b'", "'other','b'"), [randomUUID(),name,'wrong-dataset',file,work,token])).rejects.toThrow();
    const jsonTextId=randomUUID(), jsonText = 'x\ud800y\0', jsonRaw=Buffer.from('"x\\ud800y\\u0000"','ascii');
    const jsonAnalysis=analysis.replace('file_request_id,source_work_item_id','file_request_id,scope,scope_raw,scope_encoding,source_work_item_id').replace('$4,$5,$6)', '$4,$7,$8,$9,$5,$6)');
    const jsonArgs=[jsonTextId,name,'json-surrogate',file,work,token,'x�y�',jsonRaw,'json-string-v1'];
    await ext.query(jsonAnalysis,jsonArgs); await ext.query(jsonAnalysis,jsonArgs);
    const validJsonDto=await store.imports.readAnalyses();
    expect(validJsonDto.ok && validJsonDto.rows).toContainEqual(expect.objectContaining({id:jsonTextId,scope:jsonText}));
    await expect(ext.query(jsonAnalysis,[randomUUID(),name,'json-version',file,work,token,'x�y�',jsonRaw,'json-string-v2'])).rejects.toMatchObject({code:'23514'});
    const mutateJson=async (display:string,raw:Buffer,encoding:string)=>{
      await admin.query('alter table brain.analyses disable trigger import_immutable');
      try { await admin.query('update brain.analyses set scope=$2,scope_raw=$3,scope_encoding=$4 where id=$1',[jsonTextId,display,raw,encoding]); }
      finally { await admin.query('alter table brain.analyses enable trigger import_immutable'); }
    };
    for (const [display,raw,encoding] of [['wrong',jsonRaw,'json-string-v1'],['x�y�',Buffer.from('not-json'),'json-string-v1'],['x�y�',jsonRaw,'utf-8']] as const) {
      await mutateJson(display,raw,encoding);
      expect(await store.imports.readAnalyses()).toMatchObject({ok:false});
    }
    await mutateJson('x�y�',jsonRaw,'json-string-v1');

    // primary는 같은 source/dataset이어도 분석의 불변 주 요청과 같아야 한다.
    const anotherRequest=randomUUID();
    await ext.query(request,[anotherRequest,name,'same-dataset-second','b'.repeat(64),work,token]);
    const primary=relation.replace("'image'", "'primary'");
    await expect(ext.query(primary,[randomUUID(),name,'d',analysisId,anotherRequest,work,token])).rejects.toThrow();
    const primaryId=randomUUID(), primaryArgs=[primaryId,name,'d',analysisId,file,work,token];
    await ext.query(primary,primaryArgs); await ext.query(primary,primaryArgs);
    await ext.query(relation,[randomUUID(),name,'d',analysisId,anotherRequest,work,token]);
    const input=relation.replace("'image'", "'input'");
    await ext.query(input,[randomUUID(),name,'d',analysisId,anotherRequest,work,token]);
    expect((await admin.query('select role,file_request_id from brain.analysis_artifacts where analysis_id=$1 order by role,file_request_id',[analysisId])).rows).toHaveLength(4);

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
    await expect(ext.query(relation,[randomUUID(),name,'d',analysisId,otherFile,work,token])).rejects.toThrow();
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

it('검증 snapshot JSONB를 text wrapper로만 전달하고 SQL NULL을 유지한다', async () => {
  const db=await database(), name=`x${randomBytes(5).toString('hex')}`, password=randomBytes(24).toString('hex');
  const admin=new pg.Client({connectionString:db.url}), store=postgresStore({databaseUrl:db.appUrl});
  try {
    await admin.connect(); await provisionExtension(db.url,name,password);
    await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
    await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[name,`${name}.verify`]);
    const work=randomUUID(),token=randomUUID(),now=clock.now();
    await store.addWork({id:work,kind:`${name}.verify`,targetKind:'extension',targetId:'x',createdAt:now,nextAttemptAt:now});
    expect(await store.claimSupervisedWork({now,claimedBy:'test',kinds:[`${name}.verify`],attemptToken:token})).toMatchObject({ok:true});
    const insert=`insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token,value_type,value_json,sub_identity) values ($1,$2,'d','b','test',$3,'a',true,'day_summary.drinks_json','json','2026-01-01','Asia/Seoul',false,'r',now(),1,$4,$5,'json',$6::jsonb,$3)`;
    const large=randomUUID(),nullId=randomUUID(),shaped=randomUUID();
    await admin.query(insert,[large,name,'large',work,token,'{"n":9007199254740993,"fraction":0.1000000000000000001}']);
    await admin.query(insert,[nullId,name,'null',work,token,null]);
    await admin.query(insert,[shaped,name,'wrapper',work,token,'{"encoding":"jsonb-text-v1","data":"{\\"n\\":5}"}']);
    const channel=randomUUID(),conversation=randomUUID(),request=randomUUID();
    await admin.query("insert into brain.channels(id,kind,bot_ref) values ($1,'telegram','synthetic')",[channel]);
    await admin.query("insert into brain.channel_conversations(id,channel_id,external_ref) values ($1,$2,'synthetic')",[conversation,channel]);
    await admin.query("insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,source_work_item_id,source_attempt_token,bundle) values ($1,$2,$3,'synthetic','test','synthetic',now(),$4,$5,$6::jsonb)",[request,conversation,name,work,token,'{"n":9007199254740993,"fraction":0.1000000000000000001}']);
    const snapshot=await store.imports.readVerification({source:name,workId:work,token,now,rawViews:[]});
    expect(snapshot.ok).toBe(true); if(!snapshot.ok) throw Error('snapshot');
    const rows=snapshot.data.tables.health!; const byId=(id:string)=>rows.find(row=>row.id===id)!;
    expect(byId(nullId).value_json).toBeNull();
    expect(snapshot.data.tables.channel_requests).toContainEqual(expect.objectContaining({id:request,bundle:expect.objectContaining({encoding:'jsonb-text-v1',data:expect.stringContaining('9007199254740993')})}));
    expect((snapshot.data.tables.channel_requests![0]!.bundle as {data:string}).data).toContain('0.1000000000000000001');
    expect(byId(large).value_json).toMatchObject({encoding:'jsonb-text-v1',data:expect.stringContaining('9007199254740993')});
    expect((byId(large).value_json as {data:string}).data).toContain('0.1000000000000000001');
    expect(JSON.parse((byId(shaped).value_json as {data:string}).data)).toEqual({encoding:'jsonb-text-v1',data:'{"n":5}'});
  } finally {await admin.end(); await store.close(); await db.drop();}
});
