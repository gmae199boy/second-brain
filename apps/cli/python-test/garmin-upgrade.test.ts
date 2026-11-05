import { randomBytes } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { expect, it } from 'vitest';
import { extHome } from '../test/ext-fixture.js';
import { provisionExtension, runMigrations } from 'second_brain/postgres';

it('새 설치는 core 31과 Garmin 13을 적용한다', async () => {
 const fixture=await extHome();
 try {
  const installed=await fixture.run(['ext','install','garmin','--json']); expect(installed.code,installed.stdout+installed.stderr).toBe(0);
  expect((await fixture.ledger('garmin')).map(row=>row.version)).toEqual(Array.from({length:13},(_,i)=>i+1));
  expect(await fixture.ledger('core')).toContainEqual({owner:'core',version:31});
  expect(await fixture.db.rows("select to_regclass('garmin.raw_records') as raw, to_regclass('garmin.collect_state') as collect")).toEqual([{raw:null,collect:null}]);
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
  for(const name of ['raw_records','raw_records_v2','body_records','collect_target_accounts','collect_state','collect_runs','collect_fetch_errors','collect_meta','collect_targets','collect_published','normalize_items','normalize_days','normalize_day_dirty','normalize_day_revisions','authority_v2','body_documents','body_sources','body_measurements','collect_snapshots','collect_snapshot_items','collect_notices','import_provenance','authority_provenance']) expect(await fixture.db.rows(`select to_regclass('garmin.${name}') as object`)).toEqual([{object:null}]);
  expect(await fixture.db.rows("select has_schema_privilege('brain_app','garmin','usage') as allowed")).toEqual([{allowed:false}]);
 } finally {await fixture.cleanup(); await rm(dir,{recursive:true,force:true});}
});
