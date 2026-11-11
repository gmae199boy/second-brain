import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { postgresStore } from 'second_brain/postgres';
import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm, readFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { provisionExtension, runMigrations } from 'second_brain/postgres';

it('새 설치는 core 31과 Garmin 18 및 native 표를 적용한다', async () => {
 const fixture=await extHome();
 try {
  const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
  expect((await fixture.ledger('garmin')).map(row=>row.version)).toEqual(Array.from({length:18},(_,i)=>i+1));
  expect(await fixture.ledger('core')).toContainEqual({owner:'core',version:31});
  expect(await fixture.db.rows("select to_regclass('garmin.raw_records') as raw, to_regclass('garmin.collect_state') as collect")).toEqual([{raw:null,collect:null}]);
  expect(await fixture.db.rows("select to_regclass('garmin.account_connections') is not null as accounts, to_regclass('garmin.evaluation_revisions') is not null as revisions, to_regclass('garmin.evaluation_files') is not null as files")).toEqual([{accounts:true,revisions:true,files:true}]);
 } finally {await fixture.cleanup();}
});

it('Garmin v12 이력과 보존 행을 유지하고 v13에서 옛 경로만 제거한다', async () => {
 const fixture=await extHome(), dir=await mkdtemp(join(tmpdir(),'brain-garmin-v12-'));
 const clock={now:()=>new Date('2026-01-01T00:00:00Z')};
 try {
  await provisionExtension(fixture.db.url,'garmin',randomBytes(24).toString('hex'));
  const source=new URL('../../../extensions/garmin/migrations/',import.meta.url);
  for(const file of (await readdir(source)).filter(f=>/^\d{4}_/.test(f) && f<'0013')) await copyFile(new URL(file,source),join(dir,file));
  const options={databaseUrl:fixture.db.url,clock,owners:[{owner:'garmin',directory:dir}]};
  expect(await runMigrations(options)).toMatchObject({ok:true});
  await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('synthetic','acct',true);
    insert into garmin.import_batches values ('batch','synthetic',now());
    insert into garmin.preserved_rows(id,dataset,original_table,original_key,values_json) values ('00000000-0000-4000-8000-000000000001','synthetic','meta','key','{"value":"sample"}');
    insert into garmin.raw_payloads(dataset,batch,account,scope,original_key,endpoint,fetched_at_ms,checked_at_ms,library_version,body) values ('synthetic','batch','acct','day','key','endpoint',1,2,'v','body');
    insert into garmin.import_mapping values ('synthetic','meta','key','preserved','00000000-0000-4000-8000-000000000001','hash','batch');
    insert into garmin.source_schemas values ('synthetic','meta',15,'[{"name":"value"}]','["key"]');
    insert into garmin.import_checkpoints(batch,dataset,source_hash,schema_version,importer_version,manifest_fingerprint,source_role,conversation_id) values ('batch','synthetic','hash',15,2,'fingerprint','D1','00000000-0000-4000-8000-000000000002');
    insert into garmin.import_conflicts values ('00000000-0000-4000-8000-000000000003','synthetic','batch','meta','key','synthetic',now());
    insert into garmin.legacy_conversations values ('synthetic','notification','key','00000000-0000-4000-8000-000000000002');
    insert into garmin.artifact_inventory(dataset,original_table,artifact_key,batch,category,request_id,analysis_id,metadata) values ('synthetic','artifact','report','batch','report','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005','{}');
    insert into garmin.artifact_relations values ('synthetic','report','report','image','00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000005',null);
    insert into garmin.input_inventory(dataset,batch,category,state,metadata,metadata_raw) values ('synthetic','batch','body','present','{}',decode('610062','hex'));`);
  const tables=['datasets','import_batches','raw_payloads','import_mapping','source_schemas','preserved_rows','import_checkpoints','import_conflicts','legacy_conversations','artifact_inventory','input_inventory','artifact_relations'];
  const snapshot=async()=>{const rows:Record<string,unknown>={};for(const name of tables) rows[name]=await fixture.db.rows(`select count(*)::int as n,md5(coalesce(string_agg(row_to_json(t)::text,',' order by row_to_json(t)::text),'')) as hash from garmin.${name} t`);return rows;};
  const before=await snapshot();
  for(const table of tables) expect((before[table] as {n:number}[])[0]?.n,table).toBeGreaterThan(0);
  await copyFile(new URL('0013_remove_legacy_collect.sql',source),join(dir,'0013_remove_legacy_collect.sql'));
  expect(await runMigrations(options)).toMatchObject({ok:true,applied:['0013_remove_legacy_collect.sql']}); expect(await snapshot()).toEqual(before);
  await copyFile(new URL('0014_native_store.sql',source),join(dir,'0014_native_store.sql'));
  expect(await runMigrations(options)).toMatchObject({ok:true,applied:['0014_native_store.sql']}); expect(await snapshot()).toEqual(before);
  await copyFile(new URL('0015_raw_observations.sql',source),join(dir,'0015_raw_observations.sql'));
  expect(await runMigrations(options)).toMatchObject({ok:true,applied:['0015_raw_observations.sql']}); expect(await snapshot()).toEqual(before);
  await copyFile(new URL('0016_report_publication.sql',source),join(dir,'0016_report_publication.sql'));
  expect(await runMigrations(options)).toMatchObject({ok:true,applied:['0016_report_publication.sql']}); expect(await snapshot()).toEqual(before);
  await copyFile(new URL('0017_period_analysis.sql',source),join(dir,'0017_period_analysis.sql'));
  expect(await runMigrations(options)).toMatchObject({ok:true,applied:['0017_period_analysis.sql']}); expect(await snapshot()).toEqual(before);
  await copyFile(new URL('0018_report_message.sql',source),join(dir,'0018_report_message.sql'));
  expect(await runMigrations(options)).toMatchObject({ok:true,applied:['0018_report_message.sql']}); expect(await snapshot()).toEqual(before);
  expect((await fixture.ledger('garmin')).map(row=>row.version)).toEqual(Array.from({length:18},(_,i)=>i+1));
  for(const name of ['raw_records','raw_records_v2','body_records','collect_target_accounts','collect_state','collect_runs','collect_fetch_errors','collect_meta','collect_targets','collect_published','normalize_items','normalize_days','normalize_day_dirty','normalize_day_revisions','authority_v2','body_documents','body_sources','body_measurements','collect_snapshots','collect_snapshot_items','collect_notices','import_provenance','authority_provenance']) expect(await fixture.db.rows(`select to_regclass('garmin.${name}') as object`)).toEqual([{object:null}]);
  expect(await fixture.db.rows("select has_schema_privilege('brain_app','garmin','usage') as allowed")).toEqual([{allowed:false}]);
 } finally {await fixture.cleanup(); await rm(dir,{recursive:true,force:true});}
});


it('이전 배포 package에서 현재 package로 갱신하며 기존 데이터와 신원을 보존한다', async () => {
 const fixture=await extHome(), temp=await realpath(await mkdtemp(join(tmpdir(),'brain-garmin-release-')));
 const store=postgresStore({databaseUrl:fixture.db.appUrl});
 try {
  const archive=join(temp,'baseline.tar');
  execFileSync('git',['archive','--output',archive,'505188d3a2259f058988c2dd4f68f8dbce4a7b57','plugins/garmin/package']);
  execFileSync('tar',['-xf',archive,'-C',temp]);
  const old=join(temp,'plugins/garmin/package'), current=fileURLToPath(new URL('../../../plugins/garmin/package',import.meta.url));
  const oldDigest=(await readFile(join(old,'digest'),'utf8')).trim(), currentDigest=(await readFile(join(current,'digest'),'utf8')).trim();
  const currentManifest=JSON.parse(await readFile(join(current,'manifest.json'),'utf8'));
  const sourceManifest=JSON.parse(await readFile(new URL('../../../extensions/garmin/manifest.json',import.meta.url),'utf8'));
  const pluginManifest=JSON.parse(await readFile(new URL('../../../plugins/garmin/.claude-plugin/plugin.json',import.meta.url),'utf8'));
  const newer=(value:string,previous:string)=>{
   expect(value).toMatch(/^\d+\.\d+\.\d+$/);
   const parts=value.split('.').map(Number), prior=previous.split('.').map(Number);
   return parts.some((part,index)=>part>prior[index] && parts.slice(0,index).every((v,i)=>v===prior[i]));
  };
  expect(currentManifest.version).toBe(sourceManifest.version);
  expect(currentManifest.plugin_version).toBe(pluginManifest.version);
  expect(newer(currentManifest.version,'1.2.0')).toBe(true);
  expect(newer(currentManifest.plugin_version,'0.1.2')).toBe(true);
  expect(oldDigest).not.toBe(currentDigest);
  const first=await fixture.run(['ext','install','--package',old,'--json']);
  const oldRegistry=await fixture.db.rows("select version,package_digest,plugin_version from brain.extensions where name='garmin'");
  expect(oldRegistry).toEqual([{version:'1.2.0',package_digest:oldDigest,plugin_version:'0.1.2'}]);
  expect(first.code,first.stdout+first.stderr).toBe(0);
  const { extensionDatabaseUrl }=await import('../src/config/codec.js');
  const url=await extensionDatabaseUrl(fixture.home,'garmin',fixture.db.appUrl), target=join(fixture.home,'extensions/garmin');
  const probe=()=>JSON.parse(execFileSync(join(target,'.venv/bin/python'),['-c',"import json,psycopg,sys;sys.path.insert(0,sys.argv[1]);from role_probe import probe_role; c=psycopg.connect(sys.argv[2]); print(json.dumps(probe_role(c))); c.close()",join(target,'src'),url],{encoding:'utf8',env:{...fixture.env,PYTHONDONTWRITEBYTECODE:'1'}}));
  expect(probe().no_excess_functions).toBe(false);
  await fixture.db.query(`insert into garmin.datasets(dataset,account,account_confirmed) values ('synthetic-existing',null,false);
    insert into garmin.preserved_rows(id,dataset,original_table,original_key,values_json) values ('00000000-0000-4000-8000-000000000001','synthetic-existing','meta','key','{"value":"sample"}');
    insert into brain.schedules(id,kind,hold_group,target_kind,target_id,trigger_kind,cron_expr,time_zone,time_zone_source,extension,schedule_key,user_id,enabled,next_run_at,created_at)
      select '00000000-0000-4000-8000-000000000002','garmin.collect','extension:garmin','account','synthetic','cron','0 9 * * *','Asia/Seoul','user','garmin','synthetic-preserve',id,false,date_trunc('milliseconds',now()+interval '1 day'),date_trunc('milliseconds',now()) from brain.users where is_self=1`);
  expect(await store.setSetting({userId:'01940000-0000-7000-8000-00000000000a',key:'garmin.timezone',value:'Asia/Seoul',updatedAt:new Date()})).toMatchObject({ok:true});
  const saved=async()=>({rows:await fixture.db.rows("select * from garmin.preserved_rows where dataset='synthetic-existing'"),ledger:await fixture.ledger('garmin'),settings:await fixture.db.rows("select * from brain.settings where key='garmin.timezone'"),schedule:await fixture.db.rows("select * from brain.schedules where extension='garmin' order by id")});
  const before=await saved(); expect(before.rows).toHaveLength(1);expect(before.settings).toHaveLength(1);expect(before.schedule.length).toBeGreaterThanOrEqual(3);expect(before.ledger).toHaveLength(16);
  const upgraded=await fixture.run(['ext','install','--package',current,'--json']);
  expect(upgraded.code,upgraded.stdout+upgraded.stderr).toBe(0);
  expect(await fixture.db.rows("select version,package_digest,plugin_version from brain.extensions where name='garmin'")).toEqual([{version:currentManifest.version,package_digest:currentDigest,plugin_version:currentManifest.plugin_version}]);
  const after=await saved();
  expect({...after,ledger:after.ledger.slice(0,before.ledger.length)}).toEqual(before);
  expect(after.ledger.map(row=>row.version)).toEqual(Array.from({length:18},(_,i)=>i+1));
  expect(await fixture.db.rows("select data_type,is_nullable from information_schema.columns where table_schema='garmin' and table_name='evaluation_revisions' and column_name='message'")).toEqual([{data_type:'jsonb',is_nullable:'YES'}]);
  expect(probe()).toMatchObject({no_excess_functions:true,send_execute:true});
  for(const path of ['src/role_probe.py','src/batch_import.py','manifest.json','digest']) expect(await readFile(join(fixture.home,'extensions/garmin',path))).toEqual(await readFile(join(current,path)));
 } finally {await store.close();await fixture.cleanup();await rm(temp,{recursive:true,force:true});}
},120000);
