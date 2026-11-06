#!/usr/bin/env node
// Own disposable PostgreSQL only; no caller-provided database URL is used.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { serializeError } from './explain-error.mjs';
import { createIsolatedTestDatabase } from '../test-db/dist/index.js';
import { prepareDatabase, runMigrations } from '../../packages/postgres/dist/index.js';
const require = createRequire(new URL('../test-db/package.json', import.meta.url));
const pg = require('pg');
const run = promisify(execFile);
const args=process.argv.slice(2);
if (args.length!==2 || args[0]!=='--out' || !args[1]) throw Error('사용법: node tooling/recall-eval/explain.mjs --out <새 출력 파일>');
// createIsolatedTestDatabase checks presence only; it always starts its own cluster.
process.env.BRAIN_TEST_DATABASE_URL ||= 'postgres://fixture-placeholder';
let db, client, transactionOpen=false;
const record={schema:1,generated_at:new Date().toISOString(),fixture:null,environment:null,indexes:null,scenarios:[],cleanup:{client_end:'not_started',database_drop:'not_started',container_remove:'not_started'},errors:[]};
const capture=(stage,error)=>{ record.errors.push({stage,...serializeError(error)}); };
let failed=false;
try {
  db=await createIsolatedTestDatabase();
  record.fixture={container_id:db.fixtureContainer.id,name:db.fixtureContainer.name,port:db.fixtureContainer.port};
  const inspect=JSON.parse((await run('docker',['inspect',db.fixtureContainer.id])).stdout)[0];
  const image=JSON.parse((await run('docker',['image','inspect',inspect.Image])).stdout)[0];
  const prep=await prepareDatabase({databaseUrl:db.url,appPassword:'brain-test-app',maintenancePassword:'brain-test-maintenance',databaseName:new URL(db.url).pathname.slice(1)}); if (!prep.ok) throw Error(prep.message);
  const migration=await runMigrations({databaseUrl:db.url,clock:{now:()=>new Date()}}); if (!migration.ok) throw Error(JSON.stringify(migration));
  client=new pg.Client({connectionString:db.url}); await client.connect();
  const environment=(await client.query("select version() as server_version, current_setting('server_encoding') as encoding, datcollate as lc_collate, datctype as lc_ctype, datlocprovider, datlocale from pg_database where datname=current_database()" )).rows[0];
  const ext=(await client.query("select extversion from pg_extension where extname='pg_trgm'" )).rows[0];
  record.environment={...environment,pg_trgm:ext?.extversion,image_id:inspect.Image,repo_digests:image.RepoDigests,os:image.Os,architecture:image.Architecture};
  record.indexes=(await client.query("select indexname,indexdef from pg_indexes where schemaname='brain' and indexname=any($1::text[]) order by indexname",[['tool_notes_target_idx','chunks_body_idx','log_entries_text_idx','document_chunks_body_idx','file_names_text_idx']])).rows;
  if (record.indexes.length!==5 || !record.environment.pg_trgm || !record.environment.repo_digests?.length) throw Error('필수 색인·pg_trgm·이미지 digest 누락');
  await client.query("insert into brain.users(id,name,is_self,created_at) values ('00000000-0000-4000-8000-000000000001','synthetic',1,now())");
  await client.query("insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ('00000000-0000-4000-8000-000000000002','synthetic','explain','00000000-0000-4000-8000-000000000001','synthetic',now(),'import')");
  await client.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ('00000000-0000-4000-8000-000000000003','sha256:'||repeat('a',64),1,now())");
  await client.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ('00000000-0000-4000-8000-000000000004','00000000-0000-4000-8000-000000000003','synthetic',1,'ok',now(),now())");
  const configs=await client.query("select id from brain.index_configs where id='019a0000-0000-7000-8000-000000000003'"); if (!configs.rows[0]) throw Error('대화 색인 설정 없음');
  for (const size of [100,10000]) {
    await client.query('begin'); transactionOpen=true;
    const text="case when n%100=0 then '희귀수면량' else '공통수면량' end || ' synthetic ' || md5(n::text)";
    await client.query(`insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,part,body) select gen_random_uuid(),'00000000-0000-4000-8000-000000000002',$2,now()+n*interval '1 second',now()+n*interval '1 second',0,${text} from generate_series(1,$1::int) n`,[size,configs.rows[0].id]);
    await client.query(`insert into brain.tool_notes(id,session_id,harness_message_id,ordinal,tool,target,ok) select gen_random_uuid(),'00000000-0000-4000-8000-000000000002','synthetic-'||n,0,'tool',${text},1 from generate_series(1,$1::int) n`,[size]);
    await client.query(`insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) select gen_random_uuid(),'00000000-0000-4000-8000-000000000004',n,${text},json_build_object('type','text','start',n*100,'end',n*100+50)::text from generate_series(1,$1::int) n`,[size]);
    await client.query('analyze brain.chunks'); await client.query('analyze brain.tool_notes'); await client.query('analyze brain.document_chunks');
    for (const [target,column] of [['chunks','body'],['tool_notes','target'],['document_chunks','body']]) for (const [selectivity,pattern] of [['two-char','%수면%'],['common','%공통수면량%'],['rare','%희귀수면량%']]) for (const filtered of [false,true]) {
      const filter = !filtered ? '' : target === 'chunks' ? " and from_at < now() + interval '50 seconds'" : target === 'tool_notes' ? " and harness_message_id like '%1'" : " and ordinal <= 50";
      const sql=`explain (analyze, buffers, format json) select id from brain.${target} where lower(${column}) like lower($1) escape '\\'${filter}`;
      const explain=(await client.query(sql,[pattern])).rows[0]['QUERY PLAN'];
      record.scenarios.push({size,target,selectivity,filtered,pattern,sql,explain});
    }
    await client.query('rollback'); transactionOpen=false;
  }
} catch (error) { failed=true; capture('collection',error); } finally {
  if (transactionOpen) { try { await client.query('rollback'); } catch (error) { failed=true; capture('transaction_rollback',error); } }
  if (client) { try { await client.end(); record.cleanup.client_end='succeeded'; } catch (error) { failed=true; record.cleanup.client_end='failed'; capture('client_end',error); } }
  if (db) {
    try { await db.drop(); } catch (error) { failed=true; capture('database_or_container_cleanup',error); }
    record.cleanup.database_drop=db.fixtureDatabaseDropped?'succeeded':'failed';
    record.cleanup.container_remove=db.fixtureContainerRemoved?'succeeded':'failed';
    record.cleanup.id=record.fixture.container_id;
    if (!db.fixtureDatabaseDropped || !db.fixtureContainerRemoved) failed=true;
  }
  try { await writeFile(args[1],JSON.stringify(record,null,2)+'\n',{flag:'wx'}); }
  catch (error) { failed=true; capture('output_write',error); process.stderr.write(JSON.stringify({output_write_error:record.errors.at(-1),recovery_record:record})+'\n'); }
}
if (failed) { process.stderr.write(JSON.stringify({errors:record.errors,cleanup:record.cleanup})+'\n'); process.exitCode=1; }
