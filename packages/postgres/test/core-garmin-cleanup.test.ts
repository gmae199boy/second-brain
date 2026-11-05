import { randomBytes, randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import pg from 'pg'; import { expect, it } from 'vitest';
import { database, clock } from './fixture.js';
import { provisionExtension, postgresStore, runMigrations } from '../src/index.js';

it('v30에서 공용 데이터와 권한을 보존하며 v31로 정리한다', async () => {
 const db=await database(false), dir=await mkdtemp(join(tmpdir(),'brain-v30-'));
 const name=`x${randomBytes(5).toString('hex')}`, role=`brain_ext_${name}`, newName=`${name}n`, newRole=`brain_ext_${newName}`, password=randomBytes(24).toString('hex');
 const admin=new pg.Client({connectionString:db.url}); const store=postgresStore({databaseUrl:db.appUrl}); let ext:pg.Client|undefined;
 try {
  const source=new URL('../migrations/',import.meta.url);
  const files=(await readdir(source)).filter(f=>/^\d{4}_/.test(f) && f<'0022').sort();
  for(const f of files) await copyFile(new URL(f,source),join(dir,f));
  expect(await runMigrations({databaseUrl:db.url,clock,owners:[{owner:'core',directory:dir}]})).toMatchObject({ok:true,to:21});
  await admin.connect(); await provisionExtension(db.url,name,password);
  for(const f of (await readdir(source)).filter(f=>/^\d{4}_/.test(f) && f>='0022' && f<'0031')) await copyFile(new URL(f,source),join(dir,f));
  expect(await runMigrations({databaseUrl:db.url,clock,owners:[{owner:'core',directory:dir}]})).toMatchObject({ok:true,to:30});
  await admin.query("insert into brain.extensions(name,version,installed_at,enabled,enabled_changed_at) values ($1,'1',now(),true,now())",[name]);
  await admin.query('insert into brain.extension_work_kinds(extension_name,kind) values ($1,$2)',[name,`${name}.import`]);
  const work=randomUUID(),token=randomUUID(),channel=randomUUID(),conversation=randomUUID(),req=randomUUID(),file=randomUUID();
  await admin.query("insert into brain.work_items(id,kind,target_kind,target_id,created_at,attempts,next_attempt_at,execution_class) values ($1,'health_analysis','analysis_snapshot','old',now(),0,now(),'supervised')",[randomUUID()]);
  await store.addWork({id:work,kind:`${name}.import`,targetKind:'import',targetId:'seed',createdAt:clock.now(),nextAttemptAt:clock.now()});
  await store.claimSupervisedWork({now:clock.now(),claimedBy:'test',kinds:[`${name}.import`],attemptToken:token});
  await admin.query('insert into brain.channels values ($1,$2,$3)',[channel,'telegram','bot']);
  await admin.query('insert into brain.channel_conversations values ($1,$2,$3,null)',[conversation,channel,'chat']);
  const url=new URL(db.url);url.username=role;url.password=password;ext=new pg.Client({connectionString:url.toString()});await ext.connect();
  const user=randomUUID(),session=randomUUID(),message=randomUUID(),channelRequest=randomUUID();
  await admin.query("insert into brain.users(id,name,is_self,created_at) values ($1,'synthetic',1,now())",[user]);
  await admin.query("insert into brain.sessions(id,harness,harness_session_id,user_id,machine,started_at,ingest_source) values ($1,'synthetic','session',$2,'test',now(),'import')",[session,user]);
  await admin.query("insert into brain.messages(id,session_id,harness_message_id,role,body,occurred_at) values ($1,$2,'message','user','synthetic',now())",[message,session]);
  await ext.query("insert into brain.channel_requests(id,conversation_id,producer,producer_result_id,purpose,body,created_at,source_work_item_id,source_attempt_token) values ($1,$2,$3,'result','notice','body',now(),$4,$5)",[channelRequest,conversation,name,work,token]);
  await admin.query("insert into brain.channel_attempt_results(request_id,work_item_id,attempt_token,created_at) values ($1,$2,$3,now())",[channelRequest,work,token]);
  await ext.query("insert into brain.channel_legacy_deliveries(id,conversation_id,source,dataset,original_table,original_key,import_batch,original_id,local_date,kind,event,ok,at,source_work_item_id,source_attempt_token,dataset_label,dataset_label_raw,dataset_label_encoding) values ($1,$2,$3,'d','deliveries','1','b','1','2026-01-01','notice','event',true,now(),$4,$5,'label',$6,'utf-8')",[randomUUID(),conversation,name,work,token,Buffer.from('label')]);
  const request=`insert into brain.file_requests(id,source,request_key,dataset,import_batch,locator,sha256,size_bytes,media_type,created_at,source_work_item_id,source_attempt_token,metadata) values ($1,$2,'key','d','b','loc',$3,1,'text/plain','2026-01-01',$4,$5,'{"x":1}')`;
  const args=[req,name,'a'.repeat(64),work,token]; await ext.query(request,args);
  await admin.query("insert into brain.files(id,content_hash,size_bytes,first_seen_at) values ($1,$2,1,now())",[file,'sha256:'+'a'.repeat(64)]);
  const location=randomUUID(), extraction=randomUUID();
  await admin.query("insert into brain.file_locations(id,file_id,store_kind,locator,ownership,first_seen_at) values ($1,$2,'local','synthetic/file','brain',now())",[location,file]);
  await admin.query('update brain.files set home_location_id=$1 where id=$2',[location,file]);
  await admin.query("insert into brain.transcript_files(id,harness,path,size_bytes,fingerprint,scanned_at) values ($1,'synthetic','synthetic/transcript',1,'hash',now())",[randomUUID()]);
  await admin.query("insert into brain.message_attachments(id,message_id,ordinal,source_kind,file_id,status) values ($1,$2,0,'synthetic',$3,'stored')",[randomUUID(),message,file]);
  await admin.query("insert into brain.failures(id,target_kind,target_id,stage,fingerprint,session_id,code,message,occurred_at,first_occurred_at,occurrences) values ($1,'session','synthetic','ingest','fingerprint',$2,'ERROR','synthetic',now(),now(),1)",[randomUUID(),session]);
  await admin.query("insert into brain.chunks(id,session_id,index_config_id,from_at,to_at,body) values ($1,$2,'019a0000-0000-7000-8000-000000000003',now(),now(),'synthetic chunk')",[randomUUID(),session]);
  await admin.query("insert into brain.document_extractions(id,file_id,extractor_version,attempt,status,started_at,finished_at) values ($1,$2,'test',1,'ok',now(),now())",[extraction,file]);
  await admin.query("insert into brain.document_chunks(id,extraction_id,ordinal,body,chunk_locator) values ($1,$2,0,'synthetic document','{\"type\":\"text\"}')",[randomUUID(),extraction]);
  await admin.query('insert into brain.file_request_handoffs values ($1,$2)',[req,work]);
  await admin.query('insert into brain.file_request_results(request_id,file_id,finished_at) values ($1,$2,now())',[req,file]);
  await ext.query(`insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token,detail_raw,detail_encoding,dataset_label,dataset_label_raw,dataset_label_encoding) values ($1,$2,$3,'d','notifications','1','b','2026-01-01','event','a�b',now(),$4,$5,$6,'utf-8','label',$7,'utf-8')`,[randomUUID(),conversation,name,work,token,Buffer.from([97,0,98]),Buffer.from('label')]);
  await ext.query(`insert into brain.health_observations(id,source,dataset,import_batch,original_table,original_key,account,account_confirmed,metric,value,unit,local_date,time_zone,time_zone_missing,revision,fetched_at,normalization_version,source_work_item_id,source_attempt_token) values ($1,$2,'d','b','daily','1','a',true,'steps',1,'count','2026-01-01','UTC',false,'r',now(),1,$3,$4)`,[randomUUID(),name,work,token]);
  await ext.query(`insert into brain.analyses(id,source,dataset,import_batch,original_table,original_key,revision,model_missing,created_at_missing,file_request_id,source_work_item_id,source_attempt_token) values ($1,$2,'d','b','reports','1',1,true,true,$3,$4,$5)`,[randomUUID(),name,req,work,token]);
  const tables=(await admin.query<{relname:string}>(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='brain' and c.relkind='r' and c.relname not in ('schema_migrations','health_observations','health_authority_rules','health_catalog_v1','health_supported_versions','analyses','analysis_artifacts','analysis_files','analysis_snapshots') order by c.relname`)).rows.map(r=>r.relname);
  const snapshot=async()=>{ const result:Record<string,unknown>={}; for(const table of tables) { const keys=(await admin.query<{attname:string}>(`select a.attname from pg_index i join pg_class c on c.oid=i.indrelid join pg_namespace n on n.oid=c.relnamespace cross join lateral unnest(i.indkey) with ordinality k(attnum,ord) join pg_attribute a on a.attrelid=c.oid and a.attnum=k.attnum where n.nspname='brain' and c.relname=$1 and i.indisprimary order by k.ord`,[table])).rows.map(r=>`t."${r.attname}"`); const order=keys.length ? keys.join(',') : 'row_to_json(t)::text'; result[table]=(await admin.query(`select count(*)::int as count,md5(coalesce(string_agg(row_to_json(t)::text, ',' order by ${order}),'')) as hash from brain."${table}" t`)).rows[0]; } return result; };
  const definitions=async()=>({
   triggers:(await admin.query(`select c.relname,t.tgname,pg_get_triggerdef(t.oid) as definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='brain' and not t.tgisinternal and c.relname in ('file_requests','file_request_results','channel_requests','channel_legacy_notifications','channel_legacy_deliveries') order by 1,2`)).rows,
   policies:(await admin.query(`select tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='brain' and tablename in ('file_requests','channel_requests','channel_legacy_notifications','channel_legacy_deliveries') order by 1,2`)).rows,
   functions:(await admin.query(`select p.proname,pg_get_functiondef(p.oid) as definition from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='brain' and p.proname in ('queue_import_cleanup','guard_import_locator','reject_import_mutation','reconcile_channel_legacy','original_utf8','extension_predecessor_results') order by 1`)).rows,
  });
  const before=await snapshot(), beforeDefinitions=await definitions();
  const requiredNonempty=['sessions','messages','transcript_files','message_attachments','files','file_locations','document_extractions','document_chunks','chunks','failures','work_items','work_attempts','file_requests','file_request_handoffs','file_request_results','file_import_cleanup','channel_requests','channel_attempt_results','channel_legacy_notifications','channel_legacy_deliveries'];
  const emptyRequired=requiredNonempty.filter(table => (before[table] as {count:number}).count===0);
  expect(emptyRequired).toEqual([]);
  // 나머지는 이 seed에 해당 기록이 없는 별도의 기능 표다.
  const emptyAllowed=['channel_gates','channel_item_results','context_injections','extension_install_progress','extension_python_environment','file_metadata','file_names','log_entries','log_entry_edits','projects','redactions','schedule_successes','schedules','settings','tool_notes','work_dependencies','work_hold_groups','workspaces','worktrees'];
  const unexpectedEmpty=Object.entries(before).filter(([name,row]) => (row as {count:number}).count===0 && !emptyAllowed.includes(name)).map(([name])=>name);
  expect(unexpectedEmpty).toEqual([]);
  await copyFile(new URL('0031_remove_core_garmin.sql',source),join(dir,'0031_remove_core_garmin.sql'));
  expect(await runMigrations({databaseUrl:db.url,clock,owners:[{owner:'core',directory:dir}]})).toMatchObject({ok:true,from:30,to:31});
  expect(await snapshot()).toEqual(before); expect(await definitions()).toEqual(beforeDefinitions);
  for(const table of ['health_observations','health_current_v1','health_resolution_v1','health_authority_rules','health_catalog_v1','health_supported_versions','analyses','analysis_artifacts','analysis_files','analysis_snapshots']) expect((await admin.query('select to_regclass($1) as object',[`brain.${table}`])).rows[0].object).toBeNull();
  await provisionExtension(db.url,name,password); await provisionExtension(db.url,newName,password);
  expect((await admin.query("select has_column_privilege($1,'brain.channel_legacy_notifications','dataset_label_raw','insert') as label,has_column_privilege($1,'brain.file_requests','metadata','insert') as file",[newRole])).rows[0]).toEqual({label:true,file:true});
  const grants: Record<string,string[]> = {
   channel_legacy_deliveries:['original_id_raw','reason_raw','dataset_label_raw'],
   channel_legacy_notifications:['detail_raw'],
   file_requests:['id','source','request_key','dataset','import_batch','locator','sha256','size_bytes','media_type','created_at','source_work_item_id','source_attempt_token'],
   channel_requests:['id','conversation_id','producer','producer_result_id','purpose','revision','body','created_at','source_work_item_id','source_attempt_token'],
  };
  for (const [table,columns] of Object.entries(grants)) for (const column of columns)
   expect((await admin.query("select has_column_privilege($1,$2,$3,'insert') as allowed",[newRole,`brain.${table}`,column])).rows[0].allowed,`${table}.${column}`).toBe(true);
  expect((await admin.query(`select count(*)::int as n from information_schema.role_table_grants where grantee=$1 and table_schema='brain' and (table_name like 'health_%' or table_name like 'analysis%')`,[newRole])).rows[0].n).toBe(0);
  for(const signature of ['brain.health_aggregate_v1(text,text,text,text)','brain.reconcile_import_authority(uuid,text,text,bytea,text,text[],uuid,uuid,boolean)','brain.health_json_comparison(jsonb,bytea,text)','brain.health_text_comparison(text,bytea,text)','brain.validate_health_observation()','brain.reconcile_analysis_artifact()','brain.guard_analysis_dataset()']) expect((await admin.query('select to_regprocedure($1) as object',[signature])).rows[0].object).toBeNull();
  expect((await admin.query(`select has_column_privilege($1,'brain.file_requests','metadata','insert') as file,has_column_privilege($1,'brain.channel_legacy_notifications','detail_raw','insert') as raw,has_column_privilege($1,'brain.channel_legacy_deliveries','dataset_label','insert') as label`,[role])).rows[0]).toEqual({file:true,raw:true,label:true});
  await ext.query("insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token,detail_raw,detail_encoding) values ($1,$2,$3,'d','notifications','after','b','2026-01-01','event','a�b',now(),$4,$5,$6,'utf-8')",[randomUUID(),conversation,name,work,token,Buffer.from([97,0,98])]);
  const legacyId=randomUUID();
  const legacySql="insert into brain.channel_legacy_notifications(id,conversation_id,source,dataset,original_table,original_key,import_batch,local_date,event,detail,at,source_work_item_id,source_attempt_token,detail_raw,detail_encoding,dataset_label,dataset_label_raw,dataset_label_encoding) values ($1,$2,$3,'d','notifications','reconcile','b','2026-01-01','event','a�b','2026-01-01',$4,$5,$6,'utf-8','l�x',$7,'utf-8')";
  const legacyArgs=[legacyId,conversation,name,work,token,Buffer.from([97,0,98]),Buffer.from([108,0,120])];
  await ext.query(legacySql,legacyArgs); await ext.query(legacySql,legacyArgs);
  expect((await admin.query('select detail_raw,detail_encoding,dataset_label_raw,dataset_label_encoding from brain.channel_legacy_notifications where id=$1',[legacyId])).rows).toEqual([{detail_raw:Buffer.from([97,0,98]),detail_encoding:'utf-8',dataset_label_raw:Buffer.from([108,0,120]),dataset_label_encoding:'utf-8'}]);
  await expect(ext.query(legacySql,[...legacyArgs.slice(0,5),Buffer.from([97,0,99]),legacyArgs[6]])).rejects.toMatchObject({code:'P0001'});
  await expect(ext.query(legacySql,[legacyId,conversation,name,work,randomUUID(),legacyArgs[5],legacyArgs[6]])).rejects.toMatchObject({code:'BRS01'});
  await ext.query(request,args);
  await expect(ext.query(request,[req,name,'b'.repeat(64),work,token])).rejects.toMatchObject({code:'P0001'});
  await expect(ext.query(request,[randomUUID(),name,'a'.repeat(64),work,randomUUID()])).rejects.toMatchObject({code:'BRS01'});
 } finally { await ext?.end();await store.close();await admin.query(`drop owned by "${role}"; drop role if exists "${role}"`).catch(()=>{});await admin.query(`drop owned by "${newRole}"; drop role if exists "${newRole}"`).catch(()=>{});await admin.end();await db.drop();await rm(dir,{recursive:true,force:true}); }
});
