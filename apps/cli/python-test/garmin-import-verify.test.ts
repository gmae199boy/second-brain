import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, realpath, readFile, writeFile, unlink, copyFile, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { postgresStore } from 'second_brain/postgres';
import { runDaemon } from '../src/daemon/run.js';
import { systemClock } from '../src/runtime/clock.js';
import { uuidV7IdGen } from '../src/runtime/id-gen.js';

it('합성 capture를 반입하고 공개 검증 뒤 변조를 실패로 감지한다', async () => {
  const fixture = await extHome(), store = postgresStore({ databaseUrl: fixture.db.appUrl }), controller = new AbortController(), ids = uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const install = await fixture.run(['ext','install','garmin','--json']); expect(install.code,install.stdout+install.stderr).toBe(0);
    const python = join(fixture.home,'extensions/garmin/.venv/bin/python'), root = join(fixture.home,'capture'); await mkdir(root);
    const fixtures = fileURLToPath(new URL('../../../extensions/garmin/tests', import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib,sqlite3; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; p=pathlib.Path(sys.argv[2]); artifact_capture(p); c=sqlite3.connect(p/'D1.db'); c.execute('update daily_metric set steps=987654321'); c.commit(); c.close()",fixtures,root]);
    const captureManifest = join(root,'manifest.json');
    const captureValue = JSON.parse(await readFile(captureManifest,'utf8'));
    captureValue.inventory[0].metadata.fields.weight.quality = { nested: [1, 0, 0.1] };
    captureValue.inventory[1].metadata={marker:'raw-secret\u0000',number:1};
    const rawArtifact=captureValue.files.find((f:any)=>f.artifact_key==='config'); rawArtifact.source='raw-artifact\u0000'; rawArtifact.bytes=1; await writeFile(join(root,'config.toml'),'x');
    await writeFile(captureManifest,JSON.stringify(captureValue));
    const channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon = runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imported = await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code,imported.stdout+imported.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('succeeded');
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:25000}).toBe(0);
    const verified = await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(verified.code, verified.stdout+verified.stderr).toBe(0);
    expect(Object.values(verified.body.data.report.checks).every(Boolean)).toBe(true);
    expect(verified.body.data.report.counts).toMatchObject({datasets:5,artifacts:11,excluded:6,unselected:21,excluded_config:2,excluded_secret:1,excluded_scan_failed:2,excluded_unknown:1,outbound_requests:0,outbound_results:0,mismatches:0});
    expect(verified.stdout).not.toContain('synthetic-D1');
    const forbidden = ['synthetic-D1', '2026-01-01', '12345', '987654321', '한글', createHash('sha256').update(await readFile(join(root,'D1.db'))).digest('hex')];
    const checkPublic = (text: string) => { for (const secret of forbidden) expect(text).not.toContain(secret); };
    checkPublic(verified.stdout + verified.stderr);
    await fixture.db.query(`create table public.backup_health as select * from brain.health_observations where metric='daily_metric.steps' and value is not null limit 1;
      create table public.backup_raw as select * from garmin.raw_payloads where body_raw is null limit 1;
      create table public.backup_legacy as select * from brain.channel_legacy_notifications limit 1;
      create table public.backup_analysis as select * from brain.analyses where original_table='artifact' limit 1;
      create table public.backup_evaluation as select * from brain.analyses where original_table='evaluation' limit 1;
      create table public.backup_provenance as select * from garmin.import_provenance limit 1;
      create table public.backup_typed as select * from garmin.preserved_rows where original_table='run' and values_json->'id'->>'value'='1' limit 1;
      create table public.backup_typed_zero as select * from garmin.preserved_rows where original_table='delivery' and values_json->'ok'->>'value'='0' limit 1;
      create table public.backup_schema as select * from garmin.source_schemas where original_table='run' limit 1;
      create table public.backup_input as select * from garmin.input_inventory where dataset='synthetic-D1' and category='body';
      create table public.backup_input_raw as select * from garmin.input_inventory where dataset='synthetic-D1' and category='profile';
      create table public.backup_artifact_raw as select * from garmin.artifact_inventory where dataset='synthetic-D1' and artifact_key='config';
      create table public.backup_inventory as select * from garmin.artifact_inventory where exclusion_reason is not null limit 1;
      create table public.backup_relation as select * from brain.analysis_artifacts where role='primary' limit 1;
      create table public.backup_authority as select * from brain.health_authority_rules limit 1;
      create table public.backup_parent as select * from garmin.preserved_rows where original_table='fetch_error' and run_id is not null limit 1;
      create table public.backup_mapping as select * from garmin.import_mapping where target_kind='preserved' limit 1;
      create table public.backup_preserved as select * from garmin.preserved_rows limit 1;
      create table public.backup_result as select r.* from brain.file_request_results r where r.file_id is not null limit 1;
      create table public.backup_file as select f.* from brain.files f join public.backup_result r on r.file_id=f.id;`);
    await fixture.db.query('delete from brain.health_supported_versions where version=2');
    try {
      const reason = await fixture.db.rows("select reason from brain.health_resolution_v1 where account='12345' and metric='daily_metric.steps' and local_date='2026-01-01'");
      expect(reason).toEqual([{reason:'version_unsupported'}]);
      const unsupported = await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(unsupported.code,unsupported.stdout+unsupported.stderr).toBe(0);
      expect(unsupported.body.data.report.checks.authority).toBe(true);
    } finally {await fixture.db.query('insert into brain.health_supported_versions(version) values (2)');}
    const selectionSql = "select current_id,dataset,authority_id,authority_version from brain.health_resolution_v1 where source='garmin' and account='12345' and metric='daily_metric.steps' and local_date='2026-01-01'";
    const selectionBefore = await fixture.db.rows(selectionSql); expect(selectionBefore).toHaveLength(1);
    for (const [label, metric, revision, orderChanged] of [['높은 revision','null',2,true],['구체적 metric',"'daily_metric.steps'",1,true],['같은 순서의 높은 revision','null',2,false]] as const) {
      const ruleId=ids.next();
      await fixture.db.query(`insert into brain.health_authority_rules(id,source,account,metric,activity_id,date_from,date_to,revision,datasets) select '${ruleId}',source,account,${metric},null,null,null,${revision},${orderChanged ? 'array_reverse(datasets)' : 'datasets'} from public.backup_authority`);
      try {
        const current=await fixture.db.rows(selectionSql); if (orderChanged) expect(current[0]!.current_id,label).not.toEqual(selectionBefore[0]!.current_id);
        else expect(current[0]!.current_id,label).toEqual(selectionBefore[0]!.current_id);
        expect(current[0]!.authority_id,label).toBe(ruleId);
        const tampered=await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(tampered.code,`${label}: ${tampered.stdout}${tampered.stderr}`).not.toBe(0);
        expect(tampered.body.data.report.checks.authority,label).toBe(false);
        expect(await fixture.db.rows(selectionSql)).toEqual(current);
        for (const secret of forbidden) expect(tampered.stdout+tampered.stderr).not.toContain(secret);
      } finally {await fixture.db.query(`alter table brain.health_authority_rules disable trigger user; delete from brain.health_authority_rules where id='${ruleId}'; alter table brain.health_authority_rules enable trigger user`);}
    }
    const snapshotSql = ['garmin.preserved_rows','garmin.import_mapping','garmin.import_provenance','garmin.raw_payloads','garmin.import_conflicts','garmin.artifact_inventory','garmin.artifact_relations','brain.health_observations','brain.health_authority_rules','brain.analyses','brain.analysis_artifacts','brain.file_requests','brain.file_request_results','brain.files','brain.file_locations','brain.channel_legacy_notifications','brain.channel_legacy_deliveries'].map((table, index) => `select ${index} as n,md5(coalesce(string_agg(row_to_json(x)::text,'' order by row_to_json(x)::text),'')) as digest from ${table} x`).join(' union all ') + ' order by n';
    const privateReport = join(fixture.home,'extensions/garmin/reports',verified.body.data.work_id,'private.json');
    const projected = execFileSync(python,['-c',"import json,sys; sys.path.insert(0,sys.argv[1]); from verify_compare import public_projection; print(json.dumps(public_projection(json.load(open(sys.argv[2])))))",join(fixture.home,'extensions/garmin/src'),privateReport],{encoding:'utf8'});
    expect(JSON.parse(projected)).toEqual(verified.body.data.report); checkPublic(projected);
    await fixture.db.query("alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set values_json=jsonb_set(values_json,'{id,value}','1.0'::jsonb) where id=(select id from public.backup_typed); alter table garmin.preserved_rows enable trigger user; update garmin.source_schemas set columns_json=jsonb_set(columns_json,'{0,primary_key_position}','1.0'::jsonb) where (dataset,original_table)=(select dataset,original_table from public.backup_schema); update garmin.input_inventory set metadata=jsonb_set(metadata,'{fields,fields,weight,quality,nested,0}','1.0'::jsonb) where (dataset,category)=(select dataset,category from public.backup_input)");
    try {
      const numericEquivalent = await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(numericEquivalent.code,numericEquivalent.stdout+numericEquivalent.stderr).toBe(0);
    } finally {
      await fixture.db.query("alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set values_json=b.values_json from public.backup_typed b where p.id=b.id; alter table garmin.preserved_rows enable trigger user; update garmin.source_schemas s set columns_json=b.columns_json from public.backup_schema b where (s.dataset,s.original_table)=(b.dataset,b.original_table); update garmin.input_inventory i set metadata=b.metadata from public.backup_input b where (i.dataset,i.category)=(b.dataset,b.category)");
    }
    const preciseCases = [
      ['typed', 'preserved', "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set values_json=jsonb_set(values_json,'{id,value}','1.0000000000000000001'::jsonb) where id=(select id from public.backup_typed); alter table garmin.preserved_rows enable trigger user", "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set values_json=b.values_json from public.backup_typed b where p.id=b.id; alter table garmin.preserved_rows enable trigger user"],
      ['schema', 'schemas', "update garmin.source_schemas set columns_json=jsonb_set(columns_json,'{0,primary_key_position}','1.0000000000000000001'::jsonb) where (dataset,original_table)=(select dataset,original_table from public.backup_schema)", "update garmin.source_schemas s set columns_json=b.columns_json from public.backup_schema b where (s.dataset,s.original_table)=(b.dataset,b.original_table)"],
      ['metadata', 'inventory', "update garmin.input_inventory set metadata=jsonb_set(metadata,'{fields,fields,weight,quality,nested,0}','1.0000000000000000001'::jsonb) where (dataset,category)=(select dataset,category from public.backup_input)", "update garmin.input_inventory i set metadata=b.metadata from public.backup_input b where (i.dataset,i.category)=(b.dataset,b.category)"],
    ] as const;
    for (const [label, check, change, restore] of preciseCases) {
      await fixture.db.query(change);
      try {
        const before = await fixture.db.rows(snapshotSql);
        const result = await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(result.code, label).not.toBe(0);
        expect(result.body.data.report.checks[check], label).toBe(false);
        expect(await fixture.db.rows(snapshotSql), label).toEqual(before);
        const publicReport = await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
        checkPublic(result.stdout + result.stderr + publicReport);
        expect(JSON.parse(publicReport)).toEqual(result.body.data.report);
      } finally { await fixture.db.query(restore); }
    }
    for (const [table, field, check, predicate] of [
      ['brain.health_observations','fetched_at','health',"fetched_at is not null"],
      ['brain.health_observations','observed_at','health',"observed_at is not null"],
      ['brain.channel_legacy_notifications','at','legacy',"at is not null"],
      ['brain.channel_legacy_deliveries','at','legacy',"at is not null"],
    ] as const) {
      const rows=await fixture.db.rows(`select id from ${table} where ${predicate} limit 1`); expect(rows,`${table}.${field}`).toHaveLength(1);
      const id=rows[0]!.id;
      await fixture.db.query(`alter table ${table} disable trigger user; update ${table} set ${field}=${field}+interval '1 microsecond' where id='${id}'; alter table ${table} enable trigger user`);
      try {
        const before=await fixture.db.rows(`select ${field}::text as value from ${table} where id='${id}'`);
        const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(result.code,`${table}.${field}`).not.toBe(0); expect(result.body.data.report.checks[check]).toBe(false);
        expect(await fixture.db.rows(`select ${field}::text as value from ${table} where id='${id}'`)).toEqual(before);
        const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
        checkPublic(result.stdout+result.stderr+publicReport); expect(JSON.parse(publicReport)).toEqual(result.body.data.report);
      } finally {await fixture.db.query(`alter table ${table} disable trigger user; update ${table} set ${field}=${field}-interval '1 microsecond' where id='${id}'; alter table ${table} enable trigger user`);}
    }
    for (const value of ['[]','null']) {
      await fixture.db.query(`alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set values_json='${value}'::jsonb where id=(select id from public.backup_typed); alter table garmin.preserved_rows enable trigger user`);
      try {
        const before=await fixture.db.rows("select values_json::text as value from garmin.preserved_rows where id=(select id from public.backup_typed)");
        const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(result.code).not.toBe(0); expect(result.body.data.report.checks.preserved).toBe(false);
        const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
        const privateReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'private.json'),'utf8');
        expect(JSON.parse(publicReport)).toEqual(result.body.data.report); expect(JSON.parse(privateReport).differences.preserved.length).toBeGreaterThan(0); checkPublic(publicReport);
        expect(await fixture.db.rows("select values_json::text as value from garmin.preserved_rows where id=(select id from public.backup_typed)")).toEqual(before);
        checkPublic(result.stdout+result.stderr);
      } finally {await fixture.db.query("alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set values_json=b.values_json from public.backup_typed b where p.id=b.id; alter table garmin.preserved_rows enable trigger user");}
    }
    await fixture.db.query('update garmin.authority_provenance set revision=revision+1');
    try {
      const before=await fixture.db.rows('select revision from garmin.authority_provenance');
      const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(result.code).not.toBe(0); expect(result.body.data.report.checks.authority).toBe(false);
      const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8'); checkPublic(publicReport);
      expect(await fixture.db.rows('select revision from garmin.authority_provenance')).toEqual(before); checkPublic(result.stdout+result.stderr);
    } finally {await fixture.db.query('update garmin.authority_provenance set revision=revision-1');}
    for (const kind of ['input','artifact'] as const) {
      const table=kind==='input'?'garmin.input_inventory':'garmin.artifact_inventory';
      const where=kind==='input'?"dataset='synthetic-D1' and category='profile'":"dataset='synthetic-D1' and artifact_key='config'";
      const pattern=kind==='input'?'"number":1':'"bytes":1';
      const changed=kind==='input'?'"number":1.0000000000000000001':'"bytes":1.0000000000000000001';
      const backup=kind==='input'?'public.backup_input_raw':'public.backup_artifact_raw';
      await fixture.db.query(`update ${table} set metadata_raw=convert_to(replace(convert_from(metadata_raw,'UTF8'),'${pattern}','${changed}'),'UTF8') where ${where}`);
      try {
        const before=await fixture.db.rows(`select encode(metadata_raw,'hex') as raw from ${table} where ${where}`); expect(before[0]!.raw).not.toEqual((await fixture.db.rows(`select encode(metadata_raw,'hex') as raw from ${backup}`))[0]!.raw);
        const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(result.code,kind).toBe(0); expect(result.body.data.report.checks.inventory,kind).toBe(true);
        expect(await fixture.db.rows(`select encode(metadata_raw,'hex') as raw from ${table} where ${where}`)).toEqual(before); checkPublic(result.stdout+result.stderr);
      } finally {await fixture.db.query(`update ${table} set metadata_raw=(select metadata_raw from ${backup}) where ${where}`);}
    }
    const cases = [
      ['typed 정수와 boolean', 'preserved', "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set values_json=jsonb_set(values_json,'{id,value}','true'::jsonb) where id=(select id from public.backup_typed); alter table garmin.preserved_rows enable trigger user", "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set values_json=b.values_json from public.backup_typed b where p.id=b.id; alter table garmin.preserved_rows enable trigger user"],
      ['typed 0과 false', 'preserved', "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set values_json=jsonb_set(values_json,'{ok,value}','false'::jsonb) where id=(select id from public.backup_typed_zero); alter table garmin.preserved_rows enable trigger user", "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set values_json=b.values_json from public.backup_typed_zero b where p.id=b.id; alter table garmin.preserved_rows enable trigger user"],
      ['schema 중첩 숫자와 boolean', 'schemas', "update garmin.source_schemas set columns_json=jsonb_set(columns_json,'{0,primary_key_position}','true'::jsonb) where (dataset,original_table)=(select dataset,original_table from public.backup_schema)", "update garmin.source_schemas s set columns_json=b.columns_json from public.backup_schema b where (s.dataset,s.original_table)=(b.dataset,b.original_table)"],
      ['metadata 중첩 숫자와 boolean', 'inventory', "update garmin.input_inventory set metadata=jsonb_set(metadata,'{fields,fields,weight,quality,nested,0}','true'::jsonb) where (dataset,category)=(select dataset,category from public.backup_input)", "update garmin.input_inventory i set metadata=b.metadata from public.backup_input b where (i.dataset,i.category)=(b.dataset,b.category)"],
      ['metadata 중첩 0과 false', 'inventory', "update garmin.input_inventory set metadata=jsonb_set(metadata,'{fields,fields,weight,quality,nested,1}','false'::jsonb) where (dataset,category)=(select dataset,category from public.backup_input)", "update garmin.input_inventory i set metadata=b.metadata from public.backup_input b where (i.dataset,i.category)=(b.dataset,b.category)"],
      ['보존 값', 'preserved', "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set values_json='{}' where id=(select id from public.backup_preserved); alter table garmin.preserved_rows enable trigger user", "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set values_json=b.values_json from public.backup_preserved b where p.id=b.id; alter table garmin.preserved_rows enable trigger user"],
      ['자연키 누락과 과잉', 'preserved', "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set original_key=original_key || '-extra' where id=(select id from public.backup_preserved); alter table garmin.preserved_rows enable trigger user", "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set original_key=b.original_key from public.backup_preserved b where p.id=b.id; alter table garmin.preserved_rows enable trigger user"],
      ['건강 수치', 'health', "alter table brain.health_observations disable trigger user; update brain.health_observations set value=value+1 where id=(select id from public.backup_health); alter table brain.health_observations enable trigger user", "alter table brain.health_observations disable trigger user; update brain.health_observations h set value=b.value from public.backup_health b where h.id=b.id; alter table brain.health_observations enable trigger user"],
      ['건강 NULL', 'health', "alter table brain.health_observations disable trigger user; update brain.health_observations set value=null where id=(select id from public.backup_health); alter table brain.health_observations enable trigger user", "alter table brain.health_observations disable trigger user; update brain.health_observations h set value=b.value from public.backup_health b where h.id=b.id; alter table brain.health_observations enable trigger user"],
      ['건강 단위', 'health', "alter table brain.health_observations disable trigger user; update brain.health_observations set unit='wrong' where id=(select id from public.backup_health); alter table brain.health_observations enable trigger user", "alter table brain.health_observations disable trigger user; update brain.health_observations h set unit=b.unit from public.backup_health b where h.id=b.id; alter table brain.health_observations enable trigger user"],
      ['건강 JSON', 'health', "alter table brain.health_observations disable trigger user; update brain.health_observations set value_type='json',value=null,value_json='{\"type\":\"Buffer\",\"data\":[0,255]}'::jsonb where id=(select id from public.backup_health); alter table brain.health_observations enable trigger user", "alter table brain.health_observations disable trigger user; update brain.health_observations h set value_type=b.value_type,value=b.value,value_json=b.value_json from public.backup_health b where h.id=b.id; alter table brain.health_observations enable trigger user"],
      ['파일 위치 삭제', 'files', "alter table brain.files disable trigger user; update brain.files set home_location_id=null where id=(select id from public.backup_file); alter table brain.files enable trigger user", "alter table brain.files disable trigger user; update brain.files f set home_location_id=b.home_location_id from public.backup_file b where f.id=b.id; alter table brain.files enable trigger user"],
      ['파일 가림', 'files', "alter table brain.files disable trigger user; update brain.files set redacted_at=now() where id=(select id from public.backup_file); alter table brain.files enable trigger user", "alter table brain.files disable trigger user; update brain.files f set redacted_at=b.redacted_at from public.backup_file b where f.id=b.id; alter table brain.files enable trigger user"],
      ['파일 대기', 'files', "delete from brain.file_request_results where request_id=(select request_id from public.backup_result)", "insert into brain.file_request_results select * from public.backup_result"],
      ['파일 실패', 'files', "update brain.file_request_results set file_id=null,error_code='SYNTHETIC' where request_id=(select request_id from public.backup_result)", "update brain.file_request_results r set file_id=b.file_id,error_code=b.error_code from public.backup_result b where r.request_id=b.request_id"],
      ['원문', 'raw', "alter table garmin.raw_payloads disable trigger user; update garmin.raw_payloads set body='altered' where (dataset,raw_identity)=(select dataset,raw_identity from public.backup_raw); alter table garmin.raw_payloads enable trigger user", "alter table garmin.raw_payloads disable trigger user; update garmin.raw_payloads r set body=b.body from public.backup_raw b where r.dataset=b.dataset and r.raw_identity=b.raw_identity; alter table garmin.raw_payloads enable trigger user"],
      ['legacy', 'legacy', "alter table brain.channel_legacy_notifications disable trigger user; update brain.channel_legacy_notifications set detail='altered' where id=(select id from public.backup_legacy); alter table brain.channel_legacy_notifications enable trigger user", "alter table brain.channel_legacy_notifications disable trigger user; update brain.channel_legacy_notifications n set detail=b.detail from public.backup_legacy b where n.id=b.id; alter table brain.channel_legacy_notifications enable trigger user"],
      ['dataset 부모', 'preserved', "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows set run_id=null where id=(select id from public.backup_parent); alter table garmin.preserved_rows enable trigger user", "alter table garmin.preserved_rows disable trigger user; update garmin.preserved_rows p set run_id=b.run_id from public.backup_parent b where p.id=b.id; alter table garmin.preserved_rows enable trigger user"],
      ['분석 flag', 'analyses', "alter table brain.analyses disable trigger user; update brain.analyses set model='altered',model_missing=false where id=(select id from public.backup_analysis); alter table brain.analyses enable trigger user", "alter table brain.analyses disable trigger user; update brain.analyses a set model=b.model,model_missing=b.model_missing from public.backup_analysis b where a.id=b.id; alter table brain.analyses enable trigger user"],
      ['분석 원문', 'analyses', "alter table brain.analyses disable trigger user; update brain.analyses set summary='altered' where id=(select id from public.backup_evaluation); alter table brain.analyses enable trigger user", "alter table brain.analyses disable trigger user; update brain.analyses a set summary=b.summary from public.backup_evaluation b where a.id=b.id; alter table brain.analyses enable trigger user"],
      ['제외 사유', 'inventory', "update garmin.artifact_inventory set exclusion_reason='altered' where (dataset,original_table,artifact_key)=(select dataset,original_table,artifact_key from public.backup_inventory)", "update garmin.artifact_inventory a set exclusion_reason=b.exclusion_reason from public.backup_inventory b where (a.dataset,a.original_table,a.artifact_key)=(b.dataset,b.original_table,b.artifact_key)"],
      ['발행 사유', 'provenance', "update garmin.import_provenance set reason='altered' where (dataset,original_table,original_key,metric)=(select dataset,original_table,original_key,metric from public.backup_provenance)", "update garmin.import_provenance a set reason=b.reason from public.backup_provenance b where (a.dataset,a.original_table,a.original_key,a.metric)=(b.dataset,b.original_table,b.original_key,b.metric)"],
      ['충돌 원장', 'conflicts', `insert into garmin.import_conflicts select '${ids.next()}',dataset,batch,original_table,original_key,'synthetic-conflict',now() from public.backup_mapping`, "delete from garmin.import_conflicts where reason='synthetic-conflict'"],
      ['분석 관계', 'relations', "alter table brain.analysis_artifacts disable trigger user; update brain.analysis_artifacts set role='source_file' where id=(select id from public.backup_relation); alter table brain.analysis_artifacts enable trigger user", "alter table brain.analysis_artifacts disable trigger user; update brain.analysis_artifacts a set role=b.role from public.backup_relation b where a.id=b.id; alter table brain.analysis_artifacts enable trigger user"],
      ['권위', 'authority', "alter table brain.health_authority_rules disable trigger user; update brain.health_authority_rules set datasets=array_reverse(datasets) where id=(select id from public.backup_authority); alter table brain.health_authority_rules enable trigger user", "alter table brain.health_authority_rules disable trigger user; update brain.health_authority_rules a set datasets=b.datasets from public.backup_authority b where a.id=b.id; alter table brain.health_authority_rules enable trigger user"],
      ['mapping 과잉', 'mappings', "insert into garmin.import_mapping select dataset,original_table,original_key || '-extra',target_kind,target_id,content_hash,batch from public.backup_mapping", "delete from garmin.import_mapping where original_key=(select original_key || '-extra' from public.backup_mapping)"],
      ['mapping 삭제', 'mappings', "delete from garmin.import_mapping where (dataset,original_table,original_key,target_kind)=(select dataset,original_table,original_key,target_kind from public.backup_mapping)", "insert into garmin.import_mapping select * from public.backup_mapping"],
    ];
    for (const [label, check, change, restore] of cases) {
      await fixture.db.query(change!);
      try {
        const stateBefore = await fixture.db.rows(snapshotSql);
        const altered = await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(altered.code, `${label}: ${altered.stdout}${altered.stderr}`).not.toBe(0);
        expect(altered.body.data.report.checks[check!], label).toBe(false);
        const publicReport = await readFile(join(fixture.home,'extensions/garmin/reports',altered.body.data.work_id,'public.json'),'utf8');
        expect(JSON.parse(publicReport)).toEqual(altered.body.data.report);
        checkPublic(altered.stdout + altered.stderr + publicReport);
        expect(await fixture.db.rows(snapshotSql), label).toEqual(stateBefore);
        const failurePrivate = join(fixture.home,'extensions/garmin/reports',altered.body.data.work_id,'private.json');
        const failureProjection = execFileSync(python,['-c',"import json,sys; sys.path.insert(0,sys.argv[1]); from verify_compare import public_projection; print(json.dumps(public_projection(json.load(open(sys.argv[2])))))",join(fixture.home,'extensions/garmin/src'),failurePrivate],{encoding:'utf8'});
        expect(JSON.parse(failureProjection)).toEqual(altered.body.data.report); checkPublic(failureProjection);
      } finally { await fixture.db.query(restore!); }
    }
    const before = await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,content_hash from garmin.import_mapping order by dataset,original_table,original_key,target_kind');
    const again = await fixture.run(['ext','run','garmin','import','--json']);
    expect(again.code,again.stdout+again.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${again.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('succeeded');
    expect(await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,content_hash from garmin.import_mapping order by dataset,original_table,original_key,target_kind')).toEqual(before);
    const repeated = await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(repeated.code,repeated.stdout+repeated.stderr).toBe(0);
    expect(repeated.body.data.report.counts).toMatchObject({outbound_requests:0,outbound_results:0});
    const source = join(root,'D1.db'), sourceBytes = await readFile(source);
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"update evaluation set model='other'\"); c.commit(); c.close()",source]);
    try {
      const changed = await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(changed.code).not.toBe(0); expect(changed.body.data.report.checks.source_unchanged).toBe(false);
    } finally { await writeFile(source,sourceBytes); }
    await writeFile(source+'-wal',Buffer.from('synthetic'));
    try {
      const wal = await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(wal.code).not.toBe(0); expect(wal.body.data.report.checks.source_unchanged).toBe(false);
    } finally { await unlink(source+'-wal'); }
    const blob = (await fixture.db.rows("select l.locator from brain.file_requests q join brain.file_request_results r on r.request_id=q.id join brain.files f on f.id=r.file_id join brain.file_locations l on l.id=f.home_location_id limit 1"))[0]!.locator as string;
    const filePath = join(fixture.home,'files',blob), bytes = await readFile(filePath);
    await unlink(filePath);
    try {
      const missing = await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(missing.code).not.toBe(0); expect(missing.body.data.report.checks.files).toBe(false);
    } finally { await writeFile(filePath,bytes); }
    const corrupted = Buffer.from(bytes); corrupted[0] = corrupted[0]! ^ 1; await writeFile(filePath,corrupted);
    try {
      const damaged = await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(damaged.code).not.toBe(0); expect(damaged.body.data.report.checks.files).toBe(false);
    } finally { await writeFile(filePath,bytes); }

  } finally { controller.abort(); if (daemon) await daemon; await store.close(); await fixture.cleanup(); }
}, 180000);

it.each(['precise', 'tamper'] as const)('분석 생성 시각 마이크로초 %s', async mode => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; artifact_capture(pathlib.Path(sys.argv[2]))",fixtures,root]);
    const path=join(root,'manifest.json'), capture=JSON.parse(await readFile(path,'utf8'));
    capture.files.find((f:any)=>f.artifact_key==='facts').created_at=mode==='precise'?'2026-01-02T03:04:05.123456+09:00':'2026-01-02T03:04:05.123000+09:00';
    await writeFile(path,JSON.stringify(capture));
    const channel=ids.next(), conversation=ids.next();
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imported=await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code,imported.stdout+imported.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:25000}).toBe(0);
    const first=await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(first.code,first.stdout+first.stderr).toBe(0);
    expect(first.body.data.report.checks.analyses).toBe(true);
    // 같은 instant의 다른 시간대 표현은 정상이다.
    await fixture.db.query("alter table brain.analyses disable trigger user; update brain.analyses set created_at=created_at at time zone 'UTC' at time zone 'UTC' where original_table='artifact' and original_key='facts'; alter table brain.analyses enable trigger user");
    const equivalent=await fixture.run(['ext','run','garmin','import-verify','--json']); expect(equivalent.code,equivalent.stdout+equivalent.stderr).toBe(0);
    await fixture.db.query("alter table brain.analyses disable trigger user; update brain.analyses set created_at=created_at+interval '1 microsecond' where original_table='artifact' and original_key='facts'; alter table brain.analyses enable trigger user");
    const before=await fixture.db.rows("select created_at::text as created_at from brain.analyses where original_table='artifact' and original_key='facts'");
    const altered=await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(altered.code).not.toBe(0); expect(altered.body.data.report.checks.analyses).toBe(false);
    expect(await fixture.db.rows("select created_at::text as created_at from brain.analyses where original_table='artifact' and original_key='facts'")).toEqual(before);
    const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',altered.body.data.work_id,'public.json'),'utf8');
    for (const secret of ['synthetic-D1','2026-01-02','12345','합성']) expect(first.stdout+first.stderr+equivalent.stdout+equivalent.stderr+altered.stdout+altered.stderr+publicReport).not.toContain(secret);
    expect(JSON.parse(publicReport)).toEqual(altered.body.data.report);
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it.each(['file','parent'] as const)('원본 SQLite의 첫 읽기 직전 %s symlink 교체를 거부한다', async boundary => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; p=pathlib.Path(sys.argv[2]); capture_manifest(p,five_candidates(p))",fixtures,root]);
    const path=join(root,'manifest.json'), target=await realpath(join(root,'D1.db')), external=join(fixture.home,'external.db'), marker=join(fixture.home,'external-opened'); await copyFile(target,external);
    const captureDir=await realpath(root), externalDir=join(fixture.home,'external-capture'); await cp(root,externalDir,{recursive:true});
    const swapped=boundary==='file'?target:captureDir, swapDestination=boundary==='file'?external:externalDir;
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(path),updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imported=await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code,imported.stdout+imported.stderr).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');
    const script=join(fixture.home,'extensions/garmin/src/import_verify.py');
    let source=await readFile(script,'utf8');
    const instrumentation=`
# 격리 시험 전용: 원본 첫 열기 직전에만 경로를 교체한다.
import pathlib, inspect
_target=${JSON.stringify(swapped)}
_external=${JSON.stringify(swapDestination)}
_boundary=${JSON.stringify(boundary)}
_source=${JSON.stringify(target)}
_marker=${JSON.stringify(marker)}
_done=False
_old_path_open=pathlib.Path.open
_old_os_open=os.open
def _swap(call):
    global _done
    _done=True
    with _old_path_open(pathlib.Path(_marker+'-attempt'),'w') as f: f.write('attempted')
    os.rename(_target,_target+'.held')
    os.symlink(_external,_target)
    try:
        result=call()
        with _old_path_open(pathlib.Path(_marker),'w') as f: f.write('opened')
        return result
    finally:
        os.unlink(_target)
        os.rename(_target+'.held',_target)
def _path_open(self,*a,**kw):
    if not _done and str(self)==_source and any(f.function=='digest_file' for f in inspect.stack()): return _swap(lambda:_old_path_open(self,*a,**kw))
    return _old_path_open(self,*a,**kw)
def _os_open(path,flags,*a,**kw):
    if not _done and str(path)==('D1.db' if _boundary=='file' else 'capture') and any(f.function=='read_source' for f in inspect.stack()) and any(f.function=='compare' for f in inspect.stack()): return _swap(lambda:_old_os_open(path,flags,*a,**kw))
    return _old_os_open(path,flags,*a,**kw)
pathlib.Path.open=_path_open
os.open=_os_open
`;
    source=source.replace('\ntry:\n    main()',instrumentation+'\ntry:\n    main()'); await writeFile(script,source);
    const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
    expect(result.code,result.stdout+result.stderr).not.toBe(0); expect(result.body.data.report.checks.source_unchanged).toBe(false);
    expect(await readFile(marker+'-attempt','utf8')).toBe('attempted');
    await expect(readFile(marker,'utf8')).rejects.toMatchObject({code:'ENOENT'});
    const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
    for (const secret of [target,external,'synthetic-D1','2026-01-01','12345']) expect(result.stdout+result.stderr+publicReport).not.toContain(secret);
    expect(JSON.parse(publicReport)).toEqual(result.body.data.report);
    const sourceBytes=await readFile(target); expect(await readFile(external)).toEqual(sourceBytes);
    await writeFile(script,source.replace(instrumentation,''));
    try {
      await writeFile(target,Buffer.alloc(sourceBytes.length));
      const corrupt=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(corrupt.code).not.toBe(0); expect(corrupt.body.data.report.checks.source_unchanged).toBe(false);
      const report=await readFile(join(fixture.home,'extensions/garmin/reports',corrupt.body.data.work_id,'public.json'),'utf8');
      for (const secret of [target,external,'synthetic-D1']) expect(corrupt.stdout+corrupt.stderr+report).not.toContain(secret);
    } finally {await writeFile(target,sourceBytes);}
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('schema10/15, v1 및 evaluation 부재를 검증하고 미할당 파일을 표시한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib; sys.path.insert(0,sys.argv[1]); from fixtures import five_candidates,capture_manifest; p=pathlib.Path(sys.argv[2]); capture_manifest(p,five_candidates(p))",fixtures,root]);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imported=await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('succeeded');
    const verified=await fixture.run(['ext','run','garmin','import-verify','--json']); expect(verified.code,verified.stdout+verified.stderr).toBe(0);
    expect(verified.body.data.report.counts).toMatchObject({datasets:5,analysis_rows:0,file_requests:0,artifacts:0,unassigned_files:1,mismatches:0});
  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},90000);

it('이전 capture mapping 재사용과 현재 논리 범위의 이전 batch 과잉을 구분한다', async () => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    execFileSync(python,['-c',"import sys,pathlib,sqlite3; sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture; p=pathlib.Path(sys.argv[2]); artifact_capture(p); c=sqlite3.connect(p/'D1.db'); c.execute(\"insert into meta values ('old-only','history')\"); c.execute(\"insert into raw_response select scope,key,'old-only',raw,fetched_at,checked_at,library_version from raw_response limit 1\"); c.commit(); c.close()",fixtures,root]);
    const manifestPath=join(root,'manifest.json'), channel=ids.next(), conversation=ids.next();
    const oldReport=Buffer.from('# old unrelated\n'), oldImage=Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1]);
    await writeFile(join(root,'old-report.md'),oldReport); await writeFile(join(root,'old-image.png'),oldImage);
    const evaluationKey=execFileSync(python,['-c',"import sys; sys.path.insert(0,sys.argv[1]); from reader import read_snapshot; from batch_import import canonical,encoded; t=read_snapshot(sys.argv[2])['tables']['evaluation']; print(canonical([encoded(t['rows'][0][k]) for k in t['keys']]))",join(fixture.home,'extensions/garmin/src'),join(root,'D1.db')],{encoding:'utf8'}).trim();
    const collisionKey='evaluation:'+evaluationKey, collisionBytes=Buffer.from('# 별도 artifact\n');
    await writeFile(join(root,'namespace.md'),collisionBytes);
    const captureA=JSON.parse(await readFile(manifestPath,'utf8'));
    captureA.files.push({source:'old-report.md',snapshot:'old-report.md',bytes:oldReport.length,dataset:'synthetic-D1',artifact_key:'old-report',category:'report',relations:[]}, {source:'old-image.png',snapshot:'old-image.png',bytes:oldImage.length,dataset:'synthetic-D1',artifact_key:'old-image',category:'image',relations:[{analysis_key:'old-report',role:'image'}]});
    captureA.files.push({source:'namespace.md',snapshot:'namespace.md',bytes:collisionBytes.length,dataset:'synthetic-D1',artifact_key:collisionKey,category:'report',relations:[]});
    await writeFile(manifestPath,JSON.stringify(captureA));
    await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(manifestPath),updatedAt:new Date()});
    await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const importCapture=async()=>{const result=await fixture.run(['ext','run','garmin','import','--json']); expect(result.code,result.stdout+result.stderr).toBe(0); await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${result.body.data.work_id}'`))[0]?.outcome,{timeout:30000}).toBe('succeeded');};
    await importCapture();
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:20000}).toBe(0);
    const beforeMappings=await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,batch from garmin.import_mapping order by dataset,original_table,original_key,target_kind');
    const changed=JSON.parse(await readFile(manifestPath,'utf8')); changed.capture_id='synthetic-capture-B'; changed.files=changed.files.filter((file:any)=>!['safe','old-report','old-image'].includes(file.artifact_key));
    await writeFile(manifestPath,JSON.stringify(changed));
    execFileSync(python,['-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"delete from meta where key='old-only'\"); c.execute(\"delete from raw_response where endpoint='old-only'\"); c.commit(); c.close()",join(root,'D1.db')]);
    await importCapture();
    const normal=await fixture.run(['ext','run','garmin','import-verify','--json']); expect(normal.code,normal.stdout+normal.stderr).toBe(0);
    expect(await fixture.db.rows('select dataset,original_table,original_key,target_kind,target_id,batch from garmin.import_mapping order by dataset,original_table,original_key,target_kind')).toEqual(beforeMappings);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.preserved_rows where values_json->'key'->>'base64'='b2xkLW9ubHk=' ")).toEqual([{n:1}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_inventory where artifact_key in ('safe','old-report','old-image')")).toEqual([{n:3}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_relations where artifact_key='old-image' and analysis_key='old-report'")).toEqual([{n:1}]);
    expect(await fixture.db.rows("select count(*)::int as n from garmin.raw_payloads where dataset='synthetic-D1' and endpoint='old-only'")).toEqual([{n:1}]);
    await fixture.db.query("insert into garmin.raw_payloads select (jsonb_populate_record(null::garmin.raw_payloads,to_jsonb(r)||jsonb_build_object('raw_identity','synthetic-extra','body','synthetic altered body'))).* from garmin.raw_payloads r where dataset='synthetic-D1' and endpoint <> 'old-only' and body_raw is null limit 1");
    try {
      const before=await fixture.db.rows("select raw_identity,body,batch from garmin.raw_payloads where raw_identity='synthetic-extra'"); expect(before).toHaveLength(1);
      const excess=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(excess.code).not.toBe(0); expect(excess.body.data.report.checks.raw).toBe(false);
      const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',excess.body.data.work_id,'public.json'),'utf8');
      for (const secret of ['synthetic-D1','2026-01-01','12345','synthetic altered body']) expect(excess.stdout+excess.stderr+publicReport).not.toContain(secret);
      expect(JSON.parse(publicReport)).toEqual(excess.body.data.report);
      expect(await fixture.db.rows("select raw_identity,body,batch from garmin.raw_payloads where raw_identity='synthetic-extra'")).toEqual(before);
    } finally {await fixture.db.query("delete from garmin.raw_payloads where raw_identity='synthetic-extra'");}
    for (const field of ['request_id','analysis_id'] as const) {
      await fixture.db.query(`update garmin.artifact_relations r set ${field}=i.${field} from garmin.artifact_inventory i where r.artifact_key='old-image' and r.analysis_key='old-report' and i.dataset=r.dataset and i.original_table='artifact' and i.artifact_key='report'`);
      try {
        const before=await fixture.db.rows("select artifact_key,analysis_key,request_id,analysis_id from garmin.artifact_relations where artifact_key='old-image' and analysis_key='old-report'"); expect(before).toHaveLength(1);
        const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
        expect(result.code).not.toBe(0); expect(result.body.data.report.checks.relations).toBe(false);
        const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
        for (const secret of ['synthetic-D1','2026-01-01','12345']) expect(result.stdout+result.stderr+publicReport).not.toContain(secret);
        expect(await fixture.db.rows("select artifact_key,analysis_key,request_id,analysis_id from garmin.artifact_relations where artifact_key='old-image' and analysis_key='old-report'")).toEqual(before);
        expect(result.stdout+result.stderr).not.toContain('synthetic-D1');
      } finally {
        const original=field==='request_id'?'old-image':'old-report';
        await fixture.db.query(`update garmin.artifact_relations r set ${field}=i.${field} from garmin.artifact_inventory i where r.artifact_key='old-image' and r.analysis_key='old-report' and i.dataset=r.dataset and i.original_table='artifact' and i.artifact_key='${original}'`);
      }
    }
    await fixture.db.query("insert into garmin.datasets select (jsonb_populate_record(null::garmin.datasets,to_jsonb(d)||jsonb_build_object('dataset','synthetic-C'))).* from garmin.datasets d where dataset='synthetic-D1'; insert into garmin.import_batches select (jsonb_populate_record(null::garmin.import_batches,to_jsonb(b)||jsonb_build_object('id','synthetic-batch-C','dataset','synthetic-C'))).* from garmin.import_batches b where dataset='synthetic-D1' limit 1; insert into garmin.artifact_inventory(dataset,original_table,artifact_key,batch,category,metadata) values ('synthetic-C','artifact','unrelated-C','synthetic-batch-C','unknown','{}'); insert into garmin.artifact_relations(dataset,artifact_key,analysis_key,role,reason) values ('synthetic-C','unrelated-C','unrelated-analysis','image','analysis_unavailable')");
    const unrelated=await fixture.run(['ext','run','garmin','import-verify','--json']); expect(unrelated.code,unrelated.stdout+unrelated.stderr).toBe(0);
    for (const kind of ['mapping','request','analysis','relation','inventory','internal'] as const) {
      const ident=ids.next();
      const setup={
        mapping:`insert into garmin.import_mapping select 'synthetic-C','artifact','extra-C','artifact_file',target_id,content_hash,'synthetic-batch-C' from garmin.import_mapping where dataset='synthetic-D1' and original_table='artifact' and original_key='report' and target_kind='artifact_file'`,
        request:`alter table brain.file_requests disable trigger user; insert into brain.file_requests select (jsonb_populate_record(null::brain.file_requests,to_jsonb(q)||jsonb_build_object('id','${ident}','dataset','synthetic-C','import_batch','synthetic-batch-C','request_key',q.request_key || ' '))).* from brain.file_requests q where q.request_key::jsonb->>2='report'; alter table brain.file_requests enable trigger user; insert into brain.file_request_handoffs(request_id,work_item_id) select '${ident}',h.work_item_id from brain.file_request_handoffs h join brain.file_requests q on q.id=h.request_id where q.request_key::jsonb->>2='report' limit 1`,
        analysis:`alter table brain.analyses disable trigger user; insert into brain.analyses select (jsonb_populate_record(null::brain.analyses,to_jsonb(a)||jsonb_build_object('id','${ident}','dataset','synthetic-C','import_batch','synthetic-batch-C','original_key','extra-C'))).* from brain.analyses a where a.original_table='artifact' and a.original_key='report'; alter table brain.analyses enable trigger user`,
        relation:`alter table brain.analysis_artifacts disable trigger user; insert into brain.analysis_artifacts select (jsonb_populate_record(null::brain.analysis_artifacts,to_jsonb(r)||jsonb_build_object('id','${ident}','dataset','synthetic-C','import_batch','synthetic-batch-C','role','source_file'))).* from brain.analysis_artifacts r join brain.analyses a on a.id=r.analysis_id where a.original_key='report' and r.role='primary'; alter table brain.analysis_artifacts enable trigger user`,
        inventory:`insert into garmin.artifact_inventory(dataset,original_table,artifact_key,batch,category,request_id,metadata) select 'synthetic-C','artifact','extra-C','synthetic-batch-C','report',request_id,'{}' from garmin.artifact_inventory where dataset='synthetic-D1' and artifact_key='report'`,
        internal:`update garmin.artifact_relations r set request_id=i.request_id from garmin.artifact_inventory i where r.dataset='synthetic-C' and i.dataset='synthetic-D1' and i.artifact_key='report'`,
      }[kind];
      const cleanup={mapping:"delete from garmin.import_mapping where dataset='synthetic-C' and original_key='extra-C'",request:`delete from brain.file_request_handoffs where request_id='${ident}'; alter table brain.file_requests disable trigger user; delete from brain.file_requests where id='${ident}'; alter table brain.file_requests enable trigger user`,analysis:`alter table brain.analyses disable trigger user; delete from brain.analyses where id='${ident}'; alter table brain.analyses enable trigger user`,relation:`alter table brain.analysis_artifacts disable trigger user; delete from brain.analysis_artifacts where id='${ident}'; alter table brain.analysis_artifacts enable trigger user`,inventory:"delete from garmin.artifact_inventory where dataset='synthetic-C' and artifact_key='extra-C'",internal:"update garmin.artifact_relations set request_id=null where dataset='synthetic-C'"}[kind];
      const sql={mapping:"select * from garmin.import_mapping where dataset='synthetic-C' and original_key='extra-C'",request:`select * from brain.file_requests where id='${ident}'`,analysis:`select * from brain.analyses where id='${ident}'`,relation:`select * from brain.analysis_artifacts where id='${ident}'`,inventory:"select * from garmin.artifact_inventory where dataset='synthetic-C' and artifact_key='extra-C'",internal:"select * from garmin.artifact_relations where dataset='synthetic-C'"}[kind];
      await fixture.db.query(setup);
      try {
        const before=await fixture.db.rows(sql); expect(before,kind).toHaveLength(1);
        const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
        const check={mapping:'mappings',request:'files',analysis:'analyses',relation:'relations',inventory:'inventory',internal:'relations'}[kind];
        expect(result.code,`${kind}: ${result.stdout}${result.stderr}`).not.toBe(0); expect(result.body.data.report.checks[check],kind).toBe(false);
        const publicReport=await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
        for (const secret of ['synthetic-C','synthetic-D1','2026-01-01','12345']) expect(result.stdout+result.stderr+publicReport).not.toContain(secret);
        expect(JSON.parse(publicReport)).toEqual(result.body.data.report); expect(await fixture.db.rows(sql),kind).toEqual(before);
      } finally {await fixture.db.query(cleanup);}
    }
    expect((await fixture.run(['ext','run','garmin','import-verify','--json'])).code).toBe(0);
    const outcomes: {label:string;code:number|null;check:unknown}[]=[];
    for (const kind of ['health','analysis','request','relation'] as const) {
      const ident=ids.next();
      const setup={
        health:`alter table brain.health_observations disable trigger user; insert into brain.health_observations select (jsonb_populate_record(null::brain.health_observations,to_jsonb(h)||jsonb_build_object('id','${ident}','metric','daily_metric.readiness_score','unit','score','value',50))).* from brain.health_observations h where h.metric='daily_metric.steps' and h.dataset='synthetic-D1' limit 1; alter table brain.health_observations enable trigger user; insert into garmin.import_mapping select dataset,original_table,original_key,'health:daily_metric.readiness_score','${ident}',content_hash,batch from garmin.import_mapping where dataset='synthetic-D1' and target_kind='preserved' and original_table='daily_metric' limit 1`,
        analysis:`alter table brain.analyses disable trigger user; insert into brain.analyses select (jsonb_populate_record(null::brain.analyses,to_jsonb(a)||jsonb_build_object('id','${ident}','revision',2))).* from brain.analyses a where a.original_table='artifact' and a.original_key='report'; alter table brain.analyses enable trigger user`,
        request:`alter table brain.file_requests disable trigger user; insert into brain.file_requests select (jsonb_populate_record(null::brain.file_requests,to_jsonb(q)||jsonb_build_object('id','${ident}','request_key',q.request_key || ' '))).* from brain.file_requests q where q.request_key::jsonb->>2='report'; alter table brain.file_requests enable trigger user; insert into brain.file_request_handoffs(request_id,work_item_id) select '${ident}',h.work_item_id from brain.file_request_handoffs h join brain.file_requests q on q.id=h.request_id where q.request_key::jsonb->>2='report' limit 1`,
        relation:`alter table brain.analysis_artifacts disable trigger user; insert into brain.analysis_artifacts select (jsonb_populate_record(null::brain.analysis_artifacts,to_jsonb(r)||jsonb_build_object('id','${ident}','role','source_file'))).* from brain.analysis_artifacts r join brain.analyses a on a.id=r.analysis_id where a.original_key='report' and r.role='primary'; alter table brain.analysis_artifacts enable trigger user`,
      }[kind];
      const cleanup={health:`delete from garmin.import_mapping where target_id='${ident}'; alter table brain.health_observations disable trigger user; delete from brain.health_observations where id='${ident}'; alter table brain.health_observations enable trigger user`,analysis:`alter table brain.analyses disable trigger user; delete from brain.analyses where id='${ident}'; alter table brain.analyses enable trigger user`,request:`delete from brain.file_request_handoffs where request_id='${ident}'; alter table brain.file_requests disable trigger user; delete from brain.file_requests where id='${ident}'; alter table brain.file_requests enable trigger user`,relation:`alter table brain.analysis_artifacts disable trigger user; delete from brain.analysis_artifacts where id='${ident}'; alter table brain.analysis_artifacts enable trigger user`}[kind];
      await fixture.db.query(setup);
      try {
        const excess=await fixture.run(['ext','run','garmin','import-verify','--json']);
        const check=kind==='health'?'mappings':kind==='analysis'?'analyses':kind==='request'?'files':'relations';
        outcomes.push({label:kind,code:excess.code,check:excess.body?.data?.report?.checks?.[check]});
        expect(await fixture.db.rows(`select count(*)::int as n from ${kind==='health'?'brain.health_observations':kind==='analysis'?'brain.analyses':kind==='request'?'brain.file_requests':'brain.analysis_artifacts'} where id='${ident}'`)).toEqual([{n:1}]);
        expect(excess.stdout+excess.stderr).not.toContain('synthetic-D1');
      } finally {await fixture.db.query(cleanup);}
    }
    expect(outcomes).toEqual([{label:'health',code:2,check:false},{label:'analysis',code:2,check:false},{label:'request',code:2,check:false},{label:'relation',code:2,check:false}]);
    const inventoryOutcomes: {label:string;code:number|null;check:unknown}[]=[];
    await fixture.db.query("insert into garmin.artifact_inventory(dataset,original_table,artifact_key,batch,category,content_hash,size_bytes,exclusion_reason,metadata) select dataset,'evaluation','evaluation:' || original_key,batch,'report',repeat('a',64),1,'too_large',jsonb_build_object('original_table','evaluation','original_key',original_key) from garmin.import_mapping where dataset='synthetic-D1' and original_table='evaluation' and target_kind='preserved' limit 1");
    try {
      const before=await fixture.db.rows("select dataset,original_table,artifact_key,batch,exclusion_reason from garmin.artifact_inventory where original_table='evaluation'");
      expect(before).toHaveLength(1); expect(before[0]!.artifact_key).toBe(collisionKey);
      const excessInventory=await fixture.run(['ext','run','garmin','import-verify','--json']);
      inventoryOutcomes.push({label:'evaluation',code:excessInventory.code,check:excessInventory.body.data.report.checks.inventory});
      expect(await fixture.db.rows("select dataset,original_table,artifact_key,batch,exclusion_reason from garmin.artifact_inventory where original_table='evaluation'")).toEqual(before);
      expect(excessInventory.stdout+excessInventory.stderr).not.toContain('synthetic-D1');
    } finally {await fixture.db.query("delete from garmin.artifact_inventory where original_table='evaluation' and exclusion_reason='too_large'");}
    await fixture.db.query("insert into garmin.artifact_inventory(dataset,original_table,artifact_key,batch,category,content_hash,size_bytes,request_id,analysis_id,metadata) select dataset,'artifact','old-linked-extra',batch,'report',repeat('b',64),1,request_id,analysis_id,'{}'::jsonb from garmin.artifact_inventory where dataset='synthetic-D1' and original_table='artifact' and artifact_key='report'");
    try {
      const before=await fixture.db.rows("select dataset,artifact_key,batch,request_id,analysis_id from garmin.artifact_inventory where artifact_key='old-linked-extra'");
      const linkedInventory=await fixture.run(['ext','run','garmin','import-verify','--json']);
      inventoryOutcomes.push({label:'linked',code:linkedInventory.code,check:linkedInventory.body.data.report.checks.inventory});
      expect(await fixture.db.rows("select dataset,artifact_key,batch,request_id,analysis_id from garmin.artifact_inventory where artifact_key='old-linked-extra'")).toEqual(before);
      expect(linkedInventory.stdout+linkedInventory.stderr).not.toContain('synthetic-D1');
    } finally {await fixture.db.query("delete from garmin.artifact_inventory where artifact_key='old-linked-extra'");}
    expect(inventoryOutcomes).toEqual([{label:'evaluation',code:2,check:false},{label:'linked',code:2,check:false}]);
    await fixture.db.query("insert into garmin.import_provenance select dataset,original_table,original_key,'synthetic.extra','발행' from garmin.import_provenance where dataset='synthetic-D1' and original_table='daily_metric' limit 1");
    try {
      const provenance=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(provenance.code).not.toBe(0); expect(provenance.body.data.report.checks.provenance).toBe(false);
      expect(await fixture.db.rows("select count(*)::int as n from garmin.import_provenance where metric='synthetic.extra'")).toEqual([{n:1}]);
    } finally {await fixture.db.query("delete from garmin.import_provenance where metric='synthetic.extra'");}
    await fixture.db.query("insert into garmin.artifact_relations select dataset,artifact_key,artifact_key,'source_file',request_id,analysis_id,null from garmin.artifact_inventory where dataset='synthetic-D1' and original_table='artifact' and artifact_key='report'");
    try {
      const related=await fixture.run(['ext','run','garmin','import-verify','--json']);
      expect(related.code).not.toBe(0); expect(related.body.data.report.checks.relations).toBe(false);
      expect(await fixture.db.rows("select count(*)::int as n from garmin.artifact_relations where artifact_key='report' and role='source_file'")).toEqual([{n:1}]);
    } finally {await fixture.db.query("delete from garmin.artifact_relations where artifact_key='report' and role='source_file'");}

  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);

it.each([
  ['큰 정수 정상','9007199254740993',false,false],
  ['큰 정수 변조','9007199254740992',true,false],
  ['최상위 wrapper 모양 객체','9007199254740993',false,true],
] as const)('JSONB %s을 정확하게 검증한다', async (_label, sourceNumber, mutate, wrapped) => {
  const fixture=await extHome(), store=postgresStore({databaseUrl:fixture.db.appUrl}), controller=new AbortController(), ids=uuidV7IdGen();
  let daemon: ReturnType<typeof runDaemon> | undefined;
  try {
    const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
    const python=join(fixture.home,'extensions/garmin/.venv/bin/python'), root=join(fixture.home,'capture'); await mkdir(root);
    const fixtures=fileURLToPath(new URL('../../../extensions/garmin/tests',import.meta.url));
    const script=`import sys,pathlib,sqlite3
sys.path.insert(0,sys.argv[1]); from fixtures import artifact_capture
p=pathlib.Path(sys.argv[2]); artifact_capture(p)
with sqlite3.connect(p/'D1.db') as c:
 c.execute('update daily_metric set sleep_s=?',(sys.argv[3],))
 c.execute('insert into raw_response values (?,?,?,?,?,?,?)',('day','2026-01-01','sleep_data','{\\"userProfileId\\":12345}',1700000000123,1700000000456,'test'))
 c.execute('insert into normalize_result values (?,?,?,?,?,?,?)',('day','2026-01-01','sleep_data',1,None,1700000000123,1700000000999))`;
    const source = wrapped ? '{"encoding":"jsonb-text-v1","data":"{\\"n\\":5}"}' : `{"n":${sourceNumber},"nested":{"fraction":0.1,"truth":true,"nothing":null,"one":1},"wrapper":{"encoding":"jsonb-text-v1","data":"{\\"n\\":5}"}}`;
    execFileSync(python,['-c',script,fixtures,root,source]);
    await fixture.db.query("update brain.health_catalog_v1 set definition=jsonb_set(jsonb_set(definition,'{type}',to_jsonb('json'::text)),'{unit}',to_jsonb('json'::text)) where metric='daily_metric.sleep_s'");
    const channel=ids.next(),conversation=ids.next(); await fixture.db.query(`insert into brain.channels values ('${channel}','telegram','bot'); insert into brain.channel_conversations values ('${conversation}','${channel}','chat',null)`);
    await store.setSetting({key:'garmin.capture_manifest',value:await realpath(join(root,'manifest.json')),updatedAt:new Date()}); await store.setSetting({key:'garmin.legacy_conversation_id',value:conversation,updatedAt:new Date()});
    daemon=runDaemon({home:fixture.home,env:fixture.env,clock:systemClock,idGen:ids,signal:controller.signal,drainPauseMs:25,heartbeatMs:100,supervisor:{pollMs:25}});
    const imported=await fixture.run(['ext','run','garmin','import','--json']); expect(imported.code).toBe(0);
    await expect.poll(async()=> (await fixture.db.rows(`select outcome from brain.work_items where id='${imported.body.data.work_id}'`))[0]?.outcome,{timeout:25000}).toBe('succeeded');
    await expect.poll(async()=> (await fixture.db.rows('select count(*)::int as n from brain.file_requests q left join brain.file_request_results r on r.request_id=q.id where r.file_id is null'))[0]?.n,{timeout:25000}).toBe(0);
    if(mutate) await fixture.db.query("alter table brain.health_observations disable trigger user; update brain.health_observations set value_json=jsonb_set(value_json,'{n}','9007199254740993'::jsonb) where dataset='synthetic-D1' and metric='daily_metric.sleep_s'; alter table brain.health_observations enable trigger user");
    const result=await fixture.run(['ext','run','garmin','import-verify','--json']);
    if(mutate) {expect(result.code,result.stdout+result.stderr).not.toBe(0); expect(result.body.data.report.checks.health).toBe(false);}
    else expect(result.code,result.stdout+result.stderr).toBe(0);
    const publicJson = await readFile(join(fixture.home,'extensions/garmin/reports',result.body.data.work_id,'public.json'),'utf8');
    expect(JSON.parse(publicJson)).toEqual(result.body.data.report);
    for(const secret of [sourceNumber,'synthetic-D1','2026-01-01','12345']) expect(result.stdout+result.stderr+publicJson).not.toContain(secret);
    if (!wrapped && !mutate) {
      await fixture.db.query("create table public.precision_backup as select * from brain.health_observations where dataset='synthetic-D1' and metric='daily_metric.sleep_s'");
      for (const [path, replacement, expectedSuccess] of [['{nested,fraction}','0.1000000000000000001',false],['{nested,truth}','1',false],['{nested,nothing}','false',false],['{nested,one}','1.0',true]] as const) {
        await fixture.db.query(`alter table brain.health_observations disable trigger user; update brain.health_observations set value_json=jsonb_set(value_json,'${path}','${replacement}'::jsonb) where id=(select id from public.precision_backup); alter table brain.health_observations enable trigger user`);
        try {
          const before=await fixture.db.rows("select value_json::text as value from brain.health_observations where id=(select id from public.precision_backup)");
          const observed=await fixture.run(['ext','run','garmin','import-verify','--json']);
          if(expectedSuccess) expect(observed.code,observed.stdout+observed.stderr).toBe(0);
          else {expect(observed.code,observed.stdout+observed.stderr).not.toBe(0); expect(observed.body.data.report.checks.health).toBe(false);}
          expect(await fixture.db.rows("select value_json::text as value from brain.health_observations where id=(select id from public.precision_backup)")).toEqual(before);
          const report=await readFile(join(fixture.home,'extensions/garmin/reports',observed.body.data.work_id,'public.json'),'utf8');
          expect(JSON.parse(report)).toEqual(observed.body.data.report);
          for(const secret of [sourceNumber,'synthetic-D1','2026-01-01','12345']) expect(observed.stdout+observed.stderr+report).not.toContain(secret);
        } finally {await fixture.db.query('alter table brain.health_observations disable trigger user; update brain.health_observations h set value_json=b.value_json from public.precision_backup b where h.id=b.id; alter table brain.health_observations enable trigger user');}
      }
    }

  } finally {controller.abort(); if(daemon) await daemon; await store.close(); await fixture.cleanup();}
},120000);
